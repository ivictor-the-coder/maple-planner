/**
 * MapleStory GMS damage model — the quantitative core.
 *
 * WHAT THIS IS
 * A single comparable number (`damageIndex`) for a character, plus the marginal
 * value of each stat. It exists so the planner can answer "which stat is worth
 * more" in numbers instead of adjectives.
 *
 * WHAT THIS IS EXPLICITLY NOT — do not assume a later piece can read these off
 * this module, because they are not modelled here at all:
 *   - attack speed, skill rotations, cooldowns, summon uptime
 *   - per-class final-damage passives, hyper skill passives, buff uptime
 *   - meso cost of any upgrade
 *   - hit count / lines per skill, mob count, positioning
 * `damageIndex` is therefore NOT DPS and must never be labelled as such in the
 * UI. It answers "which stat is worth more", never "how long to kill Lucid".
 * Cost-per-damage is the next piece and needs a meso-cost curve module; that
 * module should consume `damageIndex`, never reimplement the math.
 *
 * DEPENDENCIES: none, deliberately. No React, no storage, no ./rules import.
 * Every value here is a plain number so this is testable without a browser.
 *
 * SCOPE OF TRUTH: GMS Heroic (Reboot), patch v.271. KMS numbers are not GMS
 * numbers and are not used.
 *
 * @module lib/damage
 */

/* ============================================================================
 * GAME CONSTANTS
 *
 * Every constant is exported and carries its source on the line above it, so a
 * wrong one is a one-line fix in one place. Anything marked UNVERIFIED is a
 * community number that could not be confirmed against a first-party or
 * datamined source; it is still used, but it is named, exported, and visible.
 * Nothing in this file hides a guess inside an expression.
 * ==========================================================================*/

/**
 * Source: https://ayumilove.net/maplestory-formula/ weapon table, corroborated
 * by https://maplestorywiki.net/w/Damage_Formula for the shape of the range
 * formula.
 *
 * UNVERIFIED for post-class-multiplier GMS. This table is the legacy per-weapon
 * table. Modern GMS folds a per-CLASS multiplier into the same slot: community
 * sources give Bowmaster 1.3 while the legacy Bow row gives 1.15. That is a 13%
 * difference on the absolute number. It cancels exactly in every ratio this
 * module reports (see `marginal`), so the percentages are unaffected — but the
 * absolute `damageIndex` is only comparable against itself, never against a
 * number produced by any other tool.
 */
export const WEAPON_MULTIPLIER: Record<string, number> = {
  bow: 1.15,
  crossbow: 1.35,
  claw: 2.0,
  dagger: 1.3,
  gun: 1.6,
  knuckler: 1.7,
  staff: 0.88,
  wand: 0.88,
  oneHanded: 1.1,
  twoHandedSword: 1.29,
  twoHandedAxeBlunt: 1.27,
  spear: 1.49,
  polearm: 1.49,
};

/**
 * Source: community class-multiplier tables surfaced alongside the AyumiLove
 * weapon table ("for Bowmasters ... the class multiplier is 1.3").
 * UNVERIFIED. Swap `WEAPON_MULTIPLIER.bow` for this to test the other reading.
 * Kept as a separate named export rather than a second table so there is
 * exactly one place a correction has to land.
 */
export const BOW_CLASS_MULTIPLIER_ALTERNATIVE = 1.3;

/**
 * Source: https://maplestorywiki.net/w/Damage_Formula — the crit branch of the
 * average-damage formula is `(1)` or `(1.35 + cd%)`, i.e. a flat 35% base.
 *
 * UNVERIFIED, and the disagreement is structural rather than numeric.
 * https://grandislibrary.com/content/stat-terms states the Critical Damage
 * shown in the stat window "is added to a Lower Critical Damage (20%) and a
 * Higher Critical Damage (50%) multiplier" — a BAND, not a point. If that is
 * right, the true base is a distribution over [0.20, 0.50] and 0.35 is only its
 * midpoint; a single crit rolls somewhere inside the band. Using the midpoint
 * is correct for expected damage and wrong for any variance question, which is
 * fine here because this module only ever reports expectations.
 */
export const CRIT_DAMAGE_BASE = 0.35;

