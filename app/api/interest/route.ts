import { NextResponse } from "next/server";
import {
  ALLOWED_IMPORT_HOSTS,
  DAY_MS,
  DEMO_IMPORTS,
  INTEREST_FORM_PATH,
  isSameSiteRequest,
  secondsUntil,
  subjectKey,
} from "@/lib/entitlement";
import { getEntitlementStore } from "@/lib/entitlementStore";
import { DatabaseNotConfiguredError, getSql, type Sql } from "@/lib/db";

/**
 * POST /api/interest — what happens after the demo runs out.
 *
 * THE SHAPE OF THIS ENDPOINT IS A LEGAL CONSTRAINT, NOT A PREFERENCE.
 * Vercel's Hobby plan forbids commercial use and defines it to include "any
 * method of requesting or processing payment from visitors of the site". An
 * expression of interest is not payment, so this shape keeps the deployment on
 * Hobby and defers Vercel Pro at $20/seat/month indefinitely.
 *
 *   ALLOWED HERE:     asking whether someone would use a paid plan, and what
 *                     they would want in it. "Would you pay for this?" is a
 *                     survey question and this endpoint's `note` is where that
 *                     answer goes.
 *   NOT ALLOWED HERE: card fields, a checkout of any kind, a pre-order, a
 *                     waitlist that takes a deposit, or naming a price as
 *                     something being purchased. "Reserve your spot for $10"
 *                     crosses the line and costs $20/month the moment it ships.
 *
 * That rule is enforced in code below rather than left to whoever writes the
 * next version of the form: the body is a STRICT two-field allowlist, so a
 * client that posts `amount`, `card`, `token` or `price` gets a 400 naming the
 * problem instead of quietly having it stored. PRICE_USD_PER_PERIOD is never
 * read in this file, and nothing here returns a figure to render.
 *
 * WHAT IT COLLECTS, AND WHAT IT DELIBERATELY DOES NOT.
 *   contact   required. The only way to come back to someone.
 *   note      optional free text. The actual signal — "I'd pay", "only if it
 *             also did X", "I just wanted the one character".
 * Not the IP, not the user agent, not the demo count, not a fingerprint. The
 * subject key is computed for rate limiting and is used only in memory; it is
 * never written to the row. A signup table that quietly accumulates addresses
 * beside email addresses is a liability built out of convenience.
 *
 * DURABILITY IS REPORTED, NEVER ASSUMED. An interest signup that vanishes is
 * worse than a form that admits it is not ready: the visitor thinks they have
 * been heard, and the one number this whole gate exists to produce — how many
 * people asked — silently reads zero. So a write that cannot be made durable
 * answers 503 with `stored: false` and says why. It is not dropped on the floor
 * and it is not reported as success.
 */

// Per-visitor, and it writes. Never cached, never statically evaluated.
export const dynamic = "force-dynamic";

/* ========================================================================== *
 * 1. THE BODY — A STRICT ALLOWLIST
 * ========================================================================== */

/** The only two fields this endpoint accepts. Anything else is a 400 — see the
 *  header for why that strictness is the point rather than fussiness. */
const ALLOWED_FIELDS = ["contact", "note"] as const;

const MAX_CONTACT = 200;
const MAX_NOTE = 1000;

/** Deliberately permissive — an address either round-trips or it does not, and
 *  a clever regex mostly rejects real addresses. This only catches "asdf". */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * A 13-to-19 digit run, which is what a card number looks like however it is
 * spaced. If one arrives — pasted into the wrong box by a visitor who assumed
 * this was a checkout — the request is refused and NOTHING is stored, not even
 * the rest of the submission. Storing it "just this once" would make this
 * deployment a place that holds card data, which is the one outcome the whole
 * design is arranged to avoid.
 */
const CARD_LIKE_RE = /(?:\d[ -]?){13,19}/;

interface InterestBody {
  contact?: unknown;
  note?: unknown;
}

type Parsed =
  | { ok: true; contact: string; note: string | null }
  | { ok: false; status: number; error: string };

