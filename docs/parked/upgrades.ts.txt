// Upgrade finder — the Top Gear analogue.
//
// Enumerates every meso-priced upgrade available to a character, prices each one,
// asks the damage model what it is worth, and ranks by damage per 100M mesos.
// This is the only place in the app where two unrelated upgrades can be compared.
//
// It deliberately knows NOTHING about the damage formula and NOTHING about the
// star force cost curve. It expresses every upgrade as a StatDelta in the units
// the game already prints on a tooltip (`DEX +9%`, `ATT +12`, `Ignore DEF +35%`)
// and hands it to lib/damage.ts, and it asks lib/cost.ts what things cost. Those
// two modules own their constants; this one owns the enumeration and the ranking.
//
// ---------------------------------------------------------------------------
// ASSUMED INTERFACES (both files are being written in parallel with this one).
// If either signature lands differently, the fix belongs here, not there.
//
//   lib/damage.ts
//     export interface StatDelta {
//       mainFlat?, mainPct?, allStatPct?, attFlat?, attPct?,
//       dmgPct?, bossPct?, iedPct?, critDmgPct?, critRatePct?
//     }
//     export function relativeDamage(ch: Character): number
//     export function damageWith(ch: Character, d: StatDelta): number   // pure, no clone
//   Assumed further: IED composes multiplicatively, 1-(1-a)(1-b). At this
//   player's 92.9% IED an additive model overvalues an IED line by ~10x, so
//   every IED delta below is written as "the line's printed value" and the
//   composition is damage.ts's problem. If damage.ts adds IED additively the
//   weapon rows in this table are wrong by an order of magnitude.
//
//   lib/cost.ts
//     export const FLAME_RESET_MESOS: number                 // 3_000_000, v.271
//     export const CUBE_MESOS: { glowing: number; bright: number }
//     export const SF_COST_VERIFIED: boolean
//     export function expectedStarCost(
//       item, fromStar, toStar, opts?
//     ): { expected: number; p10: number; p90: number }      // Markov, charges booms
//   `opts` is passed as a pre-built object (not a fresh literal) so that extra
//   keys cost.ts does not know about are ignored rather than rejected by TS
//   excess-property checking.
// ---------------------------------------------------------------------------

import type { Character, Item, SlotDef, Tier } from "./rules";
import {
  SLOTS,
  LADDER,
  SOURCE,
  TIER_LABEL,
  canStarForce,
  sfCap,
  isDeadLine,
  statPct,
} from "./rules";
import type { StatDelta } from "./damage";
import { relativeDamage, damageWith } from "./damage";
import {
  FLAME_RESET_MESOS,
  CUBE_MESOS,
  SF_COST_VERIFIED,
  expectedStarCost,
} from "./cost";
import guide from "@/data/guide-graph.json";

/* =========================================================================
 * Public shape
 * ====================================================================== */

export type UpgradeKind = "starforce" | "potential" | "flame" | "gear";

/** How much to trust the number in the row. */
export type Confidence =
  /** Read from an in-game tooltip or a verified constant. */
  | "measured"
  /** Sourced constants, modelled outcome. The number is the right order of magnitude. */
  | "estimated"
  /** At least one input is an unsourced placeholder. Render this row degraded. */
  | "placeholder";

export interface Candidate {
  id: string;
  slot: string;
  kind: UpgradeKind;
  label: string;
  /** The upgrade expressed in tooltip units. The damage model turns it into damage. */
  delta: StatDelta;
  /** Percentage points of total damage, e.g. 2.1 means +2.1%. */
  damagePct: number;
  /** Expected mesos. Always > 0 — a free upgrade is not a meso decision. */
  mesos: number;
  /** 90th percentile mesos. The row is a lie without it; RNG is the product here. */
  mesosP90: number;
  /** damagePct per 100M mesos. The one unit this whole feature is quoted in. */
  ratio: number;
  confidence: Confidence;
  /** The slot's gear will be replaced at the next LADDER rung, so this spend is rented. */
  transient?: boolean;
  note?: string;
  /**
   * Mutually exclusive set. `weapon:starforce` emits →15, →17, →20, →22 as four
   * rows; a budget plan may buy at most one of them. Not in the original spec —
   * without it the greedy fill double-counts nested upgrades.
   */
  group: string;
  /**
   * What the default sort actually ordered on: `ratio`, times TRANSIENT_DEMOTION
   * for rented upgrades. Exposed so the table can explain why a row with a lower
   * printed ratio sits above one with a higher one, instead of looking broken.
   */
  sortScore?: number;
}

/**
 * The next rung on the gear ladder. Farm-gated, not meso-gated: it has no price,
 * so it can never be ratio-ranked against a meso spend without producing a
 * garbage #1 row. Separate list, separate sort.
 */
