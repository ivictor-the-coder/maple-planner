// Meso income engine. The staircase: weekly bosses first, then dailies once the
// weeklies stop filling the crystal allowance, then non-crystal income above it.
//
// Everything here is deliberately pure and table-driven. No number in this file is
// a game constant unless it is in the CONSTANTS block below with a citation, and
// every constant that could not be sourced for GMS Heroic v.271 is exported, typed
// so the compiler forces the caller to handle the unknown, and listed in UNVERIFIED.

/**
 * OBSERVED IN GAME, 2026-09-12, on the Crystal Collector's Weekly Sale Status:
 *
 *   Crystal (all three types)  World      159 / 180
 *   Crystal (weekly only)      Character    4 / 14
 *
 * Both figures were DISPUTED and are now settled by the game itself.
 * The world cap is 180, not the 60 that was the last GMS-official figure
 * anyone could source (2021) and not the 90 that KMS uses. The per-character
 * weekly cap is 14, not 12 - 12 was the only value with a primary source
 * (KMS v1.2.393, July 2024) and it does not describe GMS.
 *
 * The label matters too: the character row counts only the WEEKLY crystal type,
 * which is direct evidence that daily and monthly crystals do not consume the
 * per-character allowance. That was previously flagged as weakly corroborated
 * and load-bearing for the whole daily-bossing conclusion.
 */
export const OBSERVED_CRYSTAL_CAPS = {
  worldPerWeek: 180,
  perCharacterWeeklyType: 14,
  observedAt: "2026-09-12",
  observedWorldUsed: 159,
  observedCharacterUsed: 4,
  source: "in-game Crystal Collector, Weekly Sale Status panel",
} as const;

// so the compiler forces the caller to handle the unknown, and listed in UNVERIFIED.
//
// WHY this file refuses to guess: a wrong crystal price does not produce a slightly
// wrong number, it produces a wrong ORDER, and the ordered "add next" list is the
// entire product. A player who is told Hard Lotus is worth more than Chosen Seren
// spends a month of weekly resets on the wrong boss.

import type { Character } from "./rules";

/* ============================================================================
 * CONSTANTS — sourced, unsourced, and the one that matters most
 * ==========================================================================*/

/** The crux of this entire feature.
 *
 *  The crystal allowance is counted in CRYSTALS, not mesos, and its SCOPE decides
 *  every downstream number: per-character multiplies the ceiling by roughly the
 *  size of the roster (31 characters on this account), account-per-world does not.
 *  There is no number in this product that survives getting this wrong.
 *
 *  What was actually checked (September 2026), and why none of it is good enough:
 *    - forums.maplestory.nexon.net/discussion/17560 (Dec 2017): players describe
 *      "a 60 per week limit"; no scope, no reset time, nine years stale.
 *    - forums.maplestory.nexon.net/discussion/22210: a suggestion thread arguing
 *      60 -> 100; again player wording, not patch notes.
 *    - forums.maplestory.nexon.net/discussion/31841 (Nov 2021): a BUG report
 *      claiming the intent was "60 intense crystals PER character per week" but
 *      the observed behaviour was "60 shared across ALL characters of the same
 *      world". A Nexon moderator acknowledged and forwarded it; the thread has no
 *      resolution. So the two candidate scopes are both attested and they
 *      contradict each other — which is precisely why this ships as 'unknown'.
 *    - maplestorywiki.net and the Fandom mirror both refused fetches (403 / 402).
 *    - No GMS v.271 patch note stating a number or a scope could be found.
 *
 *  Until someone cites a current GMS source, the engine MUST render the ceiling as
 *  a range across the plausible scopes (see CAP_SCENARIOS) and never as a figure.
 *  The type below makes that unavoidable: crystalsPerReset is `number | null`, and
 *  every income figure this module returns is a discriminated union whose 'range'
 *  and 'unknown' arms the compiler will not let a caller ignore.
 *
 *  Do NOT fill this in from memory. It needs a citation in `source` and a date in
 *  `lastVerified`, and tools/meso-check.ts exists to keep unverified numbers out
 *  of headline figures. */
export const CRYSTAL_SALE_LIMIT = {
  crystalsPerReset: null as number | null,
  scope: "unknown" as "account-per-world" | "per-character" | "unknown",
  /** GMS weekly content reset. Supplied by the product brief; independent of the
   *  cap itself, which is why it is not null while the cap is. */
  resetsAt: "Thursday 00:00 UTC",
  source: null as string | null,
  lastVerified: null as string | null,
};

/** The plausible worlds the cap could live in, used to produce a RANGE while
 *  CRYSTAL_SALE_LIMIT.crystalsPerReset is null.
 *
 *  UNVERIFIED. The number 60 comes from player forum posts dated 2017 and 2021,
 *  not from GMS v.271 patch notes. It is here only to bound a range that is
 *  labelled unverified everywhere it surfaces — it is never presented as truth,
 *  and `verified: false` keeps it out of anything tools/meso-check.ts calls a
 *  headline figure without a range flag beside it. Replace the whole array the
 *  moment a real source appears. */
