/**
 * The durable import-demo ledger: an EntitlementStoreAdapter backed by Neon
 * Postgres.
 *
 * WHAT THIS FIXES
 * ---------------
 * lib/entitlementStore.ts shipped exactly one implementation of the ledger:
 * VolatileMemoryEntitlementStore_NOT_A_PRODUCTION_GATE, whose counts live in
 * one Node process's Map. On Vercel a function is cold-started, recycled and
 * scaled horizontally at the platform's discretion, and none of those instances
 * share a Map, so a visitor who landed on a different instance started again at
 * zero used. The DEMO_IMPORTS = 10 ceiling was correct and complete — and
 * (this file said "tested"; there is no test suite in this repo, and 800 lines
 * below it says so itself)
 * not load-bearing. This class is what makes it load-bearing. Nothing else
 * changes: the seam (`EntitlementStoreAdapter`, `registerEntitlementStore`) was
 * already built for this, so no route, no component and nothing in
 * lib/entitlement.ts is touched.
 *
 * THERE IS ONE LEDGER ARITHMETIC, AND IT IS NOT IN THIS FILE
 * ---------------------------------------------------------
 * The rules for rolling a window over, for replacing a stale bucket rather than
 * incrementing it, and for which buckets a charge touches are all in
 * MemoryEntitlementStore in lib/entitlement.ts, next to the decideImport() that
 * reads them. Copying that loop into SQL CASE expressions — or into TypeScript
 * here — creates two ledgers that will eventually disagree about what somebody
 * spent, and the disagreement is invisible: both sides still return 200s.
 *
 * So this file computes NOTHING about windows. `ledgerAfter()` below builds a
 * throwaway MemoryEntitlementStore, replays the row it just read into it, and
 * asks it what the ledger becomes. Postgres stores and serialises; lib/
 * entitlement.ts decides and computes. (The two things this store does own are
 * the compare-and-swap, and the reservation LEASE — see RESERVATION_LEASE_MS —
 * because neither has any counterpart in a Map that dies with its process.)
 *
 * CONCURRENCY: COMPARE-AND-SWAP ON "rev", NOT A READ FOLLOWED BY A WRITE
 * ---------------------------------------------------------------------
 * components/ImportDialog.tsx fires three lanes at once. The cheap
 * implementation — SELECT the row, compute, UPDATE it — loses that race every
 * time, and the way it loses is by granting over the ceiling: two requests both
 * read lifetime = 9, both decide "one left", both write 10, and eleven imports
 * happen against a demo of ten. That is a lost update, and it is not rare under
 * three parallel lanes; it is the normal case.
 *
 * Every write here is therefore conditional: `... on conflict do update set ...
 * where "entitlement_ledger"."rev" = <the rev I read>`. Exactly one concurrent
 * writer matches; the others match zero rows, re-read, and RE-DECIDE against
 * what actually landed — which is why the loser of the race for the tenth
 * import comes back denied rather than being handed the eleventh. It is the
 * same mechanism "profile" already uses in 0001_init.sql for the same reason.
 *
 * Why not the alternatives:
 *   - SELECT ... FOR UPDATE inside a transaction would also be correct, but the
 *     runtime driver is @neondatabase/serverless over HTTP (lib/db.ts), which
 *     sends one statement per request and cannot hold an interactive
 *     transaction open across a round trip. It would mean a WebSocket pool for
 *     this one table.
 *   - A bare atomic increment (`set "lifetimeUnits" = "lifetimeUnits" + 1
 *     where "lifetimeUnits" < 10`) is the cheapest safe option and does not fit:
 *     a charge touches four or five buckets at once, three of which must be
 *     RESET rather than incremented when their window has aged out, and the
 *     ceiling that applies depends on the plan. Expressing that in SQL is the
 *     second ledger arithmetic this file exists to avoid.
 *
 * FAIL CLOSED
 * -----------
 * Every method here rejects on any database failure and never substitutes an
 * empty ledger. guardImport() turns that into a `store_unavailable` deny and a
 * 503. "We cannot read the ledger" silently becoming "they have spent nothing"
 * is an unlimited demo spending real vision-API tokens for the length of the
 * outage — which is the one thing this whole layer exists to prevent.
 *
 * SECRETS. Nothing in this file reads, logs, formats or stores a connection
 * string. The client comes from getSql() in lib/db.ts, which owns that
 * validation; the failure warnings below name a CATEGORY and a time, never a
 * driver message, because a driver message can carry a host.
 *
 * PRIVACY, STATED RATHER THAN SOLVED. Subject keys are "ip:<address>" on this
 * deployment, so this table holds raw client IPs indefinitely — that is new,
 * and it is the cost of a demo count that survives a cold start. Hashing them
 * is not the obvious improvement it looks like: an unsalted hash of an IPv4
 * address is reversible by brute force in seconds (2^32 inputs), and a salted
 * one makes the salt load-bearing — rotate or lose it and every visitor in the
 * world gets a fresh demo, silently. If this should be anonymised, it wants a
 * deliberate retention policy, not a one-line hash.
 */

