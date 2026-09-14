// The database, and the one table the planner actually cares about.
//
// WHAT THIS FILE IS FOR
// Everything the planner knows about a player — 25 equip slots and a 31-row
// Legion roster — lives in one browser's localStorage today. Accounts exist so
// that the same data opens on a MacBook. This file is the server half of that:
// a Neon client, and the read/write primitives an /api/profile route will call
// once Better Auth is handing it a user id.
//
// THE FAILURE THIS FILE IS DESIGNED AROUND
// The realistic first sign-in is: a full gear set is already in localStorage on
// the PC, the owner signs up, and a naive client says "I am signed in now, sync
// me" — pushing whatever it has, or pulling an empty account down over the top.
// One of those two directions destroys hours of screenshot-reading. So the
// write path here is deliberately NOT an upsert:
//
//   * claimProfile()  inserts only when the account has no profile at all. It
//                     can never overwrite. First sign-in seeds the account from
//                     the browser, and a second device signing in gets told
//                     "already exists, here it is" instead of clobbering it.
//   * saveProfile()   is a compare-and-swap on `rev`, in BOTH directions. A
//                     device writing from a stale read gets `conflict` and the
//                     server's row back; it never wins by being last. A device
//                     naming a rev of a profile that has since been DELETED
//                     gets `gone` and creates nothing — it cannot quietly
//                     reverse an erase the owner had to type a phrase to ask
//                     for.
//   * the empty guard refuses a write that would replace a populated profile
//                     with an empty one, unless the caller passes allowEmpty.
//                     That is the "blank profile lands on 31 characters" case,
//                     blocked in SQL rather than in a component.
//   * profile_history keeps the previous ten revisions. Even a forced overwrite
//                     is recoverable — see listProfileHistory/getProfileRevision.
//   * MAX_PROFILE_BYTES bounds the document. A JSONB column fed straight from a
//                     browser is otherwise unbounded; see SECTION 4.
//
// WHAT `rev` IS, AND WHAT IT IS NOT
// `rev` is an optimistic-concurrency token, not a version number the user sees.
// A write names the rev it is replacing; the statement only fires if that is
// still the current one. It is ALSO the key profile_history is archived under,
// which is why a new row does not start at 1 — see newRevExpr() below.
//
// POOLED, ALWAYS
// DATABASE_URL is the Neon POOLED endpoint. Every serverless invocation opens
// its own connection and a direct endpoint runs out of connection slots fast.
// DATABASE_URL_UNPOOLED exists for migrations (db/migrate.mjs) and is not read
// here. Neither string is ever logged, thrown, or included in an error message.
//
// PAYLOAD SHAPE
// One JSONB document per user, not normalised tables: lib/rules.ts's Character
// is under active change and a normalised schema would owe a migration for
// every moved field. The document is exactly lib/portable.ts's `Profile`
// envelope — `{ v, app, exported, icons, char }` — and its validator and
// migration ladder are reused verbatim here rather than re-implemented, so a
// row that came out of this table is a row parseProfile() has already accepted.

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import {
  SCHEMA_VERSION,
  makeProfile,
  migrate,
  parseProfile,
  type FieldError,
  type Profile,
} from "./portable";
import type { Character } from "./rules";

/* ==========================================================================
   SECTION 1 — CONNECTION
   ========================================================================== */

/** Thrown when DATABASE_URL is absent. A half-configured database that quietly
 *  returns null is worse than a loud failure: the UI would read "no data yet"
 *  and the next save would look like it worked. */
export class DatabaseNotConfiguredError extends Error {
  constructor(detail: string) {
    super(
      `DATABASE_URL is not usable: ${detail}. ` +
        `Set it to the Neon POOLED connection string in .env.local (local) and in ` +
        `the Vercel project environment (deployed). Migrations use DATABASE_URL_UNPOOLED.`
    );
    this.name = "DatabaseNotConfiguredError";
  }
}

