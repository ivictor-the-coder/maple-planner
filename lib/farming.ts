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
  type Conf,
  type SlotDef,
} from "./rules";
import { mesoPctFromLines, dropPctFromLines } from "./meso";
import { damageIndex, inputsFromPercentStats, type DamageInputs } from "./damage";
import { CUBE_COST_MESOS, PRIME_LINE as CUBE_PRIME_LINE, type Sourced, type CubeType } from "./cubes";
// lib/symbols.ts declares these three effects and states in as many words that
// pricing them belongs to THIS file and to ./meso. The strings are imported and
// PARSED, never retyped: a percentage copied across a module boundary is a
// second source of truth that goes stale silently the day the first is fixed.
// The parsers used are ./meso's — the same two that read gear potential lines.
import { GRAND_SACRED_UNMODELLED_EFFECTS, GRAND_SACRED_AREAS } from "./symbols";
// SELF-IMPORT, deliberate, and the only way the provenance self-test below can
// be a test rather than a restatement.
//
// __selfTest() has to answer "is every placeholder constant in THIS module
// registered in farmingUnverified()?". A hand-written list of names cannot
// answer it: the failure mode is a constant nobody remembered, and a list nobody
// remembered to update is the same omission twice. The previous version of that
// test whitelisted four names and passed while FARM_MAPS sat unregistered.
// Enumerating the live module namespace is what closes that, and a module
// namespace is the only object in the language that holds every export.
//
// The cycle is safe: ES module namespaces are live bindings, and the only read
// happens inside a function body long after evaluation. Under TypeScript's
// CommonJS emit the self-require returns the same `module.exports` object (it
// already carries __esModule, so __importStar passes it through by reference),
// which is likewise live. The cost is that a bundler cannot tree-shake this
// module's exports; that is the price of the file being able to audit itself.
import * as FARMING_MODULE from "./farming";

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
    name: "MESO_BAG_BASE_CHANCE_UNVERIFIED",
    why: "0.60 is attested only by community sources (MapleStory Wiki, Francesco149/mapleguide). No Nexon statement found. LOAD-BEARING: the entire 67% drop breakpoint is derived from it.",
  },
  {
    name: "DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED",
    why: "Derived from MESO_BAG_BASE_CHANCE_UNVERIFIED, so it inherits that constant's status. 0.60 * 1.67 = 1.002.",
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
    name: "CONSUMABLE_MESO_BUCKET_CAP_PCT",
    why: "REGISTRY GAP found by the 2026-09-13 audit: the constant was marked placeholder: true with an internal-conflict note and was never listed here, so farmingUnverified() did not report it and a provenance panel would have shown it as clean. 100% is maplestorywiki.net/w/Meso; Legion's Wealth's own in-game text cites the 300% global cap instead, so the two disagree and neither is Nexon.",
  },
  {
    name: "MESO_LINES_PER_ITEM_MAX",
    why: "A bare 3 with no Sourced wrapper. It is structural rather than researched - an item has three potential lines - so it is almost certainly right, but it was asserted without saying which of those two it was.",
  },
  {
    name: "HEROIC_MESO_MULTIPLIER",
    why: "INTERNAL INCONSISTENCY, not a contradiction of the value. 6x is placeholder: false while MESO_GEAR_CAP_PCT, cited to the SAME wiki domain, is placeholder: true. One of the two verdicts is wrong by this file's own standard. The 6x is left as-is because it is corroborated everywhere and because changing it would move every meso figure in the app; flagged so the standard can be applied deliberately rather than by accident.",
  },
  {
    name: "SPAWN_TICK_MS / SPAWN_TICKS_PER_HOUR_UNVERIFIED",
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
    // Commas, not " / ": the registry's name field is split on " / " to list
    // several constants in one entry, and "rows -37 / -38 / -39" made the
    // splitter emit "-38" and "-39" as though they were constants. The doubt
    // here is about three ROWS, not about the whole table, so the entry stays
    // one name.
    name: "LEVEL_DAMAGE_MULT rows -37, -38 and -39",
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
    // FARM_MAPS leads the name because FARM_MAPS is the exported constant, and
    // the constant is what a registry has to be able to find. MAP_MOB_HP and
    // MAP_MOB_LEVEL are fields inside its rows and exist under no other name, so
    // an entry filed only under those two left the export itself unregistered —
    // the identical gap the 2026-09-13 audit closed for
    // CONSUMABLE_MESO_BUCKET_CAP_PCT and then failed to guard, because the test
    // that was supposed to guard it checked a four-name whitelist.
    name: "FARM_MAPS / MAP_MOB_HP / MAP_MOB_LEVEL",
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
export const MESO_BAG_BASE_CHANCE_UNVERIFIED: Sourced<number> = {
  value: 0.6,
  source: "maplestorywiki.net/w/Meso and github.com/Francesco149/mapleguide, independently. NOT a Nexon figure.",
  verifiedOn: "2026-09-13",
  patch: GMS_PATCH,
  placeholder: true,
  note:
    "UNVERIFIED against any Nexon statement, and the name now says so because a headline number a player acts on was resting on it. "
    + "Re-sourcing attempt 2026-09-13: see MESO_BAG_SOURCING_ATTEMPT. The MECHANISM is first-party corroborated; the MAGNITUDE 0.60 is not.",
};

/**
 * What a deliberate attempt to source 0.60 actually turned up, on 2026-09-13.
 * Recorded rather than summarised, so the next person does not repeat it.
 *
 * The two claims are NOT of equal standing and the audit turned on separating
 * them:
 *
 *   MECHANISM - "drop rate multiplies meso-bag FREQUENCY, and it saturates once
 *   the bag is guaranteed". First-party corroboration exists: a Nexon-hosted
 *   forum thread states that a meso drop rate familiar raises only the frequency
 *   of the meso bag, and that if a monster already drops a bag 100% of the time
 *   the familiar changes nothing. That is the saturating-multiplier shape this
 *   module models, stated on Nexon's own forum.
 *
 *   MAGNITUDE - "the base frequency is 0.60". NOT found. Every hit traces to the
 *   same two community documents already cited, or to aggregators
 *   (digitaltq.com, gamerempire.net) that restate them. maplestorywiki.net/w/Meso
 *   itself now returns HTTP 403 to a direct fetch, so even the community source
 *   could not be re-read first-hand this pass. No Nexon patch note, item text or
 *   support page states a number.
 *
 * CONSEQUENCE, and it is the whole reason this block exists: the SHAPE of
 * mesoBagChance() is sourced and the 67 that falls out of it is not. So the
 * engine keeps modelling the curve and stops printing 67 as a threshold the game
 * has. See DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED.
 */
export const MESO_BAG_SOURCING_ATTEMPT = {
  attemptedOn: "2026-09-13",
  mechanismCorroborated: true,
  mechanismSource:
    "forums.maplestory.nexon.net discussion 27641 - meso drop rate familiars raise meso bag FREQUENCY only, and do nothing once the bag already drops 100% of the time",
  magnitudeFound: false,
  magnitudeSearched: [
    "Nexon patch notes and news (v.170 through v.267 hits, none stating a base meso drop chance)",
    "forums.maplestory.nexon.net drop-rate formula threads (15714, 27641, 24742)",
    "maplestorywiki.net/w/Meso - HTTP 403 to direct fetch on this pass",
    "digitaltq.com and gamerempire.net - aggregators restating the same community figure",
  ],
  verdict: "unsourced-magnitude-sourced-mechanism" as const,
};

/**
 * THE AUDIT FINDING OF THIS FILE, kept in the name.
 *
 * This was `DROP_PCT_GUARANTEED_MESO_BAG = 67`: a bare number, no provenance
 * wrapper, printed into player-facing warning text as "the 67% meso-bag
 * breakpoint" — i.e. as a fact about the game. It is not one. It is
 * ceil((1/0.60 - 1) * 100), and 0.60 has no first-party source (see
 * MESO_BAG_SOURCING_ATTEMPT). A player closing "the last 17% to the breakpoint"
 * is grinding against a community guess with two significant figures.
 *
 * WHY NOT JUST DELETE IT: the mechanism it encodes IS corroborated — bag
 * frequency scales with drop rate and saturates. Deleting the breakpoint would
 * lose a real and important structural fact (drop % and meso % are not
 * independent below saturation) to fix a labelling problem. So the curve stays,
 * the name carries the provenance, and the warning text no longer calls it a
 * threshold.
 *
 * SENSITIVITY, so the reader can price the doubt themselves: the breakpoint is
 * 1/base - 1, which is steep. If the true base chance were 0.50 the breakpoint
 * is 100%; if 0.70, it is 43%. The 67 is not a rounding away from those.
 */
export const DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED = Math.ceil((1 / MESO_BAG_BASE_CHANCE_UNVERIFIED.value - 1) * 100);

/** The breakpoint under other plausible base chances, so no caller has to trust
 *  the single figure above. Exported because a range is the honest rendering of
 *  a number whose input is a guess. */
export const DROP_BREAKPOINT_SENSITIVITY: ReadonlyArray<{ baseChance: number; breakpointPct: number }> = [
  0.5, 0.55, 0.6, 0.65, 0.7,
].map((b) => ({ baseChance: b, breakpointPct: Math.ceil((1 / b - 1) * 100) }));

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
  return Math.min(1, MESO_BAG_BASE_CHANCE_UNVERIFIED.value * (1 + Math.max(0, dropPctForBags) / 100));
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

/**
 * Every genuinely MULTIPLICATIVE factor on Mesos Obtained a character can be
 * carrying, read out of NON_GEAR_SOURCES rather than retyped.
 *
 * THIS IS NOT THE WHOLE LIST, and the sentence that used to sit here said it was:
 * "the list scoreFarming() assembles as `mesoMults`, and the list a caller has to
 * divide back out to invert the stat window". It omits HEROIC_MESO_MULTIPLIER.
 * scoreFarming() opens with `[HEROIC_MESO_MULTIPLIER.value]` and pushes these on
 * top, and a caller who followed the old sentence literally would divide 764% by
 * 1.2 alone and land on 620% additive instead of 20% — a 6x error, which is the
 * exact failure this area of the file exists to prevent. No shipped figure was
 * ever wrong, because every in-repo call site prepends the Heroic factor; the
 * COMMENT was the thing that outran the code.
 *
 * To invert a stat window, use `FarmScore.mesoMultipliers` rather than this array
 * directly. It is derived from NON_GEAR_SOURCES because the alternative — writing
 * 1.2 wherever the Wealth Acquisition Potion is discussed — is a second source of
 * truth for a number the table above already holds, and the day the potion is
 * rebalanced only one of them changes.
 */
export const MESO_MULTIPLIER_SOURCES: ReadonlyArray<{ id: string; n: string; mult: number }> =
  NON_GEAR_SOURCES.value
    .filter((s): s is NonGearSource & { mesoMult: number } => typeof s.mesoMult === "number")
    .map((s) => ({ id: s.id, n: s.n, mult: s.mesoMult }));

/** The Wealth Acquisition Potion's 1.2x, by id. Null if the table stops carrying
 *  it — which is a fact worth failing on rather than substituting a literal. */
export const WEALTH_POTION_MESO_MULT: number | null =
  MESO_MULTIPLIER_SOURCES.find((m) => m.id === "wealthPotion")?.mult ?? null;

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
 * 3b. GRAND SACRED SYMBOLS — the three lines lib/symbols.ts declines to price
 *
 * lib/symbols.ts models force and stat, names these three effects as unmodelled,
 * and says in as many words that lib/farming.ts and lib/meso.ts are the files
 * that price them. This is that pricing.
 *
 * THE ANSWER IS THE DIMINISHING RETURN, not the headline percentage, and it cuts
 * in BOTH directions — which is why this section computes four numbers for the
 * same line instead of one:
 *
 *   1. FACE VALUE. "Mesos Obtained +5%" reads like +5% income. It is not. That
 *      is the error a player makes unaided, and it is the same class of error as
 *      the one just found in the cube ranking.
 *
 *   2. THE "DIVIDE BY THE STAT WINDOW" CORRECTION. At 764% Mesos Obtained,
 *      5/764 = 0.65%, so the line looks nearly worthless. This is the correction
 *      most guides reach for and in a HEROIC world it is ALSO wrong — wrong by
 *      about 5x, and wrong in the expensive direction, because it tells the
 *      player to ignore a line that is worth taking.
 *
 *   3. WHY 2 IS WRONG HERE. The 764% in the stat window is not an additive
 *      total. It is the OUTPUT of this repo's own sourced formula,
 *      floor((100 + additive) * 6) - 100, with Heroic's 6x already inside it.
 *      Inverting it gives additive = (764 + 100)/6 - 100 = 44%. A new additive
 *      point re-enters BEFORE the 6x, so it is worth far more than its share of
 *      the displayed number.
 *
 *   4. THE REAL SHAPE. Income is proportional to (100 + additive) x multiplier,
 *      so the relative gain from d additive points is exactly d / (100 +
 *      additive) — AND THE HEROIC 6x CANCELS COMPLETELY. That is the cleanest
 *      fact in this section: the 6x changes how much you earn and changes
 *      nothing about which meso line to take next.
 *
 * So the diminishing return is real, and its denominator is (100 + additive) =
 * 144 — not the displayed 764, and not 100. The line is worth about 3.5%, not
 * 5% and not 0.65%.
 * ========================================================================*/

/**
 * Meso % and drop % one Grand Sacred symbol grants, READ OUT OF the declaration
 * in lib/symbols.ts with ./meso's line parsers.
 *
 * The parse is not decoration. GRAND_SACRED_UNMODELLED_EFFECTS is prose
 * ("Mesos Obtained +5% per symbol") and these two parsers are the repo's single
 * reader for exactly that prose, already used on every gear potential line. If
 * lib/symbols.ts corrects 5 to 4 tomorrow this file moves with it; a retyped
 * literal would not, and nothing would fail to warn anybody.
 */
export const GRAND_SACRED_MESO_PCT_PER_SYMBOL = mesoPctFromLines(GRAND_SACRED_UNMODELLED_EFFECTS);
export const GRAND_SACRED_DROP_PCT_PER_SYMBOL = dropPctFromLines(GRAND_SACRED_UNMODELLED_EFFECTS);

/** Two areas, so two symbols. Taken from lib/symbols.ts's area list rather than
 *  written as 2 — a third Grand Sacred area would otherwise silently halve this
 *  entire valuation with no test failing. */
export const GRAND_SACRED_MAX_SYMBOLS = GRAND_SACRED_AREAS.length;

/**
 * NOT PRICED, and named here so the omission stays visible — the same courtesy
 * lib/symbols.ts extended to this file.
 *
 * The third line is EXP Obtained. This module converts things into mesos per
 * hour; EXP is not mesos, and no sourced exchange rate between them exists for a
 * Lv 245 character. Inventing one ("a level is worth N mesos") is exactly the
 * move the honesty ledger forbids. The line is real and is left unvalued.
 */
export const GRAND_SACRED_EXP_NOT_PRICED = {
  line: GRAND_SACRED_UNMODELLED_EFFECTS.find((l) => /exp/i.test(l)) ?? null,
  why: "No sourced meso value of EXP exists for this level band. A farming module that priced it would be inventing the exchange rate.",
} as const;

/**
 * Invert the stat window back to the additive total the game's formula took as
 * input.
 *
 *   displayed = floor((100 + additive) * product) - 100
 *   additive  = (displayed + 100) / product - 100
 *
 * The floor() is not inverted and cannot be: it destroys up to one point of
 * information. At these magnitudes (a 6x on a three-digit total) that is under a
 * tenth of an additive point and it is never the reason an answer is wrong —
 * whereas forgetting the multiplier entirely is a 6x error.
 *
 * WHY THE DEFAULT IS NOT ENOUGH, and why every caller must think about it:
 * `multipliers` defaults to the Heroic 6x alone because that is the only
 * multiplier a character always has. It is NOT the only one that can be up.
 * scoreFarming() builds [6, 1.2] whenever the Wealth Acquisition Potion is
 * active, and a stat window read while that potion is running was produced by
 * 7.2x, not 6x. Dividing 764% by 6 then gives 44% additive when the true figure
 * is 20% — and since the additive total is the DENOMINATOR of every relative
 * valuation downstream, that understates the next meso line by ~17%. The
 * default is a default, not an assumption the caller is allowed to inherit
 * silently: valueOfMesoPct() and valueGrandSacredForFarming() both report which
 * multipliers they divided out.
 */
export function additiveMesoPctFromDisplayed(
  displayedPct: number,
  multipliers: readonly number[] = [HEROIC_MESO_MULTIPLIER.value],
): number {
  const prod = multipliers.reduce((a, b) => a * b, 1);
  if (!(prod > 0)) return displayedPct;
  return (100 + displayedPct) / prod - 100;
}

export interface MesoLineValue {
  /** Additive points the line adds. */
  readonly addedAdditivePct: number;
  readonly displayedBefore: number;
  readonly displayedAfter: number;
  readonly additiveBefore: number;
  readonly additiveAfter: number;
  /** THE ANSWER: relative change in meso income, additive reading. */
  readonly relativeIncomeGain: number;
  /** The competing reading, in which the line lands on the displayed total
   *  AFTER the world multiplier instead of before it. Returned rather than
   *  hidden, because it is not separately sourced for symbols. */
  readonly relativeIncomeGainIfPostMultiplier: number;
  /** What the tooltip looks like it promises. */
  readonly naiveFaceValue: number;
  /** The "divide by the stat window" reading this section exists to correct. */
  readonly naiveDisplayedRatio: number;
  /** relativeIncomeGain / naiveFaceValue. 1 = no dilution, 0 = worthless. */
  readonly dilutionVsFaceValue: number;
  /** Additive points thrown away by the total additive cap. */
  readonly cappedAwayPct: number;
  /** The multiplicative factors that were divided back out of the stat window to
   *  recover `additiveBefore`. Returned rather than assumed, because the answer
   *  is wrong by the square of a missing entry: the 6x alone on a window read
   *  with the Wealth Acquisition Potion up recovers 44% additive where the truth
   *  is 20%, and the additive total is the denominator of `relativeIncomeGain`. */
  readonly multipliersDividedOut: readonly number[];
  /** One sentence naming those multipliers, for a caller that surfaces a list of
   *  assumptions rather than the whole struct. */
  readonly multiplierAssumption: string;
  readonly why: string;
}

/**
 * What d additive points of Mesos Obtained are worth, relatively, to a character
 * whose stat window reads displayedMesoPct.
 *
 * The model is one line — (100 + a + d) / (100 + a) — and the reason it is
 * wrapped in a struct this wide is that the bare ratio is indistinguishable from
 * three WRONG ratios a reader might expect it to be. Returning only the right
 * number teaches nobody why the other three are wrong, and this is precisely
 * where a player over- or under-values hours of grinding.
 *
 * `multipliers` is the third argument and not an internal constant because the
 * stat window is an OUTPUT of the game's formula and this function has to invert
 * it. Which factors were in that product is a fact about the moment the player
 * read the window, not about the character: the same 764% means 44% additive
 * with nothing running and 20% additive with the Wealth Acquisition Potion up.
 * A caller holding a FarmScore should pass `FarmScore.mesoMultipliers`, which is
 * the list scoreFarming() actually used for THAT score. Re-deriving it from
 * MESO_MULTIPLIER_SOURCES is not equivalent: that array is every multiplicative
 * source the model knows about, while the score was computed from the subset
 * selected by `chosen` and `includeTemporary`.
 */
export function valueOfMesoPct(
  displayedMesoPct: number,
  deltaAdditivePct: number,
  multipliers: readonly number[] = [HEROIC_MESO_MULTIPLIER.value],
): MesoLineValue {
  const cap = MESO_TOTAL_ADDITIVE_CAP_PCT.value;
  const a0raw = additiveMesoPctFromDisplayed(displayedMesoPct, multipliers);
  const a0 = Math.min(Math.max(a0raw, 0), cap);
  const a1 = Math.min(Math.max(a0raw + deltaAdditivePct, 0), cap);
  const cappedAway = Math.max(0, a0raw + deltaAdditivePct - cap) - Math.max(0, a0raw - cap);

  // Income is proportional to (100 + additive) x multiplier, so the multiplier
  // cancels. Written as the ratio of the two totals, NOT as delta / total:
  // delta/total silently drops the 100 and that is the second-most-common way to
  // get this wrong.
  const relative = (100 + a1) / (100 + a0) - 1;

  const postMult = (100 + displayedMesoPct + deltaAdditivePct) / (100 + displayedMesoPct) - 1;
  const face = deltaAdditivePct / 100;
  const naiveRatio = displayedMesoPct > 0 ? deltaAdditivePct / displayedMesoPct : face;
  // The SAME list on the way back out. Re-deriving the displayed figure through
  // a different product than the one it was inverted with would print a window
  // the player can never see.
  const after = mesosObtainedPct(a1, multipliers);

  const prod = multipliers.reduce((x, y) => x * y, 1);
  // "6x" reads better than "a product of 6", and "6 x 1.2 = 7.2x" is the case a
  // reader has to be able to spot, so the phrase is built rather than templated.
  const multPhrase =
    multipliers.length === 1
      ? `${multipliers[0]}x`
      : `${multipliers.join(" x ")} = ${Number(prod.toFixed(4))}x`;
  const multiplierAssumption =
    `The ${displayedMesoPct}% stat window was inverted by dividing out ${multPhrase}`
    + (multipliers.length === 1 && multipliers[0] === HEROIC_MESO_MULTIPLIER.value
      ? ` (the Heroic world multiplier alone). If the window was read with a MULTIPLICATIVE buff up — ${MESO_MULTIPLIER_SOURCES.map((m) => `${m.n}'s ${m.mult}x`).join(", ") || "none are modelled"} — the additive total behind it is lower than the ${a0.toFixed(1)}% used here and this line is worth MORE, not less.`
      : `, so the additive total behind it is ${a0.toFixed(1)}%. Any multiplicative buff that was running when the window was read and is missing from that list makes this figure an understatement.`);

  return {
    addedAdditivePct: deltaAdditivePct,
    displayedBefore: displayedMesoPct,
    displayedAfter: after,
    additiveBefore: a0,
    additiveAfter: a1,
    relativeIncomeGain: relative,
    relativeIncomeGainIfPostMultiplier: postMult,
    naiveFaceValue: face,
    naiveDisplayedRatio: naiveRatio,
    dilutionVsFaceValue: face > 0 ? relative / face : 0,
    cappedAwayPct: cappedAway,
    multipliersDividedOut: [...multipliers],
    multiplierAssumption,
    why:
      `+${deltaAdditivePct}% Mesos Obtained on a character reading ${displayedMesoPct}%: `
      + `the stat window already contains ${multPhrase}, so the additive total behind it is ${a0.toFixed(1)}%, `
      + `and the line moves the window to ${after}%. `
      + `Meso income rises ${(relative * 100).toFixed(2)}% — not the ${(face * 100).toFixed(0)}% the tooltip reads like, `
      + `and not the ${(naiveRatio * 100).toFixed(2)}% you get by dividing into the stat window, which understates it `
      + `${(relative / (naiveRatio || 1)).toFixed(1)}x because it forgets that an additive point re-enters BEFORE the ${multPhrase}. `
      + `The diminishing return is real and its denominator is 100 + ${a0.toFixed(0)} = ${(100 + a0).toFixed(0)}: the same line on a character with no meso bonuses at all would be worth ${(face * 100).toFixed(0)}%.`
      + (cappedAway > 0 ? ` ${cappedAway.toFixed(1)} of the ${deltaAdditivePct} points are past the ${cap}% additive cap and do nothing.` : ""),
  };
}

export interface DropLineValue {
  readonly addedDropPct: number;
  readonly dropBefore: number;
  readonly dropAfter: number;
  readonly bagChanceBefore: number;
  readonly bagChanceAfter: number;
  /** Relative meso income gain via meso-bag FREQUENCY only. Zero once bags are
   *  already guaranteed. */
  readonly relativeMesoIncomeGain: number;
  /** Relative item-drop gain. Never saturates the way the bag term does. */
  readonly relativeItemDropGain: number;
  readonly saturated: boolean;
  readonly why: string;
}

/**
 * What drop % is worth. Drop does TWO jobs and they diminish differently, which
 * is why one number cannot answer it:
 *
 *   - item drops scale with (100 + drop) forever;
 *   - meso-bag frequency scales the same way but SATURATES the moment a bag is
 *     guaranteed, after which more drop % is worth exactly zero mesos.
 *
 * Collapsing the two makes drop look either permanently good (wrong past
 * saturation) or permanently mediocre (wrong below it). The saturation POINT
 * rests on an unverified base chance — see
 * DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED — but the SHAPE is corroborated on
 * Nexon's own forum, and the shape is what this function reports.
 */
export function valueOfDropPct(dropPctForBags: number, deltaDropPct: number): DropLineValue {
  const d0 = Math.max(0, dropPctForBags);
  const d1 = Math.max(0, d0 + deltaDropPct);
  const b0 = mesoBagChance(d0);
  const b1 = mesoBagChance(d1);
  const bagGain = b0 > 0 ? b1 / b0 - 1 : 0;
  const itemGain = (100 + d1) / (100 + d0) - 1;
  const saturated = b0 >= 1 - 1e-12;
  return {
    addedDropPct: deltaDropPct,
    dropBefore: d0,
    dropAfter: d1,
    bagChanceBefore: b0,
    bagChanceAfter: b1,
    relativeMesoIncomeGain: bagGain,
    relativeItemDropGain: itemGain,
    saturated,
    why: saturated
      ? `Meso bags are already modelled as guaranteed at ${d0}% drop, so +${deltaDropPct}% adds nothing to MESO income. It still adds ${(itemGain * 100).toFixed(2)}% to item drops.`
      : `+${deltaDropPct}% drop takes modelled bag chance ${(b0 * 100).toFixed(1)}% -> ${(b1 * 100).toFixed(1)}%, worth ${(bagGain * 100).toFixed(2)}% more mesos, plus ${(itemGain * 100).toFixed(2)}% more item drops. Below saturation drop % is partly a MESO stat, which is why it is not comparable one-for-one with a meso line.`,
  };
}

export interface GrandSacredFarmValue {
  readonly symbols: number;
  readonly mesoPctAdded: number;
  readonly dropPctAdded: number;
  readonly meso: MesoLineValue;
  /** The MESO-side reading of the drop line, computed from bag-eligible drop.
   *  `relativeItemDropGain` on this struct is off the bag base and is therefore
   *  NOT the item answer — read `dropItems` for that. */
  readonly drop: DropLineValue;
  /** The ITEM-side reading, computed from the stat window's Item Drop Rate
   *  total. Identical to `drop` whenever the caller did not separate the two. */
  readonly dropItems: DropLineValue;
  /** The bag-eligible drop % the meso half was actually computed from. */
  readonly dropPctForMesoBagsUsed: number;
  /** False when `dropPctForMesoBagsUsed` is just the stat window's item total,
   *  i.e. when bag-eligible and item drop were conflated. The assumption is
   *  spelled out in `assumptions` either way; this is the machine-readable form
   *  so a UI can mark the figure rather than reprint a paragraph. */
  readonly bagDropSeparatedFromItemDrop: boolean;
  /** The bag-eligible-drop assumption as one sentence. Also inside
   *  `assumptions`; exposed by name so a caller quoting it need not index the
   *  array by position. */
  readonly bagDropAssumption: string;
  /** Which multiplicative factors were divided back out of the meso stat window.
   *  [6] normally, [6, 1.2] with the Wealth Acquisition Potion up. */
  readonly mesoMultipliersDividedOut: readonly number[];
  /** Multiplier on mesos per hour at an unchanged kill rate. */
  readonly mesoIncomeMultiplier: number;
  readonly mesoIncomeGainPct: number;
  readonly itemDropGainPct: number;
  /** Absolute mesos/hour, ONLY when the caller supplies a measured rate. There
   *  is no defensible default — see FARM_RATE in ./meso. */
  readonly mesosPerHourGain: number | null;
  readonly confidence: "modelled";
  readonly assumptions: readonly string[];
  readonly why: string;
}

export interface GrandSacredValueOptions {
  /** Mesos Obtained % as the stat window reads it. */
  readonly displayedMesoPct: number;
  /**
   * Item Drop Rate % as the stat window reads it. This is the ITEM total, and
   * the stat window has no other. It is used for the item-drop half.
   */
  readonly displayedDropPct: number;
  /**
   * Drop % that actually feeds MESO BAG frequency, which is not the same number.
   * `FarmScore.dropPctForMesoBags` is exactly this, and scoreFarming() keeps it
   * apart from `dropPctForItems` on purpose: familiar ITEM drop lines are not
   * established to raise meso-bag frequency — see
   * UNVERIFIED.FAMILIAR_ITEM_DROP_FEEDS_MESO_BAGS.
   *
   * Defaults to `displayedDropPct`, which CONFLATES the two. The default is
   * honest only because the conflation is then named in `assumptions`; a caller
   * holding a FarmScore has the real figure and should pass it.
   */
  readonly dropPctForMesoBags?: number;
  /**
   * The multiplicative factors already inside `displayedMesoPct`, for inverting
   * the stat window: [6] normally and [6, 1.2] with the Wealth Acquisition Potion
   * up. Pass `FarmScore.mesoMultipliers` — the list that score was actually built
   * from — rather than rebuilding it, which cannot reproduce the same subset.
   * Defaults to the Heroic 6x alone.
   */
  readonly mesoMultipliers?: readonly number[];
  /** Symbols equipped. Defaults to all of them. */
  readonly symbols?: number;
  /** The player's own measured mesos/hour, if they have measured one. */
  readonly mesosPerHour?: number | null;
}

/**
 * The headline: what equipping Grand Sacred symbols is worth to a farmer.
 *
 * The two effects COMPOUND rather than add, and that is not a rounding detail.
 * Meso income per kill is (mesos in the bag) x (chance a bag drops); the meso
 * line moves the first and the drop line moves the second, so the honest
 * combination is a product. Adding them understates the result — the one place
 * in this section where the naive move is too PESSIMISTIC rather than too
 * generous.
 */
export function valueGrandSacredForFarming(opts: GrandSacredValueOptions): GrandSacredFarmValue {
  const n = Math.max(0, Math.min(opts.symbols ?? GRAND_SACRED_MAX_SYMBOLS, GRAND_SACRED_MAX_SYMBOLS));
  const mesoAdd = GRAND_SACRED_MESO_PCT_PER_SYMBOL * n;
  const dropAdd = GRAND_SACRED_DROP_PCT_PER_SYMBOL * n;

  const mesoMults = opts.mesoMultipliers ?? [HEROIC_MESO_MULTIPLIER.value];
  // Whether the caller separated bag-eligible drop from the stat window's item
  // total. If they did not, the two are conflated and `assumptions` says so in
  // the same words scoreFarming() uses — it is not a rounding difference: a
  // familiar Item Drop Rate Boost line is worth up to +120% of the stat window
  // and is not established to feed a single meso bag.
  const bagDropSeparated = opts.dropPctForMesoBags !== undefined;
  const dropForBags = opts.dropPctForMesoBags ?? opts.displayedDropPct;
  // Built once and returned as its own field as well as going into
  // `assumptions`, so a caller that quotes one sentence does not have to index
  // into the array by position to find it.
  const bagDropAssumption = bagDropSeparated
    ? `Meso-bag frequency is computed from ${dropForBags}% bag-eligible drop, supplied separately from the ${opts.displayedDropPct}% Item Drop Rate stat window. That is the split scoreFarming() maintains as dropPctForMesoBags vs dropPctForItems.`
    : `The ${opts.displayedDropPct}% Item Drop Rate stat window is used AS the bag-eligible drop, because no separate figure was supplied. This CONFLATES two totals that scoreFarming() deliberately keeps apart as dropPctForMesoBags and dropPctForItems: familiar ITEM drop lines are not established to raise meso-bag frequency (UNVERIFIED.FAMILIAR_ITEM_DROP_FEEDS_MESO_BAGS), and a Legendary familiar's Item Drop Rate Boost line alone is +120% of item drop that may feed no bag at all. Where the window contains any such line the character is modelled as CLOSER TO BAG SATURATION THAN THEY ARE, which understates the meso half of this figure — marginal bag gain is (100+d1)/(100+d0) and falls as d0 rises, reaching exactly zero once the conflated total crosses saturation. Pass dropPctForMesoBags — FarmScore already computes it — to remove this assumption.`;

  const meso = valueOfMesoPct(opts.displayedMesoPct, mesoAdd, mesoMults);
  // Twice, from two different bases, because drop does two jobs off two
  // different totals. `drop` answers "how much more MESO" and must start from
  // the bag-eligible figure; `dropItems` answers "how much more LOOT" and must
  // start from the stat window's item total. When the caller does not separate
  // them these two calls are identical and nothing changes — which is exactly
  // why the conflation was invisible before.
  const drop = valueOfDropPct(dropForBags, dropAdd);
  const dropItems = valueOfDropPct(opts.displayedDropPct, dropAdd);

  const mult = (1 + meso.relativeIncomeGain) * (1 + drop.relativeMesoIncomeGain);
  const perHour =
    opts.mesosPerHour === null || opts.mesosPerHour === undefined ? null : opts.mesosPerHour * (mult - 1);

  return {
    symbols: n,
    mesoPctAdded: mesoAdd,
    dropPctAdded: dropAdd,
    meso,
    drop,
    dropItems,
    dropPctForMesoBagsUsed: dropForBags,
    bagDropSeparatedFromItemDrop: bagDropSeparated,
    bagDropAssumption,
    mesoMultipliersDividedOut: [...mesoMults],
    mesoIncomeMultiplier: mult,
    mesoIncomeGainPct: (mult - 1) * 100,
    itemDropGainPct: dropItems.relativeItemDropGain * 100,
    mesosPerHourGain: perHour,
    confidence: "modelled",
    assumptions: [
      "The symbol's Mesos Obtained line is ADDITIVE, entering the formula before the Heroic multiplier, like every other +X% Mesos Obtained source in NON_GEAR_SOURCES. NOT separately sourced for symbols: if it applied AFTER the multiplier the meso half would be worth "
        + (meso.relativeIncomeGainIfPostMultiplier * 100).toFixed(2)
        + "% instead of "
        + (meso.relativeIncomeGain * 100).toFixed(2)
        + "%. Both readings are returned so a caller can show the spread rather than pick one silently.",
      "The symbol line is NOT an equipment potential, so it is assumed not to consume MESO_GEAR_CAP_PCT (+100%). It IS counted against MESO_TOTAL_ADDITIVE_CAP_PCT (+300%), which is itself unverified.",
      meso.multiplierAssumption,
      "The drop line is assumed to raise meso-bag frequency as well as item drops, i.e. to behave like gear drop rather than like a familiar ITEM drop line. Unverified for symbols; if it behaves like the familiar line the meso half of the drop gain is zero.",
      // The assumption above is about the SYMBOL's own new line. This one is
      // about the drop the character already had, which is a different claim and
      // was previously made silently.
      bagDropAssumption,
      "Meso-bag saturation is modelled from an UNVERIFIED "
        + (MESO_BAG_BASE_CHANCE_UNVERIFIED.value * 100)
        + "% base bag chance. The SHAPE is corroborated; the magnitude is not.",
      "Kill rate is held constant. Symbols also grant force and stat, which raise kill rate; that gain belongs to lib/symbols.ts's model and is NOT included here, so this figure is a floor on the symbols' total farming value.",
    ],
    why:
      `${n} Grand Sacred symbol${n === 1 ? "" : "s"} = +${mesoAdd}% Mesos Obtained and +${dropAdd}% Item Drop Rate. `
      + `${meso.why} `
      // drop.why is one sentence about two jobs off ONE base, which is only
      // coherent while the two bases are the same number. Once the caller
      // separates them it would report the item gain off the bag base — the
      // exact conflation being fixed, just inverted — so the separated case gets
      // a sentence built from both structs instead.
      + (bagDropSeparated
        ? `+${dropAdd}% drop against ${dropForBags}% bag-eligible drop takes modelled bag chance ${(drop.bagChanceBefore * 100).toFixed(1)}% -> ${(drop.bagChanceAfter * 100).toFixed(1)}%, worth ${(drop.relativeMesoIncomeGain * 100).toFixed(2)}% more mesos; against the ${opts.displayedDropPct}% Item Drop Rate window it is worth ${(dropItems.relativeItemDropGain * 100).toFixed(2)}% more item drops. Those are two different denominators because familiar ITEM drop lines are not established to feed meso bags. `
        : `${drop.why} `)
      + `The two compound: meso income x${mult.toFixed(4)}, i.e. +${((mult - 1) * 100).toFixed(2)}% mesos per hour at the same kill rate. `
      + `Compare that with the +${mesoAdd + dropAdd}% face value across the two lines, and with the +${(meso.naiveDisplayedRatio * 100).toFixed(2)}% a stat-window division gives for the meso half alone.`,
  };
}

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
export const SPAWN_TICKS_PER_HOUR_UNVERIFIED = 3600 / (SPAWN_TICK_MS.value / 1000);

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
  return { ceiling: SPAWN_TICKS_PER_HOUR_UNVERIFIED * slots, confidence: "ranking-only" };
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
  /** Drop % that raises ITEM drops, after the (contested) total cap.
   *
   *  The counterpart of dropPctForMesoBags, and the pair is the point: bag
   *  frequency saturates and item drops do not, so one number cannot serve both.
   *  scoreFarming has always computed this and dropped it on the floor, which
   *  made it look like dead code rather than like a missing field. */
  readonly dropPctForItems: number;
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
  /**
   * The multiplicative factors THIS score was computed from, in the order they
   * were applied: [6] on Heroic, [6, 1.2] with the Wealth Acquisition Potion up.
   *
   * Exposed because two docblocks told callers to pass it and it did not exist —
   * `mesoMults` was a local. Re-deriving it from MESO_MULTIPLIER_SOURCES is not
   * the same thing: that array is every multiplicative source the model knows,
   * while this is the subset `chosen` and `includeTemporary` actually selected.
   * Inverting a stat window with the wrong subset is a silent multiple-of-six.
   */
  readonly mesoMultipliers: readonly number[];
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
  const toBreakpoint = Math.max(0, DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED - dropForBags);

  if (toBreakpoint > 0 && mesoAdditive > 0) {
    warnings.push(
      // The saturating shape is corroborated; the 67 is not. So the sentence
      // leads with the consequence the player can act on (meso % is being
      // multiplied by less than one) and labels the number, rather than naming
      // a "breakpoint" as though the game published one.
      `Drop rate is ${dropForBags}%, below the level at which a meso bag is guaranteed, so every point of Mesos Obtained is currently being multiplied by ${bag.toFixed(2)} — roughly ${((1 - bag) * 100).toFixed(0)}% of mobs drop no bag at all. Drop % is therefore partly a MESO stat until that saturates. The saturation point is modelled at ${DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED}% from an UNVERIFIED ${MESO_BAG_BASE_CHANCE_UNVERIFIED.value * 100}% base bag chance; on other plausible base chances it lands between ${Math.min(...DROP_BREAKPOINT_SENSITIVITY.map((s) => s.breakpointPct))}% and ${Math.max(...DROP_BREAKPOINT_SENSITIVITY.map((s) => s.breakpointPct))}%. Treat it as "add drop before adding more meso", not as a finish line.`,
    );
  }

  return {
    gearMesoPct: gear.mesoPct,
    gearDropPct: gear.dropPct,
    nonGearMesoPct: insideCapMeso + outsideCapMeso + consumableMesoCapped,
    nonGearDropPct: insideCapDrop + outsideCapDrop + consumableDropCapped + familiarItemBoost,
    dropPctForMesoBags: dropForBags,
    dropPctForItems: dropForItems,
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
    mesoMultipliers: [...mesoMults],
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
  const wantDropFirst = before.dropPctForMesoBags < DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED;
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
 * sources are large enough to reach meso-bag saturation on their own, saturation
 * is worth up to 1/base - 1 on all meso income (modelled at +67% from an
 * UNVERIFIED base chance — see DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED), and the
 * meso gear cap makes every point past +100% worthless. A player who cubes first
 * has paid for something they could have had free. The ORDER survives the
 * unverified constant even though the size of the step does not, which is why
 * this is still safe advice.
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

  const gap = Math.max(0, DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED - score.dropPctForMesoBags);
  if (gap > 0) {
    const need = Math.ceil(gap / 20);
    steps.push({
      order: order++,
      id: "drop-to-breakpoint",
      title: `Cube ${need} drop line${need > 1 ? "s" : ""} to reach meso-bag saturation (modelled at ${DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED}%)`,
      detail:
        `A mob's chance to drop a meso bag is multiplied by your drop rate and stops rising once the bag is guaranteed — that much is corroborated on Nexon's own forum. WHERE it stops is NOT: it is modelled at ${DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED}% from an unverified ${(MESO_BAG_BASE_CHANCE_UNVERIFIED.value * 100).toFixed(0)}% base chance, and on other plausible base chances it lands anywhere from ${Math.min(...DROP_BREAKPOINT_SENSITIVITY.map((s) => s.breakpointPct))}% to ${Math.max(...DROP_BREAKPOINT_SENSITIVITY.map((s) => s.breakpointPct))}%. What is solid is the direction: every point of Mesos Obtained you own is currently being multiplied by ${score.mesoBagChance.toFixed(2)}, so drop is worth more than meso until that reaches 1.00. You are ${gap}% short of the modelled point. ` +
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
      msg: `You have ${score.gearMesoPct}% Mesos Obtained on gear but only ${score.dropPctForMesoBags}% drop rate, so your meso % is being multiplied by ${score.mesoBagChance.toFixed(2)} — a share of mobs are dropping no bag for it to apply to.`,
      fix: `Add drop before adding any more meso. Drop and meso are not independent below saturation: drop % is partly a MESO stat until bags are guaranteed. Saturation is modelled at ${DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED}% (you are ${score.dropToBreakpoint}% short) from an UNVERIFIED ${(MESO_BAG_BASE_CHANCE_UNVERIFIED.value * 100).toFixed(0)}% base bag chance — treat it as a direction, not a finish line.`,
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
 * 14. THE ONE ENTRY POINT
 *
 * Everything above is a library. This is the single function lib/rules.ts should
 * call to get farming advice, and it is the only thing in this module the
 * orchestrator needs to know about.
 *
 * SHAPE CONTRACT: FarmingRec is deliberately a structural subset of
 * `Rec` in ./rules — same field names, same literal types for `pri` and `lv`,
 * same `Conf` for `conf`. It is declared here rather than imported so that this
 * module does not take a type dependency on a file it must not edit and cannot
 * see the final state of; the self-test below asserts the subset relationship
 * holds against the real Rec fields. A caller writes:
 *
 *     recs.push(...farmingRecs(ch, { displayedMesoPct, displayedDropPct }));
 *
 * and nothing else changes.
 *
 * WHY `dmg` AND `eff` ARE NEVER SET, even though Rec has them: `eff` is
 * documented in ./rules as "dmg per 1e9 mesos — the sort key". A farming rec has
 * no damage term at all, and the honest value of `dmg` for "move your Boss
 * Damage hyper points to Normal Damage" is not zero and is not a damage gain
 * either — it is a gain against a DIFFERENT target. Writing 0 would sort every
 * farming rec to the bottom; writing a mob-damage figure into a field the rest
 * of the app reads as boss damage would be worse. So both are left undefined and
 * `pri` carries the ordering, which is what `pri` is for.
 * ========================================================================*/

/** A recommendation row, shaped to drop straight into ./rules' `Rec[]`. */
export interface FarmingRec {
  pri: 1 | 2 | 3 | 4;
  lv: "hi" | "mid" | "ok";
  t: string;
  w: string;
  /** Mesos to realise it. 0 means free — and most of the best farming advice is
   *  free, which is the point of surfacing cost here. */
  cost?: number;
  conf?: Conf;
  /** Slot id, or "character" for account-wide advice, matching ./rules. */
  slot?: string;
}

export interface FarmingRecsOptions extends RecommendOptions {
  /** Mesos Obtained % as the stat window reads it. Without it the Grand Sacred
   *  valuation is skipped rather than guessed — there is no default stat window. */
  readonly displayedMesoPct?: number;
  /** Item Drop Rate % as the stat window reads it. */
  readonly displayedDropPct?: number;
  /** Bag-eligible drop %, when the caller knows it apart from the item total.
   *  See GrandSacredValueOptions.dropPctForMesoBags — omitting it conflates the
   *  two, and the Grand Sacred rec then carries that conflation in its text. */
  readonly dropPctForMesoBags?: number;
  /** Multiplicative factors already inside `displayedMesoPct`. Defaults to the
   *  Heroic 6x alone; pass [6, 1.2] for a window read with the Wealth
   *  Acquisition Potion up, which is what scoreFarming() would have built. */
  readonly mesoMultipliers?: readonly number[];
  /** Grand Sacred symbols equipped. Defaults to all of them. */
  readonly grandSacredSymbols?: number;
  /** The player's own measured mesos/hour, if they have one. */
  readonly mesosPerHour?: number | null;
}

function priFromSeverity(sev: "hi" | "mid" | "ok"): 1 | 2 | 3 | 4 {
  return sev === "hi" ? 1 : sev === "mid" ? 2 : 3;
}

/**
 * Every farming recommendation for this character, ordered.
 *
 * Composes the three engines already in this file — cold start, drift, and the
 * Grand Sacred valuation — rather than adding a fourth. The composition is the
 * only new judgement: what order the three kinds of finding go in, and that is
 * expressed entirely through `pri` so a reader can disagree with one comparison
 * instead of unpicking a blend.
 *
 * Deduplicated by title, because cold-start step 1 and the "drop below
 * saturation" drift finding are frequently the same advice reached two ways, and
 * the same sentence twice reads as a bug.
 */
export function farmingRecs(ch: CharacterWithLoadouts, opts: FarmingRecsOptions = {}): FarmingRec[] {
  const out: FarmingRec[] = [];
  const seen = new Set<string>();
  const push = (r: FarmingRec): void => {
    const key = r.t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };

  // 1. Grand Sacred symbols, when the caller has supplied a real stat window.
  //    Skipped rather than defaulted: this module has no business inventing a
  //    Mesos Obtained figure for a character it cannot see.
  if (opts.displayedMesoPct !== undefined && opts.displayedDropPct !== undefined) {
    const g = valueGrandSacredForFarming({
      displayedMesoPct: opts.displayedMesoPct,
      displayedDropPct: opts.displayedDropPct,
      dropPctForMesoBags: opts.dropPctForMesoBags,
      mesoMultipliers: opts.mesoMultipliers,
      symbols: opts.grandSacredSymbols,
      mesosPerHour: opts.mesosPerHour,
    });
    push({
      // Priority 3, not 1, and the reason is the honest one: +14% income is
      // real but Grand Sacred symbols are gated on Grandis progression that a
      // farming rec cannot accelerate. It is a reason to keep going, not a
      // thing to go and do this evening.
      pri: 3,
      lv: g.mesoIncomeGainPct >= 10 ? "hi" : g.mesoIncomeGainPct >= 4 ? "mid" : "ok",
      t: `Grand Sacred symbols: +${g.mesoIncomeGainPct.toFixed(1)}% mesos/hour`,
      // The two assumptions the player cannot see from the headline are carried
      // into the rec text, not left in a struct the UI may never render: which
      // multipliers were divided out of the stat window, and whether the drop
      // figure behind the meso half is bag-eligible drop or the item total.
      // A figure whose caveat lives somewhere the reader never looks is an
      // undeclared figure.
      w: `${g.why} ASSUMED: ${g.meso.multiplierAssumption} ${g.bagDropAssumption}`,
      cost: 0,
      conf: "modelled",
      slot: "character",
    });
  }

  // 2. The cold-start ladder. Order is mechanical, so it maps to pri directly.
  for (const step of coldStartPlan(ch, opts)) {
    const gain = step.gainDropPct + step.gainMesoPct;
    push({
      pri: step.order <= 2 ? 1 : step.order <= 4 ? 2 : 3,
      lv: gain >= 20 ? "hi" : gain >= 10 ? "mid" : "ok",
      t: step.title,
      w: step.detail,
      cost: step.costMesos ?? 0,
      // "ranking-only" is this module's word for what ./rules calls
      // "placeholder" — CONFIDENCE_VOCABULARY in ./rules lists exactly that
      // alias, so this mapping is the repo's own, not a new one.
      conf: step.confidence === "sourced" ? "sourced" : "placeholder",
      slot: "character",
    });
  }

  // 3. Drift, in both directions. These are things already wrong on the
  //    character, so a "hi" drift outranks a cold-start step of the same size.
  for (const d of detectDrift(ch, opts)) {
    push({
      pri: priFromSeverity(d.severity),
      lv: d.severity,
      t: d.msg,
      w: d.fix,
      cost: 0,
      conf: "modelled",
      slot: d.slot ?? "character",
    });
  }

  // Stable sort: pri, then severity, then insertion order. Array.prototype.sort
  // is stable in every engine this ships to, so the third key needs no index.
  const lvRank: Record<FarmingRec["lv"], number> = { hi: 0, mid: 1, ok: 2 };
  return out.sort((a, b) => a.pri - b.pri || lvRank[a.lv] - lvRank[b.lv]);
}

/* ==========================================================================
 * 15. PROVENANCE AND SELF-TEST
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
    ok: DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED === 67 && Math.abs(mesoBagChance(67) - 1) < 1e-9,
    detail: `0.6 x 1.67 = ${(0.6 * 1.67).toFixed(3)}; modelled saturation ${DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED}% — this check asserts the DERIVATION is intact, not that 0.6 is correct`,
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

  /* ---- Grand Sacred pricing, and the errors it exists to prevent ---- */

  out.push({
    name: "Grand Sacred percentages parse out of lib/symbols.ts, not out of this file",
    ok: GRAND_SACRED_MESO_PCT_PER_SYMBOL > 0 && GRAND_SACRED_DROP_PCT_PER_SYMBOL > 0 && GRAND_SACRED_MAX_SYMBOLS > 0,
    detail: `${GRAND_SACRED_MESO_PCT_PER_SYMBOL}% meso and ${GRAND_SACRED_DROP_PCT_PER_SYMBOL}% drop per symbol, ${GRAND_SACRED_MAX_SYMBOLS} symbols — read from GRAND_SACRED_UNMODELLED_EFFECTS. A zero here means lib/symbols.ts reworded the strings and this module went silently blind.`,
  });

  {
    // The inversion must round-trip through the module's own formula, or the
    // additive total every valuation below is built on is wrong.
    const a = additiveMesoPctFromDisplayed(764);
    out.push({
      name: "stat window inverts to the additive total it was built from",
      ok: Math.abs(a - 44) < 1e-9 && mesosObtainedPct(a, [HEROIC_MESO_MULTIPLIER.value]) === 764,
      detail: `764% displayed -> ${a}% additive -> ${mesosObtainedPct(a, [HEROIC_MESO_MULTIPLIER.value])}% displayed. (764 + 100)/6 - 100 = 44.`,
    });
  }

  {
    // THE FINDING. All three wrong answers are computed alongside the right one
    // so that a future edit cannot quietly collapse them into each other.
    const v = valueOfMesoPct(764, 5);
    const modelled = v.relativeIncomeGain * 100;
    const naive = v.naiveDisplayedRatio * 100;
    out.push({
      name: "+5% Mesos Obtained at 764% is neither 5% nor 0.65%",
      ok:
        Math.abs(v.naiveFaceValue * 100 - 5) < 1e-9 &&
        Math.abs(naive - 0.6545) < 0.001 &&
        Math.abs(modelled - 3.4722) < 0.001 &&
        modelled < v.naiveFaceValue * 100 &&
        modelled > naive * 5,
      detail: `face 5.00%, divide-by-stat-window ${naive.toFixed(4)}%, modelled ${modelled.toFixed(4)}%. The stat-window reading understates it ${(modelled / naive).toFixed(1)}x because 764% already contains the Heroic ${HEROIC_MESO_MULTIPLIER.value}x.`,
    });
  }

  {
    // THE DEFECT THIS SECTION WAS SHIPPED WITH: the same stat window inverts to
    // two different additive totals depending on what was running when the
    // player read it, and the old signature gave a caller no way to say which.
    // scoreFarming() builds [6, 1.2] whenever the Wealth Acquisition Potion is
    // up; 764% then means 20% additive, not 44%, and +5% is worth 4.17% rather
    // than 3.47% — a 17% understatement of a number a player spends hours on.
    const potion = WEALTH_POTION_MESO_MULT;
    const withPotion = valueOfMesoPct(764, 5, potion === null ? [HEROIC_MESO_MULTIPLIER.value] : [HEROIC_MESO_MULTIPLIER.value, potion]);
    const heroicOnly = valueOfMesoPct(764, 5);
    // The owner's real window with the potion up: (764 + 100) / 7.2 - 100 = 20
    // additive, so +5 takes 120 -> 125. Written as the closed form rather than a
    // captured output, so the test checks the model and not itself.
    const exact = 125 / 120 - 1;
    out.push({
      name: "the multipliers divided out of the stat window are the caller's to choose",
      ok:
        potion !== null &&
        Math.abs(withPotion.additiveBefore - 20) < 1e-6 &&
        Math.abs(withPotion.relativeIncomeGain - exact) < 1e-6 &&
        withPotion.relativeIncomeGain > heroicOnly.relativeIncomeGain &&
        withPotion.multipliersDividedOut.length === 2 &&
        withPotion.multiplierAssumption.includes("7.2x"),
      detail:
        potion === null
          ? "NON_GEAR_SOURCES no longer carries a wealthPotion mesoMult, so the multiplicative case cannot be exercised"
          : `764% / 6 = ${heroicOnly.additiveBefore.toFixed(1)}% additive -> +5% is worth ${(heroicOnly.relativeIncomeGain * 100).toFixed(4)}%; `
            + `764% / (6 x ${potion}) = ${withPotion.additiveBefore.toFixed(1)}% additive -> ${(withPotion.relativeIncomeGain * 100).toFixed(4)}% = (125/120)-1. `
            + `Ignoring the potion understates the line by ${((1 - heroicOnly.relativeIncomeGain / withPotion.relativeIncomeGain) * 100).toFixed(1)}%.`,
    });
  }

  {
    // The assumption has to be VISIBLE, not merely correct. Both halves of the
    // Grand Sacred valuation now name what they divided out and what drop figure
    // they used, in every case — including the default one, where the honest
    // report is "we assumed".
    const dflt = valueGrandSacredForFarming({ displayedMesoPct: 764, displayedDropPct: 50 });
    const told = valueGrandSacredForFarming({
      displayedMesoPct: 764,
      displayedDropPct: 170,
      dropPctForMesoBags: 50,
      mesoMultipliers: [HEROIC_MESO_MULTIPLIER.value, ...MESO_MULTIPLIER_SOURCES.map((m) => m.mult)],
    });
    // Same character, same 170% window, but now the caller does NOT separate —
    // which is what the old entry point did unconditionally. 170% is past
    // modelled saturation, so the conflation reports the symbol's drop line as
    // worth zero mesos when at 50% bag-eligible drop it is worth real income.
    const conflated = valueGrandSacredForFarming({
      displayedMesoPct: 764,
      displayedDropPct: 170,
      mesoMultipliers: [HEROIC_MESO_MULTIPLIER.value, ...MESO_MULTIPLIER_SOURCES.map((m) => m.mult)],
    });
    out.push({
      name: "the Grand Sacred valuation declares which multipliers and which drop total it used",
      ok:
        dflt.assumptions.some((a) => a.includes("6x")) &&
        dflt.assumptions.some((a) => a.includes("CONFLATES")) &&
        dflt.bagDropSeparatedFromItemDrop === false &&
        told.bagDropSeparatedFromItemDrop === true &&
        told.dropPctForMesoBagsUsed === 50 &&
        told.mesoMultipliersDividedOut.length === 2 &&
        // The meso half must come off bag-eligible drop and the item half off
        // the item total. Same +5% line, two different answers.
        told.drop.dropBefore === 50 &&
        told.dropItems.dropBefore === 170 &&
        told.itemDropGainPct < dflt.itemDropGainPct &&
        // The direction the assumption text claims, asserted rather than
        // asserted-about: feeding the item total into mesoBagChance() makes the
        // character look nearer saturation than they are, which UNDERSTATES the
        // drop line's meso value — here to exactly zero.
        conflated.drop.saturated && !told.drop.saturated &&
        conflated.mesoIncomeGainPct < told.mesoIncomeGainPct,
      detail:
        `default: conflated at ${dflt.dropPctForMesoBagsUsed}% and divided by ${dflt.mesoMultipliersDividedOut.join(" x ")}, both said out loud in ${dflt.assumptions.length} assumptions. `
        + `told: bags from ${told.dropPctForMesoBagsUsed}%, items from ${told.dropItems.dropBefore}% -> +${told.itemDropGainPct.toFixed(2)}% items vs +${dflt.itemDropGainPct.toFixed(2)}% when conflated. `
        + `Same 170% window conflated reports +${conflated.mesoIncomeGainPct.toFixed(3)}% mesos/hr against +${told.mesoIncomeGainPct.toFixed(3)}% when the 50% bag-eligible figure is supplied.`,
    });
  }

  {
    // The cleanest structural fact in the section: the world multiplier cancels
    // out of every relative comparison. If this ever fails, some caller has
    // started ranking meso lines differently in Heroic than in Interactive.
    const heroic = valueOfMesoPct(mesosObtainedPct(44, [HEROIC_MESO_MULTIPLIER.value]), 5).relativeIncomeGain;
    const plain = (100 + 49) / (100 + 44) - 1;
    out.push({
      name: "the Heroic multiplier cancels out of the relative gain",
      ok: Math.abs(heroic - plain) < 1e-9,
      detail: `both ${(heroic * 100).toFixed(4)}% — the 6x changes how much you earn and nothing about which meso line to take next`,
    });
  }

  {
    const diminishing = [500, 764, 1500].map((d) => valueOfMesoPct(d, 5).relativeIncomeGain);
    const atCap = valueOfMesoPct(mesosObtainedPct(MESO_TOTAL_ADDITIVE_CAP_PCT.value, [HEROIC_MESO_MULTIPLIER.value]), 5);
    out.push({
      name: "the meso line's value strictly diminishes and reaches exactly zero at the cap",
      ok:
        diminishing[0] > diminishing[1] &&
        diminishing[1] > diminishing[2] &&
        atCap.relativeIncomeGain === 0 &&
        atCap.cappedAwayPct === 5,
      detail: `${diminishing.map((d) => (d * 100).toFixed(2) + "%").join(" > ")}, and 0.00% once additive is at the ${MESO_TOTAL_ADDITIVE_CAP_PCT.value}% cap`,
    });
  }

  {
    // Drop does two jobs that diminish differently. Below saturation both move;
    // above it only item drops do. Collapsing them is the error guarded here.
    const below = valueOfDropPct(50, 10);
    const above = valueOfDropPct(DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED + 50, 10);
    out.push({
      name: "drop % stops being a meso stat at saturation but never stops being a drop stat",
      ok:
        !below.saturated && below.relativeMesoIncomeGain > 0 && below.relativeItemDropGain > 0 &&
        above.saturated && above.relativeMesoIncomeGain === 0 && above.relativeItemDropGain > 0,
      detail: `at 50%: +${(below.relativeMesoIncomeGain * 100).toFixed(2)}% mesos and +${(below.relativeItemDropGain * 100).toFixed(2)}% items; past saturation: +0% mesos, +${(above.relativeItemDropGain * 100).toFixed(2)}% items`,
    });
  }

  {
    // The two halves compound. Adding them would understate the answer, which is
    // the one naive move in this section that errs downwards.
    const g = valueGrandSacredForFarming({ displayedMesoPct: 764, displayedDropPct: 50 });
    const summed = g.meso.relativeIncomeGain + g.drop.relativeMesoIncomeGain;
    out.push({
      name: "meso and drop compound rather than add",
      ok: g.mesoIncomeMultiplier - 1 > summed && Math.abs(g.mesoIncomeGainPct - 14.074) < 0.01,
      detail: `product ${(g.mesoIncomeGainPct).toFixed(3)}% vs sum ${(summed * 100).toFixed(3)}% — mesos per bag and bags per kill are different factors of the same product`,
    });
  }

  out.push({
    name: "no absolute mesos/hour without a measured rate",
    ok: valueGrandSacredForFarming({ displayedMesoPct: 764, displayedDropPct: 50 }).mesosPerHourGain === null,
    detail: "FARM_RATE.mesosPerHour is a placeholder, so an absolute figure is only produced when the caller supplies one",
  });

  out.push({
    name: "EXP Obtained is named as unpriced rather than silently dropped",
    ok: GRAND_SACRED_EXP_NOT_PRICED.line !== null,
    detail: `${GRAND_SACRED_EXP_NOT_PRICED.line} — no sourced meso value of EXP exists, so it is left unvalued`,
  });

  /* ---- the audit's own findings, locked in ---- */

  out.push({
    name: "the unverified breakpoint carries its provenance in its name",
    ok:
      MESO_BAG_BASE_CHANCE_UNVERIFIED.placeholder === true &&
      UNVERIFIED.some((u) => u.name === "MESO_BAG_BASE_CHANCE_UNVERIFIED") &&
      UNVERIFIED.some((u) => u.name === "DROP_PCT_GUARANTEED_MESO_BAG_UNVERIFIED") &&
      MESO_BAG_SOURCING_ATTEMPT.magnitudeFound === false &&
      MESO_BAG_SOURCING_ATTEMPT.mechanismCorroborated === true,
    detail: "0.60 has a corroborated mechanism and an unsourced magnitude; both the constant and the figure derived from it now say so in their names and in the registry",
  });

  {
    // ENUMERATED, not whitelisted. The version this replaced asserted the same
    // sentence against a hardcoded list of four names and passed while
    // FARM_MAPS — placeholder: true, unregistered — sat two screens away. A test
    // that can only fail if someone edits the test is not a guard; it is a note
    // that stops the next reader looking.
    //
    // ONE direction only, and on purpose. An unregistered placeholder renders as
    // clean in a provenance panel, which is the harm. The converse — a registry
    // entry naming something that is not an export — is NOT checked, because
    // most entries here deliberately name a doubt rather than a constant
    // (BADGE_CAN_ROLL_DROP_MESO, FAMILIAR_ITEM_DROP_FEEDS_MESO_BAGS,
    // MAP_MOB_HP). A test that flagged those would be asserting a convention
    // this file does not follow.
    const placeholders = Object.entries(FARMING_MODULE as Readonly<Record<string, unknown>>)
      .filter(([, v]) => {
        if (typeof v !== "object" || v === null) return false;
        // Structural, not `instanceof Sourced`: Sourced<T> is an interface and
        // has no runtime identity. Every constant in this file that carries
        // provenance carries these two fields.
        const s = v as { placeholder?: unknown; source?: unknown };
        return s.placeholder === true && typeof s.source === "string";
      })
      .map(([name]) => name);
    const listed = new Set(farmingUnverified().flatMap((u) => u.name.split(" / ")));
    const unregistered = placeholders.filter((n) => !listed.has(n));
    out.push({
      name: "every placeholder constant is listed by farmingUnverified()",
      // placeholders.length > 0 is not padding. If the namespace ever fails to
      // enumerate — a bundler transform, a future module format — the filter
      // returns [] and an empty list satisfies `every`. The test would then pass
      // by construction again, silently, which is the exact bug being fixed.
      ok: placeholders.length > 0 && unregistered.length === 0,
      detail:
        placeholders.length === 0
          ? "FOUND NO PLACEHOLDER EXPORTS AT ALL — the module namespace did not enumerate, so this test proved nothing"
          : `${placeholders.length} exports carry placeholder: true (${placeholders.join(", ")}); `
            + (unregistered.length === 0 ? "all are registered" : `UNREGISTERED: ${unregistered.join(", ")}`),
    });
  }

  /* ---- the entry point's shape contract ---- */

  {
    const ch: CharacterWithLoadouts = {
      name: "Archerroni", cls: "Bow Master", main: "dex", lvl: 245, cp: 0,
      stats: { main: 20790, att: 1497, crit: 0, critdmg: 0, boss: 159, ied: 92.9, hp: 0, arcane: 1070, starforce: 188 },
      items: {
        ring1: { name: "Silver Blossom Ring", lvl: 110, star: 0, pot: "legendary", sup: 0, p: ["Mesos Obtained +20%"], f: [] },
        earring: { name: "Sup Gollux Earring", lvl: 150, star: 0, pot: "legendary", sup: 0, p: ["Item Drop Rate +20%"], f: [] },
      },
      loadouts: [],
    };
    const recs = farmingRecs(ch, { displayedMesoPct: 764, displayedDropPct: 50 });
    const shapeOk = recs.every(
      (r) =>
        [1, 2, 3, 4].includes(r.pri) &&
        ["hi", "mid", "ok"].includes(r.lv) &&
        typeof r.t === "string" && r.t.length > 0 &&
        typeof r.w === "string" && r.w.length > 0 &&
        (r.conf === undefined || ["sourced", "modelled", "placeholder"].includes(r.conf)),
    );
    // dmg and eff are absent from FarmingRec entirely, so the compiler already
    // guarantees they are never set. Asserted over the runtime object too,
    // because a later edit could widen the interface without anyone noticing
    // that it starts feeding ./rules' damage sort key with a farming number.
    const noDamageTerm = recs.every((r) => {
      const wide = r as unknown as Record<string, unknown>;
      return wide.dmg === undefined && wide.eff === undefined;
    });
    const sorted = recs.every((r, i) => i === 0 || recs[i - 1].pri <= r.pri);
    out.push({
      name: "farmingRecs returns Rec-shaped rows, sorted, with no invented damage term",
      ok: recs.length > 0 && shapeOk && sorted && noDamageTerm,
      detail: `${recs.length} recs; pri in 1..4, lv in hi/mid/ok, conf in the ./rules vocabulary, dmg and eff deliberately absent`,
    });
    out.push({
      name: "farmingRecs deduplicates advice reached two ways",
      ok: new Set(recs.map((r) => r.t.toLowerCase())).size === recs.length,
      detail: "cold start and drift frequently produce the same sentence; the same sentence twice reads as a bug",
    });
  }

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
