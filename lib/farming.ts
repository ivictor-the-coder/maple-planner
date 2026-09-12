/**
 * lib/farming.ts — the farming loadout engine.
 *
 * WHAT THIS IS
 * Every recommendation the planner makes today assumes one objective: damage,
 * against a boss. On a farming loadout that advice is not merely suboptimal, it
 * is inverted — `isDeadLine()` in ./rules has no concept of "Mesos Obtained
 * +20%" being GOOD, and `advise()` will tell a player to reroll away the single
 * most valuable line on the item. This module supplies the farming-side half:
 *
 *   1. an objective-aware line evaluator (drop-in replacement for isDeadLine)
 *   2. a farming score for a loadout — drop %, meso %, resulting income index
 *   3. the CONSTRAINED recommendation: maximise drop + meso subject to keeping
 *      damage above the floor that still clears the target map
 *   4. a cold-start path for a player with no farming gear at all
 *   5. drift detection, in both directions
 *
 * SCOPE OF TRUTH: GMS Heroic (Reboot), patch v.271 (2026-09-09). KMS numbers
 * are not GMS numbers; where a KMS number is the only number that exists it is
 * used for RANKING only and is flagged `placeholder: true`, and every figure
 * derived from it carries `confidence: "ranking-only"` so the UI can suppress
 * absolutes. Reboot has no player trading: a drop/meso line can only be CUBED
 * onto gear the player already owns, never bought. Nothing in here may ever
 * emit "buy this accessory".
 *
 * THE ONE STRUCTURAL FACT THAT DRIVES EVERYTHING
 * In regular potential — and Heroic has no bonus potential at all — Item Drop
 * Rate % and Mesos Obtained % exist in exactly one cell of the whole table:
 * the accessory group at Legendary prime. That is 9 of the 25 slots in SLOTS.
 * No cube in the game can put a drop line on a hat, a belt or a weapon. Every
 * piece of farming advice below is gated on FARM_ELIGIBLE_SLOTS for that
 * reason, and the reroll advice is additionally gated on the item being IN the
 * farm overlay — telling a player to reroll a line on gear shared with their
 * boss preset destroys boss damage to gain nothing.
 *
 * DEPENDENCIES AND WHAT WAS ASSUMED ABOUT THEM
 *   ./rules   Item, Character, Stats, SLOTS, MainStat, Tier — imported, never
 *             redefined. Also pctToFlat / gearStatPct / symbolFlatStat, which
 *             already handle the fact that Arcane Symbol stat is FLAT and is
 *             never multiplied by a %stat line. That dilution is the reason a
 *             12% DEX line on this character is worth ~2%, not ~12%, and it is
 *             what makes the boss->farm swap far cheaper than it looks.
 *   ./damage  damageIndex / inputsFromPercentStats. ASSUMED: `Stats` from
 *             ./rules is structurally assignable to `PercentStats` (it is —
 *             main/att/crit/critdmg/boss/ied, with the rest optional), and
 *             `DamageOptions.pdr` is enemy PDR as a fraction so MOB_PDR = 0.10
 *             can be passed straight in. Mob damage is produced by overriding
 *             `bossPct` with %Normal Enemy Damage, which is exactly the
 *             substitution the game's formula makes.
 *   ./meso    mesoPctFromLines / dropPctFromLines are the single parser for
 *             these two lines; this module does not re-derive them.
 *   ./cubes   the `Sourced<T>` provenance convention and CUBE_COST_MESOS, so
 *             there is one cube price in the repo, not two.
 *
 * NO React, no fetch, no browser APIs. Pure functions, testable alone.
 *
 * @module lib/farming
 */

import {
  SLOTS,
  isDeadLine as bossIsDeadLine,
  pctToFlat,
  statPct,
  statFlat,
  attFlat,
  PLACEHOLDER_SF_MAIN_STAT_PER_STAR_TO_15,
  PLACEHOLDER_SF_ATT_PER_STAR_ABOVE_15,
  type Item,
  type Character,
  type Stats,
  type MainStat,
  type Tier,
  type SlotDef,
} from "./rules";
import { mesoPctFromLines, dropPctFromLines } from "./meso";
import { damageIndex, inputsFromPercentStats, type DamageInputs } from "./damage";
import { CUBE_COST_MESOS, PRIME_LINE as CUBE_PRIME_LINE, type Sourced, type CubeType } from "./cubes";

const GMS_PATCH = "v.271";
const CHECKED = "2026-09-11";

/* ==========================================================================
 * 0. PROVENANCE REGISTRY
 *
 * Every constant below that could not be sourced to a first-party GMS text is
 * `placeholder: true` AND appears here. A number a player might grind hours
 * against must never be a guess buried inside an expression.
 * ========================================================================*/

export interface UnverifiedNote {
  readonly name: string;
  readonly why: string;
}

/**
 * Honor EXP to reroll inner ability, by how many lines are locked.
 *
 * CONFIRMED IN GAME, 2026-09-12, from the Ability Setting panel on Archerroni,
 * which prints "Required Honor EXP" and updates as lines are locked:
 *   0 locked   8,000
 *   1 locked  11,000
 *   2 locked  16,000
 * Legendary rank, Heroic world. Locking is what costs; the rank does not change.
 *
 * This was recorded as "rerollMethod is an empty array - the reroll items, costs
 * and Heroic availability were not sourced, and Interactive-world advice does
 * not transfer". It is now sourced for Heroic, from Heroic.
 */
export const INNER_ABILITY_REROLL_HONOR: Readonly<Record<0 | 1 | 2, number>> = {
  0: 8_000,
  1: 11_000,
  2: 16_000,
};

/**
 * OBSERVED, same session: Archerroni's live Legendary inner ability reads
 * Boss Damage +17% / Item Drop Rate +10% / DEX +19, LUK +10.
 *
 * Worth noting for drift detection rather than as a constant: Item Drop Rate on
 * line 2 is a FARMING line sitting on the bossing preset. Inner ability has
 * three presets (observed), so the honest read is not "reroll it" but "that line
 * belongs on a farm preset" - the same shape as the gear-side drift rule above.
 */
export const OBSERVED_INNER_ABILITY_BOSSING = {
  observedAt: "2026-09-12",
  rank: "legendary",
  lines: ["Boss Damage +17%", "Item Drop Rate +10%", "DEX +19, LUK +10"],
  presetsAvailable: 3,
  note: "Line 2 is a farming line on a bossing preset.",
} as const;

export const UNVERIFIED: ReadonlyArray<UnverifiedNote> = [
  {
    name: "MESO_BAG_BASE_CHANCE",
    why: "0.60 is attested only by community sources (MapleStory Wiki, Francesco149/mapleguide). No Nexon statement found. LOAD-BEARING: the entire 67% drop breakpoint is derived from it.",
  },
  {
    name: "DROP_PCT_GUARANTEED_MESO_BAG",
    why: "Derived from MESO_BAG_BASE_CHANCE, so it inherits that constant's status. 0.60 * 1.67 = 1.002.",
  },
  {
    name: "MESO_GEAR_CAP_PCT / MESO_TOTAL_ADDITIVE_CAP_PCT",
    why: "+100% from equipment potentials and +300% total additive come from maplestorywiki.net/w/Meso quoting the in-game formula, not from a Nexon page that could be opened.",
  },
  {
    name: "DROP_GEAR_CAP_PCT",
    why: "+200% from equipment potentials is transcribed tooltip text on an undated third-party wiki. Unreachable in Reboot anyway (10 lines at 2 per item = 5 dedicated accessories), so treat as non-binding rather than as a target.",
  },
  {
    name: "DROP_TOTAL_CAP_PCT",
    why: "400% is quoted verbatim from GMS v.253 patch notes (2024-09-29, ~2 years old) but a re-verification pass could not open the page, and a second pass found no primary text. Contested; aged; not confirmed for v.271.",
  },
  {
    name: "DROP_LINES_PER_ITEM_MAX",
    why: "\"Item Drop Rate increase can only appear up to 2 times\" is probability-disclosure text transcribed on a Cloudflare-gated wiki (403 to every fetch). Mesos Obtained carries no such limit, which is why triple-meso rings exist.",
  },
  {
    name: "PRIME_LINE_WEIGHT_DROP_MESO / EXTRA_LINE_PRIME_RATE",
    why: "KMS only. Nexon America has never published per-line potential probabilities. Cube identity (GMS Solid ~ KMS Gold/Meister, Glowing ~ Red, Bright ~ Black) is a lineage inference across the GMS v.239 cube revamp, which changed tier-up rates. A documented ~10x GMS/KMS gap exists in the adjacent bonus-potential rates. RANKING ONLY — never quote a cube count from these.",
  },
  {
    name: "PRIME_LINE_POOL_DENOMINATOR_CONTESTED",
    why: "The live KMS table has no DEF% line (denominator 31 in-game / 39 cash). A 2022 snapshot had it (34 / 43, giving 8.8235% / 6.9767%). No GMS patch note dates the removal, so it is unknown which denominator GMS uses.",
  },
  {
    name: "BADGE_CAN_ROLL_DROP_MESO",
    why: "UNKNOWN, but the evidence that raised it is RESOLVED and no longer supports GMS pools differing. The KMS accessory pool is face/eye/earring/ring/pendant only; badges and hearts are not in it. The Black Bean Mark carrying Item Drop Rate +20% was the one data point suggesting GMS might differ - it does not: api.maplestory.net gives its subcategory as \"Eye Decoration\", so it is an EYE ACCESSORY and sits squarely inside the known pool. Badge eligibility is therefore still unestablished either way, with one fewer reason to think it is allowed. Do not model badge odds.",
  },
  {
    name: "SPAWN_TICK_MS / SPAWN_TICKS_PER_HOUR",
    why: "7560 ms comes solely from Francesco149/mapleguide (last content commit 2022-11-16) and the v83 decompiled-server lineage. No first-party corroboration.",
  },
  {
    name: "PARTY_SPAWN_CAPACITY_MULTIPLIER",
    why: "Deliberately 1. The circulated 75%-solo / +5%-per-player / 100%-at-six curve originates from a pre-Big-Bang MapleStory Classic guide that self-labels it unverified and is contradicted by the decompiled capacity interpolation. Raising it would inflate promised income by up to ~33%.",
  },
  {
    name: "ARCANE_MAP_MULT_READING",
    why: "clamp(AP / required, 1, 1.5) is the RATIO reading. A competing DIFFERENCE-based reading exists (KPRobin 2019). Both agree for this character on Esfera/Sellas/Moonbridge because he is above the cap there; they diverge at Labyrinth of Suffering and Limina.",
  },
  {
    name: "LEVEL_DAMAGE_MULT rows -37 / -38 / -39",
    why: "The wiki table reads 0.8 / 0.5 / 0.3 at those gaps, which would be a jump UP from 0.10 at -36 before hitting 0 at -40. Almost certainly 0.08 / 0.05 / 0.03. Encoded as the wiki prints them; irrelevant at the gaps this planner reaches.",
  },
  {
    name: "INNER_ABILITY_DROP_PCT",
    why: "13-15% is a 2022 community figure (mapleguide). The meso side (+20%) is wiki-confirmed; the drop side is not. Encoded at the top of the reported range.",
  },
  {
    name: "FAMILIAR_DROP_LINE_SHARES_GEAR_CAP",
    why: "The wiki states verbatim that familiar Mesos Obtained lines count inside the +100% equipment potential cap. The drop equivalent is inferred by symmetry only and is not stated anywhere.",
  },
  {
    name: "FAMILIAR_BOOST_LINES_STACK",
    why: "Whether three simultaneously-summoned familiars' '...Drop Rate Boost' lines stack with each other is unresolved. The only statement is a Jan-2021 moderator reply saying only the highest applies. Modelled as max() within the category.",
  },
  {
    name: "FAMILIAR_ITEM_DROP_FEEDS_MESO_BAGS",
    why: "mapleguide (2022) states familiar ITEM drop rate does not raise meso-bag frequency and that a 'Meso Drop Rate' line is required instead. Contradicted by nothing, corroborated by the existence of two separate familiar line families. Modelled as separate buckets; the split itself is unverified.",
  },
  {
    name: "MAP_MOB_HP / MAP_MOB_LEVEL",
    why: "Mob HP and levels are from maplestorywiki region pages with no patch stamp relative to v.271. Spawn-point counts are deliberately null: every published figure traces to a 2022 Korean blog chain, and the guide's own author annotates part of that table as counted off YouTube footage.",
  },
  {
    name: "KMS_ECONOMY_OVERHAUL_2026_09_10",
    why: "KMS announced an economy overhaul one day after GMS v.271 shipped, including a meso reduction when the character is 11+ levels above the monster. NOT in GMS v.271. If GMS receives it, MESO_LEVEL_PENALTY and the map ranking both change materially.",
  },
];

/* ==========================================================================
 * 1. SLOT ELIGIBILITY — the hard constraint
 * ========================================================================*/

/**
 * The only slots on which a cube can ever produce Item Drop Rate % or Mesos
 * Obtained % for this player.
 *
 * Source: the regular-potential slot-group tables put drop/meso in exactly one
 * cell of the whole matrix — the {Face, Eye, Ring, Earring, Pendant} group at
 * Legendary (Prime). Independently corroborated by the live KMS probability
 * disclosure, whose accessory pools (nPartsType 15 face / 16 eye / 17 earring /
 * 18 ring / 19 pendant) contain Mesos Obtained and Item Drop Rate while the
 * mechanical-heart pool contains neither.
 *
 * BELT IS THE TRAP: the equip window groups belt with accessories and players
 * call it one, but the potential system groups Cape + Belt + Shoulderpad with
 * armour, and that group has no drop or meso line at any tier. Shoulder is the
 * same. Both are correctly `pot: "stat"` in SLOTS for damage purposes and both
 * are farm-INELIGIBLE.
 */
export const FARM_ELIGIBLE_SLOTS: Sourced<readonly string[]> = {
  value: ["ring1", "ring2", "ring3", "ring4", "pendant1", "pendant2", "earring", "face", "eye"],
  source:
    "Regular-potential slot-group tables (accessory group, Legendary Prime) cross-checked against Nexon KR's live probability disclosure endpoint /Guide/OtherProbability/cube/GetSearchProbList for nPartsType 15-19",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
  note: "Belt and shoulder are NOT eligible despite being worn as accessories. Badge eligibility is UNKNOWN — see UNVERIFIED.BADGE_CAN_ROLL_DROP_MESO.",
};

const ELIGIBLE = new Set(FARM_ELIGIBLE_SLOTS.value);

/** The 16 slots on which farming advice must never appear. Stated positively so
 *  a reader can check the partition rather than trust a negation. */
export const FARM_INELIGIBLE_SLOTS: readonly string[] = SLOTS.map((s) => s.id).filter((id) => !ELIGIBLE.has(id));

export function isFarmEligibleSlot(slotId: string): boolean {
  return ELIGIBLE.has(slotId);
}

/**
 * Heroic/Reboot has no bonus potential at all, which removes the entire second
 * axis most drop/meso guides are written around. Confirmed again in the v.271
 * notes, which mark Karma Bonus Mystical Cube "Available on Interactive worlds
 * only". On Interactive worlds bonus potential rolls drop/meso on almost every
 * armour slot at 2/3/4/5% by item level — the planner must hard-gate that
 * behind world type and never show it to a Heroic character.
 */