export type Sql = NeonQueryFunction<false, false>;

let cached: Sql | null = null;

/** The pooled Neon client. Lazy on purpose — importing this module must never
 *  throw, or `next build` fails on a machine that has no env file. The throw
 *  happens on first query instead, which is still long before any UI could
 *  mistake an unconfigured database for an empty account. */
export function getSql(): Sql {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") throw new DatabaseNotConfiguredError("the variable is empty or missing");
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new DatabaseNotConfiguredError("the value is not a postgres:// connection string");
  }
  // Never print the string. The host is the only part named, and only when it
  // is the wrong KIND of endpoint, because that mistake is invisible until the
  // day traffic arrives and connections run out.
  if (!url.includes("-pooler.")) {
    console.warn(
      "[db] DATABASE_URL does not look like a Neon pooled endpoint (-pooler host). " +
        "Serverless runtime must use the pooled string; the direct endpoint exhausts connections."
    );
  }
  cached = neon(url);
  return cached;
}

/** For a health check or a startup assertion: true when a query round-trips. */
export async function ping(): Promise<boolean> {
  const rows = (await getSql().query("select 1 as ok")) as Array<{ ok: number }>;
  return rows[0]?.ok === 1;
}

/* ==========================================================================
   SECTION 2 — NAMES

   Exported so callers write `PROFILE_TABLE` instead of a string literal that
   drifts. Column identifiers are camelCase and therefore MUST stay quoted in
   raw SQL — that is Better Auth's convention for its own four tables and this
   table follows it rather than mixing two conventions in one database.
   ========================================================================== */

export const PROFILE_TABLE = "profile";
export const PROFILE_HISTORY_TABLE = "profile_history";
/** Better Auth core tables, for anything that needs to join against them. */
export const AUTH_TABLES = ["user", "session", "account", "verification"] as const;

/** How many previous revisions profile_history keeps per user. Enforced by the
 *  prune inside the trigger in db/migrations/0001_init.sql. */
export const HISTORY_DEPTH = 10;

/* ==========================================================================
   SECTION 3 — ROW SHAPES
   ========================================================================== */

export interface ProfileRow {
  userId: string;
  /** Optimistic-concurrency token. Read it, send it back with the next save. */
  rev: number;
  /** Mirrors Profile.v. A column so a future migration can find stale rows in
   *  SQL without parsing every document. */
  schemaVersion: number;
  /** ISO 8601 UTC, server clock. Never trust a client's idea of "now". */
  updatedAt: string;
  createdAt: string;
  /** Exactly lib/portable.ts's envelope; `row.profile.char` is the Character. */
  profile: Profile;
}

/** The head of a row without its payload — cheap enough to poll. */
export interface ProfileMeta {
  userId: string;
  rev: number;
  schemaVersion: number;
  updatedAt: string;
  createdAt: string;
  /** No items and no roster. The thing that must never land on a full profile. */
  isEmpty: boolean;
}

export interface HistoryEntry {
  userId: string;
  rev: number;
  schemaVersion: number;
  /** When this revision stopped being current. */
  replacedAt: string;
  isEmpty: boolean;
}

/* ==========================================================================
   SECTION 4 — PAYLOAD HANDLING

   Nothing reaches the table unvalidated, and nothing is stored at a version
   this build cannot read. Both of those come from lib/portable.ts; there is no
   second validator and no second version scheme here.
   ========================================================================== */

