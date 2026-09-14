// Making one planner sheet follow the player between two machines.
//
// =============================================================================
// WHAT IS AT STAKE, AND THE ONE RULE
// =============================================================================
// The thing being synced is 25 hand-entered gear slots and a 31-row Legion
// roster that exist in exactly one place: one browser's localStorage. There is
// no backup. So this module has one rule, and every branch below obeys it:
//
//     NOTHING HERE OVERWRITES A POPULATED SHEET - on either side - UNLESS IT
//     CAN PROVE THE OTHER SIDE IS STRICTLY NEWER, OR A HUMAN SAID TO.
//
// "Prove" is doing real work in that sentence. See THE MARKER below.
//
// =============================================================================
// WHY GET-THEN-DECIDE, AND NOT POST /api/profile
// =============================================================================
// app/api/profile/route.ts ships a POST whose whole job is first sign-in: it
// seeds an empty account, fills an empty row, and 409s with both documents when
// both sides are populated and differ. It is safe by construction and this
// module could have been fifty lines of "POST and render the 409".
//
// It is not used, for one reason: POST cannot see the COMMON ANCESTOR, so it
// has to treat every "both populated and different" as a question for a human.
// That is right for the server, which knows nothing about this device. But this
// device knows something the server does not - what it last successfully
// synced - and for the two ordinary cases that knowledge is a proof:
//
//   * the account is still at the revision this device last saw, and the local
//     sheet has changed since -> the local edits are strictly newer. Push.
//   * the local sheet is byte-identical to what this device last synced, and
//     the account has moved on -> the other machine's edits are strictly
//     newer. Pull.
//
// Without the ancestor, BOTH of those look like "two populated profiles that
// differ", and every single sign-in on the second machine would put a
// choose-one dialog in front of the owner. The route's own comment, on the
// danger of that: it is "exactly how someone gets trained to click through it
// and lose a roster."
//
// So: GET (which writes nothing, ever), decide here against the marker, and
// then either PUT with a baseRev - the same compare-and-swap POST would have
// used - or pull, or ask. Every write still goes through PUT's rev check, so a
// wrong guess here cannot lose data: it loses the race and comes back as a 409
// that this module turns into the question it was trying to avoid asking.
//
// =============================================================================
// THE MARKER
// =============================================================================
// One localStorage key, `maple-planner:sync`, holding: the account id it
// belongs to, the account revision this device last agreed with, and the
// canonical text of BOTH sides at that moment.
//
// Two strings rather than one hash, and rather than one string:
//
//   * TWO, because the trip through /api/profile is lossy in known ways (see
//     WHAT THE WIRE CARRIES) - the sheet that comes back is not always byte
//     identical to the one sent. `local` is what this device sent; `server` is
//     what the account actually holds. A device is "unchanged since last sync"
//     if it still matches EITHER, otherwise lossy normalisation alone would
//     look like a local edit and push forever in a loop.
//
//   * STRINGS, not hashes, because a hash collision here is not a glitch: it
//     would read as "this device has not changed" and authorise pulling the
//     other machine's sheet over edits the player typed. A canonical character
//     is a handful of kilobytes. Exactness is worth the bytes.
//
// A missing or unreadable marker (first sign-in, cleared storage, private
// window, blocked localStorage) is NEVER treated as proof of anything. It
// degrades to asking, which is noisier and always safe.
//
// =============================================================================
// WHAT THE WIRE CARRIES - the honest list
// =============================================================================
// The account stores lib/portable.ts's Profile envelope, and everything written
// to it goes through parseProfile(). That is the app's own validator and it is
// the definition of what survives a round trip. It carries name, class, main
// stat, level, CP, the nine printed stats, all 25 item slots (including the
// cropped icons) and the Legion roster.
//
// It DROPS four things, established by reading parseCharacter() in
// lib/portable.ts rather than by assuming:
//
//   * `symbols`        - the six Arcane symbol LEVELS.
//   * `stats.damagePct`, `stats.finalDamagePct`, `stats.secondary`
//                      - the three hand-typed stat-window readings.
//
// parseCharacter() copies STAT_KEYS, which is the nine keys of `Stats`, and
// never looks at `symbols` or at the three DamageReadings fields. They are not
// rejected; they are simply not copied, so they do not come back.
//
// TWO CONSEQUENCES, BOTH HANDLED HERE RATHER THAN HIDDEN:
//
//   1. adoptRemote() carries those four fields over from the local sheet when
//      the account's copy has none. The account cannot express "the player
//      cleared their symbols" - the field cannot travel at all - so an absence
//      on the wire is not evidence, and deleting local data on the strength of
//      it would be inventing a fact. This is the one merge this module does
//      without asking, and it is only ever additive.
//
//   2. characterSignature() is computed over canonicalCharacter(), which spans
//      exactly the fields that DO travel. A symbols-only edit therefore does
//      not read as "this device has unsynced changes", because pushing it
//      would change nothing on the server and the state would never clear.
//
// The real fix is for those four fields to travel, and it is a change to
// lib/portable.ts, which this wave does not own. Until then the UI says so in
// words: they stay on the device that typed them.

