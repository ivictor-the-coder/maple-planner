// Set effects: which slots are coupled, and what breaks when one of them moves.
//
// WHY THIS FILE EXISTS
// advise() is handed the whole Character and looks only at one slot. That is
// how the shipped LADDER came to tell a player wearing four Superior Gollux
// pieces to replace their ring with a "Boss ring" — a swap that drops the set
// from 4pc to 3pc and costs +30% IED and +30% Boss Damage. At this account's
// 92.9% IED and 159% boss damage against a 300%-DEF Arcane boss that is about
// -22% damage, presented as an upgrade. Nothing in the codebase knew the ring
// belonged to a set, so nothing could have caught it.
//
// Everything here is pure: no React, no fetch, no I/O. `activeSets` and
// `setDelta` take plain data and return plain data.
//
// PROVENANCE
// Set effect values come from digitaltq.com/maplestory-set-effects, spot-checked
// against maplestorywiki.net and maplestory.fandom.com set pages. Every set
// below is `verified: false` and MUST stay that way until someone reads the
// numbers off an in-game Set Effect panel. GMS Heroic (Reboot), v.271.

import type { Item } from "./rules";

/* ------------------------------------------------------------------ types */

/**
 * The effects a set tier grants. Percentages are in game units — `bossPct: 30`
 * is the "+30% Boss Monster Damage" the tooltip shows, not 0.3.
 */
export interface SetEffects {
  /** Flat Attack Power / Magic ATT. */
  att?: number;
  /** Flat main stat only (CRA grants main + secondary separately). */
  mainStat?: number;
  /** Flat secondary stat. */
  secondaryStat?: number;
  /** Flat All Stats. */
  allStat?: number;
  /** All Stats %. No set below grants it; present because some sets do. */
  allStatPct?: number;
  bossPct?: number;
  iedPct?: number;
  hpPct?: number;
  hpFlat?: number;
  defFlat?: number;
  /** Damage Against Normal Monsters %. Pensalir's whole identity. */
  normalDmgPct?: number;
}

export interface SetTier {
  /** Pieces equipped for this tier to apply. */
  count: number;
  /** INCREMENTAL. A 4-set holds the 2-, 3- and 4-set lines at once. */
  effects: SetEffects;
}

export interface SetPiece {
  /**
   * Slot FAMILY, not slot id: "ring" covers ring1..ring4, "pendant" covers
   * pendant1 and pendant2. Matches itemLookup.ts's `fam()`.
   */
  slot: string;
  /** Regex source, matched case-insensitively against the item name. */
  itemNamePattern: string;
  /**
   * Disqualifier. `^Royal\b` identifies a CRA hat, but "Royal Von Leon Helm" is
   * a different set entirely and "Royal Black Metal Shoulder" is a Boss
   * Accessory — the slot gate catches the shoulder, this catches Von Leon.
   */
  excludePattern?: string;
  /** Stable id for this piece, so a resolved item can name what it matched. */
  id: string;
}

export interface SetDefinition {
  id: string;
  name: string;
  pieces: SetPiece[];
  tiers: SetTier[];
  source: string;
  lastVerified: string;
  patchVersion: string;
  /**
   * False until a human reads these numbers off an in-game Set Effect panel.
   * Every entry below is false. Do not flip one without doing that.
   */
  verified: boolean;
  notes?: string;
}

/* --------------------------------------------------------------- the table
 *
 * data/sets.json is owned by another builder in this repo, so this module
 * carries the table inline rather than importing a file that may not exist at
 * compile time. `useSetTable()` lets that JSON take over at runtime once it
 * lands, without a static import and without two competing tables:
 *
 *     import sets from "@/data/sets.json";
 *     useSetTable(sets as SetDefinition[]);
 *
 * ASSUMPTION RECORDED: data/sets.json is expected to deserialise to
 * SetDefinition[] exactly as typed above. If it ships a different shape, adapt
 * it at the call site — do not loosen these types.
 */

const SOURCE_DIGITALTQ = "digitaltq.com/maplestory-set-effects, cross-checked against maplestorywiki.net";
const VERIFIED_ON = "2026-09-11";
const PATCH = "v.271";

const GOLLUX_SLOTS = ["earring", "ring", "pendant", "belt"] as const;

/** AbsoLab and Arcane Umbra share a slot list. The overall is the interesting one. */
const ARMOR_SLOTS = ["hat", "top", "shoes", "gloves", "cape", "shoulder", "weapon"] as const;

function gollux(prefix: string, pattern: string): SetPiece[] {
  return GOLLUX_SLOTS.map((slot) => ({ id: `${prefix}-${slot}`, slot, itemNamePattern: pattern }));
}

function armor(prefix: string, pattern: string): SetPiece[] {
  return ARMOR_SLOTS.map((slot) => ({ id: `${prefix}-${slot}`, slot, itemNamePattern: pattern }));
}