export interface CapScenario {
  label: string;
  crystalsPerReset: number | null;
  scope: "account-per-world" | "per-character" | "uncapped";
  /** Always false here. If you are editing this to true, you had better be
   *  pasting a URL into `source` in the same commit. */
  verified: false;
  source: string;
}
export const CAP_SCENARIOS: readonly CapScenario[] = [
  {
    label: "60 crystals per week, shared across the world",
    crystalsPerReset: 60,
    scope: "account-per-world",
    verified: false,
    source: "forums.maplestory.nexon.net/discussion/31841 (Nov 2021, player bug report of observed behaviour)",
  },
  {
    label: "60 crystals per week, per character",
    crystalsPerReset: 60,
    scope: "per-character",
    verified: false,
    source: "forums.maplestory.nexon.net/discussion/31841 (Nov 2021, stated intent) + discussion/17560 (Dec 2017)",
  },
  {
    label: "no cap reached",
    crystalsPerReset: null,
    scope: "uncapped",
    verified: false,
    source: "structural upper bound — every crystal you can clear, sold; not a sourced game rule",
  },
];

/** How many times a week a boss of each cadence can be run by ONE character.
 *
 *  `daily: 7` is a behavioural assumption (the player logs in every day), not a
 *  game constant — it is the allowance, not the observed habit, which is why it is
 *  user-editable through WeeklyPlanOptions.dailyClearsPerWeek.
 *
 *  `monthly: 0` is deliberate and visible, not a silent drop. A once-a-month kill
 *  cannot be spent against a weekly crystal allowance without amortising, and
 *  amortising a discrete crystal misstates every individual week. Monthly bosses
 *  are reported separately in IncomeReport.monthlyExcluded so the number the user
 *  sees is a real week, and the monthly income is not quietly lost. */
export const WEEKLY_RUN_ALLOWANCE: Record<BossCadence, number> = {
  daily: 7,
  weekly: 1,
  monthly: 0,
};

/** CP bands used to turn a single number into a clear/no-clear call.
 *
 *  UNVERIFIED HEURISTIC — these margins are not game data and cannot be; they are
 *  a presentation choice about how much headroom counts as comfortable. The CP
 *  thresholds they multiply are themselves community estimates (guide-graph's
 *  bosses.cp node is titled "solo estimates").
 *
 *  And CP is not the gate anyway: bind uptime, mechanics literacy and death count
 *  decide clears as much as damage does. Every consumer of ClearConfidence must
 *  repeat that — see CLEAR_CAVEAT. */
export const CP_CONFIDENCE_BANDS = {
  /** cp >= threshold * this -> "comfortable" */
  comfortable: 1.5,
  /** cp >= threshold * this -> "likely" */
  likely: 1.0,
  /** cp >= threshold * this -> "stretch" (doable with mechanics, not with stats) */
  stretch: 0.7,
  verified: false as const,
};

export const CLEAR_CAVEAT =
  "CP thresholds are community solo estimates. Bind uptime and mechanics gate a clear as much as damage does — a stretch clear is a practice problem, not a gear problem.";

/** Farming mesos/hour. There is no defensible constant here: it swings with map,
 *  class, meso/drop gear, familiars, Kishin and legion, and any figure this app
 *  invented would be a lie with four significant digits.
 *
 *  So it is a user input with a clearly labelled placeholder. `mesosPerHour` is
 *  defined as the rate measured at the user's CURRENT Mesos Obtained %, which is
 *  why projectFarmIncome() does not re-apply the bonus the user already had when
 *  they measured it — double-counting meso% is the obvious way to get this wrong. */
export const FARM_RATE = {
  mesosPerHour: null as number | null,
  hoursPerWeek: null as number | null,
  /** Meso Obtained % the user had on when they measured mesosPerHour. Needed to
   *  answer "what would more meso gear buy me" without counting it twice. */
  measuredAtMesoPct: null as number | null,
  placeholder: true as const,
  source: null as string | null,
  lastVerified: null as string | null,
};

/** Every constant in this module that could not be sourced for GMS Heroic v.271.
 *  Exported so the UI can render a provenance panel and so a checker can assert
 *  none of them reached a headline figure unflagged. */
export const UNVERIFIED: ReadonlyArray<{ name: string; why: string }> = [
  { name: "CRYSTAL_SALE_LIMIT.crystalsPerReset", why: "No GMS v.271 source. Forum posts say 60 (2017, 2021); scope contradicted within the same thread." },
  { name: "CRYSTAL_SALE_LIMIT.scope", why: "Attested both as per-character (stated intent) and account-per-world (observed behaviour, unresolved bug report)." },
  { name: "CAP_SCENARIOS[*].crystalsPerReset", why: "Range bounds taken from 2017/2021 player forum wording, not patch notes." },
  { name: "WEEKLY_RUN_ALLOWANCE.daily", why: "7 is the entry allowance assuming a daily login, not a measured habit; user-editable." },
  { name: "CP_CONFIDENCE_BANDS", why: "Presentation heuristic over community CP estimates. Not game data." },
  { name: "FARM_RATE.mesosPerHour", why: "Placeholder. Must be measured by the user; no defensible default exists." },
];