/** Source: grandislibrary.com/content/stat-terms — lower bound of the crit band. UNVERIFIED. */
export const CRIT_DAMAGE_BAND_LOW = 0.2;
/** Source: grandislibrary.com/content/stat-terms — upper bound of the crit band. UNVERIFIED. */
export const CRIT_DAMAGE_BAND_HIGH = 0.5;

/**
 * Source: https://ayumilove.net/maplestory-formula/ — initial mastery by combat
 * type: melee 20%, ranged (bow/crossbow) 15%, magic 25%.
 * UNVERIFIED as a modern GMS number, and note this is BASE mastery before job
 * skills; a fourth-job Bowmaster sits far higher (community figures put total
 * Bowmaster mastery near 85–90%). Mastery does not affect maximum damage, only
 * how close minimum sits to it — see `expectedDamageIndex`.
 */
export const RANGE_MASTERY_BASE = 0.15;

/** Source: community formula compilations — mastery is capped at 99%. UNVERIFIED. */
export const MASTERY_CAP = 0.99;

/**
 * Source: https://ayumilove.net/maplestory-formula/ and
 * https://maplestorywiki.net/w/Damage_Formula — range is
 * `WeaponMultiplier * (4 * PrimaryStat + SecondaryStat) * (Att / 100)`.
 * The 4 is consistent across every modern source consulted. Treated as VERIFIED.
 */
export const STAT_MULTIPLIER_MAIN = 4;

/**
 * Boss PDR (percent damage reduction / "defense"), as a fraction: 3.0 = 300%.
 *
 * Source: https://grandislibrary.com/content/stat-terms — "most Lv. 200+ bosses
 * have" 300% PDR/MDR. Source: https://gmsmeta.com/bsm/ied.html lists
 * Chaos Von Bon at 100% and Chaos Vellum, Lotus, Damien and Lucid at 300%.
 *
 * VERIFIED (gmsmeta, named individually): vonBon, vellum, lotus, damien, lucid.
 * UNVERIFIED (inferred from the blanket "Lv. 200+ bosses are 300%" rule and NOT
 * individually confirmed): will, darknell, gloom, verusHilla, blackMage, kalos,
 * kaling, limbo. Any of these could be higher — Grandis-era content is widely
 * reported at 380% — and a wrong PDR moves every IED marginal on this page.
 */
export const BOSS_PDR: Record<string, number> = {
  // VERIFIED — gmsmeta.com/bsm/ied.html
  vonBon: 1.0,
  vellum: 3.0,
  lotus: 3.0,
  damien: 3.0,
  lucid: 3.0,
  // UNVERIFIED — assumed from the Lv.200+ = 300% rule, not confirmed per boss
  will: 3.0,
  gloom: 3.0,
  darknell: 3.0,
  verusHilla: 3.0,
  blackMage: 3.0,
  kalos: 3.0,
  kaling: 3.0,
  limbo: 3.0,
};

/**
 * Default target when the caller does not name a boss: the Arcane River
 * standard, equal to BOSS_PDR.lucid. Written as a literal rather than read out
 * of the table so the table can stay a plain Record<string, number>.
 */
export const DEFAULT_PDR = 3.0;

/**
 * Floor for the defence term.
 *
 * The raw term is `1 - pdr * (1 - ied)`. At pdr = 3.0 and ied = 0.50 that is
 * `1 - 1.5 = -0.5`: negative, and a naive implementation silently returns a
 * negative or sign-flipped damage number.
 *
 * What the game actually does, per https://gmsmeta.com/bsm/ied.html: "when this
 * quantity is bigger than or equal to 1, the entirety of the damage formula is
 * ignored and one will only deal 1 damage." So in-game damage floors at 1 — a
 * fixed absolute value, not a fraction of your range. There is no scale factor
 * that expresses "1 damage" inside an index, so this module clamps to 0 and
 * raises a warning instead of pretending the number means anything.
 *
 * UNVERIFIED whether the clamp is exactly at the boundary or one tick either
 * side. The consequence either way: `damageIndex` is only meaningful for a
 * character whose effective IED already clears roughly `1 - 1/pdr` — about 67%
 * against a 300% boss. Below that, read the warning, not the number.
 */
