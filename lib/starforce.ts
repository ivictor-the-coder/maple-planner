/**
 * Star Force: rate table, Reboot meso cost model, Monte Carlo simulator, and the
 * meso-efficiency ranking that answers "which tap buys the most for the least".
 *
 * WHY THIS FILE EXISTS
 * The app shipped the per-star success/fail/boom table as *display strings* inside
 * data/guide-graph.json. A string cannot be simulated. Everything numeric about
 * star force now lives here, as numbers, so the guide table and the simulator can
 * never drift apart: render the guide from STAR_ROWS and the two are the same data.
 *
 * WHAT "verified" MEANS HERE
 * `verified: true` is claimed only when a number is confirmed by a Nexon-primary
 * source, OR reproduced exactly by two independent public sources. Everything else
 * is `false` and names itself in `unverified[]` so the UI can say precisely which
 * constant is soft. This is deliberately stricter than "I found it somewhere":
 * a confidently wrong cost model sends a real person to grind for nothing.
 *
 * Nexon's own v.271 patch-note page (meta.patchNotesUrl in guide-graph.json) is a
 * client-rendered SPA and returned no readable body to any fetch attempt made while
 * building this, so NOTHING here is marked nexon-primary. That is a sourcing gap,
 * not an oversight. See ENHANCEMENT_MODE_QUESTION below.
 *
 * SCOPE: GMS, Heroic (Reboot), v.271. No trading, no Star Force Transfer modelling
 * (transfer is a separate decision), no Superior-equipment rate table.
 */

/* ------------------------------------------------------------------ *
 * 0. Provenance plumbing
 * ------------------------------------------------------------------ */

export type Provenance =
  | "nexon-primary" // Nexon patch notes / official support article
  | "community-cross-checked" // >= 2 independent public sources agreeing exactly
  | "community-single" // one public source, or several that may share an upstream
  | "placeholder"; // could not be sourced at all - labelled guess, never silent

export function isVerified(p: Provenance): boolean {
  return p === "nexon-primary" || p === "community-cross-checked";
}

/** Every URL cited below, in one place, so the UI can link its own footnotes. */
export const SOURCES = {
  /** The app's own shipped table, itself sourced to DigitalTQ (Feb 2026). */
  guideGraph: "data/guide-graph.json#starforce.rates",
  digitalTq: "https://www.digitaltq.com/maplestory-star-force-guide",
  /** Open-source GMS calculator. Cost function, rate table and mode table read from src.js. */
  blushiemagic:
    "https://github.com/blushiemagic/Maplestory-Starforce-Calculator/blob/master/src.js",
  /** Second, independent GMS calculator advertising "v269 GMS Enhancement Modes". */
  tadeucci: "https://starforce.tadeucci.dev/",
  strategyWiki: "https://strategywiki.org/wiki/MapleStory/Spell_Trace_and_Star_Force",
  maplestoryWiki: "https://maplestorywiki.net/w/Star_Force_Enhancement",
  mvpWiki: "https://maplestorywiki.net/w/MVP_System",
  nexonSupportChanceTime:
    "https://support-maplestory.nexon.com/hc/en-us/articles/204088639-How-do-I-enhance-equips-with-Star-Force",
  patchNotesV271:
    "https://www.nexon.com/maplestory/news/update/44597/updated-9-10-v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes",
} as const;

/**
 * THE ENHANCEMENT MODE QUESTION, RESOLVED AS FAR AS IT CAN BE.
 *
 * The shipped guide says "Safeguard doubles the meso cost and removes boom, up to
 * 18 stars." Post-v269 GMS sources instead describe Enhancement Modes 1-4 selectable
 * at 15-21 stars, with Mode 4 at 0% destroy. These are NOT in conflict, they are the
 * same mechanic described at two points in time:
 *
 *   - At from-stars 15, 16 and 17 the boom-free option is the classic Safeguard, and
 *     its cost is ADDITIVE with other multipliers (multiplier += cost - 1), not
 *     multiplicative. That is why it reads as "+2x base" rather than "x3".
 *   - At from-stars 18-21 there is no Safeguard; Modes 2-4 buy down the destroy rate
 *     by ALSO lowering the success rate (18/19/21 Mode 4 = 8% success, 0% destroy,
 *     6.5x cost), which is the part the old guide text does not cover.
 *   - At 22+ there are no modes and no protection of any kind.
 *
 * Two independent calculators agree on the mode numbers to four decimal places: the
 * open-source blushiemagic table (success/destroy/cost per mode) reproduces, once the
 * 1.05x star-catch success bonus is applied, exactly the destroy percentages that
 * starforce.tadeucci.dev displays (e.g. 18->19 Mode 2: (1 - 0.12*1.05) * 0.05 =
 * 4.37%). That is strong corroboration, but both could descend from one upstream data
 * dump and no Nexon-primary confirmation was obtainable, so MODE 2-4 ROWS SHIP
 * `verified: false` and any SimResult that touches them names "enhancement-mode-rates"
 * in `unverified[]`. The UI must show its UNVERIFIED RATES banner in that case.
 * Nothing here is averaged, interpolated or guessed; rows are transcribed or absent.
 *
 * TO CLOSE THIS: one screenshot of the in-game enhancement window at 18 stars showing
 * the four modes' success and destroy percentages promotes these rows to
 * "nexon-primary" and the banner disappears.
 */
export const ENHANCEMENT_MODE_QUESTION = {
  resolved: "partially",
  modeRateProvenance: "community-single" as Provenance,
  needed: "In-game screenshot of the 18-star enhancement window, or the v.271 notes.",
} as const;

/* ------------------------------------------------------------------ *
 * 1. The rate table
 * ------------------------------------------------------------------ */

export type EnhancementMode = 1 | 2 | 3 | 4;

/**
 * One (from-star, mode) pair.
 *
 * `success` + `fail` + `boom` sum to 1 and are ABSOLUTE per-attempt probabilities,
 * matching what the guide table displays. The game itself stores destruction as a
 * rate conditional on failure - boom = (1 - success) * conditionalDestroy - which is
 * why the published numbers are odd-looking values like 2.1% and 6.8%. Both forms are
 * kept: the absolute one for display, the conditional one because every runtime
 * modifier (star catching, destruction-reduction events) acts on the conditional form.
 */
