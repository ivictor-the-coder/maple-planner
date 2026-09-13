/**
 * Entitlement storage — the adapter seam, the dev implementation, and the
 * fail-closed sequence routes call.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * `lib/entitlement.ts` decides. It is pure: no clock, no env, no network, and
 * no memory of what anyone has already spent. This file is the memory, and it
 * is the only place in the entitlement layer allowed to fail.
 *
 * THERE ARE TWO DATASTORES, AND ONLY ONE OF THEM GATES ANYTHING.
 *
 *   neon-postgres    NeonEntitlementStore in lib/entitlementNeonStore.ts, on
 *                    the "entitlement_ledger" table from
 *                    db/migrations/0002_entitlement_ledger.sql. Durable, shared
 *                    between serverless instances, compare-and-swap on every
 *                    write. This is the gate.
 *   memory-volatile  a Map in one Node process, named after its defect. Right
 *                    for `next dev` and tests; not a gate anywhere else.
 *
 * WHICH ONE YOU GET: the database when DATABASE_URL is configured, the Map
 * otherwise — chooseEntitlementBackend() below is the whole rule, and the
 * fallback is LOUD. A deployment that quietly stops enforcing is the exact
 * failure this design exists to prevent, so the fallback logs a banner at error
 * level when it happens anywhere that looks like production, and `health()`
 * rides along in every response the API sends — allow and deny alike — saying
 * which backend answered and whether it is really enforcing. A reader who never
 * opens this file still learns it from the JSON.
 *
 * WHAT THE MAP MEANS ON VERCEL, PLAINLY. A serverless function is cold-started,
 * recycled and scaled horizontally at the platform's discretion, and none of
 * those instances share a Map. So on the volatile store the demo is NOT
 * enforced: a visitor who waits for a cold start, or who simply lands on a
 * different instance, starts again at zero used. It counts correctly and
 * forgets completely.
 *
 * THE SEAM. Routes never name an implementation; they call getEntitlementStore()
 * or, better, guardImport(). A third implementation (KV, Redis) is a class that
 * implements EntitlementStoreAdapter plus one registerEntitlementStore() call at
 * process start — no route changes, no import changes, one line moved.
 *
 * FAIL CLOSED. Every ledger call here can reject, and every rejection becomes a
 * `store_unavailable` DENY. Never an allow. An allow on an unreadable ledger
 * spends real OpenRouter vision tokens on a call nobody counted, which is the
 * exact expense this layer exists to stop. The cost of that choice is real and
 * is not hidden: while the ledger is unreachable the importer is off for
 * everybody, including people who have demo left. That is the cheaper failure —
 * a broken importer is a bug report, an uncounted importer is a bill.
 */

import {
  DEMO_IMPORTS,
  EntitlementDenied,
  INTEREST_FORM_PATH,
  MAX_CONCURRENT_IMPORTS,
  MemoryEntitlementStore,
  decideImport,
  denyBody,
  denyHeaders,
  quotaSummary,
  settleImport,
  statusForDeny,
  subjectKey,
  type Charge,
  type Deny,
  type DenyBody,
  type EntitlementStore,
  type ImportContext,
  type ImportOutcome,
  type LedgerQuery,
  type LedgerSnapshot,
  type PlanState,
  type QuotaSummary,
  type RequestLike,
  type Settlement,
  type Subject,
} from "./entitlement";
import { NeonEntitlementStore } from "./entitlementNeonStore";

/* ========================================================================== *
 * 1. WHAT A STORE MUST SAY ABOUT ITSELF
 * ========================================================================== */

/**
 * A store's own account of whether it is really enforcing anything. This is
 * returned to the API on every path so that "the demo is not actually gated in
 * production" is a fact in the response body, not a discovery someone makes six
 * weeks later while reading lib/.
 *
 * IT DESCRIBES THE STORE AT THE INSTANT health() IS CALLED, and for a store
 * that can fail that is a different answer before and after a ledger call. So
 * the rule for every caller, and the reason guardImport() below reads health()
 * at each of its exits rather than once at the top: ask AFTER the ledger calls
 * whose outcome the response reports, never before them. Health read first and
 * attached to a response built later is a claim about calls that had not
 * happened yet.
 */
