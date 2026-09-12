// Arcane, Sacred and Grand Sacred symbols: growth, cost, income and the one
// answer the model exists to produce — "level THIS symbol next".
//
// WHY THIS FILE EXISTS
// Symbol stat is FLAT. It is not multiplied by %stat potential, so while your
// symbols are low every %stat line on your gear is worth less than it looks.
// For a Lv.244 player at Arcane Power 1060 the 26 remaining symbol levels are
// +2,600 flat main stat — larger than any single gear swap available to them,
// and the only progression in the game whose completion date can be computed
// exactly, because the income is a fixed daily/weekly quest reward.
//
// Everything here is pure. No React, no fetch, no Date.now() — callers pass
// `today`, so projections are testable without a browser or a clock.
//
// PROVENANCE. Every constant below is either verified against a cited source,
// or carries `_UNVERIFIED` in its name and an entry in
// UNVERIFIED_SYMBOL_CONSTANTS at the bottom. Nothing is buried in an
// expression.

/* ------------------------------------------------------------------ areas */

export const ARCANE_AREAS = ["vj", "chuchu", "lach", "arcana", "morass", "esfera"] as const;
export type ArcaneArea = (typeof ARCANE_AREAS)[number];

export const SACRED_AREAS = ["cernium", "arcus", "odium", "shangrila", "arteria", "carcion"] as const;
export type SacredArea = (typeof SACRED_AREAS)[number];

export const GRAND_SACRED_AREAS = ["tallahart", "geardock"] as const;
export type GrandSacredArea = (typeof GRAND_SACRED_AREAS)[number];

export type ArcaneLevels = Record<ArcaneArea, number>;
export type SacredLevels = Record<SacredArea, number>;
export type GrandSacredLevels = Record<GrandSacredArea, number>;

/** Replaces the single `arcane: number` stat. Levels, not a derived total. */
export interface SymbolState {
  arcane: ArcaneLevels;
  sacred: SacredLevels;
  grandSacred: GrandSacredLevels;
}

export const AREA_NAME: Record<ArcaneArea | SacredArea | GrandSacredArea, string> = {
  vj: "Vanishing Journey",
  chuchu: "Chu Chu Island",
  lach: "Lachelein",
  arcana: "Arcana",
  morass: "Morass",
  esfera: "Esfera",
  cernium: "Cernium",
  arcus: "Hotel Arcus",
  odium: "Odium",
  shangrila: "Shangri-La",
  arteria: "Arteria",
  carcion: "Carcion",
  tallahart: "Tallahart",
  geardock: "Geardock",
};

export function emptySymbolState(): SymbolState {
  return {
    arcane: { vj: 0, chuchu: 0, lach: 0, arcana: 0, morass: 0, esfera: 0 },
    sacred: { cernium: 0, arcus: 0, odium: 0, shangrila: 0, arteria: 0, carcion: 0 },
    grandSacred: { tallahart: 0, geardock: 0 },
  };
}

/* ------------------------------------------------------------- level gates */

/** Arcane River opens at Lv. 200; symbols cannot be equipped before it. */
export const ARCANE_UNLOCK_LEVEL = 200;
/** Sacred symbols unlock at Lv. 260 in Cernium. Source: guide-graph symbols.sacred. */
export const SACRED_UNLOCK_LEVEL = 260;
/** Source: MapleStory Wiki, Grand Sacred Symbol. Tallahart Lv. 290, Geardock Lv. 295. */
export const GRAND_SACRED_UNLOCK_LEVEL: Record<GrandSacredArea, number> = {
  tallahart: 290,
  geardock: 295,
};

export const ARCANE_LEVEL_CAP = 20;
export const SACRED_LEVEL_CAP = 11;
export const GRAND_SACRED_LEVEL_CAP = 11;

export interface Gate {
  unlocked: boolean;
  levelsRemaining: number;
  headline: string;
  why: string;
}

/**
 * guide-graph.json already carries "Do not buy Sacred symbol selectors before
 * Lv. 260 — you cannot equip them" and that line has never reached the planner.
 * This is the function that carries it there, with the gap attached.
 */
export function sacredGate(playerLevel: number): Gate {
  const remaining = Math.max(0, SACRED_UNLOCK_LEVEL - playerLevel);
  return {
    unlocked: remaining === 0,
    levelsRemaining: remaining,
    headline:
      remaining === 0
        ? "Sacred Symbols are unlocked."
        : `${remaining} level${remaining === 1 ? "" : "s"} to Sacred Symbols.`,
    why:
      remaining === 0
        ? "Cernium onward. Sacred Force is what lets you damage Western Grandis at all."
        : "Sacred Symbols unlock at Lv. 260 in Cernium. Do not buy Sacred Symbol Selector "
          + "coupons before then — you cannot equip what they give you.",
  };
}

