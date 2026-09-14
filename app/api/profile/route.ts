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
//  too big          | any                     | "too-large"        | 413
//                   |   NOTHING IS WRITTEN. See HOW BIG IS TOO BIG below.
//
// ---------------------------------------------------------------------------
// HOW BIG IS TOO BIG, AND WHICH LIMIT YOU HIT
// ---------------------------------------------------------------------------
// A profile carries item icons as base64 data URLs, so it is genuinely large
// for a JSON document. lib/portable.ts bounds every field — 64 KiB per icon, 64
// characters per name — but nothing bounded the ROSTER, and therefore nothing
// bounded the document. MEASURED against this deployment on 2026-09-13, before
// the caps below existed: a 12.27 MB PUT was accepted, stored, and handed back
// in full on the next GET; a 27 MB document passed lib/portable.ts's validator
// in 17 ms. Eleven copies per user (current plus ten in profile_history) made
// that roughly 300 MB of shared database per browser that asked for it.
//
// Two caps, and a 413 always says which one it was, in `scope`:
//   scope: "request"  MAX_REQUEST_BYTES — the HTTP body, counted as it streams
//                     in, so an oversized request is refused WITHOUT being
//                     buffered or parsed. 4 MiB. Also deliberately under
//                     Vercel's own 4.5 MB body limit, so on the deployment it
//                     is this message the caller gets rather than a platform
//                     error page with no `status` in it.
//   scope: "profile"  lib/db.ts's MAX_PROFILE_BYTES — the normalised document
//                     that would be stored. 3 MiB, against a MEASURED
//                     legitimate worst case of 1.58 MB (all 25 slots carrying
//                     an icon at portable.ts's 64 KiB cap, plus a roster).
// A payload sent as JSON *text* rather than as an object has less room than it
// looks: escaping roughly doubles it on the wire, and the request cap counts
// the wire.
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
//
// VERIFIED, not merely intended. Two accounts were signed up through the real
// /api/auth/sign-up/email on 2026-09-13 and one of them tried to reach the
// other's row through ?userId=, ?user=, ?id=, /api/profile/<id>, an x-user-id
// header, an x-forwarded-user header, body.userId, body.user.id, and a DELETE
// naming the other id. Every one of them landed on the caller's OWN row; the
// other account's document was never read and never written. A session token
// with one byte changed — in the signature or in the body — is a 401, not a
// session, and the signed session-cache cookie alone is a 401 too.

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
  type TooLarge,
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

   That last sentence used to be untrue and is the reason resolveCaller() below
   exists: a database outage that reached the SESSION lookup — which is every
   request once the five-minute session-cookie cache lapses — escaped the
   handler and produced a bare 500 with an empty body. See resolveCaller().
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

/** Who is asking — or the response to send instead.
 *
 *  getUserId() is NOT a pure cookie read. lib/auth.ts caches the session in a
 *  signed cookie for five minutes; past that, resolving a session is a query
 *  against the same Postgres this route stores profiles in. So a database
 *  outage makes identity itself throw, before any handler's own try block has
 *  started.
 *
 *  MEASURED on 2026-09-13, with the server restarted against an unreachable
 *  DATABASE_URL and a cookie that had been valid seconds earlier: with the
 *  session cache still warm, every verb answered 503 "unavailable" exactly as
 *  intended — but with the cache cookie dropped, the way every request looks
 *  after five minutes, the throw escaped the handler and Next answered a bare
 *  HTTP 500 with an EMPTY BODY and no content-type. No `status`, from a route
 *  whose stated contract is that `status` is always present, including on
 *  errors. A client matching on `status` had nothing to match, during exactly
 *  the outage where guessing wrong means writing an empty profile over a real
 *  one.
 *
 *  So the session lookup gets the same treatment as every other database call:
 *  it is an outage, it is a 503, and it says nothing was read or written.
 *  A throw is never reported as "not signed in" — 401 is reserved for the case
 *  where the database answered and there is genuinely no session. */
type Caller = { ok: true; userId: string } | { ok: false; response: NextResponse };

async function resolveCaller(req: Request): Promise<Caller> {
  let userId: string | null;
  try {
    userId = await getUserId(req);
  } catch (err) {
    return { ok: false, response: failure(err) };
  }
  if (!userId) return { ok: false, response: NextResponse.json(UNAUTHENTICATED, { status: 401 }) };
  return { ok: true, userId };
}

