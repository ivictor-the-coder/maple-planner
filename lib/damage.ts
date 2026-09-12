/**
 * MapleStory GMS damage model — the quantitative core, plus the bridge that
 * makes it usable from the app.
 *
 * WHAT THIS IS
 * A single comparable number (`damageIndex`) for a character, plus the marginal
 * value of each stat, plus a `Character` -> inputs adapter so the planner can
 * call it with the object it already holds.
 *
 * WHAT THIS IS EXPLICITLY NOT — do not assume a later piece can read these off
 * this module, because they are not modelled here at all:
 *   - attack speed, skill rotations, cooldowns, summon uptime
 *   - per-class final-damage passives (LISTED in CLASS_CONSTANTS, not applied
 *     by default — see `classBuffs` on the adapter), buff uptime
 *   - meso cost of any upgrade
 *   - hit count / lines per skill, mob count, positioning
 * `damageIndex` is therefore NOT DPS and must never be labelled as such in the
 * UI. It answers "which stat is worth more", never "how long to kill Lucid".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * UNITS. THIS IS THE ONE THING THAT WILL BITE YOU.
 *
 * Everything in THIS module that is percentage-shaped is a FRACTION:
 *   92.9% IED -> 0.929,  41.5% crit damage -> 0.415,  159% boss -> 1.59.
 *
 * `lib/cubes.ts` has its own damage model whose percentage-shaped fields are
 * PRINTED PERCENTS (92.9, 41.5, 159). The two models are NOT interchangeable
 * and mixing them is a silent 100x error, so the names here are unit-tagged:
 *
 *   this module            lib/cubes.ts          units
 *   FractionalDamageInputs DamageInputs          fraction vs printed percent
 *   stackIedFractions      stackIed              fraction vs printed percent
 *
 * There is exactly ONE place a printed percent becomes a fraction in this file:
 * `printedPercentToFraction`. Every adapter routes through it. If you are
 * writing `/ 100` anywhere else, you are re-introducing the bug.
 *
 * `DamageInputs` survives here only as a deprecated alias of
 * `FractionalDamageInputs` because lib/farming.ts still imports that name.
 * See WHAT THE OTHER SIDE MUST DO at the bottom of this header.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * DEPENDENCIES: none, deliberately. No React, no storage, no ./rules import —
 * the `Character` adapter takes a structural `CharacterLike`, which
 * `rules.Character` satisfies without either file importing the other. Every
 * value here is a plain number so this is testable without a browser.
 *
 * SCOPE OF TRUTH: GMS Heroic (Reboot), patch v.271. KMS numbers are not GMS
 * numbers and are not used.
 *
 * WHAT THE OTHER SIDE MUST DO (neither file is owned by this change):
 *   1. lib/cubes.ts should rename its `DamageInputs` -> `PercentDamageInputs`
 *      and its `stackIed` -> `stackIedPercents`. Its units are printed
 *      percents; the names should say so, exactly as they now do here.
 *   2. lib/farming.ts should import `FractionalDamageInputs` instead of
 *      `DamageInputs` (line 77). Once it does, delete the deprecated alias.
 *   Until (1) lands, never write `import { stackIed } from "./cubes"` in the
 *   same file as anything from here.
 *
 * @module lib/damage
 */

/* ============================================================================
 * UNIT DISCIPLINE
 *
 * The single conversion point. Named so that reading a call site tells you the
 * units on both sides without opening this file.
 * ==========================================================================*/

/** Printed percents are hundredths. Exported so the number 100 never appears
 *  bare in a conversion anywhere in this codebase. */
export const PRINTED_PERCENT_DIVISOR = 100;

/**
 * THE conversion. A stat window reads "Ignore DEF 92.9%"; the model wants
 * 0.929. Nothing else in this module divides by 100.
 *
 * Call it at the boundary — the moment a number leaves `rules.Stats`, a form
 * field, or an OCR import — never in the middle of a formula.
 */
export function printedPercentToFraction(printed: number): number {
  return printed / PRINTED_PERCENT_DIVISOR;
}

/** The inverse, for putting a model number back on screen. */
export function fractionToPrintedPercent(fraction: number): number {
  return fraction * PRINTED_PERCENT_DIVISOR;
}

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
 * How much of a constant is real. Deliberately the SAME three string literals
 * as `rules.Conf` so one UI badge renders both vocabularies — this module does
 * not add a fourth confidence language to the three that already exist.
 *   - `sourced`     a named source states this exact number for modern GMS.
 *   - `modelled`    the inputs are sourced, the number here needs a documented
 *                   interpretation on top (e.g. a buff-uptime assumption).
 *   - `placeholder` legacy or inferred. Do not budget against it.
 */
export type ConstantConf = "sourced" | "modelled" | "placeholder";

/**
 * LEGACY per-weapon table. Kept because `inputsFromPercentStats` takes a weapon
 * key and lib/farming.ts calls it with "bow", but it is NOT the number a modern
 * GMS class uses — see CLASS_CONSTANTS, which supplies the class multiplier
 * that actually occupies this slot today.
 *
 * Source: https://ayumilove.net/maplestory-formula/ weapon table, corroborated
 * by https://maplestorywiki.net/w/Damage_Formula for the shape of the range
 * formula. `placeholder` for every modern class: for a Bow Master the correct
 * figure is 1.3 (CLASS_CONSTANTS), not the 1.15 legacy Bow row — a 13%
 * difference on the absolute number.
 *
 * It cancels exactly in every ratio this module reports (see `marginal`), so
 * percentages are unaffected — but an absolute `damageIndex` built on this
 * table is comparable only against itself.
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

/** Confidence of every row of WEAPON_MULTIPLIER, as one value. */
export const WEAPON_MULTIPLIER_CONF: ConstantConf = "placeholder";

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
 *
 * The band matters for one Bow Master constant specifically: Bow Expert raises
 * MINIMUM crit damage, which moves the band's floor, not the printed stat. See
 * `BOW_MASTER.minCritDamageBonus`.
 */