export interface GearStep {
  id: string;
  slot: string;
  kind: "gear";
  label: string;
  /** Required level of the target item — the sort key. */
  itemLevel: number;
  source: string;
  /** No damage estimate: base stat tables for named gear sets are not in the repo. */
  note: string;
}

export interface FindOpts {
  /** Safeguard doubles cost and removes boom. Legal through 18 only. */
  safeguard?: boolean;
  /** 0.3 during the 30%-off Sunny Sunday. Passed straight through to cost.ts. */
  eventDiscount?: number;
  /**
   * Cost of replacing a boomed item, per slot id. In Reboot this is a farming
   * cost, not a meso cost, so there is no honest default that is a number:
   * anything finite prices a Lucid drop as if it were on the auction house.
   */
  replacementCost?: Record<string, number>;
  /** Used when a slot has no entry above and the item is not a boss drop. */
  defaultReplacementCost?: number;
  /**
   * Rows below this are noise. Set it to the damage model's own stated
   * resolution once damage.ts exports one; 0.01 (one hundredth of a percent)
   * is a floor, not a claim about accuracy.
   */
  minDamagePct?: number;
  /** Demote (do not hide) upgrades on gear the ladder says gets replaced. */
  demoteTransient?: boolean;
  /** Star force decision boundaries. Nobody taps once, so nobody wants per-star rows. */
  starTargets?: number[];
}

export interface BudgetPlan {
  picks: Candidate[];
  spent: number;
  /** Sum of the individual damagePct values. Upgrades are not additive; see note. */
  totalDamagePct: number;
  method: string;
  note: string;
}

/* =========================================================================
 * Constants this module owns
 * ====================================================================== */

/** The unit. Printed in the column header; every row is quoted in it. */
export const RATIO_UNIT_MESOS = 100_000_000;

/**
 * Star force decision boundaries. 15 is the last safe star, 17 is the classic
 * stopping point, 22 is the endgame wall, 20 is the cheap plateau before it.
 */
export const DEFAULT_STAR_TARGETS = [15, 17, 20, 22];

/**
 * How much a ranked row is worth when the item underneath it is scheduled for
 * replacement. A judgement call, not a game constant: stars partially survive
 * via Star Force Transfer (you keep stars-1, guide-graph `starforce.transfer`)
 * but potential does not transfer at all. One number for both is deliberately
 * crude — it exists to stop a 22-star recommendation on a Lv150 CRA hat that
 * this Lv244 player replaces at Arcane Umbra.
 */
export const TRANSIENT_DEMOTION = 0.4;

/**
 * What a boom costs beyond the stars it eats, for gear that is NOT a boss drop.
 *
 * Zero, and that is a modelling choice with a reason rather than an oversight:
 * CRA, Absolab and Arcane Umbra pieces are weekly-farmable or craftable in
 * Reboot, so the meso loss of a destroyed one is the re-starring from the trace
 * recovery star — which lib/cost.ts already charges — and the rest is time.
 * Boss-drop items (`Item.bossDrop`) default to Infinity instead, which makes
 * expectedStarCost non-finite and drops the row entirely: the model refuses to
 * recommend a risky tap on something it cannot price rather than pricing the
 * loss at zero. Override per slot with `FindOpts.replacementCost`.
 */
export const DEFAULT_REPLACEMENT_COST_MESOS = 0;

/* ---- UNSOURCED: star force stat gains -----------------------------------
 * The per-star stat table (how much flat main stat and ATT one star actually
 * grants, by item level band) could NOT be sourced in this session —
 * strategywiki.org and maplestorywiki.net both returned HTTP 403.
 *
 * What lands here when it is sourced: a table keyed by item level band and
 * star index giving flat main stat and flat ATT, because the real system pays
 * per-star amounts that step at 15 and scale with item level. The placeholder
 * below has the right SHAPE and approximately the right magnitude for Lv150
 * gear and nothing more. Every star force candidate is therefore emitted with
 * confidence 'placeholder' and must render degraded.
 * ------------------------------------------------------------------------ */
export const STAR_STAT_GAIN_VERIFIED = false;

/** PLACEHOLDER. Flat main stat granted per star, by the star being gained. */
const PLACEHOLDER_MAIN_PER_STAR: ReadonlyArray<readonly [number, number]> = [
  [5, 2],
  [10, 3],
  [15, 5],
  [20, 7],
  [25, 9],
  [30, 11],
];
/** PLACEHOLDER. Flat ATT per star from 15 up, where the ATT jumps begin. */
const PLACEHOLDER_ATT_PER_STAR_FROM_15 = 3;