export function grandSacredGate(playerLevel: number, area: GrandSacredArea): Gate {
  const need = GRAND_SACRED_UNLOCK_LEVEL[area];
  const remaining = Math.max(0, need - playerLevel);
  return {
    unlocked: remaining === 0,
    levelsRemaining: remaining,
    headline:
      remaining === 0
        ? `${AREA_NAME[area]} is open.`
        : `${remaining} levels to ${AREA_NAME[area]} (Lv. ${need}).`,
    why: `Grand Sacred Symbol: ${AREA_NAME[area]} requires Lv. ${need}.`,
  };
}

/* ------------------------------------------------- symbols required per level
 *
 * VERIFIED. The Arcane requirement is exactly level^2 + 11. Check it against
 * data/guide-graph.json node symbols.arcane.cost, which lists 12, 15, 20, 27,
 * 36, 47, 60, 75, 92, 111, 132, 155, 180, 207, 236, 267, 300, 335, 372 for
 * levels 1..19 and a cumulative 2,679 to reach 20: 1+11=12, 4+11=15, 361+11=372.
 * The same (level^2 + 11) term appears inside the meso formula below, which is
 * why one expression covers both.
 *
 * Sacred uses 9*level^2 + 20*level. Source: MapleStory Wiki Sacred Symbol pages.
 */

/** Symbols consumed to go from `level` to `level + 1`. Arcane. */
export function arcaneSymbolsForLevel(level: number): number {
  if (level < 1 || level >= ARCANE_LEVEL_CAP) return 0;
  return level * level + 11;
}

/** Symbols consumed to go from `level` to `level + 1`. Sacred and Grand Sacred. */
export function sacredSymbolsForLevel(level: number): number {
  if (level < 1 || level >= SACRED_LEVEL_CAP) return 0;
  return 9 * level * level + 20 * level;
}

/* ----------------------------------------------------------- meso cost ----
 *
 * MESO_PER_LEVEL(area, level) = 10,000 * floor((level^2 + 11) * (K + 0.1*level))
 *
 * Every K below is VERIFIED against its own MapleStory Wiki symbol page. The
 * brief listed 10 / 12 / 16 as an unchecked interpolation between the sourced
 * 8 / 14 / 18; all four intermediate areas were then confirmed individually, so
 * the interpolation is no longer load-bearing:
 *   Vanishing Journey  8   maplestorywiki.net/w/Arcane_Symbol:_Vanishing_Journey
 *   Chu Chu Island     10  maplestorywiki.net/w/Arcane_Symbol:_Chu_Chu_Island
 *   Lachelein          12  maplestorywiki.net/w/Arcane_Symbol:_Lachelein
 *   Arcana             14  maplestorywiki.net/w/Arcane_Symbol:_Arcana
 *   Morass             16  maplestorywiki.net/w/Arcane_Symbol:_Morass
 *   Esfera             18  maplestorywiki.net/w/Arcane_Symbol:_Esfera
 *
 * Two independent spot-checks against digitaltq.com/maplestory-arcane-symbols:
 *   VJ level 1      -> 10000*floor(12  * 8.1 ) =    970,000  (published:    970,000)
 *   Esfera level 19 -> 10000*floor(372 * 19.9) = 74,020,000  (published: 74,020,000)
 */
export const ARCANE_MESO_K: Record<ArcaneArea, number> = {
  vj: 8,
  chuchu: 10,
  lach: 12,
  arcana: 14,
  morass: 16,
  esfera: 18,
};

/** Mesos to go from `level` to `level + 1` for an Arcane symbol. */
export function MESO_PER_LEVEL(area: ArcaneArea, level: number): number {
  if (level < 1 || level >= ARCANE_LEVEL_CAP) return 0;
  return 10_000 * Math.floor((level * level + 11) * (ARCANE_MESO_K[area] + 0.1 * level));
}
/** Readable alias. `MESO_PER_LEVEL` is kept because the spec names it. */
export const arcaneMesoForLevel = MESO_PER_LEVEL;

/*
 * Sacred: 100,000 * floor((9*L^2 + 20*L) * (K - 0.6*L)).
 * Note the coefficient SHRINKS with level while the quadratic grows — that is
 * how the wiki states it and it is not a transcription error. K is an
 * arithmetic ladder in steps of 1.8, and every rung was confirmed on its own
 * page rather than inferred from the two ends:
 *   Cernium 13.2, Hotel Arcus 15.0, Odium 16.8, Shangri-La 18.6,
 *   Arteria 20.4, Carcion 22.2   (maplestorywiki.net / maplewiki symbol pages)
 */
export const SACRED_MESO_K: Record<SacredArea, number> = {
  cernium: 13.2,
  arcus: 15.0,
  odium: 16.8,
  shangrila: 18.6,
  arteria: 20.4,
  carcion: 22.2,
};

/**
 * Grand Sacred. Only Tallahart's coefficient could be sourced (39.8). Geardock
 * is a PLACEHOLDER copied from Tallahart: the Sacred ladder steps by 1.8, but
 * Grand Sacred has exactly two entries, so there is no second rung to infer a
 * step from. Geardock meso figures are unknown, not approximate — check
 * GRAND_SACRED_MESO_K_VERIFIED before printing one.
 */