export const BUILTIN_SETS: SetDefinition[] = [
  {
    id: "superior-gollux",
    name: "Superior Gollux",
    // Four pieces: Earrings, Ring, Pendant, Belt. GMS item names carry
    // "Engraved" ("Superior Engraved Gollux Belt"); the pattern tolerates both
    // spellings because vision imports drop the word about half the time.
    pieces: gollux("sup-gollux", "superior\\s+(engraved\\s+)?gollux"),
    tiers: [
      { count: 2, effects: { allStat: 20, hpFlat: 1500 } },
      { count: 3, effects: { hpPct: 13, att: 35 } },
      { count: 4, effects: { iedPct: 30, bossPct: 30 } },
    ],
    source: SOURCE_DIGITALTQ,
    lastVerified: VERIFIED_ON,
    patchVersion: PATCH,
    verified: false,
    notes: "The 4-set is the single largest coupled bonus in mid-game gear and the "
      + "reason no individual ring, pendant, earring or belt upgrade is safe in isolation.",
  },
  {
    id: "reinforced-gollux",
    name: "Reinforced Gollux",
    pieces: gollux("rein-gollux", "reinforced\\s+(engraved\\s+)?gollux"),
    tiers: [
      { count: 2, effects: { allStat: 15, hpFlat: 1200 } },
      { count: 3, effects: { hpPct: 10, att: 30 } },
      { count: 4, effects: { iedPct: 15, bossPct: 30 } },
    ],
    source: SOURCE_DIGITALTQ,
    lastVerified: VERIFIED_ON,
    patchVersion: PATCH,
    verified: false,
    notes: "Solid and Cracked Gollux tiers exist below this and are not modelled.",
  },
  {
    id: "absolab",
    name: "AbsoLab",
    // Hat, Overall, Shoes, Gloves, Cape, Shoulder, Weapon — seven pieces.
    // There is deliberately NO `bottom` entry: the AbsoLab Overall sits in the
    // top slot and covers the bottom, so a player mid-set has an empty-looking
    // bottom slot that is not a missing set piece.
    pieces: armor("abso", "abso\\s*lab"),
    tiers: [
      { count: 2, effects: { hpFlat: 1500, att: 20, bossPct: 10 } },
      { count: 3, effects: { allStat: 30, att: 20, bossPct: 10 } },
      { count: 4, effects: { att: 25, defFlat: 200, iedPct: 10 } },
      { count: 5, effects: { att: 30, bossPct: 10 } },
      { count: 6, effects: { hpPct: 20, att: 20 } },
      { count: 7, effects: { att: 20, iedPct: 10 } },
    ],
    source: SOURCE_DIGITALTQ,
    lastVerified: VERIFIED_ON,
    patchVersion: PATCH,
    verified: false,
  },
  {
    id: "arcane-umbra",
    name: "Arcane Umbra",
    pieces: armor("umbra", "arcane\\s+umbra"),
    tiers: [
      { count: 2, effects: { att: 30, bossPct: 10 } },
      { count: 3, effects: { att: 30, defFlat: 400, iedPct: 10 } },
      { count: 4, effects: { allStat: 50, att: 35, bossPct: 10 } },
      { count: 5, effects: { hpFlat: 2000, att: 40, bossPct: 10 } },
      { count: 6, effects: { hpPct: 30, att: 30 } },
      { count: 7, effects: { att: 30, iedPct: 10 } },
    ],
    source: SOURCE_DIGITALTQ,
    lastVerified: VERIFIED_ON,
    patchVersion: PATCH,
    verified: false,
  },
  {
    id: "cra",
    name: "Chaos Root Abyss",
    // CRA names are per-class but follow a fixed template: Royal <class> hat,
    // Eagle Eye <class> top, Trixter <class> bottom, Fafnir <class> weapon.
    // Unlike AbsoLab this set HAS a separate top and bottom.
    pieces: [
      { id: "cra-hat", slot: "hat", itemNamePattern: "^royal\\b", excludePattern: "von\\s*leon" },
      { id: "cra-top", slot: "top", itemNamePattern: "^eagle\\s*eye\\b" },
      { id: "cra-bottom", slot: "bottom", itemNamePattern: "^trixter\\b" },
      { id: "cra-weapon", slot: "weapon", itemNamePattern: "^fafnir\\b" },
    ],
    tiers: [
      { count: 2, effects: { mainStat: 20, secondaryStat: 20, hpFlat: 1000 } },
      { count: 3, effects: { hpPct: 10, att: 50 } },
      { count: 4, effects: { bossPct: 30 } },
    ],
    source: SOURCE_DIGITALTQ + "; per-class names from maplestorywiki.net Root Abyss Set pages",
    lastVerified: VERIFIED_ON,
    patchVersion: PATCH,
    verified: false,
    notes: "Name templates confirmed for Bowman (Royal Ranger Beret / Eagle Eye Ranger "
      + "Cowl / Trixter Ranger Pants / Fafnir Dual Windwing). The prefixes are shared "
      + "across classes but only the Bowman set was read end to end.",
  },
  {
    id: "boss-accessory",
    name: "Boss Accessory",
    // Slot-gated exact names. These are low-level boss drops with no shared
    // prefix, so unlike the other sets there is nothing to pattern-match on -
    // each piece is named. The list is the weakest part of this table: sources
    // disagree on which nine items count. See `notes`.
    pieces: [
      { id: "boss-face", slot: "face", itemNamePattern: "condensed\\s+power\\s+crystal" },
      { id: "boss-eye", slot: "eye", itemNamePattern: "black\\s+bean\\s+mark|aquatic\\s+letter\\s+eye" },
      { id: "boss-earring", slot: "earring", itemNamePattern: "dea\\s+sidus\\s+earring" },
      { id: "boss-ring", slot: "ring", itemNamePattern: "silver\\s+blossom\\s+ring" },
      { id: "boss-pendant", slot: "pendant", itemNamePattern: "dominator\\s+pendant" },
      { id: "boss-belt", slot: "belt", itemNamePattern: "golden\\s+clover\\s+belt" },
      { id: "boss-shoulder", slot: "shoulder", itemNamePattern: "royal\\s+black\\s+metal" },
      { id: "boss-badge", slot: "badge", itemNamePattern: "crystal\\s+ventus\\s+badge" },
      { id: "boss-pocket", slot: "pocket", itemNamePattern: "pink\\s+(holy\\s+cup|light\\s+grail)" },
    ],
    tiers: [
      { count: 3, effects: { allStat: 10, hpPct: 10, att: 5 } },
      { count: 5, effects: { allStat: 10, hpPct: 10, att: 5 } },
      { count: 7, effects: { allStat: 10, att: 10, defFlat: 80, iedPct: 10 } },
      { count: 9, effects: { allStat: 15, att: 10, defFlat: 100, bossPct: 10 } },
    ],
    source: SOURCE_DIGITALTQ + "; piece list assembled from maplewiki and community guides",
    lastVerified: VERIFIED_ON,
    patchVersion: PATCH,
    verified: false,
    notes: "PIECE LIST INCOMPLETE AND UNVERIFIED. Sources name between six and ten "
      + "qualifying items and do not agree. An item not in this list resolves to "
      + "set: undefined and is excluded from the count rather than assumed in, so "
      + "the count under-reports rather than over-promises — but a 7pc player may "
      + "read as 5pc here. Confirm against the in-game Set Effect panel.",
  },
  {
    id: "pensalir",
    name: "Pensalir",
    pieces: [
      { id: "pensalir-hat", slot: "hat", itemNamePattern: "^pensalir\\b" },
      { id: "pensalir-top", slot: "top", itemNamePattern: "^pensalir\\b" },
      { id: "pensalir-bottom", slot: "bottom", itemNamePattern: "^pensalir\\b" },
      { id: "pensalir-shoes", slot: "shoes", itemNamePattern: "^pensalir\\b" },
      { id: "pensalir-gloves", slot: "gloves", itemNamePattern: "^pensalir\\b" },
      { id: "pensalir-cape", slot: "cape", itemNamePattern: "^pensalir\\b" },
    ],
    tiers: [
      { count: 2, effects: { defFlat: 140 } },
      { count: 3, effects: { hpPct: 9, normalDmgPct: 2 } },
      { count: 4, effects: { mainStat: 9, att: 9, normalDmgPct: 4 } },
      { count: 5, effects: { allStat: 15, defFlat: 250, normalDmgPct: 6, iedPct: 10 } },
      { count: 6, effects: { att: 10, normalDmgPct: 8, iedPct: 10 } },
    ],
    source: SOURCE_DIGITALTQ,
    lastVerified: VERIFIED_ON,
    patchVersion: PATCH,
    verified: false,
    notes: "Six armour pieces. Whether Pensalir weapons also count toward the set "
      + "could not be sourced, so the weapon is excluded. The tier list ending at 6 "
      + "is consistent with armour-only. Pensalir's bonuses are Damage Against "
      + "Normal Monsters — a training set, worth nothing at a boss.",
  },
];