export interface LedgerHealth {
  /** Short machine id of the implementation, e.g. "memory-volatile". */
  backend: string;
  /** True only when counts outlive the process that wrote them. */
  durable: boolean;
  /** Spelled out separately because this is the specific lie to avoid: a
   *  serverless cold start must not hand anyone a fresh demo. */
  survivesColdStart: boolean;
  /**
   * True when a refusal from this store can be trusted to mean something. False
   * for the in-memory store: it will still refuse the 11th import of one warm
   * instance, which is a real behaviour and a useless guarantee.
   */
  enforcing: boolean;
  /** Human-readable klaxon, or null for a store that really does enforce. */
  warning: string | null;
}

/**
 * The seam. Everything routes touch is this type, never a concrete class.
 *
 * A durable implementation must keep the two properties the in-memory one gets
 * for free from the single-threaded event loop:
 *   1. commitSpend is ATOMIC — one `UPDATE ... RETURNING` or one `INCR`+`EXPIRE`,
 *      never a read followed by a write. ImportDialog fires three lanes at once
 *      and a read-then-write loses that race by granting over the ceiling.
 *   2. Failures REJECT. Returning an empty ledger when the database is down
 *      turns "we do not know" into "they have spent nothing", which is an
 *      unlimited demo for the length of the outage.
 */
export interface EntitlementStoreAdapter extends EntitlementStore {
  readonly backend: string;
  readonly durable: boolean;
  health(): LedgerHealth;
}

/* ========================================================================== *
 * 2. THE DEV IMPLEMENTATION, NAMED AFTER ITS DEFECT
 * ========================================================================== */

/**
 * The exact sentence this store puts in front of anyone who receives its JSON.
 * Exported so a health endpoint, a startup log and a deploy checklist can all
 * say the same thing.
 */
export const VOLATILE_LEDGER_WARNING =
  "IN-MEMORY ENTITLEMENT LEDGER — NOT A PRODUCTION GATE. Import counts live in one " +
  "server process's memory. A cold start, a redeploy, or a second serverless instance " +
  "starts every visitor back at zero used, so on Vercel the demo limit is not actually " +
  "enforced. Register a durable store (Neon, KV) via registerEntitlementStore() before " +
  "relying on this to cap OpenRouter spend.";

/**
 * IN-MEMORY, VOLATILE, AND NOT A PRODUCTION GATE — the name is the documentation
 * because the name is what shows up at every call site.
 *
 * Use it for `next dev` and for tests, where a Map is exactly right: no
 * migration, no connection string, and the whole entitlement layer is
 * exercisable end to end before anyone picks a database.
 *
 * Do not use it to answer "is the importer gated?" — it is not. It counts
 * correctly and forgets completely. Every response it touches carries
 * VOLATILE_LEDGER_WARNING, and the constructor logs it once per process, so the
 * shortfall is impossible to miss and impossible to ship past by accident.
 *
 * The arithmetic itself is not reimplemented here: it delegates to
 * MemoryEntitlementStore in lib/entitlement.ts, which is the same ledger logic
 * decideImport is written against. Two copies of a ledger is how two modules end
 * up disagreeing about what someone has spent.
 */