/** The HTTP body cap. See HOW BIG IS TOO BIG in the header. Not exported: a
 *  route module's value exports are route segment configuration to Next. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** Read the body with a hard byte ceiling, counted as it arrives.
 *
 *  `await req.json()` was the obvious thing and it is the wrong thing: it
 *  buffers and parses the whole body first, so the 12.27 MB request measured
 *  above was fully received and fully parsed before anything could object. The
 *  ceiling has to be enforced against the STREAM to mean anything.
 *
 *  Content-Length is checked first because it is free, but it is a claim by the
 *  caller, not a fact — a chunked request has none and a hostile one can lie —
 *  so the streaming count below is the enforcing copy. */
async function readCapped(
  req: Request,
  limit: number
): Promise<{ ok: true; text: string } | { ok: false; reason: "too-large" | "unreadable" }> {
  const stream = req.body;
  if (!stream) return { ok: true, text: "" };
  const reader = stream.getReader();
  // Streaming decode: a multi-byte character split across two chunks would
  // otherwise decode to a replacement character and corrupt an IGN.
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false, reason: "too-large" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true, text };
}

type BodyRead =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "too-large"; declared: number | null };

/** Body parsing that cannot throw. A malformed body is a 400, an oversized one
 *  a 413, and neither is ever a 500. */
