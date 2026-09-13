// Arcane, Sacred and Grand Sacred symbols: growth, cost, income and the one
// answer the model exists to produce — "level THIS symbol next".
//
// WHY THIS FILE EXISTS
// Symbol stat is FLAT. It is not multiplied by %stat potential, so while your
// symbols are low every %stat line on your gear is worth less than it looks.
// The observed reference character — Archerroni, Bow Master, Lv 245, Arcane
// Power 1,070 — is carrying 95 symbol levels, which is 10,700 of their 20,790
// DEX: slightly over half their main stat, and none of it multiplied. The 25
// levels they have left are +2,500 more, larger than any single gear swap
// available to them, and the only progression in the game whose completion date
// can be computed exactly, because the income is a fixed quest reward.
// (This paragraph used to read "Lv.244 ... Arcane Power 1060 ... 26 remaining
// levels ... +2,600". That was the previous sheet; the arithmetic was right for
// the inputs it named, and the inputs went one level stale.)
//
// Everything here is pure. No React, no fetch, no Date.now() — callers pass
// `today`, so projections are testable without a browser or a clock.
//
// PROVENANCE. Every constant below is either verified against a cited source,
// or carries `_UNVERIFIED` (or `_UNRECONCILED`) in its name AND an entry in
// UNVERIFIED_SYMBOL_CONSTANTS at the bottom. Nothing is buried in an
// expression. checkUnverifiedRegistry() enforces that in two passes, and
// __symbolSelfTest() in lib/symbolSelfTest.ts runs it:
//
//   1. SYMMETRY. The marked exports and the registry's `markedExport` rows must
//      be the same set, differing by not one name in either direction.
//   2. COVERAGE. Every export carrying a game figure — a number, or a record
//      whose values are all numbers — must appear in exactly one of the two
//      ledgers: UNVERIFIED_SYMBOL_CONSTANTS or SYMBOL_CONSTANT_PROVENANCE.
//
// Pass 2 exists because pass 1 alone could not see the bug it was written for.
// GRAND_SACRED_DAILY was once a bare `= 15` with no marker and no row, and a
// symmetry check is blind to that by construction: an unregistered constant is
// absent from both sets, so the sets still match. Adding a bare constant now
// fails COVERAGE, which is the whole point.
//
// WHAT PASS 2 STILL CANNOT DO, said plainly so the next reader keeps looking:
// it checks that a provenance claim EXISTS, never that the claim is TRUE. A row
// reading `conf: "sourced"` against a URL nobody opened passes. The check makes
// silence impossible; it does not make lying impossible. Only reading the cited
// page does that.

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

/** True once at least one Arcane symbol level has actually been entered. The
 *  ranking below is silent until this is true — see NO_ARCANE_LEVELS_WHY. */
export function hasArcaneLevels(s: SymbolState): boolean {
  return ARCANE_AREAS.some((a) => s.arcane[a] > 0);
}

/* ------------------------------------------------------------- level gates */

/** Arcane River opens at Lv. 200; symbols cannot be equipped before it. */
export const ARCANE_UNLOCK_LEVEL = 200;
/**
 * Sacred symbols unlock at Lv. 260 in Cernium.
 *
 * The citation used to read "guide-graph symbols.sacred" — a node whose own
 * `source` field is the literal string "UNVERIFIED", which makes citing it a
 * way of laundering an unsourced figure through a file path. The figure is
 * fine; the citation was not. Corroborated 2026-09-13 against MapleStory Wiki
 * (Sacred Symbol): Sacred Symbols are given to players at Level 260 and above.
 */
export const SACRED_UNLOCK_LEVEL = 260;

/**
 * Tallahart Lv. 290 is corroborated twice over: MapleStory Wiki states Grand
 * Sacred Symbols are given at Level 290 and above, and names Tallahart as the
 * first of them. Geardock's 295 is NOT equally solid — see the registry entry
 * for GRAND_SACRED_UNLOCK_LEVEL.geardock — so it is gated rather than trusted.
 */
export const GRAND_SACRED_UNLOCK_LEVEL: Record<GrandSacredArea, number> = {
  tallahart: 290,
  geardock: 295,
};
/** Declared next to the figures it qualifies so a caller cannot miss it, and
 *  read by grandSacredGate() rather than left as an unenforced footnote. */
export const GRAND_SACRED_UNLOCK_VERIFIED: Record<GrandSacredArea, boolean> = {
  tallahart: true,
  geardock: false,
};

export const ARCANE_LEVEL_CAP = 20;
export const SACRED_LEVEL_CAP = 11;
export const GRAND_SACRED_LEVEL_CAP = 11;

/* --------------------------------------------------- reading a level ------
 *
 * THE ONE PLACE A RAW LEVEL BECOMES A LEVEL THIS MODULE WILL USE.
 *
 * NON-FINITE IS NOT ZERO, AND THAT DISTINCTION IS THE WHOLE FUNCTION.
 * `Math.max(0, Math.min(cap, NaN))` is NaN, and NaN then walks through every
 * guard in this file untouched, because every comparison against it is false:
 *   - `if (level < 1 || level >= CAP) return 0` returns neither, so cost
 *     formulas run on NaN and produce NaN;
 *   - `for (let l = from; l < to; l++)` is false on entry, so
 *     arcaneSymbolsBetween(NaN, 20) returns 0 — "no symbols left";
 *   - daysToEarn(0) is 0, so maxedOn becomes today and the area reports
 *     FINISHED;
 *   - and in finishRanking's comparator every `a - b` is NaN, so the row keeps
 *     its array position and a half-typed form field is ranked #1: "level this
 *     symbol next", chosen because nobody could read it.
 * An empty or half-typed input is a level NOBODY KNOWS. It is not 0 and it is
 * not maxed, so this returns null and every caller has to say "unknown" out
 * loud instead of inheriting a number by accident.
 *
 * A FINITE OUT-OF-RANGE LEVEL IS CLAMPED, NOT REFUSED. The game has no level
 * 999 and no level -3, the cap is the real ceiling, and clamping is already
 * what every per-area field in planArcane does — defect 3 was that forceNow
 * alone did not. Clamping is REPORTED (ArcanePlan.clampedAreas) rather than
 * applied silently, because a 999 in the input is a typo the player should see
 * named rather than have quietly rounded down for them.
 *
 * A NON-INTEGER IS UNREADABLE, not floored. There is no level 16.5, and
 * choosing 16 over 17 is a guess about which way the input went wrong. Refusing
 * fails loudly at the one place that can explain itself; flooring would hand
 * back a confident number derived from an impossible one.
 */
export function readSymbolLevel(raw: number, cap: number): number | null {
  if (!Number.isInteger(raw)) return null;
  return Math.max(0, Math.min(cap, raw));
}

/** True when readSymbolLevel would refuse this input. The negative form exists
 *  because callers overwhelmingly want to list the bad areas, not the good. */
export function isUnreadableLevel(raw: number): boolean {
  return !Number.isInteger(raw);
}

