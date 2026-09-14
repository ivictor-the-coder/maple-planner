// Recommendation engine. Everything the planner advises comes from here.
// Rules are current as of GMS v.271 (2026-09-09).
//
// There are two layers in this file and the split matters:
//
//   1. the RULES layer — what to do and why, in words. Unchanged in substance.
//   2. the PRICING layer — a number attached to a rec: expected final-damage
//      gain, expected meso cost, and damage per billion mesos, which is the
//      sort key. Priority is no longer authored; it is read off that ranking.
//
// The rules layer has to keep working when the pricing layer cannot price
// something, so pricing is strictly additive and all-or-nothing per rec: if the
// damage model returns null, the rec loses dmg/cost/eff/conf together and falls
// back to its authored priority. `__setDamageModelEnabled(false)` turns the
// whole pricing layer off, and `__selfTest()` asserts that doing so reproduces
// the pre-pricing output exactly.
//
// FILE LAYOUT NOTE: the change brief describes lib/damage.ts and lib/costs.ts.
// This session owns only lib/rules.ts, so the damage model and the cost
// constants live here behind exactly the interfaces those modules were
// specified to export (relGain / DmgEnv / ENEMY_DEF_* / SOURCED / PLACEHOLDER_*).
// Splitting them out later is a cut-and-paste plus a re-export; no call site
// needs to change, and nothing in this file reaches back into the UI.
//
// ---------------------------------------------------------------------------
// THE ONE CONFIDENCE VOCABULARY (this file is the authority; see Conf below)
// ---------------------------------------------------------------------------
// Four modules grew four ways of saying "how much of this is real":
//
//   rules.Conf          'sourced' | 'modelled' | 'placeholder'
//   starforce           Provenance: 'nexon-primary' | 'community-cross-checked'
//                       | 'community-single' | 'placeholder', plus a list of
//                       named UnverifiedConstants attached to every result
//   cubes / farming     Confidence: 'absolute' | 'ranking-only'
//                       (farming also uses 'needs-measurement')
//
// One badge cannot render four. `Conf` WINS, because it is the only one whose
// values map onto a decision a player actually makes: budget against it /
// trust the ordering but not the magnitude / do not trust the number. Every
// other vocabulary enters through an explicit, total mapping —
// confFromProvenance() and confFromUnverified() below — so nothing is ever
// silently upgraded, and the mapping is one function to argue with rather than
// a dozen call sites. Rec.conf is the ONLY confidence field the UI reads.
//
// ---------------------------------------------------------------------------
// MODULE CYCLE, PROVEN RATHER THAN ASSUMED
// ---------------------------------------------------------------------------
// lib/farming.ts imports SLOTS from this file and reads it at MODULE SCOPE
// (farming.ts:210). A plain `import { isDeadLineFor } from "./farming"` here
// therefore makes farming's body run while this module's body is suspended on
// that import, with `SLOTS` still in its temporal dead zone. That is measured,
// not assumed: with the static import in place `next build` dies with
//   ReferenceError: Cannot access 'g' before initialization
//   at module evaluation (lib/farming.ts:210:57)
// lib/starforce.ts imports NOTHING, so it is imported the ordinary way. The
// farming adoption goes through the deferred seam at __useObjectiveDeadLine().

import type { RosterChar } from "./legion";
// The damage model lives in ./damage and is the authority on its constants AND
// on its formula. This file used to re-derive both, which is how two live models
// came to disagree; anything the model owns is imported, never restated.
// dmgIndex() below is now a thin call into damageBreakdown() through the one
// printed-percent -> fraction adapter, so the app has exactly one crit term, one
// damage term and one defence term.
import {
  CLASS_CONSTANTS,
  DAMAGE_RANGE_VALIDATION,
  DEFAULT_PDR,
  classConstantsFor,
  classKey,
  damageBreakdown,
  fractionalInputsFromCharacter,
} from "./damage";
// The class roster is the authority on which stat a class scales on. An account
// creates characters out of roster entries that carry only a class NAME, so the
// main stat has to come from somewhere, and restating a 53-row table here is
// exactly the duplication that once put two disagreeing models in this app.
import { findClass } from "./classes";
import type { FarmObjective } from "./farming";
// Set membership has to reach the superior-gear advice below, or the app tells a
// player to break a set to escape a 15-star cap. lib/sets.ts already models this
// and was imported by nobody.
import { resolveSet, activeSets, describeEffects, isEmptyEffects } from "./sets";
import {
  NO_EVENTS,
  STAR_ROWS_MODE1,
  UNVERIFIED_LABEL,
  costPerAttempt,
  effectiveRates,
  isVerified,
  modesAvailableAt,
  rowFor,
  traceRecoveryStar as sfTraceRecoveryStar,
  type EnhancementMode,
  type Provenance,
  type UnverifiedConstant,
} from "./starforce";
import {
  arcaneFlatMainStatFromLevels,
  arcaneFlatMainStatFromPower,
  hasArcaneLevels,
  type SymbolState,
} from "./symbols";
import guideGraphRaw from "@/data/guide-graph.json";

export type MainStat = "dex" | "str" | "int" | "luk";
export type Tier = "none" | "rare" | "epic" | "unique" | "legendary";
export type PotKind = "stat" | "atk" | "crit" | "no";

export interface Item {
  name: string;
  lvl: number;
  star: number;
  pot: Tier;
  sup: 0 | 1;
  p: string[];
  f: string[];
  /** From the item database, when the item was picked rather than typed. */
  itemId?: number;
  /** Boss-drop gear is flame advantaged: tier 4 minimum, up to tier 7. */
  bossDrop?: boolean;
  /**
   * The importer could not READ this item's bonus stats — as distinct from
   * reading them and finding none.
   *
   * Set when a screenshot showed the item tooltip but not the Enhance > Bonus
   * Stats panel, where the rows are actually stated. The aggregate stat block
   * on a tooltip sums base, star force and bonus stats and separates them only
   * by COLOUR, so a reading taken from it is not a reading.
   *
   * WITHOUT THIS FIELD the engine saw an empty `f` and said "No flame. Roll
   * one" — which on a Pink Holy Cup carrying All Stats +5% was advice to pay
   * 3,000,000 mesos to destroy it. The importer has been emitting this signal
   * on the wire since the panel reader landed; nothing consumed it, so an
   * admission of ignorance arrived as a confident zero.
   *
   * `f: []` with this flag means UNKNOWN. `f: []` without it means NONE.
   */
  fUnknown?: true;
  /** Icon cropped out of an imported screenshot, as a data URL. Used when the
   *  item database has no match — an imported item still shows its real sprite. */
  icon?: string;
  /** Item database subcategory, e.g. "Arrow Fletching" or "Shield". This is what
   *  decides star forceability in the secondary slot; the slot cannot. */
  sub?: string;
  // MapleStory has three independent enhancement systems and an item can opt
  // out of any combination of them — the tooltip spells it out, so read it
  // rather than inferring from the slot. A Glory Guard ring takes no stars
  // while every other ring does; a pocket item takes flames but no potential.
  /** "Star Force ... Can't Enhance". */
  noSf?: boolean;
  /** "... Bonus Stats Can't Enhance". */
  noFl?: boolean;
  /** "Potential : Can't Enhance". */
  noPot?: boolean;
}

/** The nine figures the character sheet has carried since v1, every one of them
 *  required and every one of them a number. Deliberately still exactly nine:
 *  lib/portable.ts enumerates `keyof Stats` as the share-link wire format
 *  (STAT_KEYS, portable.ts:234) and indexes into it expecting a number, so a
 *  tenth OPTIONAL key here is a type error in a file this change does not own,
 *  and a tenth REQUIRED key is a wire-format break. The two new readings live in
 *  DamageReadings below and reach the character through CharacterStats. */
export interface Stats {
  main: number;
  att: number;
  crit: number;
  critdmg: number;
  boss: number;
  ied: number;
  hp: number;
  arcane: number;
  starforce: number;
}

/**
 * The two figures the stat window prints that the model had nowhere to store.
 *
 * Both are OPTIONAL and absence is meaningful: it means "this character has no
 * reading", which is a different claim from "this character reads zero" and is
 * the difference between an honest default and an invented measurement. Every
 * reader in this file goes through `?? DEFAULT_DAMAGE_PCT` / `??
 * DEFAULT_FINAL_DAMAGE_PCT` and names the assumption where a player can see it.
 *
 * A character decoded from a SHARE LINK arrives without either field, because
 * the wire format predates them (see Stats above). That is correct behaviour,
 * not a gap: a share link carries what the sender recorded, and the sender's
 * codec never carried these.
 */
export interface DamageReadings {
  /**
   * PRINTED PERCENT. The stat window's "DAMAGE" line: 73 means 73%.
   *
   * The model had nowhere to put this and assumed zero — see ASSUMED_DAMAGE_PCT,
   * which is still the default and still biases every boss-damage rec HIGH. The
   * game does print it (this file used to say it does not; the live character
   * reads 73.00%, see DAMAGE_RANGE_VALIDATION), so the honest fix is a field,
   * not a better guess.
   */
  damagePct?: number;
  /**
   * PRINTED PERCENT, read exactly as the stat window prints it.
   *
   * "FINAL DAMAGE 115.79%" means a MULTIPLIER OF 2.1579, not 1.1579 —
   * DAMAGE_RANGE_VALIDATION.finalDamageReading is the authority and misreading
   * it halves every range. Store 115.79 here; the adapter converts.
   *
   * Absent means DEFAULT_FINAL_DAMAGE_PCT, which is 0 and which is a pure
   * common factor — see that constant for the direction of the bias.
   */
  finalDamagePct?: number;
  /**
   * PRINTED. Flat SECONDARY stat, as the stat window shows it: STR for a Bow
   * Master, DEX for a Night Lord, and so on.
   *
   * It joins the readings rather than Stats for the same reason the other two
   * did — lib/portable.ts enumerates keyof Stats as the share-link wire format,
   * so a tenth required key changes the codec for every link ever shared.
   *
   * WHY IT EARNS A FIELD. The range formula counts it at 1x against main
   * stat's 4x, which sounds ignorable and is not: the reference character's
   * 2,609 STR is 3.0% of their printed Damage Range, and with DAMAGE % and
   * FINAL DAMAGE % now applied this is the entire remaining gap between what
   * the app prints and what the game prints. A model that reproduces the stat
   * window to 3% and stops has given up the last thing that made it checkable.
   *
   * Absent means the sheet has no value, which the adapter reports out loud.
   * It does NOT mean zero — a class whose secondary stat genuinely contributes
   * nothing still reads a number in its window.
   */
  secondary?: number;
}

/** What a Character's `stats` actually is: the nine printed figures plus the
 *  optional readings. Anything that only needs the nine keeps taking `Stats`. */
export type CharacterStats = Stats & DamageReadings;

/** Stable identity for a character inside an Account. Opaque: never parsed,
 *  never derived from the name, so a rename cannot break a reference. */
export type CharacterId = string;

export interface Character {
  /** Stable identity — see CharacterId. Optional so that every Character
   *  literal that predates accounts still typechecks; `Account` always fills it
   *  in, and `activeCharacter()` never hands out one without it. */
  id?: CharacterId;
  name: string;
  cls: string;
  main: MainStat;
  lvl: number;
  cp: number;
  stats: CharacterStats;
  items: Record<string, Item>;
  /**
   * Per-area symbol LEVELS, not a derived total.
   *
   * Deliberately NOT a tenth key on Stats: lib/portable.ts enumerates
   * keyof Stats as the share-link wire format, so anything added there
   * changes the codec. `stats.arcane` stays as the stat-window reading and
   * becomes a checksum against these rather than a substitute for them.
   *
   * A total does not invert to a spread. Arcane Power 1,070 is 95 levels
   * across six symbols, and thousands of distributions sum to 95 with
   * different answers to "level which one next" - which is the whole
   * question the symbols model exists to answer. Optional, and absent means
   * absent: the advice says to enter them rather than guessing a split.
   */
  symbols?: SymbolState;
  /**
   * Every character on the account, read from the Switch Character window.
   *
   * @deprecated The ACCOUNT owns the roster now — it is account-wide data that
   * happened to be stored on whichever character was active. `Account.roster`
   * is the authority and `setRoster()` is the only writer. This field survives
   * as a read-side projection: `activeCharacter()` fills it from the account so
   * that UI written against `ch.roster` keeps rendering, and the legacy
   * character `Store` hoists it back on save. New code must not write it.
   */
  roster?: RosterChar[];
}

export interface SlotDef {
  id: string;
  n: string;
  c: number;
  r: number;
  pot: PotKind;
  sf: boolean;
  fl: boolean;
}

/** How much of a rec's number is real. THE confidence vocabulary — see the
 *  header. Everything else in lib/ funnels into these three through
 *  confFromProvenance() / confFromUnverified().
 *  - `sourced`     every input is cited, cost included. Budget against it.
 *  - `modelled`    the meso cost is cited; the damage is derived through a
 *                  documented model whose assumptions are named in this file.
 *  - `placeholder` a load-bearing input — usually the COST — rests on an
 *                  uncited constant. Trust the ordering, not the magnitude.
 *                  This is the one a player must not budget against, which is
 *                  why it, and only it, gets a warning appended to `w`. */
export type Conf = "sourced" | "modelled" | "placeholder";

/** The mapping, as data, so the UI can render a legend without re-deriving it
 *  and so a reviewer can disagree with one table instead of twelve literals. */
export const CONFIDENCE_VOCABULARY: ReadonlyArray<{
  conf: Conf;
  badge: string;
  meaning: string;
  /** What the other modules call the same thing. */
  aliases: readonly string[];
}> = [
  {
    conf: "sourced",
    badge: "Sourced",
    meaning: "Every input is cited. Safe to budget against.",
    aliases: ["starforce: nexon-primary", "starforce: community-cross-checked", "cubes/farming: absolute"],
  },
  {
    conf: "modelled",
    badge: "Modelled",
    meaning: "The cost is cited; the damage comes from a documented model.",
    aliases: ["farming: sourced (derived)", "cubes: absolute with a derived damage term"],
  },
  {
    conf: "placeholder",
    badge: "Estimate",
    meaning: "A load-bearing constant is uncited. Trust the order, not the size.",
    aliases: ["starforce: community-single", "starforce: placeholder", "cubes/farming: ranking-only", "farming: needs-measurement"],
  },
];

/** starforce.Provenance -> Conf. Total, and deliberately pessimistic:
 *  `community-single` is exactly the state the star force meso curve is in, and
 *  a single community source is not something to hand a player as a budget. */
export function confFromProvenance(p: Provenance): Conf {
  return isVerified(p) ? "sourced" : p === "community-single" ? "placeholder" : "placeholder";
}

/** starforce's per-result `unverified[]` -> Conf. An empty list means every
 *  constant the result touched was verified. */
export function confFromUnverified(list: readonly UnverifiedConstant[]): Conf {
  return list.length === 0 ? "sourced" : "placeholder";
}

/** cubes / farming's `Confidence` -> Conf. Accepts farming's third value too,
 *  so the union can widen there without this becoming a partial function. */
export function confFromRankingOnly(c: "absolute" | "ranking-only" | "needs-measurement"): Conf {
  return c === "absolute" ? "sourced" : "placeholder";
}

export interface Rec {
  // pri / lv / t / w are load-bearing for components/Planner.tsx and keep their
  // exact shape: PRI_LABEL[r.pri] indexes ['', 'NOW', 'SOON', 'LATER', 'DONE'],
  // so pri must never leave 1..4.
  pri: 1 | 2 | 3 | 4;
  lv: "hi" | "mid" | "ok";
  t: string;
  w: string;
  /** Expected final-damage gain as a fraction. 0.021 = +2.1%. */
  dmg?: number;
  /** Expected mesos to realise it. 0 means free. */
  cost?: number;
  /** dmg per 1e9 mesos — the sort key. Infinity for a free upgrade. */
  eff?: number;
  conf?: Conf;
  /** Slot id this rec came from. Stamped by planAdvice(); "character" for
   *  account-wide advice. */
  slot?: string;
  /** This rec spends on THIS item: cubes, flames, star force. Set at the call
   *  site so the ladder check below can find them without matching on strings. */
  invest?: true;
  /** Set when the plan has told the player to replace the item this rec spends
   *  on. Two consequences: the warning names what does not survive the swap,
   *  and assignPri() will not promote the rec on damage alone. */
  replaced?: true;
}

/* ---------- slots, laid out like the in-game equip window ---------- */
export const SLOTS: SlotDef[] = [
  { id: "ring1", n: "Ring 1", c: 1, r: 1, pot: "stat", sf: true, fl: false },
  { id: "ring2", n: "Ring 2", c: 1, r: 2, pot: "stat", sf: true, fl: false },
  { id: "ring3", n: "Ring 3", c: 1, r: 3, pot: "stat", sf: true, fl: false },
  { id: "ring4", n: "Ring 4", c: 1, r: 4, pot: "stat", sf: true, fl: false },
  { id: "pocket", n: "Pocket", c: 1, r: 5, pot: "stat", sf: false, fl: true },
  { id: "pendant1", n: "Pendant 1", c: 2, r: 2, pot: "stat", sf: true, fl: true },
  { id: "pendant2", n: "Pendant 2", c: 2, r: 3, pot: "stat", sf: true, fl: true },
  { id: "weapon", n: "Weapon", c: 2, r: 4, pot: "atk", sf: true, fl: true },
  { id: "belt", n: "Belt", c: 2, r: 5, pot: "stat", sf: true, fl: true },
  { id: "hat", n: "Hat", c: 3, r: 1, pot: "stat", sf: true, fl: true },
  { id: "face", n: "Face", c: 3, r: 2, pot: "stat", sf: true, fl: true },
  { id: "eye", n: "Eye", c: 3, r: 3, pot: "stat", sf: true, fl: true },
  { id: "top", n: "Top", c: 3, r: 4, pot: "stat", sf: true, fl: true },
  { id: "bottom", n: "Bottom", c: 3, r: 5, pot: "stat", sf: true, fl: true },
  { id: "shoes", n: "Shoes", c: 3, r: 6, pot: "stat", sf: true, fl: true },
  { id: "earring", n: "Earring", c: 4, r: 3, pot: "stat", sf: true, fl: true },
  { id: "shoulder", n: "Shoulder", c: 4, r: 4, pot: "stat", sf: true, fl: false },
  { id: "gloves", n: "Gloves", c: 4, r: 5, pot: "crit", sf: true, fl: true },
  { id: "cape", n: "Cape", c: 4, r: 6, pot: "stat", sf: true, fl: true },
  { id: "emblem", n: "Emblem", c: 5, r: 1, pot: "atk", sf: false, fl: false },
  { id: "badge", n: "Badge", c: 5, r: 2, pot: "no", sf: false, fl: false },
  { id: "medal", n: "Medal", c: 5, r: 3, pot: "no", sf: false, fl: false },
  { id: "secondary", n: "Secondary", c: 5, r: 4, pot: "atk", sf: true, fl: true },
  { id: "heart", n: "Heart", c: 5, r: 5, pot: "stat", sf: false, fl: false },
  { id: "android", n: "Android", c: 5, r: 6, pot: "no", sf: false, fl: false },
];

/**
 * TRANSFER HAMMER, sourced from Nexon's own Item Enhancement guide on
 * 2026-09-13, after this repo spent the whole project refusing to state it:
 *
 *   "The Level Requirement of the receiving item must be 1-10 levels higher
 *    than the Level Requirement of the extracted item, or 1-20 levels if the
 *    extracting item is Lv. 119 or below."
 *   "You can transfer stats of a Lv. 110 item to an item with a level as high
 *    as Lv. 130, but not to a Lv. 140 item."
 *
 * The remembered figure was a flat ten levels. It is ten ABOVE Lv 119 and
 * twenty at or below it, and the worked example is what makes that concrete.
 *
 * WHAT CARRIES, and this is the part that was actively wrong in the advice:
 *   "...transfer the stat bonuses from Star Force Enhancement, Potentials,
 *    Bonus Potentials and Soul Weapon enhancements from a lower-level item to
 *    a higher-level item."
 * POTENTIAL TRANSFERS. This file told players the opposite - "potential does
 * not transfer, so do not over-cube what you will replace" - which is advice
 * to leave a cheap upgrade on the table. Bonus Stats (flames) are the
 * conspicuous omission from that list and are believed lost, but the guide
 * does not say so outright, so the copy says believed, not lost.
 */