/* ============================================================================
 * The boss table
 * ==========================================================================*/

export type BossCadence = "daily" | "weekly" | "monthly";

/** One boss at one difficulty. Mirrors data/boss-income.json row-for-row.
 *
 *  ASSUMPTION RECORDED: data/boss-income.json is authored by a parallel builder to
 *  this shape (the shape is fixed by the build brief). This module deliberately
 *  does NOT import that file — a static import of a JSON that does not exist yet
 *  fails the build for every other builder in the repo. Instead the table is
 *  injected: call setBossTable(parseBossIncome(rows)) once, or pass a table to any
 *  function. parseBossIncome() validates, so a malformed row degrades to "unpriced"
 *  instead of poisoning a total. */
export interface BossIncomeRow {
  id: string;
  boss: string;
  difficulty: string;
  cadence: BossCadence;
  /** Mesos for ONE crystal. null means unknown and must render as the literal word
   *  "unknown" — never 0, never a guess. */
  crystalMesos: number | null;
  cpSolo: number | null;
  cpParty: number | null;
  crystalsPerClear: number;
  /** false for anything not sourced for GMS Heroic v.271. Unverified rows are
   *  excluded from every total and counted in unpricedCount. */
  verified: boolean;
  source?: string | null;
  lastVerified?: string | null;
  patchVersion?: string | null;
}

let TABLE: readonly BossIncomeRow[] = [];

/** Install the boss table. Call once at module init in the UI:
 *    import rows from "@/data/boss-income.json";
 *    setBossTable(parseBossIncome(rows));
 *  An empty table is a legitimate state — every figure comes back 'unknown' and
 *  the UI says so, which is the correct behaviour before the data lands. */
export function setBossTable(rows: readonly BossIncomeRow[]): void {
  TABLE = rows;
}
export function getBossTable(): readonly BossIncomeRow[] {
  return TABLE;
}

function isCadence(v: unknown): v is BossCadence {
  return v === "daily" || v === "weekly" || v === "monthly";
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Validate raw JSON into rows. Anything unparseable in a numeric field becomes
 *  null rather than 0 — the difference between "unknown" and "worth nothing" is
 *  the difference between a banner and a silently wrong total. */
export function parseBossIncome(raw: unknown): BossIncomeRow[] {
  if (!Array.isArray(raw)) return [];
  const out: BossIncomeRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.boss !== "string") continue;
    if (!isCadence(o.cadence)) continue;
    const per = num(o.crystalsPerClear);
    out.push({
      id: o.id,
      boss: o.boss,
      difficulty: typeof o.difficulty === "string" ? o.difficulty : "",
      cadence: o.cadence,
      crystalMesos: num(o.crystalMesos),
      cpSolo: num(o.cpSolo),
      cpParty: num(o.cpParty),
      // A row that does not say how many crystals it drops is assumed to drop one,
      // which is the universal case; it never inflates a total.
      crystalsPerClear: per !== null && per > 0 ? Math.floor(per) : 1,
      verified: o.verified === true,
      source: typeof o.source === "string" ? o.source : null,
      lastVerified: typeof o.lastVerified === "string" ? o.lastVerified : null,
      patchVersion: typeof o.patchVersion === "string" ? o.patchVersion : null,
    });
  }
  return out;
}

/** The single gate on whether a row may be summed. Both conditions matter:
 *  a price with verified:false is someone's guess, and verified:true with a null
 *  price is an honest row about a boss nobody has priced. */
export function isPriced(r: BossIncomeRow): r is BossIncomeRow & { crystalMesos: number } {
  return r.verified === true && typeof r.crystalMesos === "number";
}

/* ============================================================================
 * Clearability
 * ==========================================================================*/

export type ClearConfidence = "comfortable" | "likely" | "stretch" | "out-of-reach" | "unknown";

export interface ClearableBoss {
  row: BossIncomeRow;
  confidence: ClearConfidence;
  /** The threshold actually used, and which column it came from. Party thresholds
   *  are far lower than solo ones, so saying which was applied is not a detail. */
  thresholdCp: number | null;
  thresholdBasis: "solo" | "party" | "none";
  /** cp shortfall against thresholdCp; 0 when already over it, null when unknown. */
  cpGap: number | null;
  caveat: string;
}

