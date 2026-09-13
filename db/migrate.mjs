// Apply db/migrations/*.sql to the Neon branch, once each, in order.
//
//   node db/migrate.mjs            apply anything not yet applied
//   node db/migrate.mjs --verify   apply nothing, print what the branch has
//   node db/migrate.mjs --dry-run  print the plan, touch nothing
//
// CONNECTION STRINGS ARE NEVER PRINTED. Not on success, not in an error, not
// in --verify. The only thing this script ever says about the connection is
// which VARIABLE it read. Driver errors are scrubbed of both strings before
// they are re-thrown, because a DNS or auth failure otherwise echoes the host
// and user back into a terminal that gets pasted into chat.
//
// Migrations use DATABASE_URL_UNPOOLED (a direct endpoint) when it is set:
// DDL is a handful of statements from one machine, so there is nothing for a
// pooler to help with, and a direct connection keeps advisory-lock and
// transaction semantics uncomplicated. Runtime keeps using the POOLED
// DATABASE_URL — see lib/db.ts.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "migrations");
const ROOT = join(HERE, "..");

const args = new Set(process.argv.slice(2));
const VERIFY_ONLY = args.has("--verify");
const DRY_RUN = args.has("--dry-run");

/* ---------------------------------------------------------------- env ---- */

function loadEnv() {
  if (process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED) return;
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(join(ROOT, file));
      return;
    } catch {
      // next candidate
    }
  }
}

loadEnv();

const VAR = process.env.DATABASE_URL_UNPOOLED ? "DATABASE_URL_UNPOOLED" : "DATABASE_URL";
const DB_URL = process.env[VAR];

if (!DB_URL) {
  console.error(
    "No database URL. Set DATABASE_URL_UNPOOLED (preferred for migrations) or " +
      "DATABASE_URL in .env.local, or export it in this shell."
  );
  process.exit(1);
}

/** Scrub both connection strings out of anything on its way to a terminal. */
const SECRETS = [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED].filter(Boolean);
function scrub(text) {
  let out = String(text);
  for (const s of SECRETS) out = out.split(s).join("[connection string redacted]");
  // Belt and braces: any postgres URL at all, including one this script never read.
  out = out.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[connection string redacted]");
  return out;
}

const sql = neon(DB_URL);

/* --------------------------------------------------------- sql parsing --- */

/** Split a migration file into statements.
 *
 *  A naive split on ";" cuts plpgsql function bodies in half, so this walks the
 *  text and skips over line comments, single- and double-quoted identifiers,
 *  and dollar-quoted blocks ($$ ... $$ or $tag$ ... $tag$) before it treats a
 *  semicolon as a terminator. The Neon HTTP driver takes one statement per
 *  request, so the split is not optional. */
function splitStatements(text) {
  const out = [];
  let cur = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      const end = nl === -1 ? text.length : nl + 1;
      cur += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      cur += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) j += 2;
          else break;
        } else j += 1;
      }
      const stop = Math.min(j + 1, text.length);
      cur += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        const stop = end === -1 ? text.length : end + tag.length;
        cur += text.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      out.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  out.push(cur);

  return out
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      // Trailing comment blocks between statements are not statements.
      const code = s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("")
        .trim();
      return code.length > 0;
    });
}

/* ------------------------------------------------------------- reports --- */

async function report() {
  const tables = await sql.query(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`
  );
  console.log(`\npublic tables (${tables.length}):`);
  for (const t of tables) console.log(`  ${t.tablename}`);

  const cols = await sql.query(
    `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = 'public'
        and table_name in ('user','session','account','verification','profile','profile_history','entitlement_ledger')
      order by table_name, ordinal_position`
  );
  let current = "";
  for (const c of cols) {
    if (c.table_name !== current) {
      current = c.table_name;
      console.log(`\n  ${current}`);
    }
    console.log(
      `    ${c.column_name.padEnd(22)} ${c.data_type}${c.is_nullable === "NO" ? " not null" : ""}`
    );
  }

  const idx = await sql.query(
    `select tablename, indexname from pg_indexes where schemaname = 'public' order by tablename, indexname`
  );
  console.log(`\n  indexes (${idx.length}):`);
  for (const i of idx) console.log(`    ${i.tablename}.${i.indexname}`);

  const fns = await sql.query(
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' order by p.proname`
  );
  console.log(`\n  functions: ${fns.map((f) => f.proname).join(", ") || "(none)"}`);

  const trg = await sql.query(
    `select tgname, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal order by tgname`
  );
  console.log(`  triggers: ${trg.map((t) => `${t.relname}.${t.tgname}`).join(", ") || "(none)"}`);
}

/* ----------------------------------------------------------------- run --- */

async function main() {
  console.log(`Using ${VAR} (value not shown).`);

  if (VERIFY_ONLY) {
    await report();
    return;
  }

  await sql.query(
    `create table if not exists "schema_migrations" (
       "name" text primary key not null,
       "appliedAt" timestamptz not null default now()
     )`
  );

  const applied = new Set(
    (await sql.query(`select "name" from "schema_migrations"`)).map((r) => r.name)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const statements = splitStatements(text);
    if (DRY_RUN) {
      console.log(`  plan  ${file} — ${statements.length} statement(s)`);
      continue;
    }
    // One transaction per file: a migration either lands whole or not at all.
    await sql.transaction([
      ...statements.map((s) => sql.query(s)),
      sql.query(`insert into "schema_migrations" ("name") values ($1)`, [file]),
    ]);
    console.log(`  apply ${file} — ${statements.length} statement(s) OK`);
    ran += 1;
  }

  if (!DRY_RUN) {
    console.log(ran ? `\nApplied ${ran} migration(s).` : `\nNothing to apply.`);
    await report();
  }
}

main().catch((err) => {
  console.error("\nMigration failed:");
  console.error(scrub(err && err.message ? err.message : err));
  if (err && err.position) console.error(`  at character ${err.position}`);
  process.exit(1);
});