export const TRANSFER_HAMMER = {
  /** Max level gap when the item being extracted FROM is Lv 120 or above. */
  spanAboveLv119: 10,
  /** Max level gap when the item being extracted FROM is Lv 119 or below. */
  spanAtOrBelowLv119: 20,
  lowLevelThreshold: 119,
  carries: ["Star Force", "Potential", "Bonus Potential", "Soul Weapon"] as const,
  source: "Nexon Maple Guides, Item Enhancement, read 2026-09-13",
  url: "https://www.nexon.com/maplestory/game/maple-guides/all/5897/item-enhancement",
} as const;

/** Whether the investment in an item can follow it up to the next rung, and in
 *  one sentence, why or why not. Empty when there is nothing to say. */
function nextTierTransferNote(fromLvl: number, toLvl: number, toName: string): string {
  const ceil = transferHammerCeiling(fromLvl);
  if (ceil === null || !(toLvl > 0)) return "";
  return ceil >= toLvl
    ? ` — a Transfer Hammer reaches Lv. ${ceil} from Lv. ${fromLvl}, so star force and potential can move onto ${toName} at Lv. ${toLvl}. Bonus stats are believed not to carry.`
    : ` — a Transfer Hammer only reaches Lv. ${ceil} from Lv. ${fromLvl}, short of ${toName} at Lv. ${toLvl}, so do not over-cube what you will replace.`;
}

/**
 * The other slots an item could equally sit in: ring1..ring4, pendant1..pendant2.
 * Derived from SLOTS rather than hardcoded, so a future numbered family is
 * covered without touching this.
 */
function siblingSlots(slotId: string): string[] {
  const base = slotId.replace(/\d+$/, "");
  if (base === slotId) return [];
  return SLOTS.filter((s) => s.id !== slotId && s.id.replace(/\d+$/, "") === base).map((s) => s.id);
}

/**
 * Is this ladder rung an item the character is ALREADY WEARING in a sibling slot?
 *
 * Reported from the running app: ring2 held Ifia's Ring and the planner said
 * "Outclassed - Kanna's Treasure is the upgrade here" while Kanna's Treasure was
 * on ring1 at 17 stars. You cannot wear two. The advice was not merely useless,
 * it was unfollowable, and it displaced the rung that IS the answer - which the
 * player worked out themselves by reading the ring1 panel, where the same engine
 * correctly says Superior Gollux.
 *
 * Only siblings are checked, not the whole loadout. A cross-slot name collision
 * is a real risk with loose matching - "Arcane Umbra" appears on five different
 * pieces - and unique-equip is a within-family rule anyway.
 *
 * Matching is by TOKEN rather than substring, because a rung is a family name and
 * an item is a specific piece: "Superior Gollux" has to match "Superior Engraved
 * Gollux Ring", which `includes` does not. Every token of the rung must appear in
 * the item name, so "Boss ring" does not match "Guardian Angel Ring" on the
 * strength of the word ring alone.
 */