export class VolatileMemoryEntitlementStore_NOT_A_PRODUCTION_GATE
  implements EntitlementStoreAdapter
{
  readonly backend = "memory-volatile";
  readonly durable = false;

  private readonly inner: MemoryEntitlementStore;
  private static announced = false;

  constructor(concurrencyLimit: number = MAX_CONCURRENT_IMPORTS) {
    this.inner = new MemoryEntitlementStore(concurrencyLimit);
    if (!VolatileMemoryEntitlementStore_NOT_A_PRODUCTION_GATE.announced) {
      VolatileMemoryEntitlementStore_NOT_A_PRODUCTION_GATE.announced = true;
      // Once per process, at warn level, naming the demo size so the log line
      // is legible without this file open.
      console.warn(
        `[entitlement] ${VOLATILE_LEDGER_WARNING} (demo = ${DEMO_IMPORTS} imports per visitor)`,
      );
    }
  }

  health(): LedgerHealth {
    return {
      backend: this.backend,
      durable: false,
      survivesColdStart: false,
      enforcing: false,
      warning: VOLATILE_LEDGER_WARNING,
    };
  }

  /**
   * IP only. The identity must not come from anything the caller can set: a
   * subject key a visitor chooses is a button labelled "new demo". IP is a weak
   * key — CGNAT shares one, a VPN rotates through many — and it is still the
   * strongest key available on a deployment with no accounts.
   */
  subjectFor(req: RequestLike): Subject {
    return this.inner.subjectFor(req);
  }

  readLedger(subject: Subject, window: LedgerQuery): Promise<LedgerSnapshot> {
    return this.inner.readLedger(subject, window);
  }

  inFlightFor(subject: Subject): Promise<number> {
    return this.inner.inFlightFor(subject);
  }

  commitSpend(subject: Subject, charge: Charge): Promise<LedgerSnapshot> {
    return this.inner.commitSpend(subject, charge);
  }

  settle(subject: Subject, charge: Charge, settlement: Settlement): Promise<LedgerSnapshot> {
    return this.inner.settle(subject, charge, settlement);
  }

  /** Tests only. */
  reset(): void {
    this.inner.reset();
  }
}

/* ========================================================================== *
 * 3. THE ADAPTER SEAM
 * ========================================================================== */

type StoreFactory = () => EntitlementStoreAdapter;

let registered: StoreFactory | null = null;
let instance: EntitlementStoreAdapter | null = null;

/**
 * Point the whole app at a different ledger. This is the entire cost of moving
 * to KV, Redis, or a test double — no route, no component and nothing in
 * lib/entitlement.ts changes.
 *
 *   registerEntitlementStore(() => new MyStore());
 *
 * Neon needs no such call: chooseEntitlementBackend() already selects it
 * whenever DATABASE_URL is configured, so the durable gate is the default
 * rather than something a deployment has to remember to switch on. Registering
 * OVERRIDES that selection, which is what tests want and what a deployment
 * almost never does.
 *
 * Register before the first getEntitlementStore() call; registering afterwards
 * replaces the cached instance, which is fine at startup and a bug mid-request.
 */
export function registerEntitlementStore(factory: StoreFactory): void {
  registered = factory;
  instance = null;
}

/**
 * Which backend this environment gets, and why — separated from
 * getEntitlementStore() so a deploy check, a health endpoint or a test can ask
 * the question without constructing anything or caching an answer.
 *
 * The rule is one line: a configured DATABASE_URL means the durable ledger.
 * There is no opt-in flag, because an enforcement mechanism that has to be
 * remembered is an enforcement mechanism that gets forgotten.
 */
export interface EntitlementBackendChoice {
  backend: "neon-postgres" | "memory-volatile";
  durable: boolean;
  reason: string;
  /** True when falling back to the Map somewhere that looks like a real
   *  deployment — the case that gets shouted about. */
  unexpected: boolean;
}

/** Vercel sets VERCEL=1 on every deployment, including previews. Together with
 *  NODE_ENV this is how the fallback tells "a laptop with no env file" (fine,
 *  expected) from "a deployment that has silently stopped enforcing" (not). */
function looksDeployed(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VERCEL) || env.NODE_ENV === "production";
}

export function chooseEntitlementBackend(
  env: NodeJS.ProcessEnv = process.env,
): EntitlementBackendChoice {
  const url = env.DATABASE_URL;
  if (url && url.trim() !== "") {
    return {
      backend: "neon-postgres",
      durable: true,
      reason: "DATABASE_URL is set, so import counts go to the entitlement_ledger table.",
      unexpected: false,
    };
  }
  return {
    backend: "memory-volatile",
    durable: false,
    reason:
      "DATABASE_URL is not set, so there is nowhere durable to count imports and the ledger " +
      "falls back to a per-process Map.",
    unexpected: looksDeployed(env),
  };
}

/** The banner the fallback prints. Exported so a deploy check and a health
 *  endpoint can say the same words this file logs. */