import {
  canonicalCharacter,
  makeProfile,
  migrate,
  parseProfile,
  type FieldError,
  type Profile,
} from "@/lib/portable";
import { exampleCharacter, type Character } from "@/lib/rules";

/* ==========================================================================
   SECTION 1 - SHAPES THE UI RENDERS
   ========================================================================== */

/** Enough to describe a sheet to a human deciding which one to keep. Computed
 *  the same way for both sides - the server sends its own summary, and it is
 *  deliberately ignored in favour of this one, so the two numbers on screen are
 *  never produced by two different counters. */
export interface SheetSummary {
  name: string;
  cls: string;
  lvl: number;
  /** Equipped slots holding an item. */
  items: number;
  /** Legion roster rows. */
  roster: number;
  /** No gear and no roster - the state that must never land on top of data. */
  isEmpty: boolean;
}

export function summarize(ch: Character | null | undefined): SheetSummary {
  const items = ch?.items && typeof ch.items === "object" ? Object.keys(ch.items).length : 0;
  const roster = Array.isArray(ch?.roster) ? ch.roster.length : 0;
  return {
    name: typeof ch?.name === "string" ? ch.name : "",
    cls: typeof ch?.cls === "string" ? ch.cls : "",
    lvl: typeof ch?.lvl === "number" ? ch.lvl : 0,
    items,
    roster,
    isEmpty: items === 0 && roster === 0,
  };
}

export function isEmptySheet(ch: Character | null | undefined): boolean {
  return summarize(ch).isEmpty;
}

/** The canonical text of everything about a character that survives the wire.
 *
 *  canonicalCharacter() walks SLOTS in fixed order and rebuilds every object
 *  literal in a fixed key order, so this is stable across a Postgres jsonb
 *  round trip - jsonb does not preserve key order, and a naive
 *  JSON.stringify() of the stored side would differ from the sent side on key
 *  order alone and call every already-synced device a conflict. */
export function characterSignature(ch: Character): string {
  return JSON.stringify(canonicalCharacter(ch));
}

/* ==========================================================================
   SECTION 2 - THE ENVELOPE
   ========================================================================== */

/** Wrap the sheet for the wire. Icons are declared `inline` only when some item
 *  actually carries one, matching profileFromCharacter() in lib/db.ts; the
 *  policy field is descriptive, so claiming "inline" for a sheet with no icons
 *  would be a false statement inside the stored document. */
export function envelopeFor(ch: Character): Profile {
  const anyIcon = Object.values(ch.items ?? {}).some((it) => !!it?.icon);
  return makeProfile(ch, anyIcon ? "inline" : "omitted");
}