export const DEF_TERM_FLOOR = 0;

/* ============================================================================
 * TYPES
 * ==========================================================================*/

/**
 * Every input the GMS formula needs. All percentage-shaped fields are
 * FRACTIONS, not display percentages: 41.5% crit damage is `0.415`, 159% boss
 * damage is `1.59`, 92.9% IED is `0.929`. `att` and the stat fields are flat
 * game values. Use `inputsFromPercentStats` if you are holding display numbers.
 *
 * Widened deliberately past the current `Stats` shape in ./rules: a model fed a
 * character with no Damage % and no Final Damage % is off by a large
 * multiplicative factor, which is worse than having no model.
 */
export interface DamageInputs {
  /** Flat primary stat, totalled as the stat window shows it (DEX for a Bowmaster). */
  mainStat: number;
  /** Flat secondary stat (STR for a Bowmaster). 0 is a legitimate value, not a sentinel. */
  secondaryStat: number;
  /** Flat weapon attack / magic attack as shown in the stat window. */
  att: number;
  /** ATT % from potentials and buffs, as a fraction. */
  attPct: number;
  /** Damage % (the generic bucket), as a fraction. */
  dmgPct: number;
  /** Boss Damage %, as a fraction. Added to `dmgPct`, not multiplied — see `damageTerm`. */
  bossPct: number;
  /** Final Damage %, as a fraction. Its own multiplicative bucket. */
  finalDmgPct: number;
  /** Critical rate as a fraction. Anything above 1 is dead weight and is clamped. */
  critRate: number;
  /** Critical Damage % as shown in the stat window, as a fraction. Excludes CRIT_DAMAGE_BASE. */
  critDmg: number;
  /** EFFECTIVE Ignore Enemy DEF as a fraction, i.e. already stacked. See `stackIed`. */
  ied: number;
  /** Key into WEAPON_MULTIPLIER, e.g. "bow". */
  weaponMultiplier: string;
  /**
   * Weapon mastery as a fraction. NOT used by `damageIndex` — mastery moves the
   * minimum of the range, never the maximum. Consumed only by
   * `expectedDamageIndex`, which averages over the range.
   */
  mastery: number;
  /**
   * Character level. NOT used by `damageIndex`. Carried because the
   * level-difference damage penalty and the Arcane Force / Sacred Power checks
   * are real and will need it — but neither is modelled here and neither
   * constant could be sourced, so applying one would be inventing a constant.
   */
  charLevel: number;
  /**
   * Skill damage % as a fraction. NOT used by `damageIndex`. It is a single
   * multiplicative factor common to base and perturbed cases, so it cancels
   * exactly in every ratio this module reports; including it would change the
   * absolute number and no comparison. A real per-skill model is out of scope.
   */
  skillPct: number;
}

export interface DamageOptions {
  /** Target boss PDR as a fraction: 3.0 = 300%. Look one up in BOSS_PDR. */
  pdr: number;
}

export type DamageWarningCode =
  | "def-term-floored"
  | "unknown-weapon"
  | "crit-rate-overcapped"
  | "unused-input";

export interface DamageWarning {
  code: DamageWarningCode;
  /** Plain sentence, safe to render straight into the UI. */
  message: string;
}

/** Every intermediate term, so a number on screen can be traced to a line of formula. */
export interface DamageBreakdown {
  range: number;
  damageTerm: number;
  fdTerm: number;
  critTerm: number;
  defTerm: number;
  /** The raw defence term before clamping. Negative means the character is under the IED wall. */
  rawDefTerm: number;
  damageIndex: number;
  warnings: DamageWarning[];
  /** False when a warning makes the number unsafe to show as a damage figure. */
  meaningful: boolean;
}

/** One row of the marginal table. `gainPct` is a percentage, e.g. 0.56 for +0.56%. */
export interface Marginal {
  /** Stable machine key. Use it to look up styling or a tooltip; do not render it. */
  stat: MarginalStat;
  /** Human label for the perturbation, e.g. "+1% crit damage". */
  label: string;
  /** Size of the perturbation in the input's own units. */
  delta: number;
  /** Percentage change in damageIndex, e.g. 0.56 means +0.56%. */
  gainPct: number;
  /** Set when the row needs a caveat the number alone cannot carry. */
  note?: string;
}