export const HEROIC_HAS_BONUS_POTENTIAL: Sourced<boolean> = {
  value: false,
  source: "GMS v.271 patch notes (Karma Bonus Mystical Cube: Interactive worlds only); maplestorywiki.net/w/Potential",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/**
 * Drop and meso are Legendary-PRIME-only lines. Two consequences the engine
 * enforces: a Rare/Epic/Unique accessory can never display one, so the item
 * must reach Legendary first; and on a Legendary item only prime lines can be
 * drop/meso, so line 1 (always prime) is the reliable slot and lines 2-3 are a
 * windfall. This is the one mechanic that is safe to rely on independently of
 * the disputed KMS probabilities.
 */
export const FARM_LINE_REQUIRES_TIER: Tier = "legendary";

/* ==========================================================================
 * 2. LINE VALUES AND CAPS
 * ========================================================================*/

/**
 * Line value is set by ITEM LEVEL, not by tier, and there is no 151+ bump —
 * unlike main-stat %, which goes 12% -> 13% at item level 151.
 *
 * This is the single most important optimisation fact in the module: a Lv 110
 * junk ring carries exactly the same 20% as a Lv 200 endgame ring, while the
 * stat % it displaces is SMALLER on the junk ring. Farming lines belong on the
 * worst accessory you own, never on your best.
 */
export const DROP_MESO_LINE_PCT_BY_ITEM_LEVEL: Sourced<ReadonlyArray<{ min: number; max: number; pct: number }>> = {
  value: [
    { min: 0, max: 30, pct: 10 },
    { min: 31, max: 70, pct: 15 },
    { min: 71, max: Number.POSITIVE_INFINITY, pct: 20 },
  ],
  source: "Regular-potential line-value table, accessory group; corroborated by digitaltq.com/maplestory-item-drop-rate (patch 253 changelog, 2024-08-30)",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/** What one drop or meso line is worth on an item of this level. */
export function dropMesoLinePct(itemLevel: number): number {
  for (const b of DROP_MESO_LINE_PCT_BY_ITEM_LEVEL.value) {
    if (itemLevel >= b.min && itemLevel <= b.max) return b.pct;
  }
  return 0;
}

/** Mesos Obtained from equipment potentials. 5 lines of 20%. Familiar potential
 *  lines are documented to count against this SAME budget. */
export const MESO_GEAR_CAP_PCT: Sourced<number> = {
  value: 100,
  source: "maplestorywiki.net/w/Meso — \"Maximum +100% from equipment Potentials and Bonus Potentials\"; the same page states familiar potential lines share the cap",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED against a Nexon page. Wiki quoting in-game tooltip text.",
};

/** Every additive Mesos Obtained source combined. Gear can supply at most a
 *  third of it, so this is not binding for a Reboot player cubing their own
 *  gear — but it bounds the target. */
export const MESO_TOTAL_ADDITIVE_CAP_PCT: Sourced<number> = {
  value: 300,
  source: "maplestorywiki.net/w/Meso — \"The meso obtained stat can be increased from additive bonuses by up to 300%\"",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED against a Nexon page.",
};

/** Item Drop Rate from equipment potentials. 10 lines of 20%, which at 2 lines
 *  per item needs 5 dedicated accessories — effectively unreachable by cubing
 *  in Reboot. Treated as non-binding and said so plainly, never presented as a
 *  target. */
export const DROP_GEAR_CAP_PCT: Sourced<number> = {
  value: 200,
  source: "Transcribed probability/tooltip text, undated third-party wiki",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED. Non-binding in practice for a Reboot player.",
};

/** Total Item Drop Rate Increase stat, base monster drop rate excluded. */
export const DROP_TOTAL_CAP_PCT: Sourced<number> = {
  value: 400,
  source: "GMS v.253 patch notes (2024-09-29), Character Info: \"Fixed the issue where the Item Drop Rate Stat displayed over the max limit of 400%\"",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "First-party quote exists but a re-verification pass could not open the page and a second pass found no primary text. Aged (~2 years) and contested; not confirmed for v.271.",
};

/** Item Drop Rate is limited to 2 lines on a single item. Mesos Obtained is
 *  NOT — which is why triple-meso rings exist and why the engine must never
 *  advise chasing a third drop line on one item. */
export const DROP_LINES_PER_ITEM_MAX: Sourced<number> = {
  value: 2,
  source: "Potential probability text: \"Item Drop Rate increase can only appear up to 2 times on a single cube\" — same restriction class as Boss Damage and Ignore DEF",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED: the wiki carrying this text is Cloudflare-gated (403). Contradicts DigitalTQ's widely-copied claim of three drop lines per item, which is wrong.",
};

/** Mesos Obtained has no per-item line limit beyond the three potential lines. */
export const MESO_LINES_PER_ITEM_MAX = 3;

/* ---- the breakpoint that matters more than any cap ---- */

/**
 * All monsters have a 60% base chance to drop mesos. Item drop rate multiplies
 * that chance. This is the load-bearing community constant in the module.
 */
export const MESO_BAG_BASE_CHANCE: Sourced<number> = {
  value: 0.6,
  source: "maplestorywiki.net/w/Meso and github.com/Francesco149/mapleguide, independently",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED against any Nexon statement. Derivation kept visible because DROP_PCT_GUARANTEED_MESO_BAG depends on it entirely.",
};

/**
 * DERIVED, not a game constant: the drop % at which a meso bag is guaranteed.
 * 0.60 * 1.67 = 1.002. Below this, every point of Mesos Obtained is being
 * applied to bags that do not spawn — so drop % and meso % are NOT independent,
 * and the first ~67% of drop rate is partly a meso stat.
 *
 * This is a STEP, not a curve, and it is the first thing a farming loadout
 * should buy. Four 20% drop lines (80%) clears it; three lines (60%) plus a
 * Decent Holy Symbol clears it with room to spare.
 */
export const DROP_PCT_GUARANTEED_MESO_BAG = Math.ceil((1 / MESO_BAG_BASE_CHANCE.value - 1) * 100);

/**
 * Heroic World's meso passive, applied MULTIPLICATIVELY after every additive
 * bonus. The stat window erroneously displays 500%. This 6x is why an additive
 * point of meso % is worth six times more in Reboot than on a regular server.
 */
export const HEROIC_MESO_MULTIPLIER: Sourced<number> = {
  value: 6,
  source: "maplestorywiki.net/w/Reboot_World — \"Increases Mesos obtained by 6x\"; maplestorywiki.net/w/Meso notes the stat window lists 500% in error",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/**
 * Mesos Obtained = floor((100 + sum of additive bonuses) * product of
 * multiplicative bonuses) - 100.
 *
 * Additive first, then multiply, then subtract the base 100. Items stating
 * "1.5x" or "2x" are ADDITIVE +50% / +100% despite the wording; the Wealth
 * Acquisition Potion's 1.2x is the documented genuinely-multiplicative case.
 */
export function mesosObtainedPct(additivePct: number, multipliers: readonly number[] = []): number {
  const add = Math.min(Math.max(additivePct, 0), MESO_TOTAL_ADDITIVE_CAP_PCT.value);
  const prod = multipliers.reduce((a, b) => a * b, 1);
  return Math.floor((100 + add) * prod) - 100;
}

/** Chance a defeated mob drops a meso bag at all, given drop % that actually
 *  feeds meso bags. Capped at 1 — drop rate past the breakpoint does nothing
 *  for meso income and the engine must say so rather than keep scoring it. */
export function mesoBagChance(dropPctForBags: number): number {
  return Math.min(1, MESO_BAG_BASE_CHANCE.value * (1 + Math.max(0, dropPctForBags) / 100));
}

/* ==========================================================================
 * 3. NON-GEAR SOURCES
 *
 * In Reboot a cube is the expensive resource, so anything that supplies drop or
 * meso WITHOUT one must be exhausted first. A Lv 244 character can plausibly
 * clear the 67% drop breakpoint on these alone, at zero cube cost — which means
 * a player who cubes first has paid for something they could have had free.
 * ========================================================================*/

export type NonGearCategory =
  /** Additive with gear, and counted inside the equipment potential cap. */
  | "statLine"
  /** Additive with gear but OUTSIDE the equipment potential cap. */
  | "statOutsideGearCap"
  /** The unstackable "familiar buff" category — only the highest member applies. */
  | "familiarBuff"
  /** Consumables, additive inside their own +100% bucket. */
  | "consumable"
  /** A true multiplicative factor on Mesos Obtained. */
  | "multiplicative";

export interface NonGearSource {
  readonly id: string;
  readonly n: string;
  readonly mesoPct: number;
  /** Drop % that raises ITEM drops. */
  readonly dropPct: number;
  /** Drop % that raises MESO BAG frequency. Often but not always equal to
   *  dropPct — familiar item-drop lines are documented not to feed meso bags. */
  readonly dropPctForMesoBags: number;
  /** Multiplicative factor on Mesos Obtained, if any. */
  readonly mesoMult?: number;
  readonly category: NonGearCategory;
  /** Zero cubes to obtain. The whole point of the checklist. */
  readonly cubeFree: boolean;
  /** Not permanent — has to be re-applied, re-summoned or re-bought. */
  readonly temporary: boolean;
  readonly sourced: boolean;
  readonly source: string;
  readonly note?: string;
}

/**
 * The cube-free checklist, plus the consumables worth naming. Ordered roughly
 * by how much a Bow Master can get for free.
 *
 * Deliberately ABSENT:
 *   - Greed Pendant. Its text says EQUIPMENT drop rate, not item drop rate, so
 *     it should not be assumed to raise meso-bag frequency — and it consumes a
 *     pendant slot that could carry up to three 20% lines. Almost certainly a
 *     net loss for a farming preset.
 *   - "2x Drop Coupon" and "Lucky Winter". GMS v270 client data contains ten
 *     distinct items named "2x Drop Coupon" split across two INCOMPATIBLE
 *     mechanics (additive-and-capped vs multiplicative-uncapped), and Lucky
 *     Winter's GMS text states no percentage at all. Modelling either as one
 *     entity would be inventing a constant.
 *   - Shadower's Meso Mastery (+20% above the cap). Class-specific, and this is
 *     a Bow Master. If the planner ever supports other classes it must be a
 *     per-class term, never a constant.
 */
export const NON_GEAR_SOURCES: Sourced<readonly NonGearSource[]> = {
  value: [
    {
      id: "decentHolySymbol",
      n: "Decent Holy Symbol (Lv 30)",
      mesoPct: 0,
      dropPct: 24,
      dropPctForMesoBags: 24,
      category: "statOutsideGearCap",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Decent_Holy_Symbol (GMS v264 tab) — Drop Rate = 14 + floor(lvl/3)%; 270s duration vs 180s cooldown",
      note: "100% uptime at max level, so it is effectively permanent. Does not stack with Holy Symbol proper, which is EXP-only.",
    },
    {
      id: "innerAbilityMeso",
      n: "Inner Ability — Mesos Obtained",
      mesoPct: 20,
      dropPct: 0,
      dropPctForMesoBags: 0,
      category: "statOutsideGearCap",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Meso lists Inner Ability up to +20% meso, separately from the potential-line cap",
      note: "Costs Honor EXP, not cubes. Inner ability has its own 3 Ability Presets, so it can flip alongside the equipment preset. Mutually exclusive with the drop line on the same slot.",
    },
    {
      id: "innerAbilityDrop",
      n: "Inner Ability — Item Drop Rate",
      mesoPct: 0,
      dropPct: 15,
      dropPctForMesoBags: 15,
      category: "statOutsideGearCap",
      cubeFree: true,
      temporary: false,
      sourced: false,
      source: "Community figure (Francesco149/mapleguide, 2022): 13-15%",
      note: "UNVERIFIED for current GMS. Encoded at the top of the reported range. Mutually exclusive with innerAbilityMeso on the same line slot.",
    },
    {
      id: "legionArtifactMeso",
      n: "Legion Artifact — Mesos obtained",
      mesoPct: 12,
      dropPct: 0,
      dropPctForMesoBags: 0,
      category: "statOutsideGearCap",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Legion_Artifact — crystal stat, up to +12% at effective level 10",
      note: "Crystals EXPIRE 30 days after being obtained and their bonuses deactivate until reactivated with Artifact Points. A farming loadout can silently lose 12% meso + 12% drop.",
    },
    {
      id: "legionArtifactDrop",
      n: "Legion Artifact — Item drop rate",
      mesoPct: 0,
      dropPct: 12,
      dropPctForMesoBags: 12,
      category: "statOutsideGearCap",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Legion_Artifact — crystal stat, up to +12% at effective level 10",
      note: "Same 30-day expiry. Per-level values are undocumented; only the level-10 maximum is sourced.",
    },
    {
      id: "legionBoardPhantom",
      n: "Legion board — Phantom",
      mesoPct: 5,
      dropPct: 0,
      dropPctForMesoBags: 0,
      category: "statOutsideGearCap",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Legion — Phantom grants Mesos Obtained +1/2/3/4/5% at B/A/S/SS/SSS",
      note: "The ONLY class Legion board effect that grants meso. No class Legion effect grants item drop rate at all — the full effect table was read.",
    },
    {
      id: "wingsOfFateDrop",
      n: "Wings of Fate — Kurama / Izuna / Yorozu",
      mesoPct: 0,
      dropPct: 5,
      dropPctForMesoBags: 5,
      category: "statOutsideGearCap",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Threads_of_Fate/Bonus — Item Drop Rate +1..5% by closeness level",
      note: "MUTUALLY EXCLUSIVE with wingsOfFateMeso — one trio only. Costs the cape slot, which is farm-ineligible anyway, so it is free in slot terms.",
    },
    {
      id: "wingsOfFateMeso",
      n: "Wings of Fate — Nue / Izuna / Tengu",
      mesoPct: 3,
      dropPct: 0,
      dropPctForMesoBags: 0,
      category: "statOutsideGearCap",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Threads_of_Fate/Bonus — Mesos Obtained +1..3% by closeness level",
      note: "MUTUALLY EXCLUSIVE with wingsOfFateDrop.",
    },
    {
      id: "familiarMesoLine",
      n: "Legendary familiar — \"Mesos Obtained: +20%\"",
      mesoPct: 20,
      dropPct: 0,
      dropPctForMesoBags: 0,
      category: "statLine",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Familiars/Stat_Tables (Legendary); maplestorywiki.net/w/Meso states familiar potential lines share the equipment +100% cap",
      note: "This is a STAT line, additive with gear and inside gear's cap — i.e. a literal free substitute for a cubed gear line. Decisive in Reboot, where the alternative costs cubes.",
    },
    {
      id: "familiarDropLine",
      n: "Legendary familiar — \"Item Drop Rate: +20%\"",
      mesoPct: 0,
      dropPct: 20,
      dropPctForMesoBags: 0,
      category: "statLine",
      cubeFree: true,
      temporary: false,
      sourced: false,
      source: "maplestorywiki.net/w/Familiars/Stat_Tables (Legendary)",
      note: "Line value is sourced; two things are not — whether it counts inside the gear drop cap (inferred by symmetry from the meso side), and whether familiar item drop feeds meso bags (mapleguide says it does not, hence dropPctForMesoBags = 0).",
    },
    {
      id: "familiarMesoDropBoost",
      n: "Legendary familiar — \"Meso Drop Rate Boost: +120%\"",
      mesoPct: 0,
      dropPct: 0,
      dropPctForMesoBags: 120,
      category: "familiarBuff",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Familiars/Stat_Tables (Legendary)",
      note: "BUFF line in the unstackable familiar category — only the highest member of that category applies. This is the line that actually clears the 67% meso-bag breakpoint on its own.",
    },
    {
      id: "familiarItemDropBoost",
      n: "Legendary familiar — \"Item Drop Rate Boost: +120%\"",
      mesoPct: 0,
      dropPct: 120,
      dropPctForMesoBags: 0,
      category: "familiarBuff",
      cubeFree: true,
      temporary: false,
      sourced: true,
      source: "maplestorywiki.net/w/Familiars/Stat_Tables (Legendary)",
      note: "Raises item drops (nodes, familiar cards, equips), not meso-bag frequency.",
    },
    {
      id: "wealthPotion",
      n: "Wealth Acquisition Potion",
      mesoPct: 20,
      dropPct: 20,
      dropPctForMesoBags: 20,
      mesoMult: 1.2,
      category: "multiplicative",
      cubeFree: true,
      temporary: true,
      sourced: true,
      source: "GMS v270 client text (item IDs 2003551/2003559/2003575/2004242): \"+20% item and Meso drop rates for 2 hours. ... not limited by item drop rate increases or max Meso acquisition increases\"",
      note: "The only non-gear consumable with both a verified GMS number AND verified exemption from the caps. 2h; the Small variant is 30 min at the same values. Whether Alchemy's two-at-once yields 1.44x is unresolved — the engine applies 1.2x once.",
    },
    {
      id: "legionsLuck",
      n: "Legion's Luck coupon",
      mesoPct: 0,
      dropPct: 50,
      dropPctForMesoBags: 50,
      category: "consumable",
      cubeFree: true,
      temporary: true,
      sourced: true,
      source: "GMS v270 client text (IDs 2023661/2/3): \"Item drop rate +50%, increase in item drop rate from consumables is applied up to a maximum of 100%\"",
      note: "10/20/30 min for 30/50/70 Legion Coins, 20 per week, 10-day expiry. The wiki files it under both item and meso drop boosts, so its drop % does raise meso-bag chance. Whether it shares a bucket with drop coupons is UNVERIFIED — player testing says it is coded separately.",
    },
    {
      id: "legionsWealth",
      n: "Legion's Wealth coupon",
      mesoPct: 50,
      dropPct: 0,
      dropPctForMesoBags: 0,
      category: "consumable",
      cubeFree: true,
      temporary: true,
      sourced: true,
      source: "GMS in-game text: \"Meso's obtained rate increase is applied up to 300%\"; maplestorywiki.net/w/Legion%27s_Wealth",
      note: "ADDITIVE +50%. Same 10/20/30 min tiers and 20/week limit.",
    },
  ],
  source: "See per-entry source fields",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
  note: "Entries with sourced: false carry their own caveat and are reported by farmingUnverified().",
};

/** The consumable item-drop bucket cap, stated verbatim in-game on Legion's Luck. */
export const CONSUMABLE_DROP_BUCKET_CAP_PCT: Sourced<number> = {
  value: 100,
  source: "GMS v270 client text, Legion's Luck Lv.1/2/3 (IDs 2023661/2/3)",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/** Consumables that temporarily raise Mesos Obtained. The wiki gives +100%
 *  while Legion's Wealth's own item text cites the 300% global figure; +100% is
 *  treated as operative and the conflict is flagged. */
export const CONSUMABLE_MESO_BUCKET_CAP_PCT: Sourced<number> = {
  value: 100,
  source: "maplestorywiki.net/w/Meso",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED and internally contested: Legion's Wealth's in-game text cites the 300% global cap instead.",
};

/**
 * An un-activated Rune curses the field, multiplicatively reducing EXP and item
 * drop rate: 0.5x at 5 minutes, 0.35x at 10, 0.2x at 15, 0x at 20. Lifted the
 * moment the Rune is activated. Most players never model it and it can silently
 * halve a farming session.
 *
 * Note Rune of Riches was REMOVED in GMS v.251 (12 June 2024) — there is no
 * meso rune any more.
 */
export const ELITE_BOSS_CURSE_MULTIPLIER: Sourced<ReadonlyArray<{ afterMinutes: number; mult: number }>> = {
  value: [
    { afterMinutes: 5, mult: 0.5 },
    { afterMinutes: 10, mult: 0.35 },
    { afterMinutes: 15, mult: 0.2 },
    { afterMinutes: 20, mult: 0 },
  ],
  source: "maplestorywiki.net/w/Runes",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
  note: "Whether it multiplies the drop-rate BONUS or the total drop multiplier is ambiguous in the source, and whether it scales meso-bag chance through the drop stat is unresolved.",
};

/* ==========================================================================
 * 4. THE MOB DAMAGE MODEL — what the boss model gets wrong about farming
 * ========================================================================*/

/**
 * Normal mobs have 10% PDR/MDR. Verified individually on 11 mobs spanning
 * Lv 240-254 (Aranya, Aranea, Keeper of Light/Darkness, Light/Dark Executor,
 * Temple Guardian, Oceanleli, Hyades, Denebola, Angelus, Lilli Borea, the Soot
 * and Glare families) — every one reads PDR 10% MDR 10%.
 *
 * Consequence: this character's 92.9% IED is worth 0.9929/0.90 = +9.4% mob
 * damage versus having NONE. Dropping IED from 92.9% to 60% costs 3.3% against
 * mobs — and would produce literal 1-damage hits against a 300% PDR boss. IED
 * is a boss stat that is very nearly free to give up while farming, and the
 * boss-objective advice that says "push IED toward 95%" is noise on a farming
 * preset.
 */
export const MOB_PDR: Sourced<number> = {
  value: 0.1,
  source: "maplestorywiki.net per-mob pages (11 mobs Lv 240-254 checked individually); grandislibrary.com/content/stat-terms — \"IED is irrelevant against normal enemies as most only have 10% PDR/MDR\"",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/**
 * Boss Damage % contributes EXACTLY ZERO against normal mobs. It is a different
 * term in the formula, not a discounted one:
 *   Damage Multiplier = 1 + %Damage + %Boss Damage    (bosses)
 *   Damage Multiplier = 1 + %Damage + %Normal Enemy Damage   (mobs)
 *
 * This character's 159% Boss Damage is worth nothing on a farming map. The
 * mirror of it — Normal Damage — is a HYPER STAT with the same value curve as
 * the Boss Damage hyper stat (+55% at level 15), and hyper stats have three
 * presets of their own. That makes the largest farming lever in the game free
 * and not gear at all: move Boss Damage hyper points to Normal Damage in a
 * second hyper preset. The engine surfaces it as a cold-start step because no
 * amount of cubing competes with it.
 */
export const BOSS_DAMAGE_APPLIES_TO_MOBS: Sourced<boolean> = {
  value: false,
  source: "maplestorywiki.net/w/Damage_Formula — the Damage Multiplier substitutes %Normal Enemy Damage for %Boss Damage against mobs",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/** Ignore Elemental Resistance is likewise 1 (inert) against almost all mobs,
 *  versus 0.5 * (1 + %IER) against almost all bosses. A second boss-only stat
 *  the farming objective must stop valuing. Not modelled numerically here
 *  because neither ./damage nor ./rules carries an IER field. */
export const IER_APPLIES_TO_MOBS: Sourced<boolean> = {
  value: false,
  source: "maplestorywiki.net/w/Damage_Formula",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/**
 * Level-difference damage multiplier, keyed by (player level - monster level).
 * A published lookup table, not a formula, so it is a step function and
 * LEVELLING IS A FIRST-CLASS FARMING LEVER: at Lv 244 against a Lv 251 mob the
 * multiplier is 0.83; reaching Lv 251 makes it 1.10, a +32.5% mob damage swing
 * for zero mesos.
 */
export const LEVEL_DAMAGE_MULT: Sourced<ReadonlyArray<readonly [number, number]>> = {
  value: [
    [5, 1.2], [4, 1.18], [3, 1.16], [2, 1.14], [1, 1.12], [0, 1.1],
    [-1, 1.0584], [-2, 1.007], [-3, 0.9672], [-4, 0.918], [-5, 0.88],
    [-6, 0.85], [-7, 0.83], [-8, 0.8], [-9, 0.78], [-10, 0.75],
    [-15, 0.63], [-20, 0.5], [-21, 0.48], [-30, 0.25], [-40, 0],
  ],
  source: "maplestorywiki.net/w/Damage_Formula",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
  note: "Rows between listed gaps are interpolated linearly by levelDamageMult(). At gap -21 and below, runes, chests and elites stop spawning. See UNVERIFIED for the suspected -37/-38/-39 typo in the source table, which is outside the range this planner reaches.",
};

/** Damage multiplier for a player of `charLevel` against a mob of `mobLevel`. */
export function levelDamageMult(charLevel: number, mobLevel: number): number {
  const gap = charLevel - mobLevel;
  const rows = LEVEL_DAMAGE_MULT.value;
  if (gap >= rows[0][0]) return rows[0][1];
  const last = rows[rows.length - 1];
  if (gap <= last[0]) return last[1];
  for (let i = 0; i < rows.length - 1; i++) {
    const [gHi, mHi] = rows[i];
    const [gLo, mLo] = rows[i + 1];
    if (gap === gHi) return mHi;
    if (gap < gHi && gap > gLo) {
      // Linear between the two published anchors. The real table is dense in
      // the -1..-10 band (so this never fires there) and sparse below it.
      const t = (gap - gLo) / (gHi - gLo);
      return mLo + t * (mHi - mLo);
    }
  }
  return last[1];
}

/** Arcane Power map multiplier cap. */
export const ARCANE_MAP_MULT_CAP = 1.5;

/**
 * Map damage multiplier from Arcane Power against the map's requirement.
 *
 * The wiki gives two anchor points only: "Same Arcane Power: 1" and "1.5 times
 * the recommended Arcane Power: 1.5". This implements the RATIO reading,
 * clamp(AP / required, 1, 1.5). A competing DIFFERENCE-based reading exists.
 * For this character at AP 1060 the two agree everywhere he can farm — he is
 * at the 1.5 cap on every Esfera, Sellas and Moonbridge map (cap needs
 * required <= 706) — so the ambiguity is not binding, and the engine says so
 * rather than warning about a constraint that does not bind.
 */
export function arcaneMapMultiplier(arcanePower: number, required: number): number {
  if (!(required > 0)) return 1;
  return Math.min(ARCANE_MAP_MULT_CAP, Math.max(1, arcanePower / required));
}

/**
 * Level-difference penalty on MESOS obtained, keyed by (player level - monster
 * level). Zero inside +-10, which covers every Arcane River map this planner
 * considers for a Lv 244 character — so the penalty does not discriminate here
 * and the map-selection rule collapses to "pick the highest-level map you can
 * still clear". Encoded anyway because it bites hard in Grandis.
 */
export const MESO_LEVEL_PENALTY: Sourced<ReadonlyArray<readonly [number, number]>> = {
  value: [
    [10, 0], [-10, 0],
    [-11, 0.03], [-12, 0.06], [-15, 0.15], [-20, 0.3], [-25, 0.55], [-30, 1],
    [11, 0.02], [15, 0.1], [20, 0.2], [30, 1],
  ],
  source: "maplestorywiki.net/w/Meso — Level Difference Penalty table",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
  note: "GMS has NO daily map meso acquisition limit — the daily cap table is explicitly labelled non-GlobalMS. Do not copy Korean guides that assume one.",
};

/** Fraction of mesos LOST to the level-difference penalty. 0 means no penalty. */
export function mesoLevelPenalty(charLevel: number, mobLevel: number): number {
  const gap = charLevel - mobLevel;
  if (gap >= -10 && gap <= 10) return 0;
  const rows = MESO_LEVEL_PENALTY.value.filter(([g]) => (gap < 0 ? g < 0 : g > 0));
  let worst = 0;
  for (const [g, pen] of rows) {
    if (gap < 0 ? gap <= g : gap >= g) worst = Math.max(worst, pen);
  }
  return Math.min(1, worst);
}

/* ---- spawn ceiling ---- */

/** Global respawn tick. Sole source is Francesco149/mapleguide (last content
 *  commit 2022-11-16) and the v83 decompiled-server lineage. */
export const SPAWN_TICK_MS: Sourced<number> = {
  value: 7560,
  source: "github.com/Francesco149/mapleguide README.org",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED for GMS v.271 — no Nexon source states it. Applies to GMS Heroic because GMS removed every spawn enhancer (Kishin, wild/fury totem) in the 2022 Ignition patch, so a Heroic player really is on the base cycle.",
};

/** Upper bound on spawns per hour per effective spawn slot. Inherits
 *  SPAWN_TICK_MS's unverified status. */
export const SPAWN_TICKS_PER_HOUR = 3600 / (SPAWN_TICK_MS.value / 1000);

/**
 * DELIBERATELY 1. A 75%-solo / +5%-per-player / 100%-at-six curve circulates
 * widely, but it originates from a pre-Big-Bang MapleStory Classic guide that
 * self-labels it unverified, it contradicts the decompiled min/max capacity
 * interpolation, and its variable is controllers-present rather than party
 * size. Applying it would inflate promised income by up to ~33%.
 *
 * Also: in Heroic worlds, Sacred Power hunting maps are instanced at up to 2
 * players with monsters not shared (GMS v248), so the planner should assume a
 * solo instance and surface no partying advice at all.
 */
export const PARTY_SPAWN_CAPACITY_MULTIPLIER = 1;

/**
 * DELIBERATELY NOT A CONSTANT: the income cost of two-shotting.
 *
 * The only figures available (96-99% of the theoretical ceiling while
 * deliberately two-shotting) are KMS six-minute Burning Agent samples
 * extrapolated x10, recorded in 2022 on pre-6th-job class kits; two of the four
 * source videos are now 403, and one surviving comparable sample measures
 * 100.2% of the ceiling — i.e. the method's upward bias exceeds the effect
 * being claimed. The constraint is real and is a per-cycle TIME budget, not a
 * shot count, and its cost term is per-player.
 *
 * So this engine never claims a percentage. It reports the damage RATIO of a
 * farming loadout against the loadout the player already clears with, which is
 * a computed fact, and leaves the shot-count consequence to be measured.
 */
export const TWO_SHOT_INCOME_COST_PCT: null = null;

/* ==========================================================================
 * 5. FARMING MAPS
 * ========================================================================*/

export interface FarmMap {
  readonly id: string;
  readonly n: string;
  readonly region: string;
  /** Representative (highest) monster level on the map. */
  readonly mobLevel: number;
  /** Representative monster max HP. null where no per-mob figure was found. */
  readonly mobHp: number | null;
  /** Arcane Force / Arcane Power requirement. */
  readonly arcaneForceReq: number;
  /** Base spawn points. DELIBERATELY null — see the note on the table. */
  readonly spawnPoints: number | null;
  readonly measured: boolean;
}

/**
 * Candidate farming maps for a Lv 240-259 Arcane River character.
 *
 * Mob levels and HP are from maplestorywiki region and monster pages. Spawn
 * points are DELIBERATELY null on every row: every published count traces to a
 * single 2022 Korean blog chain via a repo whose own author annotates part of
 * the table "website is wrong, checked shadower video". A spawn count counted
 * off YouTube footage is not a measured value and must not be presented as one.
 * `FarmMapSpawn` below is the shape a measured value should be stored in.
 *
 * Ranking rule that follows from the sourced facts: every map here has mobs at
 * Lv 245+, i.e. above this Lv 244 character, so NONE of them takes a meso level
 * penalty and the penalty table does not discriminate. Base meso per mob is
 * monsterLevel * k for 6 <= k <= 9, so a Lv 251 mob pays only ~2.9% more than a
 * Lv 244 mob. The selection rule is therefore simply: the highest-level map you
 * can still clear — which is exactly what the damage floor decides.
 */
export const FARM_MAPS: Sourced<readonly FarmMap[]> = {
  value: [
    { id: "esfera-mirror-touched", n: "Mirror-Touched Sea", region: "Esfera", mobLevel: 245, mobHp: 439_566_000, arcaneForceReq: 600, spawnPoints: null, measured: false },
    { id: "esfera-radiant-temple", n: "Radiant Temple", region: "Esfera", mobLevel: 249, mobHp: 473_680_000, arcaneForceReq: 640, spawnPoints: null, measured: false },
    { id: "sellas-final-edge", n: "The Final Edge of Light", region: "Sellas", mobLevel: 247, mobHp: 456_280_000, arcaneForceReq: 600, spawnPoints: null, measured: false },
    { id: "sellas-plunging-depths", n: "Plunging Depths", region: "Sellas", mobLevel: 248, mobHp: 464_940_000, arcaneForceReq: 640, spawnPoints: null, measured: false },
    { id: "sellas-star-swallowing", n: "Star-Swallowing Sea", region: "Sellas", mobLevel: 251, mobHp: 540_540_000, arcaneForceReq: 670, spawnPoints: null, measured: false },
    { id: "moonbridge-last-horizon", n: "Last Horizon", region: "Moonbridge", mobLevel: 251, mobHp: 540_540_000, arcaneForceReq: 670, spawnPoints: null, measured: false },
    { id: "moonbridge-mysterious-fog", n: "Mysterious Fog", region: "Moonbridge", mobLevel: 253, mobHp: null, arcaneForceReq: 700, spawnPoints: null, measured: false },
    { id: "moonbridge-void-current", n: "Void Current", region: "Moonbridge", mobLevel: 254, mobHp: 570_438_000, arcaneForceReq: 730, spawnPoints: null, measured: false },
    { id: "los-interior", n: "Labyrinth Interior", region: "Labyrinth of Suffering", mobLevel: 256, mobHp: null, arcaneForceReq: 760, spawnPoints: null, measured: false },
    { id: "los-core", n: "Labyrinth Core", region: "Labyrinth of Suffering", mobLevel: 258, mobHp: null, arcaneForceReq: 790, spawnPoints: null, measured: false },
    { id: "los-deep-core", n: "Deep Core", region: "Labyrinth of Suffering", mobLevel: 259, mobHp: null, arcaneForceReq: 820, spawnPoints: null, measured: false },
  ],
  source: "maplestorywiki.net region pages (Esfera, Sellas, Moonbridge, Labyrinth of Suffering) and individual monster pages",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "No patch stamp relative to v.271. Spawn points intentionally null — no GMS-verified source exists. Grandis (Cernium 260+) is deliberately absent: at Lv 244 it is both a damage and a meso-penalty loss.",
};

/** Per-map spawn data, to be populated from observation. There is no reliable
 *  closed-form for modern GMS maps — the v83 area * mobRate formula predates
 *  every map this player farms. */
export interface FarmMapSpawn {
  readonly mapId: string;
  readonly mobCapacity: number;
  readonly spawnPoints: number;
  readonly measured: boolean;
}

/** Theoretical kills/hour ceiling if the player full-clears every cycle.
 *  Spawn-point count and mob capacity are independent limiters and on a full
 *  clear the binding one is usually spawn points, so min() is correct. */
export function killsPerHourCeiling(spawn: FarmMapSpawn): { ceiling: number; confidence: "ranking-only" } {
  const slots = Math.min(spawn.mobCapacity, spawn.spawnPoints) * PARTY_SPAWN_CAPACITY_MULTIPLIER;
  return { ceiling: SPAWN_TICKS_PER_HOUR * slots, confidence: "ranking-only" };
}

export function findMap(id: string): FarmMap | null {
  return FARM_MAPS.value.find((m) => m.id === id) ?? null;
}

export interface MapDifficulty {
  readonly map: FarmMap;
  readonly levelMult: number;
  readonly mapMult: number;
  /** mobHp / (levelMult * mapMult) — damage required per kill, comparable
   *  across maps. null when the map has no sourced HP. */
  readonly index: number | null;
  readonly arcaneCapped: boolean;
  readonly mesoPenalty: number;
  readonly why: string;
}

/**
 * The one-shot difficulty index: how much damage a map demands, relative to
 * other maps. requiredDamage is proportional to mobHp / (levelMult * mapMult).
 * Use `mapDifficultyRatio` to turn two of these into the ratio a loadout must
 * clear.
 */
export function mapDifficulty(map: FarmMap, charLevel: number, arcanePower: number): MapDifficulty {
  const levelMult = levelDamageMult(charLevel, map.mobLevel);
  const mapMult = arcaneMapMultiplier(arcanePower, map.arcaneForceReq);
  const capped = mapMult >= ARCANE_MAP_MULT_CAP - 1e-9;
  const index = map.mobHp === null ? null : map.mobHp / (levelMult * mapMult);
  const pen = mesoLevelPenalty(charLevel, map.mobLevel);
  const why =
    map.mobHp === null
      ? `No sourced mob HP for ${map.n}; difficulty cannot be indexed. Level multiplier ${levelMult.toFixed(3)}, map multiplier ${mapMult.toFixed(2)}.`
      : `${map.n}: ${map.mobLevel} mobs, level multiplier ${levelMult.toFixed(3)}, Arcane map multiplier ${mapMult.toFixed(2)}${capped ? " (at the 1.5 cap — Arcane Power is not your constraint here)" : ` (below the 1.5 cap; ${Math.ceil(map.arcaneForceReq * 1.5)} AP would cap it)`}.`;
  return { map, levelMult, mapMult, index, arcaneCapped: capped, mesoPenalty: pen, why };
}

/** How much more damage per cast map `to` demands than map `from`. */
export function mapDifficultyRatio(from: FarmMap, to: FarmMap, charLevel: number, arcanePower: number): number | null {
  const a = mapDifficulty(from, charLevel, arcanePower);
  const b = mapDifficulty(to, charLevel, arcanePower);
  if (a.index === null || b.index === null || !(a.index > 0)) return null;
  return b.index / a.index;
}

/* ==========================================================================
 * 6. LINE CLASSIFICATION — objective-aware
 * ========================================================================*/

export type FarmObjective = "boss" | "farm";

export type LineKind =
  | "meso"
  | "drop"
  | "mainStatPct"
  | "allStatPct"
  | "mainStatFlat"
  | "attFlat"
  | "attPct"
  | "boss"
  | "ied"
  | "critDmg"
  | "critRate"
  | "dmgPct"
  | "offStat"
  | "junk";

// These mirror the private regexes in ./rules. They are duplicated rather than
// imported because ./rules does not export them and this module may not edit
// that file. __selfTest() asserts byte-for-byte agreement with rules.isDeadLine
// on a corpus, so a divergence is caught rather than shipped.
const JUNK_RE = /\b(max ?mp|mp|speed|jump|avoid|accuracy|knockback)\b/i;
const FLAT_DEF_RE = /\bdef(ense)?\b/i;
const IGNORE_DEF_RE = /\bignore\s*(enemy\s*)?def(ense)?\b|\bied\b/i;
const MESO_RE = /mesos?\s*(obtained|acquired|acquisition)?/i;
const DROP_RE = /item\s*drop\s*rate|drop\s*rate/i;
const BOSS_RE = /\bboss\s*(damage|dmg)?\b/i;
const ATT_PCT_RE = /\b(att|attack power|magic att)\b/i;
const CRIT_DMG_RE = /critical\s*damage/i;
const CRIT_RATE_RE = /critical\s*rate/i;
const DMG_PCT_RE = /(^|[^a-z])damage\s*\+?\d/i;
const OFF_STATS: Record<MainStat, readonly MainStat[]> = {
  dex: ["str", "int", "luk"],
  str: ["dex", "int", "luk"],
  int: ["str", "dex", "luk"],
  luk: ["str", "int", "dex"],
};

function pctOf(txt: string): number {
  const m = txt.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : 0;
}

export interface ClassifiedLine {
  readonly kind: LineKind;
  /** The number on the line: a percentage for %-kinds, flat points otherwise. */
  readonly value: number;
  readonly text: string;
}

/**
 * What kind of line this is, independent of objective. Order matters: Ignore
 * DEF must be tested before flat DEF or it is destroyed by the same word, and
 * drop must be tested before meso because "Meso Drop Rate" contains both.
 */
export function classifyLine(txt: string, main: MainStat): ClassifiedLine {
  const text = txt ?? "";
  if (!text.trim()) return { kind: "junk", value: 0, text };
  const t = text.toLowerCase();

  if (DROP_RE.test(t)) return { kind: "drop", value: pctOf(t), text };
  if (MESO_RE.test(t)) return { kind: "meso", value: pctOf(t), text };
  if (IGNORE_DEF_RE.test(t)) return { kind: "ied", value: pctOf(t), text };
  if (BOSS_RE.test(t)) return { kind: "boss", value: pctOf(t), text };
  if (CRIT_DMG_RE.test(t)) return { kind: "critDmg", value: pctOf(t), text };
  if (CRIT_RATE_RE.test(t)) return { kind: "critRate", value: pctOf(t), text };
  if (/all ?stat/.test(t)) {
    const p = statPct(text, main);
    return p > 0 ? { kind: "allStatPct", value: p, text } : { kind: "mainStatFlat", value: statFlat(text, main), text };
  }
  if (ATT_PCT_RE.test(t)) {
    if (t.includes("%")) return { kind: "attPct", value: pctOf(t), text };
    return { kind: "attFlat", value: attFlat(text), text };
  }
  if (JUNK_RE.test(t) || FLAT_DEF_RE.test(t)) return { kind: "junk", value: 0, text };
  if (OFF_STATS[main].some((o) => new RegExp(`\\b${o}\\b`).test(t))) return { kind: "offStat", value: pctOf(t), text };
  if (DMG_PCT_RE.test(t)) return { kind: "dmgPct", value: pctOf(t), text };
  {
    const p = statPct(text, main);
    if (p > 0) return { kind: "mainStatPct", value: p, text };
    const f = statFlat(text, main);
    if (f > 0) return { kind: "mainStatFlat", value: f, text };
  }
  return { kind: "junk", value: 0, text };
}

/**
 * Ranking weights, per objective. These are a POLICY HEURISTIC for ordering a
 * reroll list, NOT game data — nothing downstream should present them as a
 * measured quantity, and they are exported so they can be tuned in one place.
 * The damage numbers the planner actually shows come from ./damage, not here.
 *
 * The farm column is where the inversion lives: boss damage and IED go to zero
 * (boss damage is a different formula term against mobs; IED is worth ~3% at
 * 10% mob PDR), and meso/drop go to the top.
 */
export const HEURISTIC_WEIGHTS: Record<FarmObjective, Record<LineKind, number>> = {
  boss: {
    meso: 0, drop: 0,
    mainStatPct: 1, allStatPct: 0.8, mainStatFlat: 0.15,
    attFlat: 0.6, attPct: 1.1, boss: 1.2, ied: 1.2,
    critDmg: 1.1, critRate: 0.5, dmgPct: 1.1,
    offStat: 0, junk: 0,
  },
  farm: {
    // 20% meso in Heroic is multiplied by 6; 20% drop below the breakpoint is
    // partly a meso stat too. Nothing on an accessory competes.
    meso: 3, drop: 3,
    mainStatPct: 1, allStatPct: 0.8, mainStatFlat: 0.15,
    attFlat: 0.6, attPct: 1.1,
    boss: 0, ied: 0,
    critDmg: 1.1, critRate: 0.5, dmgPct: 1.1,
    offStat: 0, junk: 0,
  },
};

export interface LineContext {
  readonly objective: FarmObjective;
  readonly main: MainStat;
  /** Slot the line sits in. When supplied under the farm objective it gates
   *  every "dead" verdict: a slot that cannot roll drop or meso has nothing
   *  better to offer, so nothing on it is dead for farming. */
  readonly slot?: string;
  /** True when the item is in the farm overlay, i.e. a dedicated farm carrier
   *  the player does not boss with. Reroll advice is gated on this. */
  readonly dedicated?: boolean;
}

export interface LineVerdict {
  readonly line: ClassifiedLine;
  /** Heuristic ranking weight under this objective. 0 means "contributes
   *  nothing to this objective". */
  readonly score: number;
  /** True only when the line is BOTH worthless for this objective AND there is
   *  a better line this slot could actually roll. */
  readonly dead: boolean;
  /** True when the line is the best thing this slot can carry for the objective. */
  readonly premium: boolean;
  readonly why: string;
}

/**
 * Evaluate one line against one objective.
 *
 * THE SAFETY RULE, enforced here rather than left to the caller: under the farm
 * objective a line is never "dead" unless the slot is farm-eligible AND the
 * item is a dedicated farm carrier. A shared item — the weapon, the emblem, any
 * accessory absent from the farm overlay — is the same physical item the player
 * bosses with. Telling them to reroll its Boss Damage line would destroy boss
 * gear to gain nothing, because an ineligible slot cannot roll drop or meso
 * under any cube in the game.
 */
export function evaluateLine(txt: string, ctx: LineContext): LineVerdict {
  const line = classifyLine(txt, ctx.main);
  const score = HEURISTIC_WEIGHTS[ctx.objective][line.kind];

  if (ctx.objective === "boss") {
    const dead = bossIsDeadLine(txt, ctx.main);
    return {
      line,
      score,
      dead,
      premium: line.kind === "boss" || line.kind === "ied" || line.kind === "attPct",
      why: dead
        ? "Contributes nothing to boss damage."
        : line.kind === "meso" || line.kind === "drop"
          ? "Worth nothing against a boss — but it is the best line in the game on a farming preset. Move this item into the farming loadout rather than rerolling it."
          : "Contributes to boss damage.",
    };
  }

  // --- farm objective ---
  const eligible = ctx.slot ? isFarmEligibleSlot(ctx.slot) : true;
  const premium = line.kind === "meso" || line.kind === "drop";

  if (premium) {
    return { line, score, dead: false, premium: true, why: `+${line.value}% ${line.kind === "meso" ? "Mesos Obtained" : "Item Drop Rate"} — the highest-value line this slot can carry while farming.` };
  }
  if (!eligible) {
    return {
      line,
      score,
      dead: false,
      premium: false,
      why: "This slot can never roll drop or meso in regular potential, so there is nothing better for it to be. Keep it exactly as your boss preset wants it.",
    };
  }
  if (!ctx.dedicated) {
    return {
      line,
      score,
      dead: false,
      premium: false,
      why: "Farm-eligible slot, but this item is shared with your boss preset. Rerolling it costs boss damage. Put a spare accessory in the farming loadout and cube that instead.",
    };
  }
  if (line.kind === "boss" || line.kind === "ied") {
    return { line, score: 0, dead: true, premium: false, why: `${line.kind === "boss" ? "Boss Damage" : "Ignore DEF"} is worth nothing against normal mobs — boss damage is a different term in the mob formula, and IED faces 10% mob PDR. On a dedicated farm carrier this is a wasted line.` };
  }
  if (line.kind === "junk" || line.kind === "offStat") {
    return { line, score: 0, dead: true, premium: false, why: "Dead on every objective." };
  }
  return {
    line,
    score,
    dead: false,
    premium: false,
    why: "Keeps damage on your farm carrier. Worth rerolling toward meso or drop only while you are still below the caps and the damage floor allows it.",
  };
}

/**
 * DROP-IN REPLACEMENT for `isDeadLine` in ./rules.
 *
 * Signature is deliberately `(txt, main, objective = "boss", slot?, dedicated?)`
 * so that every existing call site — including components/Planner.tsx — keeps
 * working untouched and keeps its exact current behaviour. __selfTest() asserts
 * parity with rules.isDeadLine over a corpus, so adopting this is a no-op for
 * the boss path and a correctness fix for the farm path.
 */
export function isDeadLineFor(
  txt: string,
  main: MainStat,
  objective: FarmObjective = "boss",
  slot?: string,
  dedicated?: boolean,
): boolean {
  return evaluateLine(txt, { objective, main, slot, dedicated }).dead;
}

/* ==========================================================================
 * 7. THE LOADOUT DATA MODEL
 *
 * Mirrors the game rather than inventing a parallel concept. GMS has 3
 * Equipment Presets (added v.251 "GO WEST", June 2024). Preset 1 is the BASE
 * and presets 2 and 3 are SPARSE OVERLAYS on it: an item equipped in preset 1
 * is shared into the others until a different item is equipped in that slot.
 *
 * So one physical item is ONE `Item` object living in `Character.items`, and it
 * appears in the farming loadout because it is ABSENT from the overlay.
 *
 * THE ANTI-PATTERN THIS EXISTS TO REFUSE: giving each loadout its own full
 * Record<string, Item>. Twenty of twenty-five slots become byte-identical
 * copies that drift the moment the player stars a ring in one tab, and the
 * planner then believes they own two Guardian Angel Rings. In Reboot, where
 * every accessory is a boss drop or a coin purchase and nothing can be bought
 * from another player, advising someone to acquire a duplicate they already own
 * is hours of wasted grinding. The overlay makes that state unrepresentable.
 * ========================================================================*/

export type LoadoutKind = "boss" | "farm" | "custom";

export interface Loadout {
  /** Stable key, e.g. "farm". */
  readonly id: string;
  readonly n: string;
  readonly kind: LoadoutKind;
  /** In-game preset number, when the player has mirrored it in the client.
   *  Optional because the planner also wants aspirational loadouts that do not
   *  exist in-game yet — the game caps at 3, the planner should not, and
   *  whether it is still 3 at v.271 is unconfirmed (the v.251 note is the last
   *  patch text found touching the count). */
  readonly preset?: 1 | 2 | 3;
  /** SPARSE overlay on Character.items. Slot absent => the base item is shared
   *  into this loadout. null => the slot is deliberately empty here. */
  readonly over: Readonly<Record<string, Item | null>>;
}

/**
 * `Character` plus loadouts. Declared here as an extension rather than edited
 * into ./rules (which this module may not touch). The integrator's job is to
 * move these three optional fields onto `Character`; at that point this
 * interface becomes a no-op alias and nothing else changes.
 */
export interface CharacterWithLoadouts extends Character {
  readonly loadouts?: readonly Loadout[];
  /** Loadout currently being viewed. Absent === the base. */
  readonly active?: string;
  /** Which loadout `stats` was captured under.
   *
   *  LOAD-BEARING: the game's Character Info window reports the ACTIVE preset's
   *  stats, so an import taken while preset 2 is up is a snapshot of FARMING
   *  stats. Feeding that to boss advice mis-states boss damage, IED and main
   *  stat. The farming loadout's damage must be DERIVED from the base snapshot
   *  by applying the overlay's stat delta — which is also what makes the
   *  one-shot floor computable — never re-imported. */
  readonly statsFrom?: string;
}

/** Resolve a loadout to the item map it actually equips. */
export function loadoutItems(ch: CharacterWithLoadouts, id?: string): Record<string, Item> {
  const lo = id ? ch.loadouts?.find((l) => l.id === id) : undefined;
  if (!lo) return { ...ch.items };
  const out: Record<string, Item> = { ...ch.items };
  for (const [slot, it] of Object.entries(lo.over)) {
    if (it === null) delete out[slot];
    else out[slot] = it;
  }
  return out;
}

/** True when this slot's item is the same physical item the boss preset uses.
 *  The UI owes the player a "shared with Bossing" badge on every one of these,
 *  and a warning on edit that the change applies to both presets — because it
 *  is one object. Star force and flame recommendations on a shared item should
 *  be priority-BOOSTED, not deduplicated: the cost is paid once and the benefit
 *  lands in both presets. */
export function isSharedSlot(lo: Loadout | undefined, slotId: string): boolean {
  return !lo || !(slotId in lo.over);
}

export function findLoadout(ch: CharacterWithLoadouts, id: string): Loadout | undefined {
  return ch.loadouts?.find((l) => l.id === id);
}

/** Build a farm overlay from a set of slot->item decisions. */
export function makeFarmLoadout(over: Record<string, Item | null>, id = "farm", n = "Farming"): Loadout {
  return { id, n, kind: "farm", preset: 2, over: { ...over } };
}

/* ==========================================================================
 * 8. SCORING A LOADOUT FOR FARMING
 * ========================================================================*/

export interface GearFarmTotals {
  readonly mesoPct: number;
  readonly dropPct: number;
  /** Per-slot contributions, for the UI to attribute a number to an item. */
  readonly bySlot: ReadonlyArray<{ slot: string; item: string; mesoPct: number; dropPct: number; eligible: boolean }>;
}

/**
 * Sum meso % and drop % over a RESOLVED item map.
 *
 * This deliberately takes an item map rather than a Character. `accountMesoGear`
 * in ./meso sums over `ch.items` — i.e. over the boss preset — which is the one
 * function in the repo that is actively wrong once loadouts exist, because it
 * will report the farming totals of gear the player is not wearing while
 * farming. Line parsing itself is delegated to ./meso so there is exactly one
 * parser for these two line types.
 */
export function gearFarmTotals(items: Readonly<Record<string, Item>>): GearFarmTotals {
  let meso = 0;
  let drop = 0;
  const bySlot: Array<{ slot: string; item: string; mesoPct: number; dropPct: number; eligible: boolean }> = [];
  for (const [slot, it] of Object.entries(items)) {
    if (!it) continue;
    const lines = (it.p || []).filter(Boolean);
    const m = mesoPctFromLines(lines);
    const d = dropPctFromLines(lines);
    if (m || d) {
      bySlot.push({ slot, item: it.name, mesoPct: m, dropPct: d, eligible: isFarmEligibleSlot(slot) });
      meso += m;
      drop += d;
    }
  }
  bySlot.sort((a, b) => b.mesoPct + b.dropPct - (a.mesoPct + a.dropPct));
  return { mesoPct: meso, dropPct: drop, bySlot };
}

export interface FarmScoreOptions {
  /** Ids from NON_GEAR_SOURCES the player actually has active. */
  readonly nonGear?: readonly string[];
  /** Include temporary consumables in the headline figure. Default false:
   *  a buff you are not holding is not income. */
  readonly includeTemporary?: boolean;
}

export interface CapState {
  readonly used: number;
  readonly cap: number;
  readonly headroom: number;
  readonly atCap: boolean;
  readonly capIsUnverified: boolean;
}

export interface FarmScore {
  readonly gearMesoPct: number;
  readonly gearDropPct: number;
  readonly nonGearMesoPct: number;
  readonly nonGearDropPct: number;
  /** Drop % that actually raises meso-bag frequency. Familiar ITEM drop lines
   *  are excluded here — see UNVERIFIED.FAMILIAR_ITEM_DROP_FEEDS_MESO_BAGS. */
  readonly dropPctForMesoBags: number;
  /** Additive Mesos Obtained after the gear sub-cap and the global cap. */
  readonly mesoAdditivePct: number;
  /** Mesos Obtained % as the game's formula computes it, Heroic 6x included. */
  readonly mesosObtainedPct: number;
  /** Multiplier on the mesos inside a bag. */
  readonly mesoFactor: number;
  readonly mesoBagChance: number;
  /** mesoFactor * mesoBagChance. Compare two of these; the absolute value is
   *  an index, not mesos. */
  readonly incomeIndex: number;
  readonly mesoGearCap: CapState;
  readonly dropGearCap: CapState;
  readonly mesoTotalCap: CapState;
  readonly dropTotalCap: CapState;
  /** True while drop % is below the meso-bag breakpoint, i.e. while every point
   *  of meso % is being multiplied by less than 1. */
  readonly belowBagBreakpoint: boolean;
  readonly dropToBreakpoint: number;
  readonly warnings: readonly string[];
  readonly gearBySlot: GearFarmTotals["bySlot"];
}

function capState(used: number, cap: Sourced<number>): CapState {
  return {
    used,
    cap: cap.value,
    headroom: Math.max(0, cap.value - used),
    atCap: used >= cap.value,
    capIsUnverified: cap.placeholder,
  };
}

/** Score a resolved loadout for farming. */
export function scoreFarming(items: Readonly<Record<string, Item>>, opts: FarmScoreOptions = {}): FarmScore {
  const gear = gearFarmTotals(items);
  const chosen = new Set(opts.nonGear ?? []);
  const sources = NON_GEAR_SOURCES.value.filter(
    (s) => chosen.has(s.id) && (opts.includeTemporary ? true : !s.temporary),
  );

  // Additive stat lines split by whether they live inside the equipment cap.
  let insideCapMeso = 0;
  let outsideCapMeso = 0;
  let insideCapDrop = 0;
  let outsideCapDrop = 0;
  let consumableDrop = 0;
  let consumableMeso = 0;
  const mesoMults: number[] = [HEROIC_MESO_MULTIPLIER.value];
  // The familiar-buff category is unstackable: only its highest member applies.
  let familiarBagBoost = 0;
  let familiarItemBoost = 0;

  for (const s of sources) {
    switch (s.category) {
      case "statLine":
        insideCapMeso += s.mesoPct;
        insideCapDrop += s.dropPct;
        break;
      case "statOutsideGearCap":
        outsideCapMeso += s.mesoPct;
        outsideCapDrop += s.dropPct;
        break;
      case "familiarBuff":
        familiarBagBoost = Math.max(familiarBagBoost, s.dropPctForMesoBags);
        familiarItemBoost = Math.max(familiarItemBoost, s.dropPct);
        break;
      case "consumable":
        consumableMeso += s.mesoPct;
        consumableDrop += s.dropPct;
        break;
      case "multiplicative":
        // Wealth Acquisition Potion is exempt from the caps by its own text, so
        // its additive halves go straight into the outside-cap buckets.
        outsideCapMeso += s.mesoPct;
        outsideCapDrop += s.dropPct;
        if (s.mesoMult) mesoMults.push(s.mesoMult);
        break;
    }
  }

  const warnings: string[] = [];

  // Gear + familiar stat lines share the equipment potential cap.
  const mesoInsideCapRaw = gear.mesoPct + insideCapMeso;
  const mesoInsideCap = Math.min(mesoInsideCapRaw, MESO_GEAR_CAP_PCT.value);
  if (mesoInsideCapRaw > MESO_GEAR_CAP_PCT.value) {
    warnings.push(
      `Mesos Obtained from potentials is ${mesoInsideCapRaw}% against a ${MESO_GEAR_CAP_PCT.value}% cap — ${mesoInsideCapRaw - MESO_GEAR_CAP_PCT.value}% of it is doing nothing. Stop cubing meso and put the next line into drop.`,
    );
  }
  const dropInsideCapRaw = gear.dropPct + insideCapDrop;
  const dropInsideCap = Math.min(dropInsideCapRaw, DROP_GEAR_CAP_PCT.value);

  const consumableDropCapped = Math.min(consumableDrop, CONSUMABLE_DROP_BUCKET_CAP_PCT.value);
  if (consumableDrop > CONSUMABLE_DROP_BUCKET_CAP_PCT.value) {
    warnings.push(`Consumable drop rate is capped at ${CONSUMABLE_DROP_BUCKET_CAP_PCT.value}% by its own in-game text; ${consumableDrop - CONSUMABLE_DROP_BUCKET_CAP_PCT.value}% is wasted.`);
  }
  const consumableMesoCapped = Math.min(consumableMeso, CONSUMABLE_MESO_BUCKET_CAP_PCT.value);

  const mesoAdditiveRaw = mesoInsideCap + outsideCapMeso + consumableMesoCapped;
  const mesoAdditive = Math.min(mesoAdditiveRaw, MESO_TOTAL_ADDITIVE_CAP_PCT.value);
  if (mesoAdditiveRaw > MESO_TOTAL_ADDITIVE_CAP_PCT.value) {
    warnings.push(`Total additive Mesos Obtained is capped at ${MESO_TOTAL_ADDITIVE_CAP_PCT.value}%.`);
  }

  // Two separate drop totals, because they do two different jobs.
  const dropForItemsRaw = dropInsideCap + outsideCapDrop + consumableDropCapped + familiarItemBoost;
  const dropForBags = dropInsideCap + outsideCapDrop + consumableDropCapped + familiarBagBoost;
  const dropForItems = Math.min(dropForItemsRaw, DROP_TOTAL_CAP_PCT.value);
  if (dropForItemsRaw > DROP_TOTAL_CAP_PCT.value) {
    warnings.push(`Item Drop Rate is reported capped at ${DROP_TOTAL_CAP_PCT.value}% — but that figure is aged and contested, so treat the overflow as unconfirmed rather than certainly wasted.`);
  }

  const obtained = mesosObtainedPct(mesoAdditive, mesoMults);
  const mesoFactor = (100 + obtained) / 100;
  const bag = mesoBagChance(dropForBags);
  const toBreakpoint = Math.max(0, DROP_PCT_GUARANTEED_MESO_BAG - dropForBags);

  if (toBreakpoint > 0 && mesoAdditive > 0) {
    warnings.push(
      `Drop rate is ${dropForBags}% against the ${DROP_PCT_GUARANTEED_MESO_BAG}% meso-bag breakpoint — ${((1 - bag) * 100).toFixed(0)}% of mobs are dropping no bag at all, so every point of Mesos Obtained is currently being multiplied by ${bag.toFixed(2)}. Close the ${toBreakpoint}% gap before adding more meso.`,
    );
  }

  return {
    gearMesoPct: gear.mesoPct,
    gearDropPct: gear.dropPct,
    nonGearMesoPct: insideCapMeso + outsideCapMeso + consumableMesoCapped,
    nonGearDropPct: insideCapDrop + outsideCapDrop + consumableDropCapped + familiarItemBoost,
    dropPctForMesoBags: dropForBags,
    mesoAdditivePct: mesoAdditive,
    mesosObtainedPct: obtained,
    mesoFactor,
    mesoBagChance: bag,
    incomeIndex: mesoFactor * bag,
    mesoGearCap: capState(mesoInsideCapRaw, MESO_GEAR_CAP_PCT),
    dropGearCap: capState(dropInsideCapRaw, DROP_GEAR_CAP_PCT),
    mesoTotalCap: capState(mesoAdditiveRaw, MESO_TOTAL_ADDITIVE_CAP_PCT),
    dropTotalCap: capState(dropForItemsRaw, DROP_TOTAL_CAP_PCT),
    belowBagBreakpoint: toBreakpoint > 0,
    dropToBreakpoint: toBreakpoint,
    warnings,
    gearBySlot: gear.bySlot,
  };
}

/** Income of `after` relative to `before`. 1.42 means +42% mesos per hour at
 *  the same kill rate — it says nothing about kill rate, which is the damage
 *  floor's job. */
export function incomeRatio(before: FarmScore, after: FarmScore): number | null {
  if (!(before.incomeIndex > 0)) return null;
  return after.incomeIndex / before.incomeIndex;
}

/* ==========================================================================
 * 9. THE DAMAGE FLOOR
 * ========================================================================*/

export interface MobDamageOptions {
  /** %Normal Enemy Damage, as a percentage. This is the term that REPLACES
   *  Boss Damage against mobs; it is a hyper stat with the same value curve as
   *  the Boss Damage hyper stat (+55% at level 15) and hyper stats have three
   *  presets, so this is the cheapest farming lever there is. Default 0. */
  readonly normalEnemyDmgPct?: number;
  /** Key into ./damage WEAPON_MULTIPLIER. Cancels in every ratio. */
  readonly weapon?: string;
  /** Map the damage is being computed against, for the level and map terms. */
  readonly map?: FarmMap;
  readonly arcanePower?: number;
}

/**
 * Build ./damage inputs for a MOB rather than a boss.
 *
 * Two substitutions, both straight out of the game's formula:
 *   - bossPct is replaced by %Normal Enemy Damage
 *   - the caller passes MOB_PDR (0.10) instead of a boss's 3.0
 * Level and map multipliers are applied by `mobDamageIndex` on top, because
 * ./damage deliberately does not model them (it carries charLevel unused and
 * says so).
 */
export function mobDamageInputs(stats: Stats, charLevel: number, opts: MobDamageOptions = {}): DamageInputs {
  const base = inputsFromPercentStats(
    {
      main: stats.main,
      att: stats.att,
      crit: stats.crit,
      critdmg: stats.critdmg,
      boss: opts.normalEnemyDmgPct ?? 0,
      ied: stats.ied,
    },
    opts.weapon ?? "bow",
    charLevel,
  );
  return base;
}

/** A mob-damage index, comparable only against another produced the same way. */
export function mobDamageIndex(stats: Stats, charLevel: number, opts: MobDamageOptions = {}): number {
  const idx = damageIndex(mobDamageInputs(stats, charLevel, opts), { pdr: MOB_PDR.value });
  if (!opts.map) return idx;
  const lvl = levelDamageMult(charLevel, opts.map.mobLevel);
  const mapMult = arcaneMapMultiplier(opts.arcanePower ?? 0, opts.map.arcaneForceReq);
  return idx * lvl * mapMult;
}

/**
 * The floor, expressed the only honest way available.
 *
 * NO ABSOLUTE ONE-SHOT THRESHOLD IS DERIVABLE. No source gives per-class
 * mobbing-skill hit counts and damage %, and ./damage explicitly excludes them
 * from scope. So the floor is a RATIO against the loadout the player already
 * clears with — and in that ratio every unmodelled term (skill %, hit count,
 * mastery, weapon constant, buff uptime) cancels EXACTLY. That is not a
 * convenience; it is what makes the number trustworthy.
 */
export interface DamageFloor {
  readonly kind: "ratio";
  /** Fraction of the player's CURRENT mob damage the farming loadout must keep.
   *  1.0 = "must not lose any damage". */
  readonly minRatio: number;
  readonly basis: string;
  readonly confidence: "sourced" | "ranking-only" | "needs-measurement";
}

/** The player keeps farming the map they already clear. Nothing may be lost. */
export function floorHoldingMap(map?: FarmMap): DamageFloor {
  return {
    kind: "ratio",
    minRatio: 1,
    basis: map
      ? `Hold your clear on ${map.n}. Any damage lost risks dropping below whatever margin you currently have, and that margin is not something this planner can see — only you can, by watching whether mobs still die in the same number of casts.`
      : "Hold your current clear. Any damage lost is unvalidated until you check your kill rate in game.",
    confidence: "needs-measurement",
  };
}

/** The player has told us how much spare damage they have — e.g. "I one-shot
 *  with 30% to spare". That is a measured input and is the only way to get a
 *  real allowance. */
export function floorWithHeadroom(headroomPct: number, map?: FarmMap): DamageFloor {
  const r = 1 / (1 + Math.max(0, headroomPct) / 100);
  return {
    kind: "ratio",
    minRatio: r,
    basis: `You reported ${headroomPct}% spare damage on ${map ? map.n : "your farming map"}, so a farming loadout may keep as little as ${(r * 100).toFixed(0)}% of your current mob damage. This came from your measurement, not from a constant.`,
    confidence: "sourced",
  };
}

/** The player wants to move up a map tier. That ratio IS computable, because it
 *  is mob HP over the level and map multipliers — no class term involved. */
export function floorForMapChange(from: FarmMap, to: FarmMap, charLevel: number, arcanePower: number): DamageFloor | null {
  const r = mapDifficultyRatio(from, to, charLevel, arcanePower);
  if (r === null) return null;
  return {
    kind: "ratio",
    minRatio: r,
    basis: `${to.n} demands ${(r * 100 - 100).toFixed(0)}% more damage per cast than ${from.n} (mob HP ${to.mobHp?.toLocaleString()} vs ${from.mobHp?.toLocaleString()}, after the level and Arcane Power multipliers). A farming loadout that loses damage cannot also move up a tier.`,
    confidence: "ranking-only",
  };
}

/* ==========================================================================
 * 10. THE CONSTRAINED RECOMMENDATION
 * ========================================================================*/

/** A spare accessory the player owns but is not wearing. In Reboot this is the
 *  entire supply — there is no auction house — so the planner must work from
 *  what is in the inventory, not from a shopping list. */
export interface SpareItem {
  readonly item: Item;
  /** Slot ids it can occupy. A ring can go in any of ring1..ring4. */
  readonly slots: readonly string[];
}

export interface FarmCandidate {
  readonly slot: string;
  /** The item this candidate puts in the slot. */
  readonly item: Item;
  readonly origin: "keep" | "spare" | "cube-in-place";
  /** Meso % this candidate contributes once its plan is realised. */
  readonly mesoPct: number;
  readonly dropPct: number;
  /** Lines to cube onto it, over and above what it already has. */
  readonly cubeMesoLines: number;
  readonly cubeDropLines: number;
  /** True when the item must first be taken to Legendary. That is usually the
   *  real expense, and it can dwarf the line hunt. */
  readonly needsLegendary: boolean;
  /** Main-stat % this slot gives up versus the boss item currently in it. */
  readonly statPctLost: number;
  readonly flatMainLost: number;
  readonly attLost: number;
  readonly bossPctLost: number;
  readonly iedPctLost: number;
  readonly why: string;
}

export interface RecommendOptions extends FarmScoreOptions {
  readonly loadoutId?: string;
  readonly spares?: readonly SpareItem[];
  readonly targetMap?: string;
  readonly floor?: DamageFloor;
  readonly weapon?: string;
  readonly normalEnemyDmgPct?: number;
  /** Cap on exhaustive search. Above it the engine falls back to greedy and
   *  says so. 9 eligible slots with a handful of candidates each is well inside
   *  the default. */
  readonly searchBudget?: number;
  /** Hard ceiling on how many drop/meso lines the player is willing to chase. */
  readonly maxNewLines?: number;
}

export interface SwapReport {
  readonly slot: string;
  readonly from: string;
  readonly to: string;
  /** "spare" swaps a different physical item in and costs no boss damage.
   *  "cube-in-place" rerolls the item the player also bosses with — the UI must
   *  not render it as a swap, because `from` and `to` are the same object. */
  readonly origin: FarmCandidate["origin"];
  readonly mesoGain: number;
  readonly dropGain: number;
  readonly damageCostPct: number | null;
  readonly cubeLines: number;
  readonly needsLegendary: boolean;
  readonly why: string;
}

export interface FarmRecommendation {
  readonly picks: readonly FarmCandidate[];
  readonly overlay: Record<string, Item>;
  readonly before: FarmScore;
  readonly after: FarmScore;
  readonly incomeRatio: number | null;
  readonly damageRatio: number | null;
  readonly floor: DamageFloor;
  readonly feasible: boolean;
  readonly swaps: readonly SwapReport[];
  readonly searchMode: "exhaustive" | "greedy";
  readonly notes: readonly string[];
  readonly confidence: "sourced" | "ranking-only";
}

/** Flat main stat and ATT a star-forced item is carrying, so a swap to a
 *  low-star spare prices the loss. Both constants are ./rules PLACEHOLDERs and
 *  are reused rather than re-invented, so a correction there fixes this too. */
function starStat(it: Item): { main: number; att: number } {
  const s = Math.max(0, it.star || 0);
  return {
    main: Math.min(s, 15) * PLACEHOLDER_SF_MAIN_STAT_PER_STAR_TO_15,
    att: Math.max(0, s - 15) * PLACEHOLDER_SF_ATT_PER_STAR_ABOVE_15,
  };
}

interface ItemContribution {
  statPct: number;
  flatMain: number;
  att: number;
  bossPct: number;
  iedPct: number;
}

/** What one item contributes to damage, from its own lines plus star force. */
function itemContribution(it: Item | undefined, main: MainStat): ItemContribution {
  const out: ItemContribution = { statPct: 0, flatMain: 0, att: 0, bossPct: 0, iedPct: 0 };
  if (!it) return out;
  for (const l of [...(it.p || []), ...(it.f || [])]) {
    if (!l) continue;
    const c = classifyLine(l, main);
    switch (c.kind) {
      case "mainStatPct":
      case "allStatPct":
        out.statPct += c.value;
        break;
      case "mainStatFlat":
        out.flatMain += c.value;
        break;
      case "attFlat":
        out.att += c.value;
        break;
      case "boss":
        out.bossPct += c.value;
        break;
      case "ied":
        out.iedPct += c.value;
        break;
      default:
        break;
    }
  }
  const sf = starStat(it);
  out.flatMain += sf.main;
  out.att += sf.att;
  return out;
}

/**
 * How many drop/meso lines an item could carry once it is Legendary.
 *
 * Line 1 is prime by construction and is the reliable slot. Lines 2 and 3 are
 * drop/meso only when they independently roll prime, and on a Legendary item a
 * non-prime line draws from the Unique pool, which contains neither — so
 * "plan for line 1, treat a second as a windfall" is correct advice
 * independently of the disputed probabilities. The engine therefore PLANS one
 * line per item and only counts a second when the item already has it.
 */
export const PLAN_LINES_PER_ITEM = 1;

function farmLinesAlreadyOn(it: Item): { meso: number; drop: number } {
  const lines = (it.p || []).filter(Boolean);
  return { meso: mesoPctFromLines(lines), drop: dropPctFromLines(lines) };
}

/** Candidate loadout entries for one eligible slot. */
function candidatesForSlot(
  slot: string,
  current: Item | undefined,
  spares: readonly SpareItem[],
  main: MainStat,
  want: "drop" | "meso",
): FarmCandidate[] {
  const out: FarmCandidate[] = [];
  const cur = itemContribution(current, main);

  const mk = (item: Item, origin: FarmCandidate["origin"]): FarmCandidate => {
    const have = farmLinesAlreadyOn(item);
    const linePct = dropMesoLinePct(item.lvl || 0);
    const needsLegendary = item.pot !== FARM_LINE_REQUIRES_TIER;
    const addMeso = want === "meso" ? linePct : 0;
    const addDrop = want === "drop" ? linePct : 0;
    const cand = itemContribution(item, main);
    // A cubed farm line replaces the potential lines the item is carrying, so
    // the stat those lines gave is lost on top of any swap-in loss.
    const potStatPct = (item.p || []).reduce((a, l) => {
      const c = classifyLine(l || "", main);
      return c.kind === "mainStatPct" || c.kind === "allStatPct" ? a + c.value : a;
    }, 0);
    const lostFromCubing = origin === "keep" ? 0 : potStatPct;
    return {
      slot,
      item,
      origin,
      mesoPct: have.meso + addMeso,
      dropPct: have.drop + addDrop,
      cubeMesoLines: addMeso > 0 ? PLAN_LINES_PER_ITEM : 0,
      cubeDropLines: addDrop > 0 ? PLAN_LINES_PER_ITEM : 0,
      needsLegendary,
      statPctLost: Math.max(0, cur.statPct - cand.statPct + lostFromCubing),
      flatMainLost: Math.max(0, cur.flatMain - cand.flatMain),
      attLost: Math.max(0, cur.att - cand.att),
      bossPctLost: Math.max(0, cur.bossPct - cand.bossPct),
      iedPctLost: Math.max(0, cur.iedPct - cand.iedPct),
      why:
        origin === "spare"
          ? `${item.name} (Lv ${item.lvl}${item.star ? `, ${item.star}*` : ""}) carries the full ${linePct}% line at item level ${item.lvl} while giving up less stat than your equipped ${current?.name ?? "slot"} — the line value is flat past item level 71, so the cheap accessory is the right carrier.`
          : origin === "cube-in-place"
            ? `Cube ${item.name} in place. It stays in your boss preset too, so the stat lines you reroll away are paid for twice.`
            : `${item.name} already carries ${have.meso ? `${have.meso}% meso` : ""}${have.meso && have.drop ? " and " : ""}${have.drop ? `${have.drop}% drop` : ""} — banked, no cube needed.`,
    };
  };

  // 0. Keep whatever is there, unchanged. Always a legal option.
  if (current) out.push({ ...mk(current, "keep"), mesoPct: farmLinesAlreadyOn(current).meso, dropPct: farmLinesAlreadyOn(current).drop, cubeMesoLines: 0, cubeDropLines: 0, statPctLost: 0, flatMainLost: 0, attLost: 0, bossPctLost: 0, iedPctLost: 0, needsLegendary: false });

  // 1. Swap in a spare that can occupy this slot, and cube it.
  for (const sp of spares) {
    if (!sp.slots.includes(slot)) continue;
    out.push(mk(sp.item, "spare"));
  }

  // 2. Cube the equipped item in place. Listed LAST and flagged, because the
  //    item is shared with the boss preset and the cost is real boss damage.
  if (current) out.push(mk(current, "cube-in-place"));

  return out;
}

/** Damage ratio of a set of picks against the unchanged loadout. */
function damageRatioFor(
  ch: Character,
  picks: readonly FarmCandidate[],
  opts: RecommendOptions,
  map: FarmMap | undefined,
): number | null {
  let statPct = 0;
  let flat = 0;
  let att = 0;
  let boss = 0;
  let ied = 0;
  for (const p of picks) {
    statPct += p.statPctLost;
    flat += p.flatMainLost;
    att += p.attLost;
    boss += p.bossPctLost;
    ied += p.iedPctLost;
  }
  // %stat converts to flat through the character's own base, which already
  // excludes undilutable Arcane Symbol stat — that dilution is exactly why
  // giving up six accessory stat lines costs far less than 6 x 12%.
  const fromPct = statPct > 0 ? pctToFlat(ch, statPct) : 0;
  if (fromPct === null) return null;
  const after: Stats = {
    ...ch.stats,
    main: ch.stats.main - fromPct - flat,
    att: ch.stats.att - att,
    boss: ch.stats.boss - boss,
    ied: ch.stats.ied - ied,
  };
  const mo: MobDamageOptions = {
    normalEnemyDmgPct: opts.normalEnemyDmgPct ?? 0,
    weapon: opts.weapon,
    map,
    arcanePower: ch.stats.arcane,
  };
  const before = mobDamageIndex(ch.stats, ch.lvl, mo);
  const a = mobDamageIndex(after, ch.lvl, mo);
  if (!(before > 0) || !Number.isFinite(a)) return null;
  return a / before;
}

/**
 * THE CONSTRAINED RECOMMENDATION.
 *
 * Maximise drop % + meso % subject to keeping mob damage at or above the floor.
 * The objective is NOT linear — the meso-bag breakpoint is a step and the caps
 * are hard clamps — so a greedy pass is genuinely suboptimal and the search is
 * exhaustive whenever the candidate space allows (9 slots is tiny). Above the
 * budget it falls back to greedy by income-per-damage-cost and says which mode
 * it used.
 *
 * Drop is prioritised until the meso-bag breakpoint because below it every
 * point of meso % is multiplied by less than one; after it, meso to the gear
 * cap; only then more drop, and the engine states plainly that the +200% gear
 * drop cap is unreachable rather than presenting it as a target.
 */
export function recommendFarmLoadout(ch: CharacterWithLoadouts, opts: RecommendOptions = {}): FarmRecommendation {
  const notes: string[] = [];
  const baseItems = loadoutItems(ch, opts.loadoutId);
  const before = scoreFarming(baseItems, opts);
  const map = opts.targetMap ? findMap(opts.targetMap) ?? undefined : undefined;
  const floor = opts.floor ?? floorHoldingMap(map);
  const spares = opts.spares ?? [];

  if (!HEROIC_HAS_BONUS_POTENTIAL.value) {
    notes.push("Heroic has no bonus potential, so every drop and meso line must be cubed onto regular potential on gear you already own. Nothing here can be bought.");
  }

  // Which stat each slot should chase, decided ONCE up front from the
  // breakpoint rather than per-slot, so the answer is coherent.
  const wantDropFirst = before.dropPctForMesoBags < DROP_PCT_GUARANTEED_MESO_BAG;
  const mesoHeadroom = before.mesoGearCap.headroom;

  const slotCandidates: Array<{ slot: string; cands: FarmCandidate[] }> = [];
  for (const slot of FARM_ELIGIBLE_SLOTS.value) {
    const want: "drop" | "meso" = wantDropFirst || mesoHeadroom <= 0 ? "drop" : "meso";
    const cands = candidatesForSlot(slot, baseItems[slot], spares, ch.main, want);
    if (cands.length > 1) slotCandidates.push({ slot, cands });
  }

  const combinations = slotCandidates.reduce((a, s) => a * s.cands.length, 1);
  const budget = opts.searchBudget ?? 200_000;
  const mode: "exhaustive" | "greedy" = combinations <= budget ? "exhaustive" : "greedy";

  const evaluate = (picks: FarmCandidate[]): { score: FarmScore; ratio: number | null; ok: boolean } => {
    const items: Record<string, Item> = { ...baseItems };
    for (const p of picks) items[p.slot] = applyPlannedLines(p);
    const score = scoreFarming(items, opts);
    const ratio = damageRatioFor(ch, picks.filter((p) => p.origin !== "keep"), opts, map);
    const ok = ratio === null ? false : ratio >= floor.minRatio - 1e-9;
    return { score, ratio, ok };
  };

  let best: { picks: FarmCandidate[]; score: FarmScore; ratio: number | null } | null = null;

  /**
   * Income first, damage as the tie-break. Two loadouts that buy the same
   * income are NOT equivalent: the one that keeps more damage keeps more
   * headroom against the spawn-cycle clear, and headroom is the thing the
   * player cannot see and this planner cannot measure. The epsilon is a
   * floating-point guard, not a tolerance band.
   */
  const better = (
    a: { score: FarmScore; ratio: number | null },
    b: { score: FarmScore; ratio: number | null },
  ): boolean => {
    const d = a.score.incomeIndex - b.score.incomeIndex;
    if (Math.abs(d) > 1e-9) return d > 0;
    return (a.ratio ?? 0) > (b.ratio ?? 0);
  };

  if (mode === "exhaustive") {
    const walk = (i: number, acc: FarmCandidate[]): void => {
      if (i === slotCandidates.length) {
        const used = acc.filter((p) => p.origin !== "keep");
        if (opts.maxNewLines !== undefined && used.reduce((a, p) => a + p.cubeMesoLines + p.cubeDropLines, 0) > opts.maxNewLines) return;
        const r = evaluate(acc);
        if (!r.ok) return;
        if (!best || better(r, best)) best = { picks: [...acc], score: r.score, ratio: r.ratio };
        return;
      }
      for (const c of slotCandidates[i].cands) {
        acc.push(c);
        walk(i + 1, acc);
        acc.pop();
      }
    };
    walk(0, []);
  } else {
    notes.push(`Candidate space is ${combinations.toLocaleString()} combinations, above the ${budget.toLocaleString()} exhaustive budget — this is a greedy result and may not be optimal.`);
    const picks: FarmCandidate[] = slotCandidates.map((s) => s.cands[0]);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < slotCandidates.length; i++) {
        const baseline = evaluate(picks);
        for (const c of slotCandidates[i].cands) {
          const trial = [...picks];
          trial[i] = c;
          const r = evaluate(trial);
          if (r.ok && better(r, baseline)) {
            picks[i] = c;
            improved = true;
          }
        }
      }
    }
    const r = evaluate(picks);
    if (r.ok) best = { picks, score: r.score, ratio: r.ratio };
  }

  if (!best) {
    // Nothing clears the floor. That is a real answer, not a failure — say what
    // would change it.
    notes.push(
      `No farming swap keeps damage at or above the floor (${(floor.minRatio * 100).toFixed(0)}% of current mob damage). ${floor.basis} The cheapest ways out are not gear: move Boss Damage hyper points to Normal Damage in a second hyper preset (Boss Damage is worth literally zero against mobs), level up — the level multiplier is a step table, so closing a 7-level gap is worth about +32% mob damage for free — or drop to an easier map.`,
    );
    return {
      picks: [],
      overlay: {},
      before,
      after: before,
      incomeRatio: 1,
      damageRatio: 1,
      floor,
      feasible: false,
      swaps: [],
      searchMode: mode,
      notes,
      confidence: "ranking-only",
    };
  }

  // TypeScript cannot see through the closure assignment above.
  const chosen: { picks: FarmCandidate[]; score: FarmScore; ratio: number | null } = best;
  const used = chosen.picks.filter((p) => p.origin !== "keep" && (p.cubeMesoLines + p.cubeDropLines > 0 || p.mesoPct + p.dropPct > 0));
  const overlay: Record<string, Item> = {};
  for (const p of used) overlay[p.slot] = applyPlannedLines(p);

  const swaps: SwapReport[] = used.map((p) => {
    const solo = damageRatioFor(ch, [p], opts, map);
    return {
      slot: p.slot,
      from: baseItems[p.slot]?.name ?? "(empty)",
      to: p.item.name,
      origin: p.origin,
      mesoGain: p.mesoPct,
      dropGain: p.dropPct,
      damageCostPct: solo === null ? null : (1 - solo) * 100,
      cubeLines: p.cubeMesoLines + p.cubeDropLines,
      needsLegendary: p.needsLegendary,
      why: p.why,
    };
  });

  if (chosen.score.mesoGearCap.capIsUnverified || chosen.score.dropTotalCap.capIsUnverified) {
    notes.push("The meso and drop caps used here are wiki-transcribed tooltip text, not Nexon patch notes. They bound the target, they do not change the shape of the answer for you — you are nowhere near them.");
  }
  if (map) notes.push(mapDifficulty(map, ch.lvl, ch.stats.arcane).why);
  if (used.some((p) => p.origin === "cube-in-place")) {
    notes.push("At least one recommendation cubes an item that is shared with your boss preset. That is one physical item: the stat lines you reroll away are gone from your bossing too.");
  }

  return {
    picks: chosen.picks,
    overlay,
    before,
    after: chosen.score,
    incomeRatio: incomeRatio(before, chosen.score),
    damageRatio: chosen.ratio,
    floor,
    feasible: true,
    swaps,
    searchMode: mode,
    notes,
    confidence: "ranking-only",
  };
}

/** Materialise a candidate's planned lines onto a copy of the item, so the
 *  score function sees the loadout as it WOULD be. The synthesised line text
 *  deliberately matches the in-game wording the ./meso parser expects. */
function applyPlannedLines(p: FarmCandidate): Item {
  if (p.cubeMesoLines === 0 && p.cubeDropLines === 0) return p.item;
  const pct = dropMesoLinePct(p.item.lvl || 0);
  const lines = [...(p.item.p || [])];
  const planned: string[] = [];
  for (let i = 0; i < p.cubeMesoLines; i++) planned.push(`Mesos Obtained +${pct}%`);
  for (let i = 0; i < p.cubeDropLines; i++) planned.push(`Item Drop Rate +${pct}%`);
  // A cubed line REPLACES a line; it does not append to a fourth slot.
  for (let i = 0; i < planned.length; i++) lines[i] = planned[i];
  return { ...p.item, pot: FARM_LINE_REQUIRES_TIER, p: lines.slice(0, 3) };
}

/* ==========================================================================
 * 11. COLD START — the player who has nothing and does not know where to begin
 * ========================================================================*/

export type ColdStartCost = "free" | "honor" | "cubes" | "time" | "mesos";

export interface ColdStartStep {
  readonly order: number;
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly cost: ColdStartCost;
  readonly costMesos: number | null;
  readonly gainDropPct: number;
  readonly gainMesoPct: number;
  readonly confidence: "sourced" | "ranking-only";
}

/**
 * Ranking a slot as a farming carrier.
 *
 * Lower is better. The principle, which is well sourced: the drop/meso line is
 * a FLAT 20% at item level 71+, while the stat % it displaces scales with item
 * level and star force. So the correct carrier is the accessory with the WORST
 * damage ceiling — a Lv 110 Silver Blossom Ring is exactly as good a meso
 * carrier as a Lv 200 endgame ring and costs a fraction as much damage. Never
 * put farming lines on a 22-star-capable boss ring.
 */
export function carrierCost(it: Item | undefined, ch: Character): number | null {
  if (!it) return 0;
  const c = itemContribution(it, ch.main);
  const flat = pctToFlat(ch, c.statPct);
  if (flat === null) return null;
  // Star force is the dominant term for a boss ring and is why one must not be
  // used as a carrier; ATT is weighted by the same 1:1 pass-through the stat
  // model uses for a ranged class's range formula.
  return flat + c.flatMain + c.att * 4 + (it.pot === FARM_LINE_REQUIRES_TIER ? 0 : LEGENDARY_TIER_UP_PENALTY);
}

/** Ranking penalty applied to a carrier that is not yet Legendary, expressed in
 *  the same flat-main-stat units as the rest of carrierCost.
 *
 *  NOT A GAME CONSTANT — a policy weight. Reaching Legendary is usually the
 *  real expense (GMS changed tier-up probabilities in v.239 and publishes no
 *  current numbers), so a non-Legendary carrier is deprioritised, but not
 *  excluded, because the v.271 event track is currently handing out a
 *  guaranteed-Legendary event ring. */
export const LEGENDARY_TIER_UP_PENALTY = 400;

/**
 * The ordered first moves for a player with no farming loadout.
 *
 * Order is not a preference. It follows from the mechanics: the cube-free
 * sources are large enough to clear the 67% breakpoint on their own, the
 * breakpoint is a step worth a flat +67% on all meso income, and the meso gear
 * cap makes every point past +100% worthless. A player who cubes first has paid
 * for something they could have had free.
 */
export function coldStartPlan(ch: CharacterWithLoadouts, opts: RecommendOptions = {}): ColdStartStep[] {
  const items = loadoutItems(ch, opts.loadoutId);
  const score = scoreFarming(items, opts);
  const steps: ColdStartStep[] = [];
  let order = 1;
  const have = new Set(opts.nonGear ?? []);

  steps.push({
    order: order++,
    id: "hyper-preset",
    title: "Move Boss Damage hyper points to Normal Damage in a second hyper preset",
    detail:
      "Boss Damage contributes EXACTLY ZERO against normal mobs — the mob formula uses %Normal Enemy Damage where the boss formula uses %Boss Damage. Normal Damage is a hyper stat with the same value curve (+55% at level 15), and hyper stats have three presets just like equipment. This is the single largest farming lever in the game, it costs no cubes and no mesos, and it is entirely reversible. Do it before anything on this list.",
    cost: "free",
    costMesos: 0,
    gainDropPct: 0,
    gainMesoPct: 0,
    confidence: "sourced",
  });

  // Cube-free drop and meso sources, biggest first, that the player does not
  // already have.
  // Sort key is meso plus the LARGER of the two drop figures, not their sum:
  // for most sources they are the same number and adding both would count one
  // stat twice. Sources that only raise item drops (familiar item-drop boost)
  // therefore rank on their real contribution, not a doubled one.
  const magnitude = (s: NonGearSource): number => s.mesoPct + Math.max(s.dropPct, s.dropPctForMesoBags);
  const free = NON_GEAR_SOURCES.value
    .filter((s) => s.cubeFree && !s.temporary && !have.has(s.id))
    .sort((a, b) => magnitude(b) - magnitude(a));
  for (const s of free) {
    steps.push({
      order: order++,
      id: s.id,
      title: s.n,
      detail: `${s.note ? s.note + " " : ""}Source: ${s.source}${s.sourced ? "" : " (UNVERIFIED — see the provenance panel)"}`,
      cost: s.id.startsWith("innerAbility") ? "honor" : "time",
      costMesos: 0,
      gainDropPct: Math.max(s.dropPct, s.dropPctForMesoBags),
      gainMesoPct: s.mesoPct,
      confidence: s.sourced ? "sourced" : "ranking-only",
    });
  }

  // Claim what the player already owns. This is the "if you forgot" case: the
  // gear exists, it was just never attributed to a goal.
  if (score.gearBySlot.length > 0) {
    const owned = score.gearBySlot.filter((r) => r.eligible);
    if (owned.length > 0) {
      steps.push({
        order: order++,
        id: "claim-existing",
        title: `Declare a farming preset and claim the ${owned.length} item${owned.length > 1 ? "s" : ""} you already have`,
        detail:
          `${owned.map((r) => `${r.item} (${[r.mesoPct ? `${r.mesoPct}% meso` : "", r.dropPct ? `${r.dropPct}% drop` : ""].filter(Boolean).join(", ")})`).join("; ")}. ` +
          `That is ${score.gearMesoPct}% of your ${MESO_GEAR_CAP_PCT.value}% meso cap and ${score.gearDropPct}% drop already banked. These are not drift to be corrected — they are the right lines on the right kind of carrier. Putting them in a farming loadout stops the planner calling them dead and gives you a real starting position.`,
        cost: "free",
        costMesos: 0,
        gainDropPct: 0,
        gainMesoPct: 0,
        confidence: "sourced",
      });
    }
  }

  // Then cubes, in threshold order, on the cheapest eligible carriers.
  const ranked = FARM_ELIGIBLE_SLOTS.value
    .map((slot) => ({ slot, item: items[slot], cost: carrierCost(items[slot], ch) }))
    .filter((r): r is { slot: string; item: Item; cost: number } => !!r.item && r.cost !== null)
    .sort((a, b) => a.cost - b.cost);

  const gap = Math.max(0, DROP_PCT_GUARANTEED_MESO_BAG - score.dropPctForMesoBags);
  if (gap > 0) {
    const need = Math.ceil(gap / 20);
    steps.push({
      order: order++,
      id: "drop-to-breakpoint",
      title: `Cube ${need} drop line${need > 1 ? "s" : ""} to clear the ${DROP_PCT_GUARANTEED_MESO_BAG}% meso-bag breakpoint`,
      detail:
        `Mobs have a ${(MESO_BAG_BASE_CHANCE.value * 100).toFixed(0)}% base chance to drop a meso bag, multiplied by your drop rate; ${DROP_PCT_GUARANTEED_MESO_BAG}% guarantees it. You are ${gap}% short, so every point of Mesos Obtained you own is currently being multiplied by ${score.mesoBagChance.toFixed(2)}. This is a step, not a curve, and it is worth more than any drop rate above it. ` +
        (ranked.length
          ? `Cheapest carriers you own, worst damage ceiling first: ${ranked.slice(0, 3).map((r) => `${r.item.name} (${r.slot})`).join(", ")}. Remember the line is a flat 20% at item level 71+, so the junk accessory carries exactly as much as the endgame one.`
          : "You have no eligible accessory equipped — face, eye, earring, either pendant or any of the four rings."),
      cost: "cubes",
      costMesos: null,
      gainDropPct: need * 20,
      gainMesoPct: 0,
      confidence: "ranking-only",
    });
  }

  const mesoRoom = score.mesoGearCap.headroom;
  if (mesoRoom > 0) {
    const need = Math.ceil(mesoRoom / 20);
    steps.push({
      order: order++,
      id: "meso-to-cap",
      title: `Then cube toward the ${MESO_GEAR_CAP_PCT.value}% Mesos Obtained gear cap (${need} more line${need > 1 ? "s" : ""})`,
      detail:
        `Heroic multiplies your total additive meso by ${HEROIC_MESO_MULTIPLIER.value}x, which is why an additive point is worth six times more here than on an Interactive world. Stop at ${MESO_GEAR_CAP_PCT.value}% — every point past the gear cap is wasted, and the cap is shared with any Legendary familiar rolling "Mesos Obtained +20%", which is free.`,
      cost: "cubes",
      costMesos: null,
      gainDropPct: 0,
      gainMesoPct: need * 20,
      confidence: "ranking-only",
    });
  }

  steps.push({
    order: order++,
    id: "drop-beyond",
    title: "Only then push drop rate further",
    detail:
      `Past the meso-bag breakpoint, drop rate no longer touches meso income at all — it buys nodestones, familiar cards and equipment drops. The ${DROP_GEAR_CAP_PCT.value}% equipment cap needs ten lines at two per item, i.e. five dedicated accessories, which is not a realistic target in Reboot. Treat it as a ceiling, not a goal.`,
    cost: "cubes",
    costMesos: null,
    gainDropPct: 0,
    gainMesoPct: 0,
    confidence: "ranking-only",
  });

  return steps;
}

/* ==========================================================================
 * 12. CUBE ECONOMICS — ranking only
 * ========================================================================*/

/** Which real-world cube family a rate belongs to. GMS Solid / Karma Solid /
 *  Event Ring Exclusive Solid are the in-game family; Glowing and Bright are
 *  the cash family bought with mesos on Heroic. */
export type CubeFamily = "ingame" | "cash";

export function cubeFamilyOf(cube: CubeType): CubeFamily {
  return cube === "glowing" || cube === "bright" ? "cash" : "ingame";
}

/**
 * Probability that the FIRST (prime) line of a Legendary accessory rolls Mesos
 * Obtained or Item Drop Rate.
 *
 * KMS ONLY, queried live from Nexon Korea's mandated disclosure endpoint
 * (POST /Guide/OtherProbability/cube/GetSearchProbList, nGrade=4, nPartsType
 * 15-19, level bands 120~200 and 201~250, which carry identical weights).
 * Nexon America has never published a GMS table, and a documented ~10x GMS/KMS
 * gap exists in the adjacent bonus-potential rates — so these are directional
 * inputs for RANKING slots and cube choice only.
 */
export const PRIME_LINE_WEIGHT_DROP_MESO: Sourced<Record<CubeFamily, number>> = {
  value: { ingame: 3 / 31, cash: 3 / 39 },
  source: "Nexon KR live probability disclosure, queried 2026-09-11: Gold/Meister (id 2711004) 9.6774% = 3/31; Red (id 5062009) 7.6923% = 3/39",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "KMS, not GMS. Cube identity inferred through the GMS v.239 revamp (Solid ~ Gold/Meister, Glowing ~ Red, Bright ~ Black). The DEF% line has been removed from the live KMS pool, which moved the denominators 34 -> 31 and 43 -> 39; if GMS still rolls DEF% the correct figures are 8.8235% and 6.9767%. Denominator itself is unverified for GMS.",
};

/**
 * Probability that line 2 or line 3 rolls PRIME, i.e. at the item's own tier
 * rather than one below. A DIFFERENT TABLE from the prime-line weights above.
 *
 * This is NOT the probability of getting a drop/meso line on line 2 — it is the
 * probability that line 2 is prime AT ALL. Multiply by the pool weight to get
 * the drop/meso probability (see `pBonusFarmLine`). Conflating the two is the
 * error that overstates a double-meso roll by orders of magnitude, and this
 * player already owns a double-meso ring, so it is exactly the quantity that
 * must not be got wrong.
 *
 * Glowing and Bright are read from ./cubes PRIME_LINE rather than duplicated,
 * so there is one place in the repo to correct them. Their KMS ancestors are
 * first-party: Nexon Korea's 2021-03-05 notice discloses Red 10% / 1% and
 * Black 20% / 5%, flat across all four tiers.
 *
 * THE IN-GAME FAMILY IS THE CORRECTION. ./cubes assigns mystical/hard/solid the
 * Red Cube's 10% / 1% shape, but the in-game cubes are documented to give lines
 * 2 and 3 the SAME prime chance as each other — a 10:1 split is wrong in shape,
 * not merely in value. The figure below is derived from the live KMS Legendary
 * ring table: Gold/Meister shows meso-or-drop at 0.01932% on line 2 AND on
 * line 3, which against the 9.6774% pool weight implies a prime rate of
 * 0.01932 / 9.6774 = 0.1996% on both. (0.1996% is ALSO the published
 * Meister Unique -> Legendary tier-up rate; that coincidence is noted, not
 * relied on — these are different mechanics and the agreement may be accident.)
 */
export const EXTRA_LINE_PRIME_RATE: Sourced<Record<CubeFamily, { line2: number; line3: number }>> = {
  value: {
    ingame: { line2: 0.001996, line3: 0.001996 },
    cash: CUBE_PRIME_LINE.bright.value,
  },
  source:
    "Glowing/Bright: ./cubes PRIME_LINE, from Nexon KR notice 133316 (2021-03-05). In-game family: derived from the live Nexon KR disclosure (Legendary ring, nPartsType 18, cube 2711004), meso-or-drop 0.01932% on lines 2 and 3 against the 9.6774% pool weight",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note:
    "KMS only; 2021 notice predates the GMS v.239 cube revamp by two years. NOTE THE INVERSION: in-game cubes are mildly BETTER for the FIRST drop/meso line (9.68% vs 7.69%) and catastrophically worse for the second and third (~50x). Any \"use free event cubes for farming lines\" advice must therefore be scoped to first-line hunting only — telling a Heroic player to burn event Solid Cubes chasing a second drop line wastes real hours. The `cash` row uses Bright/Black rates; Glowing/Red is half of it, and pBonusFarmLine() reads the per-cube row directly.",
};

export interface CubeEstimate {
  readonly cube: CubeType;
  readonly family: CubeFamily;
  readonly pFirstLine: number;
  readonly expectedCubes: number;
  readonly expectedMesos: number | null;
  readonly confidence: "ranking-only";
  readonly caveat: string;
}

/**
 * Expected cubes to land one drop or meso line, counting the guaranteed-prime
 * FIRST line only.
 *
 * DERIVED, never a game constant. It ignores the small extra chance from lines
 * 2 and 3 (which lowers it slightly) and ignores the cost of first reaching
 * Legendary (which can dwarf it entirely). Every figure it produces is
 * `ranking-only`: a placeholder is on the path, so the UI must not print an
 * absolute cube count or meso total from it.
 */
export function estimateCubesForFarmLine(cube: CubeType): CubeEstimate {
  const family = cubeFamilyOf(cube);
  const p = PRIME_LINE_WEIGHT_DROP_MESO.value[family];
  const n = 1 / p;
  const unit = CUBE_COST_MESOS.value[cube];
  return {
    cube,
    family,
    pFirstLine: p,
    expectedCubes: n,
    expectedMesos: unit > 0 ? n * unit : null,
    confidence: "ranking-only",
    caveat:
      "KMS-derived. Nexon America has never published per-line potential rates, and cube identity across the GMS v.239 revamp is inferred. Use this to choose BETWEEN cubes, never to budget a cube count — and note it excludes the cost of reaching Legendary, which is usually the larger bill.",
  };
}

/**
 * P(at least one EXTRA drop/meso line beyond the prime one) on a single cube,
 * and P(both extras) — i.e. the triple-meso roll.
 *
 * Quote pAny, never the line-2 figure alone: line 3 is real and dropping it
 * understates the answer. A line is drop/meso only if it rolls prime first
 * (a non-prime line on a Legendary item draws from the Unique pool, which
 * contains neither), so each term is primeRate x poolWeight.
 *
 * The per-cube prime row is read directly rather than through the family, so
 * Glowing gets Red's 10%/1% and Bright gets Black's 20%/5% instead of both
 * getting the same number.
 */
export function pBonusFarmLine(cube: CubeType): { pAny: number; pBoth: number; confidence: "ranking-only" } {
  const family = cubeFamilyOf(cube);
  const w = PRIME_LINE_WEIGHT_DROP_MESO.value[family];
  const prime = family === "ingame" ? EXTRA_LINE_PRIME_RATE.value.ingame : CUBE_PRIME_LINE[cube].value;
  const p2 = prime.line2 * w;
  const p3 = prime.line3 * w;
  return { pAny: 1 - (1 - p2) * (1 - p3), pBoth: p2 * p3, confidence: "ranking-only" };
}

/* ==========================================================================
 * 13. DRIFT — the "if you forgot" case, in both directions
 * ========================================================================*/

export type DriftKind =
  | "unclaimed-farm-gear"
  | "orphan-farm-line"
  | "boss-line-on-farm-carrier"
  | "farm-line-on-premium-carrier"
  | "farm-line-on-ineligible-slot"
  | "over-meso-gear-cap"
  | "too-many-drop-lines"
  | "drop-below-breakpoint"
  | "farm-line-below-max-value"
  | "boss-stat-advice-on-farm-preset";

export interface DriftFinding {
  readonly kind: DriftKind;
  readonly severity: "hi" | "mid" | "ok";
  readonly slot?: string;
  readonly item?: string;
  readonly msg: string;
  readonly fix: string;
}

/**
 * Lines the player already has that only make sense on the other loadout.
 *
 * Both directions, because both happen: a meso ring left in the boss preset is
 * dead weight while bossing AND invisible while farming; a Boss Damage line on
 * a dedicated farm carrier is a wasted slot. And the most common case of all is
 * the one this whole feature exists for — farming gear that is correct but was
 * never attributed to a farming loadout, so the planner has been quietly
 * telling the player to reroll it away.
 */
export function detectDrift(ch: CharacterWithLoadouts, opts: RecommendOptions = {}): DriftFinding[] {
  const out: DriftFinding[] = [];
  const farm = opts.loadoutId ? findLoadout(ch, opts.loadoutId) : ch.loadouts?.find((l) => l.kind === "farm");
  const base = ch.items;
  const hasFarmLoadout = !!farm;

  for (const [slot, it] of Object.entries(base)) {
    if (!it) continue;
    const lines = (it.p || []).filter(Boolean);
    const meso = mesoPctFromLines(lines);
    const drop = dropPctFromLines(lines);
    const eligible = isFarmEligibleSlot(slot);
    const dedicated = !!farm && slot in farm.over;

    if ((meso || drop) && !eligible) {
      out.push({
        kind: "farm-line-on-ineligible-slot",
        severity: "mid",
        slot,
        item: it.name,
        msg: `${it.name} shows ${[meso ? `${meso}% Mesos Obtained` : "", drop ? `${drop}% Item Drop Rate` : ""].filter(Boolean).join(" and ")} in the ${slot} slot, which regular potential cannot roll in Heroic — the accessory pool is face, eye, earring, pendant and ring only, and Heroic has no bonus potential.`,
        fix: "Check the slot this item is actually in. If it really is a badge, the odds and even the eligibility are unknown for GMS and this planner will not model them; treat the line as a bonus you have, not as something to replicate.",
      });
      continue;
    }

    if ((meso || drop) && eligible && !hasFarmLoadout) {
      out.push({
        kind: "unclaimed-farm-gear",
        severity: "hi",
        slot,
        item: it.name,
        msg: `${it.name} carries ${[meso ? `${meso}% Mesos Obtained` : "", drop ? `${drop}% Item Drop Rate` : ""].filter(Boolean).join(" and ")} but you have no farming loadout, so the planner has been scoring it as if you only ever boss.`,
        fix: "Create a farming loadout and put this item in it. Nothing needs to be rerolled — this is income you already own that was never attributed to a goal.",
      });
    } else if ((meso || drop) && eligible && hasFarmLoadout && !dedicated) {
      out.push({
        kind: "orphan-farm-line",
        severity: "mid",
        slot,
        item: it.name,
        msg: `${it.name} carries farming lines but sits in your base/boss preset rather than the farming overlay.`,
        fix: "If you wear it while farming, it is already working — but move it into the farming overlay so the planner counts it and stops treating those lines as filler.",
      });
    }

    if ((meso || drop) && eligible) {
      const maxPct = dropMesoLinePct(it.lvl || 0);
      const each = lines.filter((l) => {
        const c = classifyLine(l, ch.main);
        return c.kind === "meso" || c.kind === "drop";
      });
      for (const l of each) {
        const c = classifyLine(l, ch.main);
        if (c.value > 0 && c.value < maxPct) {
          out.push({
            kind: "farm-line-below-max-value",
            severity: "ok",
            slot,
            item: it.name,
            msg: `"${l}" is below the ${maxPct}% this item's level (${it.lvl}) is entitled to.`,
            fix: "Line value is set by item level, not by tier: 10% below item level 31, 15% to 70, 20% from 71 up, with no further bump. A re-roll on the same item would give the full value.",
          });
        }
      }
      const dropLineCount = each.filter((l) => classifyLine(l, ch.main).kind === "drop").length;
      if (dropLineCount > DROP_LINES_PER_ITEM_MAX.value) {
        out.push({
          kind: "too-many-drop-lines",
          severity: "ok",
          slot,
          item: it.name,
          msg: `${it.name} shows ${dropLineCount} Item Drop Rate lines, above the documented per-item limit of ${DROP_LINES_PER_ITEM_MAX.value}.`,
          fix: "Either the import mis-read a line, or the 2-line limit is wrong for GMS — it is transcribed from a Cloudflare-gated wiki and could not be verified. Do not plan a third drop line on one item on the strength of this.",
        });
      }
    }

    // A farming line sitting on a premium boss carrier is the expensive mistake:
    // it is the same 20% it would be on a junk accessory, but the stat it
    // displaces is far larger.
    if ((meso || drop) && eligible) {
      const cost = carrierCost(it, ch);
      const star = it.star || 0;
      if (cost !== null && (star >= 15 || (it.lvl || 0) >= 160)) {
        out.push({
          kind: "farm-line-on-premium-carrier",
          severity: "mid",
          slot,
          item: it.name,
          msg: `${it.name} is a ${star}-star Lv ${it.lvl} accessory carrying a farming line. The line is worth the same 20% it would be on a Lv 110 junk ring, but the stat it displaces here is much larger.`,
          fix: "If you own a spare low-level accessory for this slot, move the farming line there and give this item its damage lines back. Never put farming lines on a 22-star-capable boss ring.",
        });
      }
    }

    // The other direction: boss lines squatting on a dedicated farm carrier.
    if (dedicated) {
      for (const l of lines) {
        const v = evaluateLine(l, { objective: "farm", main: ch.main, slot, dedicated: true });
        if (v.dead && (v.line.kind === "boss" || v.line.kind === "ied")) {
          out.push({
            kind: "boss-line-on-farm-carrier",
            severity: "mid",
            slot,
            item: it.name,
            msg: `"${l}" on ${it.name}, which is a dedicated farming carrier. ${v.why}`,
            fix: "This is the line to reroll toward Mesos Obtained or Item Drop Rate — you are not bossing with this item, so nothing is lost.",
          });
        }
      }
    }
  }

  const score = scoreFarming(loadoutItems(ch, opts.loadoutId), opts);
  if (score.mesoGearCap.used > score.mesoGearCap.cap) {
    out.push({
      kind: "over-meso-gear-cap",
      severity: "hi",
      msg: `Mesos Obtained from potentials is ${score.mesoGearCap.used}% against a ${score.mesoGearCap.cap}% cap. ${score.mesoGearCap.used - score.mesoGearCap.cap}% of it is doing nothing.`,
      fix: "Put the next line into Item Drop Rate instead. Note the cap is shared with any Legendary familiar rolling \"Mesos Obtained +20%\", so check your familiars before assuming the overflow is on gear.",
    });
  }
  if (score.belowBagBreakpoint && score.gearMesoPct > 0) {
    out.push({
      kind: "drop-below-breakpoint",
      severity: "hi",
      msg: `You have ${score.gearMesoPct}% Mesos Obtained on gear but only ${score.dropPctForMesoBags}% drop rate, against a ${DROP_PCT_GUARANTEED_MESO_BAG}% breakpoint. Mobs have a ${(MESO_BAG_BASE_CHANCE.value * 100).toFixed(0)}% base chance to drop a meso bag at all, so your meso % is being multiplied by ${score.mesoBagChance.toFixed(2)}.`,
      fix: `Close the ${score.dropToBreakpoint}% gap before adding any more meso. Drop and meso are not independent below this line — the first ${DROP_PCT_GUARANTEED_MESO_BAG}% of drop rate is partly a meso stat.`,
    });
  }
  if (hasFarmLoadout) {
    out.push({
      kind: "boss-stat-advice-on-farm-preset",
      severity: "ok",
      msg: "While a farming loadout is active, boss-objective advice does not apply: Boss Damage is a different formula term against mobs and contributes zero, Ignore DEF faces 10% mob PDR rather than 300%, and Ignore Elemental Resistance is inert.",
      fix: "Read the farming panel, not the IED and boss-damage targets. The boss targets are still correct for your boss preset, which is the same physical gear in every slot you have not overridden.",
    });
  }

  const rank: Record<DriftFinding["severity"], number> = { hi: 0, mid: 1, ok: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return out;
}

/* ==========================================================================
 * 14. PROVENANCE AND SELF-TEST
 * ========================================================================*/

/** Every unverified constant in this module, for the UI's provenance panel and
 *  for a checker asserting none of them reached a headline figure unflagged. */
export function farmingUnverified(): ReadonlyArray<UnverifiedNote> {
  const fromSources = NON_GEAR_SOURCES.value
    .filter((s) => !s.sourced)
    .map((s) => ({ name: `NON_GEAR_SOURCES.${s.id}`, why: s.note ?? "Community figure, not sourced to a first-party GMS text." }));
  return [...UNVERIFIED, ...fromSources];
}

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Self-test. The parity check against rules.isDeadLine is the important one:
 * this module duplicates that function's regexes because ./rules does not
 * export them and may not be edited, so a divergence must be caught here rather
 * than shipped as a silent behaviour change at the call sites that adopt
 * isDeadLineFor().
 */
export function __selfTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const main: MainStat = "dex";

  const corpus = [
    "DEX +12%", "DEX +9%", "All Stats +3%", "STR +9%", "LUK +6%", "INT +12%",
    "Boss Damage +30%", "Ignore Enemy DEF +30%", "ATT +9%", "ATT +51",
    "Max HP +6%", "Max MP +6%", "DEF +120", "Critical Damage +8%",
    "Mesos Obtained +20%", "Item Drop Rate +20%", "Movement Speed +6%",
    "Jump +6%", "DEX +40", "Critical Rate +12%", "",
  ];
  const mismatches = corpus.filter((l) => isDeadLineFor(l, main, "boss") !== bossIsDeadLine(l, main));
  out.push({
    name: "boss-objective parity with rules.isDeadLine",
    ok: mismatches.length === 0,
    detail: mismatches.length === 0 ? `${corpus.length} lines agree` : `diverged on: ${mismatches.map((m) => `"${m}"`).join(", ")}`,
  });

  out.push({
    name: "farm objective inverts meso and boss lines",
    ok:
      !isDeadLineFor("Mesos Obtained +20%", main, "farm", "ring1", true) &&
      isDeadLineFor("Boss Damage +30%", main, "farm", "ring1", true) &&
      !isDeadLineFor("Boss Damage +30%", main, "farm", "weapon", false),
    detail: "meso alive on a farm carrier; boss dead on a farm carrier; boss ALIVE on an ineligible slot (never reroll shared boss gear)",
  });

  out.push({
    name: "farm advice never fires on a shared item",
    ok: !isDeadLineFor("Boss Damage +30%", main, "farm", "ring1", false),
    detail: "an eligible slot whose item is not in the farm overlay is still boss gear",
  });

  const slotIds = new Set(SLOTS.map((s: SlotDef) => s.id));
  const unknown = FARM_ELIGIBLE_SLOTS.value.filter((s) => !slotIds.has(s));
  out.push({
    name: "every eligible slot exists in SLOTS",
    ok: unknown.length === 0,
    detail: unknown.length === 0 ? `${FARM_ELIGIBLE_SLOTS.value.length} of ${SLOTS.length} slots eligible` : `unknown: ${unknown.join(", ")}`,
  });

  out.push({
    name: "eligible + ineligible partitions SLOTS exactly",
    ok: FARM_ELIGIBLE_SLOTS.value.length + FARM_INELIGIBLE_SLOTS.length === SLOTS.length,
    detail: `${FARM_ELIGIBLE_SLOTS.value.length} + ${FARM_INELIGIBLE_SLOTS.length} = ${SLOTS.length}`,
  });

  out.push({
    name: "belt and shoulder are farm-ineligible",
    ok: !isFarmEligibleSlot("belt") && !isFarmEligibleSlot("shoulder"),
    detail: "the potential system groups Cape + Belt + Shoulderpad with armour, which has no drop or meso line",
  });

  out.push({
    name: "breakpoint derives from the base bag chance",
    ok: DROP_PCT_GUARANTEED_MESO_BAG === 67 && Math.abs(mesoBagChance(67) - 1) < 1e-9,
    detail: `0.6 x 1.67 = ${(0.6 * 1.67).toFixed(3)}; breakpoint ${DROP_PCT_GUARANTEED_MESO_BAG}%`,
  });

  out.push({
    name: "meso bag chance clamps at 1",
    ok: mesoBagChance(500) === 1,
    detail: "drop rate past the breakpoint adds nothing to meso income",
  });

  out.push({
    name: "line value is flat past item level 71",
    ok: dropMesoLinePct(110) === 20 && dropMesoLinePct(200) === 20 && dropMesoLinePct(50) === 15 && dropMesoLinePct(20) === 10,
    detail: "a Lv 110 junk ring carries the same 20% as a Lv 200 endgame ring",
  });

  const worked = mesosObtainedPct(100 + 20 + 12 + 3, [HEROIC_MESO_MULTIPLIER.value]);
  out.push({
    name: "meso formula reproduces the documented worked example",
    ok: worked === 1310,
    detail: `(100 + 135) x 6 - 100 = ${worked}, expected 1310`,
  });

  out.push({
    name: "additive meso is capped before the multiplier",
    ok: mesosObtainedPct(9999, [HEROIC_MESO_MULTIPLIER.value]) === (100 + MESO_TOTAL_ADDITIVE_CAP_PCT.value) * HEROIC_MESO_MULTIPLIER.value - 100,
    detail: "the 300% additive cap applies inside the parentheses, not after",
  });

  out.push({
    name: "level multiplier table reads at the anchors",
    ok: levelDamageMult(244, 244) === 1.1 && levelDamageMult(244, 251) === 0.83 && levelDamageMult(260, 244) === 1.2,
    detail: "gap 0 -> 1.10, gap -7 -> 0.83, gap +16 -> 1.20",
  });

  out.push({
    name: "Arcane map multiplier caps at 1.5 for this character",
    ok: arcaneMapMultiplier(1060, 670) === 1.5 && Math.abs(arcaneMapMultiplier(1060, 790) - 1060 / 790) < 1e-9,
    detail: "capped through Moonbridge; below cap at Labyrinth Core",
  });

  out.push({
    name: "no meso level penalty inside the +-10 band",
    ok: mesoLevelPenalty(244, 251) === 0 && mesoLevelPenalty(244, 254) === 0 && mesoLevelPenalty(244, 260) > 0,
    detail: "every Arcane River map this planner lists is penalty-free at Lv 244",
  });

  out.push({
    name: "drop/meso parsing agrees with lib/meso",
    ok: mesoPctFromLines(["Mesos Obtained +20%", "Mesos Obtained +20%"]) === 40 && dropPctFromLines(["Item Drop Rate +20%"]) === 20,
    detail: "single parser, not re-derived here",
  });

  out.push({
    name: "in-game cubes are better for line 1 and worse for lines 2-3",
    ok:
      PRIME_LINE_WEIGHT_DROP_MESO.value.ingame > PRIME_LINE_WEIGHT_DROP_MESO.value.cash &&
      EXTRA_LINE_PRIME_RATE.value.ingame.line2 < EXTRA_LINE_PRIME_RATE.value.cash.line2,
    detail: "the inversion that makes \"use free event cubes\" advice first-line-only",
  });

  {
    // A bonus line needs prime AND the pool weight. Bright: 20% x 7.6923% on
    // line 2 and 5% x 7.6923% on line 3. Getting this wrong by applying the
    // pool weight twice understates it ~13x; getting it wrong by omitting the
    // prime term overstates it ~5x.
    const b = pBonusFarmLine("bright");
    const g = pBonusFarmLine("glowing");
    const expected = 1 - (1 - 0.2 * (3 / 39)) * (1 - 0.05 * (3 / 39));
    out.push({
      name: "bonus drop/meso line probability composes prime x pool weight",
      ok: Math.abs(b.pAny - expected) < 1e-12 && b.pAny > g.pAny && b.pAny > 0.015 && b.pAny < 0.025,
      detail: `Bright P(at least one extra) = ${(b.pAny * 100).toFixed(3)}%, Glowing = ${(g.pAny * 100).toFixed(3)}%, P(triple) = ${(b.pBoth * 100).toFixed(4)}%`,
    });
    out.push({
      name: "in-game cubes are far worse for lines 2 and 3",
      ok: pBonusFarmLine("solid").pAny < b.pAny / 10,
      detail: `solid ${(pBonusFarmLine("solid").pAny * 100).toFixed(4)}% vs bright ${(b.pAny * 100).toFixed(3)}% — free event cubes are a FIRST-line tool only`,
    });
  }

  out.push({
    name: "every cube estimate is ranking-only",
    ok: (["mystical", "hard", "solid", "glowing", "bright"] as CubeType[]).every((c) => estimateCubesForFarmLine(c).confidence === "ranking-only"),
    detail: "a KMS placeholder is on the path, so absolutes must be suppressed",
  });

  out.push({
    name: "loadout overlay resolves by absence, not by copy",
    ok: (() => {
      const ch: CharacterWithLoadouts = {
        name: "t", cls: "Bow Master", main: "dex", lvl: 244, cp: 0,
        stats: { main: 1, att: 1, crit: 0, critdmg: 0, boss: 0, ied: 0, hp: 0, arcane: 0, starforce: 0 },
        items: {
          ring1: { name: "A", lvl: 160, star: 0, pot: "legendary", sup: 0, p: [], f: [] },
          weapon: { name: "W", lvl: 200, star: 0, pot: "legendary", sup: 0, p: [], f: [] },
        },
        loadouts: [makeFarmLoadout({ ring1: { name: "B", lvl: 110, star: 0, pot: "legendary", sup: 0, p: [], f: [] } })],
      };
      const v = loadoutItems(ch, "farm");
      return v.ring1.name === "B" && v.weapon.name === "W" && ch.items.ring1.name === "A";
    })(),
    detail: "overridden slot swaps; absent slot shares the base item; the base is not mutated",
  });

  return out;
}