/** Read a document that came off the wire through the app's own validator.
 *
 *  The server already validated what it stored, so this is belt and braces -
 *  but it is the belt that stops a schema drift, a half-deployed build or a
 *  hand-edited row from being adopted onto this device as if it were a sheet.
 *  A document this build cannot read is an error the UI shows, never a silent
 *  empty character. */
export function readWireProfile(
  raw: unknown
): { ok: true; profile: Profile } | { ok: false; errors: FieldError[] } {
  const report = migrate(raw);
  if (report.unknownVersion) {
    return {
      ok: false,
      errors: [
        {
          path: "v",
          got: String(report.from),
          want: "a profile this build understands",
          fix: "nothing was changed on this device - update the app and try again",
        },
      ],
    };
  }
  const res = parseProfile(report.value);
  if (!res.ok) return { ok: false, errors: res.errors };
  return { ok: true, profile: res.profile };
}

/* ==========================================================================
   SECTION 3 - THE MARKER
   ========================================================================== */

export const SYNC_MARKER_KEY = "maple-planner:sync";

export interface SyncMarker {
  /** Which account this is about. A marker for another user is ignored, never
   *  trusted, and never used to authorise a write. */
  userId: string;
  /** The account revision this device last agreed with. null means "this
   *  device last observed that the account held no profile at all". */
  rev: number | null;
  /** characterSignature() of what this device sent (or held) at that moment. */
  local: string;
  /** characterSignature() of what the account held at that moment. Differs
   *  from `local` exactly when the round trip was lossy. "" when `rev` is null. */
  server: string;
  /** Informational only. Never used to decide anything - a client clock is not
   *  evidence, and two machines disagreeing about "now" is the normal case. */
  at: string;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Blocked storage (private mode, a hardened profile). Sync still works; it
    // just has to ask more often, because it has no ancestor to reason from.
    return null;
  }
}

export function readMarker(userId: string): SyncMarker | null {
  const s = storage();
  if (!s) return null;
  let raw: string | null;
  try {
    raw = s.getItem(SYNC_MARKER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.userId !== "string" || m.userId !== userId) return null;
  if (typeof m.local !== "string" || typeof m.server !== "string") return null;
  const rev = m.rev;
  if (rev !== null && (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1)) return null;
  return {
    userId,
    rev: rev as number | null,
    local: m.local,
    server: m.server,
    at: typeof m.at === "string" ? m.at : "",
  };
}

export function writeMarker(m: SyncMarker): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(SYNC_MARKER_KEY, JSON.stringify(m));
  } catch {
    // Quota, or blocked. Losing the marker costs a question on the next
    // sign-in. It never costs data, so it is not worth failing a save over.
  }
}

export function forgetMarker(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(SYNC_MARKER_KEY);
  } catch {
    /* ignore */
  }
}

/* ==========================================================================
   SECTION 4 - THE NETWORK

   Every function here returns a discriminated result and NEVER throws. A
   thrown error in a sync path is how "the request failed" becomes "the account
   is empty", which is the one mistake this whole wave is built to avoid.
   ========================================================================== */

type JsonBody = Record<string, unknown>;

interface RawResponse {
  status: number;
  body: JsonBody;
}

async function request(
  path: string,
  init?: RequestInit
): Promise<{ ok: true; res: RawResponse } | { ok: false; detail: string }> {
  let r: Response;
  try {
    r = await fetch(path, { ...init, cache: "no-store" });
  } catch {
    // Offline, DNS, a dev server that just restarted, a tunnel that dropped.
    return { ok: false, detail: "Could not reach the server." };
  }
  let body: JsonBody = {};
  try {
    const parsed: unknown = await r.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as JsonBody;
  } catch {
    // A non-JSON body from an app route means a proxy, an error page or a
    // rewrite got in the way. Report the status rather than inventing a shape.
    return { ok: false, detail: "The server answered " + r.status + " with something that was not JSON." };
  }
  return { ok: true, res: { status: r.status, body } };
}