export type MarginalStat =
  | "mainStat"
  | "att"
  | "attPct"
  | "dmgPct"
  | "bossPct"
  | "critDmg"
  | "critRate"
  | "finalDmgPct"
  | "ied";

/** Result of adding one IED POTENTIAL LINE, which is a different question to one IED point. */
export interface IedLineResult {
  /** The line as printed on the cube, e.g. 0.20 for "Ignore DEF +20%". */
  lineValue: number;
  /** IED before the line. */
  ied: number;
  /** IED after multiplicative stacking. */
  newIed: number;
  /** How many EFFECTIVE points the line actually buys. This is the number that shrinks. */
  effectiveIedPoints: number;
  /** Percentage change in damageIndex from adding the line. */
  gainPct: number;
  /** gainPct divided by effectiveIedPoints — the per-point value, which RISES near the cap. */
  gainPctPerEffectivePoint: number;
  warnings: DamageWarning[];
}

/* ============================================================================
 * CORE MODEL
 * ==========================================================================*/

/**
 * Clamp the defence term. Exported so a test can pin the singularity directly.
 * See DEF_TERM_FLOOR for why this exists and why the clamped number is not a
 * damage figure.
 */
export function clampDefTerm(x: number): number {
  return Math.max(DEF_TERM_FLOOR, x);
}

/**
 * Effective IED after stacking one more source. IED sources multiply their
 * REMAINDERS rather than adding, which is the whole reason the last points are
 * expensive to buy and cheap to own.
 *
 * Source: https://grandislibrary.com/content/stat-terms — "calculated
 * multiplicatively ... it is impossible to obtain 100% IED". VERIFIED.
 */
export function stackIed(current: number, line: number): number {
  return 1 - (1 - current) * (1 - line);
}

/** Fold a list of IED sources into one effective value. */
export function stackIedAll(sources: readonly number[]): number {
  return sources.reduce<number>((acc, s) => stackIed(acc, s), 0);
}

/**
 * The IED a character needs before `damageIndex` means anything against this
 * boss: below it the defence term is zero or negative and the game floors
 * damage at 1. ~66.7% against a 300% boss.
 */
export function iedWall(pdr: number): number {
  if (pdr <= 0) return 0;
  return 1 - 1 / pdr;
}

/**
 * Full breakdown. `damageIndex` is the thin wrapper over this; prefer this one
 * anywhere the warnings matter, which is anywhere a human will read the number.
 *
 * Term order below is the audit order. Each line is one factor of the formula
 * and nothing is folded together, so a term can be checked against its source
 * without unpicking an expression.
 */