let TABLE: SetDefinition[] = BUILTIN_SETS;

/** Swap in data/sets.json once it exists. Pass nothing to restore the builtin table. */
export function useSetTable(defs?: SetDefinition[]): void {
  TABLE = defs && defs.length ? defs : BUILTIN_SETS;
}
export function setTable(): SetDefinition[] {
  return TABLE;
}
export function setById(id: string): SetDefinition | undefined {
  return TABLE.find((s) => s.id === id);
}

/* ------------------------------------------------------------- resolution */

/** ring1..ring4 -> "ring". Same rule itemLookup.ts uses. */
export function slotFamily(slotId: string): string {
  return slotId.replace(/\d+$/, "");
}

export interface ResolvedSetPiece {
  setId: string;
  setName: string;
  setPieceId: string;
}

/**
 * Which set piece, if any, this item in this slot is.
 *
 * Both halves of the two-way resolution the engine needs land here: an item
 * picked from the database arrives with its real `name`, and one typed or read
 * out of a screenshot arrives with whatever the vision model saw. The same
 * name-pattern match serves both. An item that matches nothing returns
 * undefined and is EXCLUDED from every count — never assumed into a set.
 */
export function resolveSet(slotId: string, item: Item | null | undefined): ResolvedSetPiece | undefined {
  if (!item?.name) return undefined;
  const fam = slotFamily(slotId);
  const name = item.name;
  for (const def of TABLE) {
    for (const piece of def.pieces) {
      if (piece.slot !== fam) continue;
      if (piece.excludePattern && new RegExp(piece.excludePattern, "i").test(name)) continue;
      if (new RegExp(piece.itemNamePattern, "i").test(name)) {
        return { setId: def.id, setName: def.name, setPieceId: piece.id };
      }
    }
  }
  return undefined;
}

/* ---------------------------------------------------------- effect algebra */

// Ordered by how much a player cares, not alphabetically. describeEffects reads
// this in order and the first clause of a warning is the one that gets read, so
// IED and Boss Damage lead — they are what a dropped set tier actually costs.
const EFFECT_KEYS = [
  "iedPct", "bossPct", "att", "allStat", "mainStat", "secondaryStat",
  "allStatPct", "normalDmgPct", "hpPct", "hpFlat", "defFlat",
] as const;
type EffectKey = (typeof EFFECT_KEYS)[number];