/** The largest document this table will store, in UTF-8 bytes of its JSON.
 *
 *  WHY THERE HAS TO BE ONE. lib/portable.ts bounds every FIELD — a name is 64
 *  characters, an icon is 64 KiB, a potential line is 64 characters — but it
 *  does not bound the number of ROSTER ROWS, and nothing else did either. A
 *  27 MB profile (200,000 roster rows) passes parseProfile() untouched; a
 *  12.27 MB one was accepted by PUT /api/profile and stored, MEASURED against
 *  this database on 2026-09-13. Multiply by the eleven copies a user can hold
 *  (current + HISTORY_DEPTH) and one browser can put ~300 MB into a shared
 *  database, then pull it all back down again on the next GET.
 *
 *  WHERE THE NUMBER COMES FROM. The legitimate worst case is every one of the
 *  25 equip slots carrying an icon at portable.ts's MAX_ICON_CHARS (64 KiB)
 *  plus a Legion roster: MEASURED at 1.58 MB. 3 MiB is a little under twice
 *  that, so no real profile can reach it and nothing pathological gets close.
 *
 *  WHY BYTES AND NOT ROWS. A row cap would be a second validator living
 *  outside lib/portable.ts, which is the file that owns what a profile may
 *  contain. This is not a claim about profiles; it is a claim about what this
 *  table will hold, which is this file's business. */
export const MAX_PROFILE_BYTES = 3 * 1024 * 1024;

/** UTF-8 byte length of a document, without a second copy of it in memory. */
export function profileBytes(json: string): number {
  return Buffer.byteLength(json, "utf8");
}

export type Normalized =
  | { ok: true; profile: Profile; warnings: FieldError[]; migratedFrom: number }
  | { ok: false; errors: FieldError[] };

/** Accept anything a client might send — a current Profile, a pre-v1 bare
 *  Character, or a JSON string of either — and return a validated, migrated,
 *  current-version Profile, or the list of what is wrong with it. */
export function normalizePayload(input: unknown): Normalized {
  if (typeof input === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return {
        ok: false,
        errors: [
          { path: "", got: "text that is not JSON", want: "a MaplePlanner profile", fix: "nothing was saved" },
        ],
      };
    }
    return normalizePayload(parsed);
  }
  const report = migrate(input);
  if (report.unknownVersion) {
    return {
      ok: false,
      errors: [
        {
          path: "v",
          got: String(report.from),
          want: `schema version ${SCHEMA_VERSION} or older`,
          fix: "nothing was saved — this profile was written by a newer build",
        },
      ],
    };
  }
  const res = parseProfile(report.value);
  if (!res.ok) return { ok: false, errors: res.errors };
  return { ok: true, profile: res.profile, warnings: res.warnings, migratedFrom: report.from };
}

/** Wrap a Character for storage. Convenience for callers holding the in-memory
 *  shape rather than an envelope; icons are kept, they cost little in JSONB and
 *  are this account's fallback sprites on a device that has never imported. */
export function profileFromCharacter(ch: Character, at: Date = new Date()): Profile {
  const anyIcon = Object.values(ch.items).some((it) => !!it?.icon);
  return makeProfile(ch, anyIcon ? "inline" : "omitted", at);
}

/** No gear and no roster: there is nothing in here worth keeping, which is
 *  precisely what makes it dangerous to write over something that is not.
 *  Mirrors profile_payload_is_empty() in db/migrations/0001_init.sql — the SQL
 *  one is the enforcing copy, this one is for reporting. */
export function isEmptyProfile(p: Profile): boolean {
  const ch = p?.char;
  if (!ch) return true;
  const items = ch.items && typeof ch.items === "object" ? Object.keys(ch.items).length : 0;
  const roster = Array.isArray(ch.roster) ? ch.roster.length : 0;
  return items === 0 && roster === 0;
}

/* ==========================================================================
   SECTION 5 — READS
   ========================================================================== */

const ROW_COLS =
  `"userId", "rev", "schemaVersion", "data",` +
  ` to_char("updatedAt" at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAtIso",` +
  ` to_char("createdAt" at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAtIso"`;

interface RawRow {
  userId: string;
  rev: number;
  schemaVersion: number;
  data: unknown;
  updatedAtIso: string;
  createdAtIso: string;
}