export const GRAND_SACRED_MESO_K: Record<GrandSacredArea, number> = {
  tallahart: 39.8,
  geardock: 39.8,
};
export const GRAND_SACRED_MESO_K_VERIFIED: Record<GrandSacredArea, boolean> = {
  tallahart: true,
  geardock: false,
};

export function sacredMesoForLevel(area: SacredArea, level: number): number {
  if (level < 1 || level >= SACRED_LEVEL_CAP) return 0;
  const symbols = 9 * level * level + 20 * level;
  return 100_000 * Math.floor(symbols * (SACRED_MESO_K[area] - 0.6 * level));
}

export function grandSacredMesoForLevel(area: GrandSacredArea, level: number): number {
  if (level < 1 || level >= GRAND_SACRED_LEVEL_CAP) return 0;
  const symbols = 9 * level * level + 20 * level;
  return 100_000 * Math.floor(symbols * (GRAND_SACRED_MESO_K[area] - 0.6 * level));
}

/** Cumulative mesos to take one Arcane symbol from `from` up to `to`. */
export function arcaneMesoBetween(area: ArcaneArea, from: number, to: number): number {
  let total = 0;
  for (let l = Math.max(1, from); l < Math.min(to, ARCANE_LEVEL_CAP); l++) {
    total += MESO_PER_LEVEL(area, l);
  }
  return total;
}
export function arcaneSymbolsBetween(from: number, to: number): number {
  let total = 0;
  for (let l = Math.max(1, from); l < Math.min(to, ARCANE_LEVEL_CAP); l++) {
    total += arcaneSymbolsForLevel(l);
  }
  return total;
}
export function sacredMesoBetween(area: SacredArea, from: number, to: number): number {
  let total = 0;
  for (let l = Math.max(1, from); l < Math.min(to, SACRED_LEVEL_CAP); l++) {
    total += sacredMesoForLevel(area, l);
  }
  return total;
}
export function sacredSymbolsBetween(from: number, to: number): number {
  let total = 0;
  for (let l = Math.max(1, from); l < Math.min(to, SACRED_LEVEL_CAP); l++) {
    total += sacredSymbolsForLevel(l);
  }
  return total;
}

/* --------------------------------------------------------- force and stat */

/*
 * A symbol at level L contributes 20 + 10*L Arcane Force; an UNEQUIPPED symbol
 * (level 0) contributes nothing. The familiar shorthand
 *
 *     arcanePower = 120 + 10 * sum(levels)
 *
 * is that same expression summed over six symbols, with the six base-20s
 * collected into the 120. It is only correct when all six are equipped.
 * Summing per symbol is the difference between a player who has not unlocked
 * Esfera reading 1060 and reading the truth.
 */
export const ARCANE_FORCE_BASE_PER_SYMBOL = 20;
export const ARCANE_FORCE_PER_LEVEL = 10;
export const ARCANE_FORCE_MAX = 1320;

export function arcaneForceOf(level: number): number {
  return level <= 0 ? 0 : ARCANE_FORCE_BASE_PER_SYMBOL + ARCANE_FORCE_PER_LEVEL * level;
}

/** The real derivation. Replaces storing `arcane` as a number. */
export function arcanePower(levels: ArcaneLevels): number {
  return ARCANE_AREAS.reduce((sum, a) => sum + arcaneForceOf(levels[a]), 0);
}

/** Sacred symbols grant 10 Sacred Power (Authentic Force) per level, no base. */
export const SACRED_FORCE_PER_LEVEL = 10;
/**
 * Six Sacred symbols at 11 = 660 Sacred Power. Source: MapleStory Wiki — after
 * Carcion was added the maximum Authentic Force became 660, and one symbol at
 * max is +110.
 *
 * The brief specified `sacredPower (cap 250)`. 250 reconciles with no sourced
 * figure. SACRED_FORCE_MAX uses 660; the 250 is carried below only so the
 * discrepancy stays visible instead of being silently overwritten.
 */
export const SACRED_FORCE_MAX = 660;
export const SACRED_FORCE_CAP_PER_BRIEF_UNRECONCILED = 250;

export function sacredPower(levels: SacredLevels): number {
  return SACRED_AREAS.reduce((s, a) => s + SACRED_FORCE_PER_LEVEL * Math.max(0, levels[a]), 0);
}
export function grandSacredPower(levels: GrandSacredLevels): number {
  return GRAND_SACRED_AREAS.reduce((s, a) => s + SACRED_FORCE_PER_LEVEL * Math.max(0, levels[a]), 0);
}
/** What the game's "Authentic Force" line shows: Sacred plus Grand Sacred. */
export function authenticForce(s: SymbolState): number {
  return sacredPower(s.sacred) + grandSacredPower(s.grandSacred);
}