export const ENTITLEMENT_FALLBACK_WARNING =
  "NO DURABLE ENTITLEMENT LEDGER — THE IMPORT DEMO IS NOT BEING ENFORCED. DATABASE_URL is not " +
  "set, so import counts fall back to a per-process Map that a cold start, a redeploy or a " +
  "second serverless instance wipes. Set DATABASE_URL to the Neon POOLED connection string and " +
  "apply db/migrations/0002_entitlement_ledger.sql (node db/migrate.mjs); no code change is " +
  "needed, the store is selected automatically.";

let announcedFallback = false;

function announceFallback(choice: EntitlementBackendChoice): void {
  if (announcedFallback) return;
  announcedFallback = true;
  const line = `[entitlement] ${ENTITLEMENT_FALLBACK_WARNING} (demo = ${DEMO_IMPORTS} imports per visitor)`;
  // Error level, not warn, when this happens on something that looks like a
  // deployment: on a laptop it is expected and a warning is enough, but in
  // production it means real vision-API spend has no ceiling, and that belongs
  // wherever the errors go rather than in a stream nobody reads.
  if (choice.unexpected) console.error(line);
  else console.warn(line);
}

/**
 * The store for this process: the durable Neon ledger when a database is
 * configured, the volatile Map otherwise.
 *
 * The fallback is never silent. It logs the banner above, and the store it
 * returns says so in its name and in the `ledger` block of every API response
 * it touches — because a deployment that quietly stops enforcing is the failure
 * this whole design exists to prevent.
 */
export function getEntitlementStore(): EntitlementStoreAdapter {
  if (instance) return instance;
  if (registered) {
    instance = registered();
    return instance;
  }

  const choice = chooseEntitlementBackend();
  if (choice.backend === "neon-postgres") {
    // Construction does not connect — getSql() in lib/db.ts is lazy — so this
    // cannot throw for a missing or malformed URL. The catch is for the
    // genuinely unexpected, and it degrades to the volatile store rather than
    // taking the whole app down with it; the store it degrades to is the one
    // that shouts about itself.
    try {
      instance = new NeonEntitlementStore();
      return instance;
    } catch (err) {
      console.error(
        "[entitlement] could not construct the durable ledger; falling back to the volatile one",
        err,
      );
    }
  }

  announceFallback(choice);
  instance = new VolatileMemoryEntitlementStore_NOT_A_PRODUCTION_GATE();
  return instance;
}

/** Tests only: drop the cached instance and any registration. */
export function resetEntitlementStore(): void {
  registered = null;
  instance = null;
}

/**
 * Whether a refusal from the current store means anything. Use it for a deploy
 * check or an admin banner — never to decide whether to run the gate. The gate
 * runs regardless: an unenforced gate still shapes the UI, still exercises the
 * code path, and still catches the 11th import of a warm instance.
 *
 * TWO THINGS THIS IS NOT. Nothing in this repository calls it today — it is an
 * offer to a deploy check or an admin banner that has not been written, not a
 * thing the app does. And on the durable store it is a snapshot of ledger calls
 * ALREADY MADE: asked on a fresh instance that has not touched the ledger yet
 * it answers true from the optimistic default, which is why guardImport() and
 * importQuota() read health() after their own ledger calls instead of calling
 * this. Treat a true from here as "no failure has been observed on this
 * instance", not as "the database answered just now".
 */
export function isDemoEnforced(store: EntitlementStoreAdapter = getEntitlementStore()): boolean {
  return store.health().enforcing;
}

/* ========================================================================== *
 * 4. THE SEQUENCE ROUTES CALL
 * ========================================================================== */

/** Deny body plus the store's own account of itself. */
export interface ImportDenyBody extends DenyBody {
  ledger: LedgerHealth;
}

export interface ImportGuardAllow {
  allow: true;
  subject: Subject;
  charge: Charge;
  /** Demo units left AFTER this import. */
  remaining: number;
  limit: number;
  /** POSITIVE_INFINITY for the demo — it does not reset. */
  resetsAt: number;
  ledger: LedgerHealth;
  /**
   * Release the concurrency slot and refund whatever the outcome earns back.
   * MUST be called on every exit path including the 20s abort: a leaked slot is
   * a visitor who cannot import again until the process restarts.
   *
   * Never throws, and is idempotent — calling it twice is a no-op, so a `catch`
   * arm that settles after a `try` arm already did cannot double-refund.
   */
  settle(outcome: ImportOutcome): Promise<void>;
}