export function damageBreakdown(inputs: DamageInputs, opts: DamageOptions): DamageBreakdown {
  const warnings: DamageWarning[] = [];

  const wm = WEAPON_MULTIPLIER[inputs.weaponMultiplier];
  const weapon = typeof wm === "number" ? wm : 1;
  if (typeof wm !== "number") {
    warnings.push({
      code: "unknown-weapon",
      message: `Unknown weapon "${inputs.weaponMultiplier}" — using a multiplier of 1. Absolute numbers are wrong; ratios are unaffected.`,
    });
  }

  // Crit rate above 100% is worth exactly zero. Clamping here, once, is what
  // makes the crit-rate marginal fall to 0 at the cap instead of lying.
  const critRateClamped = Math.min(inputs.critRate, 1);
  if (inputs.critRate > 1) {
    warnings.push({
      code: "crit-rate-overcapped",
      message: `Crit rate is ${(inputs.critRate * 100).toFixed(1)}% — everything above 100% is dead. Move it to crit damage.`,
    });
  }

  const range =
    weapon *
    (STAT_MULTIPLIER_MAIN * inputs.mainStat + inputs.secondaryStat) *
    (inputs.att / 100) *
    (1 + inputs.attPct);

  // Boss Damage is ADDED to the %Damage bucket, not multiplied against it.
  // Source: grandislibrary.com/content/stat-terms — "It is added to %Damage in
  // calculations." VERIFIED. This is why boss% gets cheaper as damage% grows.
  const damageTerm = 1 + inputs.dmgPct + inputs.bossPct;

  // Final Damage is its own multiplicative bucket, outside the %Damage sum.
  const fdTerm = 1 + inputs.finalDmgPct;

  // Expected value over the crit branch: non-crits hit for 1x, crits for
  // (1 + base + critDmg). At 100% crit the non-crit branch vanishes entirely.
  const critTerm =
    (1 - critRateClamped) + critRateClamped * (1 + CRIT_DAMAGE_BASE + inputs.critDmg);

  const rawDefTerm = 1 - opts.pdr * (1 - inputs.ied);
  const defTerm = clampDefTerm(rawDefTerm);
  if (rawDefTerm <= 0) {
    warnings.push({
      code: "def-term-floored",
      message:
        `Effective IED ${(inputs.ied * 100).toFixed(1)}% is below the ${(iedWall(opts.pdr) * 100).toFixed(1)}% wall for a ` +
        `${(opts.pdr * 100).toFixed(0)}% defence boss. In game you would deal 1 damage per hit. ` +
        `This number is floored and is not a damage figure — fix IED before reading anything else here.`,
    });
  }

  for (const [name, value] of [
    ["skillPct", inputs.skillPct],
    ["mastery", inputs.mastery],
  ] as const) {
    if (value !== 0) {
      warnings.push({
        code: "unused-input",
        message: `${name} is carried but not applied by damageIndex — it cancels in every marginal, so no comparison on this page is affected.`,
      });
    }
  }

  const damageIndexValue = range * damageTerm * fdTerm * critTerm * defTerm;

  return {
    range,
    damageTerm,
    fdTerm,
    critTerm,
    defTerm,
    rawDefTerm,
    damageIndex: damageIndexValue,
    warnings,
    meaningful: rawDefTerm > 0 && typeof wm === "number",
  };
}

/**
 * A single comparable damage number. Unitless — it is an index, not damage and
 * emphatically not DPS. Only ever compare it against another `damageIndex`
 * produced by this same module with the same constants.
 */
export function damageIndex(inputs: DamageInputs, opts: DamageOptions): number {
  return damageBreakdown(inputs, opts).damageIndex;
}

/**
 * Average-over-the-range index. Damage rolls uniformly between `mastery * max`
 * and `max`, so the expectation is `max * (1 + mastery) / 2`. This is the only
 * place mastery is used. Kept separate from `damageIndex` because a mastery
 * factor is common to every stat comparison and would only obscure the audit.
 */
export function expectedDamageIndex(inputs: DamageInputs, opts: DamageOptions): number {
  const m = Math.min(Math.max(inputs.mastery, 0), MASTERY_CAP);
  return damageIndex(inputs, opts) * ((1 + m) / 2);
}

/* ============================================================================
 * MARGINAL VALUE
 * ==========================================================================*/

/**
 * Central difference would be more accurate; forward difference is used because
 * the perturbations here are the real, discrete things a player can buy (one
 * ATT, one potential line), not infinitesimals. Either way this is computed
 * numerically rather than from hand-derived partial derivatives on purpose: a
 * gradient rots silently the moment someone edits a term above, a finite
 * difference does not.
 */
function diffPct(
  base: number,
  inputs: DamageInputs,
  opts: DamageOptions,
  patch: Partial<DamageInputs>,
): number {
  if (base === 0) return 0;
  return (damageIndex({ ...inputs, ...patch }, opts) / base - 1) * 100;
}

/**
 * Marginal value of one more of each stat, as a percentage change in
 * damageIndex. Sort descending by `gainPct` for "what should I buy next".
 *
 * Every row is one finite difference against the same baseline, so the rows are
 * directly comparable to each other but are NOT additive — buying two of them
 * does not gain the sum, because the terms multiply.
 */