/* ------------------------------------------------- per-class stat conversion
 *
 * charAdvice() hardcodes +100 main stat per symbol level. That is wrong for two
 * classes, and the fix has to be keyed off the class rather than the main-stat
 * enum — Demon Avenger's main stat IS str, it simply does not receive str from
 * symbols.
 */
export type SymbolStatKind = "mainStat" | "hp" | "allStat";

export interface StatGrant {
  kind: SymbolStatKind;
  /** Stat at level L is `base + perLevel * L`. Level 0 grants nothing. */
  base: number;
  perLevel: number;
  verified: boolean;
  note?: string;
}

/** VERIFIED: level 1 = 300 main stat, level 20 = 2,200. guide-graph symbols.arcane.cost. */
export const ARCANE_GRANT_DEFAULT: StatGrant = {
  kind: "mainStat", base: 200, perLevel: 100, verified: true,
};

/**
 * UNVERIFIED. Demon Avenger receives HP instead of STR: reported as 4,200 at
 * level 1 and +1,400 per level (forums.maplestory.nexon.net discussions 20754
 * and 23662). The game treats it as equipment HP, so %HP does multiply it —
 * unlike main stat from symbols, which %stat does not touch. Read it off a
 * Demon Avenger's symbol window before presenting it as fact.
 */
export const ARCANE_GRANT_DEMON_AVENGER: StatGrant = {
  kind: "hp", base: 2800, perLevel: 1400, verified: false,
  note: "Forum-sourced. 4,200 HP at level 1, +1,400/level. Not read off an in-game panel.",
};

/**
 * UNVERIFIED. Xenon receives all-stat: reported 125 at level 1 and +39 per
 * level (same thread). The base/per-level split does not sit at the same ratio
 * as every other class, which is one more reason to confirm it.
 */
export const ARCANE_GRANT_XENON: StatGrant = {
  kind: "allStat", base: 86, perLevel: 39, verified: false,
  note: "Forum-sourced. 125 all stat at level 1, +39/level. Not read off an in-game panel.",
};

const DEMON_AVENGER = /demon\s*avenger/i;
const XENON = /xenon/i;

export function arcaneGrantFor(cls: string): StatGrant {
  if (DEMON_AVENGER.test(cls)) return ARCANE_GRANT_DEMON_AVENGER;
  if (XENON.test(cls)) return ARCANE_GRANT_XENON;
  return ARCANE_GRANT_DEFAULT;
}

/** VERIFIED: Sacred level 1 = 500 main stat, +200 per level (guide-graph symbols.sacred). */
export const SACRED_GRANT_DEFAULT: StatGrant = {
  kind: "mainStat", base: 300, perLevel: 200, verified: true,
};

/**
 * Demon Avenger and Xenon receive something other than main stat from Sacred
 * symbols too, and no source for those numbers could be found. Returning
 * `undefined` is deliberate: a caller must print "not modelled for this class"
 * rather than a scaled guess. A wrong number here sends a real person to grind.
 */
export function sacredGrantFor(cls: string): StatGrant | undefined {
  if (DEMON_AVENGER.test(cls) || XENON.test(cls)) return undefined;
  return SACRED_GRANT_DEFAULT;
}

export function statAtLevel(grant: StatGrant, level: number): number {
  return level <= 0 ? 0 : grant.base + grant.perLevel * level;
}

export function arcaneStatTotal(levels: ArcaneLevels, grant: StatGrant): number {
  return ARCANE_AREAS.reduce((s, a) => s + statAtLevel(grant, levels[a]), 0);
}

/** "main stat" / "HP" / "all stat", for sentences built around a grant. */
export function statWord(kind: SymbolStatKind): string {
  return kind === "hp" ? "HP" : kind === "allStat" ? "all stat" : "main stat";
}

/* ------------------------------------------------------------- checksumming */

/**
 * The importer reads Arcane Power off the stat window; per-symbol levels come
 * from the Symbol tab. When both are present they must agree — a mismatch means
 * one screenshot was misread, and saying so beats silently trusting the wrong
 * one.
 */
export interface ArcaneChecksum {
  ok: boolean;
  derived: number;
  reported: number;
  delta: number;
  /** A mismatch that is a clean multiple of 10 is a misread symbol level count. */
  likelyLevelsOff: number;
  message: string;
}

export function validateArcanePower(levels: ArcaneLevels, reported: number): ArcaneChecksum {
  const derived = arcanePower(levels);
  const delta = derived - reported;
  const likelyLevelsOff =
    delta % ARCANE_FORCE_PER_LEVEL === 0 ? Math.abs(delta / ARCANE_FORCE_PER_LEVEL) : 0;
  return {
    ok: delta === 0,
    derived,
    reported,
    delta,
    likelyLevelsOff,
    message:
      delta === 0
        ? `Arcane Power ${derived} matches your symbol levels.`
        : `Symbol levels add up to ${derived} Arcane Force but the stat window reads ${reported}`
          + (likelyLevelsOff
            ? ` — that is ${likelyLevelsOff} symbol level${likelyLevelsOff === 1 ? "" : "s"} out. Re-check the Symbol tab.`
            : ". One of the two screenshots was misread."),
  };
}