function messageOf(body: JsonBody, fallback: string): string {
  return typeof body.message === "string" && body.message.trim() ? body.message : fallback;
}

function fieldErrorsOf(body: JsonBody, key: string): FieldError[] {
  const v = body[key];
  return Array.isArray(v) ? (v as FieldError[]) : [];
}

/** What the account holds right now. */
export type RemoteRead =
  | { kind: "none" }
  | { kind: "profile"; rev: number; updatedAt: string; profile: Profile }
  | { kind: "signed-out" }
  /** The database could not be reached, or answered with something unreadable.
   *  DISTINCT FROM "none" on purpose: "none" authorises seeding the account
   *  from this browser, and an outage must never authorise anything. */
  | { kind: "unavailable"; detail: string }
  | { kind: "unreadable"; errors: FieldError[] };

export async function readRemote(): Promise<RemoteRead> {
  const r = await request("/api/profile", { method: "GET" });
  if (!r.ok) return { kind: "unavailable", detail: r.detail };
  const { status, body } = r.res;

  if (status === 401) return { kind: "signed-out" };
  if (status >= 500 || body.status === "unavailable" || body.status === "misconfigured") {
    return {
      kind: "unavailable",
      detail: messageOf(body, "The planner database could not be reached. Nothing was read or written."),
    };
  }
  if (body.status === "empty" || body.hasProfile === false) return { kind: "none" };
  if (body.status !== "ok") {
    return { kind: "unavailable", detail: messageOf(body, "Unexpected answer from /api/profile (" + status + ").") };
  }

  const rev = body.rev;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) {
    return { kind: "unavailable", detail: "The account answered without a usable revision number." };
  }
  const doc = readWireProfile(body.profile);
  if (!doc.ok) return { kind: "unreadable", errors: doc.errors };
  return {
    kind: "profile",
    rev,
    updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : "",
    profile: doc.profile,
  };
}

/** The outcome of a save. `conflict` and `refused-empty` both mean NOTHING WAS
 *  WRITTEN, and both carry the account's current state so the UI can ask. */
export type PushResult =
  | { kind: "saved"; rev: number; updatedAt: string; stored: Profile; warnings: FieldError[] }
  | { kind: "conflict"; rev: number; updatedAt: string; server: Profile }
  | { kind: "refused-empty"; rev: number; updatedAt: string; server: Profile }
  | { kind: "invalid"; errors: FieldError[] }
  /** The account said no, permanently, for a reason it named — too large, the
   *  row is gone, a malformed request. DISTINCT from `unavailable`, which is
   *  transient and worth a retry: retrying a refusal just refuses again, so the
   *  UI has to show the reason rather than a "Retry" button. */
  | { kind: "refused"; detail: string }
  | { kind: "signed-out" }
  | { kind: "unavailable"; detail: string };

export interface PushOptions {
  /** The revision this edit was made on top of. null asserts "the account has
   *  no profile yet" and fails if that is no longer true. Never omitted -
   *  /api/profile rejects a PUT without it, which is the guard that makes
   *  last-write-wins unrepresentable. */
  baseRev: number | null;
  /** Store an empty sheet over a populated account. Only ever from a second,
   *  worded click. */
  allowEmpty?: boolean;
}