function parseBody(raw: unknown): Parsed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "Expected a JSON object." };
  }
  const extra = Object.keys(raw as object).filter(
    (k) => !(ALLOWED_FIELDS as readonly string[]).includes(k)
  );
  if (extra.length) {
    return {
      ok: false,
      status: 400,
      error:
        `This form takes only ${ALLOWED_FIELDS.join(" and ")}. It is an expression of interest, ` +
        `not a checkout — it cannot accept payment details of any kind. Unexpected: ${extra.join(", ")}.`,
    };
  }

  const body = raw as InterestBody;
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (!contact) return { ok: false, status: 400, error: "An email address is needed to come back to you." };
  if (contact.length > MAX_CONTACT) {
    return { ok: false, status: 400, error: `That address is longer than ${MAX_CONTACT} characters.` };
  }
  if (!EMAIL_RE.test(contact)) {
    return { ok: false, status: 400, error: "That doesn't look like an email address." };
  }
  if (note.length > MAX_NOTE) {
    return { ok: false, status: 400, error: `Please keep it under ${MAX_NOTE} characters.` };
  }
  if (CARD_LIKE_RE.test(contact) || CARD_LIKE_RE.test(note)) {
    return {
      ok: false,
      status: 400,
      error:
        "That looks like a card number, so nothing was saved. Nothing here is for sale and there is " +
        "nothing to pay for — this form only asks whether you would use a paid plan if one existed.",
    };
  }

  return { ok: true, contact, note: note || null };
}

/* ========================================================================== *
 * 2. RATE LIMIT — IT WRITES, SO IT IS ABUSABLE
 * ========================================================================== */

/**
 * Three a day per visitor is generous for a form nobody fills in twice, and
 * cheap for a form a script would fill in ten thousand times. The per-process
 * ceiling underneath it is the botnet case: a thousand different IPs each
 * submitting three is still three thousand rows, so the instance stops
 * accepting long before the table becomes the problem.
 */
const SIGNUPS_PER_SUBJECT_PER_DAY = 3;
const SIGNUPS_PER_PROCESS_PER_DAY = 500;
/** Above this many tracked subjects, drop the expired ones. A Map that only
 *  grows is a memory leak with a 24-hour fuse. */
const PRUNE_AT = 5_000;

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();
let processWindowStart = 0;
let processCount = 0;

/**
 * CHECK and CONSUME are separate on purpose, and this is the bug that split
 * them: counting every REQUEST means someone who mistypes their address twice
 * has two attempts left, and the third correction — the one that would have
 * worked — is what meets the limit. A person fixing a typo is the opposite of
 * the thing being rate limited.
 *
 * So the check runs early (a refusal costs nothing), and the token is spent
 * only once a submission is actually filed. What the limit therefore bounds is
 * ROWS PER VISITOR PER DAY, which is the resource worth protecting; a flood of
 * malformed bodies is turned away by the JSON parse without ever reaching the
 * database.
 *
 * VOLATILE, exactly like the entitlement ledger and for exactly the same
 * reason: one serverless instance's Map. A cold start resets it. That is
 * acceptable HERE in a way it is not for the demo gate — the failure mode is
 * "a determined abuser files more than three", not "OpenRouter bills us" — but
 * it is stated rather than implied.
 */
function rateCheck(key: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
  if (now - processWindowStart >= DAY_MS) {
    processWindowStart = now;
    processCount = 0;
  }
  if (processCount >= SIGNUPS_PER_PROCESS_PER_DAY) {
    return { ok: false, retryAfterSec: secondsUntil(now, processWindowStart + DAY_MS) };
  }
  const b = buckets.get(key);
  if (b && now - b.windowStart < DAY_MS && b.count >= SIGNUPS_PER_SUBJECT_PER_DAY) {
    return { ok: false, retryAfterSec: secondsUntil(now, b.windowStart + DAY_MS) };
  }
  return { ok: true };
}