export interface StarRow {
  /** Star you are attempting to leave. 0 means the 0 -> 1 tap. */
  from: number;
  mode: EnhancementMode;
  success: number;
  fail: number;
  boom: number;
  /** Destroy chance conditional on the attempt not succeeding. */
  conditionalDestroy: number;
  /** Cost multiplier of this mode against the base attempt cost. Mode 1 is 1. */
  costMult: number;
  /**
   * True where the boom-free option is classic Safeguard rather than a mode, which
   * changes how costMult combines with other multipliers (additive, not multiplicative).
   */
  safeguardStyle: boolean;
  /** Star the item returns at after a boom + Trace restore. 0 below 15 (cannot boom). */
  traceRecoveryStar: number;
  verified: boolean;
  provenance: Provenance;
  sourceUrl: string;
}

interface BaseStar {
  success: number;
  /** Conditional on failure. 0 below 15 stars - items cannot be destroyed there. */
  destroy: number;
  destroyStar: number;
  safeguardStyle: boolean;
  modes?: Record<2 | 3 | 4, { success: number; destroy: number; cost: number }>;
}

/**
 * Mode 1 column: identical to data/guide-graph.json#starforce.rates, to DigitalTQ, and
 * to the blushiemagic table. Three sources, exact agreement -> cross-checked.
 *
 * Trace recovery stars (destroyStar) also match the guide's own rules node:
 * 15-19 -> 12, 20 -> 15, 21-22 -> 17, 23-25 -> 19, 26-30 -> 20.
 *
 * Since v.264 an item can no longer LOSE a star on failure, so a failed attempt is a
 * pure meso loss and every tap is a simple three-outcome draw.
 */
const BASE: Record<number, BaseStar> = {
  0: { success: 0.95, destroy: 0, destroyStar: 0, safeguardStyle: false },
  1: { success: 0.9, destroy: 0, destroyStar: 0, safeguardStyle: false },
  2: { success: 0.85, destroy: 0, destroyStar: 0, safeguardStyle: false },
  3: { success: 0.85, destroy: 0, destroyStar: 0, safeguardStyle: false },
  4: { success: 0.8, destroy: 0, destroyStar: 0, safeguardStyle: false },
  5: { success: 0.75, destroy: 0, destroyStar: 0, safeguardStyle: false },
  6: { success: 0.7, destroy: 0, destroyStar: 0, safeguardStyle: false },
  7: { success: 0.65, destroy: 0, destroyStar: 0, safeguardStyle: false },
  8: { success: 0.6, destroy: 0, destroyStar: 0, safeguardStyle: false },
  9: { success: 0.55, destroy: 0, destroyStar: 0, safeguardStyle: false },
  10: { success: 0.5, destroy: 0, destroyStar: 0, safeguardStyle: false },
  11: { success: 0.45, destroy: 0, destroyStar: 0, safeguardStyle: false },
  12: { success: 0.4, destroy: 0, destroyStar: 0, safeguardStyle: false },
  13: { success: 0.35, destroy: 0, destroyStar: 0, safeguardStyle: false },
  14: { success: 0.3, destroy: 0, destroyStar: 0, safeguardStyle: false },
  15: {
    success: 0.3,
    destroy: 0.03,
    destroyStar: 12,
    safeguardStyle: true,
    modes: {
      2: { success: 0.3, destroy: 0.02, cost: 1.5 },
      3: { success: 0.3, destroy: 0.01, cost: 2.5 },
      4: { success: 0.3, destroy: 0, cost: 3 },
    },
  },
  16: {
    success: 0.3,
    destroy: 0.03,
    destroyStar: 12,
    safeguardStyle: true,
    modes: {
      2: { success: 0.3, destroy: 0.02, cost: 1.5 },
      3: { success: 0.3, destroy: 0.01, cost: 2.5 },
      4: { success: 0.3, destroy: 0, cost: 3 },
    },
  },
  17: {
    success: 0.15,
    destroy: 0.08,
    destroyStar: 12,
    safeguardStyle: true,
    modes: {
      2: { success: 0.15, destroy: 0.05, cost: 1.5 },
      3: { success: 0.15, destroy: 0.02, cost: 2.5 },
      4: { success: 0.15, destroy: 0, cost: 3 },
    },
  },
  18: {
    success: 0.15,
    destroy: 0.08,
    destroyStar: 12,
    safeguardStyle: false,
    modes: {
      2: { success: 0.12, destroy: 0.05, cost: 2 },
      3: { success: 0.1, destroy: 0.02, cost: 3.5 },
      4: { success: 0.08, destroy: 0, cost: 6.5 },
    },
  },
  19: {
    success: 0.15,
    destroy: 0.1,
    destroyStar: 12,
    safeguardStyle: false,
    modes: {
      2: { success: 0.12, destroy: 0.07, cost: 2 },
      3: { success: 0.1, destroy: 0.04, cost: 3.5 },
      4: { success: 0.08, destroy: 0, cost: 6.5 },
    },
  },
  20: {
    success: 0.3,
    destroy: 0.15,
    destroyStar: 15,
    safeguardStyle: false,
    modes: {
      2: { success: 0.25, destroy: 0.1, cost: 2 },
      3: { success: 0.2, destroy: 0.05, cost: 3.5 },
      4: { success: 0.15, destroy: 0, cost: 6.5 },
    },
  },
  21: {
    success: 0.15,
    destroy: 0.15,
    destroyStar: 17,
    safeguardStyle: false,
    modes: {
      2: { success: 0.12, destroy: 0.1, cost: 2 },
      3: { success: 0.1, destroy: 0.05, cost: 3.5 },
      4: { success: 0.08, destroy: 0, cost: 6.5 },
    },
  },
  22: { success: 0.15, destroy: 0.2, destroyStar: 17, safeguardStyle: false },
  23: { success: 0.1, destroy: 0.2, destroyStar: 19, safeguardStyle: false },
  24: { success: 0.1, destroy: 0.2, destroyStar: 19, safeguardStyle: false },
  25: { success: 0.1, destroy: 0.2, destroyStar: 19, safeguardStyle: false },
  26: { success: 0.07, destroy: 0.2, destroyStar: 20, safeguardStyle: false },
  27: { success: 0.05, destroy: 0.2, destroyStar: 20, safeguardStyle: false },
  28: { success: 0.03, destroy: 0.2, destroyStar: 20, safeguardStyle: false },
  29: { success: 0.01, destroy: 0.2, destroyStar: 20, safeguardStyle: false },
};

/** Star force stops here. 30 is the game-wide ceiling; item level caps it lower. */
export const STAR_FORCE_HARD_CAP = 30;

