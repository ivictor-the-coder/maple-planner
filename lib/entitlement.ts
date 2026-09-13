/**
 * Entitlement — who may do what, how much of it, and what to say when the answer
 * is no.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS ONE FILE
 * -------------------------------------------
 * `app/api/import/route.ts` spends real money on every call (OpenRouter vision
 * tokens). Today it spends it for any anonymous caller on the internet. Hiding
 * the button is not gating; the check has to happen server-side, before the
 * fetch to openrouter.ai. This module is that check, written as pure functions
 * so it can be tested without a browser, a database, or a payment provider.
 *
 * The design was specified as five modules under `lib/entitlement/`. It ships as
 * one file because this builder owns exactly one path. The five sections below
 * are those modules, in order, with the same exports; splitting them later is a
 * cut-and-paste, not a rewrite. Nothing here imports from `next/*`, and nothing
 * here reads the clock, the environment, or the network — `now` and the ledger
 * arrive as arguments so tests can drive time.
 *
 * NO PROVIDER SDK. Auth and payments are translated into this vocabulary at the
 * edge: a session becomes a `Subject` + `PlanState`, a webhook becomes a
 * `BillingEvent`. Swapping Stripe for Paddle for Lemon Squeezy should touch the
 * webhook route and nothing in here.
 *
 * CONSTANTS. Same discipline this repo applies to game constants: every number
 * is a named export with its provenance in a comment. Where a number is a
 * product policy nobody has measured yet, the comment says UNVERIFIED and it is
 * listed in QUOTA_PROVENANCE. The per-screenshot token cost is deliberately
 * `null` rather than a guess — see IMPORT_UNIT_COST_USD_PLACEHOLDER.
 *
 * WHAT THE GATE IS TODAY: A DEMO, NOT A PAYWALL. Every visitor gets
 * DEMO_IMPORTS (10) screenshot imports, ever — one full batch, measured against
 * the `lifetime` bucket, which nothing refills. When it runs out the answer is
 * `demo_exhausted` and the next step is an EXPRESSION OF INTEREST, not a
 * checkout: see INTEREST_FORM_PATH for the Vercel Hobby constraint that makes
 * the difference between those two words a deployment cost rather than a
 * preference. The paid vocabulary below (PAID_*, BillingEvent, PRICE_*) is
 * fully implemented and currently unreachable — it is what "open paid access if
 * enough demand appears" turns on, and nothing in it is wired to a route.
 *
 * HOW app/api/import/route.ts USES THIS. The order is not decorative: every step
 * before `commitSpend` is free, and `commitSpend` is the last thing that happens
 * before money is spent. In practice a route should call guardImport() from
 * lib/entitlementStore.ts, which is this sequence with the fail-closed error
 * handling already in it:
 *
 *   const subject = store.subjectFor(req);            // session, else { kind:'ip' }
 *   const plan    = await planFor(subject);           // session claim; 'anonymous' for ip
 *   const ledger  = await store.readLedger(subject, { now, periodStart });
 *   const d = decideImport(
 *     { subject, plan, periodStart, ledger, batchSize, inFlight: await store.inFlightFor(subject),
 *       configured: Boolean(process.env.OPENROUTER_API_KEY) },
 *     Date.now(),
 *   );
 *   if (!d.allow) {
 *     return NextResponse.json(denyBody(d), { status: statusForDeny(d), headers: denyHeaders(d) });
 *   }
 *   await store.commitSpend(subject, d.charge);       // throws EntitlementDenied on a race
 *   try {
 *     ... existing image validation, then the fetch to openrouter.ai ...
 *     await store.settle(subject, d.charge, settleImport(d.charge, { ok, model, usage }));
 *   } catch { await store.settle(subject, d.charge, settleImport(d.charge, { ok:false, failure:'network_error' })); }
 *
 * `settle` must run on EVERY exit path, including the 20s abort — it releases
 * the concurrency slot as well as refunding the unit, and a leaked slot is a
 * subject who can never import again until the process restarts.
 *
 * FAIL CLOSED. Every await in that sequence can reject, and every rejection
 * DENIES with `store_unavailable`. The alternative — allowing when the ledger
 * is unreachable — spends real money on a call nobody counted, which is the one
 * thing this module exists to prevent. The cost of the choice is stated where
 * it is made: a ledger outage disables the importer completely, and with the
 * in-memory store that outage is indistinguishable from a cold start, which is
 * why the store reports its own durability in every response.
 *
 * GET /api/import/quota answers from `quotaSummary(ctx, Date.now())`, which is
 * the same resolution logic with nothing charged, so the number in the dialog
 * header and the number in the refusal can never disagree.
 */

/* ========================================================================== *
 * 1. PLAN STATES AND CAPABILITIES                    (was entitlement/plan.ts)
 * ========================================================================== */

/**
 * `anonymous` is "no identity at all" — keyed by IP.
 * `free` is a signed-in user who has never paid.
 * `active` is a paying subscriber.
 * `past_due` is a subscriber whose renewal charge failed and whose provider is
 * still retrying (dunning). A failed card is not abuse; see PAST_DUE_* below.
 * `cancelled` is a former subscriber whose paid period has ended.
 */
export type PlanState = "anonymous" | "free" | "active" | "past_due" | "cancelled";

export type Capability =
  | "import.screenshot"
  | "planner.rules"
  | "guide"
  | "legion.roster"
  | "account.persist";

/**
 * The capability table, encoding the docs/BACKLOG.md §2 decision literally.
 *
 * - `planner.rules`, `guide`, `legion.roster` are in EVERY state including
 *   anonymous. They are static computation; serving them costs nothing per user,
 *   so charging for them would be charging for nothing.
 * - `account.persist` needs an identity to persist to: free | active | past_due.
 *   `cancelled` is deliberately absent here because this table is about WRITES;
 *   read access survives cancellation — see PERSIST_MODE.
 * - `import.screenshot` is present in EVERY state, including anonymous. This is
 *   the one line in this file worth arguing about, so: access is never the gate,
 *   quota is. A hard gate at zero means nobody ever experiences the feature that
 *   justifies the $10, which is the open question BACKLOG.md §"Open questions"
 *   asks ("Is there a free trial or a small free quota of screenshots?"). The
 *   answer is a small free quota. Raidbots runs the same shape: free users can
 *   sim, and Premium buys priority and bigger sims rather than the right to sim
 *   at all (https://support.raidbots.com/article/28-raidbots-premium-rewards).
 *
 * `can()` therefore answers "is this feature in this plan", never "may this
 * request proceed". For imports only `decideImport()` is authoritative.
 */
export const CAPABILITIES: Record<PlanState, readonly Capability[]> = Object.freeze({
  anonymous: Object.freeze(["planner.rules", "guide", "legion.roster", "import.screenshot"]),
  free: Object.freeze([
    "planner.rules",
    "guide",
    "legion.roster",
    "import.screenshot",
    "account.persist",
  ]),
  active: Object.freeze([
    "planner.rules",
    "guide",
    "legion.roster",
    "import.screenshot",
    "account.persist",
  ]),
  past_due: Object.freeze([
    "planner.rules",
    "guide",
    "legion.roster",
    "import.screenshot",
    "account.persist",
  ]),
  cancelled: Object.freeze(["planner.rules", "guide", "legion.roster", "import.screenshot"]),
}) as Record<PlanState, readonly Capability[]>;

export function can(state: PlanState, cap: Capability): boolean {
  return CAPABILITIES[state].includes(cap);
}

/**
 * Persistence is the one capability with a meaningful read/write split, and the
 * Capability union is closed, so the nuance lives here instead of inventing a
 * sixth capability.
 *
 * WHY `cancelled` keeps read access: per BACKLOG.md §1 the roster is "the part
 * that is genuinely painful to re-enter" — 31 characters merged across three
 * screenshot pages. Deleting or hiding that the day a card expires is how you
 * guarantee someone never comes back. They can read it; they cannot write new
 * data into it until they resubscribe.
 */
export type PersistMode = "none" | "read" | "read-write";

export const PERSIST_MODE: Record<PlanState, PersistMode> = Object.freeze({
  anonymous: "none", // falls back to localStorage in lib/storage.ts — not an error
  free: "read-write",
  active: "read-write",
  past_due: "read-write", // a failed payment must not lock you out of your own roster
  cancelled: "read",
});

/** The plan a brand-new signed-in account starts in. Sign-up is not a billing
 *  event, so it is not part of applyBillingEvent. */
export const PLAN_ON_SIGN_UP: PlanState = "free";