import {
  EntitlementDenied,
  MAX_CONCURRENT_IMPORTS,
  MemoryEntitlementStore,
  decideImport,
  emptyLedger,
  rolledOver,
  subjectKey,
  type Charge,
  type ImportContext,
  type LedgerQuery,
  type LedgerSnapshot,
  type PlanState,
  type Provenance,
  type RequestLike,
  type Settlement,
  type Subject,
  type WindowKind,
} from "./entitlement";
import { DatabaseNotConfiguredError, getSql } from "./db";
import type { EntitlementStoreAdapter, LedgerHealth } from "./entitlementStore";

/* ========================================================================== *
 * 1. NAMES AND NUMBERS
 * ========================================================================== */

export const ENTITLEMENT_LEDGER_TABLE = "entitlement_ledger";

/** The migration that creates it. Named in the degraded-health warning so the
 *  remedy for the commonest deployment mistake is in the error, not in a wiki. */
export const ENTITLEMENT_LEDGER_MIGRATION = "db/migrations/0002_entitlement_ledger.sql";

export const NEON_ENTITLEMENT_BACKEND = "neon-postgres";

/**
 * How long a concurrency reservation stays valid without being settled.
 *
 * WHY THIS EXISTS AT ALL. In the Map implementation a process that died
 * mid-import forgot its reservations for free. A row in Postgres does not: a
 * subject whose three lanes were killed by a platform timeout would hold three
 * slots forever and could never import again. So a reservation is a LEASE, and
 * a lease that has expired counts as zero.
 *
 * SOURCED: `export const maxDuration = 60` at app/api/import/route.ts:42 — the
 * platform terminates the invocation at 60 seconds, so a reservation older than
 * that provably cannot still be running. Copied rather than imported because
 * importing a Next route module into lib/ would drag the route's whole module
 * graph in behind it; this is the same treatment CHARACTER_EQUIP_SLOTS gets in
 * lib/entitlement.ts, for the same reason. No margin is added on purpose: every
 * millisecond of margin is a millisecond a crashed lane stays leaked, and the
 * platform's own guarantee needs no padding.
 */
export const RESERVATION_LEASE_MS = 60_000;

/**
 * How many times a write re-reads and retries after losing the compare-and-swap.
 *
 * DERIVED, not picked: at most MAX_CONCURRENT_IMPORTS commits and
 * MAX_CONCURRENT_IMPORTS settles can contend for one subject's row at the same
 * moment (a settle for an earlier lane overlaps a commit for a later one), and
 * each CAS round retires exactly one writer, so a writer loses at most
 * (contenders - 1) rounds before it wins or is denied. Running out is therefore
 * not "busy", it is "something is wrong", and it fails closed: the caller sees a
 * rejection, which guardImport turns into a 503.
 */
export const CAS_MAX_ATTEMPTS = 2 * MAX_CONCURRENT_IMPORTS;

/**
 * The concurrency ceiling handed to the throwaway MemoryEntitlementStore used
 * as a calculator in ledgerAfter(). Effectively unlimited, deliberately: that
 * instance is arithmetic, not a gate. The real concurrency ceiling for this
 * store is enforced in Postgres, where it is actually shared between the
 * serverless instances that need to agree on it.
 */
const CALCULATOR_CONCURRENCY_LIMIT = Number.MAX_SAFE_INTEGER;

export const ENTITLEMENT_LEDGER_PROVENANCE: Readonly<
  Record<string, { how: Provenance; note: string }>
> = Object.freeze({
  RESERVATION_LEASE_MS: {
    how: "sourced",
    note: "app/api/import/route.ts:42 `export const maxDuration = 60`. The platform kills the invocation at 60s, so a reservation older than that cannot be live.",
  },
  CAS_MAX_ATTEMPTS: {
    how: "derived",
    note: "2 x MAX_CONCURRENT_IMPORTS: commits and settles for the same subject are the only contenders, and each CAS round retires one of them.",
  },
  ENTITLEMENT_LEDGER_TABLE: {
    how: "sourced",
    note: "db/migrations/0002_entitlement_ledger.sql. The column layout mirrors LedgerSnapshot in lib/entitlement.ts field for field.",
  },
});