// Labels carry no "%" of their own: describeEffects puts it next to the number
// ("+13% Max HP"), which is where the game puts it.
export const EFFECT_LABEL: Record<EffectKey, string> = {
  iedPct: "IED",
  bossPct: "Boss Damage",
  att: "ATT",
  allStat: "All Stat",
  mainStat: "Main Stat",
  secondaryStat: "Secondary Stat",
  allStatPct: "All Stat",
  normalDmgPct: "Damage to Normal Monsters",
  hpPct: "Max HP",
  hpFlat: "Max HP",
  defFlat: "DEF",
};

const PERCENT_KEYS = new Set<EffectKey>([
  "allStatPct", "bossPct", "iedPct", "hpPct", "normalDmgPct",
]);

export function addEffects(a: SetEffects, b: SetEffects): SetEffects {
  const out: SetEffects = {};
  for (const k of EFFECT_KEYS) {
    const v = (a[k] ?? 0) + (b[k] ?? 0);
    if (v !== 0) out[k] = v;
  }
  return out;
}

export function subEffects(a: SetEffects, b: SetEffects): SetEffects {
  const out: SetEffects = {};
  for (const k of EFFECT_KEYS) {
    const v = (a[k] ?? 0) - (b[k] ?? 0);
    if (v !== 0) out[k] = v;
  }
  return out;
}

export function isEmptyEffects(e: SetEffects): boolean {
  return EFFECT_KEYS.every((k) => !e[k]);
}

/** "+30% IED and +30% Boss Damage" — for the sentence, not a table. */
export function describeEffects(e: SetEffects, join = " and "): string {
  const parts: string[] = [];
  for (const k of EFFECT_KEYS) {
    const v = e[k];
    if (!v) continue;
    const sign = v > 0 ? "+" : "";
    parts.push(PERCENT_KEYS.has(k) ? `${sign}${v}% ${EFFECT_LABEL[k]}` : `${sign}${v} ${EFFECT_LABEL[k]}`);
  }
  return parts.join(join);
}

/** Everything a set grants at `count` pieces. Tiers are incremental and stack. */
export function cumulativeEffects(def: SetDefinition, count: number): SetEffects {
  return def.tiers
    .filter((t) => t.count <= count)
    .reduce<SetEffects>((acc, t) => addEffects(acc, t.effects), {});
}

/**
 * IED from separate sources combines multiplicatively, so the individual tier
 * values must survive to the damage model — summing them first turns two 10%
 * lines into 20% when the game gives 19%. This collects them per tier.
 */
export function iedSources(def: SetDefinition, count: number): number[] {
  return def.tiers.filter((t) => t.count <= count && t.effects.iedPct).map((t) => t.effects.iedPct as number);
}

/* --------------------------------------------------------- active set scan */

export interface ActiveSet {
  setId: string;
  name: string;
  count: number;
  activeTier: SetTier | null;
  nextTier: SetTier | null;
  /** Slot families this set wants that hold no matching item. */
  missingSlots: string[];
  /** Real slot ids currently contributing, e.g. ["ring2", "pendant1"]. */
  matchedSlots: string[];
  effects: SetEffects;
  iedSources: number[];
  verified: boolean;
}

/**
 * Every set with at least one piece equipped.
 *
 * A piece definition can be satisfied at most once — four Superior Gollux rings
 * would still be one ring piece — which is what makes the ring family safe to
 * scan across ring1..ring4.
 */