/** Total symbol levels implied by an Arcane Power reading, all six equipped. */
export function arcaneLevelSumFromPower(power: number): number {
  const base = ARCANE_FORCE_BASE_PER_SYMBOL * ARCANE_AREAS.length;
  return Math.max(0, Math.round((power - base) / ARCANE_FORCE_PER_LEVEL));
}

/**
 * Planner.tsx's statClass() flags Arcane Power red below 1,320 — true of every
 * player who has ever lived, which makes the flag mean nothing. This is the
 * level-appropriate target to compare against instead.
 *
 * The pacing is DERIVED, not sourced: an area's symbol is only farmable once
 * its region opens, and the regions open across Lv. 200-260, so a player is
 * roughly on pace with one more maxed symbol per ten levels past 200. Named and
 * exported precisely because it is a judgement call rather than a rule of the
 * game — tune it, do not cite it.
 */
export const ARCANE_PACE_LEVELS_PER_SYMBOL_UNVERIFIED = 10;

export function expectedArcaneForce(playerLevel: number): number {
  if (playerLevel < ARCANE_UNLOCK_LEVEL) return 0;
  const symbolsExpected = Math.min(
    ARCANE_AREAS.length,
    1 + Math.floor((playerLevel - ARCANE_UNLOCK_LEVEL) / ARCANE_PACE_LEVELS_PER_SYMBOL_UNVERIFIED),
  );
  // Expect the symbols you could have unlocked to be at or near cap: the same
  // dailies that unlock the next area also finish the previous one.
  return Math.min(ARCANE_FORCE_MAX, symbolsExpected * arcaneForceOf(ARCANE_LEVEL_CAP));
}

/* -------------------------------------------------------------- income ----
 *
 * VERIFIED against the v.271 patch notes (nexon.com/maplestory/news/update/44597):
 * Arcane River Daily Quest rewards for all areas increased from 20 to 40 Arcane
 * Symbols, and Weekly Quest rewards from 40 to 80. The doubling is real.
 */
export const ARCANE_DAILY_PER_AREA = 40;
export const ARCANE_WEEKLY_PER_AREA = 80;
/** 40 x 7 + 80 = 360 per area per week, and all six areas run in parallel. */
export const ARCANE_WEEKLY_TOTAL_PER_AREA = ARCANE_DAILY_PER_AREA * 7 + ARCANE_WEEKLY_PER_AREA;

/**
 * CONFIRMED against the GMS v.271 patch notes, read directly on 2026-09-12.
 *
 * Worth stating precisely, because "v.271 doubled symbol income" is the loose
 * version and it is wrong: only ARCANE doubled (dailies 20 -> 40, weeklies
 * 40 -> 80, all areas). SACRED went up 1.5x and on DAILIES ONLY - Cernium
 * 20 -> 30, the five other Grandis areas 10 -> 15, Grand Sacred 10 -> 15.
 * There is no Grandis weekly increase in the notes at all, and AUTHENTIC was
 * untouched ("authentic" returns zero matches across the rendered page).
 *
 * Modelling Sacred at 2x would overstate Grandis symbol income by a third.
 */
export const SACRED_DAILY_CERNIUM = 30;
export const SACRED_DAILY_OTHER = 15;
/** CONFIRMED with the above: Tallahart and Geardock daily 10 -> 15. */
export const GRAND_SACRED_DAILY = 15;

export function sacredDailyFor(area: SacredArea): number {
  return area === "cernium" ? SACRED_DAILY_CERNIUM : SACRED_DAILY_OTHER;
}

/**
 * UNVERIFIED. GMS weekly boss content resets Thursday 00:00 UTC; whether the
 * Arcane River weekly quest follows that or the Monday daily reset was not
 * sourced. It moves a projected completion date by at most six days, and only
 * in the final week, so it is a parameter rather than a hidden constant.
 * 0 = Sunday, 4 = Thursday.
 */
export const WEEKLY_RESET_DAY_UTC_UNVERIFIED = 4;

export interface IncomeOptions {
  dailyPerArea: number;
  weeklyPerArea: number;
  weeklyResetDayUtc: number;
  /** Days per week the player expects to miss. 0 = perfect attendance. */
  missedDaysPerWeek: number;
}

export function defaultArcaneIncome(): IncomeOptions {
  return {
    dailyPerArea: ARCANE_DAILY_PER_AREA,
    weeklyPerArea: ARCANE_WEEKLY_PER_AREA,
    weeklyResetDayUtc: WEEKLY_RESET_DAY_UTC_UNVERIFIED,
    missedDaysPerWeek: 0,
  };
}

const DAY_MS = 86_400_000;

/** Guard against a zero-income configuration looping forever. */
const SIM_DAY_LIMIT = 20_000;

/**
 * Days until `needed` symbols have been earned in ONE area. Simulated day by
 * day rather than divided, because the weekly lands on a specific weekday and a
 * closed form gets the final week wrong — which is the only week a player
 * actually cares about.
 */