/* ========================================================================== *
 * 2. THE ROW, AND TURNING IT INTO A LedgerSnapshot
 * ========================================================================== */

/** The minimum of the driver this store needs. Narrower than
 *  NeonQueryFunction so a test can drive it, and satisfied by the real client
 *  from lib/db.ts getSql(). */
export interface EntitlementLedgerSql {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

const LEDGER_COLUMNS =
  `"subjectKey", "subjectKind", "subjectId", "rev", "inFlight", "inFlightExpiresAt",` +
  ` "minuteStartedAt", "minuteUnits", "hourStartedAt", "hourUnits",` +
  ` "dayStartedAt", "dayUnits", "periodStartedAt", "periodUnits",` +
  ` "lifetimeStartedAt", "lifetimeUnits"`;

const SELECT_ROW = `select ${LEDGER_COLUMNS} from "${ENTITLEMENT_LEDGER_TABLE}" where "subjectKey" = $1`;

/**
 * ONE statement, and it is the whole concurrency story.
 *
 * The INSERT arm runs when this subject has no row yet; the ON CONFLICT arm
 * runs when it does, and its WHERE is the compare-and-swap. `$16` is the rev the
 * caller read. A caller that believes there is no row passes 0, which matches no
 * existing row (rev starts at 1) and so cannot overwrite one that appeared in
 * the meantime. Either way, zero rows returned means "you lost, re-read".
 */
const UPSERT_ROW =
  `insert into "${ENTITLEMENT_LEDGER_TABLE}" (` +
  `"subjectKey", "subjectKind", "subjectId",` +
  ` "minuteStartedAt", "minuteUnits", "hourStartedAt", "hourUnits",` +
  ` "dayStartedAt", "dayUnits", "periodStartedAt", "periodUnits",` +
  ` "lifetimeStartedAt", "lifetimeUnits", "inFlight", "inFlightExpiresAt", "rev")` +
  ` values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1)` +
  ` on conflict ("subjectKey") do update set` +
  `   "minuteStartedAt" = excluded."minuteStartedAt",` +
  `   "minuteUnits" = excluded."minuteUnits",` +
  `   "hourStartedAt" = excluded."hourStartedAt",` +
  `   "hourUnits" = excluded."hourUnits",` +
  `   "dayStartedAt" = excluded."dayStartedAt",` +
  `   "dayUnits" = excluded."dayUnits",` +
  `   "periodStartedAt" = excluded."periodStartedAt",` +
  `   "periodUnits" = excluded."periodUnits",` +
  `   "lifetimeStartedAt" = excluded."lifetimeStartedAt",` +
  `   "lifetimeUnits" = excluded."lifetimeUnits",` +
  `   "inFlight" = excluded."inFlight",` +
  `   "inFlightExpiresAt" = excluded."inFlightExpiresAt",` +
  `   "rev" = "${ENTITLEMENT_LEDGER_TABLE}"."rev" + 1,` +
  `   "updatedAt" = now()` +
  ` where "${ENTITLEMENT_LEDGER_TABLE}"."rev" = $16::int` +
  ` returning ${LEDGER_COLUMNS}`;

interface LedgerRow {
  subjectKey: unknown;
  subjectKind: unknown;
  subjectId: unknown;
  rev: unknown;
  inFlight: unknown;
  inFlightExpiresAt: unknown;
  minuteStartedAt: unknown;
  minuteUnits: unknown;
  hourStartedAt: unknown;
  hourUnits: unknown;
  dayStartedAt: unknown;
  dayUnits: unknown;
  periodStartedAt: unknown;
  periodUnits: unknown;
  lifetimeStartedAt: unknown;
  lifetimeUnits: unknown;
}

/**
 * bigint comes back from the driver as a STRING (Postgres int8 has no lossless
 * JSON number), so every numeric column is coerced here rather than trusted.
 *
 * It THROWS on anything it cannot read as a finite number instead of falling
 * back to 0. A 0 here is "this visitor has spent nothing", which is the exact
 * fail-open this store exists to refuse; a throw becomes a 503 and refuses the
 * import instead.
 */
function toNum(v: unknown, column: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(
    `${ENTITLEMENT_LEDGER_TABLE}."${column}" did not come back as a number ` +
      `(got ${typeof v}). Refusing to guess what it was.`,
  );
}

function rowToLedger(r: LedgerRow): LedgerSnapshot {
  return {
    minute: { startedAt: toNum(r.minuteStartedAt, "minuteStartedAt"), units: toNum(r.minuteUnits, "minuteUnits") },
    hour: { startedAt: toNum(r.hourStartedAt, "hourStartedAt"), units: toNum(r.hourUnits, "hourUnits") },
    day: { startedAt: toNum(r.dayStartedAt, "dayStartedAt"), units: toNum(r.dayUnits, "dayUnits") },
    period: { startedAt: toNum(r.periodStartedAt, "periodStartedAt"), units: toNum(r.periodUnits, "periodUnits") },
    lifetime: {
      startedAt: toNum(r.lifetimeStartedAt, "lifetimeStartedAt"),
      units: toNum(r.lifetimeUnits, "lifetimeUnits"),
    },
  };
}

/** The ten ledger columns as bind parameters, in the order UPSERT_ROW wants.
 *  Truncated to integers because the columns are integral: every value here is
 *  already a whole millisecond or a whole unit, and sending "1.5" to a bigint
 *  column fails the statement rather than the value. */
function ledgerParams(l: LedgerSnapshot): number[] {
  return [
    Math.trunc(l.minute.startedAt),
    Math.trunc(l.minute.units),
    Math.trunc(l.hour.startedAt),
    Math.trunc(l.hour.units),
    Math.trunc(l.day.startedAt),
    Math.trunc(l.day.units),
    Math.trunc(l.period.startedAt),
    Math.trunc(l.period.units),
    Math.trunc(l.lifetime.startedAt),
    Math.trunc(l.lifetime.units),
  ];
}

/* ========================================================================== *
 * 3. THE ARITHMETIC, BORROWED RATHER THAN REWRITTEN
 * ========================================================================== */

const ALL_WINDOWS: readonly WindowKind[] = Object.freeze([
  "minute",
  "hour",
  "day",
  "period",
  "lifetime",
]);

/**
 * What the ledger becomes after `charge` (or after settling it) — computed by
 * MemoryEntitlementStore, the one implementation of these rules.
 *
 * HOW IT IS BORROWED. MemoryEntitlementStore keeps its state in a private Map
 * with no seeding API, and lib/entitlement.ts is not this builder's file to add
 * one to. But its own commitSpend already has a "this window is empty, open it
 * at this instant with this many units" branch, so a window can be restored
 * exactly by charging it with `issuedAt` set to its startedAt. That is what the
 * loop below does: replay the row into a throwaway calculator, then ask the
 * calculator the real question.
 *
 * WHY NOT JUST COPY THE FIFTEEN-LINE LOOP. Because the loop is not the whole
 * rule — the staleness test differs per window kind, `lifetime` must never age
 * out, `period` compares against a billing anchor, and every one of those is a
 * silent failure when it drifts (the counter keeps rising against a row every
 * reader treats as stale, and the ceiling never bites again). A copy is correct
 * on the day it is written and unowned forever after.
 */
async function ledgerAfter(
  base: LedgerSnapshot,
  charge: Charge,
  settlement: Settlement | null,
): Promise<LedgerSnapshot> {
  const calculator = new MemoryEntitlementStore(CALCULATOR_CONCURRENCY_LIMIT);
  const subject = charge.subject;

  for (const w of ALL_WINDOWS) {
    const win = base[w];
    if (win.units <= 0) continue;
    await calculator.commitSpend(subject, {
      subject,
      units: win.units,
      windows: [w],
      estimatedUsd: null,
      issuedAt: win.startedAt,
      against: w,
      periodStart: charge.periodStart,
    });
  }

  return settlement === null
    ? calculator.commitSpend(subject, charge)
    : calculator.settle(subject, charge, settlement);
}

/**
 * The plan that produced a charge, read back off the window its quota was
 * checked against.
 *
 * WHY THIS IS NEEDED. commitSpend is handed a Charge, not an ImportContext, and
 * the authoritative re-check below re-runs decideImport() rather than
 * re-deriving anybody's ceiling — which needs a PlanState. `Charge.against` is
 * "the window the quota was checked against", and resolveQuotaProfile() gives
 * each profile exactly one governing window, so the mapping is an inverse, not
 * a guess: lifetime is the anonymous demo, day is the free bucket, period is
 * the paid one.
 *
 * `past_due` and `cancelled` also resolve to the free bucket, so they come back
 * here as "free" — the same ceiling, and correct for what this re-check is for.
 * Whether a plan is in dunning was already decided at guard time with the real
 * plan; this pass exists to catch races on the COUNT, which no plan changes.
 *
 * Any other window means Charge.against came from somewhere resolveQuotaProfile
 * did not produce, and the honest response to that is to refuse the spend rather
 * than measure it against a bucket picked by default.
 */
function planForGoverningWindow(against: WindowKind): PlanState {
  switch (against) {
    case "lifetime":
      return "anonymous";
    case "day":
      return "free";
    case "period":
      return "active";
    default:
      throw new Error(
        `Charge.against was "${against}", which no quota profile in lib/entitlement.ts governs. ` +
          `Refusing to re-check the spend against a bucket chosen by default.`,
      );
  }
}

/* ========================================================================== *
 * 4. FAILURE CATEGORIES
 * ========================================================================== */

/** Thrown when every compare-and-swap attempt lost. Not an EntitlementDenied:
 *  the caller did nothing wrong and nothing was decided, so it must surface as
 *  `store_unavailable` (503) and not as a quota refusal. */
export class EntitlementLedgerContentionError extends Error {
  constructor(op: string, attempts: number) {
    super(
      `${op} lost the compare-and-swap on "${ENTITLEMENT_LEDGER_TABLE}" ${attempts} times in a row. ` +
        `Refusing the import rather than writing from a stale read.`,
    );
    this.name = "EntitlementLedgerContentionError";
  }
}

/** Postgres `undefined_table`. The one failure worth naming separately, because
 *  it means the migration has not been applied and the remedy is one command. */
const PG_UNDEFINED_TABLE = "42P01";

type FailureKind = "not_configured" | "table_missing" | "query_failed";

function classifyFailure(err: unknown): FailureKind {
  if (err instanceof DatabaseNotConfiguredError) return "not_configured";
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (code === PG_UNDEFINED_TABLE) return "table_missing";
  }
  return "query_failed";
}