/* ========================================================================== *
 * 2. TIME
 * ========================================================================== */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Adds calendar months in UTC, clamping to the last day of the target month
 * (Jan 31 + 1 month = Feb 28/29). Billing anchors behave this way at every
 * provider, and getting it wrong silently shortens or lengthens a period, which
 * is exactly the bug that lets someone spend two periods' quota in one month.
 *
 * Pure: `Date` is used here as a calendar calculator, never as a clock.
 */
export function addMonthsUtc(ts: number, months: number): number {
  const d = new Date(ts);
  const targetMonth = d.getUTCMonth() + months;
  const y = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  const m = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(
    y,
    m,
    Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** Seconds, rounded up, never negative — the shape `Retry-After` wants. */
export function secondsUntil(now: number, at: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** "6d", "3h 12m", "42m", "20s". Used verbatim in the deny sentences. */
export function formatResetIn(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h > 0 && m % 60 > 0 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 > 0 ? `${d}d ${h % 24}h` : `${d}d`;
}

/* ========================================================================== *
 * 3. QUOTA CONSTANTS                                (was entitlement/quota.ts)
 * ========================================================================== */

/**
 * Provenance for every tunable below. `sourced` means the number is read off
 * something real (a file in this repo, a decision in BACKLOG.md, a published
 * price). `unverified` means it is a product policy default nobody has measured
 * — safe to change, but do not cite it as fact.
 */
export type Provenance = "sourced" | "derived" | "unverified";

export const QUOTA_PROVENANCE: Readonly<Record<string, { how: Provenance; note: string }>> =
  Object.freeze({
    DEMO_IMPORTS: {
      how: "sourced",
      note: "Product owner decision: the demo is one full batch. Equals MAX_BATCH_FILES (10) — enough gear for one character, and well short of the 25 equip slots a character has.",
    },
    CHARACTER_EQUIP_SLOTS: {
      how: "sourced",
      note: "SLOTS in lib/rules.ts:82-108 — 25 ids, as counted in the comment at lib/portable.ts:233. Copied, not imported: this file stays free of game data so it can be tested on its own.",
    },
    ANON_IMPORTS_PER_HOUR: {
      how: "derived",
      note: "Derived from DEMO_IMPORTS, not chosen. It is a pace limit inside the demo, never the demo ceiling; set below DEMO_IMPORTS it makes the one promised batch impossible to finish in one sitting.",
    },
    FREE_IMPORTS_PER_DAY: {
      how: "derived",
      note: "Equals MAX_BATCH_FILES: a signed-in free user gets exactly one full batch per day.",
    },
    PAID_IMPORTS_PER_PERIOD: {
      how: "unverified",
      note: "Placeholder ceiling. The real value is suggestedPaidImportsPerPeriod(measured unit cost); the unit cost is unmeasured, so this number is a holding position, not an answer.",
    },
    PAID_BURST_PER_MINUTE: {
      how: "derived",
      note: "MAX_CONCURRENT_IMPORTS lanes x 20s worst-case per call = 9/min of real throughput; 12 leaves headroom for fast calls without letting a script outrun the lanes.",
    },
    MAX_CONCURRENT_IMPORTS: {
      how: "sourced",
      note: "CONCURRENCY in components/ImportDialog.tsx:12. The server ceiling must equal the client's, never exceed it.",
    },
    MAX_BATCH_FILES: {
      how: "sourced",
      note: "MAX_FILES in components/ImportDialog.tsx:9, which today exists only client-side.",
    },
    IMPORT_UNIT_COST_USD_PLACEHOLDER: {
      how: "unverified",
      note: "NOT SET. Deliberately null. Measure it from OpenRouter usage on a few hundred real calls; see reconcileImportCost().",
    },
    PRICE_USD_PER_PERIOD: {
      how: "sourced",
      note: "docs/BACKLOG.md §2 — one plan at $10/month.",
    },
    TARGET_COGS_FRACTION_OF_PRICE: {
      how: "unverified",
      note: "Product policy: the fraction of the $10 that may be spent on vision tokens for one subscriber. 0.30 is a holding position, not a benchmark.",
    },
    PAST_DUE_GRACE_DAYS: {
      how: "unverified",
      note: "Product policy for how long a failed card keeps free-tier imports before they stop. Should be set to match whatever dunning window the payment provider is configured for.",
    },
  });

/**
 * THE DEMO. Every visitor gets this many screenshot imports, ever.
 *
 * TEN, AND NOT FIVE — do not "tidy" this number:
 *   - Ten is ONE FULL BATCH. MAX_BATCH_FILES is 10, so a visitor can drop one
 *     batch of screenshots and watch a populated grid appear. That is one
 *     natural action completed, not a mechanic half-demonstrated.
 *   - A character has CHARACTER_EQUIP_SLOTS (25) slots, and the value
 *     proposition is "you do not have to fill 25 slots by hand". Five
 *     screenshots proves the trick works and then leaves 20 slots to type:
 *     the demonstration without the benefit. The visitor learns the feature is
 *     real and that using it is still work.
 *   - Ten is still well short of 25, so the demo does not become the product.
 *
 * One named constant, so moving the number is a one-line change when the demand
 * signal says to move it. Everything downstream — the counter in the dialog,
 * the refusal sentence, the invariants below — reads it from here.
 *
 * This is a LIFETIME count against LedgerSnapshot.lifetime, not a window. See
 * ANON_IMPORTS_PER_HOUR for why both exist and which one governs.
 */
export const DEMO_IMPORTS = 10;

/**
 * Equip slots on one character. Used only to keep DEMO_IMPORTS honest: a demo
 * at or above 25 stops being a demo and becomes the product.
 *
 * SOURCED: SLOTS in lib/rules.ts:82-108, counted at lib/portable.ts:233.
 * Copied rather than imported so this module keeps its promise to import
 * nothing.
 */
export const CHARACTER_EQUIP_SLOTS = 25;

/**
 * Where a visitor whose demo is spent is sent. The deny body carries this path
 * so the dialog does not hard-code it.
 *
 * WHAT THAT PAGE MAY AND MAY NOT DO — this is a deployment constraint, not a
 * design preference. Vercel's Hobby plan forbids commercial use, and defines it
 * to include "any method of requesting or processing payment from visitors of
 * the site". An expression of interest is not payment, so this shape keeps the
 * app on Hobby and defers Vercel Pro at $20/seat/month indefinitely.
 *
 *   ALLOWED:     asking whether someone would use a paid plan, and what they
 *                would expect it to include. "Would you pay for this?" is a
 *                survey question.
 *   NOT ALLOWED: card fields, a checkout of any kind, a pre-order, a waitlist
 *                that takes a deposit, or naming a price as something being
 *                purchased. "Reserve your spot for $10" crosses the line.
 *
 * PRICE_USD_PER_PERIOD exists in this file as a product assumption for sizing
 * quotas. Rendering it on this page as a thing to buy is the drift this comment
 * exists to prevent — it costs $20/month the moment it happens.
 */
export const INTEREST_FORM_PATH = "/interest";

/**
 * WHICH GOVERNS AN ANONYMOUS VISITOR: DEMO_IMPORTS DOES.
 *
 * These two numbers measure different things, and the difference is the whole
 * point of the demo gate:
 *
 *   ANON_IMPORTS_PER_HOUR is a RATE — how fast. It refills. A patient visitor
 *   renews 3/hour forever, spends unbounded OpenRouter tokens over a week, and
 *   never has a reason to tell us they want this. A rate limit answers "is this
 *   a script?", never "has this person had their demo?".
 *
 *   DEMO_IMPORTS is a LIFETIME CEILING — how much, ever. It does not refill. It
 *   is the number that ENDS, and that ending is the moment which produces an
 *   expression of interest.
 *
 * So the lifetime demo is the ceiling, and decideImport checks it FIRST; the
 * hourly window sits underneath as pace. Checking the rate first would answer
 * an exhausted visitor with "try again in 40 minutes", which is a lie — those
 * units are gone for good, and the honest answer is the interest form.
 *
 * THEY CANNOT SILENTLY DISAGREE. A pace limit tighter than the demo makes the
 * promised single batch undeliverable: at 3/hour a 10-screenshot batch stalls
 * on the fourth file and the visitor meets a rate limit instead of a populated
 * grid. So this is DERIVED from DEMO_IMPORTS, and ENTITLEMENT_INVARIANTS below
 * throws at module load if anyone sets it back under the demo. IP remains a
 * weak key (CGNAT shares it, a VPN rotates it); that is accepted, because this
 * bucket is not the business model, it is what stands between the OpenRouter
 * key and the open internet.
 */
export const ANON_IMPORTS_PER_HOUR = DEMO_IMPORTS;

/**
 * A signed-in free user gets their own bucket, not the shared IP bucket. This is
 * the whole reason to sign in before there is anything to buy: the account is
 * worth something on its own. Set to MAX_BATCH_FILES so "one full batch a day"
 * is a sentence the UI can say without arithmetic.
 */
export const FREE_IMPORTS_PER_DAY = 10;

/**
 * The paid ceiling per billing period. It exists because $10/month is a flat
 * price against a variable cost: without a ceiling, one subscriber running the
 * importer in a loop outspends their own subscription. Raidbots states the same
 * position for account sharing and names rate limiting and suspension as the
 * enforcement (https://support.raidbots.com/article/22-account-sharing).
 *
 * UNVERIFIED — a holding position. Replace with suggestedPaidImportsPerPeriod()
 * once IMPORT_UNIT_COST_USD_PLACEHOLDER is a measured number.
 */
export const PAID_IMPORTS_PER_PERIOD = 500;

/**
 * Burst ceiling for paid subjects. Derived from the client: three lanes, each
 * bounded by the 20s per-model deadline in app/api/import/route.ts, is ~9 real
 * imports a minute. Anything materially above that is a script, not the dialog.
 */
export const PAID_BURST_PER_MINUTE = 12;

/**
 * Server-side concurrency ceiling. MUST equal CONCURRENCY in
 * components/ImportDialog.tsx:12 — a server ceiling above the client's protects
 * nothing, and one below it makes the dialog's own third lane fail for every
 * honest user.
 */
export const MAX_CONCURRENT_IMPORTS = 3;

/** Mirrors MAX_FILES in components/ImportDialog.tsx:9. The dialog posts one
 *  image per request today, so batchSize is 1 in practice; this is the ceiling
 *  if request batching ever lands, and the guard against a hand-rolled caller
 *  posting a hundred images in one body. */
export const MAX_BATCH_FILES = 10;

/**
 * Relations between the numbers above that must hold for the demo to mean what
 * the product owner decided it means. Not opinions: each one, if broken,
 * produces a specific silent failure, named in `breaks`.
 *
 * Checked at module load, and a violation throws rather than serving a demo
 * that quietly does not work — every failure mode here is invisible from the
 * outside, because the gate still returns 200s, it just guards the wrong thing.
 */
export interface EntitlementInvariant {
  rule: string;
  ok: boolean;
  detail: string;
  breaks: string;
}

export function entitlementInvariants(): EntitlementInvariant[] {
  return [
    {
      rule: "DEMO_IMPORTS === MAX_BATCH_FILES",
      ok: DEMO_IMPORTS === MAX_BATCH_FILES,
      detail: DEMO_IMPORTS + " vs " + MAX_BATCH_FILES,
      breaks:
        "The demo stops being one full batch. Below: the last files of a full batch are refused mid-way. Above: the visitor is promised imports the dialog will not let them queue.",
    },
    {
      rule: "ANON_IMPORTS_PER_HOUR >= DEMO_IMPORTS",
      ok: ANON_IMPORTS_PER_HOUR >= DEMO_IMPORTS,
      detail: ANON_IMPORTS_PER_HOUR + " vs " + DEMO_IMPORTS,
      breaks:
        "The pace limit fires before the demo is spent, so the one batch we promise cannot be finished in one sitting and the visitor meets 'try again later' instead of a populated grid.",
    },
    {
      rule: "DEMO_IMPORTS < CHARACTER_EQUIP_SLOTS",
      ok: DEMO_IMPORTS < CHARACTER_EQUIP_SLOTS,
      detail: DEMO_IMPORTS + " vs " + CHARACTER_EQUIP_SLOTS,
      breaks:
        "The demo covers a whole character, so it is the product rather than a taste of it.",
    },
    {
      rule: "MAX_CONCURRENT_IMPORTS <= DEMO_IMPORTS",
      ok: MAX_CONCURRENT_IMPORTS <= DEMO_IMPORTS,
      detail: MAX_CONCURRENT_IMPORTS + " vs " + DEMO_IMPORTS,
      breaks:
        "One wave of parallel lanes could exceed the whole demo, so the ceiling is never reached in order and the last allowed import is refused as a concurrency error.",
    },
  ];
}

const ENTITLEMENT_INVARIANT_VIOLATIONS = entitlementInvariants().filter((i) => !i.ok);
if (ENTITLEMENT_INVARIANT_VIOLATIONS.length > 0) {
  throw new Error(
    "Entitlement constants disagree — the demo gate would not do what it says:\n" +
      ENTITLEMENT_INVARIANT_VIOLATIONS.map(
        (v) => "  - " + v.rule + " (" + v.detail + "): " + v.breaks,
      ).join("\n"),
  );
}

/**
 * Cost of one screenshot import, in USD.
 *
 * NOT MEASURED. Deliberately null rather than a plausible-looking number: this
 * value is the denominator of every pricing decision downstream, and a wrong one
 * silently sets the paid quota to the wrong place. Populate it from real
 * `usage` objects (reconcileImportCost) after a few hundred calls, replace the
 * `null` with the measured median, and change this comment to say MEASURED with
 * the date and sample size.
 */
export const IMPORT_UNIT_COST_USD_PLACEHOLDER: number | null = null;

/** docs/BACKLOG.md §2: one plan, $10/month. */
export const PRICE_USD_PER_PERIOD = 10;

/** Share of the subscription price allowed to go to vision tokens for a single
 *  subscriber at their ceiling. UNVERIFIED product policy. */
export const TARGET_COGS_FRACTION_OF_PRICE = 0.3;

/**
 * What PAID_IMPORTS_PER_PERIOD should be, once the unit cost is known. Exported
 * rather than inlined so the derivation is visible and testable instead of
 * being folded into a magic 500.
 *
 * Returns null when the cost is unknown — which is the honest answer today.
 */
export function suggestedPaidImportsPerPeriod(
  unitCostUsd: number | null = IMPORT_UNIT_COST_USD_PLACEHOLDER,
  priceUsd: number = PRICE_USD_PER_PERIOD,
  cogsFraction: number = TARGET_COGS_FRACTION_OF_PRICE,
): number | null {
  if (unitCostUsd === null || !(unitCostUsd > 0)) return null;
  return Math.max(1, Math.floor((priceUsd * cogsFraction) / unitCostUsd));
}

/**
 * What a past_due subject may do with imports. A renewal fails for boring
 * reasons — an expired card, a bank's fraud heuristic, a travelling user. The
 * default drops them to the FREE quota rather than to zero: they keep using the
 * product at the same allowance an unpaid account gets, which costs us exactly
 * what a free user costs us, and they are not punished for their bank.
 *
 * After PAST_DUE_GRACE_DAYS past the end of the unpaid period, dunning has
 * failed and this stops being a transient problem, so imports deny with
 * `plan_past_due` and the UI can say "update your card".
 */
export const PAST_DUE_IMPORT_POLICY: "free_quota" | "deny" = "free_quota";

/** UNVERIFIED product policy — set to match the payment provider's dunning
 *  window, which is configured in that provider's dashboard, not here. */
export const PAST_DUE_GRACE_DAYS = 14;

/**
 * What a cancelled subject may do with imports. Default: exactly what a free
 * account may do. A former subscriber is a free user with history, and the
 * history is the reason they might come back. Flip to "deny" only if abuse
 * shows up in the numbers.
 */
export const CANCELLED_IMPORT_POLICY: "free_quota" | "deny" = "free_quota";

/**
 * Whether a quota unit is refunded when a model answered, cost us tokens, and
 * found nothing usable in the image ("read the image but found no item tooltip,
 * stat window or character list" in the route today).
 *
 * FALSE, and the reasoning matters: the tokens really were spent, and refunding
 * them turns a blank image into an unmetered channel to the OpenRouter key.
 * Genuine failures — the 20s abort, an HTTP 429/403/404 from a model, unparsable
 * output — are refunded in full, because in those cases the user did everything
 * right and we produced nothing.
 */
export const REFUND_ON_NO_CONTENT = false;

/**
 * Per-million-token prices for the models in the route's fallback chain.
 *
 * The INPUT prices are copied from the comment block in
 * app/api/import/route.ts, which records them as probed against the live
 * account. The OUTPUT prices are not recorded anywhere in this repo and are not
 * guessed here — they are null, and any cost derived from tokens returns null
 * until they are filled in from the provider's model page. A confidently wrong
 * cost model sets the wrong price for a real person.
 */
export const MODEL_PRICING_USD_PER_MTOK: Readonly<
  Record<string, { input: number | null; output: number | null }>
> = Object.freeze({
  "z-ai/glm-5.3-flash": Object.freeze({ input: 0.15, output: null }),
  "deepseek/deepseek-v4.1-flash": Object.freeze({ input: 0.15, output: null }),
});

/* ========================================================================== *
 * 4. LEDGER AND CONTEXT TYPES
 * ========================================================================== */

export interface Subject {
  kind: "ip" | "user";
  id: string;
}

/** Stable string key for a subject — what the store indexes on, and what a
 *  Redis key or a SQL unique index should be built from. */
export function subjectKey(s: Subject): string {
  return `${s.kind}:${s.id}`;
}

export type WindowKind = "minute" | "hour" | "day" | "period" | "lifetime";

/**
 * The windows that roll over on a fixed span. `period` is anchored to a billing
 * date and `lifetime` never rolls over at all, so neither belongs in WINDOW_MS
 * and neither can be handed to windowState() — the type says so rather than a
 * comment, because a lifetime counter that silently rolls over every hour is a
 * demo gate that does not gate.
 */
export type RollingWindow = Exclude<WindowKind, "period" | "lifetime">;

export interface LedgerWindow {
  /** epoch ms at which this window opened — i.e. when its first unit was spent */
  startedAt: number;
  /** units spent inside it */
  units: number;
}

/**
 * All four buckets for one subject. Fixed windows anchored on the first spend,
 * not sliding windows: it is what a single `INCR` + `EXPIRE` gives you for free,
 * and it is what the IP tourniquet in the route does, so the two agree.
 */
export interface LedgerSnapshot {
  minute: LedgerWindow;
  hour: LedgerWindow;
  day: LedgerWindow;
  period: LedgerWindow;
  /**
   * The demo counter, and the only bucket with no span. Monotonic for the life
   * of the row: nothing takes units back out of it except a refund for a call
   * that failed. DEMO_IMPORTS is measured against this, which is precisely why
   * a patient visitor cannot renew an hourly allowance forever.
   */
  lifetime: LedgerWindow;
}

export const EMPTY_WINDOW: LedgerWindow = Object.freeze({ startedAt: 0, units: 0 });

export function emptyLedger(): LedgerSnapshot {
  return {
    minute: { ...EMPTY_WINDOW },
    hour: { ...EMPTY_WINDOW },
    day: { ...EMPTY_WINDOW },
    period: { ...EMPTY_WINDOW },
    lifetime: { ...EMPTY_WINDOW },
  };
}

export const WINDOW_MS: Readonly<Record<RollingWindow, number>> = Object.freeze({
  minute: MINUTE_MS,
  hour: HOUR_MS,
  day: DAY_MS,
});

/**
 * Units already spent inside a live window, and when it ends.
 *
 * A window whose span has elapsed reads as empty and ends one span from `now` —
 * that is the rollover, and it is why a spend at periodStart-1ms and one at
 * periodStart+1ms land in different windows.
 */
export function windowState(
  w: LedgerWindow,
  kind: RollingWindow,
  now: number,
): { units: number; endsAt: number } {
  const span = WINDOW_MS[kind];
  const live = w.units > 0 && now - w.startedAt < span;
  return live ? { units: w.units, endsAt: w.startedAt + span } : { units: 0, endsAt: now + span };
}

/** The billing period is bounded by the subscription anchor, not a fixed span. */
export function periodWindowState(
  w: LedgerWindow,
  periodStart: number | null,
  now: number,
): { units: number; endsAt: number } {
  if (periodStart === null) return { units: 0, endsAt: now };
  const endsAt = addMonthsUtc(periodStart, 1);
  // A window opened before this period began belongs to the previous period.
  const live = w.units > 0 && w.startedAt >= periodStart && w.startedAt < endsAt;
  return { units: live ? w.units : 0, endsAt };
}

/**
 * The demo window. There is no reset, so `endsAt` is POSITIVE_INFINITY — the
 * honest value for "never". Every caller must check Number.isFinite before
 * turning it into a Retry-After: telling someone to come back in Infinity
 * seconds is worse than telling them the demo is over. JSON.stringify renders
 * it as null, which a UI should read as "this does not come back".
 */
export function lifetimeWindowState(w: LedgerWindow): { units: number; endsAt: number } {
  return { units: Math.max(0, w.units), endsAt: Number.POSITIVE_INFINITY };
}

export interface ImportContext {
  subject: Subject;
  plan: PlanState;
  /** Start of the current billing period, epoch ms. Null for anyone without a
   *  subscription anchor. */
  periodStart: number | null;
  ledger: LedgerSnapshot;
  /** Images in THIS request. One today — the dialog posts per file. */
  batchSize: number;
  /** Imports already running for this subject, from the store's reservation
   *  count. The snapshot is advisory; commitSpend is the authority on races. */
  inFlight: number;
  /**
   * Whether OPENROUTER_API_KEY is present. Passed in rather than read here so
   * this function stays pure; the route folds its old 501 branch into this so
   * the UI has one vocabulary for every failure. Defaults to true.
   */
  configured?: boolean;
}

/**
 * Why the answer was no. Never a bare boolean: the dialog has to say WHY, and
 * the four reasons a visitor of a gated-demo deployment can actually hit are
 * different conversations —
 *
 *   demo_exhausted     the demo is spent and never comes back. This is the one
 *                      that leads to the interest form; see INTEREST_FORM_PATH.
 *   anon_hourly_limit  rate limited. Time fixes it. Says so.
 *   batch_too_large    the request is malformed. The caller fixes it.
 *   store_unavailable  the ledger could not be read or written, so the import
 *                      was refused rather than run uncounted. See FAIL CLOSED
 *                      on decideImport.
 */
export type DenyReason =
  | "demo_exhausted"
  | "anon_hourly_limit"
  | "free_daily_quota"
  | "period_quota_exhausted"
  | "burst_limit"
  | "concurrency_limit"
  | "batch_too_large"
  | "store_unavailable"
  | "plan_past_due"
  | "plan_cancelled"
  | "not_configured";

export interface Charge {
  subject: Subject;
  /** Quota units to debit — one per screenshot. */
  units: number;
  /** Which buckets this charge increments. Every bucket the subject is measured
   *  against gets incremented, so switching plan mid-period cannot launder
   *  spend through a bucket that was not being read. */
  windows: readonly WindowKind[];
  /** Optimistic cost estimate. Null because IMPORT_UNIT_COST_USD_PLACEHOLDER is
   *  null — an honest unknown, not a zero. */
  estimatedUsd: number | null;
  issuedAt: number;
  /** The window the quota was checked against, for messaging and for tests. */
  against: WindowKind;
  /**
   * Billing period anchor this charge belongs to, carried so the store can tell
   * "the first spend of a new period" from "another spend in this one" without
   * a second read. A Redis implementation encodes the same fact in the key
   * (`period:<periodStart>`); a SQL one needs it in the WHERE clause. Without
   * it the period counter silently stops accumulating after the first rollover.
   */
  periodStart: number | null;
}

export interface Allow {
  allow: true;
  charge: Charge;
  /** Units left in the governing window AFTER this charge lands. */
  remaining: number;
  /** Ceiling of the governing window, for "N of M left this period". */
  limit: number;
  resetsAt: number;
}

export interface Deny {
  allow: false;
  reason: DenyReason;
  retryAfterSec?: number;
  remaining?: number;
  /** True when paying (or paying again) is what fixes this. The UI decides
   *  whether to show the upgrade affordance off this, never off the reason. */
  upgrade?: boolean;
  /**
   * True when the demo is over and there is nothing to buy — the UI shows the
   * EXPRESSION OF INTEREST form off this flag, never off the reason string.
   *
   * `interest` and `upgrade` are mutually exclusive by construction and must
   * stay that way: `upgrade` means "money fixes this", and this deployment
   * does not take money. See INTEREST_FORM_PATH for the legal reason that
   * distinction is load-bearing rather than cosmetic.
   */
  interest?: boolean;
  /** Ceiling that was hit, when there was one — lets the UI say the number. */
  limit?: number;
  window?: WindowKind;
}

export type Decision = Allow | Deny;

/* ========================================================================== *
 * 5. THE DECISION                                  (was entitlement/decide.ts)
 * ========================================================================== */

interface QuotaProfile {
  kind: "anon" | "free" | "paid";
  limit: number;
  window: WindowKind;
  reason: DenyReason;
  upgrade: boolean;
  /** True when running out leads to the interest form rather than a payment. */
  interest: boolean;
}

/**
 * The anonymous visitor's profile, and on this deployment that is EVERY
 * visitor: there is no sign-in, so nobody is ever anything else.
 *
 * The governing window is `lifetime`, not `hour`. An hourly bucket refills,
 * and a visitor who waits out a refill never reaches the end of anything — so
 * there is never a moment that asks them whether they want this, and the
 * OpenRouter spend has no ceiling at all, only a slope. The demo has an end.
 * decideImport checks this ceiling before the hourly pace for the same reason.
 */
const ANON_DEMO_PROFILE: QuotaProfile = {
  kind: "anon",
  limit: DEMO_IMPORTS,
  window: "lifetime",
  reason: "demo_exhausted",
  upgrade: false, // there is nothing to buy — deliberately, see INTEREST_FORM_PATH
  interest: true,
};

const FREE_PROFILE: QuotaProfile = {
  kind: "free",
  limit: FREE_IMPORTS_PER_DAY,
  window: "day",
  reason: "free_daily_quota",
  upgrade: true,
  interest: false,
};

const PAID_PROFILE: QuotaProfile = {
  kind: "paid",
  limit: PAID_IMPORTS_PER_PERIOD,
  window: "period",
  reason: "period_quota_exhausted",
  upgrade: false, // already the top plan; more is a support conversation
  interest: false,
};

/**
 * Which bucket this subject is measured against, or a hard deny when the plan
 * itself is the problem.
 *
 * An IP subject is always the anonymous bucket whatever `plan` claims: without
 * an identity there is nothing else to key on, and trusting a client-asserted
 * plan would be the gate all over again.
 */
export function resolveQuotaProfile(
  ctx: ImportContext,
  now: number,
): QuotaProfile | Deny {
  if (ctx.subject.kind === "ip") return ANON_DEMO_PROFILE;

  switch (ctx.plan) {
    case "anonymous":
      // Contradictory input (a user subject with no plan). Treat as the
      // cheapest bucket rather than throwing at request time.
      return ANON_DEMO_PROFILE;
    case "free":
      return FREE_PROFILE;
    case "active":
      return PAID_PROFILE;
    case "past_due": {
      if (PAST_DUE_IMPORT_POLICY === "deny") {
        return { allow: false, reason: "plan_past_due", upgrade: true, remaining: 0 };
      }
      // Grace runs from the end of the period the failed charge was for.
      if (ctx.periodStart !== null) {
        const graceEnds = addMonthsUtc(ctx.periodStart, 1) + PAST_DUE_GRACE_DAYS * DAY_MS;
        if (now >= graceEnds) {
          return { allow: false, reason: "plan_past_due", upgrade: true, remaining: 0 };
        }
      }
      return FREE_PROFILE;
    }
    case "cancelled":
      return CANCELLED_IMPORT_POLICY === "deny"
        ? { allow: false, reason: "plan_cancelled", upgrade: true, remaining: 0 }
        : FREE_PROFILE;
  }
}

/**
 * Units spent inside whichever window governs this profile, and when it ends.
 * One implementation, used by both decideImport and quotaSummary, so the number
 * in the dialog header and the number in the refusal can never disagree.
 *
 * `endsAt` is POSITIVE_INFINITY for the lifetime demo. Callers turning it into
 * a Retry-After must check Number.isFinite first.
 */
function governingWindowState(
  profile: QuotaProfile,
  ctx: ImportContext,
  now: number,
): { units: number; endsAt: number } {
  if (profile.window === "period") return periodWindowState(ctx.ledger.period, ctx.periodStart, now);
  if (profile.window === "lifetime") return lifetimeWindowState(ctx.ledger.lifetime);
  return windowState(ctx.ledger[profile.window], profile.window, now);
}

/**
 * The single function app/api/import/route.ts calls before it spends anything.
 *
 * Pure: no Date.now(), no fetch, no env. Order of checks is deliberate —
 * cheapest and most objective first (shape of the request), then the ceiling
 * that nothing reopens, then the ones time fixes — so the user is told the most
 * actionable thing, not the first thing that happened to fail.
 *
 * FAIL CLOSED. This function cannot reach the ledger; it is handed one. The
 * caller that CAN fail — the store — must turn any failure into a
 * `store_unavailable` deny and never into an allow, because an allow on an
 * unreadable ledger spends real OpenRouter tokens on a call nobody counted,
 * which is the single thing this module exists to stop. lib/entitlementStore.ts
 * does that, and guardImport() there is the sequence routes should call.
 */
export function decideImport(ctx: ImportContext, now: number): Decision {
  if (ctx.configured === false) {
    // Was a bare 501 with a prose message. Now it is part of the same vocabulary
    // as every other refusal, so the dialog has one rendering path.
    return { allow: false, reason: "not_configured" };
  }

  const batch = ctx.batchSize;
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH_FILES) {
    // A zero-file or non-integer batch is a malformed request, and this is the
    // only reason in the closed union about the shape of the request.
    return { allow: false, reason: "batch_too_large", limit: MAX_BATCH_FILES };
  }

  if (ctx.inFlight + batch > MAX_CONCURRENT_IMPORTS) {
    return {
      allow: false,
      reason: "concurrency_limit",
      // A call is bounded by the 20s per-model deadline in the route, so a slot
      // frees within that. Asking for more than a couple of seconds would make
      // the dialog's own lanes feel broken.
      retryAfterSec: 2,
      limit: MAX_CONCURRENT_IMPORTS,
      window: "minute",
    };
  }

  const profile = resolveQuotaProfile(ctx, now);
  if ("allow" in profile) return profile;

  // THE CEILING FIRST — before any window that time reopens. For an anonymous
  // visitor the ceiling is the lifetime demo, and answering it before the
  // hourly pace limit is the difference between "that was your demo, here is
  // the form" and "try again in 40 minutes", which is false and which also
  // costs us the one useful thing an exhausted visitor can still do.
  const gov = governingWindowState(profile, ctx, now);
  const used = gov.units;
  const left = Math.max(0, profile.limit - used);
  if (used + batch > profile.limit) {
    const denied: Deny = {
      allow: false,
      reason: profile.reason,
      remaining: left,
      limit: profile.limit,
      window: profile.window,
    };
    // A lifetime window has no end, so it gets no Retry-After — Infinity
    // seconds is not a thing to tell a person or a CDN. Everything else comes
    // back on its own and says when.
    if (Number.isFinite(gov.endsAt)) denied.retryAfterSec = secondsUntil(now, gov.endsAt);
    if (profile.upgrade) denied.upgrade = true;
    if (profile.interest) denied.interest = true;
    return denied;
  }

  // PACE, second. These fire only inside a ceiling that still has room, so they
  // always have an honest "try again in N" to offer.
  if (profile.kind === "paid") {
    const minute = windowState(ctx.ledger.minute, "minute", now);
    if (minute.units + batch > PAID_BURST_PER_MINUTE) {
      return {
        allow: false,
        reason: "burst_limit",
        retryAfterSec: secondsUntil(now, minute.endsAt),
        remaining: Math.max(0, PAID_BURST_PER_MINUTE - minute.units),
        limit: PAID_BURST_PER_MINUTE,
        window: "minute",
      };
    }
  }

  if (profile.kind === "anon") {
    const hour = windowState(ctx.ledger.hour, "hour", now);
    if (hour.units + batch > ANON_IMPORTS_PER_HOUR) {
      return {
        allow: false,
        reason: "anon_hourly_limit",
        retryAfterSec: secondsUntil(now, hour.endsAt),
        // Deliberately the DEMO remainder, not the hour's: the hour refills, so
        // how much of it is left is not information anyone can act on, while
        // how much demo is left is the only number that matters.
        remaining: left,
        limit: ANON_IMPORTS_PER_HOUR,
        window: "hour",
      };
    }
  }
  // NOTE: while ANON_IMPORTS_PER_HOUR === DEMO_IMPORTS the branch above cannot
  // fire — the demo ceiling is reached first, by exactly one import. It is not
  // dead code but latent: the invariants permit raising the demo above the
  // pace, and on the day someone does, this is what stops a script from
  // draining the whole demo in one second. If it ever fires, the two numbers
  // have been separated on purpose.

  // Every bucket the subject could be measured against is incremented, not just
  // the governing one: a free user who subscribes mid-day must not find their
  // day bucket unwritten when they lapse back to free next month. `lifetime` is
  // in EVERY set — the demo must not be launderable through a plan change, and
  // a subject who spends under one profile has still spent.
  const windows: WindowKind[] =
    profile.kind === "paid"
      ? ["minute", "hour", "day", "period", "lifetime"]
      : ["minute", "hour", "day", "lifetime"];

  return {
    allow: true,
    charge: {
      subject: ctx.subject,
      units: batch,
      windows,
      estimatedUsd:
        IMPORT_UNIT_COST_USD_PLACEHOLDER === null
          ? null
          : IMPORT_UNIT_COST_USD_PLACEHOLDER * batch,
      issuedAt: now,
      against: profile.window,
      periodStart: ctx.periodStart,
    },
    remaining: left - batch,
    limit: profile.limit,
    resetsAt: gov.endsAt,
  };
}

/**
 * What the dialog header shows BEFORE anyone spends anything — "N of M imports
 * left this period". Raidbots puts the combination count on screen while you are
 * still choosing; a counter you only meet at the moment of refusal is not a
 * budget, it is an ambush.
 */
export interface QuotaSummary {
  used: number;
  limit: number;
  remaining: number;
  /**
   * POSITIVE_INFINITY when the governing window is the lifetime demo, because
   * it does not reset. JSON.stringify renders that as null; a UI must read null
   * as "never", not as "unknown" or "now".
   */
  resetsAt: number;
  window: WindowKind;
  plan: PlanState;
  /** e.g. "this hour", "today", "this period" — drop straight into a sentence. */
  windowLabel: string;
  /** Present when the plan itself blocks imports; the dialog shows this instead
   *  of a counter. */
  blocked?: DenyReason;
}

const WINDOW_LABEL: Record<WindowKind, string> = {
  minute: "this minute",
  hour: "this hour",
  day: "today",
  period: "this period",
  lifetime: "in your demo",
};

export function quotaSummary(ctx: ImportContext, now: number): QuotaSummary {
  const profile = resolveQuotaProfile(ctx, now);
  if ("allow" in profile) {
    return {
      used: 0,
      limit: 0,
      remaining: 0,
      resetsAt: now,
      window: "period",
      plan: ctx.plan,
      windowLabel: WINDOW_LABEL.period,
      blocked: profile.reason,
    };
  }
  const gov = governingWindowState(profile, ctx, now);
  return {
    used: gov.units,
    limit: profile.limit,
    remaining: Math.max(0, profile.limit - gov.units),
    resetsAt: gov.endsAt,
    window: profile.window,
    plan: ctx.plan,
    windowLabel: WINDOW_LABEL[profile.window],
  };
}

/* -------------------------------------------------------------------------- *
 * Persistence decisions. Kept separate from imports because persistence has no
 * marginal cost — it is gated by identity, not by quota.
 * -------------------------------------------------------------------------- */

/**
 * `local_only` is not a failure: an anonymous visitor's data goes to
 * localStorage via lib/storage.ts and the app works exactly as it does today.
 * Returning a DenyReason for it would push an auth concern into the entitlement
 * vocabulary and make the UI shout at someone who has done nothing wrong.
 */
export function persistDisposition(plan: PlanState): "allow" | "read_only" | "local_only" {
  const mode = PERSIST_MODE[plan];
  return mode === "read-write" ? "allow" : mode === "read" ? "read_only" : "local_only";
}

/**
 * For an authenticated request only — `anonymous` is excluded at the type level
 * because "not signed in" is a 401 the auth layer owns, not an entitlement
 * refusal.
 */
export function decidePersist(
  plan: Exclude<PlanState, "anonymous">,
  op: "read" | "write",
): Decision {
  const mode = PERSIST_MODE[plan];
  if (op === "read" || mode === "read-write") {
    return {
      allow: true,
      charge: {
        subject: { kind: "user", id: "" },
        units: 0,
        windows: [],
        estimatedUsd: 0,
        issuedAt: 0,
        against: "period",
        periodStart: null,
      },
      remaining: Number.POSITIVE_INFINITY,
      limit: Number.POSITIVE_INFINITY,
      resetsAt: 0,
    };
  }
  // Only reachable for cancelled + write: the roster stays readable, but nothing
  // new is written into an account that is no longer paying for storage.
  return { allow: false, reason: "plan_cancelled", upgrade: true };
}

/* ========================================================================== *
 * 6. HTTP AND UI VOCABULARY
 * ========================================================================== */

/**
 * One reason, one status. 429 is used for everything that time alone fixes —
 * including free_daily_quota, which the spec left open: a daily allowance that
 * refills on its own is a rate limit, and answering 402 to someone who only has
 * to wait until tomorrow is a lie told to sell a subscription. The upsell rides
 * on `upgrade: true` instead, where the UI can present it as an option.
 */
export const DENY_STATUS: Readonly<Record<DenyReason, number>> = Object.freeze({
  // 403, deliberately NOT 402. 402 is "Payment Required", and this deployment
  // never asks for payment — see INTEREST_FORM_PATH. Answering 402 to a spent
  // demo would describe the endpoint as a paywall in the one place a machine
  // reads, which is exactly the line the Hobby plan says not to cross.
  demo_exhausted: 403,
  // 503: the ledger, not the caller, is the problem, and it may come back.
  store_unavailable: 503,
  anon_hourly_limit: 429,
  burst_limit: 429,
  concurrency_limit: 429,
  free_daily_quota: 429,
  period_quota_exhausted: 402,
  plan_past_due: 402,
  plan_cancelled: 403,
  batch_too_large: 413,
  not_configured: 501, // matches the status the route returns today
});

export function statusForDeny(d: Deny): number {
  return DENY_STATUS[d.reason];
}

/** The JSON body shape the dialog parses. Fields are omitted, never null, so
 *  `if (body.retryAfterSec)` reads correctly. */
export interface DenyBody {
  error: string;
  reason: DenyReason;
  retryAfterSec?: number;
  remaining?: number;
  upgrade?: boolean;
  /** Present and true only on demo_exhausted: show the interest form. */
  interest?: boolean;
  /** Where that form lives, so the dialog does not hard-code a path. */
  interestPath?: string;
}

/**
 * The sentence a human reads. It names the real number and the real time,
 * because "Request failed" is what the dialog says today and it tells the user
 * nothing they can act on.
 */
export function explainDeny(d: Deny): string {
  const reset = d.retryAfterSec !== undefined ? formatResetIn(d.retryAfterSec) : "";
  switch (d.reason) {
    case "demo_exhausted":
      // Wording is constrained, not stylistic. It must not name a price as
      // something being bought, sell a place in a queue, or promise access in
      // exchange for anything. "Would you use this?" is a survey; "reserve your
      // spot for $10" is commerce. See INTEREST_FORM_PATH.
      return `That's all ${d.limit ?? DEMO_IMPORTS} screenshot imports in the demo — one full batch, enough for one character's gear. There's no paid plan yet. If you'd use one, say so and we'll open access if enough people ask.`;
    case "store_unavailable":
      return `Screenshot import is unavailable right now: the usage ledger can't be reached, so imports are being refused rather than run uncounted.${reset ? ` Try again in ${reset}.` : ""}`;
    case "anon_hourly_limit":
      // No longer mentions signing in: there is no account to sign in to on
      // this deployment, and pointing at one would be a dead end. This is pace,
      // and pace is fixed by waiting.
      return `That's ${d.limit ?? ANON_IMPORTS_PER_HOUR} imports in an hour.${reset ? ` Try again in ${reset}` : ""}${d.remaining !== undefined ? ` — ${d.remaining} left in your demo.` : "."}`;
    case "free_daily_quota":
      return `You've used today's ${d.limit ?? FREE_IMPORTS_PER_DAY} free imports.${reset ? ` They reset in ${reset}.` : ""}`;
    case "period_quota_exhausted":
      return `You've used all ${d.limit ?? PAID_IMPORTS_PER_PERIOD} imports in this billing period.${reset ? ` It resets in ${reset}.` : ""}`;
    case "burst_limit":
      return `That's a lot of imports at once.${reset ? ` Try again in ${reset}.` : ""}`;
    case "concurrency_limit":
      return `${MAX_CONCURRENT_IMPORTS} imports are already running — the next one starts as soon as one finishes.`;
    case "batch_too_large":
      return `That's more than ${MAX_BATCH_FILES} screenshots in one request.`;
    case "plan_past_due":
      return "Your last payment didn't go through, so screenshot imports are paused. Updating your card restores them — everything else still works.";
    case "plan_cancelled":
      return "Your subscription has ended. Your gear and roster are still here; resubscribe to import screenshots again.";
    case "not_configured":
      return "Screenshot import isn't configured on this deployment yet.";
  }
}

export function denyBody(d: Deny): DenyBody {
  const body: DenyBody = { error: explainDeny(d), reason: d.reason };
  if (d.retryAfterSec !== undefined) body.retryAfterSec = d.retryAfterSec;
  if (d.remaining !== undefined) body.remaining = d.remaining;
  if (d.upgrade !== undefined) body.upgrade = d.upgrade;
  if (d.interest) {
    body.interest = true;
    body.interestPath = INTEREST_FORM_PATH;
  }
  return body;
}

/** Headers to send with a denial. `Retry-After` in seconds is what every client
 *  and every CDN already understands. */
export function denyHeaders(d: Deny): Record<string, string> {
  return d.retryAfterSec !== undefined ? { "Retry-After": String(d.retryAfterSec) } : {};
}

/* ========================================================================== *
 * 7. BILLING STATE MACHINE                          (was entitlement/state.ts)
 * ========================================================================== */

/**
 * Provider-agnostic events. A webhook route validates its provider's signature,
 * translates the payload into one of these, and calls applyBillingEvent. No
 * signature logic, no SDK types, and no provider vocabulary crosses into here.
 *
 * ADAPTER CONTRACT, and it is the one thing this design costs you: emit
 * `period_ended` ONLY when a subscription's final period has ended — that is,
 * after a cancellation, or when dunning has been abandoned. A healthy renewal
 * emits `renewal_succeeded`. PlanState has no slot for "active but cancelling",
 * and inventing one would change the specified type; instead the provider's own
 * distinction between "renewed" and "ended" carries it.
 */
export type BillingEvent =
  | "checkout_completed"
  | "renewal_succeeded"
  | "renewal_failed"
  | "cancelled_at_period_end"
  | "period_ended"
  | "reactivated";

export interface BillingTransition {
  from: PlanState;
  event: BillingEvent;
  to: PlanState;
  at: number;
  /** Why, in one line, for the audit log. Webhooks are replayed and reordered;
   *  a log that says "free -> free (no subscription to renew)" is the difference
   *  between a five-minute and a five-hour investigation. */
  note: string;
}

export function describeBillingTransition(
  state: PlanState,
  event: BillingEvent,
  now: number,
): BillingTransition {
  const t = (to: PlanState, note: string): BillingTransition => ({ from: state, event, to, at: now, note });

  switch (event) {
    case "checkout_completed":
      // Terminal for every state: money arrived, the subject is active. Also the
      // only path out of `anonymous`, since checkout creates the identity.
      return t("active", "payment completed");

    case "reactivated":
      return state === "anonymous"
        ? t(state, "no subscription to reactivate")
        : t("active", "subscription reactivated");

    case "renewal_succeeded":
      // Accepted from cancelled too: a late or reordered webhook after a
      // resubscribe must not leave a paying customer locked out.
      return state === "anonymous" || state === "free"
        ? t(state, "no subscription to renew")
        : t("active", "renewal charged");

    case "renewal_failed":
      if (state === "active" || state === "past_due") {
        // Idempotent under retries: the provider fires this once per attempt.
        return t("past_due", "renewal charge failed, dunning in progress");
      }
      return t(state, "no subscription to fail");

    case "cancelled_at_period_end":
      // Deliberately NOT a downgrade. The period is paid for; taking access away
      // the moment someone clicks cancel is charging for time you then refuse to
      // serve. `period_ended` does the downgrade when the time is actually up.
      return state === "active" || state === "past_due"
        ? t(state, "cancellation scheduled, access retained until period end")
        : t(state, "nothing to cancel");

    case "period_ended":
      return state === "active" || state === "past_due"
        ? t("cancelled", "final period ended")
        : t(state, "no paid period to end");
  }
}

/** The reducer the webhook route calls. Total and safe to replay — an event
 *  that makes no sense for the current state returns that state unchanged
 *  rather than throwing, because a webhook handler that throws gets retried
 *  forever. */
export function applyBillingEvent(state: PlanState, event: BillingEvent, now: number): PlanState {
  return describeBillingTransition(state, event, now).to;
}

/* ========================================================================== *
 * 8. COST RECONCILIATION
 * ========================================================================== */

/** The `usage` object OpenRouter returns alongside `choices` — which the route
 *  currently reads past and throws away. */
export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Some OpenRouter responses carry a cost in USD. When present it is the
   *  provider's own arithmetic and beats anything derived from a price table. */
  cost?: number;
}

/** The failure paths that already exist in app/api/import/route.ts. */
export type ImportFailure =
  | "timeout" // the 20s AbortController
  | "model_http_error" // 429 / 403 / 404 from a model
  | "network_error"
  | "unparseable" // extractJson returned null
  | "no_content" // answered, but no tooltip / stat window / roster in the image
  | "not_configured";

export interface ImportOutcome {
  ok: boolean;
  model?: string;
  usage?: OpenRouterUsage | null;
  failure?: ImportFailure;
}

export interface Settlement {
  /** Units to hand back. Equal to charge.units for a full refund. */
  unitsToRefund: number;
  /** What the call really cost, when it can be computed; null when any needed
   *  price is unknown. Feeds the measurement that replaces
   *  IMPORT_UNIT_COST_USD_PLACEHOLDER. */
  measuredUsd: number | null;
  note: string;
}

/**
 * Real cost of one call from its usage object. Returns null rather than a
 * partial number when a price is missing — an output price of "probably about
 * the same as input" is exactly the invented constant this repo refuses to
 * write.
 */
export function reconcileImportCost(model: string | undefined, usage: OpenRouterUsage | null | undefined): number | null {
  if (!usage) return null;
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) return usage.cost;
  const price = model ? MODEL_PRICING_USD_PER_MTOK[model] : undefined;
  if (!price || price.input === null || price.output === null) return null;
  const inTok = usage.prompt_tokens ?? 0;
  const outTok = usage.completion_tokens ?? 0;
  return (inTok * price.input + outTok * price.output) / 1_000_000;
}