/**
 * PLACEHOLDER, unverified. See STAR_STAT_GAIN_VERIFIED.
 * Item level is accepted and ignored, which is precisely the missing term —
 * the signature is already right for the sourced table.
 */
export function starForceStatGain(
  itemLevel: number,
  fromStar: number,
  toStar: number,
): StatDelta {
  let main = 0;
  let att = 0;
  for (let s = fromStar + 1; s <= toStar; s++) {
    const band = PLACEHOLDER_MAIN_PER_STAR.find(([maxStar]) => s <= maxStar);
    main += band ? band[1] : 0;
    if (s > 15) att += PLACEHOLDER_ATT_PER_STAR_FROM_15;
  }
  void itemLevel;
  return { mainFlat: main, attFlat: att };
}

/* ---- UNSOURCED: cubes per tier-up ---------------------------------------
 * Nexon has never published tier-up rates for the post-v.239 cubes, and the
 * community numbers that exist are explicitly uncited. DigitalTQ's potential
 * guide (the same source guide-graph uses) publishes rates only for the
 * retired Red / Black cubes (Epic 10%/20%, Unique 5%/10%, Legendary
 * 2.5%/5% — "based on data used in Reboot World"), and notes the new cubes
 * are NOT equivalent: Glowing is cheaper than Red was and rates lower.
 * The only modern figures found were an uncited calculator page
 * (crazykoder.dev/calculator/maplestory-cube-calculator.html, read 2026-09-11)
 * quoting Unique→Legendary at roughly 1-3% per Bright and 0.4-0.9% per Glowing,
 * and Epic→Unique at "10-30 Bright or 30-70 Glowing".
 *
 * Those midpoints are what is below. They are placeholders. Every potential
 * candidate is emitted with confidence 'placeholder'.
 * ------------------------------------------------------------------------ */
export const EXPECTED_CUBES_TO_TIER_VERIFIED = false;

/** PLACEHOLDER. Expected cubes to REACH the keyed tier from the one below it. */
export const EXPECTED_CUBES_TO_TIER: Record<
  Exclude<Tier, "none">,
  { glowing: number; bright: number }
> = {
  rare: { glowing: 3, bright: 2 },
  epic: { glowing: 10, bright: 6 },
  unique: { glowing: 50, bright: 20 },
  legendary: { glowing: 154, bright: 50 },
};

/**
 * PLACEHOLDER. Expected count of lines that actually do something once the
 * item sits at the given tier. Crude because a Legendary item carries one
 * legendary line and two lower ones, and this collapses that into a scalar.
 */
export const EXPECTED_GOOD_LINES: Record<Tier, number> = {
  none: 0,
  rare: 1.2,
  epic: 1.4,
  unique: 1.6,
  legendary: 1.8,
};

/* ---- UNSOURCED: weapon-line values --------------------------------------
 * guide-graph `potential.tiers` gives per-line values for MAIN STAT only.
 * The Boss Damage % / Ignore DEF % / ATT % line values that make the weapon,
 * secondary and emblem the best slots in the game are not in the repo and
 * were not sourced here. Placeholder, flagged, and used only so the three
 * highest-value slots are not silently missing from the table.
 * ------------------------------------------------------------------------ */
export const ATK_LINE_VALUES_VERIFIED = false;

/** PLACEHOLDER. Value of one good line on an attack-potential slot, by tier. */
export const ATK_LINE_VALUE: Record<Tier, { attPct: number; bossPct: number; iedPct: number }> = {
  none: { attPct: 0, bossPct: 0, iedPct: 0 },
  rare: { attPct: 3, bossPct: 0, iedPct: 0 },
  epic: { attPct: 6, bossPct: 0, iedPct: 15 },
  unique: { attPct: 9, bossPct: 20, iedPct: 30 },
  legendary: { attPct: 12, bossPct: 30, iedPct: 35 },
};

/* ---- UNSOURCED: flame line values ---------------------------------------
 * The community-standard formula for a single-stat bonus line is
 * `tier * (floor(itemLevel / 20) + 1)`, which every flame calculator uses and
 * which reproduces the Lv150 tooltips in rules.ts exampleCharacter (a Lv150
 * item pays 8 per tier: the Tyrant cape's STR +24 / INT +24 is tier 3). It
 * could not be verified against a primary source in this session —
 * whackybeanz's flame guide does not state it and the wikis 403'd.
 * ------------------------------------------------------------------------ */
export const FLAME_LINE_VALUE_VERIFIED = false;

/** PLACEHOLDER-ADJACENT: community-standard formula, unverified here. */
export function flameLineValue(itemLevel: number, tier: number): number {
  return tier * (Math.floor(itemLevel / 20) + 1);
}