/**
 * The sentence health() puts in front of anyone holding the JSON while the
 * ledger is unhappy.
 *
 * It names a category and a time and NOTHING from the driver. A driver message
 * can carry the host it failed to reach, and this string is returned to the
 * public API on every response the guard touches.
 */
function degradedWarning(kind: FailureKind, at: number): string {
  const when = new Date(at).toISOString();
  const head =
    `ENTITLEMENT LEDGER DEGRADED at ${when}. Screenshot imports are being REFUSED (503) rather than ` +
    `run uncounted, so nothing is being over-granted — but the demo count is not being measured ` +
    `while this lasts, which is why enforcing is false.`;
  switch (kind) {
    case "not_configured":
      return `${head} Cause: DATABASE_URL is missing or unusable in this environment.`;
    case "table_missing":
      return `${head} Cause: "${ENTITLEMENT_LEDGER_TABLE}" does not exist — apply ${ENTITLEMENT_LEDGER_MIGRATION} with \`node db/migrate.mjs\`.`;
    case "query_failed":
      return `${head} Cause: the database rejected or could not serve the query. Details are in the server log, not here.`;
  }
}

/* ========================================================================== *
 * 5. THE STORE
 * ========================================================================== */

export interface NeonEntitlementStoreOptions {
  /** Defaults to MAX_CONCURRENT_IMPORTS, which is the client's own lane count.
   *  A ceiling above the client's protects nothing; one below it breaks the
   *  dialog's third lane for every honest user. */
  concurrencyLimit?: number;
  /** Injectable client. Defaults to the pooled one from lib/db.ts getSql(),
   *  which is also the only place that validates DATABASE_URL. */
  sql?: EntitlementLedgerSql;
  /** Injectable clock, for exercising reservation-lease expiry in tests. The
   *  ledger's own timestamps come from the Charge, not from here. */
  now?: () => number;
}