/** 0.85 * 0.08 is 0.068000000000000005 and renders horribly. */
function r6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function buildRows(): StarRow[] {
  const rows: StarRow[] = [];
  for (let from = 0; from < STAR_FORCE_HARD_CAP; from++) {
    const b = BASE[from];
    const boom = r6((1 - b.success) * b.destroy);
    rows.push({
      from,
      mode: 1,
      success: r6(b.success),
      fail: r6(1 - b.success - boom),
      boom,
      conditionalDestroy: b.destroy,
      costMult: 1,
      safeguardStyle: b.safeguardStyle,
      traceRecoveryStar: b.destroyStar,
      verified: true,
      provenance: "community-cross-checked",
      sourceUrl: SOURCES.digitalTq,
    });
    if (!b.modes) continue;
    for (const m of [2, 3, 4] as const) {
      const cfg = b.modes[m];
      const mBoom = r6((1 - cfg.success) * cfg.destroy);
      rows.push({
        from,
        mode: m,
        success: r6(cfg.success),
        fail: r6(1 - cfg.success - mBoom),
        boom: mBoom,
        conditionalDestroy: cfg.destroy,
        costMult: cfg.cost,
        safeguardStyle: b.safeguardStyle,
        traceRecoveryStar: b.destroyStar,
        verified: false, // see ENHANCEMENT_MODE_QUESTION
        provenance: "community-single",
        sourceUrl: SOURCES.blushiemagic,
      });
    }
  }
  return rows;
}

/** The single source of truth. Render the guide table from this, not from JSON strings. */
export const STAR_ROWS: readonly StarRow[] = buildRows();

/** Mode-1 rows only, in star order - the shape the guide table wants. */
export const STAR_ROWS_MODE1: readonly StarRow[] = STAR_ROWS.filter((r) => r.mode === 1);

export function rowFor(from: number, mode: EnhancementMode): StarRow {
  const exact = STAR_ROWS.find((r) => r.from === from && r.mode === mode);
  if (exact) return exact;
  const base = STAR_ROWS.find((r) => r.from === from && r.mode === 1);
  if (!base) throw new RangeError(`No star force row for star ${from} (valid: 0-29).`);
  // Asking for mode 3 at 22 stars is not a caller error, the game just has no modes there.
  return base;
}

/** Modes the player actually gets to choose between at this star. */
export function modesAvailableAt(from: number): EnhancementMode[] {
  return STAR_ROWS.filter((r) => r.from === from).map((r) => r.mode);
}

/** Trace recovery star after a boom, straight out of the guide's rules node. */
export function traceRecoveryStar(from: number): number {
  const b = BASE[from];
  return b ? b.destroyStar : 0;
}

/**
 * Star cap by item level. Mirrors sfCap() in lib/rules.ts, duplicated rather than
 * imported so this module stays dependency-free and testable in isolation.
 * Superior equipment caps at 15 and uses a harsher table that is NOT modelled here.
 */
export function maxStarsForLevel(itemLevel: number): number {
  if (itemLevel >= 138) return 30;
  if (itemLevel >= 129) return 20;
  if (itemLevel >= 118) return 15;
  if (itemLevel >= 108) return 10;
  if (itemLevel >= 95) return 8;
  return 5;
}

/* ------------------------------------------------------------------ *
 * 2. Runtime rate modifiers
 * ------------------------------------------------------------------ */

export interface SfEvents {
  /** 100% success at the 5, 10 and 15 star taps. */
  five10Fifteen: boolean;
  /** 30% off meso cost. */
  discount30: boolean;
  /** Destroy chance x0.7, below 22 stars only. */
  destructionReduction: boolean;
  /** Success below 11 stars grants an extra star ("1+1"). */
  doubleStar: boolean;
}

export const NO_EVENTS: SfEvents = {
  five10Fifteen: false,
  discount30: false,
  destructionReduction: false,
  doubleStar: false,
};

/**
 * Star catching multiplies success by 1.05. v.271 removed the minigame and applies the
 * bonus automatically to every attempt, so this defaults ON and has no user toggle - a
 * toggle would only let a player compute a number the game will never give them.
 *
 * Cross-checked, and unusually well: blushiemagic applies `success *= 1.05`, and
 * starforce.tadeucci.dev's displayed destroy percentages are only reproducible if the
 * same 1.05 is applied first (15->16 Mode 1: (1 - 0.30*1.05) * 0.03 = 2.055%).
 */
export const STAR_CATCH_SUCCESS_MULTIPLIER = 1.05;
export const STAR_CATCH_PROVENANCE: Provenance = "community-cross-checked";

/** Destruction-reduction events scale the conditional destroy rate, below 22 stars. */
export const DESTRUCTION_REDUCTION_MULTIPLIER = 0.7;
export const DESTRUCTION_REDUCTION_MAX_STAR = 22;
export const DESTRUCTION_REDUCTION_PROVENANCE: Provenance = "community-single";

/** "1+1": a success landing on star <= 10 is bumped one further. */
export const DOUBLE_STAR_MAX_RESULT_STAR = 10;
export const DOUBLE_STAR_PROVENANCE: Provenance = "community-single";

/** 100% success taps under the 5/10/15 event. */
export const GUARANTEED_STARS: readonly number[] = [5, 10, 15];

export interface EffectiveRates {
  success: number;
  fail: number;
  boom: number;
  /** True when the 5/10/15 event made this tap risk-free. */
  guaranteed: boolean;
}

/**
 * Absolute per-attempt probabilities for one tap, after star catching and events.
 * Exported because the /starforce page should show the player the exact three numbers
 * it is about to roll against.
 */
export function effectiveRates(
  from: number,
  mode: EnhancementMode,
  events: SfEvents,
  opts: { starCatch?: boolean } = {},
): EffectiveRates {
  const row = rowFor(from, mode);
  if (events.five10Fifteen && GUARANTEED_STARS.includes(from)) {
    return { success: 1, fail: 0, boom: 0, guaranteed: true };
  }
  const catching = opts.starCatch !== false;
  const success = Math.min(1, row.success * (catching ? STAR_CATCH_SUCCESS_MULTIPLIER : 1));
  let destroy = row.conditionalDestroy;
  if (events.destructionReduction && from < DESTRUCTION_REDUCTION_MAX_STAR) {
    destroy *= DESTRUCTION_REDUCTION_MULTIPLIER;
  }
  const boom = (1 - success) * destroy;
  return { success, fail: 1 - success - boom, boom, guaranteed: false };
}

/* ------------------------------------------------------------------ *
 * 3. The meso cost model
 * ------------------------------------------------------------------ */

export type MvpTier = "none" | "silver" | "gold" | "diamond";