export async function pushLocal(ch: Character, opts: PushOptions): Promise<PushResult> {
  const r = await request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      payload: envelopeFor(ch),
      baseRev: opts.baseRev,
      ...(opts.allowEmpty ? { allowEmpty: true } : {}),
    }),
  });
  if (!r.ok) return { kind: "unavailable", detail: r.detail };
  const { status, body } = r.res;

  if (status === 401) return { kind: "signed-out" };
  if (status >= 500 || body.status === "unavailable" || body.status === "misconfigured") {
    return {
      kind: "unavailable",
      detail: messageOf(body, "The planner database could not be reached. Nothing was saved."),
    };
  }
  if (body.status === "invalid") return { kind: "invalid", errors: fieldErrorsOf(body, "errors") };

  if (body.status === "conflict" || body.status === "refused-empty") {
    const side = serverSideOf(body.server);
    if (!side.ok) return { kind: "unavailable", detail: side.detail };
    return {
      kind: body.status === "conflict" ? "conflict" : "refused-empty",
      rev: side.rev,
      updatedAt: side.updatedAt,
      server: side.profile,
    };
  }

  if (body.status === "saved") {
    const rev = body.rev;
    if (typeof rev !== "number" || !Number.isInteger(rev)) {
      return { kind: "unavailable", detail: "The account saved but answered without a revision number." };
    }
    const doc = readWireProfile(body.profile);
    if (!doc.ok) return { kind: "invalid", errors: doc.errors };
    return {
      kind: "saved",
      rev,
      updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : "",
      stored: doc.profile,
      warnings: fieldErrorsOf(body, "warnings"),
    };
  }

  // Any other 4xx is the account refusing on its own terms. It names its own
  // reason — a payload over the size ceiling, a row deleted from another
  // device, a body this build got wrong — and that reason is shown verbatim
  // rather than flattened into "could not save", because the fix differs for
  // each and none of them is "try again".
  if (status >= 400 && status < 500) {
    return {
      kind: "refused",
      detail: messageOf(body, "The account refused the save (" + status + "). Nothing was saved."),
    };
  }

  return {
    kind: "unavailable",
    detail: messageOf(body, "Unexpected answer from /api/profile (" + status + "). Nothing was saved."),
  };
}

function serverSideOf(
  raw: unknown
): { ok: true; rev: number; updatedAt: string; profile: Profile } | { ok: false; detail: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "The account reported a conflict without saying what it holds." };
  }
  const s = raw as JsonBody;
  const rev = s.rev;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) {
    return { ok: false, detail: "The account reported a conflict without a usable revision number." };
  }
  const doc = readWireProfile(s.profile);
  if (!doc.ok) {
    return { ok: false, detail: "The account holds a profile this build cannot read. Nothing was changed." };
  }
  return { ok: true, rev, updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "", profile: doc.profile };
}

/* ==========================================================================
   SECTION 5 - THE DECISION

   Pure. No fetch, no storage, no React. Given what is on this device, what the
   account answered, and what this device last agreed with, say what to do -
   and say WHY, in a sentence the UI shows the owner.
   ========================================================================== */

export type SyncPlan =
  /** Both sides already agree. Nothing to do but remember the revision. */
  | { kind: "in-sync"; rev: number | null; note: string }
  /** Send the local sheet. baseRev is the compare-and-swap token. */
  | { kind: "push"; baseRev: number | null; why: string }
  /** Take the account's sheet. Reached only where local has nothing to lose,
   *  or is provably unchanged since the last sync. */
  | { kind: "pull"; rev: number; profile: Profile; why: string }
  /** Two populated sheets, both changed, no ancestor to break the tie. ASK. */
  | { kind: "ask"; rev: number; updatedAt: string; server: Profile }
  /** This browser's sheet is still the DEMO, and the account has nothing yet.
   *  A push here would seed a real account with a sample character, so it is
   *  offered as a click rather than taken as a decision. See `localIsDemo`. */
  | { kind: "offer-seed"; baseRev: number | null; why: string }
  /** Nothing anywhere. A new account on a new browser. */
  | { kind: "idle"; note: string };