/**
 * Durable, shared, and fail-closed.
 *
 * Construction does NOT connect: getSql() is lazy, so importing or constructing
 * this on a machine with no env file cannot throw. The failure happens on the
 * first query instead, where it becomes a 503 rather than a broken build.
 */
export class NeonEntitlementStore implements EntitlementStoreAdapter {
  readonly backend = NEON_ENTITLEMENT_BACKEND;
  readonly durable = true;

  private readonly concurrencyLimit: number;
  private readonly clock: () => number;
  private readonly sqlFactory: () => EntitlementLedgerSql;
  private sql: EntitlementLedgerSql | null = null;

  /**
   * Used for subjectFor() ONLY, and it is not a fallback ledger — no count is
   * ever read from or written to it. subjectFor is pure (it parses
   * x-forwarded-for and refuses to trust a client-settable id header), and
   * borrowing it keeps the "a subject key a visitor can choose is a button
   * labelled new demo" rule in exactly one place.
   */
  private readonly identity = new MemoryEntitlementStore();

  private lastFailureAt: number | null = null;
  private lastFailureKind: FailureKind | null = null;
  private announcedMissingTable = false;

  constructor(opts: NeonEntitlementStoreOptions = {}) {
    this.concurrencyLimit = opts.concurrencyLimit ?? MAX_CONCURRENT_IMPORTS;
    this.clock = opts.now ?? Date.now;
    const injected = opts.sql;
    this.sqlFactory = injected ? () => injected : getSql;
  }