function toRow(raw: RawRow): ProfileRow {
  // jsonb comes back parsed; a string would mean a driver change, so cope.
  const data = typeof raw.data === "string" ? (JSON.parse(raw.data) as unknown) : raw.data;
  return {
    userId: raw.userId,
    rev: Number(raw.rev),
    schemaVersion: Number(raw.schemaVersion),
    updatedAt: raw.updatedAtIso,
    createdAt: raw.createdAtIso,
    profile: data as Profile,
  };
}

/** The signed-in user's profile, or null when the account has none yet.
 *  null means "nothing stored", never "could not reach the database" — a
 *  connection failure throws. The caller must be able to tell those apart,
 *  because one means "seed me from localStorage" and the other means "do not
 *  touch anything". */
export async function getProfile(userId: string): Promise<ProfileRow | null> {
  const rows = (await getSql().query(
    `select ${ROW_COLS} from ${PROFILE_TABLE} where "userId" = $1`,
    [userId]
  )) as RawRow[];
  return rows.length ? toRow(rows[0]) : null;
}

/** Head only — rev, timestamps and emptiness, without shipping the document. */
export async function getProfileMeta(userId: string): Promise<ProfileMeta | null> {
  const rows = (await getSql().query(
    `select "userId", "rev", "schemaVersion", profile_payload_is_empty("data") as "isEmpty",` +
      ` to_char("updatedAt" at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAtIso",` +
      ` to_char("createdAt" at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAtIso"` +
      ` from ${PROFILE_TABLE} where "userId" = $1`,
    [userId]
  )) as Array<{
    userId: string;
    rev: number;
    schemaVersion: number;
    isEmpty: boolean;
    updatedAtIso: string;
    createdAtIso: string;
  }>;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    userId: r.userId,
    rev: Number(r.rev),
    schemaVersion: Number(r.schemaVersion),
    isEmpty: !!r.isEmpty,
    updatedAt: r.updatedAtIso,
    createdAt: r.createdAtIso,
  };
}

/* ==========================================================================
   SECTION 6 — WRITES

   Two entry points, and the difference between them is the whole safety story.
   ========================================================================== */

/** Too big for the table. Separated from `invalid` because it is not a claim
 *  about the SHAPE of the document — the document is perfectly well formed,
 *  there is just too much of it — and a caller that renders FieldError[] would
 *  have nothing useful to say about it. */
export interface TooLarge {
  status: "too-large";
  /** UTF-8 bytes of the normalised document that was refused. */
  bytes: number;
  /** MAX_PROFILE_BYTES, echoed so the caller does not have to import it. */
  limit: number;
}

export type ClaimResult =
  /** The account had no profile; this one is now it. */
  | { status: "seeded"; row: ProfileRow; warnings: FieldError[] }
  /** The account already had one and it was left exactly as it was. The row
   *  returned is the SERVER's, so the caller can offer a merge instead of
   *  guessing which side to keep. */
  | { status: "exists"; row: ProfileRow }
  | TooLarge
  | { status: "invalid"; errors: FieldError[] };

/** The rev a BRAND NEW row gets. Not 1.
 *
 *  A user can empty their account (deleteProfile) and start again, and the old
 *  revisions stay in profile_history — that is the entire point of archiving on
 *  delete. If the new row restarted at 1, its first overwrite would try to
 *  archive rev 1 into a table that already has a rev 1 for this user, and the
 *  trigger's `on conflict ("userId","rev") do nothing` would SILENTLY DROP it.
 *  MEASURED: before this expression existed, the document written immediately
 *  after a delete was the one revision that could not be recovered — which is
 *  precisely the opposite of what profile_history is for.
 *
 *  Starting above the high-water mark of the archive keeps rev monotonic across
 *  a delete/re-seed cycle, so no revision ever collides with an older one. */
function newRevExpr(userIdParam: string): string {
  return `coalesce((select max("rev") from ${PROFILE_HISTORY_TABLE} where "userId" = ${userIdParam}), 0) + 1`;
}