export interface PlanInput {
  /** The sheet this device actually has PERSISTED, or null if this browser has
   *  never saved one. null is not the same as an empty sheet: a first-time
   *  visitor is looking at the demo character, which is not their data and must
   *  never be pushed to their account. The caller owns that distinction - see
   *  components/Planner.tsx. */
  local: Character | null;
  /**
   * Is the sheet on screen still the DEMO character rather than something this
   * player made?
   *
   * This exists because "has this browser saved anything?" turned out not to
   * answer that question. Planner's item backfill resolves the demo's gear
   * against /api/items on first load and commits the result, so a browser that
   * has never been touched by a human holds a saved account within a second of
   * opening the page. Observed, not theorised: a cleared profile reloaded with
   * `maple-planner:account` holding `demo-archerroni`, 24 items, before any
   * click.
   *
   * Without this flag, a brand new visitor's first sign-up would seed their
   * empty account with a sample character - and every later device would
   * faithfully sync the sample. So a demo sheet is never pushed on its own; it
   * is OFFERED. Once the account holds anything, this flag stops mattering and
   * the ordinary rules take over, because by then there is a real sheet to
   * compare against.
   */
  /**
   * @deprecated IGNORED, and kept only so an old call site still typechecks
   * while it is being removed. planFor() now proves the demo from content -
   * see DEMO_SIGNATURE. A caller cannot be trusted with this question: the one
   * that tried answered "does the character still carry the starter id, and has
   * nobody typed since this page loaded", which is true of most real sheets on
   * most page loads, and it cost a player their sheet.
   */
  localIsDemo?: boolean;
  remote: RemoteRead;
  marker: SyncMarker | null;
}

/** null means "no safe action exists for this input" - the three remote states
 *  that are not an answer about the data (signed out, unreachable, unreadable).
 *  Returning null rather than inventing an action is the point. */
/**
 * Is this sheet the one the app ships, IGNORING the item backfill?
 *
 * characterSignature() alone cannot answer this, and the reason is a trap worth
 * naming. canonicalItem() drops `icon` and KEEPS `itemId`, `sub` and
 * `bossDrop` - and those three are exactly what the startup backfill writes
 * when it resolves the demo's gear against /api/items. So within a second of a
 * brand-new visitor opening the page, the demo's signature has moved away from
 * exampleCharacter()'s, through no act of the player's.
 *
 * Comparing raw signatures would therefore call a fresh visitor's demo "not the
 * demo" and offer to push it into their empty account - the precise thing
 * `offer-seed` exists to prevent. Comparing shape, with the backfill's three
 * fields removed, matches both the pristine demo and the backfilled one and
 * matches nothing a player has touched: a rename, a level, a stat, a star, a
 * potential or flame line, an item added or removed all move it.
 *
 * Icons are already gone by canonicalItem(), so they need no handling here.
 */
function demoShapeSignature(ch: Character): string {
  const canon = canonicalCharacter(ch);
  const items: Record<string, unknown> = {};
  for (const [slotId, it] of Object.entries(canon.items)) {
    // Rest-spread, so the default for any field added to Item in future is to
    // PARTICIPATE in the comparison. That is the safe direction: a new field a
    // player can edit must be able to break the demo match, or this check
    // silently starts calling edited sheets 'the demo' again. Only the three
    // the backfill writes are excluded, and they are named here.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { itemId, sub, bossDrop, ...rest } = it;
    items[slotId] = rest;
  }
  return JSON.stringify({ ...canon, items });
}

/** The shape of the sheet this app ships. Computed once; exampleCharacter() is
 *  deterministic. */
const DEMO_SHAPE: string = demoShapeSignature(exampleCharacter());

/** True only for a sheet nobody has edited - pristine or merely backfilled. */
function isUntouchedDemo(ch: Character): boolean {
  return demoShapeSignature(ch) === DEMO_SHAPE;
}