export interface ImportGuardDeny {
  allow: false;
  deny: Deny;
  status: number;
  headers: Record<string, string>;
  body: ImportDenyBody;
  ledger: LedgerHealth;
}

export type ImportGuard = ImportGuardAllow | ImportGuardDeny;

export interface GuardImportOptions {
  /** Images in this request. The dialog posts one per request. Default 1. */
  batchSize?: number;
  /** Default: Boolean(process.env.OPENROUTER_API_KEY). */
  configured?: boolean;
  /** Default "anonymous" — there is no sign-in on this deployment. */
  plan?: PlanState;
  periodStart?: number | null;
  /** Injectable clock, for tests. */
  now?: number;
  /** Injectable store, for tests. */
  store?: EntitlementStoreAdapter;
}

/** The deny used whenever the ledger itself is the problem. */
function storeUnavailableDeny(): Deny {
  return {
    allow: false,
    reason: "store_unavailable",
    // Short enough that a blip self-heals from the client's own retry, long
    // enough not to hammer a database that is already unhappy.
    retryAfterSec: 30,
  };
}

function asDeny(deny: Deny, ledger: LedgerHealth): ImportGuardDeny {
  return {
    allow: false,
    deny,
    status: statusForDeny(deny),
    headers: denyHeaders(deny),
    body: { ...denyBody(deny), ledger },
    ledger,
  };
}

/**
 * The whole check, in the order lib/entitlement.ts's header specifies, with the
 * fail-closed error handling already in it:
 *
 *   subjectFor -> readLedger -> inFlightFor -> decideImport -> commitSpend
 *                                                          -> (your work)
 *                                                          -> settle
 *
 * Call it BEFORE reading the body, validating the image, or touching
 * openrouter.ai — the point of the gate is that the expensive part never starts.
 * Everything before commitSpend is free; commitSpend is the last thing that
 * happens before money can be spent.
 *
 * WHY health() IS NOT READ ONCE AT THE TOP. It used to be, and that made the
 * body of an outage 503 say `enforcing: true, warning: null` — the response
 * asserting the gate was measuring this visitor was the same response saying
 * nothing could be measured. A store learns it is degraded BY the call that
 * fails, so health read before the ledger is touched is the health of a store
 * that has not touched the ledger yet: on a fresh instance that is the
 * optimistic default. It was never "only the first request", either — on Vercel
 * every cold start, scale-out and redeploy produces another fresh instance
 * whose first answer is that one, so how many of an outage's 503s carried the
 * false flag was set by how often the platform made new instances, which is
 * nothing this code can bound. Every health() below is therefore read AFTER the
 * calls it is describing. Do not hoist it back into a local.
 */