/**
 * What to do with the optimistic charge once the call has finished.
 *
 * A user must not lose a quota unit for a screenshot that came back "timed out
 * after 20s" — they did nothing wrong and received nothing. `no_content` is the
 * one judgement call; see REFUND_ON_NO_CONTENT for why it is not refunded by
 * default.
 */
export function settleImport(charge: Charge, outcome: ImportOutcome): Settlement {
  const measuredUsd = reconcileImportCost(outcome.model, outcome.usage);

  if (outcome.ok) {
    return { unitsToRefund: 0, measuredUsd, note: "import succeeded" };
  }

  switch (outcome.failure) {
    case "timeout":
    case "model_http_error":
    case "network_error":
    case "unparseable":
    case "not_configured":
      return {
        unitsToRefund: charge.units,
        measuredUsd,
        note: `refunded in full: ${outcome.failure}`,
      };
    case "no_content":
      return REFUND_ON_NO_CONTENT
        ? { unitsToRefund: charge.units, measuredUsd, note: "refunded: model found nothing usable" }
        : { unitsToRefund: 0, measuredUsd, note: "kept: tokens were spent reading the image" };
    default:
      // Unknown failure: refund. Erring toward the user costs us one call; the
      // other error costs us their trust in the counter.
      return { unitsToRefund: charge.units, measuredUsd, note: "refunded: unclassified failure" };
  }
}