  /* ------------------------------------------------------------ health --- */

  /**
   * The truth about this backend, including when it is not currently able to
   * be one.
   *
   * `durable` and `survivesColdStart` are properties of Postgres and are
   * unconditionally true. `enforcing` is not: it starts true, goes false the
   * moment a ledger operation fails, and comes back on the next success.
   * "Enforcing" means "a refusal from this store can be trusted to mean
   * something about this visitor's usage", and during an outage nothing is
   * being measured at all — every import is refused, which is safe, but it is
   * not enforcement and must not be reported as it.
   *
   * EXACTLY WHAT `enforcing: true` IS BACKED BY, because this claim used to
   * outrun its evidence. It reports one thing: the last ledger call THIS
   * INSTANCE made succeeded. That is a measurement in every case but one — an
   * instance that has not made a ledger call yet, whose `true` is the
   * optimistic default and not an observation. So the flag CAN read true while
   * the database is down: on a cold instance, right up until its first query
   * fails. It is therefore only as good as when it is read, and the one rule
   * that keeps it honest is the caller's: read it AFTER the ledger calls whose
   * outcome the response is about, never before them. guardImport() and
   * importQuota() in lib/entitlementStore.ts do, which is what stopped an
   * outage 503 from carrying `enforcing: true, warning: null` — a body
   * asserting the gate was measuring the visitor it had just failed to measure.
   * Anything that reads health() without having touched the ledger (a banner,
   * a deploy check, isDemoEnforced() on a fresh instance) is reading that
   * assumption, not a measurement.
   */
  health(): LedgerHealth {
    if (this.lastFailureAt === null || this.lastFailureKind === null) {
      return {
        backend: this.backend,
        durable: true,
        survivesColdStart: true,
        enforcing: true,
        warning: null,
      };
    }
    return {
      backend: this.backend,
      durable: true,
      survivesColdStart: true,
      enforcing: false,
      warning: degradedWarning(this.lastFailureKind, this.lastFailureAt),
    };
  }

  /* --------------------------------------------------------- plumbing ---- */

  private async run(text: string, params: unknown[]): Promise<LedgerRow[]> {
    try {
      const sql = this.sql ?? (this.sql = this.sqlFactory());
      const rows = await sql.query(text, params);
      this.lastFailureAt = null;
      this.lastFailureKind = null;
      return rows as LedgerRow[];
    } catch (err) {
      const kind = classifyFailure(err);
      this.lastFailureAt = this.clock();
      this.lastFailureKind = kind;
      if (kind === "table_missing" && !this.announcedMissingTable) {
        this.announcedMissingTable = true;
        // Once per process, no error object: this is the silent deployment
        // mistake — the store is registered, the app looks healthy, and every
        // import 503s. The remedy is one command and belongs in the log.
        console.error(
          `[entitlement] "${ENTITLEMENT_LEDGER_TABLE}" does not exist. Apply ` +
            `${ENTITLEMENT_LEDGER_MIGRATION} (node db/migrate.mjs). Until then every ` +
            `screenshot import is refused with 503 store_unavailable.`,
        );
      }
      throw err;
    }
  }

  private async readRow(subject: Subject): Promise<LedgerRow | null> {
    const rows = await this.run(SELECT_ROW, [subjectKey(subject)]);
    return rows.length ? rows[0] : null;
  }

  /** Reservations whose lease has expired count as zero — see
   *  RESERVATION_LEASE_MS for why a durable slot must be able to rot. */
  private liveInFlight(row: LedgerRow): number {
    const expiresAt = toNum(row.inFlightExpiresAt, "inFlightExpiresAt");
    return this.clock() < expiresAt ? toNum(row.inFlight, "inFlight") : 0;
  }

  private async casWrite(
    subject: Subject,
    baseRev: number,
    ledger: LedgerSnapshot,
    inFlight: number,
    inFlightExpiresAt: number,
  ): Promise<LedgerRow | null> {
    const rows = await this.run(UPSERT_ROW, [
      subjectKey(subject),
      subject.kind,
      subject.id,
      ...ledgerParams(ledger),
      Math.trunc(inFlight),
      Math.trunc(inFlightExpiresAt),
      baseRev,
    ]);
    return rows.length ? rows[0] : null;
  }

  /* ------------------------------------------------------------ reads ---- */