/**
 * Expected tier of a re-rolled line. guide-graph `flames.system` gives the
 * bounds ("tier 2 minimum, rarely tier 5" / "tier 4 minimum, rarely tier 7"
 * on flame-advantaged boss gear) but not the distribution, so these midpoints
 * are interpolated, not sourced.
 */
export const EXPECTED_FLAME_TIER = { normal: 2.6, bossDrop: 4.6 };

/** PLACEHOLDER. Useful lines a reset lands on a bare item (cap is 4 distinct stats). */
export const EXPECTED_FLAME_LINES_ON_BARE_ITEM = 2.5;

/** Everything above that a reader is entitled to be told about, in one list. */
export const UNVERIFIED_CONSTANTS: ReadonlyArray<{ name: string; whatItBreaks: string; where: string }> = [
  {
    name: "starForceStatGain (per-star stat table)",
    whatItBreaks: "every star force row's damage",
    where: "StrategyWiki 'MapleStory/Spell Trace and Star Force', or an in-game tooltip diff at two known (level, star) pairs",
  },
  {
    name: "EXPECTED_CUBES_TO_TIER",
    whatItBreaks: "every potential row's cost",
    where: "Nexon probability disclosure for Glowing / Bright cubes, or a large Reboot cubing sample",
  },
  {
    name: "ATK_LINE_VALUE",
    whatItBreaks: "weapon / secondary / emblem potential rows",
    where: "per-tier line value tables for Boss Damage %, Ignore DEF % and ATT %",
  },
  {
    name: "flameLineValue",
    whatItBreaks: "the size (not the price) of every flame row",
    where: "MapleStory Wiki 'Bonus Stats' stat tables",
  },
  {
    name: "SF_COST_VERIFIED (in lib/cost.ts)",
    whatItBreaks: "every star force row's cost",
    where: "owned by lib/cost.ts — this module only reports its flag",
  },
];

/** Header material for the /upgrades page, so the UI does not retype any of it. */
export const MODEL_NOTES = {
  /** Matches the lastVerified discipline on all 29 data/guide-graph.json nodes. */
  dataLastVerified: "2026-09-11",
  gameVersion: "v.271",
  world: "GMS Heroic (Reboot)",
  verified: [
    "Flame reset cost — 3,000,000 mesos (v.271 patch notes, guide-graph flames.system)",
    "Cube meso prices — Glowing 12M / Bright 22M (guide-graph potential.cubes)",
    "Star force success / fail / boom rates, 30 rows (guide-graph starforce.rates)",
    "Potential main-stat line values by item level (guide-graph potential.tiers)",
  ],
  unverified: UNVERIFIED_CONSTANTS.map((u) => u.name),
  starForceCostVerified: SF_COST_VERIFIED,
} as const;

/* =========================================================================
 * guide-graph reads — the graph is the source of truth, never a second copy
 * ====================================================================== */

interface GuideNode {
  id: string;
  headers?: string[];
  rows?: string[][];
}
const NODES = (guide as unknown as { nodes: GuideNode[] }).nodes;

function node(id: string): GuideNode | undefined {
  return NODES.find((n) => n.id === id);
}