/** A charge negated — what the store applies on refund. */
export function refundOf(charge: Charge, units: number): Charge {
  return { ...charge, units: -Math.abs(units), estimatedUsd: null };
}

/* ========================================================================== *
 * 9. THE STORAGE PORT AND AN IN-MEMORY IMPLEMENTATION
 *                                                   (was entitlement/store.ts)
 * ========================================================================== */

/** Structurally a `Request`, without importing one. Keeps this file free of
 *  next/* and testable with a two-line fake. */
export interface RequestLike {
  headers: { get(name: string): string | null };
}

export interface LedgerQuery {
  now: number;
  periodStart: number | null;
}

/** Thrown by commitSpend when the authoritative check disagrees with the
 *  advisory one — i.e. a race. Carries the same vocabulary as a Decision so the
 *  route maps it through exactly one code path. */
export class EntitlementDenied extends Error {
  readonly deny: Deny;
  constructor(deny: Deny) {
    super(explainDeny(deny));
    this.name = "EntitlementDenied";
    this.deny = deny;
  }
}

/**
 * The port. Every method except subjectFor may reject, and MUST reject rather
 * than paper over a failure: an implementation that returns emptyLedger() when
 * its database is unreachable has converted "we do not know" into "they have
 * spent nothing", which grants an unbounded demo to everyone for the duration
 * of the outage and spends real OpenRouter tokens doing it.
 *
 * Callers turn a rejection into a `store_unavailable` deny. guardImport() in
 * lib/entitlementStore.ts is that caller; routes should use it rather than
 * re-implementing the sequence.
 */