/**
 * Every constant in the cost model, named and exported. Nothing below is an inline
 * literal in an expression: if a number here is wrong, exactly one line changes.
 *
 * Shape of the formula, transcribed from blushiemagic's getPrice():
 *
 *   L     = floor(itemLevel / 10) * 10        // level rounds DOWN to a ten
 *   base  = L^3 * (star + 1)     / 2500       // stars 0-9
 *   base  = L^3 * (star + 1)^2.7 / d[star]    // stars 10+, divisor varies per star
 *   mesos = (round(base) + 10) * 100
 *   mesos *= mvp (stars < 17) * 0.7 (discount event) * mode/safeguard multiplier
 *
 * UNVERIFIED. One public source for the divisors, and StrategyWiki's statement that
 * server costs "vary slightly at lower levels but equalise from 15 stars onwards" is
 * the only thing said about Reboot at all - no Reboot multiplier could be sourced in
 * either direction. So 15+ is treated as server-agnostic (that part is sourced) and
 * anything below 15 stars carries rebootMultiplier, which is 1 and flagged. Every
 * result that consumed a soft constant names it in SimResult.unverified.
 */
export const SF_COST = {
  base: {
    levelExponent: 3,
    /** Exponent on (star + 1) below 10 stars. */
    starExponent: 1,
    /** Exponent on (star + 1) from 10 stars up. The famous 2.7. */
    highStarExponent: 2.7,
    /** Divisor for stars 0-9. Kept here because the spec names it `divisor`. */
    divisor: 2500,
    /** Added after rounding, before the x100 scale. */
    constant: 10,
    /** Costs are quoted in hundreds of mesos. */
    mesoScale: 100,
    /** Item level rounds down to a multiple of this before cubing. */
    levelFloorStep: 10,
  },
  /**
   * Coarse bands, because callers ask for them by these names; only 0-9 is a single
   * number. 10-14 and 15+ genuinely differ per star, so they are null here and the
   * real values live in perStarDivisor. A null read at call time throws by name.
   */
  bandDivisors: {
    "0-9": 2500 as number | null,
    "10-14": null as number | null,
    "15-plus": null as number | null,
  },
  /** Divisor by from-star, stars 10-29. Nulls throw rather than coerce to 0. */
  perStarDivisor: {
    10: 40000,
    11: 22000,
    12: 15000,
    13: 11000,
    14: 7500,
    15: 20000,
    16: 20000,
    17: 15000,
    18: 7000,
    19: 4500,
    20: 20000,
    21: 12500,
    22: 20000,
    23: 20000,
    24: 20000,
    25: 20000,
    26: 20000,
    27: 20000,
    28: 20000,
    29: 20000,
  } as Record<number, number | null>,
  /**
   * Reboot/Heroic adjustment below 15 stars. Sources say server costs differ "slightly"
   * at low levels without saying how, so this is 1 and loudly unverified rather than a
   * guess. At 15 stars and up, sources agree the servers are identical.
   */
  rebootMultiplier: 1 as number | null,
  rebootMultiplierAppliesBelowStar: 15,
  /**
   * Classic Safeguard's multiplier at 15-17 stars, applied ADDITIVELY
   * (multiplier += safeguardMultiplier - 1) so it stacks with the 30%-off event the
   * way the game does. Note the shipped guide text says Safeguard "doubles" the cost
   * while the calculator source says x3 additive. Unresolved, hence unverified.
   */
  safeguardMultiplier: 3 as number | null,
  /** MVP star force discount. Applies to stars below 17 only. */
  mvpMultiplier: { none: 1, silver: 0.97, gold: 0.95, diamond: 0.9 } as Record<MvpTier, number>,
  mvpMaxStar: 17,
  /** 30%-off event. */
  discount30Multiplier: 0.7,
  verified: false,
  provenance: "community-single" as Provenance,
  source: SOURCES.blushiemagic,
};

/**
 * Whether MVP tiers apply in Heroic at all could not be confirmed: MVP is an NX-spend
 * status and the wiki does not carve Reboot out, but nor does it say it applies.
 * Default 'none' so the common case never silently under-quotes a cost.
 */
export const MVP_IN_HEROIC_PROVENANCE: Provenance = "community-single";

/** Names of soft constants, so a result can list exactly what it leaned on. */
export type UnverifiedConstant =
  | "meso-cost-formula"
  | "reboot-sub15-multiplier"
  | "safeguard-multiplier"
  | "mvp-discount-in-heroic"
  | "enhancement-mode-rates"
  | "destruction-reduction-multiplier"
  | "double-star-event-rule"
  | "chance-time-mechanic"
  | "star-force-stat-gain";

/** Human-readable text for the UNVERIFIED banner. */
export const UNVERIFIED_LABEL: Record<UnverifiedConstant, string> = {
  "meso-cost-formula":
    "Meso cost formula (one community source; not confirmed against patch notes)",
  "reboot-sub15-multiplier":
    "Reboot cost difference below 15 stars (sources say servers differ 'slightly' but not how)",
  "safeguard-multiplier": "Safeguard cost multiplier (guide says x2, calculator says x3 additive)",
  "mvp-discount-in-heroic": "Whether MVP star force discounts apply in Heroic",
  "enhancement-mode-rates": "Enhancement Mode 2-4 success/destroy rates",
  "destruction-reduction-multiplier": "Destruction-reduction event multiplier",
  "double-star-event-rule": "1+1 star event cutoff",
  "chance-time-mechanic": "Chance time / pity (may not exist post-v.264)",
  "star-force-stat-gain": "ATT gained per star (stat tables could not be fetched)",
};

function requireConstant(name: string, value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw new Error(
      `Star force constant "${name}" is not set. It is a documented input in SF_COST ` +
        `and has no sourced value yet - refusing to invent one.`,
    );
  }
  return value;
}

export interface CostOpts {
  safeguard: boolean;
  mode: EnhancementMode;
  discount30: boolean;
  mvpTier: MvpTier;
}

export interface CostResult {
  mesos: number;
  verified: boolean;
  unverified: UnverifiedConstant[];
}

/**
 * Meso cost of ONE attempt at `currentStar` on an item of `itemLevel`.
 *
 * `safeguard: true` means "use the boom-free option where one exists", which at 15-17
 * stars is classic Safeguard (additive cost) and at 18-21 stars is Mode 4. If both
 * `safeguard` and an explicit mode are passed, safeguard wins where it exists and the
 * mode stands everywhere else.
 */