/** Called only after a signup is really filed. */
function rateConsume(key: string, now: number): void {
  if (buckets.size > PRUNE_AT) {
    // A Map that only grows is a memory leak with a 24-hour fuse.
    for (const [k, b] of buckets) if (now - b.windowStart >= DAY_MS) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= DAY_MS) buckets.set(key, { windowStart: now, count: 1 });
  else b.count++;
  processCount++;
}

/* ========================================================================== *
 * 3. PERSISTENCE — AND AN HONEST ACCOUNT OF IT
 * ========================================================================== */

// Not exported: Next type-checks the export surface of a route module, and an
// extra named export fails the build rather than being ignored.
const INTEREST_TABLE = "interest_signup";

/**
 * Two statements, both idempotent, run at most once per process on the first
 * write rather than on every request.
 *
 * WHY THE DDL IS HERE AND NOT IN db/migrations. This endpoint has to work on a
 * deployment where nobody has run a migration, and the alternative to creating
 * its own table is refusing every signup until someone does — which is the
 * "dropped on the floor" failure with extra steps. `if not exists` makes it
 * safe to fold the same DDL into the migration ladder later; when that happens,
 * delete this function and the call to it, and nothing else changes.
 *
 * The unique index is on lower(contact) so a second submission from the same
 * person updates nothing and inserts nothing. Demand is a count of people, and
 * a refresh-happy visitor must not read as five of them.
 */
const CREATE_TABLE = `
  create table if not exists "${INTEREST_TABLE}" (
    "id" bigint generated always as identity primary key,
    "contact" text not null,
    "note" text,
    "createdAt" timestamptz not null default now()
  )`;
const CREATE_INDEX = `
  create unique index if not exists "${INTEREST_TABLE}_contact_idx"
    on "${INTEREST_TABLE}" (lower("contact"))`;

let ensuring: Promise<void> | null = null;

function ensureTable(sql: Sql): Promise<void> {
  if (!ensuring) {
    ensuring = (async () => {
      await sql.query(CREATE_TABLE);
      await sql.query(CREATE_INDEX);
    })();
    // A failed attempt must not poison the process: clear the memo so the next
    // request tries again. The current awaiters still see the rejection.
    ensuring.catch(() => {
      ensuring = null;
    });
  }
  return ensuring;
}

/** What the response says about where the signup went. Same spirit as
 *  LedgerHealth on the import routes: the deployment reports its own
 *  shortcomings in the JSON instead of in a comment nobody opens. */
interface StorageReport {
  backend: string;
  durable: boolean;
  /** True when the row is really there. */
  stored: boolean;
  /** True when this address had already been recorded. */
  duplicate: boolean;
  /** Null when there is nothing wrong. */
  warning: string | null;
}

async function fileSignup(contact: string, note: string | null): Promise<StorageReport> {
  try {
    const sql = getSql();
    await ensureTable(sql);
    const rows = (await sql.query(
      // Untargeted `on conflict` on purpose: the table has exactly one unique
      // index and naming an expression index as a conflict target is the kind
      // of syntax that differs between engines. No rows returned means the
      // address was already there.
      `insert into "${INTEREST_TABLE}" ("contact", "note") values ($1, $2)
       on conflict do nothing
       returning "id"`,
      [contact, note]
    )) as Array<{ id: string }>;
    return {
      backend: "neon-postgres",
      durable: true,
      stored: true,
      duplicate: rows.length === 0,
      warning: null,
    };
  } catch (err) {
    const unconfigured = err instanceof DatabaseNotConfiguredError;
    // The signup is NOT silently lost: it goes to the log at error level, with
    // the contact, so it is recoverable by hand from the platform's log drain
    // while this is broken. Log retention is short and this is a stopgap, not a
    // store — which is why the caller answers 503 rather than pretending.
    console.error(
      `[interest] COULD NOT STORE AN EXPRESSION OF INTEREST — recovering it from this log line is ` +
        `the only option: contact=${JSON.stringify(contact)} note=${JSON.stringify(note)}`,
      err
    );
    return {
      backend: unconfigured ? "none" : "neon-postgres",
      durable: false,
      stored: false,
      duplicate: false,
      warning: unconfigured
        ? "No DATABASE_URL is set on this deployment, so there is nowhere durable to put an " +
          "expression of interest. Set it to the Neon POOLED connection string in the project " +
          "environment and this endpoint starts working with no code change."
        : "The database rejected the write. The signup is in the server log only.",
    };
  }
}