export interface EntitlementStore {
  /**
   * Identity for a request. Falls back to `{kind:'ip'}` when there is no
   * session.
   *
   * An implementation must never derive identity from a header the client can
   * set. A subject key a visitor can change at will is not a key: it is a
   * button that says "new demo".
   */
  subjectFor(req: RequestLike): Subject;
  readLedger(subject: Subject, window: LedgerQuery): Promise<LedgerSnapshot>;
  /** In-flight reservations for this subject right now. */
  inFlightFor(subject: Subject): Promise<number>;
  /**
   * Debit the charge and reserve a concurrency slot, ATOMICALLY — one
   * `UPDATE ... RETURNING`, or one `INCR` + `EXPIRE`, never a read followed by a
   * write. components/ImportDialog.tsx fires three lanes at once; a
   * read-then-write here loses that race every time, and the way it loses is by
   * granting more than the ceiling.
   *
   * Throws EntitlementDenied when the atomic check fails.
   */
  commitSpend(subject: Subject, charge: Charge): Promise<LedgerSnapshot>;
  /** Release the slot and hand back `units` (0 on success). Must be called on
   *  every path out of the route, including the failures. */
  settle(subject: Subject, charge: Charge, settlement: Settlement): Promise<LedgerSnapshot>;
}

interface MemRecord {
  ledger: LedgerSnapshot;
  inFlight: number;
}