function wornInSibling(ch: Character, slotId: string, rungName: string): string | null {
  const want = rungName.toLowerCase().split(/[^a-z0-9']+/i).filter((t) => t.length > 2);
  if (!want.length) return null;
  for (const sib of siblingSlots(slotId)) {
    const it = ch.items[sib];
    if (!it || !it.name) continue;
    const nm = it.name.toLowerCase();
    if (want.every((t) => nm.includes(t))) return sib;
  }
  return null;
}

/** The highest required level a Transfer Hammer can reach FROM `lvl`. */
export function transferHammerCeiling(lvl: number): number | null {
  if (!(lvl > 0)) return null;
  const span =
    lvl <= TRANSFER_HAMMER.lowLevelThreshold
      ? TRANSFER_HAMMER.spanAtOrBelowLv119
      : TRANSFER_HAMMER.spanAboveLv119;
  return lvl + span;
}

/**
 * Why LADDER has no `secondary` row. Kept as a named constant rather than a
 * comment alone so that anyone re-adding the slot meets the reason first.
 */
export const SECONDARY_LADDER_RETRACTED = {
  retractedAt: "2026-09-13",
  was: ["Class secondary (Lv 0)", "Absolab-tier (Lv 160)", "Astra secondary (Lv 200)"],
  why:
    "Reported in game by the owner on a Blasted Feather: it cannot be upgraded to " +
    "an Absolab-tier secondary. Corroborated inside this file - neither of the two " +
    "upper rungs had a SOURCE entry, so the advice printed with no obtain route at " +
    "all, which is what an invented rung looks like.",
  restoreWhen:
    "A per-class secondary table exists AND every rung in it has a SOURCE row. " +
    "Secondaries are class-locked, so one shared ladder cannot be right for all.",
} as const;

/* ---------- gear ladders ---------- */
type Rung = [string, number];
export const LADDER: Record<string, Rung[]> = {
  hat: [["CRA Root Abyss hat", 150], ["Arcane Umbra", 200], ["Eternal", 250]],
  top: [["CRA top", 150], ["Arcane Umbra overall", 200], ["Eternal", 250]],
  bottom: [["CRA bottom", 150], ["Arcane Umbra overall", 200], ["Eternal", 250]],
  gloves: [["Absolab", 160], ["Arcane Umbra", 200], ["Eternal", 250]],
  shoes: [["Absolab", 160], ["Arcane Umbra", 200], ["Eternal", 250]],
  cape: [["Absolab", 160], ["Arcane Umbra", 200], ["Eternal", 250]],
  shoulder: [["Royal Black Metal", 120], ["Absolab", 160], ["Arcane Umbra", 200]],
  weapon: [["Fafnir / CRA", 150], ["Absolab", 160], ["Arcane Umbra", 200], ["Genesis (liberated)", 200]],
  // NO LADDER FOR SECONDARY, deliberately, and this is a retraction.
  //
  // It read [["Class secondary", 0], ["Absolab-tier", 160], ["Astra secondary", 200]]
  // and the owner caught it on a Blasted Feather: "cannot be absolab'd". They are
  // right, and the tell was in the code the whole time - NEITHER "Absolab-tier"
  // NOR "Astra secondary" has an entry in SOURCE, so the rec rendered with an
  // empty string where every other rung prints where the item comes from. Three
  // tier names, no provenance for any of them. They were invented to make the
  // slot look complete.
  //
  // Secondary weapons are class-locked and their progression differs per class;
  // nothing in this repo sources it. So the slot now says nothing about tiers
  // rather than naming one that does not exist, which is the difference between
  // a gap and a lie. Restore this ONLY with a per-class table and a SOURCE row
  // for every rung in it.
  //  secondary: intentionally absent - see SECONDARY_LADDER_RETRACTED.
  belt: [["Reinforced Gollux", 140], ["Superior Gollux", 150], ["Dreamy Belt", 160]],
  pendant1: [["Dominator Pendant", 140], ["Superior Gollux", 150], ["Source of Suffering", 160]],
  pendant2: [["Daybreak Pendant", 140], ["Superior Gollux", 150], ["Source of Suffering", 160]],
  earring: [["Reinforced Gollux", 140], ["Superior Gollux", 150], ["Commanding Force Earring", 160]],
  ring1: [["Meister Ring", 140], ["Superior Gollux", 150], ["Guardian Angel Ring", 160]],
  ring2: [["Kanna's Treasure", 140], ["Superior Gollux", 150], ["Boss ring", 160]],
  ring3: [["Silver Blossom Ring", 110], ["Superior Gollux", 150], ["Boss ring", 160]],
  ring4: [["Noble Ifia's Ring", 110], ["Superior Gollux", 150], ["Boss ring", 160]],
  face: [["Condensed Power Crystal", 140], ["Papulatus Mark", 145], ["Sweetwater face", 160]],
  eye: [["Papulatus Mark", 145], ["Magic Eyepatch", 150], ["Berserked", 160]],
  heart: [["Lidium Heart", 0], ["Mechanical Heart", 120], ["Black Heart", 150]],
  pocket: [["Pink Bean pocket", 140], ["Cursed Spellbook", 150], ["Stone of Eternal Life", 160]],
  emblem: [["Gold Maple Leaf Emblem", 100]],
  badge: [["Crystal Ventus Badge", 130], ["Genesis Badge", 200]],
  android: [["Any android", 0]],
  medal: [["Best available", 0]],
};

export const SOURCE: Record<string, string> = {
  "Arcane Umbra": "Lucid / Will drops, or craft with Arcane River Droplets",
  Absolab: "Lotus coins (all but hat/shoulder) and Damien Stigma Coins (weapon/shoulder)",
  "Superior Gollux": "Belt + Earrings from Hell Gollux; Ring + Pendant from Lucia's shop",
  Eternal: "Kalos the Guardian (~85M CP)",
  "Source of Suffering": "Verus Hilla",
  "Commanding Force Earring": "Darknell",
  "Guardian Angel Ring": "Guardian Angel Slime (weekly)",
  "Papulatus Mark": "Chaos Papulatus",
  "Magic Eyepatch": "Damien",
  Berserked: "Lotus",
  "Genesis (liberated)": "Tenebris liberation questline",
  "CRA Root Abyss hat": "Chaos Vellum / Pierre / Von Bon / Crimson Queen",
  "CRA top": "Root Abyss weekly",
  "CRA bottom": "Root Abyss weekly",
  "Lidium Heart": "Free from the Frieren Lotus mission",
};

export const STAT_LABEL: Record<MainStat, string> = { dex: "DEX", str: "STR", int: "INT", luk: "LUK" };
const OFF: Record<MainStat, MainStat[]> = {
  dex: ["str", "int", "luk"],
  str: ["dex", "int", "luk"],
  int: ["str", "dex", "luk"],
  luk: ["str", "int", "dex"],
};
// Flat defense, MP and movement stats do nothing for damage.
const JUNK = /\b(max ?mp|mp|speed|jump|avoid|accuracy|knockback)\b/i;
const FLAT_DEF = /\bdef(ense)?\b/i;
// ...but Ignore Defense is a premium line and must never be mistaken for flat
// defense just because it contains the same word.
const IGNORE_DEF = /\bignore\s*(enemy\s*)?def(ense)?\b|\bied\b/i;
const TIER_NEXT: Record<Tier, Tier | null> = {
  none: "rare", rare: "epic", epic: "unique", unique: "legendary", legendary: null,
};
export const TIER_LABEL: Record<Tier, string> = {
  none: "None", rare: "Rare", epic: "Epic", unique: "Unique", legendary: "Legendary",
};

/* ==================================================================== */
/* data/guide-graph.json — the only place a sourced constant may come from */
/* ==================================================================== */
// Reading the numbers out of the guide instead of retyping them means a guide
// correction is an engine correction, and it keeps the `source` field attached
// to the figure it justifies. Every read has a literal fallback so a reshaped
// guide degrades to the last verified value rather than to NaN.

interface GuideNode {
  id: string;
  rows?: string[][];
  notes?: string;
  source?: string;
}
const GUIDE_NODES: GuideNode[] = (guideGraphRaw as unknown as { nodes: GuideNode[] }).nodes;

function guideRows(id: string): string[][] {
  const n = GUIDE_NODES.find((x) => x.id === id);
  return n && Array.isArray(n.rows) ? n.rows : [];
}
/** All the free text of a list-type node, joined. Free text is parsed only
 *  where the guide states a number in prose and nowhere else. */
function guideText(id: string): string {
  return guideRows(id).map((r) => r.join(" ")).join("\n");
}
function num(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/* ==================================================================== */
/* damage model                                                          */
/* ==================================================================== */
//
// WHY THIS RETURNS A RATIO, AND WHY THAT IS THE WHOLE TRICK.
//
// MapleStory's damage formula is a product: a damage-range constant, class
// mastery, the skill's damage %, final damage multipliers, and then the terms
// below. We do not know the class constants for 46 classes and we are never
// going to, and a confidently wrong coefficient sends a real person to grind
// for nothing. But we do not need them: this function answers "how much bigger
// is damage AFTER than BEFORE", and every factor that is identical in both
// states divides out exactly. Mastery, skill %, the range constant, final
// damage, buffs, attack speed — all gone.
//
// So: DO NOT "complete" this formula. Adding a made-up class coefficient would
// not make it more accurate; it would make an exact ratio into a guess. If a
// term does not change between the two states, leaving it out is not an
// approximation, it is algebra.
//
// The one term that genuinely needs an external input is enemy defense, because
// it interacts with IED non-linearly and therefore does NOT cancel when IED
// changes. It comes in through DmgEnv.

/** Master switch for the whole pricing layer. Off, the engine must behave
 *  exactly as it did before numbers existed — see __selfTest(). */
let damageModelEnabled = true;
/** Per-Character memo of the whole ranked plan. Declared here so nothing below
 *  reads it before it exists. */
let planCache = new WeakMap<Character, Plan>();

export interface DmgEnv {
  /** Boss defense as a fraction: 3.0 = 300%. See ENEMY_DEF_* below. */
  enemyDef: number;
  /** Printed Damage % — the generic bucket Boss Damage % is ADDED INTO, not
   *  multiplied against. Defaults to ASSUMED_DAMAGE_PCT, which is 0 and which
   *  biases every boss-damage rec HIGH. A caller that knows the real figure
   *  passes it here and the bias is gone. dmgEnvFor() now reads it off
   *  `Stats.damagePct` when the character has one. See ASSUMED_DAMAGE_PCT. */
  dmgPct?: number;
  /** Printed Final Damage % — 115.79 means the multiplier 2.1579, NOT 1.1579
   *  (DAMAGE_RANGE_VALIDATION.finalDamageReading). Defaults to
   *  DEFAULT_FINAL_DAMAGE_PCT. It multiplies BOTH states of every comparison,
   *  so it is a common factor that cancels exactly out of relGain(): it moves
   *  the absolute index and cannot change a ranking. */
  finalDmgPct?: number;
  /** Class name, passed straight to damage.ts's class table. It resolves the
   *  weapon multiplier, which is a COMMON FACTOR: it moves the absolute index
   *  and cancels exactly out of every relGain() ratio. Carried so the index is
   *  not merely a ratio base, never relied on for a ranking. */
  cls?: string;
  /** Character level. The model carries it and no term uses it. */
  charLevel?: number;
  /** The class's secondary scaling stat, flat. Defaults to 0.
   *  We do not track it (Stats has no field for it), and leaving it at 0
   *  slightly OVERSTATES the value of a main-stat gain, because the real
   *  denominator is a little larger than the one used here. Named so the bias
   *  is visible rather than buried. */
  secondary?: number;
  /** Total %main-stat multiplier. It is applied to both states, so — exactly
   *  like the class constants above — it cancels. It is written out because the
   *  chain is easier to check against the game's formula with it present. The
   *  way a NEW %stat line actually enters the model is pctToFlat(), which
   *  converts it into the flat stat it is worth at this character's base.
   *
   *  NO LONGER READ BY THE MODEL, and that is a correction rather than a
   *  regression: `Stats.main` is the PRINTED total, which already has every
   *  %stat line baked in, so multiplying by it again double-counted. It was a
   *  common factor either way, so no ratio this file ever printed was wrong.
   *  The field stays because it is exported API and because dmgEnvFor() fills
   *  it; pctToFlat() is still the route a new %stat line takes. */
  pctStat?: number;
}

/** Arcane River bosses, 300%. IMPORTED, not restated: lib/damage.ts owns this
 *  number as DEFAULT_PDR (equal to its BOSS_PDR.lucid, cited to
 *  gmsmeta.com/bsm/ied.html). What is still unsourced here is the CHOICE of an
 *  Arcane River boss as the target every character is priced against — see
 *  SOURCED below. */
export const ENEMY_DEF_ARCANE = DEFAULT_PDR;
/** Grandis bosses. NOT sourced — lib/damage.ts has no row for these and says so
 *  ("Grandis-era content is widely reported at 380%"). See SOURCED below. */
export const ENEMY_DEF_GRANDIS = 3.8;

/**
 * Printed Damage % assumed for every character this engine prices.
 *
 * `Character.stats` has no damage-% field, and it has none because GMS does not
 * print one anywhere in the stat window. So the model must assume a value, and
 * it assumes ZERO. Zero is a LOWER BOUND, not a reading: every character has
 * some, from the Damage hyper stat, class passives, inner ability and links.
 *
 * WHICH DIRECTION IT BIASES, and it is not a rounding error. Boss Damage % and
 * plain Damage % land in ONE ADDITIVE BUCKET — damage.damageBreakdown() builds
 * it as `1 + dmgPct + bossPct`, cited to grandislibrary.com/content/stat-terms:
 * "It is added to %Damage in calculations." A boss-damage rec is therefore
 * priced as (1 + d + bossAfter) / (1 + d + bossBefore), which SHRINKS as d
 * grows, because a bigger d is a bigger denominator for the same numerator gain.
 * Assuming d = 0 makes that denominator as small as it can possibly be, so
 * every boss-damage figure this engine prints is the MOST the move could be
 * worth and is biased HIGH. On the reference character the 159% -> 250% move
 * reads +35.1% at d = 0 and +30.4% at a plausible d = 40% — see
 * DAMAGE_PCT_BIAS_PROBE, which is what puts that second number in the rec's own
 * explanation instead of leaving the player to discover it.
 *
 * Nothing else in the engine moves with it: the damage term is a common factor
 * in every rec that does not change boss damage, so it cancels exactly out of
 * relGain() for main stat, ATT, crit damage, flames and star force alike.
 *
 * A caller who knows the real figure passes DmgEnv.dmgPct and gets an unbiased
 * number. Listed as false in SOURCED.
 */
export const ASSUMED_DAMAGE_PCT = 0;

/**
 * An illustrative Damage % used ONLY to state the size of ASSUMED_DAMAGE_PCT's
 * bias in a sentence the player can check against their own character.
 *
 * It prices nothing and it ranks nothing. It is a guess at a plausible late-game
 * total, not a measurement, which is exactly why it never appears as a bare
 * figure — only inside "at +40% Damage% the same move is worth ...". Listed as
 * false in SOURCED.
 */
export const DAMAGE_PCT_BIAS_PROBE = 40;

/**
 * What `Stats.damagePct` falls back to when a character has no reading.
 *
 * It is ASSUMED_DAMAGE_PCT and it is the same assumption with the same bias:
 * zero is a LOWER BOUND, so every boss-damage figure computed from it is the
 * MOST the move could be worth. The difference is that the assumption is now
 * escapable — a character that records its printed DAMAGE % gets an unbiased
 * number, and the live Bow Master proves the real figure is 73, not 0
 * (DAMAGE_RANGE_VALIDATION.inputs.damagePct === 0.73, i.e. 73%).
 */
export const DEFAULT_DAMAGE_PCT = ASSUMED_DAMAGE_PCT;

/**
 * What `Stats.finalDamagePct` falls back to when a character has no reading.
 *
 * ZERO, and the bias is stated rather than hoped away: every real character has
 * Final Damage from passives and buffs, so zero understates the ABSOLUTE damage
 * index — on the validated Bow Master by a factor of 2.1579, which is most of
 * the 3.9x shortfall DAMAGE_RANGE_GAP chased.
 *
 * WHICH DIRECTION IT BIASES A REC: none. Final Damage multiplies the whole
 * chain, so it multiplies the before-state and the after-state identically and
 * divides straight out of relGain(). Unlike ASSUMED_DAMAGE_PCT — which shares an
 * ADDITIVE bucket with Boss Damage % and therefore moves that rec — this
 * constant cannot change any number this engine prints. It exists so the
 * absolute index can be right when the player supplies the reading.
 *
 * READ THE PRINTED PERCENT LITERALLY: 115.79 is stored as 115.79 and means
 * x2.1579. Listed as false in SOURCED because 0 is an assumption, not a
 * measurement.
 */
export const DEFAULT_FINAL_DAMAGE_PCT = 0;

/** The Damage % and Final Damage % actually read off the game on
 *  DAMAGE_RANGE_VALIDATION.observedAt, as PRINTED PERCENTS ready for `Stats`.
 *  Imported and converted, never retyped: damage.ts stores them as fractions
 *  (0.73 and 1.1579) and is the authority on both the values and on what the
 *  Final Damage line means. */
const printedPct = (fraction: number) => Math.round(fraction * 1e6) / 1e4;
export const VALIDATED_DAMAGE_PCT = printedPct(DAMAGE_RANGE_VALIDATION.inputs.damagePct);
export const VALIDATED_FINAL_DAMAGE_PCT = printedPct(DAMAGE_RANGE_VALIDATION.inputs.finalDamagePct);

/* ---------- which classes the damage model is allowed to speak about ---------- */

/**
 * The classes lib/damage.ts has a verified row for, by display name.
 *
 * Read off CLASS_CONSTANTS rather than listed here, so this cannot drift from
 * the model: the day a second class is measured and added there, it appears
 * here and the UI unblocks it with no edit to this file. Today it is exactly
 * ["Bow Master"], validated to ratio 1.0000 on
 * DAMAGE_RANGE_VALIDATION.observedAt.
 *
 * lib/classes.ts has a weaponMultiplier for all 53 classes and that is NOT the
 * same thing: the model needs a weapon constant, a mastery, a crit-damage base
 * and a final-damage stack, and one of four is not a model.
 */
export const VERIFIED_DAMAGE_CLASSES: readonly string[] =
  Object.values(CLASS_CONSTANTS).map((c) => c.cls);

/** Is the damage model verified for this class? True only for a class with a
 *  row in damage.CLASS_CONSTANTS. Accepts a Character or a raw class string. */
export function isDamageModelVerified(who: Character | string): boolean {
  const cls = typeof who === "string" ? who : who.cls;
  return classConstantsFor(cls) !== undefined;
}

export interface DamageModelStatus {
  /** True when every damage figure on the page is allowed to exist. */
  verified: boolean;
  /** The class as the character spells it. */
  cls: string;
  /** classKey(cls) — the join key shared by damage.ts and classes.ts. */
  key: string;
  /** The classes that ARE modelled, for "Bow Master is the only one" copy. */
  verifiedClasses: readonly string[];
  /** One sentence a UI can render verbatim. Never a number, never a hedge. */
  why: string;
}

/**
 * THE question the UI has to ask before it renders a damage figure.
 *
 * A non-verified class keeps everything that does not depend on the damage
 * model — slots, potential tiers, flames, star force caps and costs, set
 * effects, the class reference — and loses every number that does. That is not
 * a degradation to apologise for: a plausible figure for an unmeasured class is
 * precisely the failure this project has spent its life removing.
 */
export function damageModelStatus(who: Character | string): DamageModelStatus {
  const cls = typeof who === "string" ? who : who.cls;
  const verified = isDamageModelVerified(cls);
  const list = VERIFIED_DAMAGE_CLASSES.join(", ");
  return {
    verified,
    cls,
    key: classKey(cls),
    verifiedClasses: VERIFIED_DAMAGE_CLASSES,
    why: verified
      ? `The damage model is validated for ${cls} — measured against the game on ${DAMAGE_RANGE_VALIDATION.observedAt} to ratio ${DAMAGE_RANGE_VALIDATION.ratio.toFixed(4)}.`
      : `Damage is not modelled for ${cls} yet. The model has been measured against the game for ${list} only, so this page shows gear, stars, flames and potential advice but no damage figures. A number here would be a guess.`,
  };
}

function dmgIndex(s: Stats, env: DmgEnv): number | null {
  const fin = (n: number) => typeof n === "number" && Number.isFinite(n);
  if (!s || !fin(s.main) || !fin(s.att) || !fin(s.crit) || !fin(s.critdmg) || !fin(s.boss) || !fin(s.ied)) return null;
  if (s.main <= 0 || s.att <= 0) return null;

  // THE HONESTY GATE, and it is deliberately upstream of everything else.
  //
  // fractionalInputsFromCharacter() degrades an unknown class to the legacy bow
  // multiplier and raises an `unknown-class` warning. That is right for a page
  // with a warning channel; a Rec has none, so a number computed that way would
  // reach a player stripped of the one sentence that made it honest. The whole
  // pricing layer is already built to vanish rather than guess — price() drops
  // dmg/cost/eff/conf together when this returns null — so an unverified class
  // takes exactly that path and the rules layer carries on in words.
  //
  // Note the weapon multiplier is a COMMON FACTOR and cancels out of every
  // relGain() ratio, so a ratio computed on the fallback would usually be about
  // right. "Usually about right, unfalsifiable" is the thing being refused.
  if (!isDamageModelVerified(env.cls ?? "")) return null;

  // THE adapter, not a second copy of it. `Stats` holds printed percents and the
  // model wants fractions; fractionalInputsFromCharacter() is the one function
  // in the app allowed to span that boundary, and rules.Stats satisfies
  // damage.CharacterLike structurally so no import goes the other way.
  //
  // Every term that used to be written out by hand here now comes from
  // damageBreakdown(): the crit term with its sourced CRIT_DAMAGE_BASE, the
  // defence term, the range — and the DAMAGE TERM, which is the fix. This file
  // used to compute `1 + boss/100`, a damage term with no damage-% component at
  // all, which gave a boss-damage recommendation no bucket to divide into and
  // read 15-25% high. The bucket is `1 + dmgPct + bossPct` and it is
  // damage.ts's, cited there.
  const a = fractionalInputsFromCharacter(
    { cls: env.cls ?? "", lvl: env.charLevel ?? 0, stats: s },
    {
      pdr: env.enemyDef,
      secondaryStat: env.secondary ?? 0,
      dmgPctPrinted: env.dmgPct ?? DEFAULT_DAMAGE_PCT,
      // Passed as a PRINTED percent; the adapter converts. Supplying it also
      // suppresses the adapter's class-buff guess, which is what we want: a
      // measured reading beats a stacked ceiling.
      finalDmgPctPrinted: env.finalDmgPct ?? DEFAULT_FINAL_DAMAGE_PCT,
    },
  );
  const b = damageBreakdown(a.inputs, a.opts);

  // Below ied = 1 - 1/enemyDef the defence term goes negative, which is the
  // formula telling us it is out of its range rather than telling us damage is
  // negative. damage.ts clamps it to DEF_TERM_FLOOR and raises a warning, which
  // is right for a page that renders warnings; this engine has no warning
  // channel on a Rec, so it REFUSES to price instead. A rec with no number
  // degrades visibly. A rec built on a floored term does not.
  if (!b.meaningful || !(b.rawDefTerm > 0)) return null;
  if (!(b.damageTerm > 0) || !(b.critTerm > 0) || !(b.range > 0)) return null;

  return Number.isFinite(b.damageIndex) && b.damageIndex > 0 ? b.damageIndex : null;
}

/** Ratio of final damage after/before, minus 1. Null for anything the model
 *  cannot price — never a guess. */
export function relGain(before: Stats, after: Stats, env: DmgEnv): number | null {
  if (!damageModelEnabled) return null;
  const a = dmgIndex(before, env);
  const b = dmgIndex(after, env);
  if (a === null || b === null) return null;
  const g = b / a - 1;
  return Number.isFinite(g) ? g : null;
}

/* ---------- turning the character sheet into model inputs ---------- */

/** Arcane Symbols give 10 main stat per point of Arcane Force: the guide's own
 *  table runs 30 force / 300 stat at Lv1 to 220 / 2,200 at Lv20, and states
 *  "All six maxed = 13,200 main stat and 1,320 Arcane Force". */
export const ARCANE_MAIN_STAT_PER_FORCE = readArcaneStatPerForce();
function readArcaneStatPerForce(): number {
  const rows = guideRows("symbols.arcane.cost");
  const r = rows[rows.length - 1];
  const stat = num(r?.[3]);
  const force = num(r?.[4]);
  return stat && force ? stat / force : 10;
}

/**
 * Symbol stat is FLAT and is not multiplied by %stat, which is the whole reason a
 * %line is worth less than it looks on a character carrying a lot of it. This is
 * the number the owner's question turned on: roughly half their displayed DEX comes
 * from symbols and no %DEX line touches any of it.
 *
 * TWO THINGS THIS USED TO GET WRONG, both now delegated to lib/symbols.ts:
 *
 *   1. It read only ch.stats.arcane, the stat-window total. lib/cubes.ts had
 *      already moved to per-area levels, so a player who entered their six symbol
 *      levels but never typed Arcane Power got 10,700 in the cube ranking and 0
 *      here — one app disagreeing with itself about one character.
 *   2. It was class-blind. `arcane * 10` is right for an ordinary class and wrong
 *      for both exceptions. A Demon Avenger's symbols pay HP rather than STR, so
 *      its flat symbol stat is ZERO and all of its displayed STR really does sit
 *      inside the %stat multiplier; subtracting 10,700 from it understated the
 *      base and undersold every %stat line being ranked. Xenon is on a different
 *      slope again.
 *
 * Sacred symbols are still not counted — that slope is unsourced (four lookups
 * failed) and lib/symbols.ts says so. For a Lv 260+ character that understates
 * flat stat and therefore OVERSTATES every %stat rec here, the same direction as
 * the bug above. The observed character is Lv 245 and has none.
 */
export function symbolFlatStat(ch: Character): number {
  return ch.symbols && hasArcaneLevels(ch.symbols)
    ? arcaneFlatMainStatFromLevels(ch.symbols.arcane, ch.cls)
    : arcaneFlatMainStatFromPower(ch.stats.arcane, ch.cls);
}

/** %main-stat visible on gear (potential + flames). This is a LOWER bound on
 *  the character's true total: hyper stats, link skills, legion, inner ability
 *  and buffs are not on the equip window and are not counted. A low estimate
 *  here inflates the modelled base stat, which overstates a new %stat line. */
export function gearStatPct(ch: Character): number {
  let p = 0;
  for (const it of Object.values(ch.items)) {
    if (!it) continue;
    for (const l of it.p || []) p += statPct(l, ch.main);
    for (const l of it.f || []) p += statPct(l, ch.main);
  }
  return p;
}

/** What one new X% main-stat line is worth in flat main stat on THIS character.
 *  %lines multiply the pre-multiplier base, not the displayed total, and the
 *  displayed total includes flat symbol stat that %lines never touch. */
export function pctToFlat(ch: Character, pct: number): number | null {
  const mult = 1 + gearStatPct(ch) / 100;
  const base = (ch.stats.main - symbolFlatStat(ch)) / mult;
  if (!(base > 0) || !Number.isFinite(base)) return null;
  return (base * pct) / 100;
}

export function dmgEnvFor(ch: Character): DmgEnv {
  return {
    enemyDef: ENEMY_DEF_ARCANE,
    secondary: 0,
    pctStat: gearStatPct(ch),
    // The character sheet can now carry both readings. When it does not, these
    // are the named assumptions — DEFAULT_DAMAGE_PCT biases boss-damage recs
    // high, DEFAULT_FINAL_DAMAGE_PCT biases nothing. See both constants.
    dmgPct: ch.stats.damagePct ?? DEFAULT_DAMAGE_PCT,
    finalDmgPct: ch.stats.finalDamagePct ?? DEFAULT_FINAL_DAMAGE_PCT,
    cls: ch.cls,
    charLevel: ch.lvl,
  };
}

/** True when this character supplies its own printed Damage %, i.e. when the
 *  boss-damage rec is a real figure rather than an upper bound. */
export function hasDamagePctReading(ch: Character): boolean {
  return typeof ch.stats.damagePct === "number" && Number.isFinite(ch.stats.damagePct);
}

const withMain = (s: Stats, d: number): Stats => ({ ...s, main: s.main + d });
const withAtt = (s: Stats, d: number): Stats => ({ ...s, att: s.att + d });
const withBoss = (s: Stats, d: number): Stats => ({ ...s, boss: s.boss + d });
const withIed = (s: Stats, pct: number): Stats => ({ ...s, ied: pct });
const withCritDmg = (s: Stats, pct: number): Stats => ({ ...s, critdmg: pct });

/* ==================================================================== */
/* costs                                                                 */
/* ==================================================================== */

/** Bonus stat reset, v.271. "Bonus Stats can now be reset with mesos —
 *  3,000,000 per reset — at Black Rebirth Flame rates." (flames.system) */
export const FLAME_RESET_MESO = num(guideText("flames.system").match(/([\d,]+)\s*per reset/i)?.[1]) ?? 3_000_000;

function cubeMeso(name: string, fallback: number): number {
  const row = guideRows("potential.cubes").find((r) => r[0] === name);
  return num(row?.[3]) ?? fallback;
}
/** Cash Shop cube, Heroic meso price. Flat — NOT scaled by item level
 *  ("Cube meso cost is flat, not scaled by item level" — potential.cubes). */
export const CUBE_GLOWING_MESO = cubeMeso("Glowing", 12_000_000);
export const CUBE_BRIGHT_MESO = cubeMeso("Bright", 22_000_000);

/* ---- star force rates, caps and recovery: all sourced from the guide ---- */

export interface SfRate { p: number; f: number; b: number }
/** Per-star success / fail / boom, keyed by the star you are tapping FROM.
 *  Source: "Star Force success / boom table", DigitalTQ Star Force guide
 *  (Feb 2026), verified 2026-09-11 for v.271. Since v.264 an item can no
 *  longer LOSE a star on failure — only success, fail, or boom.
 *
 *  NOTE: this is the GUIDE table, kept because the guide page renders from it.
 *  sfPlan() no longer reads it — it goes through starforce.effectiveRates(),
 *  which is the same Mode-1 column plus the v.271 star-catch bonus and the
 *  Enhancement Mode rows the guide text predates. The two are cross-checked in
 *  __selfTest(): if the guide table ever disagrees with STAR_ROWS_MODE1 on
 *  success or boom, that is a real drift and the test says so. */
export const SF_RATES: Record<number, SfRate> = readSfRates();
function readSfRates(): Record<number, SfRate> {
  const out: Record<number, SfRate> = {};
  for (const r of guideRows("starforce.rates")) {
    const star = num(r[0]);
    const p = num(r[1]);
    const f = num(r[2]);
    const b = num(r[3]);
    if (star === null || p === null || f === null || b === null) continue;
    out[star] = { p: p / 100, f: f / 100, b: b / 100 };
  }
  return out;
}

/** Where a boom drops you. "Trace recovery: boomed at 15-19 returns 12 stars,
 *  20 returns 15, 21-22 returns 17, 23-25 returns 19, 26-30 returns 20."
 *  (starforce.rules) */
export const SF_TRACE_RECOVERY: Array<[number, number, number]> = readTraceRecovery();
function readTraceRecovery(): Array<[number, number, number]> {
  const line = guideRows("starforce.rules").map((r) => r[0]).find((s) => /trace recovery/i.test(s || ""));
  const out: Array<[number, number, number]> = [];
  if (line) {
    const re = /(\d+)(?:\s*-\s*(\d+))?\s+returns\s+(\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) out.push([parseInt(m[1], 10), parseInt(m[2] ?? m[1], 10), parseInt(m[3], 10)]);
  }
  return out.length ? out : [[15, 19, 12], [20, 20, 15], [21, 22, 17], [23, 25, 19], [26, 30, 20]];
}
export function traceRecovery(star: number): number {
  for (const [lo, hi, back] of SF_TRACE_RECOVERY) if (star >= lo && star <= hi) return back;
  return 0;
}

/** "Safeguard doubles the meso cost and removes boom. Available up to 18 stars
 *  only." (starforce.rules) — so the protectable attempts are the ones that
 *  LAND on 18 or below, i.e. taps from 15, 16 and 17.
 *
 *  @deprecated for pricing. lib/starforce.ts researched this properly and found
 *  the guide text is a snapshot of a mechanic that has since grown: classic
 *  Safeguard (additive x3, not x2) still covers taps from 15-17, and from 18-21
 *  the boom-free option is Enhancement Mode 4, which buys 0% destroy by ALSO
 *  cutting success and costing 6.5x. costPerAttempt() and effectiveRates()
 *  know both regimes; these two constants know neither. Kept exported because
 *  the guide page renders the old sentence. */
export const SAFEGUARD_COST_MULT = 2;
export const SAFEGUARD_MAX_TO_STAR =
  num(guideRows("starforce.rules").map((r) => r[0]).find((s) => /safeguard/i.test(s || ""))?.match(/up to (\d+) stars/i)?.[1]) ?? 18;

/* ---- potential line values: sourced ---- */

export interface PotBand { rare: number; epic: number; unique: number; legendary: number }
/** A single main-stat line, by item level band. Source: "Potential tiers and
 *  line values", DigitalTQ Potential guide. */
export function potLineValue(itemLevel: number): PotBand {
  const rows = guideRows("potential.tiers");
  const pick = rows.find((r) => {
    const band = r[0] || "";
    if (band.endsWith("+")) return itemLevel >= (num(band) ?? Infinity);
    const lo = num(band.split("-")[0]);
    const hi = num(band.split("-")[1]);
    return lo !== null && hi !== null && itemLevel >= lo && itemLevel <= hi;
  }) || rows[rows.length - 1];
  return {
    rare: num(pick?.[1]) ?? 4,
    epic: num(pick?.[2]) ?? 7,
    unique: num(pick?.[3]) ?? 10,
    legendary: num(pick?.[4]) ?? 13,
  };
}

/** The old hand-written milestones were 18% and 30% main stat. At the 71-150
 *  band a legendary line is 12%, so those constants were exactly 1.5 and 2.5
 *  legendary lines — a good rule expressed as a number that silently goes wrong
 *  one item level later, where a legendary line becomes 13%. Keeping the rule
 *  and dropping the constant fixes the Lv150/151 boundary. */
export const MILESTONE_LINES_GOOD = 1.5;
export const MILESTONE_LINES_DONE = 2.5;

/* ---- flame tiers: floors sourced, magnitudes not ---- */

/** "Eternal Rebirth Flames roll tier 2 minimum, rarely tier 5. On
 *  flame-advantaged (boss) gear, tier 4 minimum, rarely tier 7."
 *  (flames.system). We price a reroll at the FLOOR, so the flame number is a
 *  conservative one: the roll can only come out better than this. */
export const FLAME_TIER_FLOOR_ORDINARY = 2;
export const FLAME_TIER_FLOOR_ADVANTAGED = 4;

/* ==================================================================== */
/* PLACEHOLDERS — every constant below is UNVERIFIED                     */
/* ==================================================================== */
// These are the figures that are not in data/guide-graph.json and that could
// not be sourced. They are named, exported and flagged in SOURCED so that
// downstream code — and the player — can tell them apart from a cited number at
// runtime. Any rec whose COST depends on one of these is marked conf:
// 'placeholder' and says so in its own text.

/**
 * @deprecated DO NOT PRICE ANYTHING WITH THIS. Use
 * `costPerAttempt(itemLevel, star, opts)` from lib/starforce.ts, which this
 * file now calls for every tap (see tapModel() below).
 *
 * WHY IT IS STILL HERE: it is exported, and deleting an export is a different
 * change from correcting one. It is also the honest record of how wrong the
 * guess was.
 *
 * WHY IT IS WRONG: it applies ONE divisor to the whole 10-14 band and a second
 * to the whole 15+ band, where the real curve has a divisor PER STAR, and it
 * cubes the raw item level instead of the level rounded down to a multiple of
 * ten. At the stars that matter most it under-quotes badly — on Lv200 gear,
 * tapping FROM the star named:
 *
 *     star   this function   starforce.costPerAttempt   under-quote
 *     11      16.4M            29.8M                     1.82x
 *     12      20.4M            54.3M                     2.67x
 *     13      24.9M            90.4M                     3.64x
 *     14      30.0M           159.8M                     5.33x
 *     18     113.4M           324.1M                     2.86x
 *     19     130.3M           579.0M                     4.44x
 *
 * The change brief quoted this gap as "1.8x-2.7x at stars 11-13". The first two
 * are right; star 13 is 3.6x, and star 14 — which every 15-star push has to pay
 * — is 5.3x. It is worse than advertised, not better. A 5x under-quote on the
 * exact taps a mid-game player is saving for is the failure this app exists to
 * avoid. (The ratios are divisor ratios and so are item-level independent,
 * except on levels that are not multiples of ten, where the level rounding
 * moves everything by a further 0.9x — e.g. a Lv145 Papulatus Mark.)
 *
 * TODO SOURCE (unchanged, and it applies to starforce.ts's curve too): a
 * per-star meso table for GMS v.271, Heroic, from Nexon. Both curves are
 * community-sourced; only one of them is per-star.
 */
export const PLACEHOLDER_SF_COST_DIV_LOW = 2500;
export const PLACEHOLDER_SF_COST_DIV_MID = 40000;
export const PLACEHOLDER_SF_COST_DIV_HIGH = 20000;
export const PLACEHOLDER_SF_COST_EXP = 2.7;
export function PLACEHOLDER_SF_TAP_MESO(itemLevel: number, star: number): number {
  const l3 = Math.pow(itemLevel, 3);
  const n = star + 1;
  if (star < 10) return 100 * Math.round((l3 * n) / PLACEHOLDER_SF_COST_DIV_LOW) + 10;
  const div = star < 15 ? PLACEHOLDER_SF_COST_DIV_MID : PLACEHOLDER_SF_COST_DIV_HIGH;
  return 100 * Math.round((l3 * Math.pow(n, PLACEHOLDER_SF_COST_EXP)) / div) + 10;
}

/** What a star is worth in stats.
 *  TODO SOURCE: the per-star, per-level-band stat and ATT table. It is on the
 *  MapleStory Wiki's Star Force stat tables page, which is not machine
 *  readable from here, and it is not in the guide graph. The two-regime model
 *  below (stars give flat main stat up to 15, ATT from 16) is the right SHAPE
 *  and the wrong MAGNITUDE. Needs: the Lv138+ band rows. */
export const PLACEHOLDER_SF_MAIN_STAT_PER_STAR_TO_15 = 10;
export const PLACEHOLDER_SF_MAIN_STAT_PER_STAR_ABOVE_15 = 0;
export const PLACEHOLDER_SF_ATT_PER_STAR_TO_15 = 0;
export const PLACEHOLDER_SF_ATT_PER_STAR_ABOVE_15 = 7;
function sfStatGain(from: number, to: number): { main: number; att: number } {
  let main = 0;
  let att = 0;
  for (let s = from; s < to; s++) {
    const high = s >= 15;
    main += high ? PLACEHOLDER_SF_MAIN_STAT_PER_STAR_ABOVE_15 : PLACEHOLDER_SF_MAIN_STAT_PER_STAR_TO_15;
    att += high ? PLACEHOLDER_SF_ATT_PER_STAR_ABOVE_15 : PLACEHOLDER_SF_ATT_PER_STAR_TO_15;
  }
  return { main, att };
}

/** Expected cubes to move up one tier, using the cube the guide recommends for
 *  that step.
 *  TODO SOURCE: GMS does publish cube tier-up rates in its probability
 *  disclosures; they are not in the guide graph and were not retrievable here.
 *  Needs: per-cube rank-up probability by current tier for v.271. */
export const PLACEHOLDER_CUBES_TO_TIER_UP: Record<Tier, number> = {
  none: 1,
  rare: 8,
  epic: 25,
  unique: 70,
  legendary: 0,
};

/** Expected Bright cubes to add one more legendary main-stat line to an item
 *  that is already Legendary. This is a different question from a tier-up — the
 *  tier is already there and you are rerolling three lines for a better set —
 *  so it gets its own constant rather than borrowing the tier-up one.
 *  TODO SOURCE: per-line roll rates within Legendary. Needs: v.271 line pool
 *  and weights for main-stat % lines by slot. */
export const PLACEHOLDER_CUBES_FOR_EXTRA_LEGENDARY_LINE = 40;

/** One legendary Boss Damage line on a weapon / secondary / emblem.
 *  TODO SOURCE: the boss-damage line value table. The guide names the target
 *  lines but not their sizes. Needs: legendary line values for Boss Damage %
 *  and Ignore DEF % by item level. */
export const PLACEHOLDER_POT_BOSS_LINE_PCT = 30;

/** Flat main stat granted per bonus-stat TIER at a given item level.
 *  TODO SOURCE: the bonus-stat value table (value = tier x f(item level)).
 *  f() is not in the guide graph and was not retrievable. Needs: the v.271
 *  bonus stat value table. */
export function PLACEHOLDER_FLAME_UNIT_PER_TIER(itemLevel: number): number {
  return Math.floor(itemLevel / 20) + 1;
}
/** How many of the (at most 4) bonus stat lines land on main stat or All Stat.
 *  TODO SOURCE: bonus-stat line distribution. Needs: per-line-type roll rates. */
export const PLACEHOLDER_FLAME_MAIN_STAT_LINES = 1.2;

/** Which figures in this engine rest on a citation and which do not. Downstream
 *  code can read this at runtime rather than trusting a comment. */
export const SOURCED: Record<string, boolean> = {
  FLAME_RESET_MESO: true,
  CUBE_GLOWING_MESO: true,
  CUBE_BRIGHT_MESO: true,
  SF_RATES: true,
  SF_TRACE_RECOVERY: true,
  SAFEGUARD_COST_MULT: true,
  SAFEGUARD_MAX_TO_STAR: true,
  POT_LINE_VALUE: true,
  FLAME_TIER_FLOOR_ORDINARY: true,
  FLAME_TIER_FLOOR_ADVANTAGED: true,
  ARCANE_MAIN_STAT_PER_FORCE: true,
  // The 300% FIGURE is now imported from damage.DEFAULT_PDR, which cites
  // gmsmeta.com/bsm/ied.html for Lucid. What stays uncited is this file's
  // CHOICE of that boss as the target every character is measured against —
  // the player might be at Grandis, where the same IED is worth more. Enemy
  // defense cancels out of relGain unless a rec changes IED, so the only number
  // on the page it moves is the IED rec, which is labelled 'placeholder' for
  // exactly this reason.
  ENEMY_DEF_ARCANE: false,
  ENEMY_DEF_GRANDIS: false,
  // Damage % is not printed in game and Character.stats has no field for it, so
  // the model assumes 0 — a lower bound that makes every BOSS-damage figure an
  // upper bound. See the constant's own comment for the arithmetic and the
  // direction. DAMAGE_PCT_BIAS_PROBE is the illustrative figure used to say how
  // big the bias is; it prices nothing.
  ASSUMED_DAMAGE_PCT: false,
  DAMAGE_PCT_BIAS_PROBE: false,
  // The fallbacks for the two new Stats readings. Both are assumptions and both
  // say which way they lean: DEFAULT_DAMAGE_PCT biases boss-damage recs high,
  // DEFAULT_FINAL_DAMAGE_PCT biases no rec at all because it is a common factor.
  // A character that records the printed readings stops using either.
  DEFAULT_DAMAGE_PCT: false,
  DEFAULT_FINAL_DAMAGE_PCT: false,
  // These two ARE measurements: read off the game on
  // DAMAGE_RANGE_VALIDATION.observedAt and imported from lib/damage.ts, which
  // is the authority on both the values and on what "FINAL DAMAGE 115.79%"
  // means (multiplier 2.1579, not 1.1579).
  VALIDATED_DAMAGE_PCT: true,
  VALIDATED_FINAL_DAMAGE_PCT: true,
  // No longer used for pricing — see the @deprecated block on the function. The
  // curve that replaced it, starforce.costPerAttempt, is better (per-star
  // divisors, correct level rounding) but is still single-sourced, so it is
  // false here too and every star force rec stays conf: 'placeholder'.
  PLACEHOLDER_SF_TAP_MESO: false,
  STARFORCE_COST_PER_ATTEMPT: false,
  PLACEHOLDER_SF_MAIN_STAT_PER_STAR_TO_15: false,
  PLACEHOLDER_SF_MAIN_STAT_PER_STAR_ABOVE_15: false,
  PLACEHOLDER_SF_ATT_PER_STAR_TO_15: false,
  PLACEHOLDER_SF_ATT_PER_STAR_ABOVE_15: false,
  PLACEHOLDER_CUBES_TO_TIER_UP: false,
  PLACEHOLDER_CUBES_FOR_EXTRA_LEGENDARY_LINE: false,
  PLACEHOLDER_POT_BOSS_LINE_PCT: false,
  PLACEHOLDER_FLAME_UNIT_PER_TIER: false,
  PLACEHOLDER_FLAME_MAIN_STAT_LINES: false,
  // DmgEnv.secondary is pinned at 0 because Stats has no field for it.
  SECONDARY_STAT: false,
};

/* ==================================================================== */
/* star force: the absorbing Markov chain                                */
/* ==================================================================== */

export interface SfPlan {
  /** Expected taps from `from` to `to`, counting the taps spent re-climbing
   *  after a boom. */
  taps: number;
  /** Expected mesos, tap costs only. It does NOT include replacing a boomed
   *  item: Trace Transfer needs a fresh copy of the same equip, and what that
   *  copy costs is a drop table, not a price. */
  mesos: number;
  /** Expected number of booms. Nobody else shows a player this number. */
  booms: number;
  safeguard: boolean;
  /** Every soft constant this plan leaned on, named by lib/starforce.ts. Empty
   *  would mean "budget against it"; it is never empty today, because the meso
   *  formula itself is single-sourced. */
  unverified: UnverifiedConstant[];
  /** The single badge, derived from `unverified` through the one mapping. */
  conf: Conf;
}

/**
 * One tap, priced and rated by lib/starforce.ts rather than by this file.
 *
 * `guard` means "take the boom-free option if the game sells one at this star":
 *   stars 0-14   there is no boom to remove; guard is ignored.
 *   stars 15-17  classic Safeguard. Destroy goes to zero, success is unchanged,
 *                and the cost multiplier is ADDITIVE (+2, i.e. 3x base).
 *   stars 18-21  no Safeguard exists. The boom-free option is Enhancement
 *                Mode 4, which zeroes destroy by CUTTING SUCCESS (15% -> 8% at
 *                18) and charges 6.5x. That trade is why a guarded 18-19 climb
 *                can cost more than it saves, and why the old
 *                SAFEGUARD_COST_MULT = 2 could never have got this right.
 *   stars 22+    nothing protects you. guard is ignored.
 *
 * Star catching is ON: v.271 applies the 1.05x success bonus automatically to
 * every attempt, so a plan computed without it describes a game nobody plays.
 */
function tapModel(
  itemLevel: number,
  star: number,
  guard: boolean,
): { p: number; f: number; b: number; cost: number; unverified: UnverifiedConstant[] } | null {
  let row;
  try {
    row = rowFor(star, 1);
  } catch {
    return null; // star outside 0..29
  }
  const boomFreeMode = modesAvailableAt(star).includes(4);
  const wantGuard = guard && (row.safeguardStyle || boomFreeMode) && row.boom > 0;
  const mode: EnhancementMode = wantGuard && !row.safeguardStyle ? 4 : 1;

  const rates = effectiveRates(star, mode, NO_EVENTS);
  // Classic Safeguard removes the destroy branch without touching success, so
  // the failure branch absorbs it. Mode 4 already reports boom = 0.
  const classic = wantGuard && row.safeguardStyle;
  const p = rates.success;
  const b = classic ? 0 : rates.boom;
  const f = Math.max(0, 1 - p - b);

  let cost: number;
  let unverified: UnverifiedConstant[];
  try {
    const c = costPerAttempt(itemLevel, star, {
      safeguard: wantGuard,
      mode,
      discount30: false,
      mvpTier: "none",
    });
    cost = c.mesos;
    unverified = [...c.unverified];
  } catch {
    // costPerAttempt throws by name rather than inventing a divisor. A star
    // whose divisor is not sourced is a star we refuse to price, not one we
    // guess at.
    return null;
  }
  if (!(p > 0) || !Number.isFinite(cost) || cost < 0) return null;
  return { p, f, b, cost, unverified };
}

/** Gauss-Jordan with partial pivoting. n is at most 30 here. */
function solveLinear(a: number[][], rhs: number[][]): number[][] | null {
  const n = a.length;
  const k = rhs.length;
  if (!n) return rhs.map(() => []);
  const m = a.map((row, i) => row.concat(rhs.map((r) => r[i])));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    for (let j = col; j < n + k; j++) m[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (!f) continue;
      for (let j = col; j < n + k; j++) m[r][j] -= f * m[col][j];
    }
  }
  return rhs.map((_, s) => m.map((row) => row[n + s]));
}

/**
 * Expected cost of going from `from` stars to `to` stars.
 *
 * A boom does not end the run — it drops the item to its Trace recovery star
 * and you climb again — so the chain has back edges and cannot be solved by
 * walking backwards from the target. States 0..to-1 with E[to] = 0:
 *
 *   E[s] = c(s) + p(s)*E[s+1] + f(s)*E[s] + b(s)*E[recover(s)]
 *
 * which is a small linear system. The same system solved with c(s) = 1 gives
 * expected taps and with c(s) = b(s) gives expected booms.
 *
 * Superior equipment is deliberately NOT priced: the guide says it "uses its
 * own harsher table" and does not give that table.
 *
 * WHAT CHANGED IN THIS WAVE: every per-tap number — success, fail, boom, meso
 * cost, trace recovery star and the whole meaning of `safeguard` — now comes
 * from lib/starforce.ts via tapModel(). The chain itself is unchanged, and it
 * stays an EXACT linear solve rather than starforce.simulate()'s 20,000-trial
 * Monte Carlo: advise() runs for 25 slots on every render, and a sampled mean
 * that wobbles in the third digit would make the ranking flicker between
 * frames for no gain in truth.
 */
export function sfPlan(itemLevel: number, from: number, to: number, safeguard: boolean): SfPlan | null {
  if (!(itemLevel > 0) || to <= from) return null;
  if (to > 30 || from < 0) return null;

  const n = to;
  const A: number[][] = [];
  const cCost: number[] = [];
  const cTaps: number[] = [];
  const cBooms: number[] = [];
  const soft = new Set<UnverifiedConstant>();

  for (let s = 0; s < n; s++) {
    const tap = tapModel(itemLevel, s, safeguard);
    if (!tap) return null;
    const { p, f, b, cost } = tap;
    for (const u of tap.unverified) soft.add(u);

    const row = new Array<number>(n).fill(0);
    row[s] += 1 - f;
    if (s + 1 < n) row[s + 1] -= p;
    if (b > 0) {
      const back = sfTraceRecoveryStar(s);
      if (back < n) row[back] -= b;
    }
    A.push(row);
    cCost.push(cost);
    cTaps.push(1);
    cBooms.push(b);
  }

  const sol = solveLinear(A, [cCost, cTaps, cBooms]);
  if (!sol) return null;
  const [mesos, taps, booms] = sol;
  const unverified = [...soft];
  const out: SfPlan = {
    mesos: mesos[from],
    taps: taps[from],
    booms: booms[from],
    safeguard,
    unverified,
    conf: confFromUnverified(unverified),
  };
  if (![out.mesos, out.taps, out.booms].every((x) => Number.isFinite(x) && x >= 0)) return null;
  return out;
}

/** Protection costs more per tap and removes (or, at 18+, trades away) the
 *  boom, so whether it is worth it depends on the level and the range. Solve
 *  both and take the cheaper in tap mesos — and note that at 18-21 the guarded
 *  branch also has a LOWER success rate, so "cheaper" there is a real question
 *  rather than a formality. */
export function sfPlanBest(itemLevel: number, from: number, to: number): SfPlan | null {
  const plain = sfPlan(itemLevel, from, to, false);
  const guarded = sfPlan(itemLevel, from, to, true);
  if (!plain) return guarded;
  if (!guarded) return plain;
  return guarded.mesos < plain.mesos ? guarded : plain;
}

/* ---------- line analysis ---------- */
/** Boss-objective only. Kept exactly as it was: components/Planner.tsx imports
 *  it and lib/farming.ts asserts parity against it over a corpus. New code
 *  inside this file goes through deadLine() below instead. */
export function isDeadLine(txt: string, main: MainStat): boolean {
  if (!txt) return false;
  const t = txt.toLowerCase();
  if (IGNORE_DEF.test(t)) return false;
  if (JUNK.test(t) || FLAT_DEF.test(t)) return true;
  if (/all ?stat/.test(t)) return false;
  // A LINE CAN NAME MORE THAN ONE STAT. The game prints "DEX, INT +24" as a
  // single bonus-stat row granting +24 to each, and this function used to ask
  // only whether an OFF stat appeared anywhere in the text - so on a DEX
  // character that row read as DEAD, and the page led with "1 wasted flame line
  // - reset it" pointing at the player's best line. Following that advice would
  // have destroyed it for 3,000,000 mesos.
  //
  // It never fired before because no comma row could reach Item.f: the reader
  // that produces them is new, and the one it replaced summed the two DEX rows
  // into a single "DEX +59", which hid this.
  //
  // Naming the main stat is decisive. Whatever else the row carries, it is
  // paying out main stat and is not dead.
  if (new RegExp(`\\b${main}\\b`).test(t)) return false;
  return OFF[main].some((o) => new RegExp(`\\b${o}\\b`).test(t));
}

/* ---------- the farming seam ----------
 *
 * THE PROBLEM THIS SOLVES. isDeadLine() asks one question — "is this line
 * worthless for bossing?" — and the answer is wrong for the one item set where
 * it matters most. On a dedicated farming carrier, Boss Damage and Ignore DEF
 * are the dead lines and Mesos Obtained is the premium one, and judging that
 * ring by DEX% tells a player to reroll away the best line in the game.
 * lib/farming.ts's isDeadLineFor(txt, main, objective, slot, dedicated) answers
 * the right question, with every extra parameter defaulted so the boss path is
 * bit-identical.
 *
 * WHY IT IS NOT A PLAIN IMPORT. It cannot be one. farming.ts reads this file's
 * SLOTS at module scope, so a static import here is a cycle that kills the
 * build with a temporal-dead-zone ReferenceError — measured, quoted at the top
 * of this file. Editing farming.ts is another session's call.
 *
 * SO: a seam. `deadLine()` starts as isDeadLine() — today's exact behaviour,
 * which is requirement 2's floor — and is upgraded in place the moment
 * farming.ts is evaluated. Two things make that safe rather than racy:
 *
 *   1. The fallback and the upgrade AGREE on the boss objective. farming's own
 *      __selfTest() asserts that parity over a corpus. The only verdicts that
 *      can differ are the ones on a dedicated farm carrier, and a character
 *      with no farm loadout never asks for one.
 *   2. Installing invalidates the plan cache, so the next render recomputes.
 *      Advice is recomputed constantly; it cannot get stuck on the fallback.
 *
 * The deferred import below is what actually performs the upgrade. It runs
 * after this module's body has finished, which is precisely why it does not hit
 * the cycle. An integrator who would rather wire it explicitly — from a
 * component, where both modules are already evaluated — can call
 * __useObjectiveDeadLine(isDeadLineFor) instead and drop the import. */

export type ObjectiveDeadLine = (
  txt: string,
  main: MainStat,
  objective?: FarmObjective,
  slot?: string,
  dedicated?: boolean,
) => boolean;

let objectiveDeadLine: ObjectiveDeadLine = isDeadLine;
/** True once farming.ts's evaluator is in place. Exported so the UI can say
 *  "boss-objective only" rather than silently showing farm advice that has not
 *  loaded. */
export let objectiveDeadLineInstalled = false;

export function __useObjectiveDeadLine(fn: ObjectiveDeadLine | null): void {
  objectiveDeadLine = fn ?? isDeadLine;
  objectiveDeadLineInstalled = fn !== null;
  planCache = new WeakMap();
}

// Deferred on purpose. See the comment block above; a static import here is a
// build-breaking cycle.
void import("./farming")
  .then((m) => __useObjectiveDeadLine(m.isDeadLineFor))
  .catch(() => {
    /* The boss-objective fallback is already correct. Nothing to report. */
  });

/** The one line-verdict call inside this file.
 *
 *  It is the UNION of the two verdicts, not a replacement, and that is
 *  deliberate. farming's farm objective declines to call anything dead on a
 *  slot that cannot roll drop or meso — correct advice for a Boss Damage line
 *  there, but it would also stop flagging an outright dead STR line on a
 *  DEX character. OR-ing with the boss baseline means adopting farming's
 *  evaluator can only ever ADD verdicts (Boss Damage and IED on a dedicated
 *  farm carrier) and can never silently drop one this app already made. That
 *  is requirement 2's floor, enforced here rather than assumed. */
function deadLine(txt: string, main: MainStat, ctx?: LineCtx): boolean {
  if (isDeadLine(txt, main)) return true;
  if (!ctx || ctx.objective === "boss") return false;
  return objectiveDeadLine(txt, main, ctx.objective, ctx.slot, ctx.dedicated);
}

/** What objective a given slot's item should be judged under.
 *
 *  rules.Character has no `loadouts` field yet; farming.CharacterWithLoadouts
 *  adds one and extends Character, so reading it structurally works today and
 *  becomes a plain field read on the day loadouts move onto Character. Nothing
 *  is imported for it — a value import would be the same cycle. */
interface LineCtx { objective: FarmObjective; slot: string; dedicated: boolean }
interface OverlayLike { id?: string; kind?: string; over?: Record<string, unknown> }

function lineCtx(ch: Character, slotId: string): LineCtx {
  const loadouts = (ch as { loadouts?: readonly OverlayLike[] }).loadouts;
  const farm = loadouts?.find((l) => l?.kind === "farm" || l?.id === "farm");
  // Present in the overlay === a separate physical item the player does not
  // boss with. Absent === shared with the boss preset, and farming.ts's own
  // safety rule says a shared item is never judged for farming.
  const dedicated = !!farm?.over && Object.prototype.hasOwnProperty.call(farm.over, slotId) && farm.over[slotId] != null;
  return { objective: dedicated ? "farm" : "boss", slot: slotId, dedicated };
}

export function statPct(txt: string, main: MainStat): number {
  if (!txt) return 0;
  const t = txt.toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  if (/all ?stat/.test(t)) return v;
  if (new RegExp(`\\b${main}\\b`).test(t)) return v;
  return 0;
}

/** Flat main stat off a line, e.g. "DEX +28" -> 28. Percentage lines are
 *  statPct()'s job and return 0 here. */
export function statFlat(txt: string, main: MainStat): number {
  if (!txt || txt.includes("%")) return 0;
  const t = txt.toLowerCase();
  if (!new RegExp(`\\b${main}\\b`).test(t) && !/all ?stat/.test(t)) return 0;
  const m = t.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Flat ATT off a line, e.g. "ATT +51" -> 51. */
export function attFlat(txt: string): number {
  if (!txt || txt.includes("%")) return 0;
  if (!/\b(att|attack power|magic att)\b/i.test(txt)) return 0;
  const m = txt.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Most secondary weapons take no star force at all — arrow fletchings, charms,
// chess pieces, wristbands and the rest of the class-specific secondaries have no
// upgrade slots. Shields are the exception: they sit in the secondary slot but
// enhance like armour. A per-slot boolean cannot express that, so it lives here.
const SF_SECONDARY = /shield|katara|magic arrow/i;

export function canStarForce(slot: SlotDef, it: Item | null): boolean {
  if (!slot.sf || !it) return false;
  if (it.noSf) return false;
  if (slot.id === "secondary") return SF_SECONDARY.test(it.sub || it.name || "");
  return true;
}

export function sfCap(it: Item | null): number {
  if (!it) return 0;
  if (it.sup) return 15;
  const L = it.lvl || 0;
  if (L >= 138) return 30;
  if (L >= 129) return 20;
  if (L >= 118) return 15;
  if (L >= 108) return 10;
  if (L >= 95) return 8;
  return 5;
}
function sfTarget(it: Item): number {
  const cap = sfCap(it);
  return cap >= 20 ? 17 : cap;
}

/* ==================================================================== */
/* pricing: attaching the number to a rec                                */
/* ==================================================================== */

/** Test hook. Turning the model off must reproduce the pre-pricing engine
 *  exactly — see __selfTest(). */
export function __setDamageModelEnabled(on: boolean): void {
  damageModelEnabled = on;
  planCache = new WeakMap();
}

/** Below this, a rec is not worth a badge: +0.05% damage per billion mesos.
 *  A product threshold, not a game constant — tune it freely. */
export const EFF_FLOOR = 5e-4;

/* The character-sheet targets. These were bare literals inside the advice
 * sentences; they are named now because they are also the END POINT of a damage
 * delta, which makes them load-bearing rather than decorative. They are
 * PRODUCT TARGETS, not game constants — nothing in the game caps boss damage at
 * 250% — so they are not in SOURCED and nothing needs to source them. Changing
 * one changes both the sentence and the number, which is the point. */
export const CRIT_DMG_TARGET = 60;
export const IED_TARGET = 95;
export const BOSS_TARGET = 250;

interface Price { dmg: number; cost: number; conf: Conf; note?: string }

// A wrong number presented as fact sends a real player to grind for nothing; an
// estimate labelled as an estimate does not. Every rec whose COST rests on an
// uncited constant says which constant.
const SF_NOTE =
  "Cost is the per-star curve from lib/starforce.ts, which is one community source rather than a patch note — treat the ordering as solid and the total as an estimate.";
const CUBE_NOTE = "Cost estimated; cube tier-up rates are not yet sourced.";
const GENERIC_NOTE = "Cost estimated; this figure is not yet sourced.";
// The one note about a DAMAGE figure rather than a cost. Boss Damage % shares an
// additive bucket with Damage %, which the game never prints, so a boss-damage
// row is the only row whose size depends on an assumption the player can check
// against their own character — see ASSUMED_DAMAGE_PCT.
const BOSS_BUCKET_NOTE =
  `Boss Damage % is added into the same bucket as Damage %, which the game does not print; this figure assumes ${ASSUMED_DAMAGE_PCT}% Damage%, so it is the most the line could be worth rather than the likeliest.`;

function fmtDmg(d: number): string {
  const pct = d * 100;
  const s = pct >= 10 ? pct.toFixed(0) : pct >= 0.1 ? pct.toFixed(1) : pct.toFixed(2);
  return `${d >= 0 ? "+" : ""}${s}% dmg`;
}
function fmtMeso(m: number): string {
  if (m <= 0) return "free";
  if (m >= 1e9) return `${(m / 1e9).toFixed(2)}B mesos`;
  if (m >= 1e6) return `${Math.round(m / 1e6)}M mesos`;
  return `${Math.round(m / 1e3)}K mesos`;
}

/** All-or-nothing by design. If the damage model returns null the rec keeps its
 *  authored text and authored priority and carries no number at all — never a
 *  cost with no damage, which would look like a fact and rank like nothing. */
function price(r: Rec, p: Price | null): Rec {
  if (!p || !Number.isFinite(p.dmg) || !Number.isFinite(p.cost) || p.cost < 0) return r;
  r.dmg = p.dmg;
  r.cost = p.cost;
  r.eff = p.cost > 0 ? p.dmg / (p.cost / 1e9) : Number.POSITIVE_INFINITY;
  r.conf = p.conf;
  r.t = `${fmtDmg(p.dmg)} · ${fmtMeso(p.cost)} — ${r.t}`;
  const mark = p.note ?? (p.conf === "placeholder" ? GENERIC_NOTE : "");
  if (mark) r.w = r.w ? `${r.w} ${mark}` : mark;
  return r;
}

/**
 * A damage number with NO meso cost, for the upgrades that are paid for in time
 * and arcane symbols rather than mesos.
 *
 * These deliberately do not get `cost` or `eff`, so they never enter the
 * meso-efficiency ranking and keep their authored priority — a zero cost would
 * divide into infinity and pin symbols to the top of the list forever, which is
 * true and useless. But "120 symbol levels left" is the single biggest lever on
 * this character's page, and shipping it as the only rec on the page with no
 * number attached is the opposite failure. So: the size, without the ratio, and
 * a sentence saying which currency it is actually billed in.
 */
function priceDamageOnly(r: Rec, dmg: number | null, conf: Conf, currency: string, note?: string): Rec {
  if (dmg === null || !Number.isFinite(dmg) || dmg <= 0) return r;
  r.dmg = dmg;
  r.conf = conf;
  r.t = `${fmtDmg(dmg)} — ${r.t}`;
  const mark = `${currency}, so it is not in the meso ranking.${note ? ` ${note}` : ""}`;
  r.w = r.w ? `${r.w} ${mark}` : mark;
  return r;
}

/** A tier's single-line value, with "none" worth nothing. */
function lineValue(band: PotBand, tier: Tier): number {
  return tier === "none" ? 0 : band[tier];
}

/**
 * Priority used to be authored, which meant two recs could only be compared by
 * how the author felt when typing the literal. Now it is read off the ranking:
 * the sort key is eff, and pri is the decile the rec lands in.
 *
 * The ranking is ACCOUNT-WIDE, not per slot. Ranking inside a slot would make
 * every slot's best rec a NOW — including the best rec of a finished slot — and
 * Planner.tsx turns lv === "hi" into the "needs attention" dot, so per-slot
 * deciles would light all 25 dots and mean nothing. Ranked globally, NOW means
 * "top 10% of everything you could spend a meso on", which is the question.
 *
 * Recs the model could not price keep their authored pri. If NOTHING is priced
 * this collapses to the old `sort((a,b) => a.pri - b.pri)` — the property
 * __selfTest() checks.
 *
 * THE DOMINANCE PASS, and why it is not a second invented ranking. Some recs
 * carry a damage number and no meso cost — symbol levels, hyper stats — and
 * they are deliberately kept out of the eff sort, because dividing by zero
 * mesos would pin them at the top forever. But leaving them entirely alone
 * produced a genuinely absurd page on the reference character: "+35% damage,
 * boss damage 159% → 250%, costs no mesos" sat at LATER while "+0.29% damage
 * for free cubes" sat at NOW. That is not a judgement call the ranking is
 * entitled to make. A rec that delivers MORE damage for FEWER mesos strictly
 * dominates, on the ranking's own axis, so it inherits the top band. No
 * threshold is invented: the bar is the best priced NOW rec's own damage.
 */
function assignPri(pool: Rec[]): void {
  const actionable = pool.filter((r) => typeof r.eff === "number" && r.pri !== 4);
  if (!actionable.length) return;
  // Compare rather than subtract: two free upgrades are both Infinity and
  // Infinity - Infinity is NaN, which leaves Array.sort's output undefined.
  const byEff = [...actionable].sort((a, b) => {
    const x = a.eff as number;
    const y = b.eff as number;
    return x === y ? (b.dmg ?? 0) - (a.dmg ?? 0) : y > x ? 1 : -1;
  });
  byEff.forEach((r, i) => {
    const q = i / byEff.length;
    r.pri = (r.eff as number) < EFF_FLOOR ? 4 : q < 0.1 ? 1 : q < 0.4 ? 2 : 3;
    r.lv = r.pri === 1 ? "hi" : r.pri === 2 ? "mid" : "ok";
  });

  // A rec that spends on an item the plan has told the player to REPLACE can
  // still be worth doing today - the damage is real until the replacement drops
  // - but it cannot hold the top band. NOW is competing against the replacement
  // itself, and this ranking cannot see that contest: a gear-tier delta is a
  // pair of item stat blocks neither of which is in this repo, so the upgrade
  // enters with no damage number and loses to anything carrying one. Capping
  // the band is the honest correction. Deleting the rec, or inventing a figure
  // for the upgrade so it wins on merit, are both worse.
  //
  // Without this, a Lv 140 glove showed "+0.09% for 3M mesos, reroll the flame"
  // above "replace this - it is below every tier on the ladder".
  for (const r of pool) {
    if (r.replaced && r.pri < 2) {
      r.pri = 2;
      r.lv = "mid";
    }
  }

  const bar = Math.max(0, ...byEff.filter((r) => r.pri === 1).map((r) => r.dmg ?? 0));
  if (!(bar > 0)) return;
  for (const r of pool) {
    if (typeof r.eff === "number") continue; // already in the meso ranking
    // Spending on an item the plan says to replace does not get promoted on
    // raw damage. The damage is real and temporary, and this pass cannot see
    // the difference - the slot that set the flag could.
    if (r.replaced) continue;
    if (r.pri === 4 || typeof r.dmg !== "number") continue;
    if (r.dmg >= bar) {
      r.pri = 1;
      r.lv = "hi";
    }
  }
}

/**
 * Priority band first, then damage per meso inside the band.
 *
 * A rec carrying a damage number and NO cost field came from priceDamageOnly(),
 * which means its meso cost is zero — so its damage per meso is infinite in the
 * same literal sense as a free cube's, and it sorts with the free upgrades.
 * Ties among the free ones break on raw damage, which is why "+35% damage, boss
 * damage 159% → 250%" now leads the page instead of trailing behind "1 wasted
 * flame line". It is still kept out of `eff` itself: `eff` is a published field
 * and writing Infinity into it would claim a meso price that was never paid.
 * Unpriced recs keep their authored order at the bottom of their band.
 */
function sortRecs(recs: Rec[]): Rec[] {
  const key = (r: Rec) =>
    r.eff !== undefined ? r.eff : r.dmg !== undefined && r.cost === undefined ? Number.POSITIVE_INFINITY : -1;
  // Subtraction is wrong here and always was: two free upgrades both score
  // Infinity, and Infinity - Infinity is NaN, which makes Array.sort's result
  // implementation-defined. Compare, do not subtract.
  const desc = (x: number, y: number) => (x === y ? 0 : y > x ? 1 : -1);
  return [...recs].sort(
    (a, b) => a.pri - b.pri || desc(key(a), key(b)) || desc(a.dmg ?? -1, b.dmg ?? -1),
  );
}

/* ---------- per-slot advice ---------- */

function buildAdvice(slot: SlotDef, ch: Character): Rec[] {
  const it = ch.items[slot.id] || null;
  const main = ch.main;
  const label = STAT_LABEL[main];
  const env = dmgEnvFor(ch);
  const st = ch.stats;
  const ctx = lineCtx(ch, slot.id);
  const farming = ctx.objective === "farm";
  // What a reroll on THIS item should be aimed at. On a boss item that is main
  // stat; on a dedicated farm carrier it is Mesos Obtained / Item Drop Rate,
  // and saying "reroll toward DEX%" there is the bug this seam exists to fix.
  const rerollTarget = farming ? "Mesos Obtained % / Item Drop Rate %" : `${label}%`;
  const recs: Rec[] = [];
  const add = (pri: Rec["pri"], lv: Rec["lv"], t: string, w = "") => {
    const r: Rec = { pri, lv, t, w };
    recs.push(r);
    return r;
  };
  /** Marks a rec as spend on THIS item. The ladder check at the bottom of this
   *  function needs to find them, and matching on rec text would break the
   *  first time someone rewords a string. */
  const inv = (r: Rec): Rec => { r.invest = true; return r; };

  if (!it) {
    const lad = LADDER[slot.id];
    // An overall occupies the top slot and leaves the bottom slot empty by
    // design; telling that player to go buy CRA pants is wrong advice.
    const top = ch.items.top;
    if (slot.id === "bottom" && top && /\b(overall|suit|robe)\b/i.test(top.name || "")) {
      add(4, "ok", "Covered by your overall.", `${top.name} occupies the top slot and fills this one.`);
    } else if (slot.pot === "no" && slot.id !== "emblem") {
      add(3, "mid", "Slot is empty.", "Free stat even with a basic item. No potential or star force here.");
    } else if (lad) {
      const [nm, lv] = lad[0];
      add(1, "hi", `Empty — ${nm} goes here.`, `${SOURCE[nm] || ""}${lv ? ` · Lv. ${lv}` : ""}`);
    } else {
      add(1, "hi", "Slot is empty.");
    }
    return recs;
  }

  if (slot.pot !== "no" && !it.noPot) {
    const tier: Tier = it.pot || "none";
    const lines = (it.p || []).filter(Boolean);
    const dead = lines.filter((l) => deadLine(l, main, ctx));
    const pct = lines.reduce((a, l) => a + statPct(l, main), 0);
    const band = potLineValue(it.lvl || 0);

    if (tier === "none") {
      inv(add(1, "hi", "No potential. Unlock it, then cube to Epic.", "Free Mystical and Hard cubes from bossing and Monster Park."));
    } else if (tier !== "legendary") {
      const next = TIER_NEXT[tier]!;
      const nx = TIER_LABEL[next];
      const how =
        tier === "rare" || tier === "epic"
          ? "Free Hard / Solid cubes from bossing. Cheap — do this before chasing extra lines."
          : "The expensive step. Save Bright cubes for it — they can double rank-up and let you pick a line.";
      const r = inv(add(1, "hi", `Tier up: ${TIER_LABEL[tier]} → ${nx}.`, how));

      // The guide's own spend order is free cubes up to Unique, Bright cubes
      // for the Unique -> Legendary step, so that is what each step is billed at.
      const cost = tier === "unique" ? CUBE_BRIGHT_MESO * PLACEHOLDER_CUBES_TO_TIER_UP[tier] : 0;
      const conf: Conf = cost > 0 ? "placeholder" : "modelled";
      const note = cost > 0 ? CUBE_NOTE : undefined;
      if (slot.pot === "stat" && !farming) {
        const gainPct = lineValue(band, next) - lineValue(band, tier);
        const flat = gainPct > 0 ? pctToFlat(ch, gainPct) : null;
        if (flat !== null) price(r, mk(relGain(st, withMain(st, flat), env), cost, conf, note));
      } else if (slot.pot === "stat" && farming) {
        // Tiering up a farm carrier is worth doing — Legendary is where meso
        // and drop lines live — but its payoff is mesos per hour, not damage.
        // Pricing it in damage would rank it against boss gear on an axis it
        // does not compete on, so it goes out with the reason and no number.
        r.w = `${r.w} On a farm carrier the payoff is a Mesos Obtained or Item Drop Rate line, which Legendary is the only tier that rolls — so this is worth more here than the damage model can express.`;
      } else if (slot.pot === "atk" && next === "legendary") {
        // Only the legendary step is priced here: it is the one whose payoff
        // the guide names (a boss-damage line), and PLACEHOLDER_POT_BOSS_LINE_PCT
        // is the only line size available at all.
        //
        // Two separate soft spots, so both are said out loud: the COST rests on
        // an unsourced cube rate (CUBE_NOTE) and the DAMAGE rests on assuming
        // 0% Damage% (BOSS_BUCKET_NOTE). This branch is only reachable from
        // tier 'unique', so `conf` here is already 'placeholder' on cost alone.
        const bossNote = [note, BOSS_BUCKET_NOTE].filter(Boolean).join(" ");
        price(r, mk(relGain(st, withBoss(st, PLACEHOLDER_POT_BOSS_LINE_PCT), env), cost, conf, bossNote));
      }
    }

    if (slot.pot === "stat") {
      if (dead.length) {
        inv(add(2, "mid", `${dead.length} dead line${dead.length > 1 ? "s" : ""} — reroll toward ${rerollTarget}.`,
          farming
            ? `${dead.join(" · ")} does nothing against normal mobs. This item is in your farming loadout only, so rerolling it costs you no boss damage.`
            : `${dead.join(" · ")} does nothing for you.`));
      }
      if (farming) {
        // THE POINT OF ADOPTING farming.isDeadLineFor, stated in advice rather
        // than just in a verdict. A dedicated farm carrier is not a damage
        // item, so the %main-stat milestone ladder below — "only 0% DEX, aim
        // for 19.5%" — is the wrong question asked loudly, on the one item
        // where the right answer is Mesos Obtained. The ladder is skipped here
        // and nothing replaces its NUMBER: meso and drop lines pay out in
        // mesos per hour, not in damage, and this file's model prices damage.
        // lib/farming.ts's scoreFarming()/recommendFarmLoadout() are where that
        // number lives; wiring them in is the farming page's job, not this
        // file's, and inventing a damage figure for a meso line here would be
        // exactly the confidently-wrong number the engine is built to refuse.
        const already = (it.p || []).filter((l) => /meso|drop/i.test(l)).length;
        add(already >= 2 ? 4 : 2, already >= 2 ? "ok" : "mid",
          already >= 2
            ? `${already} farm lines — this carrier is doing its job.`
            : `Farm carrier: ${already} of 3 meso/drop lines.`,
          "Judged for farming, not for bossing, because this item is in the farming loadout and nowhere else. Value is mesos per hour — see the farming page, not the damage model.");
      } else if (tier === "legendary") {
        const good = round1(band.legendary * MILESTONE_LINES_GOOD);
        const done = round1(band.legendary * MILESTONE_LINES_DONE);
        if (pct < good) {
          const have = band.legendary > 0 ? Math.floor(pct / band.legendary) : 0;
          const r = inv(add(2, "mid", `Only ${pct}% ${label}. Aim for ${good}%+.`,
            `${have} of 3 legendary lines at ${band.legendary}% each. A second good line is the next milestone.`));
          const flat = pctToFlat(ch, band.legendary);
          if (flat !== null) {
            price(r, mk(relGain(st, withMain(st, flat), env),
              CUBE_BRIGHT_MESO * PLACEHOLDER_CUBES_FOR_EXTRA_LEGENDARY_LINE, "placeholder", CUBE_NOTE));
          }
        } else if (pct < done) {
          add(3, "ok", `${pct}% ${label} — solid. Endgame is ${done}%+.`,
            "Third line. Low priority until symbols and star force are done.");
        } else {
          add(4, "ok", `${pct}% ${label} — this slot is finished.`, "Leave it alone.");
        }
      } else if (pct) {
        add(3, "mid", `Currently ${pct}% effective ${label}.`);
      }
    } else if (slot.pot === "atk") {
      // Plain "Damage +12%" is a strong line here too, not just boss/IED/ATT.
      const good = lines.filter((l) => /boss|ignore|\batt\b|attack|damage/i.test(l)).length;
      if (good < 2) add(2, "mid", "Aim for Boss Damage % / Ignore DEF % / ATT %.",
        "Highest damage-per-cube slot in the game. Target boss/boss/IED or att/boss/IED.");
      else add(3, "ok", `${good} damage lines — good.`,
        good >= 3 ? "This slot is finished." : "A third damage line is the next step.");
    } else if (slot.pot === "crit") {
      // Crit damage line values are not in the guide, so this slot stays
      // qualitative rather than carrying an invented number.
      const cd = lines.filter((l) => /crit/i.test(l)).length;
      if (!cd) add(3, "mid", "Gloves are the only slot that rolls Critical Damage %.",
        `Run ${label}% until the rest of your gear is done, then switch.`);
      else add(3, "ok", `${cd} crit damage line${cd > 1 ? "s" : ""}.`);
    }
  } else if (it.noPot && slot.pot !== "no") {
    add(4, "ok", "This item cannot take potential.", "Its tooltip reads “Potential : Can't Enhance”.");
  }

  if (canStarForce(slot, it)) {
    const cap = sfCap(it), tgt = sfTarget(it), raw = it.star || 0;
    const cur = Math.min(raw, cap);
    if (raw > cap) {
      // The cap is derived from the item's level, so more stars than the cap
      // allows means the LEVEL is wrong, not the stars. Say which to check.
      add(1, "hi", `Reads ${raw} stars, but Lv ${it.lvl} caps at ${cap}.`,
        "One of the two was misread. Fix the required level first — the cap comes from it.");
    }
    if (it.sup && cur < 15) {
      // Superior gear runs on its own rate table, which the guide names but
      // does not give, so this one stays unpriced.
      //
      // "Replace it with a non-superior piece" is sound for a standalone item and
      // ACTIVELY WRONG for a set piece: a Superior Gollux ring swapped out to reach
      // 30 stars loses the Superior Gollux set bonus, which is worth more than the
      // stars gained. This fired at priority 1 on EVERY superior item regardless,
      // which is the exact mistake lib/sets.ts exists to prevent - and sets.ts was
      // imported by nobody, so the model that knew better never saw the question.
      const piece = resolveSet(slot.id, it);
      if (piece) {
        // Name the bonus actually at risk at this character's current piece count,
        // not the set's theoretical maximum.
        const live = activeSets(ch.items).find((a) => a.setId === piece.setId);
        const lost = live && !isEmptyEffects(live.effects) ? describeEffects(live.effects) : "";
        const at = live ? ` (${live.count} piece${live.count === 1 ? "" : "s"} equipped)` : "";
        inv(add(2, "mid", `Superior gear — caps at 15 stars, currently ${cur}.`,
          `Expensive per star, but this is a ${piece.setName} piece${at}. Replacing it to ` +
          `reach 30 stars gives up ${lost || "the set bonus"}, which is usually worth more ` +
          `than the extra stars. Finish the set first, then reconsider.`));
      } else {
        inv(add(1, "hi", `Superior gear — caps at 15 stars, currently ${cur}.`,
          "Expensive per star, and this piece is not in a set. A non-superior " +
          "replacement goes to 30 instead."));
      }
    } else if (cur === 0) {
      // It used to say "free power sitting on the floor". With the real per-star
      // curve in front of it that sentence now sits next to a nine-figure price
      // tag and reads as a lie. Nothing below 15 can boom — that is what was
      // actually free, and it is all this claims now.
      const r = inv(add(1, "hi", "0 stars. Nothing below 15 can boom, so this is risk-free.",
        "Mesos and time only, no destruction. Push to 15 during a 5/10/15 event."));
      priceStars(r, it, ch, env, 0, Math.min(15, cap));
    } else if (cur < tgt) {
      const r = inv(add(2, "mid", `${cur} → ${tgt} stars.`,
        `${cap >= 20 ? "Below 15 there is no boom risk. " : ""}Only tap past 15 during a 5/10/15 or 30%-off event.`));
      priceStars(r, it, ch, env, cur, tgt);
    } else if (cap >= 20 && cur < 22) {
      const r = inv(add(3, "ok", `${cur} stars. Next milestone is 22.`, "Safeguard through 18, and only on event weekends."));
      priceStars(r, it, ch, env, cur, 22);
    } else {
      add(4, "ok", `${cur}/${cap} stars.`);
    }
  } else if (slot.sf && it) {
    add(4, "ok", "This item cannot be star forced.",
      slot.id === "secondary"
        ? "Only shields take star force in the secondary slot. Fletchings, charms, chess pieces and the rest have no upgrade slots."
        : "Its tooltip has no star force row.");
  }

  if (slot.fl && !it.noFl) {
    const fl = (it.f || []).filter(Boolean);
    // Flames are judged on the BOSS objective even on a farm carrier, and that
    // is not an oversight: bonus stats have no Mesos Obtained or Item Drop Rate
    // line to roll, so the farm objective has nothing different to say about
    // them. Passing ctx here would be noise dressed as precision.
    const badf = fl.filter((l) => deadLine(l, main));
    const advantaged = it.bossDrop
      ? " This is boss-drop gear, so it is flame advantaged — tier 4 minimum and up to tier 7. Worth more rerolls than ordinary gear."
      : "";
    if (!fl.length && it.fUnknown) {
      // NOT the same as having no bonus stats, and the difference is expensive.
      // Telling a player to roll a flame on an item that already has four good
      // lines costs them 3,000,000 mesos and the lines. Unpriced on purpose:
      // there is no gain to model when the starting point is unknown.
      add(3, "mid", "Bonus stats not read.",
        "The screenshot showed the item tooltip but not the Bonus Stats panel, and a tooltip cannot tell bonus stats from star force — both land on the same line and only the colour differs. Open Enhance › Bonus Stats and re-import, or type the lines in. Until then this slot is not judged on flames either way.");
    } else if (!fl.length) {
      const r = inv(add(2, "mid", "No flame. Roll one.",
        `Bonus stats reset for 3,000,000 mesos since v.271 — at Black Flame rates.${advantaged}`));
      priceFlame(r, it, ch, env);
    } else if (badf.length) {
      const r = inv(add(1, "hi", `${badf.length} wasted flame line${badf.length > 1 ? "s" : ""} — reset it.`,
        `${badf.join(" · ")}. A reset is 3,000,000 mesos. The cheapest fix on the page.${advantaged}`));
      priceFlame(r, it, ch, env);
    } else {
      add(4, "ok", "Flame is working.",
        `Best lines are All Stat %, then flat ${label}, then ATT.${advantaged}`);
    }
  } else if (slot.fl && it.noFl) {
    add(4, "ok", "This item cannot take flames.");
  } else if (slot.id === "shoulder" || slot.id.startsWith("ring")) {
    add(4, "ok", "This slot cannot take flames.");
  }

  /* ---------- where this item sits on its ladder ----------
   *
   * The guard here used to be `idx > -1 && idx < lad.length - 1`, and the
   * first half of it silently deleted the most important case on the page.
   * idx is -1 when the item clears NO rung - a Lv 140 Pensalir glove against a
   * ladder that opens at Absolab 160 - so the slot holding the worst item in
   * the loadout was the one slot that got no upgrade advice at all. The player
   * who hit it asked exactly the right question: "what do i even replace this
   * with?" There was no answer because the branch did not exist.
   */
  const lad = LADDER[slot.id];
  if (lad) {
    // RANK AGAINST THE WHOLE LADDER. An earlier attempt filtered the array
    // first and that was wrong in a way worth recording: removing a rung
    // shifts every index above it, so a Lv 140 Kanna's Treasure at 17 stars -
    // which clears rung zero - was reported as clearing nothing and got
    // "Outclassed" instead of "Next tier". Where the item SITS is a fact about
    // the item; what the player can equip NEXT is a fact about the loadout.
    let idx = -1;
    lad.forEach((rung, i) => { if (it.lvl >= rung[1]) idx = i; });

    // Walk up from the rung above this item to the first one the player is not
    // already wearing somewhere else. Reported from the running app: ring2 held
    // Ifia's Ring and the planner said "Kanna's Treasure is the upgrade here"
    // while Kanna's Treasure sat on ring1 at 17 stars. You cannot wear two.
    const skipped: string[] = [];
    let next = idx + 1;
    while (next < lad.length && wornInSibling(ch, slot.id, lad[next][0])) {
      skipped.push(lad[next][0]);
      next++;
    }
    // "another ring slot", not "another ring 2 slot" - the family name, since
    // the point is that the item is on a SIBLING.
    const family = slot.n.replace(/\s*\d+$/, "").toLowerCase();
    const alreadyNote = skipped.length
      ? ` ${skipped.join(" and ")} ${skipped.length > 1 ? "are" : "is"} skipped — already equipped in another ${family} slot.`
      : "";

    if (!(it.lvl > 0)) {
      // Every rung is level-gated, so with no level there is nothing to compare
      // against. Reporting "outclassed" from a missing field would be inventing
      // a verdict out of an import failure - the one thing this engine refuses
      // to do. Ladders whose first rung is level 0 never reach here.
      add(3, "mid", "Item level unknown — can't rank this slot.",
        "Set the required level and this slot will name its next tier. The importer reads it from the tooltip's “REQ LEV” line.");
    } else if (next >= lad.length) {
      // Nothing left to offer: either the item is on the top rung, or every
      // rung above it is already on a sibling. Saying nothing is right.
    } else if (idx === -1) {
      const [nm, lv] = lad[next];
      const r = add(1, "hi", `Outclassed — ${nm} is the upgrade here.`,
        `${SOURCE[nm] ? `${SOURCE[nm]}. ` : ""}${lv ? `Lv. ${lv}. ` : ""}` +
        `This item is below every tier on this slot's ladder, so replacing it is the ` +
        `biggest single upgrade available here - bigger than anything you can do TO it.` +
        alreadyNote);

      // Everything above this line was advice to spend on an item the player
      // has just been told to replace, and none of that spend survives the
      // swap: potential does not carry over, and neither do flames.
      //
      // Two different corrections, because the recs are not alike:
      //
      //   - The PRICED ones are ranked by assignPri() on real damage per meso,
      //     and that ranking is not wrong. Star forcing a Pensalir glove to 15
      //     does buy damage today, and a player who cannot reach Lotus yet is
      //     entitled to it. Those keep their band and gain the caveat.
      //   - The UNPRICED ones keep whatever priority this function authored,
      //     and "Tier up to Legendary" sitting at NOW directly under "replace
      //     this item" is the planner contradicting itself on one screen.
      //     Those drop to LATER.
      //
      // `replaced` also stops assignPri()'s second pass from promoting any of
      // them back to NOW on damage alone - that pass cannot see that the damage
      // is temporary, and this branch can.
      //
      // Deliberately NOT claimed: that star force partially survives via
      // Transfer Hammer. It does, but the level span it allows and the stars it
      // costs are both unsourced in this repo, and a wrong span here sends
      // someone to hammer an item that cannot take it.
      for (const rec of recs) {
        if (rec === r || !rec.invest) continue;
        rec.replaced = true;
        const priced = typeof rec.eff === "number";
        if (!priced && rec.pri < 3) {
          rec.pri = 3;
          rec.lv = "ok";
        }
        // Names only what is actually lost. This used to say "potential and
        // flames are lost", and Nexon's own guide says Potential and Bonus
        // Potential are exactly what a Transfer Hammer CARRIES - see
        // TRANSFER_HAMMER. Telling a player their cubes die with the item,
        // when the game hands them a way to move those cubes onto the
        // replacement, talks them out of a cheap upgrade.
        const ceil = transferHammerCeiling(it.lvl);
        const reach =
          ceil !== null && lv > 0 && ceil >= lv
            ? ` Star force and potential can follow it: a Transfer Hammer reaches Lv. ${ceil} from Lv. ${it.lvl}, and ${nm} sits at Lv. ${lv}.`
            : ceil !== null && lv > 0
              ? ` A Transfer Hammer only reaches Lv. ${ceil} from Lv. ${it.lvl}, short of ${nm} at Lv. ${lv}, so this investment does not follow.`
              : "";
        rec.w = `${rec.w} Worth less than it looks: this item is below ${nm}.${reach} Bonus stats are believed not to carry either way.`.trim();
      }
    } else {
      const [nm, lv] = lad[next];
      // Not priced: the stat delta between two gear tiers is a pair of item
      // stat blocks, and neither is in this repo.
      add(3, "ok", `Next tier: ${nm}${lv ? ` (Lv. ${lv})` : ""}.`,
        `${SOURCE[nm] || ""}${nextTierTransferNote(it.lvl, lv, nm)}${alreadyNote}`);
    }
  }

  return recs;
}

function mk(dmg: number | null, cost: number, conf: Conf, note?: string): Price | null {
  return dmg === null ? null : { dmg, cost, conf, note };
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function priceStars(r: Rec, it: Item, ch: Character, env: DmgEnv, from: number, to: number): void {
  if (it.sup || !(it.lvl > 0) || to <= from) return;
  const p = sfPlanBest(it.lvl, from, to);
  if (!p) return;
  const gain = sfStatGain(from, to);
  const after = withAtt(withMain(ch.stats, gain.main), gain.att);
  const dmg = relGain(ch.stats, after, env);
  if (dmg === null) return;
  const risky = p.booms >= 0.005;
  const head = risky
    ? `Expected ${p.taps.toFixed(0)} taps and ${p.booms.toFixed(2)} booms ${p.safeguard ? "with" : "without"} protection, counting the re-climb after each boom. Replacing a boomed item is not priced.`
    : `Expected ${p.taps.toFixed(0)} taps and no boom risk in this range.`;

  // The two branches are compared on tap mesos, and tap mesos are the only part
  // of a boom that can be priced — a Trace needs a fresh copy of the same
  // equip, and what that copy costs is a drop table, not a price. So when the
  // cheaper branch is the unguarded one, say what the guarded one would have
  // cost rather than letting an unpriced externality make the decision quietly.
  let guardLine = "";
  if (risky && !p.safeguard) {
    const g = sfPlan(it.lvl, from, to, true);
    if (g && g.booms < p.booms) {
      guardLine = ` The protected route costs ${fmtMeso(g.mesos)} for ${g.booms.toFixed(2)} booms instead — dearer in mesos, and above 17 stars it also lowers your success rate, which is already priced in here.`;
    }
  }

  price(r, {
    dmg,
    cost: p.mesos,
    conf: p.conf,
    note: `${head}${guardLine} ${sfNote(p)}`,
  });
}

/** Names the exact soft constants a star force quote leaned on, using
 *  lib/starforce.ts's own labels, instead of one vague sentence for all of
 *  them. Plus the one this file owns: what a star is actually worth. */
function sfNote(p: SfPlan): string {
  const names = p.unverified.map((u) => UNVERIFIED_LABEL[u]);
  names.push("Stat and ATT gained per star (lib/rules.ts placeholder; starforce.ts declines to guess it)");
  return `${SF_NOTE} Unverified inputs: ${names.join("; ")}.`;
}

function priceFlame(r: Rec, it: Item, ch: Character, env: DmgEnv): void {
  if (!(it.lvl > 0)) return;
  const fl = (it.f || []).filter(Boolean);
  // A flame carrying ATT is common on weapons and gloves and we have no tier
  // table for ATT lines, so rather than quietly valuing those lines at zero —
  // which would recommend destroying them — this one goes unpriced.
  if (fl.some((l) => attFlat(l) > 0)) return;

  let current = 0;
  for (const l of fl) {
    current += statFlat(l, ch.main);
    const p = statPct(l, ch.main);
    if (p) {
      const f = pctToFlat(ch, p);
      if (f === null) return;
      current += f;
    }
  }
  const tier = it.bossDrop ? FLAME_TIER_FLOOR_ADVANTAGED : FLAME_TIER_FLOOR_ORDINARY;
  const expected = PLACEHOLDER_FLAME_MAIN_STAT_LINES * tier * PLACEHOLDER_FLAME_UNIT_PER_TIER(it.lvl);

  // v.271 lets you keep the better of the two rolls, so a reset can never lose
  // stat and its true expectation is E[max(old, new)] - old, which is strictly
  // positive. We do not have the tier distribution, only the guaranteed floor,
  // so all we can compute is the lower bound E[new at floor] - old. On an item
  // whose existing flame already beats an average floor roll that bound is zero
  // or negative, and a zero is not a number worth showing next to "the cheapest
  // fix on the page" — so the rec goes out unpriced and keeps its authored
  // priority rather than claiming a reroll is worthless. Sourcing the bonus
  // stat tier distribution is what turns this into a real number.
  const delta = expected - current;
  if (!(delta > 0)) return;
  const dmg = relGain(ch.stats, withMain(ch.stats, delta), env);
  if (dmg === null) return;
  price(r, {
    dmg,
    cost: FLAME_RESET_MESO,
    conf: "modelled",
    note: `The 3M is exact; the gain is modelled at the tier-${tier} floor this item is guaranteed, so the real roll can only beat it.`,
  });
}

/* ---------- the plan, built once per character ----------
 * Planner.tsx calls advise() for all 25 slots inside its render map purely to
 * compute a boolean, so every mouse move used to be 25 passes through the rule
 * set — and each of those passes now solves a Markov chain per star-forceable
 * item. Build the whole account plan once and cache it on the Character object
 * itself: every update in Planner produces a new object ({ ...ch, ... }), so a
 * new object is exactly the signal that the cache is stale, and a WeakMap lets
 * the old one be collected.
 *
 * The returned arrays are shared between callers. Treat them as immutable. */
interface Plan {
  bySlot: Map<string, Rec[]>;
  char: Rec[];
  all: Rec[];
}

function buildPlan(ch: Character): Plan {
  const bySlot = new Map<string, Rec[]>();
  const pool: Rec[] = [];
  for (const s of SLOTS) {
    const rs = buildAdvice(s, ch).map((r) => ({ ...r, slot: s.id }));
    bySlot.set(s.id, rs);
    pool.push(...rs);
  }
  const char = buildCharAdvice(ch).map((r) => ({ ...r, slot: "character" }));
  pool.push(...char);

  assignPri(pool);

  for (const [id, rs] of bySlot) bySlot.set(id, sortRecs(rs));
  return { bySlot, char: sortRecs(char), all: sortRecs(pool) };
}

function plan(ch: Character): Plan {
  let p = planCache.get(ch);
  if (!p) {
    p = buildPlan(ch);
    planCache.set(ch, p);
  }
  return p;
}

export function advise(slot: SlotDef, ch: Character): Rec[] {
  const hit = plan(ch).bySlot.get(slot.id);
  // A slot outside SLOTS is not part of the account-wide ranking, so it gets
  // the old local ordering rather than silently returning nothing.
  return hit ?? sortRecs(buildAdvice(slot, ch));
}

/* ---------- character-level advice ---------- */
function buildCharAdvice(ch: Character): Rec[] {
  const st = ch.stats;
  const label = STAT_LABEL[ch.main];
  const env = dmgEnvFor(ch);
  const out: Rec[] = [];
  const add = (pri: Rec["pri"], lv: Rec["lv"], t: string, w = "") => {
    const r: Rec = { pri, lv, t, w };
    out.push(r);
    return r;
  };

  // SAY SO, rather than letting a page full of numberless recs read as a bug.
  // Every damage figure has been withheld for this character (see the gate in
  // dmgIndex), and a player is owed the reason in one sentence before they go
  // looking for the missing percentages.
  const model = damageModelStatus(ch);
  if (!model.verified)
    add(2, "mid", `Damage is not modelled for ${model.cls} yet.`,
      `${model.why} Gear slots, star force, flames, potential tiers and set effects are class-independent and all still apply — it is only the damage percentages that are missing, and they are missing on purpose.`);
  else if (!hasDamagePctReading(ch))
    add(3, "ok", "Your printed DAMAGE % is not recorded.",
      `The stat window prints it — the reference Bow Master reads ${VALIDATED_DAMAGE_PCT}% — and without it every Boss Damage figure on this page is an upper bound, because Boss Damage and Damage share one additive bucket. Nothing else on the page moves with it.`);

  if (st.crit >= 100)
    add(1, "hi", `Crit rate is capped at ${st.crit}%.`,
      "Every point of crit rate hyper stat and every crit rate line is dead. Move it all to crit damage.");
  else if (st.crit >= 95)
    add(2, "mid", `Crit rate ${st.crit}% — nearly capped.`, "Find the last few points cheaply, then stop investing.");

  if (st.critdmg && st.critdmg < CRIT_DMG_TARGET) {
    const r = add(2, "mid", `Crit damage ${st.critdmg}% is low.`,
      `Hyper stat, gloves potential, link skills and legion. Target ${CRIT_DMG_TARGET}%+.`);
    priceDamageOnly(r, relGain(st, withCritDmg(st, CRIT_DMG_TARGET), env), "modelled",
      "Paid for in hyper stat points and link levels, not mesos",
      `That is the whole ${st.critdmg}% → ${CRIT_DMG_TARGET}% move.`);
  }
  if (st.ied && st.ied < IED_TARGET) {
    const r = add(2, "mid", `IED ${st.ied}% — push toward ${IED_TARGET}%.`,
      "Arcane bosses sit at 300% defense, Grandis at 380%.");
    // IED is the ONE stat whose value does not cancel out of the ratio: it
    // interacts with enemy defense, and ENEMY_DEF_ARCANE is uncited. So this
    // number is the one on this page that genuinely moves if that constant is
    // wrong, and it is labelled accordingly rather than sharing the 'modelled'
    // badge with the stat gains.
    priceDamageOnly(r, relGain(st, withIed(st, IED_TARGET), env), "placeholder",
      "Paid for in hyper stat points, familiars and potential lines, not mesos",
      `Assumes ${Math.round(ENEMY_DEF_ARCANE * 100)}% enemy defense, which is the one uncited number in this figure — against Grandis' ${Math.round(ENEMY_DEF_GRANDIS * 100)}% the same IED is worth more.`);
  }
  if (st.boss && st.boss < BOSS_TARGET) {
    const delta = BOSS_TARGET - st.boss;
    const r = add(3, "mid", `Boss damage ${st.boss}%.`,
      `Hyper stat, weapon/secondary/emblem lines, familiars. Endgame is 300%+.`);
    // Boss damage is the one stat on this page whose figure moves with the
    // damage-% assumption, because the two share a single additive bucket (see
    // ASSUMED_DAMAGE_PCT). So it does not get the 'modelled' badge the crit and
    // stat rows get: the ordering is sound, the magnitude is an upper bound, and
    // 'placeholder' is this file's word for exactly that. The probe puts a
    // second, smaller number in the player's hands rather than asserting a bias
    // they cannot see.
    //
    // A character that RECORDS its Damage % escapes all of that: the bucket is
    // then the real one, the figure is no longer an upper bound, and it gets
    // the 'modelled' badge the crit and stat rows get. Which of the two
    // sentences below a player reads is therefore a fact about their own sheet.
    const probe = relGain(st, withBoss(st, delta), { ...env, dmgPct: DAMAGE_PCT_BIAS_PROBE });
    const known = hasDamagePctReading(ch);
    priceDamageOnly(r, relGain(st, withBoss(st, delta), env), known ? "modelled" : "placeholder",
      "Hyper stat points and familiars cost no mesos; the weapon, secondary and emblem lines are cubes, which do",
      known
        ? `That is the whole ${st.boss}% → ${BOSS_TARGET}% move at your recorded ${st.damagePct}% Damage%. Boss Damage is added into the same bucket as Damage%, so this figure is computed against your real bucket rather than against an assumed empty one.`
        : `That is the whole ${st.boss}% → ${BOSS_TARGET}% move, and it assumes ${DEFAULT_DAMAGE_PCT}% Damage% — your character sheet has no reading for that stat. Boss Damage is added into the same bucket as Damage%, so your real Damage% makes this number SMALLER, never bigger${probe === null ? "" : `: at +${DAMAGE_PCT_BIAS_PROBE}% Damage% the same move is worth ${fmtDmg(probe)}`}. Record your printed DAMAGE % and this figure becomes exact.`);
  }
  if (st.hp && st.hp < 60000)
    add(2, "mid", `HP ${st.hp.toLocaleString()} is thin for Lucid/Will.`,
      "Max HP hyper stat, Decent Hyper Body on your bottom, Demon Avenger link.");

  if (st.arcane) {
    const lv = Math.max(0, Math.round((st.arcane - 120) / 10));
    const left = 120 - lv;
    if (left > 0) {
      const flat = left * 10 * ARCANE_MAIN_STAT_PER_FORCE;
      const r = add(1, "hi", `${left} Arcane symbol levels left (+${flat.toLocaleString()} ${label}).`,
        `Arcane Power ${st.arcane} of 1,320. Symbol stat is flat and is not multiplied by your %stat — which is why %lines are worth less than they look right now.`);
      priceDamageOnly(r, relGain(st, withMain(st, flat), env), "modelled",
        "Paid for in daily Arcane River dailies, not mesos",
        "It is the largest single number on this page, and the reason it does not sit at the top of the meso ranking is that dividing by a zero meso cost would pin it there forever.");
    }
  }
  if (st.starforce && st.starforce < 260)
    add(2, "mid", `Total star force ${st.starforce}.`,
      "Everything at 17 stars is roughly 290+. One of the two biggest levers you have.");

  // Hyper stats and symbol levels stay OUT of the meso ranking: they are paid
  // for in time and arcane symbols, and dividing a damage gain by a meso cost
  // of zero would put them permanently at the top. They now carry the damage
  // number without the ratio — see priceDamageOnly().
  // TODO: a second efficiency axis (damage per day of play) is the honest way
  // to rank these against gear.
  return out;
}

export function charAdvice(ch: Character): Rec[] {
  return plan(ch).char;
}

/* ---------- the whole-account answer ----------
 * "Which single upgrade buys me the most damage per meso?" — one ranked list
 * across all 25 slots plus the character sheet, instead of asking the player to
 * hover 25 slots and read prose. Additive: advise() and charAdvice() keep their
 * exact signatures and Planner.tsx keeps compiling untouched. */
export function planAdvice(ch: Character): Rec[] {
  return plan(ch).all;
}

/* ---------- degradation self-test ----------
 * The contract is that the pricing layer is invisible when it cannot price:
 * with the damage model off, advise() and charAdvice() must return exactly what
 * the pre-pricing engine returned — same strings, same priorities, same order,
 * and no dmg/cost/eff/conf fields anywhere. This is a function rather than a
 * spec file because this session owns only lib/rules.ts; call it from a test
 * runner, or from a scratch script, and assert ok === true. */
export function __selfTest(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const prev = damageModelEnabled;
  try {
    for (const ch of [exampleCharacter(), emptyCharacter()]) {
      __setDamageModelEnabled(false);
      const off: Rec[][] = [...SLOTS.map((s) => advise(s, ch)), charAdvice(ch)];
      const raw: Rec[][] = [
        ...SLOTS.map((s) => [...buildAdvice(s, ch)].sort((a, b) => a.pri - b.pri)),
        [...buildCharAdvice(ch)].sort((a, b) => a.pri - b.pri),
      ];
      off.forEach((list, i) => {
        const want = raw[i];
        if (list.length !== want.length) {
          failures.push(`list ${i}: length ${list.length} !== ${want.length}`);
          return;
        }
        list.forEach((r, j) => {
          const w = want[j];
          if (r.pri !== w.pri || r.lv !== w.lv || r.t !== w.t || r.w !== w.w)
            failures.push(`list ${i}[${j}]: "${r.t}" !== "${w.t}"`);
          if (r.dmg !== undefined || r.cost !== undefined || r.eff !== undefined || r.conf !== undefined)
            failures.push(`list ${i}[${j}]: carries a number with the model off`);
        });
      });
      __setDamageModelEnabled(true);
      const on = SLOTS.flatMap((s) => advise(s, ch));
      if (on.some((r) => r.pri < 1 || r.pri > 4)) failures.push("pri left the 1..4 range Planner.tsx indexes");
    }

    // The guide table and the simulator's table are now two copies of the same
    // data in two files. Two copies drift. This is the check that says so, in
    // the only place that can compare them.
    for (const row of STAR_ROWS_MODE1) {
      const g = SF_RATES[row.from];
      if (!g) continue;
      const near = (a: number, b: number) => Math.abs(a - b) <= 0.0005;
      if (!near(g.p, row.success) || !near(g.b, row.boom)) {
        failures.push(
          `star ${row.from}: guide-graph says ${(g.p * 100).toFixed(1)}%/${(g.b * 100).toFixed(2)}% boom, ` +
            `starforce.STAR_ROWS says ${(row.success * 100).toFixed(1)}%/${(row.boom * 100).toFixed(2)}%`,
        );
      }
    }

    // The whole point of requirement 3, asserted rather than described: the
    // deprecated curve must not be what anyone is quoted.
    const lv200 = sfPlan(200, 11, 12, false);
    if (lv200 && Math.abs(lv200.mesos - PLACEHOLDER_SF_TAP_MESO(200, 11)) < 1e6) {
      failures.push("sfPlan is still quoting PLACEHOLDER_SF_TAP_MESO");
    }

    // THE LADDER, on every slot that has one. The bug this replaces was not a
    // wrong answer, it was NO answer: gear below rung zero fell through the
    // guard and its slot said nothing about replacing it, which is the one
    // thing a player looking at four-tier-stale gear needs to read. A silent
    // slot is invisible in a screenshot, so it gets an assertion instead.
    __setDamageModelEnabled(true);
    for (const slot of SLOTS) {
      const lad = LADDER[slot.id];
      // A ladder opening at level 0 has no below-rung case to test.
      if (!lad || lad[0][1] <= 1) continue;
      const ch = exampleCharacter();
      ch.items = { ...ch.items, [slot.id]: { name: "Below rung zero", lvl: Math.max(1, lad[0][1] - 10), star: 0, pot: "epic", sup: 0, p: [], f: [] } };
      const recs = advise(slot, ch);
      const top = recs.find((r) => /^Outclassed/.test(r.t));
      if (!top) {
        failures.push(`${slot.id}: below-rung item gets no replacement advice`);
        continue;
      }
      if (top.pri !== 1) failures.push(`${slot.id}: replacement advice sits at pri ${top.pri}, not 1`);
      // It must name the first rung the player can actually EQUIP, which is not
      // always rung zero: a ring already on a sibling finger is skipped. Asserting
      // rung zero flatly would re-enshrine the bug where ring2 was told to go get
      // the Kanna's Treasure already worn on ring1.
      const wantRung = lad.find((r) => !wornInSibling(ch, slot.id, r[0]));
      if (wantRung && !top.t.includes(wantRung[0]))
        failures.push(`${slot.id}: replacement advice names neither ${wantRung[0]} nor an equippable rung`);
      // Nothing that spends on the doomed item may outrank replacing it.
      const above = recs.filter((r) => r.replaced && r.pri < top.pri);
      if (above.length) failures.push(`${slot.id}: ${above.length} doomed-item rec(s) rank above the replacement`);
      if (recs.some((r) => r.invest && !r.replaced))
        failures.push(`${slot.id}: an investment rec was not flagged replaced`);
    }

    // An import that failed to read the required level must not be reported as
    // a verdict about the item. lvl 0 clears no rung, which is indistinguishable
    // from "outclassed" unless this case is handled first.
    {
      const slot = SLOTS.find((x) => x.id === "gloves")!;
      const ch = exampleCharacter();
      ch.items = { ...ch.items, gloves: { name: "Level unread", lvl: 0, star: 0, pot: "epic", sup: 0, p: [], f: [] } };
      const recs = advise(slot, ch);
      if (recs.some((r) => /^Outclassed/.test(r.t)))
        failures.push("an item with no level was called outclassed");
      if (!recs.some((r) => /level unknown/i.test(r.t)))
        failures.push("an item with no level does not say so");
    }
  } finally {
    __setDamageModelEnabled(prev);
  }
  return { ok: failures.length === 0, failures };
}

/* ==================================================================== */
/* the account: many characters, one active                              */
/* ==================================================================== */
/*
 * The planner held exactly ONE character while the roster read 31 off the
 * Switch Character screenshots and could only look at them. This is the join.
 *
 * TWO THINGS DECIDE THE SHAPE, and both are constraints rather than taste:
 *
 *   1. IDENTITY SURVIVES A RENAME. Characters are keyed by an opaque
 *      CharacterId that is generated once and never derived from the name, so
 *      renaming "Archerroni" changes one string in one record and every
 *      reference still resolves. Keying by name would have been smaller and
 *      would have silently orphaned a character the first time someone used a
 *      name change coupon.
 *
 *   2. THE ROSTER HAS TO BE ABLE TO POINT AT A CHARACTER. A roster entry is
 *      three fields read off a screenshot; a Character is 25 slots of gear. The
 *      link lives in `rosterLinks`, keyed by rosterKey(name) — the SAME
 *      normalisation legion.mergeRoster() matches on, because two
 *      normalisations across two files is a silent join failure. The roster
 *      stays the screenshot's truth and the link is the app's.
 *
 * The roster is ACCOUNT data. It lived on Character only because there was one
 * Character; `Account.roster` is now the authority and Character.roster is a
 * deprecated read-side projection kept so existing UI keeps rendering.
 */

export const ACCOUNT_SCHEMA_VERSION = 2 as const;

export interface Account {
  /** Schema version of the PERSISTED shape. 1 was a bare Character at
   *  LEGACY_CHARACTER_KEY and was never stamped, which is why migrateToAccount()
   *  sniffs rather than reads a version. */
  v: typeof ACCOUNT_SCHEMA_VERSION;
  /** Keyed by CharacterId. Insertion order is display order. */
  characters: Record<CharacterId, Character>;
  /** The character the planner is editing. Always a key of `characters` — every
   *  constructor and mutator in this file repairs it rather than allowing a
   *  dangling id. */
  activeId: CharacterId;
  /** Every character on the account, read from the Switch Character window.
   *  Account-wide: it describes the account, not whoever happens to be active. */
  roster?: RosterChar[];
  /** rosterKey(roster name) -> CharacterId. A roster entry with no link is a
   *  character that exists in game and has no gear recorded here yet. */
  rosterLinks?: Record<string, CharacterId>;
}

/** localStorage key for the pre-account single character. NEVER deleted by the
 *  migration — see lib/storage.ts. */
export const LEGACY_CHARACTER_KEY = "maple-planner:character";
/** localStorage key for the Account. */
export const ACCOUNT_KEY = "maple-planner:account";

/** Stable id for the demo character, so reloading the demo cannot fork it into
 *  a second entry on the account. */
export const EXAMPLE_CHARACTER_ID = "demo-archerroni";

/** Opaque, collision-resistant, and not derived from anything the player can
 *  edit. crypto.randomUUID where it exists; a time+random id otherwise, which
 *  is enough for a per-browser account of a few dozen characters. */
export function newCharacterId(): CharacterId {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** THE roster join key. Identical to legion.mergeRoster()'s matching — lowercase
 *  and trim, nothing cleverer, because the roster is matched on the one field a
 *  screenshot spells consistently. */
export function rosterKey(name: string): string {
  return (name || "").toLowerCase().trim();
}

/** Which MainStat a class scales on, resolved through lib/classes.ts rather than
 *  restated. Returns null when the class roster has no row, or when neither of
 *  its stats is one of the four the planner models. */
export function mainStatFromClass(cls: string): MainStat | null {
  const rec = findClass(cls);
  if (!rec) return null;
  const ok = (s: string): MainStat | null => {
    const k = (s || "").toLowerCase();
    return k === "dex" || k === "str" || k === "int" || k === "luk" ? (k as MainStat) : null;
  };
  // Fall back to the SECONDARY stat for the classes whose primary is HP — Demon
  // Avenger scales on HP, which `MainStat` has no member for, and STR is what
  // its gear actually rolls.
  return ok(rec.primaryStat) ?? ok(rec.secondaryStat);
}

/* ---------- reading an account ---------- */

export function characterIds(a: Account): CharacterId[] {
  return Object.keys(a.characters);
}

/** Every character, each carrying its own id. Insertion order. */
export function listCharacters(a: Account): Character[] {
  return characterIds(a).map((id) => ({ ...a.characters[id], id }));
}

/**
 * The character the planner is editing.
 *
 * Two things are guaranteed that the raw record does not guarantee: `id` is
 * filled in, and `roster` is projected down from the account so that UI written
 * against the old single-character shape keeps rendering. The projection is
 * READ-ONLY — `withActiveCharacter()` strips the field again, and `setRoster()`
 * is the only writer of the real one.
 */
export function activeCharacter(a: Account): Character {
  const ch = a.characters[a.activeId];
  if (!ch) {
    // A dangling activeId means a corrupted or hand-edited store. Repair to the
    // first character rather than crashing the planner, and fall back to a blank
    // sheet for a genuinely empty account.
    const first = characterIds(a)[0];
    return first ? { ...a.characters[first], id: first, roster: a.roster } : emptyCharacter();
  }
  return { ...ch, id: a.activeId, roster: a.roster };
}

export function characterById(a: Account, id: CharacterId): Character | null {
  const ch = a.characters[id];
  return ch ? { ...ch, id } : null;
}

/* ---------- writing an account ---------- */

/** Store `ch` back under the active id. `roster` is stripped: the account owns
 *  it (see setRoster). Everything else on the character is replaced wholesale. */
export function withActiveCharacter(a: Account, ch: Character): Account {
  const id = ch.id && a.characters[ch.id] ? ch.id : a.activeId;
  const { roster: _dropped, ...rest } = ch;
  void _dropped;
  return { ...a, activeId: id, characters: { ...a.characters, [id]: { ...rest, id } } };
}

/** Point the planner at another character. A no-op for an unknown id, so a
 *  stale link in the UI cannot blank the planner. */
export function selectCharacter(a: Account, id: CharacterId): Account {
  return a.characters[id] ? { ...a, activeId: id } : a;
}

/** Add a character. Returns the id so the caller can select it. Never reuses an
 *  id that is already taken. */
export function addCharacter(
  a: Account,
  ch: Character,
  opts: { makeActive?: boolean } = {},
): { account: Account; id: CharacterId } {
  const id = ch.id && !a.characters[ch.id] ? ch.id : newCharacterId();
  const { roster: _dropped, ...rest } = ch;
  void _dropped;
  const account: Account = {
    ...a,
    characters: { ...a.characters, [id]: { ...rest, id } },
    activeId: opts.makeActive === false ? a.activeId : id,
  };
  return { account, id };
}

/** Remove a character, move `activeId` somewhere real, and drop any roster link
 *  that pointed at it — a link to a deleted character is the dangling reference
 *  the id scheme exists to avoid. Removing the last character leaves a blank
 *  sheet rather than an account with no active character. */
export function removeCharacter(a: Account, id: CharacterId): Account {
  if (!a.characters[id]) return a;
  const characters = { ...a.characters };
  delete characters[id];
  const links = Object.fromEntries(
    Object.entries(a.rosterLinks ?? {}).filter(([, v]) => v !== id),
  );
  const ids = Object.keys(characters);
  if (!ids.length) {
    const blank = emptyCharacter();
    const blankId = blank.id ?? newCharacterId();
    return { ...a, characters: { [blankId]: { ...blank, id: blankId } }, activeId: blankId, rosterLinks: links };
  }
  return {
    ...a,
    characters,
    activeId: a.activeId === id ? ids[0] : a.activeId,
    rosterLinks: links,
  };
}

/** Rename without touching identity — the whole point of CharacterId. Roster
 *  links are keyed by the SCREENSHOT's name and are deliberately untouched:
 *  they describe what the Switch Character window says, not what the player
 *  calls this sheet. */
export function renameCharacter(a: Account, id: CharacterId, name: string): Account {
  const ch = a.characters[id];
  return ch ? { ...a, characters: { ...a.characters, [id]: { ...ch, name } } } : a;
}

/** THE roster writer. `undefined` clears it. */
export function setRoster(a: Account, roster: RosterChar[] | undefined): Account {
  const next: Account = { ...a, roster };
  if (!roster) delete next.roster;
  return next;
}

/* ---------- the roster -> character join ---------- */

export function characterIdForRoster(a: Account, name: string): CharacterId | null {
  const id = (a.rosterLinks ?? {})[rosterKey(name)];
  return id && a.characters[id] ? id : null;
}

export function characterForRoster(a: Account, name: string): Character | null {
  const id = characterIdForRoster(a, name);
  return id ? characterById(a, id) : null;
}

export function linkRoster(a: Account, name: string, id: CharacterId): Account {
  if (!a.characters[id]) return a;
  return { ...a, rosterLinks: { ...(a.rosterLinks ?? {}), [rosterKey(name)]: id } };
}

export function unlinkRoster(a: Account, name: string): Account {
  const links = { ...(a.rosterLinks ?? {}) };
  delete links[rosterKey(name)];
  return { ...a, rosterLinks: links };
}

/**
 * A blank sheet seeded from a roster entry: the three fields the screenshot
 * gives, the main stat resolved from the class roster, and NOTHING ELSE. No
 * stats, no gear — the player is about to add those, and inventing a starting
 * stat line would put fiction in the one place this app is careful.
 *
 * The class comes through verbatim, so a class lib/classes.ts does not know
 * still produces a usable sheet. Only `main` has to be invented, and only when
 * the class roster has no row for it: MainStat has no "unknown" member, so it
 * lands on "str" and the player retypes it. mainStatFromClass() returns null in
 * that case rather than hiding it, so a caller that wants to prompt can.
 */
export function characterFromRoster(entry: RosterChar): Character {
  return {
    id: newCharacterId(),
    name: entry.name,
    cls: entry.cls,
    main: mainStatFromClass(entry.cls) ?? "str",
    lvl: entry.lvl,
    cp: 0,
    stats: { main: 0, att: 0, crit: 0, critdmg: 0, boss: 0, ied: 0, hp: 0, arcane: 0, starforce: 0 },
    items: {},
  };
}

/**
 * THE call behind "click a roster entry and start adding items to it".
 *
 * Idempotent: an entry that already has a character resolves to it, so clicking
 * twice selects rather than forking. A brand-new entry gets a seeded sheet, a
 * link, and focus. `created` tells the UI whether to say "opened" or "created".
 */
export function openRosterCharacter(
  a: Account,
  entry: RosterChar,
): { account: Account; id: CharacterId; created: boolean } {
  const existing = characterIdForRoster(a, entry.name);
  if (existing) return { account: selectCharacter(a, existing), id: existing, created: false };

  // A character the player already built by hand, before the roster knew about
  // it, matches by name — otherwise the first roster import would duplicate the
  // one character everyone has. Name is the only field both sides carry.
  const byName = characterIds(a).find(
    (id) => rosterKey(a.characters[id].name) === rosterKey(entry.name),
  );
  if (byName) {
    return { account: selectCharacter(linkRoster(a, entry.name, byName), byName), id: byName, created: false };
  }

  const { account, id } = addCharacter(a, characterFromRoster(entry), { makeActive: true });
  return { account: linkRoster(account, entry.name, id), id, created: true };
}

/* ---------- constructing and migrating ---------- */

export function accountFromCharacter(ch: Character): Account {
  const id = ch.id ?? newCharacterId();
  const { roster, ...rest } = ch;
  const account: Account = {
    v: ACCOUNT_SCHEMA_VERSION,
    characters: { [id]: { ...rest, id } },
    activeId: id,
  };
  if (roster?.length) {
    account.roster = roster;
    // The one character we have is almost certainly on the roster, and linking
    // it is what makes the migrated account immediately useful: the roster row
    // the player recognises opens their real gear.
    const hit = roster.find((r) => rosterKey(r.name) === rosterKey(ch.name));
    if (hit) account.rosterLinks = { [rosterKey(hit.name)]: id };
  }
  return account;
}

export function emptyAccount(): Account {
  return accountFromCharacter(emptyCharacter());
}

export function exampleAccount(): Account {
  return accountFromCharacter(exampleCharacter());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural sniff for a persisted Account. */
export function isAccount(v: unknown): v is Account {
  return isRecord(v) && isRecord(v.characters) && typeof v.activeId === "string";
}

/** Structural sniff for the pre-account single Character. */
export function isLegacyCharacter(v: unknown): v is Character {
  return isRecord(v) && isRecord(v.stats) && typeof v.name === "string" && "items" in v;
}

/**
 * THE MIGRATION. Total, defensive, and lossless by construction.
 *
 * It accepts anything a persisted store can hand back — a v2 Account, the v1
 * bare Character, garbage, null — and returns an Account or null. It never
 * throws and it never drops gear: the legacy Character is carried into the new
 * shape BY SPREAD, so every field, including ones this file has never heard of,
 * survives. A field-by-field copy would have silently dropped the next field
 * someone adds to Item.
 *
 * It also REPAIRS, because the store is a place a human can reach: a dangling
 * activeId, a character whose `id` disagrees with its key, a roster link
 * pointing at a deleted character, a missing version stamp.
 */
export function migrateToAccount(raw: unknown): Account | null {
  if (raw == null) return null;

  const parsed: unknown = typeof raw === "string" ? safeParse(raw) : raw;
  if (parsed == null) return null;

  if (isAccount(parsed)) return normalizeAccount(parsed);
  if (isLegacyCharacter(parsed)) return normalizeAccount(accountFromCharacter(parsed as Character));
  return null;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Idempotent repair pass. Running it on its own output must be a no-op, which
 *  is what makes it safe to run on every load. */
export function normalizeAccount(a: Account): Account {
  const characters: Record<CharacterId, Character> = {};
  for (const [key, ch] of Object.entries(a.characters ?? {})) {
    if (!isRecord(ch)) continue;
    // The KEY wins over the record's own id. One of them has to, and the key is
    // what every reference in the account is written against.
    characters[key] = { ...(ch as Character), id: key };
  }

  let ids = Object.keys(characters);
  if (!ids.length) {
    const blank = emptyCharacter();
    const id = blank.id ?? newCharacterId();
    characters[id] = { ...blank, id };
    ids = [id];
  }

  const activeId = a.activeId && characters[a.activeId] ? a.activeId : ids[0];

  const rosterLinks: Record<string, CharacterId> = {};
  for (const [name, id] of Object.entries(a.rosterLinks ?? {})) {
    if (typeof id === "string" && characters[id]) rosterLinks[rosterKey(name)] = id;
  }

  const out: Account = { v: ACCOUNT_SCHEMA_VERSION, characters, activeId };
  if (a.roster?.length) out.roster = a.roster;
  if (Object.keys(rosterLinks).length) out.rosterLinks = rosterLinks;
  return out;
}

/** What a migration actually did, for a caller that wants to report it or
 *  refuse to commit it. `characters` and `items` are counted on the OUTPUT, so
 *  a caller can compare them against the input it still holds. */
export interface MigrationReport {
  from: "account" | "character" | "none";
  characters: number;
  /** Total gear pieces across every character. The number that must not drop. */
  items: number;
  activeName: string;
  roster: number;
  links: number;
}

export function describeMigration(raw: unknown, out: Account | null): MigrationReport {
  const parsed: unknown = typeof raw === "string" ? safeParse(raw) : raw;
  const from: MigrationReport["from"] = isAccount(parsed)
    ? "account"
    : isLegacyCharacter(parsed)
      ? "character"
      : "none";
  if (!out) return { from, characters: 0, items: 0, activeName: "", roster: 0, links: 0 };
  return {
    from,
    characters: characterIds(out).length,
    items: countItems(out),
    activeName: activeCharacter(out).name,
    roster: out.roster?.length ?? 0,
    links: Object.keys(out.rosterLinks ?? {}).length,
  };
}

export function countItems(a: Account): number {
  let n = 0;
  for (const ch of Object.values(a.characters)) {
    for (const it of Object.values(ch.items ?? {})) if (it) n++;
  }
  return n;
}

/* ---------- starting points ---------- */
export function emptyCharacter(): Character {
  return {
    id: newCharacterId(),
    name: "Unnamed", cls: "Bow Master", main: "dex", lvl: 200, cp: 0,
    // damagePct and finalDamagePct are deliberately ABSENT rather than 0: absent
    // means "no reading", which is true of a blank sheet, and the engine says so
    // out loud. A literal 0 would claim a measurement of zero.
    stats: { main: 0, att: 0, crit: 0, critdmg: 0, boss: 0, ied: 0, hp: 0, arcane: 0, starforce: 0 },
    items: {},
  };
}

/** The demo every first-time visitor sees, and therefore the product pitch. It
 *  is the real character this app exists to serve: GMS Heroic Bow Master,
 *  Lv 244, 5,260,117 CP, at v.271. The 17 star-forceable pieces below add up to
 *  exactly the 188 total star force on the character sheet — if you edit one,
 *  edit stats.starforce to match. Bottom is empty on purpose: the Arcane Umbra
 *  archer overall occupies the top slot and fills it.
 *
 *  The stat block is now the account holder's stated reference sheet to the
 *  digit, and is the same block as damage.REFERENCE_CHARACTER: DEX 20,689 /
 *  ATT 1,471 / crit 98% / crit dmg 41.5% / boss 159% / IED 92.9% / Arcane Power
 *  1,060 / star force 188 / HP 45,822. It previously carried DEX 19,860 and HP
 *  44,190, which were close enough to look right and wrong enough that no
 *  number computed from this page could be checked against the game. Two
 *  modules disagreeing about the one character the whole app is calibrated on
 *  is the sort of drift that makes every downstream figure unfalsifiable. */
export function exampleCharacter(): Character {
  return {
    id: EXAMPLE_CHARACTER_ID,
    name: "Archerroni", cls: "Bow Master", main: "dex", lvl: 244, cp: 5260117,
    // damagePct / finalDamagePct are the readings from DAMAGE_RANGE_VALIDATION
    // — the same character on the same day, one level later (Lv 245 / DEX
    // 20,790 / ATT 1,497 there, Lv 244 / 20,689 / 1,471 here). Neither figure
    // moves with a level: Damage % is hyper stat, inner ability and links, and
    // Final Damage % is passives. Carrying them onto this sheet is therefore
    // the same reading rather than an extrapolation — and it is the reading
    // that took the model from a 3.9x shortfall to ratio 1.0000.
    stats: { main: 20689, att: 1471, crit: 98, critdmg: 41.5, boss: 159, ied: 92.9, hp: 45822, arcane: 1060, starforce: 188,
      damagePct: VALIDATED_DAMAGE_PCT, finalDamagePct: VALIDATED_FINAL_DAMAGE_PCT },
    items: {
      hat: { name: "Arcane Umbra Archer Hat", lvl: 200, star: 17, pot: "legendary", sup: 0, bossDrop: true,
        p: ["DEX +12%", "DEX +9%", "All Stats +3%"], f: ["DEX +70", "All Stats +6%", "STR +40"] },
      top: { name: "Arcane Umbra Archer Suit", lvl: 200, star: 17, pot: "legendary", sup: 0, bossDrop: true,
        p: ["DEX +12%", "DEX +9%", "DEX +3%"], f: ["DEX +80", "All Stats +5%"] },
      shoes: { name: "Arcane Umbra Archer Shoes", lvl: 200, star: 17, pot: "unique", sup: 0, bossDrop: true,
        p: ["DEX +9%", "DEX +6%", "Max HP +6%"], f: ["DEX +60", "LUK +40"] },
      gloves: { name: "Arcane Umbra Archer Gloves", lvl: 200, star: 17, pot: "unique", sup: 0, bossDrop: true,
        p: ["Critical Damage +8%", "DEX +9%", "DEX +3%"], f: ["DEX +50", "All Stats +4%"] },
      cape: { name: "Arcane Umbra Archer Cape", lvl: 200, star: 17, pot: "legendary", sup: 0, bossDrop: true,
        p: ["DEX +12%", "DEX +9%", "All Stats +3%"], f: ["DEX +60", "INT +40"] },
      // "AbsoLab", capital L, because that is what /api/items returns and the
      // startup backfill overwrites this literal with it on every page load. The
      // two disagreed by one character, which was enough to move the demo's
      // signature off its own constant a second after any visitor arrived.
      shoulder: { name: "AbsoLab Archer Shoulder", lvl: 160, star: 15, pot: "legendary", sup: 0,
        p: ["All Stats +9%", "DEX +9%", "DEX +9%"], f: [] },
      weapon: { name: "Arcane Umbra Bow", lvl: 200, star: 17, pot: "legendary", sup: 0, bossDrop: true,
        p: ["Boss Damage +30%", "Ignore Enemy DEF +30%", "DEX +9%"], f: ["ATT +51", "All Stats +5%", "DEX +90"] },
      secondary: { name: "Arrow Fletching", lvl: 140, star: 0, pot: "unique", sup: 0, sub: "Arrow Fletching",
        p: ["DEX +9%", "DEX +6%", "All Stats +3%"], f: [] },
      emblem: { name: "Gold Maple Leaf Emblem", lvl: 100, star: 0, pot: "legendary", sup: 0,
        p: ["Boss Damage +30%", "Ignore Enemy DEF +30%", "ATT +9%"], f: [] },
      belt: { name: "Superior Engraved Gollux Belt", lvl: 150, star: 15, pot: "legendary", sup: 1,
        p: ["DEX +12%", "DEX +9%", "All Stats +3%"], f: ["DEX +40", "STR +30"] },
      pendant1: { name: "Superior Engraved Gollux Pendant", lvl: 150, star: 15, pot: "legendary", sup: 1,
        p: ["DEX +12%", "DEX +9%", "DEX +3%"], f: ["DEX +40", "All Stats +3%"] },
      pendant2: { name: "Source of Suffering", lvl: 160, star: 12, pot: "unique", sup: 0, bossDrop: true,
        p: ["DEX +9%", "DEX +6%", "Max HP +3%"], f: ["DEX +50", "INT +30"] },
      earring: { name: "Superior Engraved Gollux Earrings", lvl: 150, star: 15, pot: "legendary", sup: 1,
        p: ["DEX +12%", "DEX +9%", "All Stats +3%"], f: ["DEX +40", "LUK +30"] },
      face: { name: "Condensed Power Crystal", lvl: 140, star: 0, pot: "unique", sup: 0,
        p: ["DEX +9%", "DEX +3%", "Max HP +3%"], f: ["DEX +30", "INT +20"] },
      eye: { name: "Papulatus Mark", lvl: 145, star: 5, pot: "unique", sup: 0, bossDrop: true,
        p: ["DEX +9%", "DEX +6%", "DEF +120"], f: ["DEX +30", "All Stats +3%"] },
      ring1: { name: "Superior Engraved Gollux Ring", lvl: 150, star: 0, pot: "legendary", sup: 1,
        p: ["DEX +12%", "DEX +9%", "All Stats +3%"], f: [] },
      ring2: { name: "Guardian Angel Ring", lvl: 160, star: 9, pot: "legendary", sup: 0, bossDrop: true,
        p: ["DEX +12%", "DEX +9%", "DEX +3%"], f: [] },
      ring3: { name: "Meister Ring", lvl: 140, star: 0, pot: "unique", sup: 0,
        p: ["DEX +9%", "DEX +6%", "All Stats +3%"], f: [] },
      ring4: { name: "Kanna's Treasure", lvl: 140, star: 0, pot: "epic", sup: 0,
        p: ["DEX +6%", "DEX +3%", "Max HP +3%"], f: [] },
      pocket: { name: "Stone of Eternal Life", lvl: 160, star: 0, pot: "unique", sup: 0, noSf: true,
        p: ["DEX +9%", "DEX +6%", "All Stats +3%"], f: ["DEX +40", "STR +30"] },
      heart: { name: "Black Heart", lvl: 150, star: 0, pot: "legendary", sup: 0,
        p: ["DEX +12%", "DEX +9%", "All Stats +3%"], f: [] },
      badge: { name: "Genesis Badge", lvl: 200, star: 0, pot: "none", sup: 0, p: [], f: [] },
      medal: { name: "Beyond Death", lvl: 0, star: 0, pot: "none", sup: 0, p: [], f: [] },
      android: { name: "Maple Android", lvl: 0, star: 0, pot: "none", sup: 0, p: [], f: [] },
    },
  };
}