export async function guardImport(
  req: RequestLike,
  opts: GuardImportOptions = {},
): Promise<ImportGuard> {
  const store = opts.store ?? getEntitlementStore();
  const now = opts.now ?? Date.now();
  const batchSize = opts.batchSize ?? 1;
  const plan: PlanState = opts.plan ?? "anonymous";
  const periodStart = opts.periodStart ?? null;
  const configured = opts.configured ?? Boolean(process.env.OPENROUTER_API_KEY);

  let subject: Subject;
  let ledger: LedgerSnapshot;
  let inFlight: number;
  try {
    subject = store.subjectFor(req);
    ledger = await store.readLedger(subject, { now, periodStart });
    inFlight = await store.inFlightFor(subject);
  } catch (err) {
    // DENY. Not "assume they have spent nothing" — see the file header.
    console.error("[entitlement] ledger read failed; refusing the import", err);
    // health() AFTER the failure: the failure is what makes it false.
    return asDeny(storeUnavailableDeny(), store.health());
  }

  const ctx: ImportContext = { subject, plan, periodStart, ledger, batchSize, inFlight, configured };
  const decision = decideImport(ctx, now);
  // The reads above succeeded, so this health() is backed by two ledger calls
  // this request actually made — which is also how a store that failed earlier
  // and has since recovered stops reporting the old outage.
  if (!decision.allow) return asDeny(decision, store.health());

  try {
    await store.commitSpend(subject, decision.charge);
  } catch (err) {
    // A race the advisory read could not see — the store's atomic check is the
    // authority, and it speaks the same vocabulary, so this is one code path.
    if (err instanceof EntitlementDenied) return asDeny(err.deny, store.health());
    console.error("[entitlement] commitSpend failed; refusing the import", err);
    return asDeny(storeUnavailableDeny(), store.health());
  }

  let settled = false;
  const settle = async (outcome: ImportOutcome): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await store.settle(subject, decision.charge, settleImport(decision.charge, outcome));
    } catch (err) {
      // Deliberately swallowed: the import itself may have succeeded, and
      // throwing here would turn a bookkeeping failure into a 500 for a user
      // who got their data. The damage is bounded and stated — a leaked
      // concurrency slot and a unit that stays spent, which errs toward
      // charging for a call we may not have delivered rather than toward
      // handing out free capacity.
      console.error(
        `[entitlement] settle failed for ${subjectKey(subject)} — ` +
          `${decision.charge.units} unit(s) stay spent and a concurrency slot is leaked`,
        err,
      );
    }
  };

  return {
    allow: true,
    subject,
    charge: decision.charge,
    remaining: decision.remaining,
    limit: decision.limit,
    resetsAt: decision.resetsAt,
    // Read last, after commitSpend: the allow is being reported by a store that
    // has just written this visitor's spend, so `enforcing` here is a statement
    // about calls that happened, not about calls that might.
    ledger: store.health(),
    settle,
  };
}

/* ========================================================================== *
 * 5. THE COUNTER THE DIALOG SHOWS BEFORE ANYONE SPENDS ANYTHING
 * ========================================================================== */

export interface ImportQuotaReport {
  /** Null when the ledger could not be read — show nothing rather than a
   *  number that is not backed by anything. */
  quota: QuotaSummary | null;
  ledger: LedgerHealth;
  /** Where an exhausted visitor goes. NOT a checkout — see INTEREST_FORM_PATH. */
  interestPath: string;
  /** Present exactly when `quota` is null. */
  error?: ImportDenyBody;
}

/**
 * Answers GET /api/import/quota. Same resolution logic as the refusal, with
 * nothing charged, so the number in the dialog header and the number in the
 * refusal cannot disagree.
 *
 * Fails closed in its own way: a ledger it cannot read produces no counter at
 * all. "10 left" from a ledger nobody could read is worse than no number.
 *
 * health() is read after the ledger calls here for the same reason as in
 * guardImport: a `quota: null` carrying `enforcing: true` would claim the gate
 * was measuring the visitor it had just failed to measure.
 */
export async function importQuota(
  req: RequestLike,
  opts: Omit<GuardImportOptions, "batchSize"> = {},
): Promise<ImportQuotaReport> {
  const store = opts.store ?? getEntitlementStore();
  const now = opts.now ?? Date.now();
  const plan: PlanState = opts.plan ?? "anonymous";
  const periodStart = opts.periodStart ?? null;
  const configured = opts.configured ?? Boolean(process.env.OPENROUTER_API_KEY);

  try {
    const subject = store.subjectFor(req);
    const ledger = await store.readLedger(subject, { now, periodStart });
    const inFlight = await store.inFlightFor(subject);
    const ctx: ImportContext = {
      subject,
      plan,
      periodStart,
      ledger,
      batchSize: 1,
      inFlight,
      configured,
    };
    return {
      quota: quotaSummary(ctx, now),
      ledger: store.health(),
      interestPath: INTEREST_FORM_PATH,
    };
  } catch (err) {
    console.error("[entitlement] quota read failed", err);
    const deny = storeUnavailableDeny();
    const ledgerHealth = store.health();
    return {
      quota: null,
      ledger: ledgerHealth,
      interestPath: INTEREST_FORM_PATH,
      // One read, used twice, so the two copies in this body cannot disagree
      // with each other about the same instant.
      error: { ...denyBody(deny), ledger: ledgerHealth },
    };
  }
}
