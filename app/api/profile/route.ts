// The signed-in user's planner data, over HTTP.
//
// ---------------------------------------------------------------------------
// WHAT IS ACTUALLY AT STAKE
// ---------------------------------------------------------------------------
// A 25-slot gear set entered by hand and a 31-row Legion roster read out of
// screenshots. Hours of work, in one browser's localStorage, on one machine.
// The whole reason accounts exist is to get that onto the MacBook too.
//
// So the failure this file is built around is NOT "sign-in is broken". It is:
// the owner signs in for the first time, and a naive sync either pushes an
// empty MacBook over the PC's data or pulls an empty account down on top of it.
// Either direction is unrecoverable in the way that matters — the data is not
// anywhere else.
//
// The rule that follows from that, and which every branch below obeys:
//
//     A WRITE MAY ONLY EVER ADD. Nothing here replaces populated data with
//     different data unless the caller has named the revision it is replacing,
//     or a human has explicitly said to.
//
// ---------------------------------------------------------------------------
// THE FOUR VERBS
// ---------------------------------------------------------------------------
//   GET    /api/profile   read mine
//   POST   /api/profile   FIRST SIGN-IN. "Here is what this browser holds."
//                         Never destructive. See THE MERGE TABLE below.
//   PUT    /api/profile   normal save. Compare-and-swap on `rev`.
//   DELETE /api/profile   erase, behind a typed confirmation phrase.
//
// ---------------------------------------------------------------------------
// THE MERGE TABLE — what POST does, for every combination, no exceptions
// ---------------------------------------------------------------------------
//  browser (local)  | account (server)        | outcome            | HTTP
//  -----------------+-------------------------+--------------------+-----
//  populated        | no row at all           | "seeded"           | 201
//                   |   the local data BECOMES the account. This is the case
//                   |   the wave exists for.
//  populated        | row exists, but empty   | "upgraded"         | 200
//                   |   an empty row holds nothing, so filling it loses
//                   |   nothing. Done as a compare-and-swap on that row's rev.
//  populated        | row, same data          | "identical"        | 200
//                   |   nothing to do; client adopts the server rev.
//  populated        | row, DIFFERENT data     | "both-populated"   | 409
//                   |   NOTHING IS WRITTEN. Both documents come back in the
//                   |   response, each with a summary (item count, roster
//                   |   count, when it was saved) so the UI can show the owner
//                   |   what is on each side and let them choose or merge.
//                   |   This is the branch that must never silently pick.
//  empty or absent  | no row                  | "nothing-to-claim" | 200
//                   |   NOTHING IS WRITTEN. Creating an empty row here would
//                   |   poison the next real claim from the PC — it would turn
//                   |   the first row of this table into the fourth.
//  empty or absent  | row exists              | "adopt"            | 200
//                   |   the MacBook case. Pull the server's data down; the
//                   |   empty browser never pushes.
//  unreadable       | any                     | "invalid"          | 422
//                   |   NOTHING IS WRITTEN, and errors[] is the same
//                   |   FieldError[] the import dialog already renders.
//
// POST is idempotent and safe to call on every sign-in, from both machines, in
// any order. It cannot destroy anything, by construction: the only writes it
// can perform are an insert into an empty account and a rev-checked fill of an
// empty row.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT HERE
// ---------------------------------------------------------------------------
// An automatic merge of two populated profiles. There is no correct answer to
// "the PC says 22 stars and the MacBook says 17" that a server can pick, and a
// wrong pick is silent and permanent. The server's job is to preserve both and
// hand the question to a human. Whatever the human decides comes back as an
// ordinary PUT with the server's `rev` as `baseRev`, and the revision it
// replaces is still in profile_history for ten revisions afterwards.
//
// ---------------------------------------------------------------------------
// ISOLATION
// ---------------------------------------------------------------------------
// Every handler derives the user id from the session cookie via lib/auth.ts.
// There is no userId parameter anywhere in this file — not in the path, not in
// the query, not in the body — so there is nothing for one account to put
// another account's id into.