function bandFor(cp: number, threshold: number): ClearConfidence {
  if (cp >= threshold * CP_CONFIDENCE_BANDS.comfortable) return "comfortable";
  if (cp >= threshold * CP_CONFIDENCE_BANDS.likely) return "likely";
  if (cp >= threshold * CP_CONFIDENCE_BANDS.stretch) return "stretch";
  return "out-of-reach";
}

export interface ClearOptions {
  /** Solo thresholds by default. A player with a static clears at the party
   *  number, which is often a third of the solo one — this flips that. */
  party?: boolean;
  table?: readonly BossIncomeRow[];
}

/** Every boss in the table, annotated with how confident we are the character can
 *  clear it. Returns ALL rows, not just the passing ones: the "add next" list is
 *  built from the ones that fail, so throwing them away here would throw away the
 *  feature. Filter on `confidence` at the call site. */
export function clearableBosses(ch: Character, opts: ClearOptions = {}): ClearableBoss[] {
  const table = opts.table ?? TABLE;
  const cp = typeof ch.cp === "number" && Number.isFinite(ch.cp) ? ch.cp : 0;
  return table.map((row) => {
    const solo = row.cpSolo;
    const party = row.cpParty;
    // Prefer the requested basis, fall back to whichever column exists.
    const preferred = opts.party ? party ?? solo : solo ?? party;
    const basis: ClearableBoss["thresholdBasis"] =
      preferred === null || preferred === undefined
        ? "none"
        : preferred === (opts.party ? party : solo)
          ? (opts.party ? "party" : "solo")
          : (opts.party ? "solo" : "party");
    if (preferred === null || preferred === undefined) {
      return { row, confidence: "unknown", thresholdCp: null, thresholdBasis: "none", cpGap: null, caveat: CLEAR_CAVEAT };
    }
    return {
      row,
      confidence: bandFor(cp, preferred),
      thresholdCp: preferred,
      thresholdBasis: basis,
      cpGap: Math.max(0, preferred - cp),
      caveat: CLEAR_CAVEAT,
    };
  });
}

/** The confidence levels that count as "this is in your rotation today". */
const CLEARS: ReadonlyArray<ClearConfidence> = ["comfortable", "likely"];
export function isClearing(c: ClearConfidence): boolean {
  return CLEARS.includes(c);
}

/* ============================================================================
 * The staircase
 * ==========================================================================*/

export interface CrystalEntry {
  rowId: string;
  boss: string;
  difficulty: string;
  cadence: BossCadence;
  /** Value of THIS one crystal. */
  mesos: number;
  /** 1..N across the week's runs. A daily boss produces several entries; that is
   *  the whole mechanism by which dailies fill the allowance left over by
   *  weeklies, with no special case anywhere in the sort. */
  runIndex: number;
  confidence: ClearConfidence;
}

export interface WeeklyPlanOptions extends ClearOptions {
  /** Restrict the candidate pool to bosses the player says they actually run.
   *  Absent means "infer from CP", which is an assumption and is flagged. */
  clearedBossIds?: readonly string[];
  /** Override WEEKLY_RUN_ALLOWANCE.daily. */
  dailyClearsPerWeek?: number;
  /** Override the cap for a what-if. null means "use CRYSTAL_SALE_LIMIT". */
  capOverride?: number | null;
}

export interface WeeklyPlan {
  takenCrystals: CrystalEntry[];
  mesosFromCrystals: number;
  /** True when there were more clearable crystals than the allowance holds — the
   *  state in which an upgrade DISPLACES rather than adds. */
  capBinding: boolean;
  /** Rows that are clearable but have no usable price (null value, or verified:false). */
  unpricedCount: number;
  /** Entries generated but left on the floor because the cap ran out. */
  spilledCrystals: CrystalEntry[];
  capUsed: number | null;
  capVerified: boolean;
}