export function costPerAttempt(
  itemLevel: number,
  currentStar: number,
  opts: CostOpts,
): CostResult {
  if (!Number.isFinite(itemLevel) || itemLevel <= 0) {
    throw new RangeError(`itemLevel must be a positive number, got ${itemLevel}.`);
  }
  if (currentStar < 0 || currentStar >= STAR_FORCE_HARD_CAP) {
    throw new RangeError(`currentStar must be 0-29, got ${currentStar}.`);
  }
  const unverified: UnverifiedConstant[] = ["meso-cost-formula"];

  const L = Math.floor(itemLevel / SF_COST.base.levelFloorStep) * SF_COST.base.levelFloorStep;
  const levelTerm = Math.pow(L, SF_COST.base.levelExponent);

  let base: number;
  if (currentStar < 10) {
    base =
      (levelTerm * Math.pow(currentStar + 1, SF_COST.base.starExponent)) /
      requireConstant("SF_COST.bandDivisors['0-9']", SF_COST.bandDivisors["0-9"]);
  } else {
    const divisor = requireConstant(
      `SF_COST.perStarDivisor[${currentStar}]`,
      SF_COST.perStarDivisor[currentStar],
    );
    base = (levelTerm * Math.pow(currentStar + 1, SF_COST.base.highStarExponent)) / divisor;
  }
  let mesos = (Math.round(base) + SF_COST.base.constant) * SF_COST.base.mesoScale;

  if (currentStar < SF_COST.rebootMultiplierAppliesBelowStar) {
    mesos *= requireConstant("SF_COST.rebootMultiplier", SF_COST.rebootMultiplier);
    unverified.push("reboot-sub15-multiplier");
  }

  let multiplier = 1;
  if (currentStar < SF_COST.mvpMaxStar && opts.mvpTier !== "none") {
    multiplier = SF_COST.mvpMultiplier[opts.mvpTier];
    unverified.push("mvp-discount-in-heroic");
  }
  if (opts.discount30) multiplier *= SF_COST.discount30Multiplier;

  const row = rowFor(currentStar, opts.mode);
  if (opts.safeguard && row.safeguardStyle) {
    // Classic Safeguard is additive with the discount event, which is why a 30%-off
    // safeguarded tap is 2.7x base and not 2.1x.
    multiplier += requireConstant("SF_COST.safeguardMultiplier", SF_COST.safeguardMultiplier) - 1;
    unverified.push("safeguard-multiplier");
  } else if (opts.mode !== 1) {
    multiplier *= row.costMult;
    unverified.push("enhancement-mode-rates");
  } else if (opts.safeguard && modesAvailableAt(currentStar).includes(4)) {
    // Safeguard requested where the boom-free option is Mode 4 rather than Safeguard.
    multiplier *= rowFor(currentStar, 4).costMult;
    unverified.push("enhancement-mode-rates");
  }

  return {
    mesos: Math.round(mesos * multiplier),
    // The formula itself is single-sourced. Never claim otherwise, whatever else is true.
    verified: false,
    unverified,
  };
}

/* ------------------------------------------------------------------ *
 * 4. The simulator
 * ------------------------------------------------------------------ */

/** Deterministic RNG so any reported number can be reproduced exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StarPlanEntry {
  mode: EnhancementMode;
  safeguard: boolean;
}

/**
 * Chance time / pity. A Nexon support article states two consecutive failures make the
 * next attempt a guaranteed success, but that article predates v.264 (which removed
 * star-down entirely, and chance time historically triggered on star-DOWNs, not plain
 * failures). Unresolvable from public sources, so it DEFAULTS OFF: modelling a pity
 * that does not exist under-quotes the cost, and under-quoting is the direction that
 * costs a real player real mesos.
 */
export interface ChanceTimeRule {
  enabled: boolean;
  consecutiveFails: number;
  /** Highest from-star at which pity applies. */
  maxStar: number;
}

export const CHANCE_TIME_DEFAULT: ChanceTimeRule = {
  enabled: false,
  consecutiveFails: 2,
  maxStar: 14,
};
export const CHANCE_TIME_PROVENANCE: Provenance = "community-single";

export interface SimInput {
  itemLevel: number;
  from: number;
  to: number;
  /** Replacement copies available for Trace restore. A boom with none left ends the run. */
  spares: number;
  /** Per from-star mode/safeguard choice. Missing stars default to mode 1, no safeguard. */
  perStarPlan: Record<number, StarPlanEntry>;
  events: SfEvents;
  trials: number;
  mvpTier?: MvpTier;
  /** v.271 applies star catching automatically; only unset this to model an older client. */
  starCatch?: boolean;
  chanceTime?: ChanceTimeRule;
  /**
   * Meso cost of acquiring one replacement item, charged when a spare is consumed.
   * NOT a game constant - it is whatever the player's own copy costs them. Default 0.
   */
  spareCostMesos?: number;
  rng?: () => number;
}

export interface HistogramBin {
  start: number;
  end: number;
  count: number;
}

export interface SimResult {
  meanCost: number;
  medianCost: number;
  p10Cost: number;
  p75Cost: number;
  p90Cost: number;
  p99Cost: number;
  meanBooms: number;
  /** boomDistribution[k] = probability of exactly k booms. */
  boomDistribution: number[];
  /** Probability of at least one boom. The number that should scare people. */
  pAnyBoom: number;
  pFailedToReachTarget: number;
  /**
   * Cost statistics over the runs that ACTUALLY reached the target. When spares run
   * out, an abandoned run stops spending, which drags the headline mean down: quoting
   * 6B while 60% of runs never got there is the exact lie this tool exists to stop.
   * null when no run reached the target.
   */
  meanCostGivenReached: number | null;
  medianCostGivenReached: number | null;
  p90CostGivenReached: number | null;
  meanAttempts: number;
  medianAttempts: number;
  /** Standard error of meanCost. Print it: a number with no error bar cannot be trusted. */
  standardError: number;
  relativeStandardError: number;
  trials: number;
  /** Cost histogram for the distribution plot - the p50/p90 gap is the whole point. */
  histogram: HistogramBin[];
  verified: boolean;
  unverified: UnverifiedConstant[];
  /** Assumptions worth printing next to the numbers. */
  notes: string[];
}

/** Runaway guard. A real run never approaches this; an impossible plan would spin forever. */
const MAX_ATTEMPTS_PER_TRIAL = 100000;

function planFor(plan: Record<number, StarPlanEntry>, star: number): StarPlanEntry {
  const p = plan[star];
  return p ? p : { mode: 1, safeguard: false };
}