import { NextResponse } from "next/server";
import {
  DatabaseNotConfiguredError,
  claimProfile,
  deleteProfile,
  getProfile,
  isEmptyProfile,
  normalizePayload,
  saveProfile,
  type ProfileRow,
} from "@/lib/db";
import { getUserId } from "@/lib/auth";
import type { FieldError, Profile } from "@/lib/portable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ==========================================================================
   SECTION 1 — SHARED SHAPES

   Documented here because the UI wave wires against them. Every response is a
   JSON object with a `status` string; `status` is the discriminant and is
   always present, including on errors.
   ========================================================================== */

/** Enough to describe a profile to a human without shipping the document.
 *  This is what makes the "both populated" dialog answerable: "PC: 25 items,
 *  31 characters, Lv.244 Wind Archer" against the same for the account. */
export interface ProfileSummary {
  /** Number of equipped slots with an item in them. The 25 that matter. */
  items: number;
  /** Number of Legion roster rows. The 31 that matter. */
  roster: number;
  /** Active character's name, or "" if unnamed. */
  name: string;
  /** Active character's level, 0 if unset. */
  lvl: number;
  /** Active character's class, or "". */
  cls: string;
  /** The envelope's own timestamp. Informational only — never used to decide
   *  which side wins, because a client clock is not evidence. */
  exported: string;
  /** True when there is no gear and no roster. */
  isEmpty: boolean;
}

function summarize(p: Profile | null | undefined): ProfileSummary {
  const ch = p?.char;
  const items = ch?.items && typeof ch.items === "object" ? Object.keys(ch.items).length : 0;
  const roster = Array.isArray(ch?.roster) ? ch.roster.length : 0;
  return {
    items,
    roster,
    name: typeof ch?.name === "string" ? ch.name : "",
    lvl: typeof ch?.lvl === "number" ? ch.lvl : 0,
    cls: typeof ch?.cls === "string" ? ch.cls : "",
    exported: typeof p?.exported === "string" ? p.exported : "",
    isEmpty: p ? isEmptyProfile(p) : true,
  };
}

/** The server's row, in the shape every response uses for it. */
function serverSide(row: ProfileRow) {
  return {
    rev: row.rev,
    schemaVersion: row.schemaVersion,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    summary: summarize(row.profile),
    profile: row.profile,
  };
}

const UNAUTHENTICATED = {
  status: "unauthenticated" as const,
  message: "Sign in to read or write planner data.",
};

/** One place that turns a thrown error into a response, so no handler can
 *  accidentally report an outage as "you have no data yet" — which is the lie
 *  that would make a client seed an empty profile over a full one. */
function failure(err: unknown): NextResponse {
  if (err instanceof DatabaseNotConfiguredError) {
    // The message names no connection string; see lib/db.ts.
    return NextResponse.json(
      {
        status: "misconfigured",
        message:
          "The planner database is not configured on this deployment. " +
          "Nothing was read or written. Do not treat this as an empty account.",
      },
      { status: 503 }
    );
  }
  // Anything else: a network blip, a constraint, a drifted schema. Never echo
  // the raw message to the client — it can contain SQL and, in the worst case,
  // a connection string from a driver-level error.
  console.error("[api/profile] request failed:", err);
  return NextResponse.json(
    {
      status: "unavailable",
      message:
        "The planner database could not be reached. Nothing was read or written. " +
        "Do not treat this as an empty account.",
    },
    { status: 503 }
  );
}