/** First sign-in. Inserts only into an empty account; physically cannot
 *  overwrite, because the statement is ON CONFLICT DO NOTHING.
 *
 *  This is the call a client makes the moment a session appears while it holds
 *  local data. It is safe to call from both devices, in any order, any number
 *  of times. */
export async function claimProfile(userId: string, payload: unknown): Promise<ClaimResult> {
  const norm = normalizePayload(payload);
  if (!norm.ok) return { status: "invalid", errors: norm.errors };

  const json = JSON.stringify(norm.profile);
  const bytes = profileBytes(json);
  if (bytes > MAX_PROFILE_BYTES) return { status: "too-large", bytes, limit: MAX_PROFILE_BYTES };

  const sql = getSql();
  const inserted = (await sql.query(
    `insert into ${PROFILE_TABLE} ("userId", "schemaVersion", "data", "rev")` +
      ` select $1::text, $2::int, $3::jsonb, ${newRevExpr("$1::text")}` +
      ` on conflict ("userId") do nothing` +
      ` returning ${ROW_COLS}`,
    [userId, norm.profile.v, json]
  )) as RawRow[];

  if (inserted.length) return { status: "seeded", row: toRow(inserted[0]), warnings: norm.warnings };

  const existing = await getProfile(userId);
  if (existing) return { status: "exists", row: existing };

  // The insert hit a conflict and yet there is no row: something deleted it in
  // between. ONE retry, not open recursion — the previous version called itself
  // with no depth bound, so a pathological delete loop (or a drifted constraint
  // that makes the insert always conflict) would recurse until the stack blew
  // rather than returning an answer.
  const retry = (await sql.query(
    `insert into ${PROFILE_TABLE} ("userId", "schemaVersion", "data", "rev")` +
      ` select $1::text, $2::int, $3::jsonb, ${newRevExpr("$1::text")}` +
      ` on conflict ("userId") do nothing` +
      ` returning ${ROW_COLS}`,
    [userId, norm.profile.v, json]
  )) as RawRow[];
  if (retry.length) return { status: "seeded", row: toRow(retry[0]), warnings: norm.warnings };

  const after = await getProfile(userId);
  if (after) return { status: "exists", row: after };
  throw new Error(
    `claimProfile: ${PROFILE_TABLE} row for the user neither exists nor accepts an insert after a retry; ` +
      `this should be impossible and means the table or its constraints have drifted`
  );
}

export interface SaveOptions {
  userId: string;
  /** A Profile, a bare pre-v1 Character, or JSON text of either. */
  payload: unknown;
  /** The `rev` this write is based on, from the row the client last read.
   *
   *  Both directions are checked, and that symmetry is the point:
   *    null      "I believe this account has no profile." Creates the row, and
   *              only if that is still true.
   *    a number  "I believe this account is at rev N." Replaces rev N, and only
   *              if that is still the current one. If there is NO row at all it
   *              is refused with `gone` — it does NOT create one. */
  baseRev: number | null;
  /** Permit writing an empty profile over a populated one. Only ever set this
   *  from an explicit, worded user action ("erase my account data"). */
  allowEmpty?: boolean;
  /** Skip the rev check. For a merge the user has already looked at and
   *  resolved; the losing revision is still in profile_history. */
  force?: boolean;
}

export type SaveResult =
  | { status: "saved"; row: ProfileRow; warnings: FieldError[] }
  /** Somebody else wrote since baseRev. `row` is the server's current state —
   *  merge against it and save again with row.rev as baseRev. */
  | { status: "conflict"; row: ProfileRow }
  /** The incoming document is empty and the stored one is not. Nothing was
   *  written. Pass allowEmpty only if the user actually asked to erase. */
  | { status: "refused-empty"; row: ProfileRow }
  /** A numeric baseRev was named and this account has no profile at all, so
   *  there is no revision N to replace. Nothing was written and, unlike every
   *  other branch, there is no server row to hand back — that is the answer.
   *  Deliberately NOT `conflict`: a caller that re-read and retried on conflict
   *  would loop against a row that does not exist. */
  | { status: "gone" }
  | TooLarge
  | { status: "invalid"; errors: FieldError[] };