function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function buildHistogram(sorted: Float64Array, bins: number): HistogramBin[] {
  if (sorted.length === 0) return [];
  const lo = sorted[0];
  // Clip at p99 so one catastrophic trial does not flatten the entire chart.
  const hi = Math.max(percentile(sorted, 0.99), lo + 1);
  const width = (hi - lo) / bins;
  const out: HistogramBin[] = [];
  for (let i = 0; i < bins; i++) {
    out.push({ start: lo + i * width, end: lo + (i + 1) * width, count: 0 });
  }
  for (let i = 0; i < sorted.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((sorted[i] - lo) / width)));
    out[b].count++;
  }
  return out;
}

function emptyResult(trials: number, notes: string[]): SimResult {
  return {
    meanCost: 0,
    medianCost: 0,
    p10Cost: 0,
    p75Cost: 0,
    p90Cost: 0,
    p99Cost: 0,
    meanBooms: 0,
    boomDistribution: [1],
    pAnyBoom: 0,
    pFailedToReachTarget: 0,
    meanCostGivenReached: 0,
    medianCostGivenReached: 0,
    p90CostGivenReached: 0,
    meanAttempts: 0,
    medianAttempts: 0,
    standardError: 0,
    relativeStandardError: 0,
    trials,
    histogram: [],
    verified: true,
    unverified: [],
    notes,
  };
}

/**
 * One trial = tap until the target star, or until a boom lands with no spare left.
 *
 * The boom branch is exactly why the mean is a lie: it is a jump back to the Trace
 * recovery star (12, 15, 17, 19 or 20) and everything above it has to be re-bought.
 * That branch is simulated, never approximated.
 */
export function simulate(input: SimInput): SimResult {
  const {
    itemLevel,
    from,
    to,
    spares,
    perStarPlan,
    events,
    trials,
    mvpTier = "none",
    starCatch = true,
    spareCostMesos = 0,
    rng = Math.random,
  } = input;
  const chanceTime = input.chanceTime ?? CHANCE_TIME_DEFAULT;

  const notes: string[] = [];
  const unverified = new Set<UnverifiedConstant>();

  if (!Number.isInteger(trials) || trials <= 0) {
    throw new RangeError(`trials must be a positive integer, got ${trials}.`);
  }
  if (from < 0 || to > STAR_FORCE_HARD_CAP || from > to) {
    throw new RangeError(`Invalid star range ${from} -> ${to}.`);
  }
  if (spares < 0) throw new RangeError(`spares cannot be negative, got ${spares}.`);

  const cap = maxStarsForLevel(itemLevel);
  if (to > cap) {
    notes.push(`A level ${itemLevel} item caps at ${cap} stars; target ${to} is above that.`);
  }
  if (events.destructionReduction) unverified.add("destruction-reduction-multiplier");
  if (events.doubleStar) unverified.add("double-star-event-rule");
  if (chanceTime.enabled) {
    unverified.add("chance-time-mechanic");
    notes.push(
      "Chance time is ON. Its existence post-v.264 is unconfirmed; these costs may be optimistic.",
    );
  }
  if (mvpTier !== "none") {
    notes.push("MVP discount applied. Whether MVP discounts apply in Heroic is unconfirmed.");
  }
  if (starCatch) {
    notes.push("Star catching applied automatically (x1.05 success), per v.271.");
  }

  if (from >= to) return emptyResult(trials, notes);

  // Attempt cost does not vary within a run, so pay for it once. Stars below `from`
  // also need a price: a boom drops the item back beneath the starting point.
  const costAt = new Float64Array(STAR_FORCE_HARD_CAP);
  for (let s = 0; s < to; s++) {
    const p = planFor(perStarPlan, s);
    const c = costPerAttempt(itemLevel, s, {
      safeguard: p.safeguard,
      mode: p.mode,
      discount30: events.discount30,
      mvpTier,
    });
    costAt[s] = c.mesos;
    for (const u of c.unverified) unverified.add(u);
  }

  // Per-star outcome thresholds: roll < succAt -> success, < boomEdge -> boom, else fail.
  const succAt = new Float64Array(STAR_FORCE_HARD_CAP);
  const boomEdge = new Float64Array(STAR_FORCE_HARD_CAP);
  for (let s = 0; s < to; s++) {
    const p = planFor(perStarPlan, s);
    const mode: EnhancementMode =
      p.safeguard && !rowFor(s, 1).safeguardStyle && modesAvailableAt(s).includes(4)
        ? 4
        : p.mode;
    if (mode !== 1) unverified.add("enhancement-mode-rates");
    const e = effectiveRates(s, mode, events, { starCatch });
    // Safeguard at 15-17 is the same rates with boom removed, at Safeguard's own price.
    const safeguarded = p.safeguard && rowFor(s, 1).safeguardStyle;
    succAt[s] = e.success;
    boomEdge[s] = safeguarded ? e.success : e.success + e.boom;
  }

  const costs = new Float64Array(trials);
  const attemptsArr = new Float64Array(trials);
  const reachedCosts = new Float64Array(trials);
  let reachedCount = 0;
  const boomCounts: number[] = [];
  let boomSum = 0;
  let attemptSum = 0;
  let failedRuns = 0;

  for (let t = 0; t < trials; t++) {
    let star = from;
    let mesos = 0;
    let booms = 0;
    let attempts = 0;
    let sparesLeft = spares;
    let consecutiveFails = 0;
    let aborted = false;

    while (star < to) {
      if (attempts >= MAX_ATTEMPTS_PER_TRIAL) {
        aborted = true;
        break;
      }
      mesos += costAt[star];
      attempts++;

      const pity =
        chanceTime.enabled &&
        consecutiveFails >= chanceTime.consecutiveFails &&
        star <= chanceTime.maxStar;

      const roll = pity ? -1 : rng();
      if (roll < succAt[star]) {
        star++;
        if (events.doubleStar && star <= DOUBLE_STAR_MAX_RESULT_STAR) star++;
        consecutiveFails = 0;
      } else if (roll < boomEdge[star]) {
        booms++;
        if (sparesLeft <= 0) {
          aborted = true;
          break;
        }
        sparesLeft--;
        mesos += spareCostMesos;
        star = traceRecoveryStar(star);
        consecutiveFails = 0;
      } else {
        consecutiveFails++;
      }
    }

    costs[t] = mesos;
    attemptsArr[t] = attempts;
    attemptSum += attempts;
    boomSum += booms;
    boomCounts[booms] = (boomCounts[booms] ?? 0) + 1;
    if (aborted) {
      failedRuns++;
    } else {
      reachedCosts[reachedCount++] = mesos;
    }
  }

  let sum = 0;
  for (let i = 0; i < trials; i++) sum += costs[i];
  const mean = sum / trials;
  let varSum = 0;
  for (let i = 0; i < trials; i++) {
    const d = costs[i] - mean;
    varSum += d * d;
  }
  const variance = trials > 1 ? varSum / (trials - 1) : 0;
  const standardError = Math.sqrt(variance / trials);

  // Float64Array.sort is numeric by default, unlike Array.prototype.sort.
  const sortedCosts = costs.slice().sort();
  const sortedAttempts = attemptsArr.slice().sort();

  const boomDistribution: number[] = [];
  for (let k = 0; k < boomCounts.length; k++) {
    boomDistribution[k] = (boomCounts[k] ?? 0) / trials;
  }
  const pAnyBoom = 1 - (boomDistribution[0] ?? 0);

  const sortedReached = reachedCosts.slice(0, reachedCount).sort();
  let reachedSum = 0;
  for (let i = 0; i < reachedCount; i++) reachedSum += sortedReached[i];

  if (spares === 0 && boomEdge[from] > succAt[from]) {
    notes.push(
      "With 0 spares a single boom ends the run - read pFailedToReachTarget, not just the mean.",
    );
  }
  if (failedRuns / trials > 0.02) {
    notes.push(
      `${Math.round((failedRuns / trials) * 100)}% of runs ran out of spares before reaching ` +
        `${to} stars. The headline mean includes those abandoned runs and is therefore LOWER ` +
        `than what actually getting there costs - use the "given reached" figures for that.`,
    );
  }

  return {
    meanCost: mean,
    medianCost: percentile(sortedCosts, 0.5),
    p10Cost: percentile(sortedCosts, 0.1),
    p75Cost: percentile(sortedCosts, 0.75),
    p90Cost: percentile(sortedCosts, 0.9),
    p99Cost: percentile(sortedCosts, 0.99),
    meanBooms: boomSum / trials,
    boomDistribution,
    pAnyBoom,
    pFailedToReachTarget: failedRuns / trials,
    meanCostGivenReached: reachedCount > 0 ? reachedSum / reachedCount : null,
    medianCostGivenReached: reachedCount > 0 ? percentile(sortedReached, 0.5) : null,
    p90CostGivenReached: reachedCount > 0 ? percentile(sortedReached, 0.9) : null,
    meanAttempts: attemptSum / trials,
    medianAttempts: percentile(sortedAttempts, 0.5),
    standardError,
    relativeStandardError: mean > 0 ? standardError / mean : 0,
    trials,
    histogram: buildHistogram(sortedCosts, 40),
    verified: unverified.size === 0,
    unverified: [...unverified],
    notes,
  };
}