export function marginal(inputs: DamageInputs, opts: DamageOptions): Marginal[] {
  const base = damageIndex(inputs, opts);
  const rows: Marginal[] = [
    {
      stat: "mainStat",
      label: "+1% main stat",
      delta: 0.01,
      gainPct: diffPct(base, inputs, opts, { mainStat: inputs.mainStat * 1.01 }),
      // In game a %stat potential line multiplies BASE stat (base + AP) only,
      // not flat stat from flames, symbols or hyper stats. Perturbing the total
      // therefore overstates a real %stat line for a symbol-heavy character —
      // which the user is, at 1060 Arcane Power. Use marginalMainStatLine for
      // the honest per-line number.
      note: "Perturbs total stat. A real %stat line applies to base stat only, so it buys less than this.",
    },
    {
      stat: "att",
      label: "+1 ATT",
      delta: 1,
      gainPct: diffPct(base, inputs, opts, { att: inputs.att + 1 }),
    },
    {
      stat: "attPct",
      label: "+1% ATT",
      delta: 0.01,
      gainPct: diffPct(base, inputs, opts, { attPct: inputs.attPct + 0.01 }),
    },
    {
      stat: "dmgPct",
      label: "+1% damage",
      delta: 0.01,
      gainPct: diffPct(base, inputs, opts, { dmgPct: inputs.dmgPct + 0.01 }),
    },
    {
      stat: "bossPct",
      label: "+1% boss damage",
      delta: 0.01,
      gainPct: diffPct(base, inputs, opts, { bossPct: inputs.bossPct + 0.01 }),
    },
    {
      stat: "critDmg",
      label: "+1% crit damage",
      delta: 0.01,
      gainPct: diffPct(base, inputs, opts, { critDmg: inputs.critDmg + 0.01 }),
    },
    {
      stat: "critRate",
      label: "+1% crit rate",
      delta: 0.01,
      gainPct: diffPct(base, inputs, opts, { critRate: inputs.critRate + 0.01 }),
      note:
        inputs.critRate >= 1
          ? "Crit rate is capped. Every further point is worth exactly zero."
          : undefined,
    },
    {
      stat: "finalDmgPct",
      label: "+1% final damage",
      delta: 0.01,
      gainPct: diffPct(base, inputs, opts, { finalDmgPct: inputs.finalDmgPct + 0.01 }),
    },
    {
      stat: "ied",
      label: "+1 effective IED point",
      delta: 0.01,
      gainPct: diffPct(base, inputs, opts, { ied: Math.min(1, inputs.ied + 0.01) }),
      // The brief's framing — "at 92.9% IED the next point is worth far less
      // than at 50%" — is the opposite of what the formula does, and coding it
      // as written would teach the wrong lesson. For a FIXED boss the damage
      // term is linear in EFFECTIVE IED: d/di of (1 - P(1-i)) is exactly P, a
      // constant. Because the denominator shrinks as IED rises, the RELATIVE
      // gain per effective point actually RISES near the cap. The real
      // diminishing return lives entirely in the stacking step — see
      // marginalIedLine, which is the number a player buying a cube needs.
      note: "Per EFFECTIVE point. Effective points get harder to buy near the cap, not less valuable — see the IED line figure.",
    },
  ];
  return rows;
}

/**
 * Marginal value of one IED POTENTIAL LINE, e.g. "Ignore DEF +20%".
 *
 * Deliberately named and typed apart from the +1-point IED marginal, because
 * conflating them is the single easiest way to mislead a player. A 20% line at
 * 50% IED buys 10 effective points; the same line at 92.9% buys 1.42
 * (1 - 0.071 * 0.80 = 94.32%). That collapse is the whole diminishing return,
 * and it happens before the damage formula is ever reached.
 *
 * Show `effectiveIedPoints` next to `gainPct` in the UI. Showing either alone
 * teaches the wrong lesson.
 */
export function marginalIedLine(
  inputs: DamageInputs,
  lineValue: number,
  opts: DamageOptions = { pdr: DEFAULT_PDR },
): IedLineResult {
  const before = damageBreakdown(inputs, opts);
  const newIed = stackIed(inputs.ied, lineValue);
  const effectiveIedPoints = (newIed - inputs.ied) * 100;
  const after = damageBreakdown({ ...inputs, ied: newIed }, opts);
  const gainPct = before.damageIndex === 0 ? 0 : (after.damageIndex / before.damageIndex - 1) * 100;

  return {
    lineValue,
    ied: inputs.ied,
    newIed,
    effectiveIedPoints,
    gainPct,
    gainPctPerEffectivePoint: effectiveIedPoints === 0 ? 0 : gainPct / effectiveIedPoints,
    // A floored baseline makes the ratio meaningless, so carry the warning out
    // with the number rather than letting the UI print a confident percentage.
    warnings: before.warnings.filter((w) => w.code === "def-term-floored"),
  };
}