export function daysToEarn(needed: number, today: Date, opt: IncomeOptions): number {
  if (needed <= 0) return 0;
  const missed = Math.min(7, Math.max(0, Math.floor(opt.missedDaysPerWeek)));
  const perWeek = opt.dailyPerArea * (7 - missed) + opt.weeklyPerArea;
  if (perWeek <= 0) return Infinity;

  let have = 0;
  let day = 0;
  while (have < needed && day < SIM_DAY_LIMIT) {
    day++;
    // Missed days are placed at the end of each 7-day block: the pessimistic
    // placement, and therefore the safe one to quote a date from. `day` is
    // 1-based, so the block offset is (day - 1) % 7 — using day % 7 puts the
    // seventh day of the block at offset 0 and silently skips nothing.
    const skipped = missed === 7 || (missed > 0 && (day - 1) % 7 >= 7 - missed);
    if (!skipped) have += opt.dailyPerArea;
    if (new Date(today.getTime() + day * DAY_MS).getUTCDay() === opt.weeklyResetDayUtc) {
      have += opt.weeklyPerArea;
    }
  }
  return day >= SIM_DAY_LIMIT ? Infinity : day;
}

export function addDays(today: Date, days: number): Date {
  return new Date(today.getTime() + days * DAY_MS);
}

/* ------------------------------------------------------------ projections */

export interface AreaProjection {
  area: ArcaneArea;
  areaName: string;
  level: number;
  levelsRemaining: number;
  symbolsRemaining: number;
  mesosRemaining: number;
  statRemaining: number;
  daysToMax: number;
  maxedOn: Date | null;
}

export interface ArcanePlan {
  areas: AreaProjection[];
  levelsRemaining: number;
  symbolsRemaining: number;
  mesosRemaining: number;
  statRemaining: number;
  statKind: SymbolStatKind;
  forceNow: number;
  forceMax: number;
  /** Areas are farmed in parallel, so the account finishes with the slowest. */
  daysToMax: number;
  maxedOn: Date | null;
  /** Days the finish date slips if one full day of dailies is skipped each week. */
  slipPerMissedDay: number;
  headline: string;
  slipLine: string;
}

export function planArcane(
  levels: ArcaneLevels,
  cls: string,
  today: Date,
  opt: IncomeOptions = defaultArcaneIncome(),
): ArcanePlan {
  const grant = arcaneGrantFor(cls);

  const areas: AreaProjection[] = ARCANE_AREAS.map((area) => {
    const level = Math.max(0, Math.min(ARCANE_LEVEL_CAP, levels[area]));
    const symbolsRemaining = arcaneSymbolsBetween(level, ARCANE_LEVEL_CAP);
    const daysToMax = daysToEarn(symbolsRemaining, today, opt);
    return {
      area,
      areaName: AREA_NAME[area],
      level,
      levelsRemaining: ARCANE_LEVEL_CAP - level,
      symbolsRemaining,
      mesosRemaining: arcaneMesoBetween(area, level, ARCANE_LEVEL_CAP),
      statRemaining: statAtLevel(grant, ARCANE_LEVEL_CAP) - statAtLevel(grant, level),
      daysToMax,
      maxedOn: Number.isFinite(daysToMax) ? addDays(today, daysToMax) : null,
    };
  });

  const daysToMax = areas.reduce((m, a) => Math.max(m, a.daysToMax), 0);
  const levelsRemaining = areas.reduce((s, a) => s + a.levelsRemaining, 0);
  const statRemaining = areas.reduce((s, a) => s + a.statRemaining, 0);
  const slowest = areas.reduce((m, a) => Math.max(m, a.symbolsRemaining), 0);
  const forceNow = arcanePower(levels);

  const slipped = daysToEarn(slowest, today, {
    ...opt,
    missedDaysPerWeek: Math.min(7, opt.missedDaysPerWeek + 1),
  });
  const slipPerMissedDay =
    Number.isFinite(slipped) && Number.isFinite(daysToMax) ? slipped - daysToMax : 0;

  const word = statWord(grant.kind);
  const done = Number.isFinite(daysToMax) ? addDays(today, daysToMax) : null;

  return {
    areas,
    levelsRemaining,
    symbolsRemaining: areas.reduce((s, a) => s + a.symbolsRemaining, 0),
    mesosRemaining: areas.reduce((s, a) => s + a.mesosRemaining, 0),
    statRemaining,
    statKind: grant.kind,
    forceNow,
    forceMax: ARCANE_FORCE_MAX,
    daysToMax,
    maxedOn: done,
    slipPerMissedDay,
    headline:
      levelsRemaining === 0
        ? `Arcane Force ${forceNow} — all six symbols maxed.`
        : `${levelsRemaining} symbol levels left (+${statRemaining.toLocaleString()} ${word}). `
          + `Arcane Force ${forceNow} of ${ARCANE_FORCE_MAX}. `
          + (done
            ? `Maxed on ${formatDate(done)} at current dailies.`
            : "No finish date — income model returned zero."),
    slipLine:
      slipPerMissedDay > 0
        ? `Skip one day a week and that date moves to `
          + `${formatDate(addDays(today, daysToMax + slipPerMissedDay))} — `
          + `${slipPerMissedDay} day${slipPerMissedDay === 1 ? "" : "s"} later.`
        : "",
  };
}