/** Compare-and-swap write. Two devices cannot silently clobber each other:
 *  the second one to write from the same base rev is told so and handed the
 *  row it lost to. VERIFIED against this database on 2026-09-13 with eight
 *  genuinely concurrent writes from one base rev — one `saved`, seven
 *  `conflict`, final rev 2, and the winner's document intact. */
export async function saveProfile(opts: SaveOptions): Promise<SaveResult> {
  const { userId, payload, baseRev, allowEmpty = false, force = false } = opts;
  const norm = normalizePayload(payload);
  if (!norm.ok) return { status: "invalid", errors: norm.errors };

  const json = JSON.stringify(norm.profile);
  const bytes = profileBytes(json);
  if (bytes > MAX_PROFILE_BYTES) return { status: "too-large", bytes, limit: MAX_PROFILE_BYTES };

  const sql = getSql();
  // `insert ... select ... where` rather than `values`, so the INSERT half can
  // be gated too. The gate reads: propose a row if one already exists (so the
  // ON CONFLICT arm below can run its rev check) OR if this caller is entitled
  // to CREATE one, which is baseRev null ("I believe there is nothing here") or
  // force. A stale device naming rev 7 against an account whose profile was
  // deleted therefore proposes nothing and writes nothing.
  //
  // MEASURED before this gate existed: the owner deleted their planner data on
  // the PC, a MacBook still holding rev 2 sent an ordinary PUT, and the delete
  // was silently undone — the stale document came back as the account's data at
  // rev 1, with no conflict reported to either device.
  const rows = (await sql.query(
    `insert into ${PROFILE_TABLE} ("userId", "schemaVersion", "data", "rev")` +
      ` select $1::text, $2::int, $3::jsonb, ${newRevExpr("$1::text")}` +
      ` where exists (select 1 from ${PROFILE_TABLE} where "userId" = $1::text)` +
      `    or $4::int is null` +
      `    or $6::boolean` +
      ` on conflict ("userId") do update set` +
      `   "data" = excluded."data",` +
      `   "schemaVersion" = excluded."schemaVersion",` +
      `   "rev" = ${PROFILE_TABLE}."rev" + 1,` +
      `   "updatedAt" = now()` +
      ` where (${PROFILE_TABLE}."rev" = $4::int or $6::boolean)` +
      `   and ($5::boolean or not (` +
      `        profile_payload_is_empty(excluded."data")` +
      `        and not profile_payload_is_empty(${PROFILE_TABLE}."data")))` +
      ` returning ${ROW_COLS}`,
    [userId, norm.profile.v, json, baseRev, allowEmpty, force]
  )) as RawRow[];

  if (rows.length) return { status: "saved", row: toRow(rows[0]), warnings: norm.warnings };

  // Zero rows means one of the three gates refused. Read the row back to say
  // which; every answer below needs the server's current state anyway, and
  // re-reading is also what settles the race between the `where exists` check
  // and the insert itself.
  const current = await getProfile(userId);
  if (!current) {
    if (baseRev !== null && !force) {
      // The caller named a revision of a profile this account does not have.
      return { status: "gone" };
    }
    // baseRev was null (or force): the caller IS entitled to create the row, so
    // the only way to get here is a concurrent delete between the two
    // statements. One retry, which terminates.
    const retry = (await sql.query(
      `insert into ${PROFILE_TABLE} ("userId", "schemaVersion", "data", "rev")` +
        ` select $1::text, $2::int, $3::jsonb, ${newRevExpr("$1::text")}` +
        ` on conflict ("userId") do nothing returning ${ROW_COLS}`,
      [userId, norm.profile.v, json]
    )) as RawRow[];
    if (retry.length) return { status: "saved", row: toRow(retry[0]), warnings: norm.warnings };
    const after = await getProfile(userId);
    if (after) return { status: "conflict", row: after };
    // Refused to insert, and nothing is there to have refused for. Do not
    // pretend this was a normal conflict — a caller that sees `conflict` would
    // retry forever against a row that does not exist.
    throw new Error(
      `saveProfile: ${PROFILE_TABLE} row for the user neither exists nor accepts an insert; ` +
        `this should be impossible and means the table or its constraints have drifted`
    );
  }
  const revMatched = force || current.rev === baseRev;
  if (revMatched && isEmptyProfile(norm.profile) && !isEmptyProfile(current.profile)) {
    return { status: "refused-empty", row: current };
  }
  return { status: "conflict", row: current };
}