async function readJsonBody(req: Request): Promise<BodyRead> {
  const header = req.headers.get("content-length");
  const declared = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  if (declared !== null && declared > MAX_REQUEST_BYTES) {
    return { ok: false, reason: "too-large", declared };
  }

  const read = await readCapped(req, MAX_REQUEST_BYTES);
  if (!read.ok) {
    if (read.reason === "too-large") return { ok: false, reason: "too-large", declared };
    return { ok: false, reason: "malformed" };
  }
  try {
    const raw: unknown = JSON.parse(read.text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "malformed" };
    return { ok: true, body: raw as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

function badBody(detail: string): NextResponse {
  return NextResponse.json({ status: "bad-request", message: detail }, { status: 400 });
}

/** 413 for the HTTP body. `bytes` is the caller's declared Content-Length and
 *  is null when the request did not declare one — in that case all that is
 *  known is that the stream went past the limit, and saying so is the honest
 *  answer rather than inventing a figure. */
function requestTooLarge(declared: number | null): NextResponse {
  return NextResponse.json(
    {
      status: "too-large",
      scope: "request" as const,
      limitBytes: MAX_REQUEST_BYTES,
      bytes: declared,
      message:
        `Nothing was read or written: the request body exceeds ${MAX_REQUEST_BYTES} bytes. ` +
        `This is the whole HTTP body, not the profile inside it — a payload sent as JSON text ` +
        `rather than as an object roughly doubles on the wire. Send the profile as an object.`,
    },
    { status: 413 }
  );
}

/** 413 for the document. Distinct `scope` from the one above because the fixes
 *  are different: this one is not about how the payload was encoded, it is that
 *  the profile itself is too big to store. */
function profileTooLarge(result: TooLarge): NextResponse {
  return NextResponse.json(
    {
      status: "too-large",
      scope: "profile" as const,
      limitBytes: result.limit,
      bytes: result.bytes,
      message:
        `Nothing was saved: this profile is ${result.bytes} bytes and the limit is ${result.limit}. ` +
        `A real profile does not reach this — the largest legitimate one measured is about 1.6 MB, ` +
        `every icon at its maximum — so the usual cause is a roster that has grown without bound.`,
    },
    { status: 413 }
  );
}

/** 409 for a write that named a revision of a profile this account no longer
 *  has. There is no server row to return; that absence IS the answer. */
function goneResponse(): NextResponse {
  return NextResponse.json(
    {
      status: "gone",
      message:
        "Nothing was saved: you sent baseRev for a revision this account does not have, because " +
        "its planner data has since been deleted. Re-read with GET — it will say empty — and then " +
        "POST to claim this browser's data, or PUT again with baseRev: null if you mean to re-create " +
        "the profile from this device. Sending the same baseRev again will not start working.",
    },
    { status: 409 }
  );
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
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;
  const userId = caller.userId;

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
   409 { status: "gone" }            // the row was deleted mid-claim, twice
   413 { status: "too-large",        scope, limitBytes, bytes }
   422 { status: "invalid",          errors }
   ========================================================================== */

export async function POST(req: Request): Promise<NextResponse> {
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;
  const userId = caller.userId;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    if (parsed.reason === "too-large") return requestTooLarge(parsed.declared);
    return badBody("Expected a JSON object: { payload }.");
  }
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
    return await claimOrFill(userId, localProfile!, localWarnings, 0);
  } catch (err) {
    return failure(err);
  }
}

/** The populated-browser half of the merge table.
 *
 *  claimProfile() is ON CONFLICT DO NOTHING: it can insert into an account that
 *  has no profile, and it is physically incapable of overwriting one that does.
 *  That property is what makes this endpoint safe to call from both machines at
 *  once — VERIFIED with two simultaneous first-sign-in claims against the same
 *  account: exactly one `seeded`, the other told `exists` and handed the
 *  winner's row.
 *
 *  `attempt` exists only for the one race that can legitimately be retried: the
 *  account's row being deleted between the claim and the fill. It is a counter
 *  rather than a `while (true)` because an unbounded retry against a database
 *  that is misbehaving is a hung request, not a recovery. */
async function claimOrFill(
  userId: string,
  local: Profile,
  warnings: FieldError[],
  attempt: number
): Promise<NextResponse> {
  const claim = await claimProfile(userId, local);

  if (claim.status === "invalid") return invalidResponse(claim.errors);
  if (claim.status === "too-large") return profileTooLarge(claim);

  if (claim.status === "seeded") {
    return NextResponse.json(
      { status: "seeded", hasProfile: true, ...serverSide(claim.row), warnings },
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
    const save = await saveProfile({ userId, payload: local, baseRev: server.rev });

    if (save.status === "saved") {
      return NextResponse.json({
        status: "upgraded",
        hasProfile: true,
        ...serverSide(save.row),
        warnings,
      });
    }
    if (save.status === "invalid") return invalidResponse(save.errors);
    if (save.status === "too-large") return profileTooLarge(save);
    if (save.status === "gone") {
      // The empty row was deleted between the claim and the fill, so there is
      // nothing left to conflict with — and a browser holding data against an
      // account holding none is the seed case this endpoint exists for.
      if (attempt === 0) return claimOrFill(userId, local, warnings, attempt + 1);
      return goneResponse();
    }
    // conflict or refused-empty: something real landed in between. Ask a human
    // rather than picking, with whatever is actually on the server now.
    return bothPopulated(local, save.row);
  }

  if (sameCharacter(local, server.profile)) {
    // Same data on both sides. Nothing to write, nothing to ask. The client
    // takes server.rev and is now a normal, synced device.
    return NextResponse.json({ status: "identical", hasProfile: true, ...serverSide(server) });
  }

  // Two different populated profiles. The one branch where the server refuses
  // to decide. Nothing was written; the browser's copy is untouched in
  // localStorage and the account's copy is untouched in Postgres.
  return bothPopulated(local, server);
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
     baseRev    the `rev` this edit was made on top of. REQUIRED — there is no
                "just overwrite" default, because a missing rev is exactly how
                last-write-wins data loss gets in. It is checked in BOTH
                directions:
                  null      "I believe this account has no profile yet."
                            Creates the row, and only if that is still true.
                  a number  "I believe this account is at rev N." Replaces rev
                            N, and only if N is still current. If the account
                            has NO profile — because it was deleted — this is
                            409 "gone" and nothing is created.
                That second half is not decoration. MEASURED on 2026-09-13,
                before it existed: the owner erased their planner data on the
                PC, a MacBook still holding rev 2 sent an ordinary save, and the
                deletion was silently reversed — the stale document came back as
                the account's data and neither device was told anything had
                happened. The erase had been behind a typed confirmation phrase;
                undoing it took no confirmation at all.
     allowEmpty optional. Permits storing an empty profile over a populated
                one. Only ever send this from a worded confirmation.
     force      optional. Skips the rev check. For a merge a human has already
                looked at and resolved. The revision it replaces is archived in
                profile_history either way.

   200 { status: "saved",         rev, updatedAt, summary, warnings }
   409 { status: "conflict",      server: {...} }   // somebody else wrote
   409 { status: "refused-empty", server: {...} }   // guard fired
   409 { status: "gone" }                           // baseRev names a deleted profile
   413 { status: "too-large",     scope, limitBytes, bytes }
   422 { status: "invalid",       errors }
   ========================================================================== */

export async function PUT(req: Request): Promise<NextResponse> {
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;
  const userId = caller.userId;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    if (parsed.reason === "too-large") return requestTooLarge(parsed.declared);
    return badBody("Expected a JSON object: { payload, baseRev }.");
  }
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

      case "gone":
        return goneResponse();

      case "too-large":
        return profileTooLarge(result);

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
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;
  const userId = caller.userId;

  const parsed = await readJsonBody(req);
  if (!parsed.ok && parsed.reason === "too-large") return requestTooLarge(parsed.declared);
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