/** Deterministic and locale-independent, so a server render and a client render agree. */
export function formatDate(d: Date): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/* ------------------------------------------------ "level THIS symbol next" */

export interface SymbolUpgradeRank {
  rank: number;
  area: ArcaneArea;
  areaName: string;
  fromLevel: number;
  toLevel: number;
  mesos: number;
  symbols: number;
  statGain: number;
  statKind: SymbolStatKind;
  forceGain: number;
  /** The ordering key: mesos spent per point of stat bought. */
  mesosPerStat: number;
  /** Calendar days of dailies + weeklies to bank the symbols for this one level. */
  daysOfIncome: number;
  line: string;
}

/**
 * The one answer this whole model exists to produce.
 *
 * All six Arcane symbols grant an identical +100 main stat and +10 Arcane Force
 * per level, but K runs 8 / 10 / 12 / 14 / 16 / 18, so AT EQUAL LEVEL the
 * meso-per-stat ordering is strictly VJ < ChuChu < Lachelein < Arcana < Morass
 * < Esfera. Levels are rarely equal in practice, which is exactly why this is
 * computed from the player's real levels rather than asserted from that
 * ordering: a level-8 Esfera is cheaper per stat than a level-17 Vanishing
 * Journey, and a static ranking gets that backwards.
 *
 * `daysOfIncome` is the other half of the answer. In Reboot the symbols are
 * usually the binding constraint, not the mesos — ranking on cost alone is the
 * Raidbots half; ranking on time is the MapleStory half.
 */
export function rankArcaneNextLevel(
  levels: ArcaneLevels,
  cls: string,
  opt: IncomeOptions = defaultArcaneIncome(),
): SymbolUpgradeRank[] {
  const grant = arcaneGrantFor(cls);
  const missed = Math.min(7, Math.max(0, Math.floor(opt.missedDaysPerWeek)));
  const perDay = (opt.dailyPerArea * (7 - missed) + opt.weeklyPerArea) / 7;
  const word = statWord(grant.kind);

  type Row = Omit<SymbolUpgradeRank, "rank" | "line">;

  const rows: Row[] = ARCANE_AREAS.map((area): Row | null => {
    const from = Math.max(0, Math.min(ARCANE_LEVEL_CAP, levels[area]));
    // Level 0 means the symbol is not unlocked; unlocking is a quest, not a
    // purchase, so it does not belong in a cost-efficiency ranking.
    if (from < 1 || from >= ARCANE_LEVEL_CAP) return null;
    const mesos = MESO_PER_LEVEL(area, from);
    const symbols = arcaneSymbolsForLevel(from);
    const statGain = statAtLevel(grant, from + 1) - statAtLevel(grant, from);
    return {
      area,
      areaName: AREA_NAME[area],
      fromLevel: from,
      toLevel: from + 1,
      mesos,
      symbols,
      statGain,
      statKind: grant.kind,
      forceGain: ARCANE_FORCE_PER_LEVEL,
      mesosPerStat: statGain > 0 ? mesos / statGain : Infinity,
      daysOfIncome: perDay > 0 ? symbols / perDay : Infinity,
    };
  }).filter((r): r is Row => r !== null);

  rows.sort((a, b) => a.mesosPerStat - b.mesosPerStat);

  return rows.map((r, i) => ({
    ...r,
    rank: i + 1,
    line:
      `${r.areaName} ${r.fromLevel} → ${r.toLevel} · ${fmtMeso(r.mesos)} · `
      + `${r.symbols} symbols (${r.daysOfIncome.toFixed(1)} days) · `
      + `+${r.statGain.toLocaleString()} ${word} · ${fmtMeso(r.mesosPerStat)} per stat`,
  }));
}