function runsPerWeek(cadence: BossCadence, dailyOverride?: number): number {
  if (cadence === "daily") {
    const n = dailyOverride ?? WEEKLY_RUN_ALLOWANCE.daily;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return WEEKLY_RUN_ALLOWANCE[cadence];
}

/** Expand the clearable, priced bosses into one entry per sellable crystal. */
function candidates(pool: ClearableBoss[], opts: WeeklyPlanOptions): CrystalEntry[] {
  const out: CrystalEntry[] = [];
  for (const c of pool) {
    if (!isPriced(c.row)) continue;
    const runs = runsPerWeek(c.row.cadence, opts.dailyClearsPerWeek);
    const per = c.row.crystalsPerClear;
    for (let r = 1; r <= runs; r++) {
      for (let k = 0; k < per; k++) {
        out.push({
          rowId: c.row.id,
          boss: c.row.boss,
          difficulty: c.row.difficulty,
          cadence: c.row.cadence,
          mesos: c.row.crystalMesos,
          runIndex: r,
          confidence: c.confidence,
        });
      }
    }
  }
  return out;
}

/** Greedy is not an approximation here, it is the exact optimum, and the reason is
 *  the unit the cap counts.
 *
 *  The allowance is denominated in CRYSTALS, not mesos and not clears. Every
 *  crystal occupies exactly one unit of the allowance regardless of what it sells
 *  for, and crystals are independent — selling Hard Lotus does not make Chosen
 *  Seren cheaper or unavailable. So this is a knapsack in which every item has
 *  weight 1, and a unit-weight knapsack is solved exactly by "take the N most
 *  valuable items". No dynamic programming, no ordering subtleties, no ties that
 *  matter. The moment the cap starts counting anything else — mesos, clears,
 *  bosses — this reasoning dies and so does this function. */
function takeTopN(entries: CrystalEntry[], cap: number | null): { taken: CrystalEntry[]; spilled: CrystalEntry[] } {
  const sorted = [...entries].sort((a, b) => b.mesos - a.mesos);
  if (cap === null) return { taken: sorted, spilled: [] };
  return { taken: sorted.slice(0, cap), spilled: sorted.slice(cap) };
}

export function weeklyPlan(ch: Character, opts: WeeklyPlanOptions = {}): WeeklyPlan {
  const all = clearableBosses(ch, opts);
  const chosen = opts.clearedBossIds
    ? all.filter((c) => opts.clearedBossIds!.includes(c.row.id))
    : all.filter((c) => isClearing(c.confidence));

  const unpricedCount = chosen.filter((c) => !isPriced(c.row) && runsPerWeek(c.row.cadence, opts.dailyClearsPerWeek) > 0).length;
  const cap = opts.capOverride !== undefined ? opts.capOverride : CRYSTAL_SALE_LIMIT.crystalsPerReset;
  const pool = candidates(chosen, opts);
  const { taken, spilled } = takeTopN(pool, cap);

  return {
    takenCrystals: taken,
    mesosFromCrystals: taken.reduce((a, c) => a + c.mesos, 0),
    capBinding: spilled.length > 0,
    unpricedCount,
    spilledCrystals: spilled,
    capUsed: cap,
    capVerified: CRYSTAL_SALE_LIMIT.crystalsPerReset !== null && CRYSTAL_SALE_LIMIT.source !== null,
  };
}

/* ============================================================================
 * Headline figures
 * ==========================================================================*/

/** A meso figure that the compiler will not let you print without deciding what to
 *  do about an unverified cap. 'range' carries the spread across CAP_SCENARIOS;
 *  'unknown' is for figures that are undefined without a cap at all. */
export type IncomeFigure =
  | { kind: "exact"; mesos: number; crystalsCounted: number; capApplied: boolean }
  | { kind: "range"; low: number; high: number; unverifiedCap: true; basis: ScenarioFigure[] }
  | { kind: "unknown"; why: string };

export interface ScenarioFigure {
  scenario: CapScenario;
  mesos: number;
  crystalsCounted: number;
}

function figureFor(entries: CrystalEntry[], rosterSize: number): IncomeFigure {
  if (CRYSTAL_SALE_LIMIT.crystalsPerReset !== null) {
    const { taken } = takeTopN(entries, CRYSTAL_SALE_LIMIT.crystalsPerReset);
    return {
      kind: "exact",
      mesos: taken.reduce((a, c) => a + c.mesos, 0),
      crystalsCounted: taken.length,
      capApplied: taken.length < entries.length,
    };
  }
  const basis: ScenarioFigure[] = CAP_SCENARIOS.map((s) => {
    // Under a per-character cap the account-wide allowance is the per-character
    // number times the roster; under an account-per-world cap it is the number
    // itself. This single line is the whole reason the scope matters.
    const effective =
      s.crystalsPerReset === null
        ? null
        : s.scope === "per-character"
          ? s.crystalsPerReset * Math.max(1, rosterSize)
          : s.crystalsPerReset;
    const { taken } = takeTopN(entries, effective);
    return { scenario: s, mesos: taken.reduce((a, c) => a + c.mesos, 0), crystalsCounted: taken.length };
  });
  return collapse(basis);
}

/** A range whose ends agree is not a range: it means no plausible cap binds on
 *  this player yet, which is a real and useful statement ("the cap is not your
 *  problem"). Report it as exact — the surrounding IncomeReport still carries
 *  capUnverified, so nothing pretends the cap itself is known. */
function collapse(basis: ScenarioFigure[]): IncomeFigure {
  const vals = basis.map((b) => b.mesos);
  const low = Math.min(...vals), high = Math.max(...vals);
  if (low === high) {
    const anyCapped = basis.some((b) => b.crystalsCounted < Math.max(...basis.map((x) => x.crystalsCounted)));
    return { kind: "exact", mesos: low, crystalsCounted: Math.max(...basis.map((b) => b.crystalsCounted)), capApplied: anyCapped };
  }
  return { kind: "range", low, high, unverifiedCap: true, basis };
}

export interface IncomeReport {
  /** (a) What the character banks this week at the bosses actually cleared. */
  current: IncomeFigure;
  /** (b) Ceiling at current clear ability, cap applied. */
  ceilingAtCurrentClears: IncomeFigure;
  /** (c) Ceiling if the allowance were filled edge to edge with the best crystal
   *  available. Undefined without a cap, hence the 'unknown' arm. */
  ceilingIfCapFilled: IncomeFigure;
  /** (c) assumes enough characters exist to repeat the best boss across the
   *  allowance. With 31 characters most of them cannot clear it, so this is an
   *  upper bound and must be labelled one. */
  capFillAssumesRosterCanRepeat: true;
  /** Clearable bosses with no usable price. Render as "N bosses unpriced". */
  unpricedCount: number;
  unpricedBosses: string[];
  /** Monthly bosses deliberately left out of a weekly figure — shown, not dropped. */
  monthlyExcluded: string[];
  /** True whenever (a) was inferred from CP because the caller did not say which
   *  bosses are actually run. */
  currentInferredFromCp: boolean;
  capUnverified: boolean;
  capNote: string;
  plan: WeeklyPlan;
}

export function incomeReport(ch: Character, opts: WeeklyPlanOptions = {}): IncomeReport {
  const rosterSize = ch.roster?.length ?? 1;
  const all = clearableBosses(ch, opts);
  const plan = weeklyPlan(ch, opts);

  const clearedNow = opts.clearedBossIds
    ? all.filter((c) => opts.clearedBossIds!.includes(c.row.id))
    : all.filter((c) => isClearing(c.confidence));
  const current = figureFor(candidates(clearedNow, opts), rosterSize);

  // (b) is (a)'s pool by construction today — clear ability IS what we inferred —
  // but they diverge the moment the caller passes clearedBossIds, which is the
  // interesting case: "you can clear these, you are only running those".
  const reachable = all.filter((c) => isClearing(c.confidence));
  const ceilingAtCurrentClears = figureFor(candidates(reachable, opts), rosterSize);

  const priced = reachable.filter((c): c is ClearableBoss & { row: BossIncomeRow & { crystalMesos: number } } => isPriced(c.row));
  const best = priced.reduce<number>((a, c) => Math.max(a, c.row.crystalMesos), 0);
  const capForFill =
    CRYSTAL_SALE_LIMIT.crystalsPerReset ??
    null;
  let ceilingIfCapFilled: IncomeFigure;
  if (!priced.length) {
    ceilingIfCapFilled = { kind: "unknown", why: "No priced boss is clearable, so there is no crystal to fill the allowance with." };
  } else if (capForFill !== null) {
    ceilingIfCapFilled = { kind: "exact", mesos: best * capForFill, crystalsCounted: capForFill, capApplied: true };
  } else {
    // Without a cap the phrase "if the cap were filled" has no referent, so the
    // uncapped scenario is excluded here rather than reported as infinity.
    const numeric = CAP_SCENARIOS.filter((s) => s.crystalsPerReset !== null);
    if (!numeric.length) {
      ceilingIfCapFilled = { kind: "unknown", why: "No cap is known and no plausible cap is on file, so a filled allowance cannot be sized." };
    } else {
      const basis: ScenarioFigure[] = numeric.map((s) => {
        const n = (s.crystalsPerReset as number) * (s.scope === "per-character" ? Math.max(1, rosterSize) : 1);
        return { scenario: s, mesos: best * n, crystalsCounted: n };
      });
      ceilingIfCapFilled = collapse(basis);
    }
  }

  const unpriced = reachable.filter((c) => !isPriced(c.row) && runsPerWeek(c.row.cadence, opts.dailyClearsPerWeek) > 0);

  return {
    current,
    ceilingAtCurrentClears,
    ceilingIfCapFilled,
    capFillAssumesRosterCanRepeat: true,
    unpricedCount: unpriced.length,
    unpricedBosses: unpriced.map((c) => `${c.row.difficulty} ${c.row.boss}`.trim()),
    monthlyExcluded: all.filter((c) => c.row.cadence === "monthly").map((c) => `${c.row.difficulty} ${c.row.boss}`.trim()),
    currentInferredFromCp: !opts.clearedBossIds,
    capUnverified: CRYSTAL_SALE_LIMIT.crystalsPerReset === null,
    capNote:
      CRYSTAL_SALE_LIMIT.crystalsPerReset === null
        ? `Crystal sale cap is UNVERIFIED for GMS v.271 and its scope (per character vs per account per world) is contradicted in the only sources found — the roster has ${rosterSize} character${rosterSize === 1 ? "" : "s"}, so the scope alone moves this figure by that factor. Figures are ranges, not estimates.`
        : `Cap ${CRYSTAL_SALE_LIMIT.crystalsPerReset} crystals per reset, ${CRYSTAL_SALE_LIMIT.scope}, resets ${CRYSTAL_SALE_LIMIT.resetsAt}.`,
    plan,
  };
}

/* ============================================================================
 * "Add next" — the ordered list, with displacement
 * ==========================================================================*/

export interface AddNextRow {
  row: BossIncomeRow;
  confidence: ClearConfidence;
  cpGap: number | null;
  thresholdCp: number | null;
  thresholdBasis: ClearableBoss["thresholdBasis"];
  /** Gross mesos the boss's crystals are worth in a week, before displacement. */
  grossPerWeek: number | null;
  /** What you actually gain. When the allowance is already full, adding a crystal
   *  means selling a worse one instead, so the delta is the difference — this is
   *  the number the feature exists to show. */
  netPerWeek: number | null;
  /** The crystals that would fall off the bottom of the allowance. Empty when the
   *  cap is not binding. */
  displaces: CrystalEntry[];
  capBinding: boolean;
  priced: boolean;
  caveat: string;
}

/** Bosses NOT currently in the rotation, ordered by what adding them actually
 *  buys. Unpriced bosses are returned last with netPerWeek null so the UI can
 *  print "unknown" rather than pretending they are worthless. */
export function addNext(ch: Character, opts: WeeklyPlanOptions = {}): AddNextRow[] {
  const all = clearableBosses(ch, opts);
  const inRotation = new Set(
    (opts.clearedBossIds ? all.filter((c) => opts.clearedBossIds!.includes(c.row.id)) : all.filter((c) => isClearing(c.confidence)))
      .map((c) => c.row.id),
  );
  const base = weeklyPlan(ch, opts);
  const cap = base.capUsed;

  const rows: AddNextRow[] = [];
  for (const c of all) {
    if (inRotation.has(c.row.id)) continue;
    if (runsPerWeek(c.row.cadence, opts.dailyClearsPerWeek) === 0) continue; // monthly, reported elsewhere

    if (!isPriced(c.row)) {
      rows.push({
        row: c.row, confidence: c.confidence, cpGap: c.cpGap, thresholdCp: c.thresholdCp,
        thresholdBasis: c.thresholdBasis, grossPerWeek: null, netPerWeek: null,
        displaces: [], capBinding: base.capBinding, priced: false, caveat: c.caveat,
      });
      continue;
    }

    const added = candidates([c], opts);
    const gross = added.reduce((a, e) => a + e.mesos, 0);

    // Re-solve rather than reason about it: merge the new crystals into the pool
    // and take the top N again. The displaced set is whatever was in the old
    // solution and is not in the new one.
    const merged = takeTopN([...base.takenCrystals, ...added], cap).taken;
    const mergedTotal = merged.reduce((a, e) => a + e.mesos, 0);
    const keptIds = new Set(merged.map((e) => `${e.rowId}#${e.runIndex}`));
    const displaces = base.takenCrystals.filter((e) => !keptIds.has(`${e.rowId}#${e.runIndex}`));

    rows.push({
      row: c.row, confidence: c.confidence, cpGap: c.cpGap, thresholdCp: c.thresholdCp,
      thresholdBasis: c.thresholdBasis, grossPerWeek: gross,
      netPerWeek: mergedTotal - base.mesosFromCrystals,
      displaces, capBinding: base.capBinding, priced: true, caveat: c.caveat,
    });
  }

  return rows.sort((a, b) => {
    if (a.priced !== b.priced) return a.priced ? -1 : 1;
    return (b.netPerWeek ?? -1) - (a.netPerWeek ?? -1);
  });
}

/* ============================================================================
 * The non-crystal tier
 * ==========================================================================*/

// Potential-line parsers for the two lines that make mesos rather than damage.
// These mirror statPct() in lib/rules.ts. They live here rather than there only
// because lib/rules.ts belongs to another builder in this build — if rules.ts
// ships `mesoPct` / `dropPct` with the same semantics, delete these two and
// re-export from there. Semantics: sum of percentages across the supplied lines.
const MESO_LINE = /mesos?\s*(obtained|acquired|acquisition)?/i;
const DROP_LINE = /item\s*drop\s*rate|drop\s*rate/i;

function pctOf(line: string): number {
  const m = line.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : 0;
}

/** "Mesos Obtained +20%" -> 20. Unlike statPct there is no All Stat / main-stat
 *  distinction to make: the line either mentions mesos or it does not. */
export function mesoPctFromLines(lines: readonly string[]): number {
  return lines.filter(Boolean).reduce((a, l) => (MESO_LINE.test(l) && !DROP_LINE.test(l) ? a + pctOf(l) : a), 0);
}

/** "Item Drop Rate +20%" -> 20. */
export function dropPctFromLines(lines: readonly string[]): number {
  return lines.filter(Boolean).reduce((a, l) => (DROP_LINE.test(l) ? a + pctOf(l) : a), 0);
}

/** Sum meso% and drop% across every equipped item's potential lines. */
export function accountMesoGear(ch: Character): { mesoPct: number; dropPct: number } {
  let m = 0, d = 0;
  for (const it of Object.values(ch.items || {})) {
    const lines = (it?.p || []).filter(Boolean);
    m += mesoPctFromLines(lines);
    d += dropPctFromLines(lines);
  }
  return { mesoPct: m, dropPct: d };
}

export interface FarmProjection {
  kind: "exact" | "unknown";
  mesosPerWeek: number | null;
  /** What the user would gain per week per additional point of Mesos Obtained %. */
  perMesoPctPerWeek: number | null;
  why: string;
}

/** Farming income above the crystal cap.
 *
 *  MODEL, not a game constant: Mesos Obtained % is treated as a linear multiplier
 *  on meso drops, so a rate measured at m0% projects to m1% as
 *  rate * (100 + m1) / (100 + m0). That is the standard additive-bonus reading and
 *  it is an assumption — it ignores flat meso-drop caps, Wealth Acquisition Potion
 *  stacking rules and per-map meso floors. It is written out here so a reader can
 *  disagree with it; it is not buried in an expression. */
export function projectFarmIncome(
  rate: typeof FARM_RATE = FARM_RATE,
  targetMesoPct?: number,
): FarmProjection {
  if (rate.mesosPerHour === null || rate.hoursPerWeek === null) {
    return {
      kind: "unknown",
      mesosPerWeek: null,
      perMesoPctPerWeek: null,
      why: "Farming rate is a placeholder. Measure one hour of your own farming and enter mesos/hour and hours/week — no default here would be true for your map, class or meso gear.",
    };
  }
  const base = rate.mesosPerHour * rate.hoursPerWeek;
  const m0 = rate.measuredAtMesoPct ?? 0;
  const m1 = targetMesoPct ?? m0;
  const scaled = (base * (100 + m1)) / (100 + m0);
  return {
    kind: "exact",
    mesosPerWeek: scaled,
    perMesoPctPerWeek: base / (100 + m0),
    why: `Measured ${rate.mesosPerHour.toLocaleString()}/h at ${m0}% Mesos Obtained, ${rate.hoursPerWeek}h/week, projected to ${m1}%.`,
  };
}

/* ============================================================================
 * Pricing a recommendation
 * ==========================================================================*/

export interface CostInContext {
  mesos: number;
  /** Cost as a fraction of one week of income. null when income is unknown. */
  fractionOfWeek: number | null;
  /** Minutes of the user's own play time, when they have told us how long they
   *  play. Without that, a "minutes" figure would be a minutes-of-nothing. */
  minutesOfPlay: number | null;
  label: string;
}

/** Turn "3,000,000 mesos" into "3M — about 4 minutes of your week".
 *
 *  Takes a resolved weekly income number rather than a Character so that the
 *  caller decides which of the three headline figures a cost is measured against
 *  — pricing a flame reset against the ceiling you have not reached yet would
 *  flatter every recommendation in the app. */
export function costInContext(mesos: number, weeklyIncome: number | null, playHoursPerWeek?: number | null): CostInContext {
  const short = mesos >= 1e9 ? `${(mesos / 1e9).toFixed(1)}B` : mesos >= 1e6 ? `${Math.round(mesos / 1e6)}M` : mesos.toLocaleString();
  if (!weeklyIncome || weeklyIncome <= 0) {
    return { mesos, fractionOfWeek: null, minutesOfPlay: null, label: `${short} — share of your week unknown until your income is priced` };
  }
  const frac = mesos / weeklyIncome;
  const mins = playHoursPerWeek && playHoursPerWeek > 0 ? frac * playHoursPerWeek * 60 : null;
  const tail =
    mins !== null
      ? `about ${mins < 1 ? "under a minute" : `${Math.round(mins)} minute${Math.round(mins) === 1 ? "" : "s"}`} of your week`
      : `${(frac * 100).toFixed(frac < 0.01 ? 2 : 1)}% of a week's income`;
  return { mesos, fractionOfWeek: frac, minutesOfPlay: mins, label: `${short} — ${tail}` };
}

/** Convenience for the UI: the one number most callers want to divide costs by.
 *  Returns null rather than a midpoint when the figure is a range — averaging an
 *  unverified range into a point estimate is exactly the move this file exists to
 *  prevent. */
export function weeklyIncomeForCosting(fig: IncomeFigure): number | null {
  return fig.kind === "exact" ? fig.mesos : null;
}

/** Format any figure for display without the caller having to know the union.
 *  A null crystal price renders as the literal word "unknown", by requirement. */
export function formatFigure(fig: IncomeFigure, fmt: (n: number) => string = (n) => n.toLocaleString()): string {
  switch (fig.kind) {
    case "exact":
      return fmt(fig.mesos);
    case "range":
      return `${fmt(fig.low)} – ${fmt(fig.high)} (unverified cap)`;
    case "unknown":
      return "unknown";
  }
}