/**
 * Marginal value of one %stat POTENTIAL LINE, which is not the same thing as
 * +1% of your total stat. A %stat line multiplies base stat only, so it is
 * diluted by every flat point from symbols, flames and hyper stats.
 *
 * @param baseStatPortion fraction of `mainStat` that comes from base + AP and
 *        is therefore actually multiplied by the line. The caller must supply
 *        it; there is no defensible default, and guessing one would be
 *        inventing a constant about a specific player's gear.
 */
export function marginalMainStatLine(
  inputs: DamageInputs,
  opts: DamageOptions,
  linePct: number,
  baseStatPortion: number,
): Marginal {
  const base = damageIndex(inputs, opts);
  const gained = inputs.mainStat * baseStatPortion * linePct;
  return {
    stat: "mainStat",
    label: `+${(linePct * 100).toFixed(0)}% main stat line`,
    delta: linePct,
    gainPct: diffPct(base, inputs, opts, { mainStat: inputs.mainStat + gained }),
    note: `Assumes ${(baseStatPortion * 100).toFixed(0)}% of your stat is base stat the line can multiply.`,
  };
}

/* ============================================================================
 * ADAPTERS AND FIXTURES
 * ==========================================================================*/

/**
 * Display-percentage shape, i.e. what the stat window and the planner's own
 * inputs hold: 41.5 rather than 0.415.
 *
 * ASSUMPTION RECORDED: this is structurally compatible with the widened `Stats`
 * interface in ./rules that another agent is adding (`main`, `att`, `crit`,
 * `critdmg`, `boss`, `ied`, plus the new `dmgPct`, `finalDmg`, `attPct`,
 * `secondary`, `mastery`). It is declared locally rather than imported so this
 * module stays dependency-free and cannot be broken by a change over there. If
 * the field names in ./rules land differently, fix the mapping here, not the
 * model.
 */
export interface PercentStats {
  main: number;
  att: number;
  crit: number;
  critdmg: number;
  boss: number;
  ied: number;
  dmgPct?: number;
  finalDmg?: number;
  attPct?: number;
  secondary?: number;
  mastery?: number;
}

/** Convert display percentages to model fractions. */
export function inputsFromPercentStats(
  s: PercentStats,
  weaponMultiplier: string,
  charLevel: number,
): DamageInputs {
  return {
    mainStat: s.main,
    secondaryStat: s.secondary ?? 0,
    att: s.att,
    attPct: (s.attPct ?? 0) / 100,
    dmgPct: (s.dmgPct ?? 0) / 100,
    bossPct: s.boss / 100,
    finalDmgPct: (s.finalDmg ?? 0) / 100,
    critRate: s.crit / 100,
    critDmg: s.critdmg / 100,
    ied: s.ied / 100,
    weaponMultiplier,
    mastery: (s.mastery ?? 0) / 100,
    charLevel,
    skillPct: 0,
  };
}

/**
 * The live character this planner was built for, as a locked test vector.
 * GMS Heroic, v.271, Bow Master Lv 244.
 *
 * `secondaryStat`, `attPct`, `dmgPct` and `finalDmgPct` are 0 because they were
 * never captured — they are NOT known to be zero. `finalDmgPct` in particular
 * is almost certainly non-zero for a Bowmaster and its absence makes the
 * absolute index low. Every ratio this module reports is unaffected by
 * `finalDmgPct` (it is a common factor) but `dmgPct` DOES move the boss-damage
 * marginal, so that row is optimistic until the field is filled in.
 */
export const LIVE_CHARACTER: DamageInputs = {
  mainStat: 19051,
  secondaryStat: 0,
  att: 1471,
  attPct: 0,
  dmgPct: 0,
  bossPct: 1.59,
  finalDmgPct: 0,
  critRate: 0.98,
  critDmg: 0.415,
  ied: 0.929,
  weaponMultiplier: "bow",
  mastery: 0,
  charLevel: 244,
  skillPct: 0,
};