/**
 * THE LEDGER ARITHMETIC, IN A MAP. Dev and test only.
 *
 * This is the raw mechanism, not the thing routes use: it is wrapped by
 * VolatileMemoryEntitlementStore in lib/entitlementStore.ts, which adds the
 * health reporting that tells the API — loudly, in every response — that this
 * ledger does not survive a cold start and therefore does not gate anything in
 * production. Use the wrapper. Two implementations of this arithmetic is
 * exactly the drift worth avoiding, which is why the wrapper delegates here
 * rather than copying.
 *
 * It is genuinely atomic, not approximately: the read-modify-write in
 * commitSpend contains no `await`, so the JS event loop cannot interleave
 * another request inside it. A Postgres or Redis implementation has to buy that
 * property explicitly; the doc comment on the interface says how.
 *
 * NOT PRODUCTION ON VERCEL. Serverless instances do not share a Map and are
 * recycled constantly, so every cold start hands the visitor a fresh demo. It
 * limits per-instance, not per-visitor.
 */
export class MemoryEntitlementStore implements EntitlementStore {
  private readonly rows = new Map<string, MemRecord>();
  private readonly concurrencyLimit: number;
  private readonly trustUserIdHeader: boolean;

  /**
   * `trustUserIdHeader` exists for tests that need to drive two subjects
   * through one fake request, and defaults to FALSE. Turning it on in
   * production would let any caller mint a fresh subject — and therefore a
   * fresh demo — by changing one header, which is the gate not gating. It may
   * only be enabled once something upstream actually verifies that header.
   */
  constructor(concurrencyLimit: number = MAX_CONCURRENT_IMPORTS, trustUserIdHeader = false) {
    this.concurrencyLimit = concurrencyLimit;
    this.trustUserIdHeader = trustUserIdHeader;
  }