export function planFor({ local, remote, marker }: PlanInput): SyncPlan | null {
  if (remote.kind === "signed-out" || remote.kind === "unavailable" || remote.kind === "unreadable") return null;

  const localEmpty = isEmptySheet(local);
  /** A populated sheet that nobody has claimed as their own yet. Safe to show,
   *  never safe to seed an account with on its own initiative. */
  // PROVE IT, DO NOT BE TOLD IT.
  //
  // This used to read `localIsDemo === true && ...`, trusting a boolean the
  // caller computed as `ch.id === EXAMPLE_CHARACTER_ID && !touched`. Neither
  // half survives contact with a real player:
  //
  //   - withActiveCharacter() preserves a character's id forever and nothing
  //     ever re-ids the starter sheet, so a player who types over the sheet
  //     they landed on - rather than clicking "+ New" - keeps the starter id
  //     for the life of the account.
  //   - `touched` was component state seeded false, so it is false again on
  //     every page load.
  //
  // Together that classified weeks of real work as "the demo" and PULLED over
  // it, silently, with no copy kept. It was reproduced twice against a real
  // account: a Lv 250 sheet with a hand-built roster was replaced on first
  // sign-in, and a single keystroke before signing in was the entire
  // difference between that and the conflict dialog.
  //
  // The demo is a CONTENT question and it has an exact answer, so ask it that
  // way. characterSignature() is canonical and exampleCharacter() is
  // deterministic, so a sheet is the demo when it is byte-identical to the one
  // the app ships - immune to page reloads, to how long the browser has been
  // open, and to which id the character happens to carry.
  const provisional = !!local && !localEmpty && isUntouchedDemo(local);

  if (remote.kind === "none") {
    if (!local || localEmpty) {
      return { kind: "idle", note: "Nothing on this device and nothing on the account yet." };
    }
    if (provisional) {
      return {
        kind: "offer-seed",
        baseRev: null,
        why: "This browser is still showing the demo sheet, so nothing was sent to your empty account.",
      };
    }
    return { kind: "push", baseRev: null, why: "This account has no sheet yet, so this device's sheet becomes it." };
  }

  const server = remote.profile.char;
  const serverSig = characterSignature(server);
  const localSig = local ? characterSignature(local) : "";

  if (local && localSig === serverSig) {
    return { kind: "in-sync", rev: remote.rev, note: "This device and the account already hold the same sheet." };
  }

  // The account's row exists but holds nothing. Filling it cannot lose
  // anything, and the rev check still runs, so a real sheet that landed in the
  // last millisecond turns into a conflict rather than a loss.
  // What the ancestor, if there is one, proves about each side.
  const ancestorRev = marker && marker.rev !== null ? marker.rev : null;
  const haveAncestor = ancestorRev !== null;

  if (isEmptySheet(server) && local && !localEmpty) {
    // Same reasoning as the empty-account case above: an empty row is a fresh
    // account, and a fresh account must not be filled with the demo unasked.
    // Once an ancestor exists this sheet has been claimed and the gate lifts.
    if (provisional && !haveAncestor) {
      return {
        kind: "offer-seed",
        baseRev: remote.rev,
        why: "This browser is still showing the demo sheet, so nothing was sent to your empty account.",
      };
    }
    return { kind: "push", baseRev: remote.rev, why: "The account's sheet is empty, so this device's sheet fills it." };
  }
  const localUnchanged =
    marker !== null && haveAncestor && (localSig === marker.local || localSig === marker.server);
  const serverUnchanged = ancestorRev === remote.rev;

  if (!local || localEmpty) {
    // An empty sheet is normally a device with nothing to lose - the second
    // machine, and the whole point of the feature. But it is ALSO what "Clear
    // gear" leaves behind, and pulling in that case would quietly undo a
    // deliberate wipe. The ancestor tells those apart: if this device emptied a
    // sheet it had already synced, and the account has not moved since, the
    // emptying is the newer edit. Push it - /api/profile refuses an empty sheet
    // over a populated one, which routes it to a worded confirmation instead of
    // doing it silently.
    if (local && haveAncestor && !localUnchanged && serverUnchanged) {
      return {
        kind: "push",
        baseRev: remote.rev,
        why: "This device's sheet was emptied after it last synced, and the account has not changed since.",
      };
    }
    return {
      kind: "pull",
      rev: remote.rev,
      profile: remote.profile,
      why: "This device had no sheet, so the account's sheet opens here.",
    };
  }

  // The demo is not data. A second machine opening the app for the first time
  // is showing sample gear, and the account holds the real thing, so this is
  // the same case as the empty device above and must not become a choose-one
  // question - it has to be the same answer whether or not the item backfill
  // happened to finish before this handshake did. Guarded on there being no
  // ancestor: once this browser has synced a sheet, the demo id means nothing
  // and the ordinary rules below are the correct ones.
  if (provisional && !haveAncestor) {
    return {
      kind: "pull",
      rev: remote.rev,
      profile: remote.profile,
      why: "This browser was still showing the demo sheet, so the account's sheet opens here.",
    };
  }

  // Both populated and different. The only thing that can break the tie without
  // asking is the common ancestor.
  if (haveAncestor) {
    if (localUnchanged && serverUnchanged) {
      // Neither side moved, and yet they differ: the round trip is lossy in one
      // of the known ways, or the marker predates a change to the canonical
      // form. Either way there is nothing to send that would change the
      // account, so treat it as settled rather than pushing in a loop.
      return { kind: "in-sync", rev: remote.rev, note: "Already in sync with the account." };
    }
    if (serverUnchanged && !localUnchanged) {
      return {
        kind: "push",
        baseRev: remote.rev,
        why: "The account has not changed since this device last synced, so this device's edits are the newer ones.",
      };
    }
    if (localUnchanged && !serverUnchanged) {
      return {
        kind: "pull",
        rev: remote.rev,
        profile: remote.profile,
        why: "This device has no unsynced edits and the account has moved on, so the other machine's sheet opens here.",
      };
    }
  }

  return { kind: "ask", rev: remote.rev, updatedAt: remote.updatedAt, server: remote.profile };
}