  subjectFor(req: RequestLike): Subject {
    return this.identity.subjectFor(req);
  }

  /**
   * A row that is not there means this subject has genuinely never spent
   * anything — the query SUCCEEDED and said so. That is the only case where an
   * empty ledger is an answer rather than a guess; a query that fails throws,
   * and guardImport refuses the import.
   */
  async readLedger(subject: Subject, window: LedgerQuery): Promise<LedgerSnapshot> {
    const row = await this.readRow(subject);
    const stored = row ? rowToLedger(row) : emptyLedger();
    // Same rule the Map implementation applies on read, from the same function.
    return rolledOver(stored, window);
  }

  async inFlightFor(subject: Subject): Promise<number> {
    const row = await this.readRow(subject);
    return row ? this.liveInFlight(row) : 0;
  }

  /* ----------------------------------------------------------- writes ---- */

  /**
   * The refusal for "this subject already has as many units in flight as this
   * store allows" — produced by MemoryEntitlementStore rather than restated
   * here, and returned for the caller to throw.
   *
   * WHY NOT JUST BUILD THE OBJECT. `{reason: "concurrency_limit",
   * retryAfterSec: 2, window: "minute"}` is already built twice in
   * lib/entitlement.ts — in decideImport()'s concurrency branch, where the 2
   * seconds is justified against the route's 20s per-model deadline, and in
   * MemoryEntitlementStore.commitSpend, which is the store-level refusal this
   * one is the durable twin of. Writing it a third time here made this the one
   * place in the file holding a second opinion about a value, in a file whose
   * premise is that there is one ledger arithmetic and it is not in this file.
   * The copies agreed on the day they were written; the failure mode is the day
   * someone moves the deadline and raises retryAfterSec in lib/entitlement.ts,
   * because nothing would have said this file was still telling clients 2.
   *
   * So the refusal is PRODUCED: a throwaway MemoryEntitlementStore is given
   * THIS store's ceiling — which may be stricter than the module constant — is
   * told how many units are already in flight, and is asked to take the charge.
   * It refuses with the same EntitlementDenied the Map store would have thrown
   * in the same situation, carrying this store's own limit. Same borrowing as
   * ledgerAfter() above, for the same reason, and it only runs on a refusal, so
   * the allocation is on the path that is already returning 429.
   */
  private async concurrencyDenial(
    subject: Subject,
    charge: Charge,
    inFlight: number,
  ): Promise<EntitlementDenied> {
    const gate = new MemoryEntitlementStore(this.concurrencyLimit);
    try {
      if (inFlight > 0) {
        // MemoryEntitlementStore has no setter for the reservation count, but
        // its commitSpend counts units in flight, and a charge against no
        // window moves only that counter — no ledger bucket is touched. (If
        // inFlight alone already exceeds the ceiling, because the limit was
        // lowered under a live reservation, this first call is the one that
        // refuses. Same answer, same reason.)
        await gate.commitSpend(subject, { ...charge, units: inFlight, windows: [] });
      }
      await gate.commitSpend(subject, charge);
    } catch (err) {
      if (err instanceof EntitlementDenied) return err;
      // Not a refusal: the calculator itself broke. Surface it unchanged rather
      // than dressing it up as a quota answer — guardImport turns anything that
      // is not an EntitlementDenied into store_unavailable, which is the right
      // category for "this store could not decide".
      throw err;
    }
    // Unreachable while both stores compare inFlight + units against the same
    // ceiling with the same operator. If it is ever reached the two disagree
    // about what "over the limit" means, and the honest move is to refuse the
    // spend loudly rather than return a refusal nobody produced.
    throw new Error(
      `${NEON_ENTITLEMENT_BACKEND}: ${inFlight} + ${charge.units} units was over this store's ` +
        `concurrency ceiling of ${this.concurrencyLimit}, but MemoryEntitlementStore accepted it. ` +
        `Refusing the spend: the two stores no longer agree on the concurrency rule.`,
    );
  }

