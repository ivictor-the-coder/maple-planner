// Cube / potential simulator, damage model, and the meso-per-1%-damage ranking.
//
// WHY THIS IS ONE FILE. The build order for this feature called for lib/cubeRates.ts,
// lib/cubes.ts, lib/upgrades.ts and tools/cubeCheck.ts. File ownership for this agent
// is lib/cubes.ts alone — eleven builders are in the repo concurrently. So the four
// concerns live here behind four clearly separated section banners and are exported
// individually. Splitting them later is a pure move operation: nothing in here imports
// anything that does not already exist on disk.
//   - RATES      pure constants, every one a Sourced<T> record. No number is ever
//                written inline in a formula below this section.
//   - MATH       exact closed-form tier-up and line-hitting. No Monte Carlo in the
//                answer path (there is one in selfCheck(), to prove the closed form).
//   - DAMAGE     dmgIndex / dmgDelta — the repo had no damage model at all before this.
//   - RANK       mesoPerOnePercentDamage over cubes, star force and flame resets.
//
// WHY NO MONTE CARLO. Tier-up is a Markov chain on four states and line-hitting is an
// enumeration over a few thousand triples. Both are exact and take microseconds, so the
// UI computes on render with no server call, no spinner and no sampling error to explain.
//
// THE ONE RULE THAT MATTERS HERE. Nexon has never published GMS cube rates. The KMS
// disclosure (below) is real and cited, but KMS is not GMS, so every rate ships with
// placeholder: true. Callers MUST check planConfidence() / CONSTANT_REGISTRY and suppress
// absolute cube counts and meso totals when anything on the path is a placeholder. A
// ranked order survives wrong absolute rates; a confident "748M mesos" does not, and it
// sends a real person to grind for nothing.

import {
  SLOTS,
  canStarForce,
  isDeadLine,
  sfCap,
  statPct,
  type Character,
  type Item,
  type MainStat,
  type PotKind,
  type SlotDef,
  type Tier,
} from "./rules";

/* ==========================================================================
 * SECTION 1 — RATES. Constants only. Nothing in here computes anything.
 * ========================================================================== */

/** Mirrors the lastVerified / patchVersion / source convention every node in
 *  data/guide-graph.json already uses, so a reader who has seen the guide data
 *  already knows how to read these. */
export interface Sourced<T> {
  readonly value: T;
  readonly source: string;
  readonly verifiedOn: string;
  readonly patch: string;
  /** true = NOT sourced for GMS. Absolute figures derived from it must be hidden. */
  readonly placeholder: boolean;
  readonly note?: string;
}

const GMS_PATCH = "v.271";
const CHECKED = "2026-09-11";

/** The KMS Black Cube disclosure page. Nexon Korea publishes this under the Korean
 *  probability-disclosure law; it is the only first-party cube probability table that
 *  exists in any region. GMS Bright Cube is the Black Cube's replacement (GMS v.239
 *  cube revamp) plus a double-rank-up branch, so these are the closest real numbers
 *  that exist — but they are KMS numbers, so everything derived from them is flagged. */
const KMS_BLACK = "maplestory.nexon.com/Guide/OtherProbability/cube/black (Nexon KR official disclosure)";
const KMS_RED = "maplestory.nexon.com/Guide/OtherProbability/cube/red (Nexon KR official disclosure)";
const GUIDE_GRAPH = "data/guide-graph.json";

export type CubeType = "mystical" | "hard" | "solid" | "glowing" | "bright";

export const CUBE_LABEL: Record<CubeType, string> = {
  mystical: "Mystical",
  hard: "Hard",
  solid: "Solid",
  glowing: "Glowing",
  bright: "Bright",
};

/** Tier order. "none" is the unlocked-but-empty state and is not a cubeable tier. */
export const TIER_ORDER: readonly Tier[] = ["none", "rare", "epic", "unique", "legendary"] as const;
export const tierIndex = (t: Tier): number => TIER_ORDER.indexOf(t);

/** The ceiling each cube can take an item to. A cube that cannot reach the target tier
 *  is not a slow plan, it is an impossible one — plans must return null, not a big number. */