/* ==========================================================================
   SECTION 6 - TAKING THE ACCOUNT'S SHEET

   The one merge this module performs without asking, and it only ever ADDS.
   ========================================================================== */

/** Carry the four fields the wire cannot carry across from the sheet already on
 *  this device - see WHAT THE WIRE CARRIES at the top of this file.
 *
 *  This is not a guess about which side is newer. The account is PHYSICALLY
 *  INCAPABLE of holding these fields, so its lack of them says nothing at all,
 *  and blanking six Arcane symbol levels and three hand-typed stat-window
 *  readings on the strength of a silence would be inventing a fact. A field
 *  present on the incoming sheet always wins - that can only happen if a future
 *  build starts carrying it, and then it should. */
export function adoptRemote(local: Character | null, incoming: Character): Character {
  const merged: Character = { ...incoming };
  if (!local) return merged;

  if (merged.symbols === undefined && local.symbols !== undefined) {
    merged.symbols = local.symbols;
  }

  // The three stat-window READINGS. `stats` on the incoming sheet is a fresh
  // object from parseCharacter(), so writing into a copy of it touches nothing
  // the caller still holds.
  const stats = { ...merged.stats };
  let statsChanged = false;
  for (const k of ["damagePct", "finalDamagePct", "secondary"] as const) {
    const mine = local.stats?.[k];
    if (stats[k] === undefined && mine !== undefined) {
      stats[k] = mine;
      statsChanged = true;
    }
  }
  if (statsChanged) merged.stats = stats;

  return merged;
}

/** Which of the untransportable fields adoptRemote() had to rescue. The UI
 *  names them, because a merge the owner cannot see is a merge they cannot
 *  check. */
export function rescuedFields(local: Character | null, incoming: Character): string[] {
  if (!local) return [];
  const out: string[] = [];
  if (incoming.symbols === undefined && local.symbols !== undefined) out.push("symbol levels");
  if (incoming.stats?.damagePct === undefined && local.stats?.damagePct !== undefined) out.push("DAMAGE %");
  if (incoming.stats?.finalDamagePct === undefined && local.stats?.finalDamagePct !== undefined) {
    out.push("FINAL DAMAGE %");
  }
  if (incoming.stats?.secondary === undefined && local.stats?.secondary !== undefined) out.push("secondary stat");
  return out;
}