export const CRIT_DAMAGE_BASE = 0.35;

/** Source: grandislibrary.com/content/stat-terms — lower bound of the crit band. UNVERIFIED. */
export const CRIT_DAMAGE_BAND_LOW = 0.2;
/** Source: grandislibrary.com/content/stat-terms — upper bound of the crit band. UNVERIFIED. */
export const CRIT_DAMAGE_BAND_HIGH = 0.5;

/**
 * Source: https://ayumilove.net/maplestory-formula/ — initial mastery by combat
 * type: melee 20%, ranged (bow/crossbow) 15%, magic 25%.
 * Corroborated for bow specifically by https://grandislibrary.com/explorers/bowmaster,
 * which itemises Bow Master's 85% mastery as "Base: +15%, Bow Expert: +70%".
 * Mastery does not affect maximum damage, only how close minimum sits to it —
 * see `expectedDamageIndex` and `damageRange`.
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
 * CLASS CONSTANTS
 *
 * ONE exported table, keyed by class. Adding Night Lord later is a new entry in
 * CLASS_CONSTANTS and nothing else — never a change to a formula above.
 *
 * ONLY BOW MASTER IS PRESENT. That is deliberate and binding: no constant for
 * any other class has been researched, and a confidently wrong damage number
 * sends a real person to grind for nothing. `classConstantsFor` returns
 * undefined for an unknown class and every caller degrades visibly.
 * ==========================================================================*/

/** Structurally identical to `rules.MainStat`; declared locally to keep this
 *  module import-free. */
export type StatKey = "dex" | "str" | "int" | "luk";

/** One sourced number, with the citation attached to the value rather than to a
 *  comment that can drift away from it. */
export interface SourcedNumber {
  /** The value, in this module's units (fractions for anything percentage-shaped). */
  readonly value: number;
  readonly conf: ConstantConf;
  /** URL or publication the value came from. */
  readonly source: string;
  /** What the number means and what would make it wrong. */
  readonly note: string;
}

export interface ClassConstants {
  /** Exactly as `Character.cls` spells it. */
  readonly cls: string;
  readonly mainStat: StatKey;
  readonly secondaryStat: StatKey;
  /** Key into WEAPON_MULTIPLIER. Retained for the legacy path only. */
  readonly weaponKey: string;
  /**
   * The multiplier this class actually uses in the modern range formula. This
   * supersedes the WEAPON_MULTIPLIER row for `weaponKey`, which is legacy.
   */
  readonly weaponMultiplier: SourcedNumber;
  /** Total weapon mastery as a fraction. Moves minimum damage only. */
  readonly mastery: SourcedNumber;
  /**
   * Final Damage sources, each as a fraction. They stack MULTIPLICATIVELY, not
   * additively — fold them with `stackFinalDamage`. NOT applied by default:
   * every one of these is a skill with an uptime this module cannot know.
   */
  readonly finalDamageSources: readonly SourcedNumber[];
  /**
   * Bow Expert raises MINIMUM Critical Damage, which lifts the floor of the
   * [20%, 50%] crit band rather than adding to the printed Critical Damage
   * stat. Whether the stat window already reflects it is unresolved, so it is
   * listed and never applied. See `critBandMidpointWithMinBonus`.
   */
  readonly minCritDamageBonus: SourcedNumber;
  /**
   * Class contributions that the stat window ALREADY SHOWS. Listed so nobody
   * re-adds them on top of `Character.stats` — adding these would double-count.
   * Read-only documentation; no function in this file consumes them.
   */
  readonly alreadyInStatWindow: {
    readonly critRate: SourcedNumber;
    readonly critDamage: SourcedNumber;
    readonly bossDamage: SourcedNumber;
    readonly ied: SourcedNumber;
    readonly attPct: SourcedNumber;
  };
}

/**
 * Bow Master, GMS, v.271.
 *
 * Primary source for every figure below unless stated otherwise:
 * https://grandislibrary.com/explorers/bowmaster — the class overview's base
 * stat table, which itemises each figure by the skill that grants it.
 */