/** Erase the account's planner data. The current revision is archived first,
 *  in the same transaction, so "delete" is still undoable from history until
 *  the user row itself goes (which cascades everything). */
export async function deleteProfile(userId: string): Promise<boolean> {
  const sql = getSql();
  const results = await sql.transaction([
    sql.query(
      `insert into ${PROFILE_HISTORY_TABLE} ("userId", "rev", "schemaVersion", "data")` +
        ` select "userId", "rev", "schemaVersion", "data" from ${PROFILE_TABLE} where "userId" = $1` +
        ` on conflict ("userId", "rev") do nothing`,
      [userId]
    ),
    sql.query(`delete from ${PROFILE_TABLE} where "userId" = $1 returning "userId"`, [userId]),
  ]);
  const deleted = results[1] as Array<{ userId: string }>;
  return deleted.length > 0;
}

/* ==========================================================================
   SECTION 7 — HISTORY

   The last resort. If a guard is ever wrong, or a user forces a merge and
   regrets it, the previous document is still here.
   ========================================================================== */

export async function listProfileHistory(
  userId: string,
  limit: number = HISTORY_DEPTH
): Promise<HistoryEntry[]> {
  const rows = (await getSql().query(
    `select "userId", "rev", "schemaVersion", profile_payload_is_empty("data") as "isEmpty",` +
      ` to_char("replacedAt" at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "replacedAtIso"` +
      ` from ${PROFILE_HISTORY_TABLE} where "userId" = $1 order by "rev" desc limit $2`,
    [userId, Math.max(1, Math.min(limit, HISTORY_DEPTH))]
  )) as Array<{
    userId: string;
    rev: number;
    schemaVersion: number;
    isEmpty: boolean;
    replacedAtIso: string;
  }>;
  return rows.map((r) => ({
    userId: r.userId,
    rev: Number(r.rev),
    schemaVersion: Number(r.schemaVersion),
    isEmpty: !!r.isEmpty,
    replacedAt: r.replacedAtIso,
  }));
}

/** One archived revision's document, for preview or for restore. */
export async function getProfileRevision(userId: string, rev: number): Promise<Profile | null> {
  const rows = (await getSql().query(
    `select "data" from ${PROFILE_HISTORY_TABLE} where "userId" = $1 and "rev" = $2`,
    [userId, rev]
  )) as Array<{ data: unknown }>;
  if (!rows.length) return null;
  const d = rows[0].data;
  return (typeof d === "string" ? JSON.parse(d) : d) as Profile;
}

/** Restore an archived revision as the current one. Goes through saveProfile so
 *  it takes a new rev, archives what it replaces, and is itself undoable. */
export async function restoreProfileRevision(
  userId: string,
  rev: number,
  baseRev: number
): Promise<SaveResult> {
  const old = await getProfileRevision(userId, rev);
  if (!old) {
    return {
      status: "invalid",
      errors: [
        { path: "rev", got: String(rev), want: "an archived revision of this profile", fix: "nothing was restored" },
      ],
    };
  }
  // allowEmpty: restoring an empty revision is an explicit, named choice.
  return saveProfile({ userId, payload: old, baseRev, allowEmpty: true });
}