export const CUBE_MAX_TIER: Sourced<Record<CubeType, Tier>> = {
  value: { mystical: "epic", hard: "unique", solid: "legendary", glowing: "legendary", bright: "legendary" },
  source: `${GUIDE_GRAPH} node potential.cubes`,
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/** Reboot/Heroic has no cash shop NX purchases for these — they cost mesos, flat.
 *  The brief for this feature asserted that Reboot cube cost scales with item level.
 *  That was the PRE-revamp Red/Black cube rule and it is no longer true: both the repo's
 *  own guide node and every current community source give a flat price. Shipping a
 *  level-scaled total would overstate cost by roughly an order of magnitude on a Lv 200
 *  item, so cubeCost() keeps the itemLevel argument as a documented hook and applies a
 *  scale factor that is 1 today. See CUBE_COST_LEVEL_SCALING. */
export const CUBE_COST_MESOS: Sourced<Record<CubeType, number>> = {
  value: { mystical: 0, hard: 0, solid: 0, glowing: 12_000_000, bright: 22_000_000 },
  source: `${GUIDE_GRAPH} node potential.cubes; corroborated by maplestorywiki.net Bright Cube / Glowing Cube (12,000,000 / 22,000,000 meso in Reboot World)`,
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
  note: "Mystical/Hard/Solid are farmed, not bought. Zero meso cost, but they are rate-limited by boss and Monster Park runs — see FARMED_CUBE_TIME_COST.",
};

/** Level scaling hook, deliberately inert. If Nexon ever reinstates level-scaled cube
 *  pricing, this is the single place that changes and every meso figure follows. */
export const CUBE_COST_LEVEL_SCALING: Sourced<(itemLevel: number) => number> = {
  value: () => 1,
  source: "No level scaling exists post-revamp; see CUBE_COST_MESOS note",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/** Farmed cubes are free in mesos and therefore always win a meso-per-damage sort,
 *  which is a lie of omission — they are capped by weekly boss runs. Callers that rank
 *  farmed cubes should price them at this opportunity cost or exclude them. Unsourced:
 *  nobody publishes a cubes-per-week figure and it varies with the account's boss mules. */
export const FARMED_CUBE_TIME_COST: Sourced<number> = {
  value: 0,
  source: "",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED. Meso-equivalent value of one farmed cube. 0 means farmed cubes are priced free and will sort first; set a real opportunity cost before trusting that ordering.",
};

/** Probability that one cube advances the item exactly one tier, keyed by the tier the
 *  item is at when the cube is used. KMS Black Cube disclosure, verbatim:
 *    Rare -> Epic        15.0000001275%
 *    Epic -> Unique       3.5%
 *    Unique -> Legendary  1.4%
 *  Red Cube on the same site gives Unique -> Legendary 0.3%, which is the anchor for
 *  the weaker cubes. Everything below is that table mapped onto GMS cube names by
 *  lineage (Bright replaced Black, Glowing replaced Red) — a mapping no first party has
 *  confirmed, hence placeholder: true on every one of them. */
export const TIER_UP: Record<CubeType, Sourced<Partial<Record<Tier, number>>>> = {
  mystical: {
    value: { rare: 0.15 },
    source: `Shape from ${KMS_BLACK}; GMS Mystical Cube rate never disclosed`,
    verifiedOn: CHECKED,
    patch: GMS_PATCH,
    placeholder: true,
    note: "UNVERIFIED. Caps at Epic, so only the rare->epic entry exists.",
  },
  hard: {
    value: { rare: 0.15, epic: 0.035 },
    source: `KMS Black Cube values from ${KMS_BLACK}, mapped to the GMS farmed cube by lineage`,
    verifiedOn: CHECKED,
    patch: GMS_PATCH,
    placeholder: true,
    note: "UNVERIFIED.",
  },
  solid: {
    value: { rare: 0.15, epic: 0.035, unique: 0.003 },
    source: `Rare/Epic from ${KMS_BLACK}; Unique->Legendary 0.3% from ${KMS_RED}`,
    verifiedOn: CHECKED,
    patch: GMS_PATCH,
    placeholder: true,
    note: "UNVERIFIED. Solid is the free workhorse and is assumed to sit at Red Cube's legendary rate.",
  },
  glowing: {
    value: { rare: 0.15, epic: 0.035, unique: 0.003 },
    source: `${KMS_RED} (Glowing replaced Red Cube in GMS)`,
    verifiedOn: CHECKED,
    patch: GMS_PATCH,
    placeholder: true,
    note: "UNVERIFIED. Community testing quotes 0.4-0.9% unique->legendary for Glowing; the KMS Red disclosure says 0.3%. The disagreement is exactly why this is a placeholder.",
  },
  bright: {
    value: { rare: 0.15, epic: 0.035, unique: 0.014 },
    source: `${KMS_BLACK} (Bright replaced Black Cube in GMS)`,
    verifiedOn: CHECKED,
    patch: GMS_PATCH,
    placeholder: true,
    note: "UNVERIFIED for GMS, but these three numbers are the real KMS disclosure, not a guess.",
  },
};

/** Glowing and Bright can jump two tiers on one cube. This is the probability that a
 *  rank-up, GIVEN it happened, was a double. Modelled as a branch inside the per-cube
 *  transition, never as a multiplier on p — a multiplier gets the Epic->Legendary case
 *  wrong in both directions depending on how far the item still has to go. */
export const DOUBLE_RANK_UP_GIVEN_UP: Record<"glowing" | "bright", Sourced<number>> = {
  glowing: {
    value: 0,
    source: "",
    verifiedOn: CHECKED,
    patch: GMS_PATCH,
    placeholder: true,
    note: "UNVERIFIED. GMS states Glowing 'can increase up to 2 ranks according to set probability rates' and has never published the rate. 0 is the deliberately conservative default: it makes Glowing look no better than a Red Cube rather than inventing an advantage.",
  },
  bright: {
    value: 0,
    source: "",
    verifiedOn: CHECKED,
    patch: GMS_PATCH,
    placeholder: true,
    note: "UNVERIFIED. Same as Glowing. Set both before quoting anyone a cube count.",
  },
};

/** Prime = the 2nd or 3rd line rolled at the item's own tier instead of one below.
 *  KMS disclosure, and it is flat across all four tiers: 2nd line 20%, 3rd line 5%
 *  for Black Cube; Red Cube is 10% / 1%. */
export const PRIME_LINE: Record<CubeType, Sourced<{ line2: number; line3: number }>> = {
  mystical: { value: { line2: 0.1, line3: 0.01 }, source: KMS_RED, verifiedOn: CHECKED, patch: GMS_PATCH, placeholder: true, note: "UNVERIFIED for GMS." },
  hard: { value: { line2: 0.1, line3: 0.01 }, source: KMS_RED, verifiedOn: CHECKED, patch: GMS_PATCH, placeholder: true, note: "UNVERIFIED for GMS." },
  solid: { value: { line2: 0.1, line3: 0.01 }, source: KMS_RED, verifiedOn: CHECKED, patch: GMS_PATCH, placeholder: true, note: "UNVERIFIED for GMS." },
  glowing: { value: { line2: 0.1, line3: 0.01 }, source: `${KMS_RED} — 2nd line 10.0000%, 3rd line 1.0000%`, verifiedOn: CHECKED, patch: GMS_PATCH, placeholder: true, note: "UNVERIFIED for GMS." },
  bright: { value: { line2: 0.2, line3: 0.05 }, source: `${KMS_BLACK} — 2nd line 20.0000%, 3rd line 5.0000%, flat across all tiers`, verifiedOn: CHECKED, patch: GMS_PATCH, placeholder: true, note: "UNVERIFIED for GMS; the underlying KMS numbers are first-party." },
};

/** KMS grants a guaranteed tier-up after a run of failures (10 / 42 / 107 for Black).
 *  MSEA has one too. No GMS patch note has ever mentioned one, so it is OFF by default —
 *  turning it on without evidence would understate cube counts on the unique->legendary
 *  step, which is the single most expensive step in the game. */
export const GUARANTEED_TIER_UP_AFTER: Sourced<Partial<Record<Tier, number>> | null> = {
  value: null,
  source: `${KMS_BLACK} discloses 10 / 42 / 107 failures for rare / epic / unique; no GMS equivalent is documented`,
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED for GMS. Pass { rare: 10, epic: 42, unique: 107 } to a plan to see the KMS-pity answer.",
};

/** What Bright's headline feature actually does. The repo's guide node says 'choose a
 *  line'; maplestorywiki describes the inherited Black Cube behaviour, 'choose before or
 *  after' (keep the old potential or the new one). These imply very different maths:
 *  locking a line multiplies your odds, keeping-the-better one does not change the odds of
 *  ever hitting a target at all (it only protects you from ending worse). Both are
 *  implemented; the default follows the repo's own guide data. */
export const BRIGHT_MECHANIC: Sourced<"lock-line" | "keep-better"> = {
  value: "lock-line",
  source: `${GUIDE_GRAPH} node potential.cubes ("Double rank-up AND choose a line"); conflicts with maplestorywiki.net Bright Cube ("option to choose before or after")`,
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED and CONTESTED. If it is really keep-better, pHitBright() overstates Bright by the factor a locked line buys.",
};

/* ---------- line pools ---------- */

export type LineKind =
  | "mainPct" | "allStatPct" | "mainFlat"
  | "attPct" | "attFlat"
  | "boss" | "ied" | "dmgPct"
  | "critDmg" | "critRate"
  | "junk";

export interface PoolLine {
  readonly text: string;
  readonly kind: LineKind;
  /** Percent for the %-kinds, flat points for mainFlat/attFlat, 0 for junk. */
  readonly value: number;
  readonly weight: number;
}

/** Item level bands. Line VALUES change at these boundaries; the pool composition is
 *  assumed not to. Bands come from the repo's own potential.tiers table. */
export const LEVEL_BANDS: Sourced<ReadonlyArray<{ min: number; max: number; id: string }>> = {
  value: [
    { min: 1, max: 30, id: "1-30" },
    { min: 31, max: 70, id: "31-70" },
    { min: 71, max: 150, id: "71-150" },
    { min: 151, max: 300, id: "151+" },
  ],
  source: `${GUIDE_GRAPH} node potential.tiers`,
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

export const bandOf = (itemLevel: number): string => {
  const bands = LEVEL_BANDS.value;
  for (const b of bands) if (itemLevel >= b.min && itemLevel <= b.max) return b.id;
  return bands[bands.length - 1].id;
};

/** One main-stat line, by band and tier. This is the one line-value table the repo can
 *  actually source — it is the guide's own potential.tiers node. */
export const MAIN_STAT_LINE_PCT: Sourced<Record<string, Partial<Record<Tier, number>>>> = {
  value: {
    "1-30": { rare: 1, epic: 2, unique: 3, legendary: 6 },
    "31-70": { rare: 2, epic: 4, unique: 6, legendary: 9 },
    "71-150": { rare: 3, epic: 6, unique: 9, legendary: 12 },
    "151+": { rare: 4, epic: 7, unique: 10, legendary: 13 },
  },
  source: `${GUIDE_GRAPH} node potential.tiers (DigitalTQ Potential guide)`,
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/** Every other line value. None of these has a first-party table. They are the values
 *  the community quotes and they are structurally right (boss comes in 30/35/40 at
 *  legendary, IED in 35/40) but they are NOT sourced, so they are flagged. */
export const OTHER_LINE_VALUES: Sourced<Record<string, Partial<Record<Tier, number[]>>>> = {
  value: {
    boss: { unique: [20, 30], legendary: [30, 35, 40] },
    ied: { epic: [15], unique: [30, 35], legendary: [35, 40] },
    attPct: { rare: [1], epic: [3], unique: [6], legendary: [9, 12] },
    critDmg: { unique: [5], legendary: [8] },
    dmgPct: { rare: [1], epic: [3], unique: [6], legendary: [9] },
  },
  source: "",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED. Community-quoted line values; each array is the set of distinct values that appear in the pool at that tier. All Stat % lives in ALL_STAT_LINE_PCT because it is a single value per tier.",
};

/** All-stat lines, pulled out of OTHER_LINE_VALUES so the typing stays honest. */
export const ALL_STAT_LINE_PCT: Sourced<Partial<Record<Tier, number>>> = {
  value: { rare: 1, epic: 3, unique: 6, legendary: 9 },
  source: "",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED. Community-quoted.",
};

/** Documented total every pool's weights must sum to. selfCheck() asserts it. */
export const POOL_WEIGHT_TOTAL = 1000;

type CubeablePotKind = Exclude<PotKind, "no">;
type CubeableTier = Exclude<Tier, "none">;

interface PoolSpecEntry {
  kind: LineKind;
  /** Null means "read the value from the tier tables". */
  value: number | null;
  weight: number;
  label?: string;
}

/** THE BIG UNSOURCED BLOCK. Nexon publishes tier-up and prime-line odds but has never
 *  published the per-line pool. These weights are a structurally plausible pool — the
 *  right lines are present in roughly the right proportions — and they are wrong in
 *  detail, which is why every pool below ships placeholder: true and why the UI must
 *  degrade to ranking-only. Replace with a real table and nothing else in this file
 *  changes. Weights are per mille and must sum to POOL_WEIGHT_TOTAL. */
const POOL_SPEC: Record<CubeablePotKind, Record<CubeableTier, PoolSpecEntry[]>> = {
  stat: {
    rare: [
      { kind: "mainPct", value: null, weight: 120 },
      { kind: "mainFlat", value: 20, weight: 120 },
      { kind: "junk", value: 0, weight: 500, label: "off-stat / DEF / MP / speed" },
      { kind: "allStatPct", value: null, weight: 60 },
      { kind: "junk", value: 0, weight: 200, label: "Max HP / MP %" },
    ],
    epic: [
      { kind: "mainPct", value: null, weight: 180 },
      { kind: "allStatPct", value: null, weight: 70 },
      { kind: "mainFlat", value: 40, weight: 100 },
      { kind: "junk", value: 0, weight: 450, label: "off-stat %" },
      { kind: "junk", value: 0, weight: 200, label: "Max HP % / DEF %" },
    ],
    unique: [
      { kind: "mainPct", value: null, weight: 200 },
      { kind: "allStatPct", value: null, weight: 80 },
      { kind: "dmgPct", value: null, weight: 40 },
      { kind: "mainFlat", value: 60, weight: 80 },
      { kind: "junk", value: 0, weight: 420, label: "off-stat %" },
      { kind: "junk", value: 0, weight: 180, label: "Max HP % / DEF % / drop / meso" },
    ],
    legendary: [
      { kind: "mainPct", value: null, weight: 210 },
      { kind: "allStatPct", value: null, weight: 90 },
      { kind: "dmgPct", value: null, weight: 50 },
      { kind: "mainFlat", value: 80, weight: 70 },
      { kind: "junk", value: 0, weight: 400, label: "off-stat %" },
      { kind: "junk", value: 0, weight: 180, label: "Max HP % / drop / meso / decent skill" },
    ],
  },
  atk: {
    rare: [
      { kind: "attPct", value: null, weight: 120 },
      { kind: "mainPct", value: null, weight: 100 },
      { kind: "attFlat", value: 4, weight: 120 },
      { kind: "junk", value: 0, weight: 660, label: "off-stat / DEF / MP" },
    ],
    epic: [
      { kind: "attPct", value: null, weight: 160 },
      { kind: "mainPct", value: null, weight: 140 },
      { kind: "ied", value: 15, weight: 90 },
      { kind: "attFlat", value: 8, weight: 110 },
      { kind: "junk", value: 0, weight: 500, label: "off-stat %" },
    ],
    unique: [
      { kind: "attPct", value: null, weight: 150 },
      { kind: "boss", value: 20, weight: 90 },
      { kind: "boss", value: 30, weight: 60 },
      { kind: "ied", value: 30, weight: 90 },
      { kind: "ied", value: 35, weight: 50 },
      { kind: "mainPct", value: null, weight: 120 },
      { kind: "dmgPct", value: null, weight: 40 },
      { kind: "junk", value: 0, weight: 400, label: "off-stat % / flat / skill" },
    ],
    legendary: [
      { kind: "attPct", value: 12, weight: 130 },
      { kind: "boss", value: 30, weight: 90 },
      { kind: "boss", value: 35, weight: 60 },
      { kind: "boss", value: 40, weight: 40 },
      { kind: "ied", value: 35, weight: 80 },
      { kind: "ied", value: 40, weight: 50 },
      { kind: "mainPct", value: null, weight: 110 },
      { kind: "dmgPct", value: null, weight: 50 },
      { kind: "junk", value: 0, weight: 390, label: "off-stat % / cooldown / skill" },
    ],
  },
  crit: {
    rare: [
      { kind: "mainPct", value: null, weight: 120 },
      { kind: "critRate", value: 1, weight: 100 },
      { kind: "mainFlat", value: 20, weight: 120 },
      { kind: "junk", value: 0, weight: 660, label: "off-stat / DEF / MP" },
    ],
    epic: [
      { kind: "mainPct", value: null, weight: 170 },
      { kind: "critRate", value: 3, weight: 110 },
      { kind: "mainFlat", value: 40, weight: 100 },
      { kind: "junk", value: 0, weight: 620, label: "off-stat %" },
    ],
    unique: [
      { kind: "mainPct", value: null, weight: 180 },
      { kind: "critDmg", value: 5, weight: 90 },
      { kind: "critRate", value: 9, weight: 100 },
      { kind: "allStatPct", value: null, weight: 70 },
      { kind: "junk", value: 0, weight: 560, label: "off-stat % / flat" },
    ],
    legendary: [
      { kind: "mainPct", value: null, weight: 190 },
      { kind: "critDmg", value: 8, weight: 100 },
      { kind: "critRate", value: 12, weight: 90 },
      { kind: "allStatPct", value: null, weight: 80 },
      { kind: "dmgPct", value: null, weight: 40 },
      { kind: "junk", value: 0, weight: 500, label: "off-stat % / drop / meso" },
    ],
  },
};

export const LINE_POOLS: Sourced<Record<CubeablePotKind, Record<CubeableTier, PoolSpecEntry[]>>> = {
  value: POOL_SPEC,
  source: "",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED. Per-line pool weights have never been published for any region. Structure is right, weights are invented and flagged.",
};

/** Boss defence, for the IED term. rules.ts:377 already tells the player Arcane bosses
 *  sit at 300% and Grandis at 380%, so the damage model reuses the repo's own numbers
 *  rather than introducing a second, different set. */
export const BOSS_DEFENSE_PCT: Sourced<Record<string, number>> = {
  value: { arcane: 300, grandis: 380 },
  source: "lib/rules.ts charAdvice (\"Arcane bosses sit at 300% defense, Grandis at 380%\")",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/** Arcane symbols give FLAT main stat that is never multiplied by your %stat. At Arcane
 *  Power 1060 that is thousands of points of undilutable stat, which is precisely why a
 *  %stat line is worth less than its face value — charAdvice already says so at
 *  rules.ts:388. A cube model that skipped this would mis-rank every armour slot. */
export const SYMBOL_STAT_PER_LEVEL: Sourced<number> = {
  value: 100,
  source: "lib/rules.ts charAdvice (+100 main stat per Arcane symbol level)",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
  note: "Xenon and Demon Avenger scale differently; this is the ordinary-class number.",
};

export const ARCANE_POWER_PER_LEVEL: Sourced<{ perLevel: number; base: number }> = {
  value: { perLevel: 10, base: 120 },
  source: "lib/rules.ts charAdvice (symbol level = (arcanePower - 120) / 10)",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

export const FLAME_RESET_COST: Sourced<number> = {
  value: 3_000_000,
  source: `lib/rules.ts advise + ${GUIDE_GRAPH} node flames.system (v.271: 3,000,000 mesos per reset, Black Rebirth Flame rates)`,
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/** Expected main-stat-equivalent gain from one 3M flame reset on a piece with dead lines.
 *  Requires the tier-by-tier flame stat table, which this agent could not source. */
export const FLAME_RESET_EXPECTED_GAIN: Sourced<{ mainFlat: number; attFlat: number }> = {
  value: { mainFlat: 0, attFlat: 0 },
  source: "",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED. Zeroed so a reflame never fakes a gain; it will sort last until a real flame table lands.",
};

/** Star force success odds, transcribed from the repo's own sourced guide node. Used to
 *  turn 'one more tap' into an expected number of taps. */
export const SF_SUCCESS: Sourced<Record<number, number>> = {
  value: {
    0: 0.95, 1: 0.9, 2: 0.85, 3: 0.85, 4: 0.8, 5: 0.75, 6: 0.7, 7: 0.65, 8: 0.6, 9: 0.55,
    10: 0.5, 11: 0.45, 12: 0.4, 13: 0.35, 14: 0.3, 15: 0.3, 16: 0.3, 17: 0.15, 18: 0.15,
    19: 0.15, 20: 0.3, 21: 0.15, 22: 0.15, 23: 0.1, 24: 0.1, 25: 0.1, 26: 0.07, 27: 0.05,
    28: 0.03, 29: 0.01,
  },
  source: `${GUIDE_GRAPH} node starforce.rates (DigitalTQ Star Force guide, Feb 2026)`,
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

export const SF_BOOM: Sourced<Record<number, number>> = {
  value: {
    15: 0.021, 16: 0.021, 17: 0.068, 18: 0.068, 19: 0.085, 20: 0.105, 21: 0.1275, 22: 0.17,
    23: 0.18, 24: 0.18, 25: 0.18, 26: 0.186, 27: 0.19, 28: 0.194, 29: 0.198,
  },
  source: `${GUIDE_GRAPH} node starforce.rates`,
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: false,
};

/** Meso cost of one star force attempt. The community formula has the shape
 *  100 * round(itemLevel^3 * (star+1)^2.7 / divisor) + 10 with a divisor that changes by
 *  star band, but this agent could not source the divisors for GMS v.271, and a wrong
 *  divisor is off by orders of magnitude. Zero means star force entries carry no meso
 *  figure and are ranking-only. */
export const SF_TAP_COST_DIVISORS: Sourced<Record<string, number> | null> = {
  value: null,
  source: "",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED. Needs the GMS meso cost divisors per star band (0-9 / 10-14 / 15-24 / 25+).",
};

/** Stat gained by one star, on an item of a given level. Star force gives flat main stat
 *  and flat ATT off a published table this agent could not retrieve. */
export const SF_STAT_PER_STAR: Sourced<{ mainFlat: number; attFlat: number } | null> = {
  value: null,
  source: "",
  verifiedOn: CHECKED,
  patch: GMS_PATCH,
  placeholder: true,
  note: "UNVERIFIED. Needs the star force stat table by item level band and star.",
};

/* ==========================================================================
 * SECTION 2 — MATH. Exact. No sampling.
 * ========================================================================== */

export interface Distribution {
  /** pmf[n] = P(exactly n cubes). Index 0 is unused and always 0. */
  readonly pmf: readonly number[];
  readonly cdf: readonly number[];
  readonly mean: number;
  readonly median: number;
  readonly p75: number;
  readonly p90: number;
  /** Support was truncated here; cdf[truncatedAt] >= CDF_TARGET unless capped. */
  readonly truncatedAt: number;
  /** True when the hard iteration cap bit before the CDF target — quantiles are lower bounds. */
  readonly capped: boolean;
}

const CDF_TARGET = 0.9999;
const HARD_CAP = 200_000;

/** Exact quantile of a single geometric variable: the n at which P(X <= n) first
 *  reaches q, i.e. ceil(ln(1-q)/ln(1-p)). Exported because line-hitting uses it
 *  directly — attempts at a fixed per-cube success probability are geometric. */
export function geometricQuantile(p: number, q: number): number {
  if (p <= 0) return Infinity;
  if (p >= 1) return 1;
  return Math.ceil(Math.log(1 - q) / Math.log(1 - p));
}

export function geometricDistribution(p: number): Distribution {
  if (!(p > 0)) {
    return { pmf: [0], cdf: [0], mean: Infinity, median: Infinity, p75: Infinity, p90: Infinity, truncatedAt: 0, capped: true };
  }
  const n = Math.min(HARD_CAP, Math.max(1, geometricQuantile(p, CDF_TARGET)));
  const pmf = new Array<number>(n + 1).fill(0);
  const cdf = new Array<number>(n + 1).fill(0);
  let q = 1;
  for (let i = 1; i <= n; i++) {
    pmf[i] = q * p;
    q *= 1 - p;
    cdf[i] = 1 - q;
  }
  return finish(pmf, cdf, n, 1 / p);
}

function quantileOf(cdf: readonly number[], q: number): number {
  for (let i = 1; i < cdf.length; i++) if (cdf[i] >= q) return i;
  return cdf.length - 1;
}

function finish(pmf: number[], cdf: number[], n: number, meanOverride?: number): Distribution {
  let mean = meanOverride;
  if (mean === undefined) {
    // Tail mass beyond truncation is < 1e-4 and is attributed to the last support point,
    // which biases the mean by at most 1e-4 * n — invisible next to the rate uncertainty.
    let m = 0;
    for (let i = 1; i <= n; i++) m += i * pmf[i];
    m += (1 - cdf[n]) * n;
    mean = m;
  }
  return {
    pmf, cdf, mean,
    median: quantileOf(cdf, 0.5),
    p75: quantileOf(cdf, 0.75),
    p90: quantileOf(cdf, 0.9),
    truncatedAt: n,
    capped: cdf[n] < CDF_TARGET,
  };
}

export interface TierUpOptions {
  /** Guaranteed success after this many consecutive failures at a tier. Default: none. */
  readonly pity?: Partial<Record<Tier, number>> | null;
  /** Override the double-rank-up branch (defaults to DOUBLE_RANK_UP_GIVEN_UP). */
  readonly doubleRankUp?: number;
}

/**
 * Cubes needed to go from one tier to another, exactly.
 *
 * With no double-rank-up branch this is a sum of independent geometrics and the result
 * is identical to convolving their PMFs. The double-rank-up branch breaks that
 * independence — a single cube can skip a tier — so the general form is a forward pass
 * over the Markov chain on tiers, which reduces to the convolution when the branch
 * probability is zero. Pity, when enabled, adds a failure-count dimension to the state.
 */
export function tierUpDistribution(
  cube: CubeType,
  from: Tier,
  to: Tier,
  opts: TierUpOptions = {},
): Distribution | null {
  const start = tierIndex(from);
  const target = tierIndex(to);
  if (target <= start) return null;
  if (tierIndex(CUBE_MAX_TIER.value[cube]) < target) return null;

  const rates = TIER_UP[cube].value;
  const dbl = opts.doubleRankUp ?? (cube === "glowing" || cube === "bright"
    ? DOUBLE_RANK_UP_GIVEN_UP[cube].value
    : 0);
  const pity = opts.pity === undefined ? GUARANTEED_TIER_UP_AFTER.value : opts.pity;

  // Every intermediate tier must have a rate, or the plan is unanswerable rather than slow.
  for (let i = start; i < target; i++) {
    const p = rates[TIER_ORDER[i]];
    if (!p || p <= 0) return null;
  }

  // state[i][f] = P(at tier index i with f consecutive failures, not yet absorbed).
  const maxFail = (t: Tier): number => {
    const n = pity ? pity[t] : undefined;
    return n && n > 0 ? n : 0;
  };
  const state: number[][] = [];
  for (let i = start; i < target; i++) state.push(new Array<number>(maxFail(TIER_ORDER[i]) + 1).fill(0));
  state[0][0] = 1;

  const pmf: number[] = [0];
  const cdf: number[] = [0];
  let absorbed = 0;
  let mean = 0;
  let n = 0;

  while (absorbed < CDF_TARGET && n < HARD_CAP) {
    n++;
    const step = massPass(state, start, target, rates, dbl, maxFail);
    for (let i = 0; i < state.length; i++) state[i] = step.next[i];
    absorbed += step.hit;
    pmf.push(step.hit);
    cdf.push(absorbed);
    mean += n * step.hit;
  }
  mean += (1 - absorbed) * n;
  return {
    pmf, cdf, mean,
    median: quantileOf(cdf, 0.5),
    p75: quantileOf(cdf, 0.75),
    p90: quantileOf(cdf, 0.9),
    truncatedAt: n,
    capped: absorbed < CDF_TARGET,
  };
}

/** One cube's worth of mass movement across the tier chain. */
function massPass(
  state: number[][],
  start: number,
  target: number,
  rates: Partial<Record<Tier, number>>,
  dbl: number,
  maxFail: (t: Tier) => number,
): { next: number[][]; hit: number } {
  const next: number[][] = state.map((row) => new Array<number>(row.length).fill(0));
  let hit = 0;
  for (let i = 0; i < state.length; i++) {
    const tier = TIER_ORDER[start + i];
    const base = rates[tier] as number;
    const cap = maxFail(tier);
    for (let f = 0; f < state[i].length; f++) {
      const mass = state[i][f];
      if (mass === 0) continue;
      const pUp = cap > 0 && f >= cap ? 1 : base;
      const canDouble = dbl > 0 && start + i + 2 <= tierIndex("legendary");
      const pDouble = canDouble ? pUp * dbl : 0;
      const pSingle = pUp - pDouble;
      for (const [steps, p] of [[1, pSingle], [2, pDouble]] as const) {
        if (p <= 0) continue;
        const dest = start + i + steps;
        if (dest >= target) hit += mass * p;
        else next[dest - start][0] += mass * p;
      }
      const fail = mass * (1 - pUp);
      if (fail > 0) next[i][Math.min(f + 1, state[i].length - 1)] += fail;
    }
  }
  return { next, hit };
}

/* ---------- line hitting, by exact enumeration ---------- */

export interface ResolvedPool {
  readonly lines: readonly PoolLine[];
  readonly total: number;
}

function lineValue(kind: LineKind, tier: CubeableTier, band: string, explicit: number | null): number {
  if (explicit !== null) return explicit;
  switch (kind) {
    case "mainPct": {
      const v = MAIN_STAT_LINE_PCT.value[band]?.[tier];
      return v ?? 0;
    }
    case "allStatPct":
      return ALL_STAT_LINE_PCT.value[tier] ?? 0;
    case "attPct": {
      const arr = OTHER_LINE_VALUES.value.attPct?.[tier];
      return arr ? arr[arr.length - 1] : 0;
    }
    case "dmgPct": {
      const arr = OTHER_LINE_VALUES.value.dmgPct?.[tier];
      return arr ? arr[arr.length - 1] : 0;
    }
    default:
      return 0;
  }
}

const poolCache = new Map<string, ResolvedPool>();

/** The line pool for one (slot potential kind, item level band, tier), with values
 *  filled in from the tier tables. Memoised — the planner calls this 25 times a render. */
export function poolFor(potKind: CubeablePotKind, band: string, tier: CubeableTier): ResolvedPool {
  const key = `${potKind}|${band}|${tier}`;
  const hit = poolCache.get(key);
  if (hit) return hit;
  const spec = POOL_SPEC[potKind][tier];
  const lines: PoolLine[] = spec.map((e) => {
    const value = lineValue(e.kind, tier, band, e.value);
    const text = e.label ?? describeLine(e.kind, value);
    return { text, kind: e.kind, value, weight: e.weight };
  });
  const total = lines.reduce((a, l) => a + l.weight, 0);
  const resolved: ResolvedPool = { lines, total };
  poolCache.set(key, resolved);
  return resolved;
}

function describeLine(kind: LineKind, value: number): string {
  switch (kind) {
    case "mainPct": return `main stat +${value}%`;
    case "allStatPct": return `All Stats +${value}%`;
    case "mainFlat": return `main stat +${value}`;
    case "attPct": return `ATT +${value}%`;
    case "attFlat": return `ATT +${value}`;
    case "boss": return `Boss Damage +${value}%`;
    case "ied": return `Ignore DEF +${value}%`;
    case "dmgPct": return `Damage +${value}%`;
    case "critDmg": return `Critical Damage +${value}%`;
    case "critRate": return `Critical Rate +${value}%`;
    default: return "no useful line";
  }
}

export type LinePredicate = (lines: readonly PoolLine[]) => boolean;

export interface HitAnalysis {
  /** Probability that one cube's three lines satisfy the predicate. */
  readonly p: number;
  /** Weighted-average stat mutation over the outcomes that DO satisfy it. This is what
   *  the damage delta is computed from, so the reported gain is the expected gain
   *  conditional on hitting — not the gain of some hand-picked ideal roll. */
  readonly expected: StatMutation;
  readonly enumerated: number;
}

/** Sum of the three line tiers' composition: line 1 is always at the item's tier; lines
 *  2 and 3 are prime (item tier) with the cube's disclosed probability, else one tier
 *  below. Enumerating this is a few thousand combinations — exact, and microseconds. */
export function analyseHit(
  cube: CubeType,
  potKind: CubeablePotKind,
  itemLevel: number,
  tier: CubeableTier,
  predicate: LinePredicate,
  lockedLine?: PoolLine,
): HitAnalysis {
  const band = bandOf(itemLevel);
  const below = TIER_ORDER[Math.max(1, tierIndex(tier) - 1)] as CubeableTier;
  const prime = PRIME_LINE[cube].value;

  const poolAt = poolFor(potKind, band, tier);
  const poolBelow = poolFor(potKind, band, below);

  const l1Options: ReadonlyArray<{ line: PoolLine; w: number }> = lockedLine
    ? [{ line: lockedLine, w: 1 }]
    : poolAt.lines.map((l) => ({ line: l, w: l.weight / poolAt.total }));

  const branch = (pPrime: number): ReadonlyArray<{ line: PoolLine; w: number }> => {
    const out: Array<{ line: PoolLine; w: number }> = [];
    for (const l of poolAt.lines) out.push({ line: l, w: pPrime * (l.weight / poolAt.total) });
    for (const l of poolBelow.lines) out.push({ line: l, w: (1 - pPrime) * (l.weight / poolBelow.total) });
    return out;
  };
  const l2Options = branch(prime.line2);
  const l3Options = branch(prime.line3);

  let p = 0;
  let count = 0;
  const acc: MutableMutation = blankMutation();
  const triple: PoolLine[] = [l1Options[0].line, l2Options[0].line, l3Options[0].line];

  for (const a of l1Options) {
    triple[0] = a.line;
    for (const b of l2Options) {
      triple[1] = b.line;
      for (const c of l3Options) {
        triple[2] = c.line;
        count++;
        if (!predicate(triple)) continue;
        const w = a.w * b.w * c.w;
        p += w;
        addLines(acc, triple, w);
      }
    }
  }
  if (p > 0) scaleMutation(acc, 1 / p);
  return { p, expected: acc, enumerated: count };
}

/**
 * Bright's own probability, not a fudge factor on the others.
 *
 * Under BRIGHT_MECHANIC "lock-line" the chosen line is fixed at the item's tier and only
 * the other two roll, so the answer is P(the remaining two satisfy the residual
 * predicate) maximised over which line is worth locking. That changes the SHAPE of the
 * answer — it helps a one-line target enormously and a three-line target barely — which
 * is exactly what a multiplier cannot express.
 *
 * Under "keep-better" the cube confers no per-roll advantage on hitting a target at all
 * (it only protects you from ending worse than you started), so the probability is the
 * ordinary one.
 */
export function pHitBright(
  potKind: CubeablePotKind,
  itemLevel: number,
  tier: CubeableTier,
  predicate: LinePredicate,
): HitAnalysis {
  if (BRIGHT_MECHANIC.value === "keep-better") {
    return analyseHit("bright", potKind, itemLevel, tier, predicate);
  }
  const pool = poolFor(potKind, bandOf(itemLevel), tier);
  let best: HitAnalysis | null = null;
  for (const locked of pool.lines) {
    if (locked.kind === "junk") continue;
    const a = analyseHit("bright", potKind, itemLevel, tier, predicate, locked);
    if (!best || a.p > best.p) best = a;
  }
  return best ?? analyseHit("bright", potKind, itemLevel, tier, predicate);
}

/* ---------- targets ---------- */

export interface PotentialTarget {
  readonly id: string;
  readonly label: string;
  /** Which slots this target is offered for. */
  readonly potKind: CubeablePotKind;
  /** The tier the item must be at before the target is reachable. */
  readonly minTier: CubeableTier;
  readonly predicate: LinePredicate;
}

const sumOf = (lines: readonly PoolLine[], kinds: LineKind[]): number =>
  lines.reduce((a, l) => a + (kinds.includes(l.kind) ? l.value : 0), 0);
const countOf = (lines: readonly PoolLine[], kinds: LineKind[]): number =>
  lines.reduce((a, l) => a + (kinds.includes(l.kind) ? 1 : 0), 0);

/** The presets are the milestones the repo's own guide already tells the player to aim
 *  for (guide-graph potential.targets): Legendary, then 18-21% main stat, then 30%+;
 *  and on weapon/secondary/emblem, two of boss / IED / ATT. */
export const TARGETS: readonly PotentialTarget[] = [
  {
    id: "stat21",
    label: "21%+ main stat",
    potKind: "stat",
    minTier: "unique",
    predicate: (l) => sumOf(l, ["mainPct", "allStatPct"]) >= 21,
  },
  {
    id: "stat30",
    label: "30%+ main stat",
    potKind: "stat",
    minTier: "legendary",
    predicate: (l) => sumOf(l, ["mainPct", "allStatPct"]) >= 30,
  },
  {
    id: "atk2line",
    label: "2 lines of boss / IED / ATT",
    potKind: "atk",
    minTier: "unique",
    predicate: (l) => countOf(l, ["boss", "ied", "attPct"]) >= 2,
  },
  {
    id: "atk3line",
    label: "3 lines of boss / IED / ATT",
    potKind: "atk",
    minTier: "legendary",
    predicate: (l) => countOf(l, ["boss", "ied", "attPct"]) >= 3,
  },
  {
    id: "crit1",
    label: "1 line of Critical Damage",
    potKind: "crit",
    minTier: "unique",
    predicate: (l) => countOf(l, ["critDmg"]) >= 1,
  },
  {
    id: "crit2",
    label: "2 lines of Critical Damage",
    potKind: "crit",
    minTier: "legendary",
    predicate: (l) => countOf(l, ["critDmg"]) >= 2,
  },
];

export const targetsFor = (potKind: PotKind): readonly PotentialTarget[] =>
  potKind === "no" ? [] : TARGETS.filter((t) => t.potKind === potKind);

/* ==========================================================================
 * SECTION 3 — DAMAGE. The repo had none; this is the whole basis of "how much
 * is this worth", so it is deliberately explicit about what it does and does
 * not know.
 * ========================================================================== */

export interface StatMutation {
  mainPct?: number;
  mainFlat?: number;
  attPct?: number;
  attFlat?: number;
  boss?: number;
  /** Percentage points of a NEW ied line, stacked multiplicatively, not added. */
  ied?: number;
  critRate?: number;
  critDmg?: number;
  dmgPct?: number;
}
type MutableMutation = Required<StatMutation>;

const blankMutation = (): MutableMutation => ({
  mainPct: 0, mainFlat: 0, attPct: 0, attFlat: 0, boss: 0, ied: 0, critRate: 0, critDmg: 0, dmgPct: 0,
});

function addLines(acc: MutableMutation, lines: readonly PoolLine[], w: number): void {
  for (const l of lines) {
    switch (l.kind) {
      case "mainPct": case "allStatPct": acc.mainPct += l.value * w; break;
      case "mainFlat": acc.mainFlat += l.value * w; break;
      case "attPct": acc.attPct += l.value * w; break;
      case "attFlat": acc.attFlat += l.value * w; break;
      case "boss": acc.boss += l.value * w; break;
      case "ied": acc.ied += l.value * w; break;
      case "critDmg": acc.critDmg += l.value * w; break;
      case "critRate": acc.critRate += l.value * w; break;
      case "dmgPct": acc.dmgPct += l.value * w; break;
      default: break;
    }
  }
}

const scaleMutation = (m: MutableMutation, k: number): void => {
  m.mainPct *= k; m.mainFlat *= k; m.attPct *= k; m.attFlat *= k; m.boss *= k;
  m.ied *= k; m.critRate *= k; m.critDmg *= k; m.dmgPct *= k;
};

export interface DamageInputs {
  /** Displayed total main stat, i.e. after every % multiplier AND after flat symbols. */
  readonly mainTotal: number;
  /** Flat, unmultiplied stat from Arcane/Sacred symbols. Diluting factor for %stat lines. */
  readonly symbolFlat: number;
  /** Sum of %main-stat currently applied, so a marginal line is valued at the true margin. */
  readonly statPctApplied: number;
  readonly att: number;
  readonly attPctApplied: number;
  readonly boss: number;
  readonly ied: number;
  readonly critRate: number;
  readonly critDmg: number;
  readonly dmgPct: number;
  readonly bossDefensePct: number;
}

/** Arcane Power -> flat main stat, inverted with the repo's own constants so the number
 *  here and the number charAdvice shows the player cannot drift apart. */
export function symbolFlatStat(arcanePower: number): number {
  const { perLevel, base } = ARCANE_POWER_PER_LEVEL.value;
  const levels = Math.max(0, Math.round((arcanePower - base) / perLevel));
  return levels * SYMBOL_STAT_PER_LEVEL.value;
}

/** IED does not add, it stacks: each line removes a share of the defence that is left. */
export const stackIed = (currentPct: number, addedPct: number): number =>
  100 - (100 - currentPct) * (1 - addedPct / 100);

/**
 * Relative damage index. Only ratios of this number mean anything — it has no units and
 * is never shown to the player.
 *
 *   (main stat x ATT) x (1 + boss) x (1 + critRate x critDmg) x (1 - residual defence) x (1 + damage%)
 *
 * Two properties the rest of this file depends on, both of which charAdvice already
 * knows and tells the player:
 *   - crit rate above 100 is dead weight (rules.ts:368), so it is clamped;
 *   - symbol stat is flat and unmultiplied (rules.ts:388), so it is held out of the
 *     %stat term. At Arcane Power 1060 that is roughly half this character's main stat
 *     sitting outside the multiplier, which is why a 13% DEX line is worth far less
 *     here than a naive model would claim.
 */
export function dmgIndex(d: DamageInputs): number {
  const multiplied = Math.max(0, d.mainTotal - d.symbolFlat);
  const statTerm = multiplied + d.symbolFlat;
  const critTerm = 1 + (Math.min(100, d.critRate) / 100) * (d.critDmg / 100);
  const residualDef = Math.max(0, (d.bossDefensePct / 100) * (1 - d.ied / 100));
  const iedTerm = Math.max(0, 1 - residualDef);
  return statTerm * d.att * (1 + d.boss / 100) * critTerm * iedTerm * (1 + d.dmgPct / 100);
}

/** Apply a mutation at the true margin: a +13% stat line on a character who already has
 *  120% adds 13/220ths of the pre-% stat, not 13%. */
export function applyMutation(d: DamageInputs, m: StatMutation): DamageInputs {
  const preStat = (d.mainTotal - d.symbolFlat) / (1 + d.statPctApplied / 100);
  const preAtt = d.att / (1 + d.attPctApplied / 100);
  const statPctAfter = d.statPctApplied + (m.mainPct ?? 0);
  const attPctAfter = d.attPctApplied + (m.attPct ?? 0);
  return {
    ...d,
    mainTotal: preStat * (1 + statPctAfter / 100) + (m.mainFlat ?? 0) + d.symbolFlat,
    statPctApplied: statPctAfter,
    att: preAtt * (1 + attPctAfter / 100) + (m.attFlat ?? 0),
    attPctApplied: attPctAfter,
    boss: d.boss + (m.boss ?? 0),
    ied: (m.ied ?? 0) > 0 ? stackIed(d.ied, m.ied ?? 0) : d.ied,
    critRate: d.critRate + (m.critRate ?? 0),
    critDmg: d.critDmg + (m.critDmg ?? 0),
    dmgPct: d.dmgPct + (m.dmgPct ?? 0),
  };
}

/** Percent change in the damage index. This is the number every ranking divides by. */
export function dmgDelta(d: DamageInputs, m: StatMutation): number {
  const before = dmgIndex(d);
  if (!(before > 0)) return 0;
  return (dmgIndex(applyMutation(d, m)) / before - 1) * 100;
}

export interface DeriveOptions {
  /** Boss to evaluate against. Defaults to the Arcane 300% figure rules.ts already cites. */
  readonly boss?: keyof typeof BOSS_DEFENSE_PCT.value;
  /** %main stat from sources the planner cannot see — hyper stats, links, legion, buffs.
   *  Left at 0 by default, which slightly OVERstates the value of a new %stat line. */
  readonly hiddenStatPct?: number;
  readonly hiddenAttPct?: number;
}

/** Everything dmgIndex needs, read off the character the planner already has. Nothing new
 *  has to be collected from the player: Planner.tsx already holds lvl, pot and p[] on
 *  every Item, plus the whole Stats block. */
export function deriveDamageInputs(ch: Character, o: DeriveOptions = {}): DamageInputs {
  let statPctApplied = o.hiddenStatPct ?? 0;
  let attPctApplied = o.hiddenAttPct ?? 0;
  for (const it of Object.values(ch.items)) {
    for (const line of [...(it.p ?? []), ...(it.f ?? [])]) {
      if (!line) continue;
      statPctApplied += statPct(line, ch.main);
      const am = /att(?:ack)?\s*(?:power)?\s*:?\s*\+?(\d+(?:\.\d+)?)\s*%/i.exec(line);
      if (am) attPctApplied += parseFloat(am[1]);
    }
  }
  return {
    mainTotal: ch.stats.main,
    symbolFlat: symbolFlatStat(ch.stats.arcane),
    statPctApplied,
    att: ch.stats.att,
    attPctApplied,
    boss: ch.stats.boss,
    ied: ch.stats.ied,
    critRate: ch.stats.crit,
    critDmg: ch.stats.critdmg,
    dmgPct: 0,
    bossDefensePct: BOSS_DEFENSE_PCT.value[o.boss ?? "arcane"],
  };
}

/** What the item's CURRENT potential lines are already contributing, so a plan reports
 *  the gain over what the player has rather than the value of the new roll in a vacuum. */
export function currentPotentialMutation(it: Item, main: MainStat): StatMutation {
  const acc = blankMutation();
  for (const line of it.p ?? []) {
    if (!line) continue;
    const pct = statPct(line, main);
    if (pct) { acc.mainPct += pct; continue; }
    if (isDeadLine(line, main)) continue;
    const num = /(\d+(?:\.\d+)?)/.exec(line);
    const v = num ? parseFloat(num[1]) : 0;
    if (/boss/i.test(line)) acc.boss += v;
    else if (/ignore|ied/i.test(line)) acc.ied = acc.ied > 0 ? stackIed(acc.ied, v) : v;
    else if (/crit.*dam/i.test(line)) acc.critDmg += v;
    else if (/crit/i.test(line)) acc.critRate += v;
    else if (/%/.test(line) && /att|attack/i.test(line)) acc.attPct += v;
    else if (/att|attack/i.test(line)) acc.attFlat += v;
    else if (/damage/i.test(line)) acc.dmgPct += v;
  }
  return acc;
}

const negate = (m: StatMutation): StatMutation => ({
  mainPct: -(m.mainPct ?? 0),
  mainFlat: -(m.mainFlat ?? 0),
  attPct: -(m.attPct ?? 0),
  attFlat: -(m.attFlat ?? 0),
  boss: -(m.boss ?? 0),
  critRate: -(m.critRate ?? 0),
  critDmg: -(m.critDmg ?? 0),
  dmgPct: -(m.dmgPct ?? 0),
  // IED cannot be un-stacked by negation; a plan that replaces an IED line must be
  // evaluated by rebuilding the IED total, which rankUpgrades does via replaceIed().
});

/* ==========================================================================
 * SECTION 4 — PLANS AND THE RANKING. One scalar, one sort.
 * ========================================================================== */

export type Confidence = "absolute" | "ranking-only";

export interface CubePlan {
  readonly slotId: string;
  readonly cube: CubeType;
  readonly target: PotentialTarget;
  /** Tier-up leg, null when the item is already at the tier the target needs. */
  readonly tierUp: Distribution | null;
  /** Line-hunting leg at the target tier. */
  readonly lineRolls: Distribution;
  readonly pPerCube: number;
  readonly expectedCubes: number;
  readonly median: number;
  readonly p75: number;
  readonly p90: number;
  /** Null whenever any constant on the path is a placeholder. Never guess a meso total. */
  readonly mesoTotal: number | null;
  readonly dmgDeltaPct: number;
  readonly mesoPerOnePercentDamage: number | null;
  readonly confidence: Confidence;
  readonly placeholders: readonly string[];
  readonly impossible?: string;
}

const CUBE_KEYS = (cube: CubeType): string[] => [
  `TIER_UP.${cube}`,
  `PRIME_LINE.${cube}`,
  "LINE_POOLS",
  "OTHER_LINE_VALUES",
  ...(cube === "glowing" || cube === "bright" ? [`DOUBLE_RANK_UP_GIVEN_UP.${cube}`] : []),
  ...(cube === "bright" ? ["BRIGHT_MECHANIC"] : []),
];

/**
 * The whole cube answer for one slot: cubes to tier up, then cubes to hit the lines,
 * then what that is worth and what it costs per point of damage.
 *
 * Both legs are exact. The tier-up leg is the Markov chain above; the line leg is
 * geometric with the enumerated per-cube success probability, so its quantiles come from
 * the same closed form. They are summed rather than convolved because the reported
 * quantiles of the sum would otherwise imply a precision the underlying rates do not
 * have — the mean is exact either way, and the p75/p90 of the sum of the two legs are
 * reported per leg in tierUp and lineRolls for anyone who wants them.
 */
export interface CubeAttempts {
  readonly tierUp: Distribution | null;
  readonly lineRolls: Distribution;
  readonly pPerCube: number;
  readonly expectedCubes: number;
  readonly median: number;
  readonly p75: number;
  readonly p90: number;
  readonly mesoTotal: number | null;
  /** Weighted-average lines conditional on hitting the target. */
  readonly expectedLines: StatMutation;
  readonly confidence: Confidence;
  readonly placeholders: readonly string[];
  readonly impossible?: string;
}

/**
 * The cube half of the answer, with no damage model attached.
 *
 * This is the seam for lib/upgrades.ts, which currently carries a placeholder
 * EXPECTED_CUBES_TO_TIER table: call this instead and it gets a real distribution,
 * quantiles included, without either module having to agree on a damage type.
 */
export function cubeAttempts(
  it: Item,
  potKind: CubeablePotKind,
  target: PotentialTarget,
  cube: CubeType,
): CubeAttempts {
  const placeholders = CUBE_KEYS(cube).filter(isPlaceholderKey);
  const startTier: Tier = it.pot || "none";
  const none = (why: string): CubeAttempts => ({
    tierUp: null,
    lineRolls: geometricDistribution(0),
    pPerCube: 0,
    expectedCubes: Infinity,
    median: Infinity, p75: Infinity, p90: Infinity,
    mesoTotal: null,
    expectedLines: blankMutation(),
    confidence: "ranking-only",
    placeholders,
    impossible: why,
  });

  if (startTier === "none") return none("Potential is not unlocked yet.");
  if (tierIndex(CUBE_MAX_TIER.value[cube]) < tierIndex(target.minTier))
    return none(`A ${CUBE_LABEL[cube]} cube cannot reach ${target.minTier}.`);

  const needsTierUp = tierIndex(startTier) < tierIndex(target.minTier);
  const tierUp = needsTierUp ? tierUpDistribution(cube, startTier, target.minTier) : null;
  if (needsTierUp && !tierUp) return none("No tier-up rate available for this cube.");

  const workingTier = (needsTierUp ? target.minTier : startTier) as CubeableTier;
  const hit = cube === "bright"
    ? pHitBright(potKind, it.lvl, workingTier, target.predicate)
    : analyseHit(cube, potKind, it.lvl, workingTier, target.predicate);
  if (!(hit.p > 0)) return none("This target cannot roll on this slot at that tier.");

  const lineRolls = geometricDistribution(hit.p);
  const expectedCubes = (tierUp?.mean ?? 0) + lineRolls.mean;
  const confidence: Confidence = placeholders.length === 0 ? "absolute" : "ranking-only";
  return {
    tierUp, lineRolls,
    pPerCube: hit.p,
    expectedCubes,
    // The two legs are reported separately rather than convolved: summing their
    // quantiles is an upper bound on the true quantile of the sum, and claiming a
    // convolved p90 would imply a precision these rates do not have.
    median: (tierUp?.median ?? 0) + lineRolls.median,
    p75: (tierUp?.p75 ?? 0) + lineRolls.p75,
    p90: (tierUp?.p90 ?? 0) + lineRolls.p90,
    mesoTotal: confidence === "absolute" ? expectedCubes * cubeCost(cube, it.lvl) : null,
    expectedLines: hit.expected,
    confidence,
    placeholders,
  };
}

export function cubePlan(
  slotId: string,
  it: Item,
  potKind: CubeablePotKind,
  target: PotentialTarget,
  cube: CubeType,
  d: DamageInputs,
  main: MainStat,
): CubePlan {
  const a = cubeAttempts(it, potKind, target, cube);
  if (a.impossible) {
    return {
      slotId, cube, target,
      tierUp: a.tierUp, lineRolls: a.lineRolls, pPerCube: a.pPerCube,
      expectedCubes: a.expectedCubes, median: a.median, p75: a.p75, p90: a.p90,
      mesoTotal: a.mesoTotal, dmgDeltaPct: 0, mesoPerOnePercentDamage: null,
      confidence: a.confidence, placeholders: a.placeholders, impossible: a.impossible,
    };
  }

  // Value the roll as the gain over what the player ALREADY has on this item: strip the
  // current lines off the baseline, add the expected new ones, and compare that against
  // the untouched character. Comparing against the stripped baseline instead would credit
  // a reroll with the full value of its lines and rank a downgrade as an upgrade — a
  // 21% target on a slot that already reads 27% has to come out negative. IED is rebuilt
  // rather than subtracted because IED stacks multiplicatively.
  const cur = currentPotentialMutation(it, main);
  const withoutCurrent = applyMutation(replaceIed(d, removeIed(d.ied, cur.ied ?? 0)), negate(cur));
  const before = dmgIndex(d);
  const after = dmgIndex(applyMutation(withoutCurrent, a.expectedLines));
  const dmgDeltaPct = before > 0 ? (after / before - 1) * 100 : 0;

  return {
    slotId, cube, target,
    tierUp: a.tierUp, lineRolls: a.lineRolls, pPerCube: a.pPerCube,
    expectedCubes: a.expectedCubes, median: a.median, p75: a.p75, p90: a.p90,
    mesoTotal: a.mesoTotal,
    dmgDeltaPct,
    mesoPerOnePercentDamage: a.mesoTotal !== null && dmgDeltaPct > 0 ? a.mesoTotal / dmgDeltaPct : null,
    confidence: a.confidence,
    placeholders: a.placeholders,
  };
}

const replaceIed = (d: DamageInputs, ied: number): DamageInputs => ({ ...d, ied });
/** Invert one stacked IED line out of a total. */
const removeIed = (total: number, line: number): number =>
  line <= 0 || line >= 100 ? total : 100 - (100 - total) / (1 - line / 100);

/** Flat today. itemLevel is a live argument so that a future level-scaled cost is a
 *  one-line change here rather than a change at every call site. */
export function cubeCost(cube: CubeType, itemLevel: number): number {
  return CUBE_COST_MESOS.value[cube] * CUBE_COST_LEVEL_SCALING.value(itemLevel);
}

export type UpgradeKind = "cube" | "starforce" | "flame";

export interface RankedUpgrade {
  readonly rank: number;
  readonly kind: UpgradeKind;
  readonly slotId: string;
  readonly slotName: string;
  readonly label: string;
  readonly expectedMesoCost: number | null;
  readonly dmgDeltaPct: number;
  /** The scalar everything sorts on. Null when any input is a placeholder. */
  readonly mesoPerOnePercentDamage: number | null;
  /** Unit-free and always present: how many times worse this upgrade's cost-per-damage
   *  is than the best entry in the same ranking. 1.0 is the best buy; 4.2 means "4.2x
   *  more cost per point of damage than the top of the list". Deliberately NOT a meso
   *  figure, so a suppressed absolute can never leak out through this field. */
  readonly costPerDamageVsBest: number;
  readonly confidence: Confidence;
  readonly placeholders: readonly string[];
  readonly detail?: string;
}

export interface RankOptions extends DeriveOptions {
  readonly cube?: CubeType;
  /** Include farmed cubes, which are priced at FARMED_CUBE_TIME_COST (0 by default and
   *  therefore free, which will sort them first — see that constant's note). */
  readonly includeFarmed?: boolean;
}

/**
 * "Which single upgrade buys me the most damage per meso?" — one array, one sort.
 *
 * Cubes, the next star force tap and a 3M flame reset all reduce to the same scalar, so
 * they compete on one axis instead of living in three different advice paragraphs.
 * Where a real meso cost exists the scalar is mesos per 1% damage; where it does not
 * (every cube path today, because the rates are placeholders) the sort falls back to the
 * same ratio in relative units, which is order-preserving.
 */
export function rankUpgrades(ch: Character, o: RankOptions = {}): RankedUpgrade[] {
  const d = deriveDamageInputs(ch, o);
  const cube = o.cube ?? "bright";
  // Raw cost-per-damage, in mesos where a meso cost exists and in expected-cubes
  // otherwise. Never rendered — it is normalised against the best entry before return.
  const out: Array<Omit<RankedUpgrade, "rank" | "costPerDamageVsBest"> & { raw: number }> = [];

  for (const slot of SLOTS) {
    const it = ch.items[slot.id];
    if (!it) continue;

    if (slot.pot !== "no" && !it.noPot) {
      for (const target of targetsFor(slot.pot)) {
        const plan = cubePlan(slot.id, it, slot.pot as CubeablePotKind, target, cube, d, ch.main);
        if (plan.impossible || !(plan.dmgDeltaPct > 0) || !isFinite(plan.expectedCubes)) continue;
        const relative = (plan.expectedCubes * relativeCubeWeight(cube)) / plan.dmgDeltaPct;
        out.push({
          kind: "cube",
          slotId: slot.id,
          slotName: slot.n,
          label: `${CUBE_LABEL[cube]} cube to ${target.label}`,
          expectedMesoCost: plan.mesoTotal,
          dmgDeltaPct: plan.dmgDeltaPct,
          mesoPerOnePercentDamage: plan.mesoPerOnePercentDamage,
          raw: relative,
          confidence: plan.confidence,
          placeholders: plan.placeholders,
          detail: `median ${plan.median} cubes, p90 ${plan.p90}`,
        });
      }
    }

    const sf = starForceTap(slot, it, d);
    if (sf) out.push(sf);

    const fl = flameReset(slot, it, ch.main, d);
    if (fl) out.push(fl);
  }

  out.sort((a, b) => a.raw - b.raw);
  const best = out.length ? out[0].raw : 1;
  return out.map(({ raw, ...u }, i) => ({
    ...u,
    rank: i + 1,
    costPerDamageVsBest: best > 0 && isFinite(best) ? raw / best : raw,
  }));
}

/** Cubes of different types are not interchangeable units, so the relative axis has to
 *  price them against each other even when absolute mesos are suppressed. Farmed cubes
 *  are weighted by FARMED_CUBE_TIME_COST, which is 0 until someone sources one. */
function relativeCubeWeight(cube: CubeType): number {
  const meso = CUBE_COST_MESOS.value[cube];
  return meso > 0 ? meso : FARMED_CUBE_TIME_COST.value;
}

type RankEntry = Omit<RankedUpgrade, "rank" | "costPerDamageVsBest"> & { raw: number };

function starForceTap(slot: SlotDef, it: Item, d: DamageInputs): RankEntry | null {
  if (!canStarForce(slot, it)) return null;
  const cap = sfCap(it);
  const star = Math.min(it.star || 0, cap);
  if (star >= cap) return null;
  const p = SF_SUCCESS.value[star];
  if (!p) return null;

  const gain = SF_STAT_PER_STAR.value;
  const taps = 1 / p;
  const divisors = SF_TAP_COST_DIVISORS.value;
  const placeholders = [
    ...(gain ? [] : ["SF_STAT_PER_STAR"]),
    ...(divisors ? [] : ["SF_TAP_COST_DIVISORS"]),
  ];
  const dmg = gain ? dmgDelta(d, { mainFlat: gain.mainFlat, attFlat: gain.attFlat }) : 0;
  const boom = SF_BOOM.value[star] ?? 0;
  return {
    kind: "starforce",
    slotId: slot.id,
    slotName: slot.n,
    label: `Star force ${star} → ${star + 1}`,
    expectedMesoCost: null,
    dmgDeltaPct: dmg,
    mesoPerOnePercentDamage: null,
    // A tap's cost in mesos needs SF_TAP_COST_DIVISORS and its gain needs SF_STAT_PER_STAR;
    // neither could be sourced. Infinity keeps the row in the list, visible and last,
    // rather than silently ranking a tap as free damage.
    raw: divisors && gain && dmg > 0 ? taps / dmg : Infinity,
    confidence: "ranking-only",
    placeholders,
    detail: `${taps.toFixed(1)} taps expected at ${(p * 100).toFixed(0)}%${boom ? `, ${(boom * 100).toFixed(1)}% boom per tap` : ", no boom risk"}`,
  };
}

function flameReset(slot: SlotDef, it: Item, main: MainStat, d: DamageInputs): RankEntry | null {
  if (!slot.fl || it.noFl) return null;
  const lines = (it.f ?? []).filter(Boolean);
  const dead = lines.filter((l) => isDeadLine(l, main)).length;
  if (lines.length > 0 && dead === 0) return null;
  const gain = FLAME_RESET_EXPECTED_GAIN.value;
  const dmg = dmgDelta(d, { mainFlat: gain.mainFlat, attFlat: gain.attFlat });
  return {
    kind: "flame",
    slotId: slot.id,
    slotName: slot.n,
    label: lines.length ? `Reflame (${dead} dead line${dead > 1 ? "s" : ""})` : "Roll a flame",
    expectedMesoCost: FLAME_RESET_COST.value,
    dmgDeltaPct: dmg,
    mesoPerOnePercentDamage: dmg > 0 ? FLAME_RESET_COST.value / dmg : null,
    raw: dmg > 0 ? FLAME_RESET_COST.value / dmg : Infinity,
    confidence: "ranking-only",
    placeholders: ["FLAME_RESET_EXPECTED_GAIN"],
    detail: `${FLAME_RESET_COST.value.toLocaleString()} mesos per reset`,
  };
}

/* ==========================================================================
 * SECTION 5 — REGISTRY, CONFIDENCE AND SELF-CHECK
 * ========================================================================== */

/** Every sourced constant in this module, by the name callers see. The UI reads this to
 *  decide whether it is allowed to print an absolute number. */
export const CONSTANT_REGISTRY: Readonly<Record<string, Sourced<unknown>>> = {
  CUBE_MAX_TIER,
  CUBE_COST_MESOS,
  CUBE_COST_LEVEL_SCALING,
  FARMED_CUBE_TIME_COST,
  "TIER_UP.mystical": TIER_UP.mystical,
  "TIER_UP.hard": TIER_UP.hard,
  "TIER_UP.solid": TIER_UP.solid,
  "TIER_UP.glowing": TIER_UP.glowing,
  "TIER_UP.bright": TIER_UP.bright,
  "DOUBLE_RANK_UP_GIVEN_UP.glowing": DOUBLE_RANK_UP_GIVEN_UP.glowing,
  "DOUBLE_RANK_UP_GIVEN_UP.bright": DOUBLE_RANK_UP_GIVEN_UP.bright,
  "PRIME_LINE.mystical": PRIME_LINE.mystical,
  "PRIME_LINE.hard": PRIME_LINE.hard,
  "PRIME_LINE.solid": PRIME_LINE.solid,
  "PRIME_LINE.glowing": PRIME_LINE.glowing,
  "PRIME_LINE.bright": PRIME_LINE.bright,
  GUARANTEED_TIER_UP_AFTER,
  BRIGHT_MECHANIC,
  LEVEL_BANDS,
  MAIN_STAT_LINE_PCT,
  ALL_STAT_LINE_PCT,
  OTHER_LINE_VALUES,
  LINE_POOLS,
  BOSS_DEFENSE_PCT,
  SYMBOL_STAT_PER_LEVEL,
  ARCANE_POWER_PER_LEVEL,
  FLAME_RESET_COST,
  FLAME_RESET_EXPECTED_GAIN,
  SF_SUCCESS,
  SF_BOOM,
  SF_TAP_COST_DIVISORS,
  SF_STAT_PER_STAR,
};

const isPlaceholderKey = (k: string): boolean => CONSTANT_REGISTRY[k]?.placeholder === true;

/** Names of every unsourced constant. The slot panel renders "rates unsourced — ranking
 *  only" whenever this is non-empty for the path it just computed. */
export const unverifiedConstants = (): string[] =>
  Object.entries(CONSTANT_REGISTRY).filter(([, c]) => c.placeholder).map(([k]) => k);

export const planConfidence = (p: CubePlan): Confidence => p.confidence;

/** The marker the slot panel must show whenever a figure was suppressed. Kept here so
 *  the wording cannot drift from the rule that produces it. */
export const RATES_UNSOURCED_MARKER = "rates unsourced — ranking only";

const meso = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : n.toLocaleString();

/**
 * The slot-panel result row, with the suppression rule applied in ONE place.
 *
 * Sourced: "median 34 cubes, p90 78, 748M mesos, +2.1% damage, 356M per 1% damage, rank 4 of 25".
 * Placeholder anywhere on the path: the cube counts and meso totals are dropped entirely
 * and the row degrades to "+2.1% damage, rank 4 of 25 — rates unsourced — ranking only".
 * A component that renders this string cannot accidentally leak a confident meso total.
 */
export function describePlan(plan: CubePlan, rank?: number, of?: number): string {
  const parts: string[] = [];
  if (plan.impossible) return plan.impossible;
  if (plan.confidence === "absolute") {
    parts.push(`median ${plan.median} cubes`, `p90 ${plan.p90}`);
    if (plan.mesoTotal !== null) parts.push(`${meso(plan.mesoTotal)} mesos`);
  }
  parts.push(`${plan.dmgDeltaPct >= 0 ? "+" : ""}${plan.dmgDeltaPct.toFixed(1)}% damage`);
  if (plan.confidence === "absolute" && plan.mesoPerOnePercentDamage !== null)
    parts.push(`${meso(plan.mesoPerOnePercentDamage)} per 1% damage`);
  if (rank !== undefined && of !== undefined) parts.push(`rank ${rank} of ${of}`);
  if (plan.confidence !== "absolute") parts.push(RATES_UNSOURCED_MARKER);
  return parts.join(", ");
}

/** Same rule for a ranked row. */
export function describeUpgrade(u: RankedUpgrade, of: number): string {
  const parts = [`#${u.rank} of ${of}`, `${u.slotName} — ${u.label}`, `+${u.dmgDeltaPct.toFixed(1)}% damage`];
  if (u.confidence === "absolute" && u.mesoPerOnePercentDamage !== null)
    parts.push(`${meso(u.mesoPerOnePercentDamage)} per 1% damage`);
  else
    parts.push(
      isFinite(u.costPerDamageVsBest) ? `${u.costPerDamageVsBest.toFixed(1)}x the best buy` : "not rankable yet",
      RATES_UNSOURCED_MARKER,
    );
  if (u.detail) parts.push(u.detail);
  return parts.join(", ");
}

export interface CheckResult { readonly name: string; readonly ok: boolean; readonly detail: string }

/**
 * Everything tools/cubeCheck.ts needs, so that script is a three-line wrapper (this
 * agent does not own tools/, hence the logic living here):
 *   (a) the closed form agrees with a Monte Carlo,
 *   (b) every exported constant carries a non-empty source string unless it is flagged,
 *   (c) every line pool's weights sum to the documented total.
 */
export function selfCheck(monteCarloRuns = 200_000): CheckResult[] {
  const out: CheckResult[] = [];

  // (a) closed form vs sampling.
  const cube: CubeType = "bright";
  const dist = tierUpDistribution(cube, "epic", "legendary");
  if (!dist) {
    out.push({ name: "closed-form vs monte carlo", ok: false, detail: "no distribution" });
  } else {
    const rates = TIER_UP[cube].value;
    const dbl = DOUBLE_RANK_UP_GIVEN_UP[cube].value;
    let total = 0;
    const samples: number[] = [];
    for (let r = 0; r < monteCarloRuns; r++) {
      let t = tierIndex("epic");
      let n = 0;
      while (t < tierIndex("legendary")) {
        n++;
        const p = rates[TIER_ORDER[t]] as number;
        if (Math.random() < p) {
          const canDouble = dbl > 0 && t + 2 <= tierIndex("legendary");
          t += canDouble && Math.random() < dbl ? 2 : 1;
        }
      }
      total += n;
      samples.push(n);
    }
    const mcMean = total / monteCarloRuns;
    samples.sort((a, b) => a - b);
    const mcP90 = samples[Math.min(samples.length - 1, Math.floor(0.9 * samples.length))];
    const meanErr = Math.abs(mcMean - dist.mean) / dist.mean;
    const p90Err = Math.abs(mcP90 - dist.p90) / dist.p90;
    out.push({
      name: "closed-form E[cubes] vs monte carlo",
      ok: meanErr < 0.02,
      detail: `closed ${dist.mean.toFixed(1)} vs mc ${mcMean.toFixed(1)} (${(meanErr * 100).toFixed(2)}%)`,
    });
    out.push({
      name: "closed-form p90 vs monte carlo",
      ok: p90Err < 0.02,
      detail: `closed ${dist.p90} vs mc ${mcP90} (${(p90Err * 100).toFixed(2)}%)`,
    });
  }

  // (b) sources.
  for (const [name, c] of Object.entries(CONSTANT_REGISTRY)) {
    const ok = c.placeholder ? (c.note ?? "").length > 0 : c.source.length > 0;
    out.push({
      name: `source: ${name}`,
      ok,
      detail: c.placeholder ? "placeholder, must carry a note" : c.source.slice(0, 60),
    });
  }

  // (c) pool weights.
  for (const potKind of Object.keys(POOL_SPEC) as CubeablePotKind[]) {
    for (const tier of Object.keys(POOL_SPEC[potKind]) as CubeableTier[]) {
      const sum = POOL_SPEC[potKind][tier].reduce((a, e) => a + e.weight, 0);
      out.push({
        name: `pool weights ${potKind}/${tier}`,
        ok: sum === POOL_WEIGHT_TOTAL,
        detail: `${sum} / ${POOL_WEIGHT_TOTAL}`,
      });
    }
  }

  // (d) a geometric quantile identity, because the line leg leans on it entirely.
  const g = geometricDistribution(0.03);
  out.push({
    name: "geometric p90 identity",
    ok: g.p90 === geometricQuantile(0.03, 0.9),
    detail: `${g.p90} vs ${geometricQuantile(0.03, 0.9)}`,
  });

  return out;
}