export const BOW_MASTER: ClassConstants = {
  cls: "Bow Master",
  mainStat: "dex",
  secondaryStat: "str",
  weaponKey: "bow",
  weaponMultiplier: {
    value: 1.3,
    conf: "sourced",
    source: "https://grandislibrary.com/explorers/bowmaster — 'Weapon Multiplier: 1.3x'",
    note:
      "The modern GMS range formula folds a per-CLASS multiplier into the weapon slot. " +
      "The legacy AyumiLove Bow row says 1.15; Grandis Library states 1.3 for Bow Master " +
      "specifically and that is the GMS-current reading. This is the single largest lever " +
      "on the absolute index (13% between the two) and it is directly falsifiable: see " +
      "`damageRange`, which must match the character's in-game stat window.",
  },
  mastery: {
    value: 0.85,
    conf: "sourced",
    source:
      "https://grandislibrary.com/explorers/bowmaster — 'Weapon Mastery: 85% (Base +15%, Bow Expert +70%)'; " +
      "corroborated by https://maplestorywiki.net/w/Bow_Master/Skills — Bow Expert Lv30 'Bow Mastery: +70%'",
    note:
      "Total mastery at Bow Expert level 30. Affects MINIMUM damage only: max range is " +
      "untouched, so `damageIndex` (a max-range index) does not use it. Consumed by " +
      "`expectedDamageIndex` and `damageRange`.",
  },
  finalDamageSources: [
    {
      value: 0.3,
      conf: "sourced",
      source: "https://grandislibrary.com/explorers/bowmaster — 'Reckless Hunt: Bow: +30%' under Final Damage",
      note: "Toggle buff. Costs HP to maintain; uptime is a player choice this module cannot see.",
    },
    {
      value: 0.06,
      conf: "sourced",
      source: "https://grandislibrary.com/explorers/bowmaster — 'Enchanted Quiver: +6%' under Final Damage",
      note: "Buff skill. Uptime not modelled.",
    },
    {
      value: 0.16,
      conf: "sourced",
      source: "https://grandislibrary.com/explorers/bowmaster — 'Armor Break: +16%' under Final Damage",
      note: "Applied as a debuff on the target; also the source of +40% of the class IED. Uptime not modelled.",
    },
    {
      value: 0.15,
      conf: "sourced",
      source: "https://grandislibrary.com/explorers/bowmaster — 'Quiver Barrage: +15%' under Final Damage",
      note: "Conditional, the least reliable of the four. Excluded from any 'realistic' subset a caller builds.",
    },
  ],
  minCritDamageBonus: {
    value: 0.15,
    conf: "modelled",
    source:
      "https://maplestorywiki.net/w/Bow_Master/Skills — Bow Expert Lv30 'Minimum Critical Damage: +15%'. " +
      "Grandis Library's crit-damage row lists 'Bow Expert: +16%', a 1pp disagreement.",
    note:
      "UNRESOLVED and therefore never applied: this raises the FLOOR of the [20%, 50%] crit " +
      "band, moving the band midpoint from 35% to 42.5%, i.e. a +7.5pp effective crit damage. " +
      "It is unknown whether the printed Critical Damage stat already folds it in. Applying it " +
      "on a stat window that already includes it double-counts by 7.5pp. Use " +
      "`critBandMidpointWithMinBonus` to price the other reading.",
  },
  alreadyInStatWindow: {
    critRate: {
      value: 0.75,
      conf: "sourced",
      source: "https://grandislibrary.com/explorers/bowmaster — 'Crit Rate: +75% (base +5%)'",
      note: "From Adventurer's Curiosity +10, Critical Shot +40, Sharp Eyes +20. DO NOT ADD: stats.crit already shows it.",
    },
    critDamage: {
      value: 0.31,
      conf: "sourced",
      source: "https://grandislibrary.com/explorers/bowmaster — 'Crit Damage: +31%'",
      note: "Sharp Eyes +15, Bow Expert +16. DO NOT ADD: stats.critdmg already shows it.",
    },
    bossDamage: {
      value: 0.2,
      conf: "sourced",
      source: "https://grandislibrary.com/explorers/bowmaster — 'Boss Damage: Concentration +20%'",
      note: "DO NOT ADD: stats.boss already shows it.",
    },
    ied: {
      value: 0.5725,
      conf: "sourced",
      source:
        "https://grandislibrary.com/explorers/bowmaster — Marksmanship +25%, Armor Break +40%, " +
        "Sharp Eyes-Guardbreak +5%, stacked multiplicatively: 1 - 0.75*0.60*0.95 = 0.5725",
      note: "DO NOT ADD: stats.ied already shows the stacked total. Re-stacking would push 92.9% to 97.0%.",
    },
    attPct: {
      value: 0.29,
      conf: "sourced",
      source: "https://grandislibrary.com/explorers/bowmaster — 'Attack: +29% (49%) +150 (200)'",
      note:
        "DO NOT ADD: the GMS stat window's ATT figure is already the post-multiplier total. " +
        "This is why the adapter defaults attPct to 0 — that default is CORRECT, not a degradation.",
    },
  },
};

/**
 * THE class table. One entry, on purpose.
 *
 * Keys are lower-cased and space-stripped so "Bow Master", "Bowmaster" and
 * "bow master" all resolve. Add a class by adding a row, never by editing a
 * formula above.
 */
/**
 * CONFIRMED IN GAME, 2026-09-12, from Archerroni's Damage Range tooltip, which
 * prints the game's own values rather than a community transcription:
 *
 *   [Current Applied Weapon Constant]  1.30
 *   [Weapon Mastery]                   85%
 *
 * Both match BOW_MASTER below exactly. The competing reading of 1.15, which
 * would have moved every damage figure in the app by 13%, is refuted.
 *
 * The same tooltip also prints the ranges themselves:
 *   Default 6,128,555 | Normal Enemy 6,199,405 | Boss 11,761,157
 * at Lv 245, DEX 20,809, and those are roughly 3.9x what damageRange() returns.
 * The CONSTANTS are therefore right and the MULTIPLIER STACK is incomplete -
 * the tooltip says it accounts for "Damage bonuses and Final Damage bonuses
 * from skills and equipment", and this model defaults both to zero. See
 * DAMAGE_RANGE_GAP.
 */
export const OBSERVED_WEAPON_CONSTANT_BOWMASTER = 1.30;
export const OBSERVED_WEAPON_MASTERY_BOWMASTER = 0.85;

/** Measured shortfall of damageRange() against the game's own printed range. */
export const DAMAGE_RANGE_GAP = {
  observedAt: "2026-09-12",
  character: "Archerroni, Bow Master, Lv 245, DEX 20,809, ATT 1,471",
  gamePrinted: { default: 6_128_555, normalEnemy: 6_199_405, boss: 11_761_157 },
  whatIsMissing:
    "Final Damage and Damage% are both defaulted to 0 by the adapter, and the " +
    "character has hyper stat Damage at Lv 10 plus Bow Master's passive final " +
    "damage stack. Buffs alone (+83.83% FD) close less than half the gap, so " +
    "something else is unmodelled. Do not scale the constants to fit - they are " +
    "confirmed correct; the missing terms are multipliers.",
} as const;