  subjectFor(req: RequestLike): Subject {
    if (this.trustUserIdHeader) {
      const user = req.headers.get("x-entitlement-user-id");
      if (user) return { kind: "user", id: user };
    }
    return { kind: "ip", id: clientIpFrom(req.headers.get("x-forwarded-for")) };
  }

  private row(subject: Subject): MemRecord {
    const k = subjectKey(subject);
    let r = this.rows.get(k);
    if (!r) {
      r = { ledger: emptyLedger(), inFlight: 0 };
      this.rows.set(k, r);
    }
    return r;
  }

  async readLedger(subject: Subject, window: LedgerQuery): Promise<LedgerSnapshot> {
    const r = this.row(subject);
    return rolledOver(r.ledger, window);
  }

  async inFlightFor(subject: Subject): Promise<number> {
    return this.row(subject).inFlight;
  }

  async commitSpend(subject: Subject, charge: Charge): Promise<LedgerSnapshot> {
    // --- critical section: no await below this line until the return ---
    const r = this.row(subject);
    if (r.inFlight + charge.units > this.concurrencyLimit) {
      throw new EntitlementDenied({
        allow: false,
        reason: "concurrency_limit",
        retryAfterSec: 2,
        limit: this.concurrencyLimit,
        window: "minute",
      });
    }
    r.inFlight += charge.units;
    for (const w of charge.windows) {
      const win = r.ledger[w];
      // A window that has aged out, or one belonging to a previous billing
      // period, is replaced rather than incremented. Getting the period case
      // wrong is invisible and expensive: the counter keeps rising against a row
      // every reader treats as stale, so the ceiling never bites again.
      const stale =
        win.units === 0 ||
        (w === "lifetime"
          ? // The demo counter never ages out. If this ever becomes "true" the
            // demo silently turns into a rate limit and the gate stops gating.
            false
          : w === "period"
            ? charge.periodStart !== null && win.startedAt < charge.periodStart
            : charge.issuedAt - win.startedAt >= WINDOW_MS[w]);
      if (stale) {
        r.ledger[w] = { startedAt: charge.issuedAt, units: Math.max(0, charge.units) };
      } else {
        win.units = Math.max(0, win.units + charge.units);
      }
    }
    return cloneLedger(r.ledger);
    // --- end critical section ---
  }