export function activeSets(items: Record<string, Item>): ActiveSet[] {
  const out: ActiveSet[] = [];

  for (const def of TABLE) {
    const matchedSlots: string[] = [];
    const satisfied = new Set<string>();

    for (const [slotId, item] of Object.entries(items)) {
      const hit = resolveSet(slotId, item);
      if (!hit || hit.setId !== def.id) continue;
      if (satisfied.has(hit.setPieceId)) continue;
      satisfied.add(hit.setPieceId);
      matchedSlots.push(slotId);
    }

    const count = satisfied.size;
    if (count === 0) continue;

    const tiers = [...def.tiers].sort((a, b) => a.count - b.count);
    const active = tiers.filter((t) => t.count <= count).pop() ?? null;
    const next = tiers.find((t) => t.count > count) ?? null;

    out.push({
      setId: def.id,
      name: def.name,
      count,
      activeTier: active,
      nextTier: next,
      missingSlots: def.pieces.filter((p) => !satisfied.has(p.id)).map((p) => p.slot),
      matchedSlots,
      effects: cumulativeEffects(def, count),
      iedSources: iedSources(def, count),
      verified: def.verified,
    });
  }

  return out.sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------ damage model
 *
 * Deliberately small and deliberately explicit about what it does not cover.
 * A partial model that names its gaps is useful; one that quietly pretends to
 * be complete is the failure mode this repo exists to avoid.
 */

/**
 * Monster DEF as a multiplier on your remaining (post-IED) defence term.
 * rules.ts already tells the player "Arcane bosses sit at 300% defense,
 * Grandis at 380%". Same numbers, in one place, as documented inputs.
 */
export const BOSS_DEF_ARCANE = 3.0;
export const BOSS_DEF_GRANDIS = 3.8;

/**
 * The boss-damage denominator here is (1 + bossDamage%), which ignores general
 * Damage% and the final-damage multipliers that sit alongside it in the real
 * formula. Leaving them out makes a set-effect LOSS read slightly worse than it
 * is — the relative change shrinks as the denominator grows. Pessimistic in the
 * direction that protects the player from an irreversible swap, which is the
 * right way to be wrong here, but it is still an approximation.
 */
export const DAMAGE_MODEL_INCLUDES_GENERAL_DAMAGE = false;

/**
 * Flat main stat is treated as linear in total main stat. Real damage is
 * roughly proportional to (4 * main + secondary), so flat stat is slightly
 * sub-linear at the margin. Under 1% error at the magnitudes set effects deal
 * in; named so nobody has to rediscover it.
 */
export const DAMAGE_MODEL_MAIN_STAT_IS_LINEAR = true;

export interface DamageContext {
  /** Ignore DEF as the stat window shows it, e.g. 92.9. */
  ied: number;
  /** Boss damage as the stat window shows it, e.g. 159. */
  boss: number;
  /** Total ATT, e.g. 1471. Omit to leave ATT out of the estimate. */
  att?: number;
  /** Total main stat, e.g. 19500. Omit to leave flat stat out of the estimate. */
  mainStat?: number;
  /** Defaults to BOSS_DEF_ARCANE. */
  bossDef?: number;
}

export interface DamageChange {
  /** Individual IED lines, NOT pre-summed. They combine multiplicatively. */
  iedSources: number[];
  bossPct: number;
  att: number;
  flatStat: number;
}

export interface DamageEstimate {
  /** 0.78 means the change leaves you at 78% of current damage. */
  ratio: number;
  /** -21.8 for that ratio. */
  pct: number;
  modelled: string[];
  unmodelled: string[];
  /** "about -22% damage at your stats" */
  phrase: string;
}

export type DamageModel = (ctx: DamageContext, change: DamageChange) => DamageEstimate;

let MODEL: DamageModel | null = null;

/**
 * Replace the built-in estimate with a fuller one.
 *
 * lib/damage.ts (built in parallel) carries a real damage index with weapon
 * multipliers, mastery and crit — a strictly better model than the two-term
 * ratio below. This module keeps its own so it is useful standalone and
 * testable without that dependency, but the app should prefer one number
 * everywhere:
 *
 *     useDamageModel((ctx, change) => { ... call damageIndex() twice ... });
 *
 * ASSUMPTION RECORDED: lib/damage.ts exports `damageIndex(inputs, opts)`,
 * `stackIedAll(sources)` and `DEFAULT_PDR = 3.0`. Its IED stacking and boss PDR
 * agree with BOSS_DEF_ARCANE here, so the two models should not disagree in
 * sign — only in precision.
 */
export function useDamageModel(model?: DamageModel): void {
  MODEL = model ?? null;
}

/**
 * `change` is applied as a GAIN. Pass a loss as negative values — setDelta
 * does exactly that when a swap drops a tier.
 */
export function estimateDamage(ctx: DamageContext, change: DamageChange): DamageEstimate {
  if (MODEL) return MODEL(ctx, change);
  return builtinEstimateDamage(ctx, change);
}

function builtinEstimateDamage(ctx: DamageContext, change: DamageChange): DamageEstimate {
  const def = ctx.bossDef ?? BOSS_DEF_ARCANE;
  const modelled: string[] = [];
  const unmodelled: string[] = [];
  let ratio = 1;

  if (change.iedSources.some((v) => v !== 0)) {
    const remainingBefore = Math.max(0, 1 - ctx.ied / 100);
    // Each source is its own multiplicative step: adding p multiplies the
    // remaining defence by (1 - p/100); removing it divides by the same term.
    let remainingAfter = remainingBefore;
    for (const p of change.iedSources) {
      if (!p) continue;
      const f = 1 - Math.abs(p) / 100;
      if (f <= 0) continue;
      remainingAfter = p > 0 ? remainingAfter * f : remainingAfter / f;
    }
    const before = Math.max(0, 1 - def * remainingBefore);
    const after = Math.max(0, 1 - def * remainingAfter);
    if (before > 0) {
      ratio *= after / before;
      modelled.push("IED");
    }
  }

  if (change.bossPct) {
    const before = 1 + ctx.boss / 100;
    const after = 1 + (ctx.boss + change.bossPct) / 100;
    if (before > 0 && after > 0) {
      ratio *= after / before;
      modelled.push("Boss Damage");
    }
  }

  if (change.att) {
    if (ctx.att && ctx.att > 0) {
      ratio *= (ctx.att + change.att) / ctx.att;
      modelled.push("ATT");
    } else {
      unmodelled.push("ATT (no total ATT supplied)");
    }
  }

  if (change.flatStat) {
    if (ctx.mainStat && ctx.mainStat > 0) {
      ratio *= (ctx.mainStat + change.flatStat) / ctx.mainStat;
      modelled.push("flat main stat");
    } else {
      unmodelled.push("flat stat (no total main stat supplied)");
    }
  }

  const pct = (ratio - 1) * 100;
  return {
    ratio,
    pct,
    modelled,
    unmodelled,
    phrase: `about ${pct >= 0 ? "+" : ""}${pct.toFixed(pct > -10 && pct < 10 ? 1 : 0)}% damage at your stats`,
  };
}

/** Turn a set-effect bundle into the damage inputs, keeping IED lines separate. */
function toChange(effects: SetEffects, ied: number[]): DamageChange {
  return {
    iedSources: ied,
    bossPct: effects.bossPct ?? 0,
    att: effects.att ?? 0,
    // All Stat is main stat for damage purposes; secondary stat is worth far
    // less and is left out rather than counted at face value.
    flatStat: (effects.mainStat ?? 0) + (effects.allStat ?? 0),
  };
}

/* ----------------------------------------------------------------- deltas */

export interface TierChange {
  setId: string;
  name: string;
  fromCount: number;
  toCount: number;
  fromTier: number | null;
  toTier: number | null;
}

export interface SetDelta {
  before: ActiveSet[];
  after: ActiveSet[];
  /** Effects the swap removes, as positive magnitudes. */
  lostEffects: SetEffects;
  /** Effects the swap adds. */
  gainedEffects: SetEffects;
  /** gained - lost. Negative entries are real losses. */
  netStatDelta: SetEffects;
  broken: TierChange[];
  formed: TierChange[];
  /** Present when a DamageContext was supplied. */
  damage?: DamageEstimate;
  /** The sentence a Rec must lead with. Empty when nothing breaks. */
  lead: string;
}

/**
 * What changes across every set if `slotId` becomes `candidate`.
 * Pass `candidate: null` to model emptying the slot.
 */
export function setDelta(
  items: Record<string, Item>,
  slotId: string,
  candidate: Item | null,
  ctx?: DamageContext,
): SetDelta {
  const next: Record<string, Item> = { ...items };
  if (candidate) next[slotId] = candidate;
  else delete next[slotId];

  const before = activeSets(items);
  const after = activeSets(next);

  const byId = (list: ActiveSet[]) => new Map(list.map((s) => [s.setId, s]));
  const b = byId(before);
  const a = byId(after);

  let lostEffects: SetEffects = {};
  let gainedEffects: SetEffects = {};
  const lostIed: number[] = [];
  const gainedIed: number[] = [];
  const broken: TierChange[] = [];
  const formed: TierChange[] = [];

  for (const setId of new Set([...b.keys(), ...a.keys()])) {
    const was = b.get(setId);
    const now = a.get(setId);
    const wasCount = was?.count ?? 0;
    const nowCount = now?.count ?? 0;
    if (wasCount === nowCount) continue;

    const def = setById(setId);
    if (!def) continue;

    const wasEffects = cumulativeEffects(def, wasCount);
    const nowEffects = cumulativeEffects(def, nowCount);
    const change: TierChange = {
      setId,
      name: def.name,
      fromCount: wasCount,
      toCount: nowCount,
      fromTier: was?.activeTier?.count ?? null,
      toTier: now?.activeTier?.count ?? null,
    };

    if (nowCount < wasCount) {
      const lost = subEffects(wasEffects, nowEffects);
      if (!isEmptyEffects(lost)) {
        lostEffects = addEffects(lostEffects, lost);
        lostIed.push(...iedSources(def, wasCount).slice(iedSources(def, nowCount).length));
      }
      if (change.fromTier !== change.toTier) broken.push(change);
    } else {
      const gained = subEffects(nowEffects, wasEffects);
      if (!isEmptyEffects(gained)) {
        gainedEffects = addEffects(gainedEffects, gained);
        gainedIed.push(...iedSources(def, nowCount).slice(iedSources(def, wasCount).length));
      }
      if (change.fromTier !== change.toTier) formed.push(change);
    }
  }

  const netStatDelta = subEffects(gainedEffects, lostEffects);

  let damage: DamageEstimate | undefined;
  if (ctx && (!isEmptyEffects(lostEffects) || !isEmptyEffects(gainedEffects))) {
    const gain = toChange(gainedEffects, gainedIed);
    const loss = toChange(lostEffects, lostIed);
    damage = estimateDamage(ctx, {
      iedSources: [...gain.iedSources, ...loss.iedSources.map((v) => -v)],
      bossPct: gain.bossPct - loss.bossPct,
      att: gain.att - loss.att,
      flatStat: gain.flatStat - loss.flatStat,
    });
  }

  return {
    before,
    after,
    lostEffects,
    gainedEffects,
    netStatDelta,
    broken,
    formed,
    damage,
    lead: leadSentence(broken, lostEffects, damage),
  };
}

function leadSentence(
  broken: TierChange[],
  lost: SetEffects,
  damage: DamageEstimate | undefined,
): string {
  if (!broken.length || isEmptyEffects(lost)) return "";
  const first = broken[0];
  const dmg = damage && damage.pct < 0 ? ` (${damage.phrase})` : "";
  return `This drops ${first.name} from ${first.fromCount}pc to ${first.toCount}pc, `
    + `costing ${describeEffects(lost)}${dmg}.`;
}

/* ------------------------------------------------------------ what breaks */

export interface WhatBreaks {
  setId: string;
  setName: string;
  pieceIndex: number;
  pieceCount: number;
  lostEffects: SetEffects;
  damage?: DamageEstimate;
  /** The line the advice rail leads with on hover. */
  text: string;
}

/**
 * The hover line. "This is 1 of 4 Superior Gollux pieces. Removing it costs
 * +30% IED and +30% Boss Damage (about -22% damage at your stats)."
 *
 * Returns undefined when the slot holds nothing, holds an item in no set, or
 * holds a piece whose removal crosses no tier boundary — silence is correct
 * there, and a rail that warns about everything warns about nothing.
 */
export function whatBreaks(
  items: Record<string, Item>,
  slotId: string,
  ctx?: DamageContext,
): WhatBreaks | undefined {
  const item = items[slotId];
  const hit = resolveSet(slotId, item);
  if (!hit) return undefined;

  const delta = setDelta(items, slotId, null, ctx);
  const brk = delta.broken.find((x) => x.setId === hit.setId);
  if (!brk || isEmptyEffects(delta.lostEffects)) return undefined;

  const def = setById(hit.setId);
  const total = def ? def.pieces.length : brk.fromCount;
  const dmg = delta.damage && delta.damage.pct < 0 ? ` (${delta.damage.phrase})` : "";

  return {
    setId: hit.setId,
    setName: hit.setName,
    pieceIndex: brk.fromCount,
    pieceCount: total,
    lostEffects: delta.lostEffects,
    damage: delta.damage,
    text: `This is 1 of ${brk.fromCount} ${hit.setName} pieces. `
      + `Removing it costs ${describeEffects(delta.lostEffects)}${dmg}.`,
  };
}

/* ------------------------------------------- AbsoLab -> Arcane Umbra batch
 *
 * Players swap this transition one piece at a time and lose damage doing it.
 * AbsoLab 6pc is +115 ATT, +30 all stat, +30% boss, +10% IED and +20% HP;
 * splitting it into AbsoLab 3pc + Umbra 3pc keeps far less than half. The
 * arithmetic is also counter-intuitive because the Umbra Overall replaces BOTH
 * the AbsoLab top and bottom while counting as ONE Umbra piece, so a player who
 * "swapped two slots" often has only swapped one piece of set count.
 */

export interface TransitionStep {
  swapCount: number;
  absolabCount: number;
  umbraCount: number;
  netEffects: SetEffects;
  damage?: DamageEstimate;
  netPositive: boolean;
  /** Ranking key. Uses the damage model when a context is supplied. */
  score: number;
}

/**
 * Scoring a step without a DamageContext. ATT and boss% are the two things
 * these tiers trade, and at this account's numbers one point of boss% is worth
 * roughly ten ATT — a rough exchange rate, exported so it is arguable rather
 * than hidden. Supply a DamageContext and this is not used at all.
 */
export const TRANSITION_ATT_PER_BOSS_PCT_UNVERIFIED = 10;

function stepScore(net: SetEffects, damage: DamageEstimate | undefined): number {
  if (damage) return damage.pct;
  const r = TRANSITION_ATT_PER_BOSS_PCT_UNVERIFIED;
  return (net.att ?? 0) + r * ((net.bossPct ?? 0) + (net.iedPct ?? 0));
}

/**
 * Multiset difference. IED lines are plain numbers and duplicates are common
 * (AbsoLab grants 10% at both 4pc and 7pc), so indexOf-style diffing silently
 * drops one of a matching pair.
 */
function multisetDiff(before: number[], after: number[]): { added: number[]; removed: number[] } {
  const pool = [...before];
  const added: number[] = [];
  for (const v of after) {
    const i = pool.indexOf(v);
    if (i >= 0) pool.splice(i, 1);
    else added.push(v);
  }
  return { added, removed: pool };
}

export interface ArmorTransition {
  absolabCount: number;
  umbraCount: number;
  /** Slots currently holding an AbsoLab piece — the ones available to swap. */
  swappableSlots: string[];
  steps: TransitionStep[];
  /** Smallest batch size that is not a net loss on set effects, or null. */
  crossover: number | null;
  /**
   * The batch to actually do: the step that scores best. Differs from
   * `crossover` when every partial swap loses but the full swap loses least.
   */
  recommendedBatch: number | null;
  headline: string;
  caveat: string;
}

/**
 * Set effects ONLY. The per-piece base stats of an Arcane Umbra piece over the
 * AbsoLab piece it replaces are not modelled — they are always a gain, so this
 * is the pessimistic bound, and the pessimistic bound is the one that stops a
 * player half-swapping. It is not the full answer and does not claim to be.
 */
export function armorTransition(items: Record<string, Item>, ctx?: DamageContext): ArmorTransition {
  const abso = setById("absolab");
  const umbra = setById("arcane-umbra");
  const active = activeSets(items);
  const absolabCount = active.find((s) => s.setId === "absolab")?.count ?? 0;
  const umbraCount = active.find((s) => s.setId === "arcane-umbra")?.count ?? 0;

  const swappableSlots = Object.keys(items).filter((slotId) => {
    const hit = resolveSet(slotId, items[slotId]);
    return hit?.setId === "absolab";
  });

  const steps: TransitionStep[] = [];
  if (abso && umbra && absolabCount > 0) {
    const baseline = addEffects(
      cumulativeEffects(abso, absolabCount),
      cumulativeEffects(umbra, umbraCount),
    );
    const baseIed = [...iedSources(abso, absolabCount), ...iedSources(umbra, umbraCount)];

    for (let k = 1; k <= absolabCount; k++) {
      const a = absolabCount - k;
      const u = umbraCount + k;
      const after = addEffects(cumulativeEffects(abso, a), cumulativeEffects(umbra, u));
      const afterIed = [...iedSources(abso, a), ...iedSources(umbra, u)];
      const net = subEffects(after, baseline);

      let damage: DamageEstimate | undefined;
      if (ctx) {
        // Removed IED lines come off as negatives, added ones as positives, so
        // the multiplicative combination stays honest either way.
        const { added, removed } = multisetDiff(baseIed, afterIed);
        damage = estimateDamage(ctx, {
          iedSources: [...added, ...removed.map((v) => -v)],
          bossPct: net.bossPct ?? 0,
          att: net.att ?? 0,
          flatStat: (net.mainStat ?? 0) + (net.allStat ?? 0),
        });
      }

      steps.push({
        swapCount: k,
        absolabCount: a,
        umbraCount: u,
        netEffects: net,
        damage,
        netPositive: (net.att ?? 0) >= 0 && (net.bossPct ?? 0) >= 0 && (net.iedPct ?? 0) >= 0,
        score: stepScore(net, damage),
      });
    }
  }

  const crossover = steps.find((s) => s.netPositive)?.swapCount ?? null;
  // The batch to actually do is the best-scoring one, which is usually the full
  // swap: every partial holds two half-sets and a half-set is worth far less
  // than half a set. `crossover` alone would report "never" in that case and
  // leave the player parked on AbsoLab forever.
  const best = steps.reduce<TransitionStep | null>(
    (m, s) => (m === null || s.score > m.score ? s : m),
    null,
  );
  const recommendedBatch = best?.swapCount ?? null;

  // The sentence is about what a SMALLER batch costs, so measure the worst step
  // strictly below the recommendation.
  const worst = steps
    .filter((s) => recommendedBatch !== null && s.swapCount < recommendedBatch)
    .reduce<TransitionStep | null>((m, s) => (m === null || s.score < m.score ? s : m), null);

  // Only name the terms that actually moved — "a net loss of 0 ATT" reads as a
  // bug even when the arithmetic is right.
  const lossPhrase = (s: TransitionStep): string => {
    const parts: string[] = [];
    const att = s.netEffects.att ?? 0;
    const boss = s.netEffects.bossPct ?? 0;
    const ied = s.netEffects.iedPct ?? 0;
    if (att < 0) parts.push(`${Math.abs(att)} ATT`);
    if (boss < 0) parts.push(`${Math.abs(boss)}% boss damage`);
    if (ied < 0) parts.push(`${Math.abs(ied)}% IED`);
    if (!parts.length && s.damage) return `${Math.abs(s.damage.pct).toFixed(1)}% damage`;
    return parts.length ? parts.join(" and ") : "set effects";
  };

  let headline: string;
  if (absolabCount === 0 && umbraCount === 0) {
    headline = "No AbsoLab or Arcane Umbra pieces equipped.";
  } else if (absolabCount === 0) {
    headline = `Arcane Umbra ${umbraCount}pc. Nothing left to transition.`;
  } else if (recommendedBatch === null) {
    headline = `AbsoLab ${absolabCount}pc + Umbra ${umbraCount}pc.`;
  } else if (recommendedBatch === 1 && (best?.netPositive ?? false)) {
    headline = `AbsoLab ${absolabCount}pc + Umbra ${umbraCount}pc — `
      + `the next single swap is already a net gain on set effects.`;
  } else if (worst) {
    headline = `Swap these ${recommendedBatch} slots together, not one at a time — `
      + `swapping fewer than ${recommendedBatch} is a net loss of ${lossPhrase(worst)}.`;
  } else {
    headline = `AbsoLab ${absolabCount}pc + Umbra ${umbraCount}pc. `
      + `Swap all ${recommendedBatch} remaining slots as one batch.`;
  }

  return {
    absolabCount,
    umbraCount,
    swappableSlots,
    steps,
    crossover,
    recommendedBatch,
    headline,
    caveat: "Set effects only. The Arcane Umbra piece's own base stats over the AbsoLab "
      + "piece are not modelled and are always a gain, so this is the floor, not the "
      + "verdict. Remember the Umbra Overall covers top AND bottom while counting as "
      + "ONE piece — swapping two AbsoLab armour slots into one Overall moves the count "
      + "by one, not two.",
  };
}

/* ------------------------------------------------- the unverified register */

export interface UnverifiedSetFact {
  name: string;
  why: string;
}

/**
 * Render this wherever set numbers are shown. Every set effect in this file is
 * transcribed from community documentation, not read off an in-game panel.
 */
export const UNVERIFIED_SET_CONSTANTS: UnverifiedSetFact[] = [
  {
    name: "Every tier in BUILTIN_SETS (verified: false on all seven sets)",
    why: "Transcribed from digitaltq.com/maplestory-set-effects and cross-checked against "
      + "maplestorywiki.net. Not read off an in-game Set Effect panel. The Superior Gollux "
      + "4pc (+30% IED, +30% Boss) is the one the whole ring warning rests on — confirm it first.",
  },
  {
    name: "boss-accessory piece list",
    why: "Sources name between six and ten qualifying items and disagree. The count can "
      + "under-report. Unmatched items are excluded, never assumed in.",
  },
  {
    name: "cra piece name templates for non-Bowman classes",
    why: "Royal / Eagle Eye / Trixter / Fafnir prefixes were read end to end only for the "
      + "Bowman set. Other classes are assumed to follow the same template.",
  },
  {
    name: "pensalir weapon membership",
    why: "Excluded. Whether Pensalir weapons count toward the set could not be sourced; "
      + "the tier list ending at 6 is consistent with armour-only but is not proof.",
  },
  {
    name: "BOSS_DEF_ARCANE / BOSS_DEF_GRANDIS",
    why: "300% / 380% are the figures rules.ts already quotes to the player. Treated as "
      + "documented inputs rather than independently sourced constants.",
  },
  {
    name: "DAMAGE_MODEL_INCLUDES_GENERAL_DAMAGE = false",
    why: "The boss-damage denominator omits general Damage% and final-damage multipliers, "
      + "which makes a set-effect loss read slightly worse than it is.",
  },
  {
    name: "TRANSITION_ATT_PER_BOSS_PCT_UNVERIFIED",
    why: "A rough exchange rate (1% boss ~ 10 ATT) used to rank AbsoLab->Umbra batch sizes "
      + "ONLY when no DamageContext is supplied. Pass a DamageContext and it is unused.",
  },
  {
    name: "DAMAGE_MODEL_MAIN_STAT_IS_LINEAR = true",
    why: "Flat main stat is treated as linear in total main stat; real damage scales on "
      + "roughly (4 * main + secondary), so this slightly overstates flat-stat value.",
  },
];