/** 380,000,000 -> "380M". Mesos are only ever quoted in millions or billions. */
export function fmtMeso(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${Math.round(n)}`;
}

/* ------------------------------------------------------------ sacred plan */

export interface SacredAreaProjection {
  area: SacredArea;
  areaName: string;
  level: number;
  levelsRemaining: number;
  symbolsRemaining: number;
  mesosRemaining: number;
  daysToMax: number;
  maxedOn: Date | null;
}

export interface SacredPlan {
  gate: Gate;
  /** Null when the character cannot equip Sacred symbols yet. */
  areas: SacredAreaProjection[] | null;
  forceNow: number;
  forceMax: number;
  statRemaining: number | null;
  statModelled: boolean;
  daysToMax: number;
  maxedOn: Date | null;
  headline: string;
  caveat: string;
}

export function planSacred(
  levels: SacredLevels,
  cls: string,
  playerLevel: number,
  today: Date,
): SacredPlan {
  const gate = sacredGate(playerLevel);
  const grant = sacredGrantFor(cls);
  const forceNow = sacredPower(levels);

  const caveat =
    "Sacred income (Cernium 30/day, other areas 15/day) comes from guide-graph.json "
    + "and is NOT confirmed against the v.271 patch notes — only the Arcane doubling "
    + "is. Treat these dates as provisional.";

  if (!gate.unlocked) {
    return {
      gate,
      areas: null,
      forceNow,
      forceMax: SACRED_FORCE_MAX,
      statRemaining: null,
      statModelled: grant !== undefined,
      daysToMax: Infinity,
      maxedOn: null,
      headline: gate.headline,
      caveat,
    };
  }

  const areas: SacredAreaProjection[] = SACRED_AREAS.map((area) => {
    const level = Math.max(0, Math.min(SACRED_LEVEL_CAP, levels[area]));
    const symbolsRemaining = sacredSymbolsBetween(level, SACRED_LEVEL_CAP);
    const days = daysToEarn(symbolsRemaining, today, {
      dailyPerArea: sacredDailyFor(area),
      weeklyPerArea: 0,
      weeklyResetDayUtc: WEEKLY_RESET_DAY_UTC_UNVERIFIED,
      missedDaysPerWeek: 0,
    });
    return {
      area,
      areaName: AREA_NAME[area],
      level,
      levelsRemaining: SACRED_LEVEL_CAP - level,
      symbolsRemaining,
      mesosRemaining: sacredMesoBetween(area, level, SACRED_LEVEL_CAP),
      daysToMax: days,
      maxedOn: Number.isFinite(days) ? addDays(today, days) : null,
    };
  });

  const daysToMax = areas.reduce((m, a) => Math.max(m, a.daysToMax), 0);
  const maxedOn = Number.isFinite(daysToMax) ? addDays(today, daysToMax) : null;
  const statRemaining = grant
    ? areas.reduce(
        (s, a) => s + (statAtLevel(grant, SACRED_LEVEL_CAP) - statAtLevel(grant, a.level)),
        0,
      )
    : null;

  return {
    gate,
    areas,
    forceNow,
    forceMax: SACRED_FORCE_MAX,
    statRemaining,
    statModelled: grant !== undefined,
    daysToMax,
    maxedOn,
    headline:
      `Sacred Power ${forceNow} of ${SACRED_FORCE_MAX}`
      + (maxedOn ? ` — maxed on ${formatDate(maxedOn)} at current dailies.` : "."),
    caveat,
  };
}

/* ------------------------------------------------- the unverified register */

export interface UnverifiedConstant {
  name: string;
  value: number | string;
  why: string;
}

/**
 * Everything in this file a reader must confirm before it is presented as fact.
 * Render it wherever these numbers are shown. A confidently wrong constant
 * sends a real person to grind for nothing.
 */
export const UNVERIFIED_SYMBOL_CONSTANTS: UnverifiedConstant[] = [
        {
    name: "WEEKLY_RESET_DAY_UTC_UNVERIFIED",
    value: WEEKLY_RESET_DAY_UTC_UNVERIFIED,
    why: "Whether the Arcane River weekly follows Thursday boss reset or Monday daily reset was not sourced. Moves a finish date by at most six days.",
  },
  {
    name: "GRAND_SACRED_MESO_K.geardock",
    value: GRAND_SACRED_MESO_K.geardock,
    why: "Copied from Tallahart because no Geardock figure could be found. Geardock meso costs are unknown, not approximate.",
  },
  {
    name: "ARCANE_GRANT_DEMON_AVENGER",
    value: "4,200 HP at level 1, +1,400/level",
    why: "Forum-sourced, not read off an in-game Demon Avenger symbol window.",
  },
  {
    name: "ARCANE_GRANT_XENON",
    value: "125 all stat at level 1, +39/level",
    why: "Forum-sourced. The base/per-level ratio differs from every other class, which warrants a second look.",
  },
  {
    name: "sacredGrantFor(Demon Avenger | Xenon)",
    value: "undefined",
    why: "No source for what Sacred symbols grant these two classes. Deliberately not modelled rather than guessed.",
  },
  {
    name: "ARCANE_PACE_LEVELS_PER_SYMBOL_UNVERIFIED",
    value: ARCANE_PACE_LEVELS_PER_SYMBOL_UNVERIFIED,
    why: "A judgement call about what Arcane Force is level-appropriate, not a game constant. Exists only to stop the UI flagging every player red forever.",
  },
  {
    name: "SACRED_FORCE_CAP_PER_BRIEF_UNRECONCILED",
    value: SACRED_FORCE_CAP_PER_BRIEF_UNRECONCILED,
    why: "The brief specified a 250 cap for Sacred Power. Sourced figures give 660 (6 areas x 11 levels x 10 Authentic Force). SACRED_FORCE_MAX uses 660; the discrepancy is unresolved.",
  },
];
