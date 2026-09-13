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
//   * saveProfile()   is a compare-and-swap on `rev`. A device writing from a
//                     stale read gets `conflict` and the server's row back; it
//                     never wins by being last.
//   * the empty guard refuses a write that would replace a populated profile
//                     with an empty one, unless the caller passes allowEmpty.
//                     That is the "blank profile lands on 31 characters" case,
//                     blocked in SQL rather than in a component.
//   * profile_history keeps the previous ten revisions. Even a forced overwrite
//                     is recoverable — see listProfileHistory/getProfileRevision.
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

export type ClaimResult =
  /** The account had no profile; this one is now it. */
  | { status: "seeded"; row: ProfileRow; warnings: FieldError[] }
  /** The account already had one and it was left exactly as it was. The row
   *  returned is the SERVER's, so the caller can offer a merge instead of
   *  guessing which side to keep. */
  | { status: "exists"; row: ProfileRow }
  | { status: "invalid"; errors: FieldError[] };

/** First sign-in. Inserts only into an empty account; physically cannot
 *  overwrite, because the statement is ON CONFLICT DO NOTHING.
 *
 *  This is the call a client makes the moment a session appears while it holds
 *  local data. It is safe to call from both devices, in any order, any number
 *  of times. */
export async function claimProfile(userId: string, payload: unknown): Promise<ClaimResult> {
  const norm = normalizePayload(payload);
  if (!norm.ok) return { status: "invalid", errors: norm.errors };

  const sql = getSql();
  const inserted = (await sql.query(
    `insert into ${PROFILE_TABLE} ("userId", "schemaVersion", "data", "rev")` +
      ` values ($1, $2, $3::jsonb, 1)` +
      ` on conflict ("userId") do nothing` +
      ` returning ${ROW_COLS}`,
    [userId, norm.profile.v, JSON.stringify(norm.profile)]
  )) as RawRow[];

  if (inserted.length) return { status: "seeded", row: toRow(inserted[0]), warnings: norm.warnings };

  const existing = await getProfile(userId);
  // Lost a race with a concurrent delete; retrying once is honest here.
  if (!existing) return claimProfile(userId, payload);
  return { status: "exists", row: existing };
}

export interface SaveOptions {
  userId: string;
  /** A Profile, a bare pre-v1 Character, or JSON text of either. */
  payload: unknown;
  /** The `rev` this write is based on, from the row the client last read.
   *  null means "I believe this account has no profile" — which succeeds only
   *  if that is still true. */
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
  | { status: "invalid"; errors: FieldError[] };

/** Compare-and-swap write. Two devices cannot silently clobber each other:
 *  the second one to write from the same base rev is told so and handed the
 *  row it lost to. */
export async function saveProfile(opts: SaveOptions): Promise<SaveResult> {
  const { userId, payload, baseRev, allowEmpty = false, force = false } = opts;
  const norm = normalizePayload(payload);
  if (!norm.ok) return { status: "invalid", errors: norm.errors };

  const sql = getSql();
  const rows = (await sql.query(
    `insert into ${PROFILE_TABLE} ("userId", "schemaVersion", "data", "rev")` +
      ` values ($1, $2, $3::jsonb, 1)` +
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
    [userId, norm.profile.v, JSON.stringify(norm.profile), baseRev, allowEmpty, force]
  )) as RawRow[];

  if (rows.length) return { status: "saved", row: toRow(rows[0]), warnings: norm.warnings };

  // Zero rows means the ON CONFLICT ... WHERE refused. Read the row back to say
  // which guard fired; both answers need the server's row anyway.
  const current = await getProfile(userId);
  if (!current) {
    // The row vanished between the insert attempt and the read — nothing to
    // conflict with any more, so one retry is safe and terminates.
    const retry = (await sql.query(
      `insert into ${PROFILE_TABLE} ("userId", "schemaVersion", "data", "rev")` +
        ` values ($1, $2, $3::jsonb, 1) on conflict ("userId") do nothing returning ${ROW_COLS}`,
      [userId, norm.profile.v, JSON.stringify(norm.profile)]
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