function pct(s: string): number {
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * potential.tiers: "Item level | Rare | Epic | Unique | Legendary", rows banded
 * "1-30", "31-70", "71-150", "151+". Parsed rather than transcribed so a patch
 * job that rewrites the node rewrites this too.
 */
const POT_TIER_BANDS: Array<{ min: number; max: number; v: Record<Tier, number> }> = (() => {
  const n = node("potential.tiers");
  const out: Array<{ min: number; max: number; v: Record<Tier, number> }> = [];
  for (const row of n?.rows ?? []) {
    const band = row[0] ?? "";
    const m = band.match(/(\d+)\s*-\s*(\d+)/);
    const open = band.match(/(\d+)\s*\+/);
    const min = m ? parseInt(m[1], 10) : open ? parseInt(open[1], 10) : 0;
    const max = m ? parseInt(m[2], 10) : Number.MAX_SAFE_INTEGER;
    out.push({
      min,
      max,
      v: { none: 0, rare: pct(row[1] ?? ""), epic: pct(row[2] ?? ""), unique: pct(row[3] ?? ""), legendary: pct(row[4] ?? "") },
    });
  }
  return out;
})();

/** Value of one main-stat potential line at a tier, for an item of this level. */
export function potentialLinePct(itemLevel: number, tier: Tier): number {
  const band = POT_TIER_BANDS.find((b) => itemLevel >= b.min && itemLevel <= b.max);
  return band ? band.v[tier] : 0;
}

const TIER_ORDER: Tier[] = ["none", "rare", "epic", "unique", "legendary"];
function nextTier(t: Tier): Tier | null {
  const i = TIER_ORDER.indexOf(t);
  return i < 0 || i === TIER_ORDER.length - 1 ? null : TIER_ORDER[i + 1];
}

/* =========================================================================
 * Small helpers
 * ====================================================================== */

/**
 * Expected cost m of a geometric process has P(X > n) = (1 - 1/m)^n, so the
 * 90th percentile is m * ln(10) to within a rounding. Used wherever the cost
 * is "keep buying one thing until it works" and cost.ts is not involved.
 */
function geometricP90(expected: number): number {
  return Math.ceil(expected * Math.LN10);
}

function ratioOf(damagePct: number, mesos: number): number {
  if (!(mesos > 0) || !isFinite(mesos)) return 0;
  return damagePct / (mesos / RATIO_UNIT_MESOS);
}

/** Does this slot's ladder have a rung above what is equipped right now? */
function willBeReplaced(slotId: string, it: Item): boolean {
  const lad = LADDER[slotId];
  if (!lad) return false;
  let idx = -1;
  lad.forEach((rung, i) => {
    if (it.lvl >= rung[1]) idx = i;
  });
  return idx > -1 && idx < lad.length - 1;
}

function slotItem(ch: Character, slot: SlotDef): Item | null {
  return ch.items[slot.id] ?? null;
}

/** Star force cost options, built as a variable so unknown keys pass through. */
interface SfCostOpts {
  safeguard: boolean;
  eventDiscount: number;
  replacementCost: number;
}

/* =========================================================================
 * Enumerators
 * ====================================================================== */

type Emit = (c: Omit<Candidate, "damagePct" | "ratio">) => void;

/**
 * (a) Star force. Emitted at decision boundaries only — current→15, →17, →20,
 * →22 — because per-star rows are noise: nobody taps once and stops.
 * Eligibility is rules.ts's canStarForce/sfCap, never re-derived here; they
 * already handle superior gear's 15 cap, the shield-only secondary exception
 * and the noSf tooltip opt-out, and a second copy would drift.
 */
function enumerateStarForce(ch: Character, slot: SlotDef, opts: Required<Pick<FindOpts, "safeguard" | "eventDiscount" | "defaultReplacementCost" | "starTargets">> & { replacementCost: Record<string, number> }, emit: Emit): void {
  const it = slotItem(ch, slot);
  if (!it || !canStarForce(slot, it)) return;

  const cap = sfCap(it);
  const from = Math.min(it.star || 0, cap);
  if (from >= cap) return;

  const replacement = opts.replacementCost[slot.id] ?? (it.bossDrop ? Infinity : opts.defaultReplacementCost);
  const transient = willBeReplaced(slot.id, it);

  const targets = [...opts.starTargets, cap]
    .map((t) => Math.min(t, cap))
    .filter((t) => t > from)
    .sort((a, b) => a - b)
    .filter((t, i, arr) => arr.indexOf(t) === i);

  for (const to of targets) {
    // Safeguard is only legal through 18; past that the option does not exist
    // and pretending otherwise would halve the cost of the riskiest taps.
    const safeguard = opts.safeguard && from < 18;
    const sfOpts: SfCostOpts = {
      safeguard,
      eventDiscount: opts.eventDiscount,
      replacementCost: replacement,
    };
    const cost = expectedStarCost(it, from, to, sfOpts);
    if (!(cost.expected > 0) || !isFinite(cost.expected)) continue; // priced at Infinity ⇒ irreplaceable, refuse to recommend

    emit({
      id: `${slot.id}:sf:${from}-${to}`,
      slot: slot.n,
      kind: "starforce",
      label: `${it.name} ${from} → ${to} stars`,
      delta: starForceStatGain(it.lvl, from, to),
      mesos: cost.expected,
      mesosP90: cost.p90,
      confidence: "placeholder",
      transient,
      group: `${slot.id}:starforce`,
      note: [
        !STAR_STAT_GAIN_VERIFIED ? "Per-star stat gain is an unsourced placeholder." : "",
        !SF_COST_VERIFIED ? "Star force cost formula is unverified — treat the meso figure as an estimate." : "",
        to > 15 ? (safeguard ? "Safeguarded (double cost, no boom) through 18." : "Boom risk is priced in above 15 stars.") : "No boom risk below 15 stars.",
        // Boss drops are priced at Infinity on destruction, so every target
        // above 15 was refused rather than guessed at. Say so on the row the
        // player can actually see, or the omission looks like a bug.
        to <= 15 && !isFinite(replacement) && cap > 15
          ? "Nothing above 15 stars is listed for this item: it is a boss drop, and this model will not put a meso price on re-farming one."
          : "",
        transient ? "This item is scheduled for replacement; Star Force Transfer returns stars-1 to the new one." : "",
      ].filter(Boolean).join(" "),
    });
  }
}

/**
 * (b) Potential. One candidate per tier-up step. Main-stat line values come
 * from guide-graph potential.tiers; the cube counts to get there do not exist
 * in the repo and are a flagged placeholder.
 */
function enumeratePotential(ch: Character, slot: SlotDef, emit: Emit): void {
  const it = slotItem(ch, slot);
  if (!it || slot.pot === "no" || it.noPot) return;

  const cur: Tier = it.pot || "none";
  const to = nextTier(cur);
  if (!to) return;

  const cubes = EXPECTED_CUBES_TO_TIER[to as Exclude<Tier, "none">];
  const viaGlowing = cubes.glowing * CUBE_MESOS.glowing;
  const viaBright = cubes.bright * CUBE_MESOS.bright;
  const useBright = viaBright <= viaGlowing;
  const mesos = useBright ? viaBright : viaGlowing;

  const lines = (it.p || []).filter(Boolean);
  let delta: StatDelta;
  if (slot.pot === "atk") {
    // Weapon-family slots. Count what is already there so the delta is the
    // improvement, not the absolute — a weapon already carrying two damage
    // lines gains far less from a tier-up than a bare one.
    const good = lines.filter((l) => /boss|ignore|\batt\b|attack|damage/i.test(l)).length;
    const gained = Math.max(0, EXPECTED_GOOD_LINES[to] - good);
    const v = ATK_LINE_VALUE[to];
    // Split the expected gained lines across the three line types this slot
    // actually rolls. IED is handed over as a printed line value; damage.ts
    // composes it multiplicatively against the character's existing 92.9%.
    delta = {
      bossPct: v.bossPct * gained * 0.5,
      iedPct: v.iedPct * gained * 0.3,
      attPct: v.attPct * gained * 0.2,
    };
  } else {
    // Stat and crit slots. Gloves are treated as a stat slot on purpose:
    // rules.ts already tells this player to run %stat there until the rest of
    // the gear is finished, and the per-tier crit damage line values are not
    // in the repo.
    const already = lines.reduce((a, l) => a + statPct(l, ch.main), 0);
    const expected = EXPECTED_GOOD_LINES[to] * potentialLinePct(it.lvl, to);
    delta = { mainPct: Math.max(0, expected - already) };
  }

  emit({
    id: `${slot.id}:pot:${cur}-${to}`,
    slot: slot.n,
    kind: "potential",
    label: `${it.name} potential ${TIER_LABEL[cur]} → ${TIER_LABEL[to]}`,
    delta,
    mesos,
    mesosP90: geometricP90(mesos),
    confidence: "placeholder",
    transient: willBeReplaced(slot.id, it),
    group: `${slot.id}:potential`,
    note: [
      `Priced as ${useBright ? `${cubes.bright} Bright` : `${cubes.glowing} Glowing`} cubes — an unsourced expected count.`,
      "In Heroic, Solid cubes do the same job for zero mesos but are drop-limited, so this price is the cost of not waiting.",
      slot.pot === "atk" ? "Boss / IED / ATT line values are placeholders." : "",
    ].filter(Boolean).join(" "),
  });
}

/**
 * (c) Flame. The one axis where the price is an exact, sourced constant and the
 * odds are documented, which is why it dominates the ratio column — correctly.
 * Priced as exactly one 3M reset. Since v.271 lets the player keep the better
 * of the old and new roll, the expected gain cannot be negative; this model
 * ignores that keep-the-better effect and therefore UNDER-states the row.
 */
function enumerateFlame(ch: Character, slot: SlotDef, emit: Emit): void {
  const it = slotItem(ch, slot);
  if (!it || !slot.fl || it.noFl) return;

  const fl = (it.f || []).filter(Boolean);
  const dead = fl.filter((l) => isDeadLine(l, ch.main));
  const bare = fl.length === 0;
  if (!dead.length && !bare) return;

  const tier = it.bossDrop ? EXPECTED_FLAME_TIER.bossDrop : EXPECTED_FLAME_TIER.normal;
  const perLine = flameLineValue(it.lvl, tier);
  const linesWon = bare ? EXPECTED_FLAME_LINES_ON_BARE_ITEM : dead.length;

  emit({
    id: `${slot.id}:flame`,
    slot: slot.n,
    kind: "flame",
    label: bare
      ? `${it.name} — roll a flame`
      : `${it.name} — reset ${dead.length} dead flame line${dead.length > 1 ? "s" : ""}`,
    // Only flat main stat is counted. A reset can also land All Stat % or ATT,
    // both worth more, so this is a floor on the row rather than a midpoint.
    delta: { mainFlat: perLine * linesWon },
    mesos: FLAME_RESET_MESOS,
    mesosP90: FLAME_RESET_MESOS,
    confidence: "estimated",
    transient: false, // 3M is never worth deferring, replacement or not
    group: `${slot.id}:flame`,
    note: [
      bare ? "Item has no bonus stats at all." : `Dead: ${dead.join(" · ")}.`,
      it.bossDrop ? "Flame advantaged (boss drop): tier 4 minimum, up to tier 7." : "Tier 2 minimum at Black Rebirth Flame rates.",
      "Priced as one reset. Line value formula is community-standard but unverified.",
    ].filter(Boolean).join(" "),
  });
}

/** (d) Gear tier. Farm-gated. Never ratio-sorted; see GearStep. */
export function findGearSteps(ch: Character): GearStep[] {
  const out: GearStep[] = [];
  for (const slot of SLOTS) {
    const lad = LADDER[slot.id];
    if (!lad) continue;
    const it = slotItem(ch, slot);

    if (!it) {
      const [nm, lv] = lad[0];
      out.push({
        id: `${slot.id}:gear:0`,
        slot: slot.n,
        kind: "gear",
        // Some first rungs are generic ("Best available", "Any android"), and
        // "equip Best available" reads like a bug rather than advice.
        label: lv ? `Empty — equip ${nm}` : `Empty — anything here is free stat (${nm})`,
        itemLevel: lv,
        source: SOURCE[nm] || "",
        note: "Slot is empty. No meso price: this is farm-gated, not meso-gated.",
      });
      continue;
    }

    let idx = -1;
    lad.forEach((rung, i) => {
      if (it.lvl >= rung[1]) idx = i;
    });
    if (idx < 0 || idx >= lad.length - 1) continue;
    const [nm, lv] = lad[idx + 1];
    out.push({
      id: `${slot.id}:gear:${idx + 1}`,
      slot: slot.n,
      kind: "gear",
      label: `${it.name} → ${nm}`,
      itemLevel: lv,
      source: SOURCE[nm] || "",
      note: "Farm-gated, not meso-gated. Potential does not transfer to the new item; stars transfer at stars-1.",
    });
  }
  return out.sort((a, b) => a.itemLevel - b.itemLevel);
}

/* =========================================================================
 * The finder
 * ====================================================================== */

/**
 * Every meso-priced upgrade on the character, ranked by damage per 100M mesos.
 *
 * ~150-250 hypotheticals per run, each one damageWith() against a base measured
 * once. damageWith must not clone the Character or this is quadratic garbage.
 */
export function findUpgrades(ch: Character, opts: FindOpts = {}): Candidate[] {
  const o = {
    safeguard: opts.safeguard ?? true,
    eventDiscount: opts.eventDiscount ?? 0,
    replacementCost: opts.replacementCost ?? {},
    defaultReplacementCost: opts.defaultReplacementCost ?? DEFAULT_REPLACEMENT_COST_MESOS,
    minDamagePct: opts.minDamagePct ?? 0.01,
    demoteTransient: opts.demoteTransient ?? true,
    starTargets: opts.starTargets ?? DEFAULT_STAR_TARGETS,
  };

  const base = relativeDamage(ch);
  const out: Candidate[] = [];

  const emit: Emit = (c) => {
    const damagePct = base > 0 ? (damageWith(ch, c.delta) / base - 1) * 100 : 0;
    if (!isFinite(damagePct) || damagePct < o.minDamagePct) return; // below resolution — a sidegrade, not a row
    if (!(c.mesos > 0) || !isFinite(c.mesos)) return; // a free or unpriceable upgrade is not a meso decision
    out.push({ ...c, damagePct, ratio: ratioOf(damagePct, c.mesos) });
  };

  for (const slot of SLOTS) {
    enumerateStarForce(ch, slot, o, emit);
    enumeratePotential(ch, slot, emit);
    enumerateFlame(ch, slot, emit);
  }

  return sortCandidates(out, o.demoteTransient);
}

/**
 * Default sort: ratio descending, with transient rows demoted rather than
 * hidden. The displayed `ratio` stays honest — only the ordering is adjusted,
 * so a sortable table can re-sort on the raw column and get the raw answer.
 */
export function sortCandidates(cands: Candidate[], demoteTransient = true): Candidate[] {
  const key = (c: Candidate) => c.ratio * (demoteTransient && c.transient ? TRANSIENT_DEMOTION : 1);
  return cands.map((c) => ({ ...c, sortScore: key(c) })).sort((a, b) => b.sortScore - a.sortScore);
}

/**
 * "What is the single best thing I can do with 500 million mesos right now?"
 *
 * Greedy ratio-ordered fill. This is a knapsack and greedy does not solve a
 * knapsack; saying so in the label costs nothing and buying the lie costs the
 * player a weekend. Nested rows (0→15 and 0→17 on the same slot) belong to one
 * `group` and at most one is taken.
 */
export function planBudget(cands: Candidate[], budget: number, demoteTransient = true): BudgetPlan {
  const ranked = sortCandidates(cands, demoteTransient);
  const taken = new Set<string>();
  const picks: Candidate[] = [];
  let spent = 0;

  for (const c of ranked) {
    if (taken.has(c.group)) continue;
    if (spent + c.mesos > budget) continue;
    picks.push(c);
    taken.add(c.group);
    spent += c.mesos;
  }

  return {
    picks,
    spent,
    totalDamagePct: picks.reduce((a, c) => a + c.damagePct, 0),
    method: "greedy — not proven optimal",
    note:
      "Each row is measured against your CURRENT character, so the total is an upper bound: " +
      "buying two %-stat upgrades together yields slightly less than the sum. Costs are expected " +
      "values; the p90 column is what a bad night actually looks like.",
  };
}

/** Everything the /upgrades page needs, in one call. */
export function analyse(ch: Character, opts: FindOpts = {}) {
  const ranked = findUpgrades(ch, opts);
  return {
    ranked,
    gear: findGearSteps(ch),
    meta: MODEL_NOTES,
    ratioUnit: RATIO_UNIT_MESOS,
    /** True when any row on screen leans on an unsourced constant. */
    hasPlaceholders: ranked.some((c) => c.confidence === "placeholder"),
  };
}

/* =========================================================================
 * Invariants
 * ====================================================================== */

/**
 * The assertions tools/upgrade-check.ts should run — kept here so the tool is a
 * three-line wrapper and so the invariants live next to the code they constrain.
 * (tools/ is outside this module's file ownership; the wrapper is someone else's
 * to write, and it only needs to call this and exit non-zero on failures.)
 */
export function selfCheck(ch: Character): { ok: boolean; failures: string[]; top: Candidate[] } {
  const failures: string[] = [];
  const cands = findUpgrades(ch);

  for (const c of cands) {
    if (!(c.mesos > 0)) failures.push(`${c.id}: cost is not positive (${c.mesos})`);
    if (!(c.mesosP90 >= c.mesos)) failures.push(`${c.id}: p90 (${c.mesosP90}) below expected (${c.mesos})`);
    if (!(c.damagePct > 0)) failures.push(`${c.id}: non-positive damage`);

    const slot = SLOTS.find((s) => s.n === c.slot);
    const it = slot ? ch.items[slot.id] : undefined;
    if (it) {
      if (c.kind === "starforce" && it.noSf) failures.push(`${c.id}: star force candidate on a noSf item`);
      if (c.kind === "potential" && it.noPot) failures.push(`${c.id}: potential candidate on a noPot item`);
      if (c.kind === "flame" && it.noFl) failures.push(`${c.id}: flame candidate on a noFl item`);
      if (c.kind === "starforce" && slot && !canStarForce(slot, it)) failures.push(`${c.id}: star force candidate rules.ts says is impossible`);
    }
  }

  // Expected star cost must be monotonically increasing in target star.
  const byGroup = new Map<string, Candidate[]>();
  for (const c of cands) {
    if (c.kind !== "starforce") continue;
    const g = byGroup.get(c.group) ?? [];
    g.push(c);
    byGroup.set(c.group, g);
  }
  for (const [g, rows] of byGroup) {
    const targets = rows
      .map((r) => ({ to: parseInt(r.id.split("-").pop() || "0", 10), mesos: r.mesos }))
      .sort((a, b) => a.to - b.to);
    for (let i = 1; i < targets.length; i++) {
      if (targets[i].mesos < targets[i - 1].mesos) {
        failures.push(`${g}: cost to ${targets[i].to} stars is cheaper than to ${targets[i - 1].to}`);
      }
    }
  }

  // Acceptance test. The Tyrant Charon Cloak carries two dead lines for a DEX
  // class and a 3M fix; rules.ts calls it "free power sitting on the floor".
  // After this feature it has to be a number, and a high-ranking one.
  const top = cands.slice(0, 5);
  if (ch.items.cape && (ch.items.cape.f || []).some((l) => isDeadLine(l, ch.main))) {
    if (!top.some((c) => c.kind === "flame" && c.slot === "Cape")) {
      failures.push("cape flame reset is not in the top five — the ratio ranking is not working");
    }
  }

  return { ok: failures.length === 0, failures, top };
}