/**
 * Raidbots' Smart Sim pattern: keep adding trials until the mean's relative standard
 * error is under the target, then print that error bar next to the number. Star force
 * at 20+ is heavy-tailed, so a fixed trial count silently delivers different precision
 * for different ranges. This does not.
 */
export function simulateAdaptive(
  input: SimInput,
  opts: { targetRelStdErr?: number; maxTrials?: number; batch?: number } = {},
): SimResult {
  const target = opts.targetRelStdErr ?? 0.005; // 0.5%
  const maxTrials = opts.maxTrials ?? 2000000;
  const batch = opts.batch ?? Math.max(10000, input.trials);

  let trials = Math.min(batch, maxTrials);
  let res = simulate({ ...input, trials });
  while (res.relativeStandardError > target && trials < maxTrials) {
    trials = Math.min(trials * 2, maxTrials);
    res = simulate({ ...input, trials });
  }
  if (res.relativeStandardError > target) {
    res.notes.push(
      `Still +/-${(res.relativeStandardError * 100).toFixed(2)}% after ` +
        `${trials.toLocaleString()} trials - this range is genuinely that volatile.`,
    );
  }
  return res;
}

/** Default trial count. 100k of this loop is milliseconds of JS and needs no server. */
export const DEFAULT_TRIALS = 100000;

/* ------------------------------------------------------------------ *
 * 5. Formatting, so every consumer quotes the same numbers
 * ------------------------------------------------------------------ */