  /**
   * Debit the charge and reserve a slot, atomically with respect to every other
   * instance of this app.
   *
   * The loop is the atomicity: read the row, decide against THAT row, write
   * conditionally on its rev. Losing the write means another lane moved the
   * count between the read and the write, so the next pass decides again
   * against what actually landed — which is how the loser of the race for the
   * tenth import ends up denied instead of handed the eleventh.
   *
   * decideImport() is re-run here rather than trusting the guard's earlier
   * decision, and rather than re-deriving a ceiling locally. It is the same
   * function, so there is no second opinion about what the limit is, what the
   * refusal is called, or whether it leads to the interest form.
   */
  async commitSpend(subject: Subject, charge: Charge): Promise<LedgerSnapshot> {
    for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS; attempt += 1) {
      const row = await this.readRow(subject);
      const base = row ? rowToLedger(row) : emptyLedger();
      const baseRev = row ? toNum(row.rev, "rev") : 0;
      const inFlight = row ? this.liveInFlight(row) : 0;

      // Concurrency first, with THIS store's ceiling — which may be stricter
      // than the module constant decideImport uses. Mirrors the order
      // MemoryEntitlementStore.commitSpend applies. The refusal itself is not
      // written here; see concurrencyDenial().
      if (inFlight + charge.units > this.concurrencyLimit) {
        throw await this.concurrencyDenial(subject, charge, inFlight);
      }

      const ctx: ImportContext = {
        subject,
        plan: planForGoverningWindow(charge.against),
        periodStart: charge.periodStart,
        ledger: base,
        batchSize: charge.units,
        inFlight,
        // Whether OPENROUTER_API_KEY exists is not a property of the ledger and
        // was already answered at guard time; re-asking it here could only
        // convert a race into the wrong refusal.
        configured: true,
      };
      // The charge's own instant, not the wall clock: the windows this write is
      // about to open must be the windows the decision was made against.
      const decision = decideImport(ctx, charge.issuedAt);
      if (!decision.allow) throw new EntitlementDenied(decision);

      const next = await ledgerAfter(base, charge, null);
      const written = await this.casWrite(
        subject,
        baseRev,
        next,
        inFlight + charge.units,
        charge.issuedAt + RESERVATION_LEASE_MS,
      );
      if (written) return rowToLedger(written);
      // Lost the CAS. Nothing was written; go round again and re-decide.
    }
    throw new EntitlementLedgerContentionError("commitSpend", CAS_MAX_ATTEMPTS);
  }

  /**
   * Release the slot and hand back whatever the outcome earns.
   *
   * No decision is re-run: settling is not a request for permission, and a
   * refund that got refused would be the user paying for a call that failed.
   */
  async settle(
    subject: Subject,
    charge: Charge,
    settlement: Settlement,
  ): Promise<LedgerSnapshot> {
    for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS; attempt += 1) {
      const row = await this.readRow(subject);
      if (!row) {
        // Nothing to refund and no slot to release. Not an error: the row can
        // only be absent if the spend never landed, and the empty ledger is the
        // true state of this subject.
        return emptyLedger();
      }
      const base = rowToLedger(row);
      const baseRev = toNum(row.rev, "rev");
      const inFlight = this.liveInFlight(row);

      // The reservation count is this store's own bookkeeping, not ledger
      // arithmetic: the Map has no lease to expire, so there is nothing to
      // borrow. Clearing the expiry when the last slot goes keeps a stale
      // timestamp from making a future reservation look already-expired.
      const nextInFlight = Math.max(0, inFlight - charge.units);
      const nextExpiry = nextInFlight === 0 ? 0 : toNum(row.inFlightExpiresAt, "inFlightExpiresAt");

      const next = await ledgerAfter(base, charge, settlement);
      const written = await this.casWrite(subject, baseRev, next, nextInFlight, nextExpiry);
      if (written) return rowToLedger(written);
    }
    // guardImport swallows this and logs the leak. It must still throw: a
    // silent success here would claim a refund was applied that was not.
    throw new EntitlementLedgerContentionError("settle", CAS_MAX_ATTEMPTS);
  }
}

/* ========================================================================== *
 * 6. WHAT USED TO BE HERE
 * ========================================================================== *
 *
 * probeEntitlementLedger() — "is the durable gate actually there?", a
 * `select count(*)` against the ledger table, returning a failure category and
 * a remedy. It was exported and nothing in this repository called it: no admin
 * page, no deploy script, no route, no test. An exported function with no
 * caller is a claim about the design that the design does not make, and this
 * one also carried a second hand-written statement against the same table that
 * no code path exercised — the kind of code that is correct on the day it is
 * written and unowned afterwards.
 *
 * It is deleted rather than kept, because the answer it gave already arrives on
 * the path that actually runs: the first query against a missing table logs the
 * table name, the migration and `node db/migrate.mjs` once per process (see
 * run()), and every response from that point carries degradedWarning()'s
 * "table_missing" text with the same remedy in it. The probe was a second way
 * to learn something the store already says out loud.
 *
 * If a deploy check or an admin page is ever built, the probe wants to be
 * written with its caller rather than ahead of one — twenty lines around a
 * `select count(*)`, against the table named at the top of this file.
 */