export const CLASS_CONSTANTS: Record<string, ClassConstants> = {
  bowmaster: BOW_MASTER,
};

/** Normalise a `Character.cls` string into a CLASS_CONSTANTS key. */
export function classKey(cls: string): string {
  return cls.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Look up a class. Returns undefined for anything but Bow Master — callers must
 * degrade visibly rather than substituting a guess, because there is no
 * defensible "average class" multiplier.
 */
export function classConstantsFor(cls: string): ClassConstants | undefined {
  return CLASS_CONSTANTS[classKey(cls)];
}

/** Final Damage buckets multiply. Fold a subset of `finalDamageSources` into
 *  one fraction suitable for `FractionalDamageInputs.finalDmgPct`. */
export function stackFinalDamage(sources: readonly SourcedNumber[]): number {
  return sources.reduce((acc, s) => acc * (1 + s.value), 1) - 1;
}

/**
 * The crit-band midpoint under the OTHER reading of Bow Expert: if the printed
 * Critical Damage stat does NOT already include the minimum-crit-damage bonus,
 * the band is [low + bonus, high] and its midpoint replaces CRIT_DAMAGE_BASE.
 * At the Bow Master value that is 0.425 rather than 0.35 — about +2.8% index.
 * Exported so the question can be priced instead of argued about.
 */
export function critBandMidpointWithMinBonus(minCritDamageBonus: number): number {
  const low = Math.min(CRIT_DAMAGE_BAND_LOW + minCritDamageBonus, CRIT_DAMAGE_BAND_HIGH);
  return (low + CRIT_DAMAGE_BAND_HIGH) / 2;
}

/* ============================================================================
 * TYPES
 * ==========================================================================*/

/**
 * Every input the GMS formula needs. All percentage-shaped fields are
 * FRACTIONS, not printed percentages: 41.5% crit damage is `0.415`, 159% boss
 * damage is `1.59`, 92.9% IED is `0.929`. `att` and the stat fields are flat
 * game values.
 *
 * The name says `Fractional` because lib/cubes.ts exports a `DamageInputs` of
 * the same shape in PRINTED PERCENTS. Never construct one of these by hand from
 * a stat window — use `fractionalInputsFromCharacter` or
 * `inputsFromPercentStats`, both of which route through
 * `printedPercentToFraction`.
 */
export interface FractionalDamageInputs {
  /** Flat primary stat, totalled as the stat window shows it (DEX for a Bow Master). */
  mainStat: number;
  /** Flat secondary stat (STR for a Bow Master). 0 is a legitimate value, not a sentinel. */
  secondaryStat: number;
  /** Flat weapon attack / magic attack as shown in the stat window. */
  att: number;
  /** ATT % from potentials and buffs, as a fraction. Normally 0 — see BOW_MASTER.alreadyInStatWindow.attPct. */
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
  /** EFFECTIVE Ignore Enemy DEF as a fraction, i.e. already stacked. See `stackIedFractions`. */
  ied: number;
  /**
   * The range multiplier. A NUMBER, resolved from CLASS_CONSTANTS or
   * WEAPON_MULTIPLIER before it gets here, so the model never has to guess what
   * an unknown string meant.
   */
  weaponMultiplier: number;
  /**
   * Weapon mastery as a fraction. NOT used by `damageIndex` — mastery moves the
   * minimum of the range, never the maximum. Consumed by `expectedDamageIndex`
   * and `damageRange`.
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

/**
 * @deprecated Ambiguous name — lib/cubes.ts exports `DamageInputs` in PRINTED
 * PERCENTS while this one is FRACTIONS. Import `FractionalDamageInputs`.
 * Retained only because lib/farming.ts:77 still imports this spelling; delete
 * once that import is updated.
 */
export type DamageInputs = FractionalDamageInputs;

export interface DamageOptions {
  /** Target boss PDR as a fraction: 3.0 = 300%. Look one up in BOSS_PDR. */
  pdr: number;
}

export type DamageWarningCode =
  | "def-term-floored"
  | "unknown-class"
  | "unknown-weapon"
  | "crit-rate-overcapped"
  | "assumed-default"
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
 * Effective IED after stacking one more source, IN FRACTIONS. IED sources
 * multiply their REMAINDERS rather than adding, which is the whole reason the
 * last points are expensive to buy and cheap to own.
 *
 * NAME: lib/cubes.ts exports a `stackIed` doing the same arithmetic on PRINTED
 * PERCENTS. `stackIedFractions(0.929, 0.20)` and `stackIed(92.9, 20)` are both
 * right and mixing them is a 100x error, so neither is called `stackIed` here.
 *
 * Source: https://grandislibrary.com/content/stat-terms — "calculated
 * multiplicatively ... it is impossible to obtain 100% IED". VERIFIED.
 */
export function stackIedFractions(current: number, line: number): number {
  return 1 - (1 - current) * (1 - line);
}

/** Fold a list of IED sources, all fractions, into one effective value. */
export function stackIedAllFractions(sources: readonly number[]): number {
  return sources.reduce<number>((acc, s) => stackIedFractions(acc, s), 0);
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
export function damageBreakdown(
  inputs: FractionalDamageInputs,
  opts: DamageOptions,
): DamageBreakdown {
  const warnings: DamageWarning[] = [];

  const weapon = Number.isFinite(inputs.weaponMultiplier) && inputs.weaponMultiplier > 0
    ? inputs.weaponMultiplier
    : 1;
  if (weapon !== inputs.weaponMultiplier) {
    warnings.push({
      code: "unknown-weapon",
      message:
        `Weapon multiplier ${String(inputs.weaponMultiplier)} is not a usable number — using 1. ` +
        `Absolute numbers are wrong; ratios are unaffected.`,
    });
  }

  // Crit rate above 100% is worth exactly zero. Clamping here, once, is what
  // makes the crit-rate marginal fall to 0 at the cap instead of lying.
  const critRateClamped = Math.min(inputs.critRate, 1);
  if (inputs.critRate > 1) {
    warnings.push({
      code: "crit-rate-overcapped",
      message: `Crit rate is ${fractionToPrintedPercent(inputs.critRate).toFixed(1)}% — everything above 100% is dead. Move it to crit damage.`,
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
        `Effective IED ${fractionToPrintedPercent(inputs.ied).toFixed(1)}% is below the ${fractionToPrintedPercent(iedWall(opts.pdr)).toFixed(1)}% wall for a ` +
        `${fractionToPrintedPercent(opts.pdr).toFixed(0)}% defence boss. In game you would deal 1 damage per hit. ` +
        `This number is floored and is not a damage figure — fix IED before reading anything else here.`,
    });
  }

  // Only skillPct earns this warning. `mastery` is also unused HERE, but it has
  // real consumers in this module (`damageRange`, `expectedDamageIndex`) and the
  // Character adapter always sets it from the class table, so warning on it
  // would fire on every single character and mean nothing.
  if (inputs.skillPct !== 0) {
    warnings.push({
      code: "unused-input",
      message:
        "skillPct is carried but not applied by damageIndex — it cancels in every marginal, so no comparison on this page is affected.",
    });
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
    meaningful: rawDefTerm > 0 && weapon === inputs.weaponMultiplier,
  };
}

/**
 * A single comparable damage number. Unitless — it is an index, not damage and
 * emphatically not DPS. Only ever compare it against another `damageIndex`
 * produced by this same module with the same constants.
 */
export function damageIndex(inputs: FractionalDamageInputs, opts: DamageOptions): number {
  return damageBreakdown(inputs, opts).damageIndex;
}

/**
 * Average-over-the-range index. Damage rolls uniformly between `mastery * max`
 * and `max`, so the expectation is `max * (1 + mastery) / 2`. This is the only
 * place mastery is used. Kept separate from `damageIndex` because a mastery
 * factor is common to every stat comparison and would only obscure the audit.
 */
export function expectedDamageIndex(
  inputs: FractionalDamageInputs,
  opts: DamageOptions,
): number {
  const m = Math.min(Math.max(inputs.mastery, 0), MASTERY_CAP);
  return damageIndex(inputs, opts) * ((1 + m) / 2);
}

/**
 * THE FALSIFIABLE CHECK.
 *
 * Damage Range is the one number in this whole model that the game prints back
 * at the player, on the stat window, with no opaque Nexon formula in between.
 * It is `weaponMultiplier * (4*main + secondary) * att/100`, with the minimum
 * being `max * mastery`.
 *
 * If `max` here does not match what the character's stat window shows, the
 * class constants are wrong and everything downstream is wrong with them. That
 * is a much better test than comparing an index to Combat Power, which is a
 * different, undocumented formula.
 */
export function damageRange(inputs: FractionalDamageInputs): { min: number; max: number } {
  const weapon = Number.isFinite(inputs.weaponMultiplier) && inputs.weaponMultiplier > 0
    ? inputs.weaponMultiplier
    : 1;
  const max =
    weapon *
    (STAT_MULTIPLIER_MAIN * inputs.mainStat + inputs.secondaryStat) *
    (inputs.att / 100) *
    (1 + inputs.attPct);
  const m = Math.min(Math.max(inputs.mastery, 0), MASTERY_CAP);
  return { min: max * m, max };
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
  inputs: FractionalDamageInputs,
  opts: DamageOptions,
  patch: Partial<FractionalDamageInputs>,
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
export function marginal(inputs: FractionalDamageInputs, opts: DamageOptions): Marginal[] {
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
      // The framing "at 92.9% IED the next point is worth far less than at 50%"
      // is the opposite of what the formula does, and coding it as written would
      // teach the wrong lesson. For a FIXED boss the damage term is linear in
      // EFFECTIVE IED: d/di of (1 - P(1-i)) is exactly P, a constant. Because
      // the denominator shrinks as IED rises, the RELATIVE gain per effective
      // point actually RISES near the cap. The real diminishing return lives
      // entirely in the stacking step — see marginalIedLine, which is the number
      // a player buying a cube needs.
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
 *
 * @param lineValue the line as a FRACTION: "Ignore DEF +20%" is 0.20.
 */
export function marginalIedLine(
  inputs: FractionalDamageInputs,
  lineValue: number,
  opts: DamageOptions = { pdr: DEFAULT_PDR },
): IedLineResult {
  const before = damageBreakdown(inputs, opts);
  const newIed = stackIedFractions(inputs.ied, lineValue);
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
  inputs: FractionalDamageInputs,
  opts: DamageOptions,
  linePct: number,
  baseStatPortion: number,
): Marginal {
  const base = damageIndex(inputs, opts);
  const gained = inputs.mainStat * baseStatPortion * linePct;
  return {
    stat: "mainStat",
    label: `+${fractionToPrintedPercent(linePct).toFixed(0)}% main stat line`,
    delta: linePct,
    gainPct: diffPct(base, inputs, opts, { mainStat: inputs.mainStat + gained }),
    note: `Assumes ${fractionToPrintedPercent(baseStatPortion).toFixed(0)}% of your stat is base stat the line can multiply.`,
  };
}

/* ============================================================================
 * THE BRIDGE: Character -> FractionalDamageInputs
 * ==========================================================================*/

/**
 * The shape this module needs off a character. `rules.Character` satisfies it
 * structurally, so the planner can pass one straight in and neither file has to
 * import the other. If `rules.Stats` grows a field, widen this — do not import.
 */
export interface CharacterLike {
  readonly cls: string;
  readonly lvl: number;
  readonly stats: {
    /** PRINTED. Total main stat as the stat window shows it. */
    readonly main: number;
    /** PRINTED. Total weapon attack — already includes ATT% multipliers. */
    readonly att: number;
    /** PRINTED PERCENT. 98 means 98%. */
    readonly crit: number;
    /** PRINTED PERCENT. 41.5 means 41.5%. */
    readonly critdmg: number;
    /** PRINTED PERCENT. 159 means 159%. */
    readonly boss: number;
    /** PRINTED PERCENT, already stacked. 92.9 means 92.9%. */
    readonly ied: number;
  };
}

/**
 * How much of the class's own buff stack to fold into Final Damage.
 *   - "none"         (default) finalDmgPct = 0 unless the caller passes one.
 *   - "all-buffs-up" the full multiplicative stack from CLASS_CONSTANTS, i.e.
 *                    every listed skill active simultaneously. That is a
 *                    ceiling, not a realistic sustained figure.
 * There is deliberately no middle option: no source gives buff uptimes, so a
 * "realistic" preset would be an invented constant. A caller who wants a subset
 * builds it explicitly with `stackFinalDamage`.
 */
export type ClassBuffMode = "none" | "all-buffs-up";

export interface CharacterAdapterOptions {
  /** Target boss PDR as a fraction. Defaults to DEFAULT_PDR (3.0). */
  readonly pdr?: number;
  /** See ClassBuffMode. Defaults to "none". */
  readonly classBuffs?: ClassBuffMode;
  /** Flat secondary stat (STR for a Bow Master). `Character` does not carry it. Defaults to 0. */
  readonly secondaryStat?: number;
  /** Damage % as a PRINTED PERCENT, if the caller knows it. `Character` does not carry it. Defaults to 0. */
  readonly dmgPctPrinted?: number;
  /** Final Damage % as a PRINTED PERCENT. Overrides `classBuffs` when supplied. Defaults to the classBuffs result. */
  readonly finalDmgPctPrinted?: number;
  /** ATT % as a PRINTED PERCENT. Defaults to 0, which is CORRECT — stats.att is already post-multiplier. */
  readonly attPctPrinted?: number;
  /**
   * Force a multiplier instead of resolving one from the class table. Use for
   * the unverified-class path or to A/B the 1.3 vs legacy-1.15 reading.
   */
  readonly weaponMultiplierOverride?: number;
}

/** What the adapter produced, and every assumption it had to make to produce it. */
export interface CharacterAdaptation {
  readonly inputs: FractionalDamageInputs;
  readonly opts: DamageOptions;
  /** The class row used, or undefined when the class is not in CLASS_CONSTANTS. */
  readonly classConstants: ClassConstants | undefined;
  /** One plain sentence per defaulted field. Render these next to any number derived from them. */
  readonly assumptions: string[];
  readonly warnings: DamageWarning[];
}

/**
 * THE adapter. `rules.Character` holds PRINTED percents; the model wants
 * FRACTIONS. This is the only function in the app that spans that boundary for
 * a whole character, and it routes every field through
 * `printedPercentToFraction`, so a call site cannot get the 100x wrong.
 *
 * DEFAULTS, and what each one assumes — all of them also come back in
 * `assumptions` so the UI can say them out loud:
 *
 *   secondaryStat  0.  `Character` has no STR field. A Bow Master's STR
 *                  contributes at 1x against DEX's 4x, so a realistic ~1,500
 *                  STR is worth about 1.8% of range. UNDERSTATES the index by
 *                  that much; cancels in every marginal except main stat's.
 *   attPct         0.  NOT a degradation — GMS prints total ATT in the stat
 *                  window, already multiplied. Anything else double-counts.
 *   dmgPct         0.  `Character` has no Damage% field and GMS does not print
 *                  one. Bow Master's own passives alone are +6% baseline
 *                  (BOW_MASTER.alreadyInStatWindow is explicit that boss% IS
 *                  printed but damage% is not). UNDERSTATES the index, and this
 *                  is the one default that also biases a comparison: because
 *                  boss% and damage% share one additive bucket, a zero damage%
 *                  makes the boss-damage marginal LOOK BETTER than it is.
 *   finalDmgPct    0.  Not printed anywhere in game. Bow Master's sourced
 *                  sources multiply to +83.8% with everything up. A pure common
 *                  factor: it changes the absolute index and no comparison at
 *                  all. Pass classBuffs:"all-buffs-up" to include it.
 *   mastery        class value (0.85 for Bow Master), else RANGE_MASTERY_BASE.
 *                  Unused by damageIndex; used by damageRange.
 *   pdr            DEFAULT_PDR, 3.0 — the Arcane River standard.
 */
export function fractionalInputsFromCharacter(
  ch: CharacterLike,
  options: CharacterAdapterOptions = {},
): CharacterAdaptation {
  const assumptions: string[] = [];
  const warnings: DamageWarning[] = [];

  const cc = classConstantsFor(ch.cls);
  if (!cc) {
    warnings.push({
      code: "unknown-class",
      message:
        `"${ch.cls}" is not in the class table — only Bow Master is modelled. ` +
        `Falling back to the legacy bow weapon multiplier (${WEAPON_MULTIPLIER.bow}), which is a placeholder ` +
        `for every modern class. Ratios on this page still hold; the absolute number does not.`,
    });
  }

  const weaponMultiplier =
    options.weaponMultiplierOverride ??
    cc?.weaponMultiplier.value ??
    WEAPON_MULTIPLIER.bow;

  const mastery = cc?.mastery.value ?? RANGE_MASTERY_BASE;
  if (!cc) {
    assumptions.push(
      `Mastery defaulted to the ranged base ${fractionToPrintedPercent(RANGE_MASTERY_BASE).toFixed(0)}% because the class is unknown. Affects minimum damage only.`,
    );
  }

  const secondaryStat = options.secondaryStat ?? 0;
  if (options.secondaryStat === undefined) {
    assumptions.push(
      "Secondary stat assumed 0 — the character sheet does not record it. A Bow Master's STR adds at 1x against DEX's 4x, so a realistic value would raise range by roughly 1-2%.",
    );
  }

  const attPct = printedPercentToFraction(options.attPctPrinted ?? 0);
  if (options.attPctPrinted === undefined) {
    assumptions.push(
      "ATT% assumed 0. This is correct, not missing: the GMS stat window's ATT figure is already the post-multiplier total, so adding ATT% again would double-count.",
    );
  }

  const dmgPct = printedPercentToFraction(options.dmgPctPrinted ?? 0);
  if (options.dmgPctPrinted === undefined) {
    assumptions.push(
      "Damage% assumed 0 — the game does not print it and the character sheet does not record it. The real value is positive, so the index is low AND the boss-damage row of the marginal table is optimistic (boss% and damage% share one additive bucket).",
    );
  }

  const classBuffs: ClassBuffMode = options.classBuffs ?? "none";
  let finalDmgPct: number;
  if (options.finalDmgPctPrinted !== undefined) {
    finalDmgPct = printedPercentToFraction(options.finalDmgPctPrinted);
    assumptions.push(
      `Final Damage taken from the caller: +${options.finalDmgPctPrinted.toFixed(2)}%.`,
    );
  } else if (classBuffs === "all-buffs-up" && cc) {
    finalDmgPct = stackFinalDamage(cc.finalDamageSources);
    assumptions.push(
      `Final Damage +${fractionToPrintedPercent(finalDmgPct).toFixed(2)}% assumes every ${cc.cls} buff in the table is active at once (${cc.finalDamageSources.length} sources, stacked multiplicatively). That is a ceiling, not a sustained figure. It is a common factor: it moves the absolute index and changes no comparison.`,
    );
  } else {
    finalDmgPct = 0;
    assumptions.push(
      "Final Damage assumed 0 — it is not printed in game and not recorded on the sheet. A Bow Master's sourced skills multiply to roughly +84% with everything up. Purely a common factor: the index is low, every marginal is unaffected.",
    );
  }

  const inputs: FractionalDamageInputs = {
    mainStat: ch.stats.main,
    secondaryStat,
    att: ch.stats.att,
    attPct,
    dmgPct,
    bossPct: printedPercentToFraction(ch.stats.boss),
    finalDmgPct,
    critRate: printedPercentToFraction(ch.stats.crit),
    critDmg: printedPercentToFraction(ch.stats.critdmg),
    ied: printedPercentToFraction(ch.stats.ied),
    weaponMultiplier,
    mastery,
    charLevel: ch.lvl,
    // Deliberately 0 and deliberately not configurable here: it cancels in every
    // ratio and this module does not model skills.
    skillPct: 0,
  };

  return {
    inputs,
    opts: { pdr: options.pdr ?? DEFAULT_PDR },
    classConstants: cc,
    assumptions,
    warnings,
  };
}

/** One-liner for the common case. Prefer `fractionalInputsFromCharacter` when
 *  the UI should show the assumptions, which is most of the time. */
export function damageIndexForCharacter(
  ch: CharacterLike,
  options: CharacterAdapterOptions = {},
): number {
  const a = fractionalInputsFromCharacter(ch, options);
  return damageIndex(a.inputs, a.opts);
}

/** Breakdown plus adapter assumptions, which is what an explainable UI needs. */
export function characterBreakdown(
  ch: CharacterLike,
  options: CharacterAdapterOptions = {},
): DamageBreakdown & { assumptions: string[]; range: number } {
  const a = fractionalInputsFromCharacter(ch, options);
  const b = damageBreakdown(a.inputs, a.opts);
  return { ...b, warnings: [...a.warnings, ...b.warnings], assumptions: a.assumptions };
}

/** Marginal table straight off a character. */
export function marginalForCharacter(
  ch: CharacterLike,
  options: CharacterAdapterOptions = {},
): Marginal[] {
  const a = fractionalInputsFromCharacter(ch, options);
  return marginal(a.inputs, a.opts);
}

/* ============================================================================
 * LEGACY ADAPTER
 * ==========================================================================*/

/**
 * Printed-percentage shape, i.e. what a stat window and the planner's own form
 * inputs hold: 41.5 rather than 0.415.
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

/**
 * Convert printed percentages to model fractions.
 *
 * KEPT for lib/farming.ts, which calls it with a weapon-key string. New code
 * should use `fractionalInputsFromCharacter`, which resolves the class table
 * and reports its assumptions. This path silently uses the LEGACY
 * WEAPON_MULTIPLIER row — for a Bow Master that is 1.15 where the class table
 * says 1.3.
 *
 * @param weaponMultiplierKey key into WEAPON_MULTIPLIER, e.g. "bow". Unknown
 *        keys resolve to 1 and `damageBreakdown` raises `unknown-weapon`.
 */
export function inputsFromPercentStats(
  s: PercentStats,
  weaponMultiplierKey: string,
  charLevel: number,
): FractionalDamageInputs {
  const wm = WEAPON_MULTIPLIER[weaponMultiplierKey];
  return {
    mainStat: s.main,
    secondaryStat: s.secondary ?? 0,
    att: s.att,
    attPct: printedPercentToFraction(s.attPct ?? 0),
    dmgPct: printedPercentToFraction(s.dmgPct ?? 0),
    bossPct: printedPercentToFraction(s.boss),
    finalDmgPct: printedPercentToFraction(s.finalDmg ?? 0),
    critRate: printedPercentToFraction(s.crit),
    critDmg: printedPercentToFraction(s.critdmg),
    ied: printedPercentToFraction(s.ied),
    // NaN rather than a silent 1 so damageBreakdown's unknown-weapon warning fires.
    weaponMultiplier: typeof wm === "number" ? wm : NaN,
    mastery: printedPercentToFraction(s.mastery ?? 0),
    charLevel,
    skillPct: 0,
  };
}

/* ============================================================================
 * THE REFERENCE CHARACTER
 *
 * The whole point of the model is that it can be checked against a real
 * character. This is that character, as PRINTED on the stat window.
 * ==========================================================================*/

/**
 * Archerroni — GMS Heroic, v.271, Bow Master Lv 244, the live character this
 * planner exists to serve. Every field is as the game PRINTS it.
 *
 * NOTE a discrepancy worth resolving by someone who can open the game:
 * `rules.exampleCharacter()` carries main 19860 / hp 44190 / cp 5260000 while
 * the account holder's own reading is 20689 / 45822 / 5260117. The numbers here
 * are the account holder's. A 4% difference in DEX moves the absolute index by
 * 4% and no ratio at all.
 */
export const REFERENCE_CHARACTER: CharacterLike & { readonly cp: number; readonly hp: number } = {
  cls: "Bow Master",
  lvl: 244,
  cp: 5260117,
  hp: 45822,
  stats: {
    main: 20689,
    att: 1471,
    crit: 98,
    critdmg: 41.5,
    boss: 159,
    ied: 92.9,
  },
};

/**
 * @deprecated Use REFERENCE_CHARACTER (printed units) with
 * `fractionalInputsFromCharacter`. Kept as a ready-made fraction fixture.
 */
export const LIVE_CHARACTER: FractionalDamageInputs =
  fractionalInputsFromCharacter(REFERENCE_CHARACTER).inputs;

export interface ReferenceCheck {
  /** Max damage range — the number the player can read off the stat window. */
  maxRange: number;
  /** Min damage range, i.e. maxRange * mastery. */
  minRange: number;
  /** Max range under the legacy 1.15 bow multiplier, for comparison. */
  maxRangeLegacyMultiplier: number;
  /** The model's index, no class buffs assumed. */
  damageIndex: number;
  /** The model's index with every Bow Master buff in the table up. */
  damageIndexAllBuffsUp: number;
  /** Nexon's printed Combat Power. NOT a target — a different, opaque formula. */
  printedCombatPower: number;
  /** damageIndex / printedCombatPower. A coincidence of scale, not a validation. */
  indexOverCp: number;
  assumptions: string[];
  warnings: DamageWarning[];
  /** What must be true in game for the class constants to be right. */
  falsifier: string;
}

/**
 * Run the model on the reference character.
 *
 * WHAT THE NUMBERS MEAN, precisely, because this is the part it would be easy
 * to lie about:
 *
 * `damageIndex` is a UNITLESS relative index. It is not damage, not DPS, and
 * not Combat Power. Combat Power is Nexon's own undocumented formula and this
 * model makes no claim to reproduce it — if the index happens to land near
 * 5,260,117 that is a coincidence of scale, since both are roughly "stat times
 * attack times multipliers", and it is NOT evidence the model is correct.
 *
 * `maxRange` is different, and it is the real check. Damage Range IS printed on
 * the stat window, and the model computes it from the same published formula
 * the game uses. So:
 *
 *   FALSIFIER — if Archerroni's stat window does not show a max range close to
 *   `maxRange`, the Bow Master constants in this file are wrong. Specifically,
 *   the 1.3 weapon multiplier and the 1.15 legacy row give ranges that differ
 *   by 13%, which is far larger than any rounding, so the stat window decides
 *   between them on sight. `maxRangeLegacyMultiplier` is printed alongside so
 *   the comparison takes one glance.
 *
 * Anything the check CANNOT catch: Damage%, Final Damage% and secondary stat
 * are all defaulted (see `fractionalInputsFromCharacter`), and none of them
 * appear in the range formula, so a correct range does not validate them.
 */
export function referenceCheck(): ReferenceCheck {
  const plain = fractionalInputsFromCharacter(REFERENCE_CHARACTER);
  const buffed = fractionalInputsFromCharacter(REFERENCE_CHARACTER, {
    classBuffs: "all-buffs-up",
  });
  const legacy = fractionalInputsFromCharacter(REFERENCE_CHARACTER, {
    weaponMultiplierOverride: WEAPON_MULTIPLIER.bow,
  });

  const r = damageRange(plain.inputs);
  const b = damageBreakdown(plain.inputs, plain.opts);
  const idx = b.damageIndex;

  return {
    maxRange: r.max,
    minRange: r.min,
    maxRangeLegacyMultiplier: damageRange(legacy.inputs).max,
    damageIndex: idx,
    damageIndexAllBuffsUp: damageIndex(buffed.inputs, buffed.opts),
    printedCombatPower: REFERENCE_CHARACTER.cp,
    indexOverCp: idx / REFERENCE_CHARACTER.cp,
    assumptions: plain.assumptions,
    warnings: [...plain.warnings, ...b.warnings],
    falsifier:
      `Open Archerroni's stat window and read Damage Range. If the maximum is not near ` +
      `${Math.round(r.max).toLocaleString("en-US")}, the Bow Master weapon multiplier of ` +
      `${BOW_MASTER.weaponMultiplier.value} is wrong. The legacy 1.15 reading would show ` +
      `${Math.round(damageRange(legacy.inputs).max).toLocaleString("en-US")} instead. ` +
      `Damage Range is unbuffed-stat-window truth, so this test does not depend on any ` +
      `buff-uptime assumption in this file.`,
  };
}