/* ========================================================================== *
 * 4. THE ROUTE
 * ========================================================================== */

export async function POST(req: Request) {
  const now = Date.now();

  // Cheap, bypassable by anyone who sets a header deliberately, and still worth
  // having on a write endpoint: it stops every casual curl and every scraper
  // that finds the path, which is the entire population that would ever abuse
  // it. Browsers always send Origin on a cross-method POST, so an honest
  // submission from the form always passes.
  if (!isSameSiteRequest(req.headers.get("origin"), req.headers.get("referer"), ALLOWED_IMPORT_HOSTS)) {
    return NextResponse.json(
      { ok: false, error: `This form is submitted from ${INTEREST_FORM_PATH}.` },
      { status: 403 }
    );
  }

  // Identity comes from the entitlement store's own subjectFor — the same seam,
  // and the same rule: never from a header the caller can set. A subject key a
  // visitor chooses is a button labelled "submit again".
  const store = getEntitlementStore();
  let key: string;
  try {
    key = subjectKey(store.subjectFor(req));
  } catch {
    key = "unknown";
  }

  const limited = rateCheck(key, now);
  if (!limited.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `You've already sent that a few times today — it's recorded, once is enough.`,
        retryAfterSec: limited.retryAfterSec,
      },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request body." }, { status: 400 });
  }

  const parsed = parseBody(raw);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: parsed.status });
  }

  const storage = await fileSignup(parsed.contact, parsed.note);

  if (!storage.stored) {
    // 503, not 200. The visitor gets told the truth — and so does the operator,
    // because a form that reports its own failure is a bug report instead of a
    // demand signal that quietly reads zero.
    return NextResponse.json(
      {
        ok: false,
        stored: false,
        storage,
        error:
          "That didn't save — this deployment has nowhere durable to keep it yet, so rather than " +
          "tell you it worked, here's the truth. Nothing was charged and there is nothing to pay; " +
          "please try again later.",
      },
      { status: 503, headers: { "Retry-After": "3600" } }
    );
  }

  // Filed, so now it costs an allowance. A 503 above does not — someone whose
  // signup we failed to store must be able to try again.
  rateConsume(key, now);

  return NextResponse.json({
    ok: true,
    stored: true,
    storage,
    // Wording is constrained, not stylistic: it may not name a price, sell a
    // place in a queue, or promise access in exchange for anything. See the
    // header, and INTEREST_FORM_PATH in lib/entitlement.ts.
    message: storage.duplicate
      ? "You're already on the list — thanks, once is enough."
      : `Thanks — that's recorded. There's nothing to buy and nothing was charged. ` +
        `The demo is ${DEMO_IMPORTS} imports; if enough people say they'd use a paid plan, we'll open one.`,
  });
}

/* ==========================================================================
   OWNER PREREQUISITES — what makes any of this real
   ==========================================================================

   1. DATABASE_URL (Neon POOLED connection string, the -pooler host) must be set
      in the Vercel project environment, not just .env.local. Without it this
      endpoint answers 503 on every submission and the demo gate does not count
      anything across instances.

   2. The demo gate itself is still NOT enforced in production until a durable
      EntitlementStoreAdapter is registered — see registerEntitlementStore() in
      lib/entitlementStore.ts. Until then GET /api/import/quota reports
      `ledger.enforcing: false`, which is the honest answer and not a bug.

   3. Optional, later: move CREATE_TABLE/CREATE_INDEX above into a numbered file
      in db/migrations and delete ensureTable(). The DDL is idempotent, so the
      two can coexist while that happens.
   ========================================================================== */