/** Body parsing that cannot throw. A malformed body is a 400, not a 500. */
async function readJsonBody(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  try {
    const raw: unknown = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
    return { ok: true, body: raw as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function badBody(detail: string): NextResponse {
  return NextResponse.json({ status: "bad-request", message: detail }, { status: 400 });
}

/** Key-sorted JSON, because `JSON.stringify` is not a comparison function here.
 *
 *  The stored side comes back out of a Postgres JSONB column, and jsonb does
 *  NOT preserve object key order — it stores keys sorted by length and then
 *  bytewise. So the same character, written and read back, serialises to a
 *  different string than the one the browser just sent, and a naive
 *  `JSON.stringify(a) === JSON.stringify(b)` calls every already-synced device
 *  a conflict. That is not a cosmetic bug: it would put the "both populated,
 *  choose one" dialog in front of the owner on every single sign-in, which is
 *  exactly how someone gets trained to click through it and lose a roster.
 *
 *  Array order is preserved deliberately — the roster is a list, and two
 *  rosters in a different order are not the same roster. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Two profiles are "the same" when their characters are. `exported` is a
 *  client timestamp that differs on every export, so whole envelopes are never
 *  compared — only `char`, which both sides have been through
 *  parseProfile()'s canonicalisation.
 *
 *  A false "different" is survivable — it routes to the ask-the-human branch. A
 *  false "same" would silently discard one side, so the comparison is exact on
 *  values and merely order-insensitive on object keys. */
function sameCharacter(a: Profile, b: Profile): boolean {
  try {
    return stableStringify(a.char) === stableStringify(b.char);
  } catch {
    return false;
  }
}

function invalidResponse(errors: FieldError[]): NextResponse {
  return NextResponse.json(
    {
      status: "invalid",
      message: "Nothing was saved. The payload did not validate.",
      errors,
    },
    { status: 422 }
  );
}

/* ==========================================================================
   SECTION 2 — GET: read mine

   200 { status: "ok",    hasProfile: true,  rev, schemaVersion, updatedAt,
         createdAt, summary, profile }
   200 { status: "empty", hasProfile: false }   // the account genuinely has none
   401 { status: "unauthenticated" }
   503 { status: "unavailable" | "misconfigured" }

   `hasProfile: false` and a 503 are different answers on purpose. "No row" means
   seed me from the browser; "could not reach the database" means touch nothing.
   A client that collapses those two will eventually overwrite real data with an
   empty document during an outage.
   ========================================================================== */

export async function GET(req: Request): Promise<NextResponse> {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json(UNAUTHENTICATED, { status: 401 });

  try {
    const row = await getProfile(userId);
    if (!row) {
      return NextResponse.json({ status: "empty", hasProfile: false });
    }
    return NextResponse.json({ status: "ok", hasProfile: true, ...serverSide(row) });
  } catch (err) {
    return failure(err);
  }
}

/* ==========================================================================
   SECTION 3 — POST: first sign-in. THE MERGE.

   Body: { payload }   — whatever the browser holds. A Profile envelope, a bare
                         pre-v1 Character, JSON text of either, or null/omitted
                         to mean "this browser has nothing".

   201 { status: "seeded",           ...server, warnings }
   200 { status: "upgraded",         ...server, warnings }
   200 { status: "identical",        ...server }
   200 { status: "adopt",            ...server }
   200 { status: "nothing-to-claim", hasProfile: false }
   409 { status: "both-populated",   local: {summary, profile},
                                     server: {rev, ..., summary, profile} }
   422 { status: "invalid",          errors }
   ========================================================================== */

export async function POST(req: Request): Promise<NextResponse> {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json(UNAUTHENTICATED, { status: 401 });

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return badBody("Expected a JSON object: { payload }.");
  const payload = parsed.body.payload;

  try {
    // ---- Does this browser have anything to offer? --------------------------
    // "Nothing" is null, undefined, or a document that validates to an empty
    // profile. It is NOT an unreadable document: that is a 422 below, because
    // silently treating corrupt local data as "nothing" and then adopting the
    // server's would be indistinguishable from losing it.
    const hasLocalInput = payload !== null && payload !== undefined && payload !== "";

    let localProfile: Profile | null = null;
    let localWarnings: FieldError[] = [];
    if (hasLocalInput) {
      const norm = normalizePayload(payload);
      if (!norm.ok) return invalidResponse(norm.errors);
      localProfile = norm.profile;
      localWarnings = norm.warnings;
    }
    const localIsEmpty = !localProfile || isEmptyProfile(localProfile);

    // ---- The empty-browser rows of the merge table -------------------------
    // This is the MacBook signing in for the first time. It must never write.
    if (localIsEmpty) {
      const existing = await getProfile(userId);
      if (!existing) {
        // No row, nothing to store. Deliberately does NOT create an empty row:
        // an empty row would make the PC's later first sign-in fall into the
        // "both populated"/"upgraded" path instead of the clean "seeded" one.
        return NextResponse.json({ status: "nothing-to-claim", hasProfile: false });
      }
      return NextResponse.json({ status: "adopt", hasProfile: true, ...serverSide(existing) });
    }

    // ---- The populated-browser rows ----------------------------------------
    // claimProfile() is ON CONFLICT DO NOTHING: it can insert into an account
    // that has no profile, and it is physically incapable of overwriting one
    // that does. That property is what makes this endpoint safe to call from
    // both machines at once.
    const claim = await claimProfile(userId, localProfile);

    if (claim.status === "invalid") return invalidResponse(claim.errors);

    if (claim.status === "seeded") {
      return NextResponse.json(
        {
          status: "seeded",
          hasProfile: true,
          ...serverSide(claim.row),
          warnings: localWarnings,
        },
        { status: 201 }
      );
    }

    // claim.status === "exists": the account already had a profile, and it was
    // left exactly as it was. Three sub-cases, and only one of them writes.
    const server = claim.row;

    if (isEmptyProfile(server.profile)) {
      // An empty row holds nothing, so filling it cannot lose anything. Still
      // done as a compare-and-swap against the rev we just read, so a real
      // profile that landed in the microsecond between the read and the write
      // turns into a conflict rather than a loss.
      const save = await saveProfile({
        userId,
        payload: localProfile,
        baseRev: server.rev,
      });
      if (save.status === "saved") {
        return NextResponse.json({
          status: "upgraded",
          hasProfile: true,
          ...serverSide(save.row),
          warnings: localWarnings,
        });
      }
      if (save.status === "invalid") return invalidResponse(save.errors);
      // Lost the race, or the guard fired. Fall through to the ask-a-human
      // branch with whatever is actually on the server now.
      return bothPopulated(localProfile!, save.row);
    }

    if (sameCharacter(localProfile!, server.profile)) {
      // Same data on both sides. Nothing to write, nothing to ask. The client
      // takes server.rev and is now a normal, synced device.
      return NextResponse.json({ status: "identical", hasProfile: true, ...serverSide(server) });
    }

    // Two different populated profiles. The one branch where the server refuses
    // to decide. Nothing was written; the browser's copy is untouched in
    // localStorage and the account's copy is untouched in Postgres.
    return bothPopulated(localProfile!, server);
  } catch (err) {
    return failure(err);
  }
}

/** 409 with BOTH documents and both summaries. The UI renders the two
 *  summaries side by side, the owner picks (or merges by hand), and the answer
 *  comes back as a PUT with `baseRev` = the `rev` in here. */
function bothPopulated(local: Profile, server: ProfileRow): NextResponse {
  return NextResponse.json(
    {
      status: "both-populated",
      message:
        "This browser and this account each hold planner data, and they differ. " +
        "Nothing was changed on either side. Choose which to keep, or merge them, " +
        "then PUT the result with baseRev set to server.rev.",
      local: { summary: summarize(local), profile: local },
      server: serverSide(server),
    },
    { status: 409 }
  );
}

/* ==========================================================================
   SECTION 4 — PUT: the ordinary save

   Body: { payload, baseRev, allowEmpty?, force? }

     payload    a Profile, a bare pre-v1 Character, or JSON text of either.
     baseRev    the `rev` this edit was made on top of. `null` asserts "I
                believe this account has no profile yet" and succeeds only if
                that is still true. REQUIRED — there is no "just overwrite"
                default, because a missing rev is exactly how last-write-wins
                data loss gets in.
     allowEmpty optional. Permits storing an empty profile over a populated
                one. Only ever send this from a worded confirmation.
     force      optional. Skips the rev check. For a merge a human has already
                looked at and resolved. The revision it replaces is archived in
                profile_history either way.

   200 { status: "saved",         rev, updatedAt, summary, warnings }
   409 { status: "conflict",      server: {...} }   // somebody else wrote
   409 { status: "refused-empty", server: {...} }   // guard fired
   422 { status: "invalid",       errors }
   ========================================================================== */

export async function PUT(req: Request): Promise<NextResponse> {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json(UNAUTHENTICATED, { status: 401 });

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return badBody("Expected a JSON object: { payload, baseRev }.");
  const { payload, baseRev, allowEmpty, force } = parsed.body;

  if (payload === undefined || payload === null) {
    return badBody("`payload` is required. To erase account data, use DELETE.");
  }
  // baseRev must be stated. Absent is not the same as null: null is a claim
  // ("there is no profile"), absent is a caller that has not thought about it.
  if (!("baseRev" in parsed.body)) {
    return badBody(
      "`baseRev` is required — send the rev you last read, or null if you believe " +
        "this account has no profile. Omitting it would mean last-write-wins."
    );
  }
  if (baseRev !== null && (typeof baseRev !== "number" || !Number.isInteger(baseRev) || baseRev < 1)) {
    return badBody("`baseRev` must be null or a positive integer.");
  }
  if (allowEmpty !== undefined && typeof allowEmpty !== "boolean") {
    return badBody("`allowEmpty` must be a boolean when present.");
  }
  if (force !== undefined && typeof force !== "boolean") {
    return badBody("`force` must be a boolean when present.");
  }

  try {
    const result = await saveProfile({
      userId,
      payload,
      baseRev: baseRev as number | null,
      allowEmpty: allowEmpty === true,
      force: force === true,
    });

    switch (result.status) {
      case "saved":
        return NextResponse.json({
          status: "saved",
          hasProfile: true,
          ...serverSide(result.row),
          warnings: result.warnings,
        });

      case "conflict":
        return NextResponse.json(
          {
            status: "conflict",
            message:
              "Another device wrote since baseRev. Nothing was saved. Merge against " +
              "server.profile and PUT again with baseRev = server.rev.",
            server: serverSide(result.row),
          },
          { status: 409 }
        );

      case "refused-empty":
        return NextResponse.json(
          {
            status: "refused-empty",
            message:
              "Refused: the incoming profile is empty and the stored one is not. " +
              "Nothing was saved. If the account holder actually asked to erase " +
              "their data, send allowEmpty: true — otherwise this is a client bug.",
            server: serverSide(result.row),
          },
          { status: 409 }
        );

      case "invalid":
        return invalidResponse(result.errors);
    }
  } catch (err) {
    return failure(err);
  }
}

/* ==========================================================================
   SECTION 5 — DELETE: erase this account's planner data

   Body: { confirm: "delete my planner data" }

   The phrase is required and exact. A DELETE with no body, or with the wrong
   phrase, does nothing and returns 400 — so a stray fetch, a double-fired
   handler or a curl typo cannot erase a roster.

   The current revision is archived into profile_history first, in the same
   transaction, so this is still undoable from history afterwards. The account
   itself is untouched: the owner stays signed in and can start again.

   200 { status: "deleted" | "nothing-to-delete" }
   ========================================================================== */

const DELETE_PHRASE = "delete my planner data";

export async function DELETE(req: Request): Promise<NextResponse> {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json(UNAUTHENTICATED, { status: 401 });

  const parsed = await readJsonBody(req);
  if (!parsed.ok || parsed.body.confirm !== DELETE_PHRASE) {
    return badBody(
      `Refused: erasing planner data requires { "confirm": "${DELETE_PHRASE}" } in the body. Nothing was deleted.`
    );
  }

  try {
    const deleted = await deleteProfile(userId);
    return NextResponse.json({
      status: deleted ? "deleted" : "nothing-to-delete",
      message: deleted
        ? "Planner data erased. The last revision is still in profile_history."
        : "This account had no planner data.",
    });
  } catch (err) {
    return failure(err);
  }
}
