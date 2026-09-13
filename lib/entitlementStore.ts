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
 * THERE IS NO DATASTORE. No DATABASE_URL, no KV, no Redis, no .env. That is not
 * something to pretend away, so it is stated three times over: in the name of
 * the class below, in its doc comment, and in `health()`, which rides along in
 * every response the API sends — allow and deny alike. A reader who never opens
 * this file still learns it from the JSON.
 *
 * WHAT THAT MEANS ON VERCEL, PLAINLY. Counts live in one Node process's Map. A
 * serverless function is cold-started, recycled and scaled horizontally at the
 * platform's discretion, and none of those instances share a Map. So on Vercel
 * today the demo is NOT enforced: a visitor who waits for a cold start, or who
 * simply lands on a different instance, starts again at zero used. The gate is
 * correct, complete, and tested — it is not yet load-bearing, and it cannot be
 * until getEntitlementStore() returns something durable.
 *
 * THE SEAM. Routes never name an implementation; they call getEntitlementStore()
 * or, better, guardImport(). A Neon or KV implementation is a class that
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

/* ========================================================================== *
 * 1. WHAT A STORE MUST SAY ABOUT ITSELF
 * ========================================================================== */

/**
 * A store's own account of whether it is really enforcing anything. This is
 * returned to the API on every path so that "the demo is not actually gated in
 * production" is a fact in the response body, not a discovery someone makes six
 * weeks later while reading lib/.
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
 * to Neon or KV — no route, no component and nothing in lib/entitlement.ts
 * changes.
 *
 *   // lib/entitlementStore.neon.ts
 *   export class NeonEntitlementStore implements EntitlementStoreAdapter { ... }
 *
 *   // instrumentation.ts, or the top of the route module
 *   registerEntitlementStore(() => new NeonEntitlementStore(process.env.DATABASE_URL!));
 *
 * Register before the first getEntitlementStore() call; registering afterwards
 * replaces the cached instance, which is fine at startup and a bug mid-request.
 */
export function registerEntitlementStore(factory: StoreFactory): void {
  registered = factory;
  instance = null;
}

/**
 * The store for this process. Falls back to the volatile in-memory one, which
 * says so in its name and in every response it touches — a silent fallback to a
 * store that does not gate would be the worst possible default.
 */
export function getEntitlementStore(): EntitlementStoreAdapter {
  if (!instance) {
    instance = registered
      ? registered()
      : new VolatileMemoryEntitlementStore_NOT_A_PRODUCTION_GATE();
  }
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
 */
export async function guardImport(
  req: RequestLike,
  opts: GuardImportOptions = {},
): Promise<ImportGuard> {
  const store = opts.store ?? getEntitlementStore();
  const ledgerHealth = store.health();
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
    return asDeny(storeUnavailableDeny(), ledgerHealth);
  }

  const ctx: ImportContext = { subject, plan, periodStart, ledger, batchSize, inFlight, configured };
  const decision = decideImport(ctx, now);
  if (!decision.allow) return asDeny(decision, ledgerHealth);

  try {
    await store.commitSpend(subject, decision.charge);
  } catch (err) {
    // A race the advisory read could not see — the store's atomic check is the
    // authority, and it speaks the same vocabulary, so this is one code path.
    if (err instanceof EntitlementDenied) return asDeny(err.deny, ledgerHealth);
    console.error("[entitlement] commitSpend failed; refusing the import", err);
    return asDeny(storeUnavailableDeny(), ledgerHealth);
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
    ledger: ledgerHealth,
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
 */
export async function importQuota(
  req: RequestLike,
  opts: Omit<GuardImportOptions, "batchSize"> = {},
): Promise<ImportQuotaReport> {
  const store = opts.store ?? getEntitlementStore();
  const ledgerHealth = store.health();
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
      ledger: ledgerHealth,
      interestPath: INTEREST_FORM_PATH,
    };
  } catch (err) {
    console.error("[entitlement] quota read failed", err);
    const deny = storeUnavailableDeny();
    return {
      quota: null,
      ledger: ledgerHealth,
      interestPath: INTEREST_FORM_PATH,
      error: { ...denyBody(deny), ledger: ledgerHealth },
    };
  }
}