  async settle(subject: Subject, charge: Charge, settlement: Settlement): Promise<LedgerSnapshot> {
    const r = this.row(subject);
    r.inFlight = Math.max(0, r.inFlight - charge.units);
    if (settlement.unitsToRefund > 0) {
      for (const w of charge.windows) {
        const win = r.ledger[w];
        win.units = Math.max(0, win.units - settlement.unitsToRefund);
      }
    }
    return cloneLedger(r.ledger);
  }

  /** Tests only. */
  reset(): void {
    this.rows.clear();
  }
}

function cloneLedger(l: LedgerSnapshot): LedgerSnapshot {
  return {
    minute: { ...l.minute },
    hour: { ...l.hour },
    day: { ...l.day },
    period: { ...l.period },
    lifetime: { ...l.lifetime },
  };
}

/** Zeroes windows whose span has elapsed, so a reader never sees yesterday's
 *  units as today's. Pure, and the same rule decideImport applies. */
export function rolledOver(l: LedgerSnapshot, q: LedgerQuery): LedgerSnapshot {
  const fix = (w: LedgerWindow, kind: RollingWindow): LedgerWindow => {
    const s = windowState(w, kind, q.now);
    return s.units === 0 ? { startedAt: 0, units: 0 } : { ...w };
  };
  const p = periodWindowState(l.period, q.periodStart, q.now);
  return {
    minute: fix(l.minute, "minute"),
    hour: fix(l.hour, "hour"),
    day: fix(l.day, "day"),
    period: p.units === 0 ? { startedAt: 0, units: 0 } : { ...l.period },
    // Never rolled over. That is the entire point of the demo counter: it is
    // the one number a visitor cannot wait out.
    lifetime: { ...l.lifetime },
  };
}

/* ========================================================================== *
 * 10. TOURNIQUET HELPERS
 * ========================================================================== *
 *
 * These belong to the emergency commit that closes /api/import to the open
 * internet, and they are NOT the entitlement layer — do not mistake one for the
 * other. They are pure so the route can use them without a second copy of the
 * parsing logic, and so they can be tested.
 */

/**
 * First hop in `x-forwarded-for`. On Vercel the left-most entry is the client
 * as seen by the edge; entries to its right are proxies. An empty or absent
 * header yields "unknown", which then shares one bucket — deliberately, since an
 * unattributable caller should not get a fresh allowance by stripping a header.
 */
export function clientIpFrom(xForwardedFor: string | null | undefined): string {
  const first = (xForwardedFor ?? "").split(",")[0]?.trim();
  return first || "unknown";
}

/**
 * True when the request was made by this deployment's own front end. Cheap,
 * bypassable by anyone who sets a header deliberately, and still worth having:
 * it stops every casual `curl` and every scraper that finds the endpoint, which
 * is the entire population spending the key today.
 */
export function isSameSiteRequest(
  origin: string | null | undefined,
  referer: string | null | undefined,
  allowedHosts: readonly string[],
): boolean {
  const host = hostOf(origin) ?? hostOf(referer);
  if (!host) return false; // no Origin and no Referer: not a browser form post we sent
  return allowedHosts.some((h) => h === host || (h.startsWith(".") && host.endsWith(h)));
}

function hostOf(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Hosts the importer answers to. `localhost` entries cover `next dev`; Vercel
 *  preview deployments vary per branch, hence the suffix match. */
export const ALLOWED_IMPORT_HOSTS: readonly string[] = Object.freeze([
  "maple-planner-blond.vercel.app",
  ".vercel.app",
  "localhost:3000",
  "127.0.0.1:3000",
]);