export function formatMesos(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}`;
}

/** The error bar, Raidbots style: "4.1B +/-0.31%". */
export function formatWithError(res: SimResult): string {
  return `${formatMesos(res.meanCost)} +/-${(res.relativeStandardError * 100).toFixed(2)}%`;
}

/**
 * The sentence lib/rules.ts should emit instead of "Next milestone is 22.":
 * "16 -> 22: 4.1B expected, 2.9B median, 11.3B at p90, 86% chance of at least one boom."
 */
export function summarizeRange(res: SimResult, from: number, to: number): string {
  const boom =
    res.pAnyBoom > 0
      ? `, ${Math.round(res.pAnyBoom * 100)}% chance of at least one boom`
      : ", no boom risk";
  const abandoned =
    res.pFailedToReachTarget > 0.02
      ? ` ${Math.round(res.pFailedToReachTarget * 100)}% of runs ran out of spares first.`
      : "";
  return (
    `${from} -> ${to}: ${formatMesos(res.meanCost)} expected, ` +
    `${formatMesos(res.medianCost)} median, ${formatMesos(res.p90Cost)} at p90${boom}.${abandoned}`
  );
}

/** Safeguard/Mode 4 wherever a boom-free option exists, mode 1 elsewhere. */
export function safeguardEverywherePlan(from: number, to: number): Record<number, StarPlanEntry> {
  const plan: Record<number, StarPlanEntry> = {};
  for (let s = from; s < to; s++) {
    const hasBoomFree = modesAvailableAt(s).includes(4);
    plan[s] = { mode: hasBoomFree ? 4 : 1, safeguard: hasBoomFree };
  }
  return plan;
}

/** Cheapest plan: never pay for protection. */
export function mode1Plan(from: number, to: number): Record<number, StarPlanEntry> {
  const plan: Record<number, StarPlanEntry> = {};
  for (let s = from; s < to; s++) plan[s] = { mode: 1, safeguard: false };
  return plan;
}

/* ------------------------------------------------------------------ *
 * 6. The ranking layer - the Droptimizer analogue
 * ------------------------------------------------------------------ */

/**
 * Structural shapes rather than imports from lib/rules.ts. rules.ts is being edited in
 * parallel, and importing it at runtime would also create a cycle the moment rules.ts
 * calls simulate(). A rules.Character satisfies SfCharacterLike structurally.
 */
export interface SfItemLike {
  name: string;
  lvl: number;
  star: number;
  sup?: 0 | 1;
  noSf?: boolean;
  sub?: string;
}

export interface SfCharacterLike {
  items: Record<string, SfItemLike | undefined>;
}

/**
 * Slots that take no stars at all. Copied from SLOTS in lib/rules.ts (sf: false) so
 * this module keeps no runtime dependency; pass `isStarForceable` to override.
 * ASSUMPTION RECORDED: if rules.ts changes which slots take stars, update this set or
 * inject the predicate. The secondary slot depends on the item subtype, which only
 * rules.canStarForce() knows - inject it when that matters.
 */
export const NON_STARFORCEABLE_SLOTS: ReadonlySet<string> = new Set([
  "pocket",
  "emblem",
  "badge",
  "medal",
  "heart",
  "android",
]);

/**
 * ATT gained per star at 15+. NOT SOURCED: maplestorywiki's stat-tables page refused
 * every fetch attempt, and no other page published the per-level-band numbers. It is
 * null on purpose - reading it throws rather than returning a plausible lie. Ranking
 * therefore sorts by meso-per-star by default, which needs no damage model and is
 * honest about what it measures; inject a StatModel to rank by meso-per-ATT.
 */
export const UNVERIFIED_PLACEHOLDER_ATT_PER_STAR_15PLUS: number | null = null;

export interface StatModel {
  /** ATT gained by taking this item from `fromStar` to `toStar`. */
  attGain(itemLevel: number, fromStar: number, toStar: number): number;
}

export interface StarForceUpgradeRank {
  slotId: string;
  itemName: string;
  itemLevel: number;
  fromStar: number;
  toStar: number;
  starsGained: number;
  expectedCost: number;
  medianCost: number;
  p90Cost: number;
  pAnyBoom: number;
  meanBooms: number;
  /** Share of runs that ran out of spares. High here means expectedCost is understated. */
  pFailedToReachTarget: number;
  /** Expected mesos per star gained. Always available. */
  mesoPerStar: number;
  /** Expected mesos per point of ATT. null until a stat model is injected. */
  mesoPerAtt: number | null;
  unverified: UnverifiedConstant[];
}

export interface RankOpts {
  /** Target star per slot; default min(item cap, 22) - the usual Heroic stopping point. */
  targetStar?: (item: SfItemLike) => number;
  spares?: number;
  events?: SfEvents;
  mvpTier?: MvpTier;
  trials?: number;
  plan?: (from: number, to: number) => Record<number, StarPlanEntry>;
  isStarForceable?: (slotId: string, item: SfItemLike) => boolean;
  statModel?: StatModel;
  rng?: () => number;
}

/** 22 is where Heroic players stop: 23+ is a different cost regime entirely. */
export const DEFAULT_TARGET_STAR = 22;

/**
 * "Which single upgrade buys me the most damage per meso?", for the star force
 * dimension. Ranked ascending by meso-per-star (cheapest progress first), or by
 * meso-per-ATT when a stat model is supplied.
 */
export function rankStarForceUpgrades(
  ch: SfCharacterLike,
  opts: RankOpts = {},
): StarForceUpgradeRank[] {
  const events = opts.events ?? NO_EVENTS;
  // Per slot, not per app: 25 slots at 100k trials each would be wasteful for a list
  // whose ordering is stable long before the mean's last decimal is.
  const trials = opts.trials ?? 20000;
  const spares = opts.spares ?? 0;
  const planFn = opts.plan ?? mode1Plan;
  const out: StarForceUpgradeRank[] = [];

  for (const [slotId, item] of Object.entries(ch.items)) {
    if (!item) continue;
    const forceable = opts.isStarForceable
      ? opts.isStarForceable(slotId, item)
      : !NON_STARFORCEABLE_SLOTS.has(slotId) && !item.noSf;
    if (!forceable) continue;
    if (!item.lvl || item.lvl <= 0) continue;

    const cap = item.sup ? 15 : maxStarsForLevel(item.lvl);
    const target = opts.targetStar ? opts.targetStar(item) : Math.min(cap, DEFAULT_TARGET_STAR);
    const fromStar = item.star ?? 0;
    if (fromStar >= target) continue;

    const res = simulate({
      itemLevel: item.lvl,
      from: fromStar,
      to: target,
      spares,
      perStarPlan: planFn(fromStar, target),
      events,
      trials,
      mvpTier: opts.mvpTier ?? "none",
      rng: opts.rng,
    });

    const starsGained = target - fromStar;
    const att = opts.statModel ? opts.statModel.attGain(item.lvl, fromStar, target) : null;

    out.push({
      slotId,
      itemName: item.name,
      itemLevel: item.lvl,
      fromStar,
      toStar: target,
      starsGained,
      expectedCost: res.meanCost,
      medianCost: res.medianCost,
      p90Cost: res.p90Cost,
      pAnyBoom: res.pAnyBoom,
      meanBooms: res.meanBooms,
      pFailedToReachTarget: res.pFailedToReachTarget,
      mesoPerStar: res.meanCost / starsGained,
      mesoPerAtt: att !== null && att > 0 ? res.meanCost / att : null,
      unverified: opts.statModel ? [...res.unverified, "star-force-stat-gain"] : res.unverified,
    });
  }

  out.sort((a, b) => {
    if (a.mesoPerAtt !== null && b.mesoPerAtt !== null) return a.mesoPerAtt - b.mesoPerAtt;
    return a.mesoPerStar - b.mesoPerStar;
  });
  return out;
}

export interface TotalStarForceCost {
  expected: number;
  /** Sum of per-slot medians. NOT the median of the total - labelled, not hidden. */
  sumOfMedians: number;
  sumOfP90: number;
  slots: number;
  unverified: UnverifiedConstant[];
}

/** Summed expected cost of bringing every eligible slot to its target. */
export function totalStarForceCost(
  ch: SfCharacterLike,
  opts: RankOpts = {},
): TotalStarForceCost {
  const ranked = rankStarForceUpgrades(ch, opts);
  const unverified = new Set<UnverifiedConstant>();
  let expected = 0;
  let sumOfMedians = 0;
  let sumOfP90 = 0;
  for (const r of ranked) {
    expected += r.expectedCost;
    sumOfMedians += r.medianCost;
    sumOfP90 += r.p90Cost;
    for (const u of r.unverified) unverified.add(u);
  }
  return { expected, sumOfMedians, sumOfP90, slots: ranked.length, unverified: [...unverified] };
}