export interface Gate {
  unlocked: boolean;
  levelsRemaining: number;
  headline: string;
  why: string;
  /** False when the level in `why` is itself something a reader must confirm. */
  gateVerified: boolean;
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
    gateVerified: true,
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
  const verified = GRAND_SACRED_UNLOCK_VERIFIED[area];
  return {
    unlocked: remaining === 0,
    levelsRemaining: remaining,
    gateVerified: verified,
    headline:
      remaining === 0
        ? `${AREA_NAME[area]} is open.`
        : `${remaining} levels to ${AREA_NAME[area]} (Lv. ${need}).`,
    why:
      `Grand Sacred Symbol: ${AREA_NAME[area]} requires Lv. ${need}.`
      + (verified
        ? ""
        : " That level is UNVERIFIED — it is repeated by search summaries of the"
          + " wiki but the page itself could not be read, so confirm it in game"
          + " before planning around it."),
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
 * Twenty published cells from digitaltq.com/maplestory-arcane-symbols were
 * checked against this formula on 2026-09-13 — both ends of the table in all
 * six areas — and all twenty matched exactly. Two of them are asserted in
 * __symbolSelfTest() so a future edit to K cannot pass silently:
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
 * step from. Geardock meso figures are unknown, not approximate.
 *
 * grandSacredMesoForLevel() now RETURNS NULL for an unverified area rather than
 * leaving that to a comment. It previously read GRAND_SACRED_MESO_K directly
 * while a comment said "check GRAND_SACRED_MESO_K_VERIFIED before printing one",
 * so the flag was declared, referenced only from prose, and never consulted:
 * a Geardock figure printed with exactly the confidence of a Tallahart one.
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

/** Null means "nobody has sourced this area's coefficient" — print the null,
 *  do not print a Tallahart number wearing a Geardock label. */
export function grandSacredMesoForLevel(area: GrandSacredArea, level: number): number | null {
  if (!GRAND_SACRED_MESO_K_VERIFIED[area]) return null;
  if (level < 1 || level >= GRAND_SACRED_LEVEL_CAP) return 0;
  const symbols = 9 * level * level + 20 * level;
  return 100_000 * Math.floor(symbols * (GRAND_SACRED_MESO_K[area] - 0.6 * level));
}

/**
 * NOT MODELLED, and named here so the omission is visible rather than implied.
 * MapleStory Wiki states a Grand Sacred Symbol also grants EXP Obtained +10%,
 * Mesos Obtained +5% and Item Drop Rate +5%. This file models force and stat
 * only, and lib/farming.ts and lib/meso.ts are the files that price the other
 * three — wiring those together is a separate job, not a number to invent here.
 */
export const GRAND_SACRED_UNMODELLED_EFFECTS: readonly string[] = [
  "EXP Obtained +10% per symbol",
  "Mesos Obtained +5% per symbol",
  "Item Drop Rate +5% per symbol",
];

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

/**
 * Force is CAPPED AT THE LEVEL, not at the total, and the difference matters.
 * Capping the sum with `Math.min(ARCANE_FORCE_MAX, ...)` would look equivalent
 * and would hide a disagreement: if someone raised ARCANE_LEVEL_CAP to 21 and
 * left ARCANE_FORCE_MAX at 1320, a total-level clamp silently pins the answer
 * to the stale constant. Clamping per level makes 1320 EMERGENT — six symbols
 * at cap — so the two constants must agree, and __symbolSelfTest asserts
 * exactly that agreement (arcaneForceOf(20) * 6 === ARCANE_FORCE_MAX).
 *
 * An UNREADABLE level contributes 0 here, the same as an unequipped one, and
 * that collapse is safe in this direction only: force is a floor, so "at least
 * this much" stays true. It is NOT safe for symbols-remaining, where the same
 * NaN-to-0 collapse turns "unknown" into "finished" — which is why planArcane
 * refuses rather than reusing this leniency. Same input, opposite obligations.
 */
export function arcaneForceOf(level: number): number {
  const L = readSymbolLevel(level, ARCANE_LEVEL_CAP);
  return L === null || L <= 0 ? 0 : ARCANE_FORCE_BASE_PER_SYMBOL + ARCANE_FORCE_PER_LEVEL * L;
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

/** `Math.max(0, ...)` alone floored the bottom and left the top open: a level of
 *  99 read as 990 Sacred Power against a sourced maximum of 660. Clamped per
 *  level for the reason given on arcaneForceOf, which makes 660 emergent
 *  (6 areas x 11 levels x 10) rather than an imposed ceiling. */
export function sacredPower(levels: SacredLevels): number {
  return SACRED_AREAS.reduce(
    (s, a) => s + SACRED_FORCE_PER_LEVEL * (readSymbolLevel(levels[a], SACRED_LEVEL_CAP) ?? 0),
    0,
  );
}
/** No GRAND_SACRED_FORCE_MAX is asserted here: none was sourced, and inventing
 *  one to cap against is the move this repo bans. The per-level clamp bounds it
 *  at 2 x 11 x 10 = 220 from constants that ARE in this file, and nothing
 *  claims that figure is the game's published maximum. */
export function grandSacredPower(levels: GrandSacredLevels): number {
  return GRAND_SACRED_AREAS.reduce(
    (s, a) => s + SACRED_FORCE_PER_LEVEL * (readSymbolLevel(levels[a], GRAND_SACRED_LEVEL_CAP) ?? 0),
    0,
  );
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
 *
 * Renamed from ARCANE_GRANT_DEMON_AVENGER. The old name carried `verified:
 * false` and a registry entry but not the marker the file header promises, so
 * the header's rule held everywhere except on two of its own constants.
 */
export const ARCANE_GRANT_DEMON_AVENGER_UNVERIFIED: StatGrant = {
  kind: "hp", base: 2800, perLevel: 1400, verified: false,
  note: "Forum-sourced. 4,200 HP at level 1, +1,400/level. Not read off an in-game panel.",
};

/**
 * UNVERIFIED. Xenon receives all-stat: reported 125 at level 1 and +39 per
 * level (same thread). The base/per-level split does not sit at the same ratio
 * as every other class, which is one more reason to confirm it.
 * Renamed from ARCANE_GRANT_XENON, for the reason given above.
 */
export const ARCANE_GRANT_XENON_UNVERIFIED: StatGrant = {
  kind: "allStat", base: 86, perLevel: 39, verified: false,
  note: "Forum-sourced. 125 all stat at level 1, +39/level. Not read off an in-game panel.",
};

const DEMON_AVENGER = /demon\s*avenger/i;
const XENON = /xenon/i;

export function arcaneGrantFor(cls: string): StatGrant {
  if (DEMON_AVENGER.test(cls)) return ARCANE_GRANT_DEMON_AVENGER_UNVERIFIED;
  if (XENON.test(cls)) return ARCANE_GRANT_XENON_UNVERIFIED;
  return ARCANE_GRANT_DEFAULT;
}

/**
 * PARTLY sourced, and therefore unverified as a whole.
 *
 * This was `SACRED_GRANT_DEFAULT`, marked `verified: true`, citing "guide-graph
 * symbols.sacred". That node's own `source` field is the string "UNVERIFIED —
 * the 500 main stat / 10 Sacred Power starting values, the area list and the
 * v.271 selector change were not re-checked against a source on this pass", so
 * the citation was pointing at a note that says it is not a citation.
 *
 * What survives: level 1 = 500 main stat is independently confirmable (MapleStory
 * Wiki, Sacred Symbol: "Each symbol will start by giving 10 Sacred Power ... as
 * well as 500 of your main stat"). What does not: the +200 PER LEVEL slope.
 * Searches on 2026-09-13 returned the level-1 value and nothing else, so every
 * Sacred stat figure above level 1 rests on a slope nobody has sourced.
 */
export const SACRED_GRANT_DEFAULT_UNVERIFIED: StatGrant = {
  kind: "mainStat", base: 300, perLevel: 200, verified: false,
  note: "Level 1 = 500 main stat is sourced. The +200/level slope is not — it is the "
    + "only thing making levels 2-11 computable, and it has never been read off a panel.",
};

/**
 * Demon Avenger and Xenon receive something other than main stat from Sacred
 * symbols too, and no source for those numbers could be found. Returning
 * `undefined` is deliberate: a caller must print "not modelled for this class"
 * rather than a scaled guess. A wrong number here sends a real person to grind.
 */
export function sacredGrantFor(cls: string): StatGrant | undefined {
  if (DEMON_AVENGER.test(cls) || XENON.test(cls)) return undefined;
  return SACRED_GRANT_DEFAULT_UNVERIFIED;
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
  // An unreadable level makes `derived` a floor, not a total, so a mismatch
  // cannot be attributed to a misread symbol count — it is already explained.
  // Saying "your levels add up to 850 but the window reads 1,070" here would
  // blame the stat window for a level this module could not read.
  const unreadable = ARCANE_AREAS.filter((a) => isUnreadableLevel(levels[a]));
  if (unreadable.length > 0) {
    return {
      ok: false,
      derived: arcanePower(levels),
      reported,
      delta: 0,
      likelyLevelsOff: 0,
      message:
        `${unreadable.length} symbol level${unreadable.length === 1 ? " is" : "s are"} blank or `
        + `not a whole number (${unreadable.map((a) => AREA_NAME[a]).join(", ")}), so your levels `
        + "cannot be checked against the stat window yet.",
    };
  }
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

/**
 * Total symbol levels implied by an Arcane Power reading, all six equipped.
 *
 * THIS IS THE ONLY THING THE NUMBER CAN TELL YOU, and it is why the ranking
 * below refuses to run on it. 1,070 inverts to 95 levels; it does not invert to
 * a per-symbol spread, because thousands of spreads sum to 95 and they do not
 * agree about which symbol to level next. It also silently assumes all six
 * symbols are equipped: a player missing Esfera reads 1,050 at the same 95
 * levels, and this function would call that 93.
 */
export function arcaneLevelSumFromPower(power: number): number {
  const base = ARCANE_FORCE_BASE_PER_SYMBOL * ARCANE_AREAS.length;
  return Math.max(0, Math.round((power - base) / ARCANE_FORCE_PER_LEVEL));
}

/** The sentence a UI should show instead of a guessed ranking. */
export const NO_ARCANE_LEVELS_WHY =
  "Arcane Power is a total, and a total does not invert. 1,070 is 95 symbol levels, "
  + "but thousands of ways of spreading 95 levels across six symbols all read 1,070 — "
  + "and they disagree about which symbol is cheapest to level next. Enter the six "
  + "levels from your Symbol tab and this becomes an exact answer instead of a guess.";

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
 * 20 -> 30, the five other Grandis areas 10 -> 15. There is no Grandis weekly
 * increase in the notes at all, and AUTHENTIC was untouched ("authentic"
 * returns zero matches across the rendered page).
 *
 * Modelling Sacred at 2x would overstate Grandis symbol income by a third.
 */
export const SACRED_DAILY_CERNIUM = 30;
export const SACRED_DAILY_OTHER = 15;

/**
 * NOT confirmed, despite what this constant's docblock used to say.
 *
 * It read "CONFIRMED with the above: Tallahart and Geardock daily 10 -> 15" and
 * was the one constant in the file missing from the registry. The repo's own
 * primary-source node contradicts it in as many words: data/guide-graph.json
 * node symbols.income row 6 gives the cell as "15 — UNCONFIRMED", and its notes
 * say "the Grand Sacred row was not [corroborated] — the v.271 notes name
 * Cernium and the five Sacred areas, not Tallahart or Geardock, so treat its 15
 * as unconfirmed." 15 is the plausible reading, not the confirmed one.
 */
export const GRAND_SACRED_DAILY_UNVERIFIED = 15;

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

/** Sacred income is dailies only — the v.271 notes raise no Grandis weekly. */
export function sacredIncomeFor(area: SacredArea): IncomeOptions {
  return {
    dailyPerArea: sacredDailyFor(area),
    weeklyPerArea: 0,
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
  // `needed <= 0` is false for NaN, and the loop guard `have < needed` is false
  // on entry, so an unguarded NaN fell straight through to `return day` with
  // day still 0 — zero days, i.e. finished today. Infinity is the value every
  // caller in this file already renders as "no date can be quoted", which is
  // the honest reading of a requirement nobody could compute.
  if (!Number.isFinite(needed)) return Infinity;
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

/** Average symbols banked per calendar day in one area. The time price. */
export function symbolsPerDay(opt: IncomeOptions): number {
  const missed = Math.min(7, Math.max(0, Math.floor(opt.missedDaysPerWeek)));
  return (opt.dailyPerArea * (7 - missed) + opt.weeklyPerArea) / 7;
}

export function addDays(today: Date, days: number): Date {
  return new Date(today.getTime() + days * DAY_MS);
}

/* ------------------------------------------------------------ projections */

export interface AreaProjection {
  area: ArcaneArea;
  areaName: string;
  level: number;
  /** False when the symbol is not owned at all (level 0). */
  unlocked: boolean;
  /**
   * UPGRADE STEPS left, counted from level 1. The three numbers on this row
   * used to disagree about what level 0 means: levelsRemaining said 20 (cap
   * minus level), symbolsRemaining said 2,679 (which is 19 steps, because
   * arcaneSymbolsBetween clamps `from` to 1), and statRemaining said 2,200
   * (which includes the 200 base). Two of the three were right about the same
   * thing and the third was counting a level nobody buys: a symbol arrives at
   * level 1 from the area's quest line, so 0 -> 1 is not an upgrade you pay for.
   * levelsRemaining now counts steps, matching symbolsRemaining.
   */
  levelsRemaining: number;
  symbolsRemaining: number;
  mesosRemaining: number;
  /** Includes the base stat that arrives with the symbol when level is 0. */
  statRemaining: number;
  daysToMax: number;
  maxedOn: Date | null;
  /** Non-empty when this row describes an area the player cannot farm yet. */
  note: string;
}

export interface ArcanePlan {
  areas: AreaProjection[];
  levelsRemaining: number;
  symbolsRemaining: number;
  mesosRemaining: number;
  statRemaining: number;
  statKind: SymbolStatKind;
  statVerified: boolean;
  forceNow: number;
  forceMax: number;
  /** Areas are farmed in parallel, so the account finishes with the slowest. */
  daysToMax: number;
  maxedOn: Date | null;
  /** Days the finish date slips if one full day of dailies is skipped each week. */
  slipPerMissedDay: number;
  /**
   * Areas whose level could not be read — see readSymbolLevel. Empty in the
   * normal case. NON-EMPTY CHANGES WHAT EVERY TOTAL ON THIS OBJECT MEANS:
   * `areas` carries no row for an unreadable area, so levelsRemaining,
   * symbolsRemaining, mesosRemaining and statRemaining become LOWER BOUNDS, and
   * daysToMax is Infinity with maxedOn null because the unread area could be
   * the slowest one. A UI must render these areas as "—", never as 0.
   */
  unreadableAreas: ArcaneArea[];
  /** Areas whose level was a whole number outside 0..cap and was clamped to it.
   *  Surfaced so a typo'd 999 is named rather than silently rounded down. */
  clampedAreas: ArcaneArea[];
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

  // Read every level ONCE, up front, and keep the readable ones. An unreadable
  // area gets no row: a row in `areas` is a projection, and there is no
  // projection for a level nobody could read. Giving it a row with a sentinel
  // level is precisely how a sentinel ends up rendered as a fact — a blank
  // field became level 0, level 0 became "0 symbols remaining", and the area
  // was reported finished today.
  const unreadableAreas = ARCANE_AREAS.filter((a) => isUnreadableLevel(levels[a]));
  const clampedAreas = ARCANE_AREAS.filter(
    (a) => !isUnreadableLevel(levels[a]) && levels[a] !== readSymbolLevel(levels[a], ARCANE_LEVEL_CAP),
  );
  const readable = ARCANE_AREAS.filter((a) => !isUnreadableLevel(levels[a]));

  const areas: AreaProjection[] = readable.map((area) => {
    // Non-null by construction: `readable` is exactly the areas that parse.
    const level = readSymbolLevel(levels[area], ARCANE_LEVEL_CAP) as number;
    const unlocked = level >= 1;
    const from = Math.max(1, level);
    const symbolsRemaining = arcaneSymbolsBetween(from, ARCANE_LEVEL_CAP);
    const daysToMax = daysToEarn(symbolsRemaining, today, opt);
    return {
      area,
      areaName: AREA_NAME[area],
      level,
      unlocked,
      levelsRemaining: ARCANE_LEVEL_CAP - from,
      symbolsRemaining,
      mesosRemaining: arcaneMesoBetween(area, from, ARCANE_LEVEL_CAP),
      statRemaining: statAtLevel(grant, ARCANE_LEVEL_CAP) - statAtLevel(grant, level),
      daysToMax,
      maxedOn: Number.isFinite(daysToMax) ? addDays(today, daysToMax) : null,
      note: unlocked
        ? ""
        : `You do not have this symbol yet. The level-1 symbol comes from the ${AREA_NAME[area]} `
          + "quest line, not from farming, so the date below is the farm time AFTER you unlock it.",
    };
  });

  // An unread area could be the slowest one, so the ACCOUNT has no finish date
  // even though five of its six rows do. Infinity is what this file already
  // means by "no date can be quoted", and maxedOn below turns it into null.
  const daysToMax = unreadableAreas.length > 0
    ? Infinity
    : areas.reduce((m, a) => Math.max(m, a.daysToMax), 0);
  const levelsRemaining = areas.reduce((s, a) => s + a.levelsRemaining, 0);
  const statRemaining = areas.reduce((s, a) => s + a.statRemaining, 0);
  const slowest = areas.reduce((m, a) => Math.max(m, a.symbolsRemaining), 0);
  // Defect 3 was that this line read the RAW levels while every per-area field
  // beside it read the clamped one, so a level of 999 printed 11,110 Arcane
  // Force against a maximum of 1,320. The clamp now lives inside arcaneForceOf,
  // which is what both this and the rows above go through — one clamp in one
  // place, rather than a second copy here that can drift from the first.
  const forceNow = arcanePower(levels);

  const slipped = daysToEarn(slowest, today, {
    ...opt,
    missedDaysPerWeek: Math.min(7, opt.missedDaysPerWeek + 1),
  });
  const slipPerMissedDay =
    Number.isFinite(slipped) && Number.isFinite(daysToMax) ? slipped - daysToMax : 0;

  const word = statWord(grant.kind);
  const done = Number.isFinite(daysToMax) ? addDays(today, daysToMax) : null;
  const locked = areas.filter((a) => !a.unlocked).length;

  return {
    areas,
    levelsRemaining,
    symbolsRemaining: areas.reduce((s, a) => s + a.symbolsRemaining, 0),
    mesosRemaining: areas.reduce((s, a) => s + a.mesosRemaining, 0),
    statRemaining,
    statKind: grant.kind,
    statVerified: grant.verified,
    forceNow,
    forceMax: ARCANE_FORCE_MAX,
    daysToMax,
    maxedOn: done,
    slipPerMissedDay,
    unreadableAreas,
    clampedAreas,
    headline:
      // The unreadable branch comes FIRST and is not merged into the one below,
      // because every phrase in that one is a claim this case cannot support:
      // "N levels left" is a lower bound, "Arcane Force N" is a floor, and
      // "maxed on DATE" is unknowable. The old code had no such branch, so a
      // blank field rendered "NaN symbol levels left (+NaN main stat). Arcane
      // Force NaN of 1320." and then quoted a confident completion date.
      unreadableAreas.length > 0
        ? `${unreadableAreas.map((a) => AREA_NAME[a]).join(", ")} `
          + `${unreadableAreas.length === 1 ? "has no level entered" : "have no levels entered"}, `
          + "so there is no finish date yet. The other "
          + `${areas.length} symbol${areas.length === 1 ? "" : "s"} need at least `
          + `${levelsRemaining} more level${levelsRemaining === 1 ? "" : "s"} `
          + `(+${statRemaining.toLocaleString()} ${word}), and Arcane Force is at least `
          + `${forceNow} of ${ARCANE_FORCE_MAX}.`
        : levelsRemaining === 0
          ? `Arcane Force ${forceNow} — all six symbols maxed.`
          : `${levelsRemaining} symbol levels left (+${statRemaining.toLocaleString()} ${word}). `
            + `Arcane Force ${forceNow} of ${ARCANE_FORCE_MAX}. `
            + (done
              ? `Maxed on ${formatDate(done)} at current dailies.`
              : "No finish date — income model returned zero.")
            + (locked
              ? ` ${locked} of the six symbols are not unlocked yet, so that date starts `
                + "counting once you have them."
              : ""),
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

export type SymbolTier = "arcane" | "sacred";

/**
 * "time" ranks on days of dailies, "mesos" on meso cost. Not a weighted blend:
 * a blend needs an exchange rate between mesos and days that nobody has, and
 * inventing one would be exactly the kind of unnamed constant this repo bans.
 */
export type SymbolRankKey = "time" | "mesos";

/**
 * Attached to every ranked rec, because a player who sees a 46M level ranked
 * above a 26M one is owed the reason in the same breath rather than in a
 * docblock they will never open.
 */
export const RANK_BASIS_WHY: Record<SymbolRankKey, string> = {
  time:
    "Ranked by when you will have the symbols, not by meso cost. Arcane symbols are "
    + "area-locked and all six areas' dailies run in parallel, so this is the order these "
    + "levels become possible in — a cheaper level in another area is still waiting on its "
    + "own symbols. Rank by mesos instead if mesos are what runs out first for you.",
  mesos:
    "Ranked by meso cost. That is the only thing you genuinely choose between areas — "
    + "symbols are area-locked and arrive on their own schedule — so this is the right key "
    + "when mesos, not dailies, are your binding constraint.",
};

export interface SymbolUpgradeRank {
  rank: number;
  tier: SymbolTier;
  area: ArcaneArea | SacredArea;
  areaName: string;
  fromLevel: number;
  toLevel: number;
  mesos: number;
  symbols: number;
  /** Null when this class's grant for this tier is not modelled at all. */
  statGain: number | null;
  statKind: SymbolStatKind | null;
  /** False when statGain rests on an unsourced slope. Print the badge. */
  statVerified: boolean;
  forceGain: number;
  mesosPerStat: number | null;
  /** Calendar days of dailies + weeklies to bank the symbols for this one level. */
  daysOfIncome: number;
  line: string;
}

/**
 * The one answer this whole model exists to produce.
 *
 * All six Arcane symbols grant an identical +100 main stat and +10 Arcane Force
 * per level, but K runs 8 / 10 / 12 / 14 / 16 / 18, so AT EQUAL LEVEL the
 * meso ordering is strictly VJ < ChuChu < Lachelein < Arcana < Morass < Esfera.
 * Levels are rarely equal in practice, which is exactly why this is computed
 * from the player's real levels rather than asserted from that ordering: a
 * level-8 Esfera is cheaper per stat than a level-17 Vanishing Journey, and a
 * static ranking gets that backwards.
 *
 * WHY THE SORT KEY CHANGED. It used to sort on mesosPerStat alone, under a
 * docblock arguing that "ranking on cost alone is the Raidbots half; ranking on
 * time is the MapleStory half" — and then ranked on cost alone. Worse, because
 * every Arcane level grants an identical +100, dividing by statGain is a
 * constant scale: mesosPerStat ordering IS meso ordering, so daysOfIncome was
 * computed, printed, and had no effect on anything. mesosPerStat survives as a
 * display figure, not as the key.
 *
 * WHY TIME IS THE DEFAULT, and it is not the obvious reason. Arcane symbols are
 * AREA-LOCKED and all six areas' dailies run in parallel: Vanishing Journey
 * symbols cannot be spent on Esfera, and the player does not choose which area
 * to farm, they do all six. So "days of income" is not a price anyone elects to
 * pay — it is when that level becomes possible at all, and ranking on it gives
 * the order these levels will actually happen in. Mesos are the only thing
 * genuinely being chosen BETWEEN areas, which is why "mesos" is a first-class
 * option and not a debug flag: for a non-Reboot player, or anyone whose meso
 * bar is the thing that runs out, it is the right key. Ranking by time can
 * therefore put a 46M Esfera level above a 26M Vanishing Journey one, and that
 * is correct under its own key and worth saying out loud to the player — see
 * RANK_BASIS_WHY, which symbolAdvice() attaches to every row it emits.
 */
export function rankArcaneNextLevel(
  levels: ArcaneLevels,
  cls: string,
  opt: IncomeOptions = defaultArcaneIncome(),
  rankBy: SymbolRankKey = "time",
): SymbolUpgradeRank[] {
  const grant = arcaneGrantFor(cls);
  const perDay = symbolsPerDay(opt);

  const rows = ARCANE_AREAS.map((area): Omit<SymbolUpgradeRank, "rank" | "line"> | null => {
    const from = readSymbolLevel(levels[area], ARCANE_LEVEL_CAP);
    // An unreadable level has no "next level" anyone can name, so it is not a
    // recommendation. The old clamp let NaN through — `NaN < 1` and
    // `NaN >= CAP` are both false — and because every subtraction in
    // finishRanking's comparator was then NaN, the row held its array position
    // and came out RANKED FIRST: "Vanishing Journey NaN → NaN · — · NaN
    // symbols". The single answer this module exists to produce, chosen because
    // nobody could read the input.
    if (from === null) return null;
    // Level 0 means the symbol is not unlocked; unlocking is a quest, not a
    // purchase, so it does not belong in a cost-efficiency ranking.
    if (from < 1 || from >= ARCANE_LEVEL_CAP) return null;
    const mesos = MESO_PER_LEVEL(area, from);
    const symbols = arcaneSymbolsForLevel(from);
    const statGain = statAtLevel(grant, from + 1) - statAtLevel(grant, from);
    return {
      tier: "arcane" as const,
      area,
      areaName: AREA_NAME[area],
      fromLevel: from,
      toLevel: from + 1,
      mesos,
      symbols,
      statGain,
      statKind: grant.kind,
      statVerified: grant.verified,
      forceGain: ARCANE_FORCE_PER_LEVEL,
      mesosPerStat: statGain > 0 ? mesos / statGain : null,
      daysOfIncome: perDay > 0 ? symbols / perDay : Infinity,
    };
  }).filter((r): r is Omit<SymbolUpgradeRank, "rank" | "line"> => r !== null);

  return finishRanking(rows, rankBy);
}

/**
 * The Sacred half of the same question. The meso and symbol arithmetic here is
 * sourced; the STAT is not — see SACRED_GRANT_DEFAULT_UNVERIFIED — so these
 * rows carry statVerified false, and for Demon Avenger and Xenon statGain is
 * null rather than a scaled guess.
 */
export function rankSacredNextLevel(
  levels: SacredLevels,
  cls: string,
  rankBy: SymbolRankKey = "time",
): SymbolUpgradeRank[] {
  const grant = sacredGrantFor(cls);

  const rows = SACRED_AREAS.map((area): Omit<SymbolUpgradeRank, "rank" | "line"> | null => {
    // Same refusal as rankArcaneNextLevel, same reason — see the note there.
    const from = readSymbolLevel(levels[area], SACRED_LEVEL_CAP);
    if (from === null) return null;
    if (from < 1 || from >= SACRED_LEVEL_CAP) return null;
    const mesos = sacredMesoForLevel(area, from);
    const symbols = sacredSymbolsForLevel(from);
    const perDay = symbolsPerDay(sacredIncomeFor(area));
    const statGain = grant ? statAtLevel(grant, from + 1) - statAtLevel(grant, from) : null;
    return {
      tier: "sacred" as const,
      area,
      areaName: AREA_NAME[area],
      fromLevel: from,
      toLevel: from + 1,
      mesos,
      symbols,
      statGain,
      statKind: grant ? grant.kind : null,
      statVerified: grant ? grant.verified : false,
      forceGain: SACRED_FORCE_PER_LEVEL,
      mesosPerStat: statGain && statGain > 0 ? mesos / statGain : null,
      daysOfIncome: perDay > 0 ? symbols / perDay : Infinity,
    };
  }).filter((r): r is Omit<SymbolUpgradeRank, "rank" | "line"> => r !== null);

  return finishRanking(rows, rankBy);
}

function finishRanking(
  rows: Omit<SymbolUpgradeRank, "rank" | "line">[],
  rankBy: SymbolRankKey,
): SymbolUpgradeRank[] {
  // The secondary key is the other currency, so two areas that cost the same
  // number of days are separated by mesos rather than by array order — which
  // would otherwise be the ARCANE_AREAS literal, i.e. alphabetical by accident.
  const sorted = [...rows].sort((a, b) =>
    rankBy === "mesos"
      ? a.mesos - b.mesos || a.daysOfIncome - b.daysOfIncome
      : a.daysOfIncome - b.daysOfIncome || a.mesos - b.mesos);

  return sorted.map((r, i) => ({
    ...r,
    rank: i + 1,
    line:
      `${r.areaName} ${r.fromLevel} → ${r.toLevel} · ${fmtMeso(r.mesos)} · `
      + `${r.symbols} symbols (${r.daysOfIncome.toFixed(1)} days) · `
      + (r.statGain === null || r.statKind === null
        ? "stat not modelled for this class"
        : `+${r.statGain.toLocaleString()} ${statWord(r.statKind)}`
          + (r.statVerified ? "" : " (unverified)")),
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
  unlocked: boolean;
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
  /** False whenever statRemaining is non-null: the Sacred slope is unsourced. */
  statVerified: boolean;
  daysToMax: number;
  maxedOn: Date | null;
  /** As ArcanePlan.unreadableAreas: non-empty makes `areas` short and daysToMax
   *  Infinity, because the unread area could be the slowest. */
  unreadableAreas: SacredArea[];
  /** As ArcanePlan.clampedAreas. */
  clampedAreas: SacredArea[];
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
  const unreadableAreas = SACRED_AREAS.filter((a) => isUnreadableLevel(levels[a]));
  const clampedAreas = SACRED_AREAS.filter(
    (a) => !isUnreadableLevel(levels[a]) && levels[a] !== readSymbolLevel(levels[a], SACRED_LEVEL_CAP),
  );

  // This string used to say the opposite of the constants it describes: "Sacred
  // income ... is NOT confirmed against the v.271 patch notes — only the Arcane
  // doubling is." SACRED_DAILY_CERNIUM and SACRED_DAILY_OTHER were confirmed
  // against those notes on 2026-09-12 and the guide-graph node records the same
  // corroboration; the caveat was pre-verification text that outlived the check
  // it was waiting for, and it was shown to the player. What is actually
  // unconfirmed here is the STAT, not the income.
  const caveat =
    "Sacred dailies (Cernium 30, the other five areas 15) are confirmed against the "
    + "GMS v.271 patch notes; there is no Grandis WEEKLY in those notes, so these dates "
    + "assume dailies only."
    + (grant
      ? " The main stat figures are the unconfirmed half: a Sacred symbol's 500 at level 1"
        + " is sourced, the +200 per level above it is not."
      : ` Sacred stat is not modelled for ${cls} — no source gives what this class receives.`);

  if (!gate.unlocked) {
    return {
      gate,
      areas: null,
      forceNow,
      forceMax: SACRED_FORCE_MAX,
      statRemaining: null,
      statModelled: grant !== undefined,
      statVerified: false,
      daysToMax: Infinity,
      maxedOn: null,
      unreadableAreas,
      clampedAreas,
      headline: gate.headline,
      caveat,
    };
  }

  const areas: SacredAreaProjection[] = SACRED_AREAS.filter(
    (a) => !isUnreadableLevel(levels[a]),
  ).map((area) => {
    // Non-null by construction: the filter above is exactly the levels that parse.
    const level = readSymbolLevel(levels[area], SACRED_LEVEL_CAP) as number;
    const from = Math.max(1, level);
    const symbolsRemaining = sacredSymbolsBetween(from, SACRED_LEVEL_CAP);
    const days = daysToEarn(symbolsRemaining, today, sacredIncomeFor(area));
    return {
      area,
      areaName: AREA_NAME[area],
      level,
      unlocked: level >= 1,
      levelsRemaining: SACRED_LEVEL_CAP - from,
      symbolsRemaining,
      mesosRemaining: sacredMesoBetween(area, from, SACRED_LEVEL_CAP),
      daysToMax: days,
      maxedOn: Number.isFinite(days) ? addDays(today, days) : null,
    };
  });

  const daysToMax = unreadableAreas.length > 0
    ? Infinity
    : areas.reduce((m, a) => Math.max(m, a.daysToMax), 0);
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
    statVerified: grant ? grant.verified : false,
    daysToMax,
    maxedOn,
    unreadableAreas,
    clampedAreas,
    headline:
      // "at least" rather than a bare figure whenever a level went unread: an
      // unread symbol contributes 0 to forceNow, so the number is a floor.
      `Sacred Power ${unreadableAreas.length > 0 ? "at least " : ""}${forceNow} of ${SACRED_FORCE_MAX}`
      + (unreadableAreas.length > 0
        ? ` — no finish date: ${unreadableAreas.map((a) => AREA_NAME[a]).join(", ")} `
          + `${unreadableAreas.length === 1 ? "has no level" : "have no levels"} entered.`
        : maxedOn
          ? ` — maxed on ${formatDate(maxedOn)} at current dailies.`
          : "."),
    caveat,
  };
}

/* ============================================================ the entry point
 *
 * ONE call for the orchestrator. Everything above is the model; this is the
 * only thing lib/rules.ts needs to know the name of.
 *
 * SymbolRec is shaped to drop straight into rules.ts's Rec: pri / lv / t / w
 * carry the same meanings and the same 1..4 range PRI_LABEL indexes, cost is
 * mesos, and conf uses the same three-word vocabulary. The extra fields are
 * additive, and TypeScript's excess-property check does not fire on a value
 * assigned from a variable, so `const recs: Rec[] = symbolAdvice(...).recs`
 * compiles with no adapter. Deliberately NOT imported from rules.ts: this file
 * must not depend on the file that will depend on it.
 *
 * There is no `dmg`. Converting flat main stat into a damage fraction is
 * lib/damage.ts's job and re-deriving it here is how this repo got a 24%-wrong
 * number once already. rules.ts already owns relGain(); it should call it on
 * `statGain` at the wiring site.
 */

export type SymbolConf = "sourced" | "modelled" | "placeholder";

export interface SymbolRec {
  pri: 1 | 2 | 3 | 4;
  lv: "hi" | "mid" | "ok";
  t: string;
  w: string;
  /** Mesos. Absent means this rec is paid for in time, not mesos. */
  cost?: number;
  conf?: SymbolConf;
  /** Flat stat bought. Feed this to rules.ts's relGain() to get a damage figure. */
  statGain?: number;
  statKind?: SymbolStatKind;
  /** Days of dailies to bank the symbols. The other currency. */
  days?: number;
  /** Stable across calls, so a UI can key a list or dedupe. */
  key: string;
}

export interface SymbolAdviceOptions {
  cls: string;
  playerLevel: number;
  today: Date;
  /** The stat window's Arcane Power, when known. Cross-checked, never trusted. */
  reportedArcanePower?: number;
  income?: IncomeOptions;
  rankBy?: SymbolRankKey;
  /** How many next-level rows become recs. The full ranking is in `ranked`. */
  top?: number;
}

export interface SymbolAdvice {
  recs: SymbolRec[];
  /** The full ranking, both tiers, already ordered. */
  ranked: SymbolUpgradeRank[];
  arcane: ArcanePlan;
  sacred: SacredPlan;
  /** Null when the caller passed no Arcane Power to check against. */
  checksum: ArcaneChecksum | null;
  /** Exactly the unverified constants that touched the numbers above. */
  unverified: UnverifiedConstant[];
}

const DEFAULT_TOP = 3;

export function symbolAdvice(state: SymbolState, opt: SymbolAdviceOptions): SymbolAdvice {
  const income = opt.income ?? defaultArcaneIncome();
  const rankBy = opt.rankBy ?? "time";
  const top = Math.max(0, opt.top ?? DEFAULT_TOP);

  const arcane = planArcane(state.arcane, opt.cls, opt.today, income);
  const sacred = planSacred(state.sacred, opt.cls, opt.playerLevel, opt.today);
  const checksum =
    opt.reportedArcanePower === undefined
      ? null
      : validateArcanePower(state.arcane, opt.reportedArcanePower);

  const ranked = [
    ...rankArcaneNextLevel(state.arcane, opt.cls, income, rankBy),
    ...(sacred.gate.unlocked ? rankSacredNextLevel(state.sacred, opt.cls, rankBy) : []),
  ];

  const recs: SymbolRec[] = [];
  const word = statWord(arcane.statKind);

  // 1. The honest refusal, first, because everything below it is empty without
  //    the input it asks for.
  if (!hasArcaneLevels(state)) {
    recs.push({
      key: "symbols/need-levels",
      pri: 2,
      lv: "hi",
      t: "Enter your six Arcane symbol levels to get a \"level this one next\" answer.",
      w: NO_ARCANE_LEVELS_WHY
        + (opt.reportedArcanePower
          ? ` Your ${opt.reportedArcanePower.toLocaleString()} reads as `
            + `${arcaneLevelSumFromPower(opt.reportedArcanePower)} total levels and stops there.`
          : ""),
    });
  }

  // 1b. Levels that could not be read. Ranked with the checksum rather than
  //     with the plan, because it is the same kind of fact: an input problem
  //     that caps what everything below it is allowed to claim. Without this
  //     rec the refusal is invisible — the plan simply stops quoting a date and
  //     never says why.
  const unread = [...arcane.unreadableAreas, ...sacred.unreadableAreas];
  if (unread.length > 0 && hasArcaneLevels(state)) {
    recs.push({
      key: "symbols/unreadable-levels",
      pri: 1,
      lv: "hi",
      t: `${unread.map((a) => AREA_NAME[a]).join(", ")} `
        + `${unread.length === 1 ? "has no symbol level" : "have no symbol levels"} entered.`,
      w: "A blank or part-typed level is not a level of 0 and not a maxed symbol — it is a "
        + "level nobody knows, so these areas are left out of the totals and no completion "
        + "date is quoted. Every figure on this page is therefore a floor: the real numbers "
        + "can only be larger. Enter the missing levels from your Symbol tab and the dates "
        + "come back.",
    });
  }

  if (arcane.clampedAreas.length > 0) {
    recs.push({
      key: "symbols/clamped-levels",
      pri: 2,
      lv: "mid",
      t: `${arcane.clampedAreas.map((a) => AREA_NAME[a]).join(", ")} read above the level cap `
        + `and ${arcane.clampedAreas.length === 1 ? "was" : "were"} treated as ${ARCANE_LEVEL_CAP}.`,
      w: `Arcane symbols stop at level ${ARCANE_LEVEL_CAP}, so anything higher is a typo. The `
        + "planner used the cap rather than the number entered — check the Symbol tab if that "
        + "is not what you meant.",
    });
  }

  // 2. A checksum failure invalidates every number below it, so it outranks them.
  //    Suppressed when a level was unreadable: the checksum cannot fail for any
  //    other reason in that case, and its `w` blames the stat window for
  //    disagreeing with levels this module never managed to read.
  if (checksum && !checksum.ok && hasArcaneLevels(state) && unread.length === 0) {
    recs.push({
      key: "symbols/checksum",
      pri: 1,
      lv: "hi",
      t: checksum.message,
      w: "The Symbol tab and the stat window disagree. Fix the levels before planning "
        + "against them — every meso figure and every date on this page is computed from "
        + "the levels, not from the Arcane Power reading.",
    });
  }

  // 3. The ranking itself.
  ranked.slice(0, top).forEach((r, i) => {
    const verifiedStat = r.statGain !== null && r.statVerified;
    recs.push({
      key: `symbols/next/${r.tier}/${r.area}`,
      pri: i === 0 ? 1 : 2,
      lv: i === 0 ? "hi" : "mid",
      t: `Level ${r.areaName} ${r.fromLevel} → ${r.toLevel}: ${r.symbols} symbols, `
        + `${fmtMeso(r.mesos)}`
        + (r.statGain === null || r.statKind === null
          ? "."
          : `, +${r.statGain.toLocaleString()} ${statWord(r.statKind)}.`),
      w: `${r.daysOfIncome.toFixed(1)} days of ${r.areaName} dailies at this income. `
        + (r.tier === "arcane"
          ? "Every Arcane level grants the same flat stat, so the only thing separating "
            + "the six symbols is what the level costs you: mesos scale with the area "
            + "(K runs 8 to 18) and symbols scale with the level you are on (L² + 11). "
          : "Sacred levels cost 9L² + 20L symbols at one area's daily rate, and Grandis "
            + "has no weekly, so Sacred time is strictly dailies. ")
        + (verifiedStat
          ? "That stat is flat: no %stat line on your gear multiplies it. "
          : "The stat figure on this row is not sourced — treat the symbol and meso "
            + "counts as the reliable half. ")
        // Only on the top row. The basis is the same for all of them, and three
        // copies of the same paragraph in one list reads as boilerplate, which
        // is how a sentence that matters gets skipped.
        + (i === 0 ? RANK_BASIS_WHY[rankBy] : ""),
      cost: r.mesos,
      conf: verifiedStat ? "sourced" : "placeholder",
      statGain: r.statGain ?? undefined,
      statKind: r.statKind ?? undefined,
      days: r.daysOfIncome,
    });
  });

  // 4. The completion projection — the number that makes symbols worth planning
  //    at all, and the only progression in the game with an exact finish date.
  if (hasArcaneLevels(state) && arcane.levelsRemaining > 0) {
    recs.push({
      key: "symbols/arcane-plan",
      pri: 2,
      lv: "hi",
      t: arcane.headline,
      // Joined rather than concatenated: two of these three sentences are
      // conditional, and hand-managed trailing spaces are how a rendered string
      // ends up with a gap in the middle of it.
      w: [
        `Symbol stat is flat — it is not multiplied by %stat potential, which is why every `
          + `%${word} line on your gear is worth less than it looks while these are low.`,
        arcane.slipLine,
        arcane.statVerified ? "" : "This class's symbol stat grant is unverified; the dates are unaffected.",
      ].filter(Boolean).join(" "),
      conf: "modelled",
      statGain: arcane.statRemaining,
      statKind: arcane.statKind,
      days: Number.isFinite(arcane.daysToMax) ? arcane.daysToMax : undefined,
    });
  }

  // 5. The gate. This is the one piece of advice that saves mesos by telling the
  //    player NOT to spend them.
  if (!sacred.gate.unlocked) {
    recs.push({
      key: "symbols/sacred-gate",
      pri: 3,
      lv: "ok",
      t: sacred.gate.headline,
      w: sacred.gate.why,
    });
  } else if (sacred.areas && sacred.daysToMax > 0) {
    recs.push({
      key: "symbols/sacred-plan",
      pri: 2,
      lv: "mid",
      t: sacred.headline,
      w: sacred.caveat,
      conf: "modelled",
      days: Number.isFinite(sacred.daysToMax) ? sacred.daysToMax : undefined,
    });
  }

  return { recs, ranked, arcane, sacred, checksum, unverified: UNVERIFIED_SYMBOL_CONSTANTS };
}

/* ------------------------------------------------- the unverified register */

export interface UnverifiedConstant {
  /** An exported identifier, or `EXPORT.field` / `fn(args)` for a part of one. */
  name: string;
  value: number | string;
  why: string;
  /**
   * True when `name` is a top-level export of this module whose identifier
   * carries the marker. checkUnverifiedRegistry() enforces that these are
   * exactly the marked exports — no more and no less.
   */
  markedExport: boolean;
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
    markedExport: true,
    why: "Whether the Arcane River weekly follows Thursday boss reset or Monday daily reset was not sourced. Moves a finish date by at most six days.",
  },
  {
    name: "ARCANE_PACE_LEVELS_PER_SYMBOL_UNVERIFIED",
    value: ARCANE_PACE_LEVELS_PER_SYMBOL_UNVERIFIED,
    markedExport: true,
    why: "A judgement call about what Arcane Force is level-appropriate, not a game constant. Exists only to stop the UI flagging every player red forever.",
  },
  {
    name: "SACRED_FORCE_CAP_PER_BRIEF_UNRECONCILED",
    value: SACRED_FORCE_CAP_PER_BRIEF_UNRECONCILED,
    markedExport: true,
    why: "The brief specified a 250 cap for Sacred Power. Sourced figures give 660 (6 areas x 11 levels x 10 Authentic Force). SACRED_FORCE_MAX uses 660; the discrepancy is unresolved.",
  },
  {
    name: "GRAND_SACRED_DAILY_UNVERIFIED",
    value: GRAND_SACRED_DAILY_UNVERIFIED,
    markedExport: true,
    why: "guide-graph symbols.income gives this cell as \"15 — UNCONFIRMED\": the v.271 notes name Cernium and the five Sacred areas, not Tallahart or Geardock. It was documented as CONFIRMED and was the one constant missing from this list.",
  },
  {
    name: "ARCANE_GRANT_DEMON_AVENGER_UNVERIFIED",
    value: "4,200 HP at level 1, +1,400/level",
    markedExport: true,
    why: "Forum-sourced, not read off an in-game Demon Avenger symbol window.",
  },
  {
    name: "ARCANE_GRANT_XENON_UNVERIFIED",
    value: "125 all stat at level 1, +39/level",
    markedExport: true,
    why: "Forum-sourced. The base/per-level ratio differs from every other class, which warrants a second look.",
  },
  {
    name: "SACRED_GRANT_DEFAULT_UNVERIFIED",
    value: "500 main stat at level 1, +200/level",
    markedExport: true,
    why: "The 500 at level 1 is sourced (MapleStory Wiki). The +200/level slope is not, and it is what makes levels 2-11 computable. It was marked verified:true citing a guide-graph node whose own source field reads \"UNVERIFIED\".",
  },
  {
    name: "GRAND_SACRED_MESO_K.geardock",
    value: GRAND_SACRED_MESO_K.geardock,
    markedExport: false,
    why: "Copied from Tallahart because no Geardock figure could be found. Geardock meso costs are unknown, not approximate — grandSacredMesoForLevel() returns null rather than print one.",
  },
  {
    name: "GRAND_SACRED_UNLOCK_LEVEL.geardock",
    value: GRAND_SACRED_UNLOCK_LEVEL.geardock,
    markedExport: false,
    why: "Two search summaries of MapleStory Wiki (Geardock, Western Grandis) both say Lv. 295, but both pages returned HTTP 403 to a direct read on 2026-09-13, so no primary text was actually seen. Tallahart's 290 is corroborated by the Grand Sacred Symbol page's own \"Level 290 and above\".",
  },
  {
    name: "sacredGrantFor(Demon Avenger | Xenon)",
    value: "undefined",
    markedExport: false,
    why: "No source for what Sacred symbols grant these two classes. Deliberately not modelled rather than guessed.",
  },

  /* The three found by the COVERAGE pass when it was first written — plain
   * constants that carried no marker, no row, and therefore no provenance at
   * all, which is the exact class the symmetry pass could not see. Each was
   * searched for across lib/, data/guide-graph.json and docs/ before being
   * listed here; none of the three has a citation anywhere in the repo.
   *
   * THEIR NAMES DO NOT CARRY THE MARKER, and that is a known, recorded debt
   * rather than an oversight: renaming an export while another agent is
   * importing this module breaks their build mid-flight. The rename is the
   * follow-up. Until then the row is the disclosure, and UNMARKED_SCALAR_DEBT
   * below names them so the gap cannot be mistaken for completeness. */
  {
    name: "ARCANE_UNLOCK_LEVEL",
    value: ARCANE_UNLOCK_LEVEL,
    markedExport: false,
    why: "Lv. 200 for Arcane River is stated in this file's own docblock and nowhere else in the repo — no wiki page, no patch note, no guide-graph row. It is almost certainly right and it has still never been checked, which is what \"unverified\" means. It feeds expectedArcaneForce() only.",
  },
  {
    name: "GRAND_SACRED_LEVEL_CAP",
    value: GRAND_SACRED_LEVEL_CAP,
    markedExport: false,
    why: "11 is copied from SACRED_LEVEL_CAP on the assumption that Grand Sacred symbols cap where Sacred ones do. No source was found for the Grand Sacred cap specifically. It bounds grandSacredMesoForLevel() and grandSacredPower().",
  },
  {
    name: "GRAND_SACRED_MESO_K.tallahart",
    value: GRAND_SACRED_MESO_K.tallahart,
    markedExport: false,
    why: "The docblock says Tallahart's 39.8 \"could be sourced\" but names no page, and 39.8 appears nowhere else in the repo. The self-test's Tallahart assertion recomputes the formula from this constant, so it corroborates nothing. Its sibling geardock was caught and registered; this half was not.",
  },
];

/**
 * The unsourced exports whose NAMES do not yet say so, kept as an explicit list
 * rather than as a tolerance buried in the checker. Exported so a reader can
 * see the size of the debt, and so the day it reaches zero is visible.
 *
 * checkUnverifiedRegistry() requires every name here to have a registry row and
 * to actually exist. It deliberately does NOT let anything else through: a new
 * unsourced constant cannot quietly join this list without an author typing its
 * name into it, which is the point at which they have to think about renaming
 * it instead.
 */
export const UNMARKED_SCALAR_DEBT: readonly string[] = [
  "ARCANE_UNLOCK_LEVEL",
  "GRAND_SACRED_LEVEL_CAP",
];

/* ------------------------------------------------- the provenance ledger */

/** Only the two confident words. Anything a reader must still check belongs in
 *  UNVERIFIED_SYMBOL_CONSTANTS, and anything standing in for a real figure is a
 *  placeholder, which is also that list's job — see grandSacredMesoForLevel. */
export type SymbolProvenance = "sourced" | "modelled";

export interface SourcedConstant {
  /** An exported identifier, or `EXPORT.field` for one field of a record. */
  name: string;
  value: number | string;
  conf: SymbolProvenance;
  /** Where it was read. A URL, a guide-graph node id, or the formula and its inputs. */
  source: string;
}

/**
 * The other half of the coverage pass: every figure-carrying export that is NOT
 * in the unverified list has to say here where it came from.
 *
 * This ledger is the answer to "an unsourced plain constant is invisible to the
 * check". It cannot be: a number export with no row in either list now fails.
 *
 * What it does NOT do, restated where someone adding a row will read it: no
 * runtime check can tell a real citation from a plausible-looking one. Writing
 * `conf: "sourced"` against a URL you did not open produces a passing build and
 * a lie. The row is a signature, not a proof.
 */
export const SYMBOL_CONSTANT_PROVENANCE: SourcedConstant[] = [
  {
    name: "SACRED_UNLOCK_LEVEL",
    value: SACRED_UNLOCK_LEVEL,
    conf: "sourced",
    source: "MapleStory Wiki, Sacred Symbol: given to players at Level 260 and above. Re-checked 2026-09-13 after the previous citation turned out to point at a guide-graph node whose own source field reads \"UNVERIFIED\".",
  },
  {
    name: "GRAND_SACRED_UNLOCK_LEVEL.tallahart",
    value: GRAND_SACRED_UNLOCK_LEVEL.tallahart,
    conf: "sourced",
    source: "MapleStory Wiki, Grand Sacred Symbol: given at Level 290 and above, with Tallahart named as the first. The geardock field is NOT sourced — see UNVERIFIED_SYMBOL_CONSTANTS.",
  },
  {
    name: "ARCANE_LEVEL_CAP",
    value: ARCANE_LEVEL_CAP,
    conf: "sourced",
    source: "guide-graph node symbols.arcane.cost (digitaltq.com/maplestory-arcane-symbols) runs levels 1..20 and stops. __symbolSelfTest asserts the node has exactly 20 rows.",
  },
  {
    name: "SACRED_LEVEL_CAP",
    value: SACRED_LEVEL_CAP,
    conf: "sourced",
    source: "MapleStory Wiki, Sacred Symbol: one symbol at max is +110 Authentic Force at 10 per level, i.e. 11 levels. The published per-level symbol table also ends at the 10 -> 11 step.",
  },
  {
    name: "ARCANE_MESO_K",
    value: "vj 8, chuchu 10, lach 12, arcana 14, morass 16, esfera 18",
    conf: "sourced",
    source: "One maplestorywiki.net/w/Arcane_Symbol:_<area> page per area, all six checked individually rather than interpolated between the ends. Twenty published cells from digitaltq.com/maplestory-arcane-symbols matched the formula on 2026-09-13; two are asserted in __symbolSelfTest.",
  },
  {
    name: "SACRED_MESO_K",
    value: "cernium 13.2, arcus 15.0, odium 16.8, shangrila 18.6, arteria 20.4, carcion 22.2",
    conf: "sourced",
    source: "maplestorywiki.net / maplewiki Sacred Symbol pages, every rung confirmed on its own page rather than inferred from the 1.8 step.",
  },
  {
    name: "ARCANE_FORCE_BASE_PER_SYMBOL",
    value: ARCANE_FORCE_BASE_PER_SYMBOL,
    conf: "sourced",
    source: "guide-graph symbols.arcane.cost force column: 30 at level 1, 120 at 10, 220 at 20, i.e. 20 + 10L. __symbolSelfTest checks arcaneForceOf against that column at L = 1, 10, 20.",
  },
  {
    name: "ARCANE_FORCE_PER_LEVEL",
    value: ARCANE_FORCE_PER_LEVEL,
    conf: "sourced",
    source: "The same force column and the same three assertions as ARCANE_FORCE_BASE_PER_SYMBOL.",
  },
  {
    name: "ARCANE_FORCE_MAX",
    value: ARCANE_FORCE_MAX,
    conf: "sourced",
    source: "guide-graph symbols.arcane.cost notes: \"All six maxed = 13,200 main stat and 1,320 Arcane Force.\" __symbolSelfTest asserts arcaneForceOf(20) * 6 equals it, so the constant and the per-level formula cannot drift apart.",
  },
  {
    name: "SACRED_FORCE_PER_LEVEL",
    value: SACRED_FORCE_PER_LEVEL,
    conf: "sourced",
    source: "MapleStory Wiki, Sacred Symbol: one symbol at max is +110 Authentic Force over 11 levels.",
  },
  {
    name: "SACRED_FORCE_MAX",
    value: SACRED_FORCE_MAX,
    conf: "sourced",
    source: "MapleStory Wiki: after Carcion was added the maximum Authentic Force became 660. __symbolSelfTest asserts 10 * 11 * 6 equals it. The brief's contradictory 250 is carried as SACRED_FORCE_CAP_PER_BRIEF_UNRECONCILED rather than reconciled away.",
  },
  {
    name: "ARCANE_DAILY_PER_AREA",
    value: ARCANE_DAILY_PER_AREA,
    conf: "sourced",
    source: "GMS v.271 patch notes (nexon.com/maplestory/news/update/44597), read 2026-09-12: Arcane River daily rewards 20 -> 40 for all areas. Cross-checked against guide-graph symbols.income row 1 on every run.",
  },
  {
    name: "ARCANE_WEEKLY_PER_AREA",
    value: ARCANE_WEEKLY_PER_AREA,
    conf: "sourced",
    source: "Same v.271 notes: Arcane River weekly rewards 40 -> 80. Cross-checked against guide-graph symbols.income row 2.",
  },
  {
    name: "ARCANE_WEEKLY_TOTAL_PER_AREA",
    value: ARCANE_WEEKLY_TOTAL_PER_AREA,
    conf: "modelled",
    source: "ARCANE_DAILY_PER_AREA * 7 + ARCANE_WEEKLY_PER_AREA. Computed here rather than typed, and independently corroborated by guide-graph symbols.income row 3 (360), which __symbolSelfTest compares it against.",
  },
  {
    name: "SACRED_DAILY_CERNIUM",
    value: SACRED_DAILY_CERNIUM,
    conf: "sourced",
    source: "Same v.271 notes: Cernium daily 20 -> 30. A 1.5x rise, not the 2x the loose reading of the patch gives — __symbolSelfTest asserts the ratio is 1.5 so it cannot drift back.",
  },
  {
    name: "SACRED_DAILY_OTHER",
    value: SACRED_DAILY_OTHER,
    conf: "sourced",
    source: "Same v.271 notes: the five other Grandis areas 10 -> 15. Dailies only; the notes raise no Grandis weekly, which __symbolSelfTest asserts from the guide's per-week column.",
  },
  {
    name: "ARCANE_GRANT_DEFAULT",
    value: "300 main stat at level 1, +100/level",
    conf: "sourced",
    source: "guide-graph symbols.arcane.cost main-stat column: 300 at level 1, 1,200 at 10, 2,200 at 20. __symbolSelfTest checks statAtLevel against that column at all three.",
  },
];

/* --------------------------------------------- the check, not the promise */

const UNVERIFIED_NAME_MARKER = /_(?:UNVERIFIED|UNRECONCILED)$/;

function isStatGrant(v: unknown): v is StatGrant {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.kind === "string" && typeof o.base === "number"
    && typeof o.perLevel === "number" && typeof o.verified === "boolean";
}

/** A figure-carrying export: a number, or a record whose values are ALL numbers
 *  (ARCANE_MESO_K, GRAND_SACRED_UNLOCK_LEVEL). Records of booleans are
 *  provenance flags, arrays are area lists and strings are prose — none of them
 *  is a game figure, so none of them needs a citation. */
function numberFields(v: unknown): string[] | null {
  if (typeof v === "number") return [];
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries.every(([, x]) => typeof x === "number") ? entries.map(([k]) => k) : null;
}

/**
 * The file header's provenance claim, turned into a fact. Two passes.
 *
 * SYMMETRY. The exports whose names carry the marker and the registry rows
 * flagged `markedExport` must be the same set, and a StatGrant with
 * `verified: false` must be marked. A constant marked but unlisted fails; a
 * constant listed but not marked fails.
 *
 * COVERAGE. Every figure-carrying export must be accounted for in exactly one
 * of the two ledgers. THIS IS THE PASS THAT MATTERS, because symmetry alone
 * could never catch the bug it was written for: GRAND_SACRED_DAILY was a bare
 * `= 15` with no marker and no row, and an unregistered constant is absent from
 * BOTH sets a symmetry check compares, so the sets still matched and it
 * returned zero failures. Five more plain constants were sitting in the module
 * in the same condition when this pass was added, and it found all five — three
 * of them (ARCANE_UNLOCK_LEVEL, GRAND_SACRED_LEVEL_CAP,
 * GRAND_SACRED_MESO_K.tallahart) turned out to have no citation anywhere in the
 * repo and are now registered as unverified rather than assumed.
 *
 * For a RECORD, one whole-name row claims every field; otherwise every field
 * needs its own `NAME.field` row. That is not pedantry: GRAND_SACRED_MESO_K's
 * geardock field was registered and its tallahart field was not, and a
 * root-name match would have called the record covered and hidden the 39.8.
 *
 * WHAT NEITHER PASS CAN DO. Both check that a claim EXISTS, never that it is
 * TRUE. `conf: "sourced"` against a page nobody opened passes. This makes
 * silence impossible, not dishonesty — keep reading the sources.
 *
 * It takes the namespace as an argument rather than importing itself, because a
 * module that imports itself is a circular import in a file three other modules
 * are about to depend on. lib/symbolSelfTest.ts holds the namespace import and
 * passes it in; that is the only reason that file exists.
 */
export function checkUnverifiedRegistry(moduleNamespace: object): string[] {
  // `object` rather than Record<string, unknown> so a caller can hand over an ES
  // module namespace directly: a namespace type has no index signature, and
  // making the caller cast would put the cast in the file least able to explain it.
  const ns = moduleNamespace as Readonly<Record<string, unknown>>;
  const failures: string[] = [];
  const marked = Object.keys(ns).filter((k) => UNVERIFIED_NAME_MARKER.test(k));
  const listed = UNVERIFIED_SYMBOL_CONSTANTS.filter((u) => u.markedExport).map((u) => u.name);

  if (marked.length === 0) {
    failures.push(
      "checkUnverifiedRegistry saw no marked exports at all — it was probably handed the "
      + "wrong object, which would make every check below pass for the wrong reason",
    );
  }

  for (const name of marked) {
    if (!listed.includes(name)) {
      failures.push(`${name} carries the marker but is not in UNVERIFIED_SYMBOL_CONSTANTS`);
    }
  }
  for (const name of listed) {
    if (!marked.includes(name)) {
      failures.push(
        `UNVERIFIED_SYMBOL_CONSTANTS lists "${name}" as a marked export, but no such export exists`,
      );
    }
  }
  const seen = new Set<string>();
  for (const u of UNVERIFIED_SYMBOL_CONSTANTS) {
    if (seen.has(u.name)) failures.push(`${u.name} is listed twice`);
    seen.add(u.name);
    if (u.markedExport) continue;
    // A field-level entry still has to name something real, or it is a note
    // about a constant that was renamed out from under it.
    const root = u.name.split(/[.(]/)[0];
    if (!(root in ns)) {
      failures.push(`registry entry "${u.name}" names no export called "${root}"`);
    }
  }

  for (const [name, value] of Object.entries(ns)) {
    if (!isStatGrant(value) || value.verified) continue;
    if (!UNVERIFIED_NAME_MARKER.test(name)) {
      failures.push(`${name} is a StatGrant with verified:false but its name does not say so`);
    }
  }

  /* ---- pass 2: coverage ---- */

  const registered = new Set(UNVERIFIED_SYMBOL_CONSTANTS.map((u) => u.name));
  const sourced = new Set(SYMBOL_CONSTANT_PROVENANCE.map((s) => s.name));

  for (const s of SYMBOL_CONSTANT_PROVENANCE) {
    if (registered.has(s.name)) {
      failures.push(
        `${s.name} is in BOTH ledgers — it cannot be "${s.conf}" and unverified at once`,
      );
    }
    if (s.source.trim().length <= 20) {
      failures.push(`provenance row "${s.name}" has no real source: "${s.source}"`);
    }
    const root = s.name.split(/[.(]/)[0];
    if (!(root in ns)) {
      failures.push(`provenance row "${s.name}" names no export called "${root}"`);
    }
  }

  const covered = (name: string): boolean => registered.has(name) || sourced.has(name);

  for (const [name, value] of Object.entries(ns)) {
    const fields = numberFields(value);
    // A StatGrant is not a number-record (it carries `kind` and `verified`), but
    // base and perLevel are game figures, so it owes a claim too. An unverified
    // one already owes a registry row via the marker rule above.
    const isFigure = fields !== null || isStatGrant(value);
    if (!isFigure) continue;
    if (covered(name)) continue;
    if (fields !== null && fields.length > 0 && fields.every((f) => covered(`${name}.${f}`))) {
      continue;
    }
    const missing = fields === null || fields.length === 0
      ? ""
      : ` (uncovered field${fields.filter((f) => !covered(`${name}.${f}`)).length === 1 ? "" : "s"}: `
        + `${fields.filter((f) => !covered(`${name}.${f}`)).join(", ")})`;
    failures.push(
      `${name} carries a game figure but has no row in UNVERIFIED_SYMBOL_CONSTANTS or `
      + `SYMBOL_CONSTANT_PROVENANCE${missing} — every number in this module owes a provenance claim`,
    );
  }

  // The marker debt is allowed, but only for names written down on purpose.
  for (const name of UNMARKED_SCALAR_DEBT) {
    if (!(name in ns)) {
      failures.push(`UNMARKED_SCALAR_DEBT lists "${name}", which is not an export`);
    }
    if (!registered.has(name)) {
      failures.push(`UNMARKED_SCALAR_DEBT lists "${name}" but no registry row explains it`);
    }
    if (UNVERIFIED_NAME_MARKER.test(name)) {
      failures.push(`${name} now carries the marker — remove it from UNMARKED_SCALAR_DEBT`);
    }
  }

  return failures;
}

/* ==========================================================================
 * FLAT MAIN STAT FROM SYMBOLS — one model, so there is nothing to drift
 *
 * This lived in lib/cubes.ts as the only implementation, and then briefly in
 * two places at once: cubes.ts moved to per-area levels while lib/rules.ts
 * still read the Arcane Power total, so one character produced 10,700 flat
 * symbol stat in the cube ranking and 0 in the recommendation engine at the
 * same moment. Both feed the SAME question — how much of the displayed main
 * stat is flat, and therefore untouched by a %stat line — so a disagreement
 * there is the app contradicting itself about the thing the owner asked.
 *
 * It belongs here: this file owns the grant tables and deliberately imports
 * nothing from rules.ts, so both callers reach it without a cycle.
 * ========================================================================== */

/** How many symbols a force reading can actually account for. A symbol you own is
 *  at level 1 or better — level 1 arrives with the area's quest line, it is not
 *  something you level into — so each owned symbol is worth at least 20 + 10 = 30
 *  Force. A reading of 100 therefore cannot be six symbols, and pretending it is
 *  would credit six bases to a player who has two. Capped at the six areas. */
function impliedSymbolCount(arcaneForce: number): number {
  const perOwnedSymbol = ARCANE_FORCE_BASE_PER_SYMBOL + ARCANE_FORCE_PER_LEVEL;
  return Math.max(0, Math.min(ARCANE_AREAS.length, Math.floor(arcaneForce / perOwnedSymbol)));
}

/**
 * Flat main stat from Arcane symbols, from an Arcane Power reading alone.
 *
 * WHAT IS ASSUMED, AND WHAT IT COSTS. A total does not invert to a spread, so this
 * assumes a symbol COUNT — the most the reading can support, up to six, the same
 * all-six assumption arcaneLevelSumFromPower() documents. For every class whose
 * grant is proportional to force that costs exactly nothing, and the observed
 * character is one of them: ARCANE_GRANT_DEFAULT is 200 + 100L against a force of
 * 20 + 10L, both a factor of 10, so
 *
 *     count * 200 + levels * 100  =  10 * (count * 20 + levels * 10)  =  10 * force
 *
 * whatever the count and whatever the spread. A player missing Esfera reads 1,050
 * instead of 1,070 and gets 10,500 — correct, not five-sixths of a guess.
 *
 * The assumption only bites for Xenon, whose grant is NOT proportional to force.
 * There, each symbol short of impliedSymbolCount over-counts by 8 flat all-stat —
 * MEASURED, and not the 86 an earlier comment claimed, because the inversion turns
 * the missing symbol's 20 Force into 2 extra levels and hands most of it back.
 *
 * Prefer arcaneFlatMainStatFromLevels() wherever the per-area levels exist. Sacred
 * stat is NOT included: Sacred levels cannot be recovered from Arcane Power at all,
 * and this file's Sacred slope is still unsourced. For a Lv 260+ character that
 * omission understates the flat total, which OVERSTATES what a %stat line is worth
 * — the exact direction of the bug this consolidation exists to stop repeating.
 */
export function arcaneFlatMainStatFromPower(arcanePowerReading: number, cls = ""): number {
  const grant = arcaneGrantFor(cls);
  // Demon Avenger's symbols pay out HP, not STR, so its flat MAIN STAT from symbols
  // is zero and every point of its displayed STR really does sit inside the %stat
  // multiplier. Xenon's all-stat grant is flat points added to each stat, so it
  // dilutes %stat exactly the way main stat does and is counted.
  if (grant.kind === "hp") return 0;
  const force = Math.max(0, Number.isFinite(arcanePowerReading) ? arcanePowerReading : 0);
  const owned = impliedSymbolCount(force);
  const levels = Math.max(
    0,
    Math.round((force - owned * ARCANE_FORCE_BASE_PER_SYMBOL) / ARCANE_FORCE_PER_LEVEL),
  );
  return owned * grant.base + levels * grant.perLevel;
}

/** Exact. Per-area levels, no inversion and no assumption about how many are
 *  equipped. This is the path to use whenever per-area levels exist. */
export function arcaneFlatMainStatFromLevels(levels: ArcaneLevels, cls = ""): number {
  const grant = arcaneGrantFor(cls);
  if (grant.kind === "hp") return 0;
  return ARCANE_AREAS.reduce((sum, a) => {
    // An UNREADABLE level contributes nothing rather than propagating. This total
    // feeds a damage number: readSymbolLevel() returning null means the input was
    // not an integer, crediting it would be inventing a level, and letting it
    // through as NaN would poison the figure and every rec computed from it.
    // Scoring 0 is defensible only as a second line of defence — the input
    // boundary rejects such values before they can reach a Character at all.
    const lv = readSymbolLevel(levels[a], ARCANE_LEVEL_CAP);
    return lv === null ? sum : sum + statAtLevel(grant, lv);
  }, 0);
}
