// The class roster and the class-guide layer.
//
// Two things live behind this module and they are not the same kind of thing:
//
//   ROSTER   — 53 classes, every field sourced from a fan wiki or Grandis
//              Library. Complete, because it is sourceable and immediately
//              useful: branch, stats, weapons, link skill, Legion square.
//   GUIDES   — the judgement layer (V matrix order, HEXA order, hyper stats,
//              inner ability, rotation). ONE class is written: Bow Master.
//              Every other class reports `guide: null` and the UI renders an
//              honest empty slot. That follows lib/legion.ts's LINK_EFFECT
//              precedent, whose own comment says it best: an unlabelled link is
//              better than an invented one. A confidently wrong skill build
//              costs a real person weeks of misallocated resources.
//
// NOTHING HERE RESTATES A DAMAGE CONSTANT. A guide skill's effect carries a
// `from` path into lib/damage.ts BOW_MASTER and `damageConstant()` resolves it,
// so the citation and the value stay in the one module that owns them. A prior
// wave re-implemented the damage model in-file and shipped a number 24% wrong.
//
// Icons: there are none, on purpose, and that is a legal finding rather than an
// omission — see data/classes.json meta.licensing.icons. What ships instead is
// a monogram plus a branch colour, from `markFor()`.

import rawData from "@/data/classes.json";
import {
  BOW_MASTER,
  BOSS_PDR,
  DEFAULT_PDR,
  classKey,
  iedWall,
  type SourcedNumber,
} from "@/lib/damage";
import { LINK_EFFECT, linkEffect, rankOf, type Rank } from "@/lib/legion";

/* ============================================================================
 * VERIFICATION
 * ==========================================================================*/

/** What kind of claim a record is making. The axis data/guide-graph.json lacks.
 *
 *  A class guide is ~80% judgement by volume. Without this third state the
 *  whole feature renders as a wall of UNVERIFIED and nobody reads it — while
 *  "boost nodes give final damage" (a fact) gets buried in the same bucket as
 *  "build the boss trio first" (a call). */
export type ClaimType = "fact" | "consensus" | "judgement";

/** Computed, never typed by hand — same rule as data/guide-graph.json. */
export type VerificationState = "verified" | "unverified" | "stale";

export interface Conflict {
  readonly source: string;
  readonly claim: string;
}

export interface Verification {
  /** A URL, or a string starting "UNVERIFIED — " followed by why. */
  readonly source: string;
  /** ISO date a human opened the source. Empty when unverified. */
  readonly lastVerified: string;
  readonly patchVersion: string;
  readonly claimType: ClaimType;
  readonly conflictsWith: readonly Conflict[] | null;
  readonly regionScope?: string;
  readonly worldScope?: string;
}

/* ============================================================================
 * ROSTER TYPES
 * ==========================================================================*/

export type StatLabel = string;

export interface BranchColor {
  readonly hex: string;
  readonly cssVar: string;
  /** Reads "MaplePlanner design decision — NOT a game constant." Render it. */
  readonly decidedBy: string;
}

export interface Branch {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly color: BranchColor;
}

export interface Archetype {
  readonly id: string;
  readonly name: string;
  readonly emblem: Verification & {
    readonly name: string;
    readonly level: number;
    readonly stats: string;
    readonly potentialLines: string;
  };
}

export interface LinkSkill extends Verification {
  /** Null when the sources disagree on the NAME — see nameCandidates. */
  readonly name: string | null;
  readonly nameCandidates: readonly string[] | null;
  /** Null when no source could be trusted for the effect. */
  readonly effect: string | null;
  readonly masterLevel: number | null;
  readonly stacks: {
    readonly group: string;
    readonly max: number;
    readonly note: string;
  } | null;
  readonly aliases: readonly string[] | null;
}

export interface LegionEffect extends Omit<Verification, "conflictsWith"> {
  readonly effect: string;
  readonly values: readonly number[];
  readonly unit: "flat" | "percent" | "special";
  readonly stat: string | null;
}

export interface WeaponMultiplier {
  /** Null when the class has per-form or per-grip variants, or when unsourced. */
  readonly value: number | null;
  readonly variants: Readonly<Record<string, number>> | null;
  readonly note: string | null;
}

export type Completeness = "reference" | "roster-only";

export interface ClassRecord extends Verification {
  /** classKey(name) — the SAME normaliser lib/damage.ts uses, so this id joins
   *  CLASS_CONSTANTS, and `linkEffectKeyFor()` bridges to legion.ts's spacier
   *  keys. Three normalisations across three files is a silent join failure. */
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly branch: string;
  readonly branchAliases: readonly string[] | null;
  readonly archetype: string;
  readonly primaryStat: StatLabel;
  readonly secondaryStat: StatLabel;
  readonly weapon: string;
  readonly secondaryWeapon: string;
  readonly mark: { readonly monogram: string };
  /** Crit rate from PASSIVES ONLY, as a fraction. Legion, hyper stats, links
   *  and gear stack on top. The highest-leverage single gearing number on the
   *  roster: a 40%-or-below class is where crit links earn their slot; a 85-94%
   *  class should spend those slots on damage. */
  readonly innateCritRate: { readonly value: number; readonly note: string | null };
  readonly innateCritDamage: { readonly value: number | null; readonly note: string | null };
  readonly weaponMultiplier: WeaponMultiplier;
  readonly linkSkill: LinkSkill;
  readonly legion: LegionEffect;
  /** Everything that breaks the normal main/secondary assumption for this class. */
  readonly exceptions: readonly string[];
  readonly guide: string | null;
  readonly completeness: Completeness;
}

/* ============================================================================
 * GUIDE TYPES
 * ==========================================================================*/

/** A path into lib/damage.ts BOW_MASTER. Resolved by `damageConstant()`. */
export type DamageConstantRef =
  | "weaponMultiplier"
  | "mastery"
  | "minCritDamageBonus"
  | "finalDamageSources[0]"
  | "finalDamageSources[1]"
  | "finalDamageSources[2]"
  | "finalDamageSources[3]"
  | "alreadyInStatWindow.critRate"
  | "alreadyInStatWindow.critDamage"
  | "alreadyInStatWindow.bossDamage"
  | "alreadyInStatWindow.ied"
  | "alreadyInStatWindow.attPct";

export interface SkillEffect {
  readonly kind: string;
  /** Set when lib/damage.ts owns the number. Never copy the value here. */
  readonly from: string | null;
  /** Set only for components damage.ts does NOT own (e.g. one skill's share of
   *  an aggregate it stores as a single total). */
  readonly value: number | null;
  /** Which damage.ts aggregate this component rolls up into. */
  readonly partOf: string | null;
  readonly note: string;
  readonly source?: string;
}

export type SkillKind =
  | "active" | "passive" | "buff" | "toggle" | "summon"
  | "bind" | "iframe" | "movement" | "party-buff" | "link";

export interface Skill extends Verification {
  readonly id: string;
  readonly name: string;
  readonly skillId: number | null;
  readonly advancement: number | null;
  readonly kind: SkillKind;
  readonly roleTags: readonly string[];
  readonly maxLevel: number | null;
  readonly masterLevel: number | null;
  readonly cooldownSec: number | null;
  readonly durationSec: number | null;
  /** NULL BY DESIGN and never inferred. See damageLineNote. */
  readonly damageLine: null;
  readonly damageLineNote: string;
  readonly effects: readonly SkillEffect[];
  readonly supersededBy: string | null;
  readonly notes: string | null;
}

export type Sufficiency = "abundant" | "tight" | "insufficient" | null;

export interface SkillBuild extends Verification {
  readonly advancement: number;
  readonly spAvailableAtCap: number | null;
  readonly spToMaxAll: number | null;
  /** The honest answer to "does build order still matter here". */
  readonly sufficiency: Sufficiency;
  readonly order: readonly { skillId: string; toLevel: number; rationale: string }[];
  readonly resetMechanism: string | null;
  readonly note: string;
}

export interface HyperSkillPick extends Verification {
  readonly hyperSkillId: string;
  readonly name: string;
  readonly boostedSkillId: string;
  readonly effect: string;
  readonly rank: number;
  readonly rationale: string;
}

export interface HyperSkillPlan extends Verification {
  readonly passivePointLevels: readonly number[];
  readonly activePointLevels: readonly number[] | null;
  readonly activePointLevelsNote: string;
  readonly picks: readonly HyperSkillPick[];
  /** The counterfactual. What you gave up is the content of the decision. */
  readonly forgone: readonly (Verification & { what: string; why: string })[];
  readonly resetCostMesoCap: number;
  readonly resetCostNote: string;
}

export type RulePriority = "critical" | "high" | "medium" | "diminishing" | "dead";

export interface ConditionalRule extends Verification {
  readonly id: string;
  readonly stat: string;
  readonly condition: {
    readonly term: "critRate" | "ied";
    readonly op: "lt" | "lte" | "gt" | "gte";
    readonly value: number | null;
    /** A formula in lib/damage.ts terms, resolved by `evaluateRule()`. */
    readonly valueFrom: string | null;
  };
  readonly thenPriority: RulePriority;
  readonly elsePriority: RulePriority;
  readonly rationale: string;
  readonly pricedBy: { readonly term: string; readonly via: string } | null;
}

export interface HyperStatPlan extends Verification {
  readonly hspGainedByLevel: readonly number[] | null;
  readonly costPerLevel: readonly number[] | null;
  readonly tablesNote: string;
  readonly lines: readonly {
    stat: string; label: string; valuePerLevel: number | null; cap: number | null;
  }[];
  readonly conditionalRules: readonly ConditionalRule[];
  readonly profiles: readonly (Verification & { goal: string; order: readonly string[] })[];
}

export interface InnerAbilityPlan extends Verification {
  readonly presets: readonly { name: string; purpose: string }[];
  readonly presetsNote: string;
  readonly lines: readonly {
    slot: number; rank: string; option: string; valueRange: string;
    desirability: string; classCondition: string | null; rationale: string;
  }[];
  readonly firstLineTargets: readonly string[];
  /** The highest-value field in the schema per byte. */
  readonly stopRule: string;
  readonly rerollMethod: readonly { method: string; cost: string; availableInHeroic: boolean }[];
  readonly rerollMethodNote: string;
}

export interface VMatrixPlan extends Verification {
  readonly slotCurve: readonly { atLevel: number; slots: number }[];
  readonly slotCurveNote: string;
  readonly slotCurveConflict: readonly Conflict[];
  readonly nodeTypes: readonly { type: string; label: string; note: string }[];
  readonly boostNodeMechanics: Verification & {
    maxLevel: number; effectType: string; multiplicative: boolean;
    masteryFifty: string; note: string;
  };
  readonly craftEconomy: Verification & {
    shardsToCraft: Readonly<Record<string, number>>;
    shardsFromDisassembly: Readonly<Record<string, number>>;
    note: string;
  };
  readonly trios: readonly {
    primarySkillId: string; partnerSkillIds: readonly string[];
    quality: "BiS" | "good" | "acceptable" | "fodder"; rationale: string;
  }[];
  readonly triosNote: string;
  readonly buildOrder: readonly (Verification & {
    rank: number; what: string; why: string;
    pricedBy: { term: string; via: string } | null;
  })[];
  readonly nodestoneSources: readonly string[];
}

export interface HexaPlan extends Verification {
  readonly unlockLevel: number;
  readonly prerequisiteQuest: string;
  readonly nodes: readonly {
    type: string; name: string; boostedSkillId: string | null;
    maxLevel: number; breakpoints: readonly number[];
    addedInPatch: string | null; note: string | null;
  }[];
  readonly costTable: readonly { nodeType: string; level: number; solErda: number; fragments: number }[];
  readonly costTableNote: string;
  readonly incomeModel: Verification & {
    energyPerSolErda: number;
    dailyQuest: string;
    dailyEnergyCapFromAuthenticFields: number | null;
    solErdaHoldCap: number | null;
    bossSources: readonly string[];
    note: string;
  };
  readonly investmentOrder: readonly (Verification & { rank: number; what: string; why: string })[];
  readonly breakpointRule: string;
  readonly hexaStat: Verification & {
    creationCost: { solErda: number; fragments: number };
    mainStatOptions: readonly string[];
    additionalStatOptions: readonly string[];
    statOptionsNote: string;
    maxRank: number;
    rankUpCostCurve: { from0to1: number; from19to20: number; unit: string; note: string };
    rerollMechanics: string | null;
    uniquenessRule: string;
  };
}

export interface RotationPlan extends Verification {
  readonly burstCycleSec: number;
  readonly burstCycleNote: string;
  readonly opener: readonly { skillId: string; offsetSec: number; note: string }[];
  readonly openerNote: string;
  readonly sustainLoop: readonly string[];
  readonly buffsToAlign: readonly { skillId: string; cooldownSec: number | null; note: string }[];
  readonly specialSkillRings: Verification & { choice: readonly string[]; note: string };
  readonly bindWindow: { skillId: string; note: string } | null;
  readonly iframes: readonly string[];
  readonly iframesNote: string;
  readonly buffMacroGroups: readonly string[];
  readonly keybindNotes: string | null;
}

export interface LevelBand {
  readonly from: number;
  readonly to: number;
  readonly focus: string;
  readonly whatStartsMattering: string;
  /** The field with no wiki analogue: guides say what to start, never what to abandon. */
  readonly whatToStopDoing: string;
  readonly gate: string;
}

export interface LevelBandOverlay extends Verification {
  readonly bands: readonly LevelBand[];
  readonly note: string;
}

export interface ClassGuide {
  readonly classId: string;
  readonly displayName: string;
  readonly completeness: "reference";
  readonly summary: string;
  readonly referenceCharacter: {
    name: string; level: number; combatPower: number; note: string;
  };
  readonly damageAuthority: { module: string; constants: string; note: string };
  readonly skills: readonly Skill[];
  readonly skillBuilds: readonly SkillBuild[];
  readonly hyperSkills: HyperSkillPlan;
  readonly hyperStats: HyperStatPlan;
  readonly innerAbility: InnerAbilityPlan;
  readonly vMatrix: VMatrixPlan;
  readonly hexa: HexaPlan;
  readonly rotation: RotationPlan;
  readonly levelBands: LevelBandOverlay;
  readonly openQuestions: readonly string[];
  readonly lastVerified: string;
  readonly patchVersion: string;
  readonly patchVersionNote: string;
}

export interface ClassesMeta {
  readonly title: string;
  readonly region: string;
  readonly gameVersion: string;
  readonly rosterPatchVersion: string;
  readonly lastBuilt: string;
  readonly worldAssumption: string;
  readonly classCount: number;
  readonly verificationPolicy: string;
  readonly stalenessNote: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly licensing: Readonly<Record<string, string>>;
  readonly integration: Readonly<Record<string, string>>;
}

export interface ClassesData {
  readonly meta: ClassesMeta;
  readonly branches: readonly Branch[];
  readonly archetypes: readonly Archetype[];
  readonly markPolicy: {
    kind: string; description: string; colorsAre: string;
    cssVars: readonly string[]; cssVarsNote: string;
  };
  readonly legacyClasses: readonly {
    name: string; status: string; becameClassId: string | null;
    note: string; source: string; lastVerified: string;
  }[];
  readonly statExceptions: readonly { classId: string; what: string; why: string }[];
  readonly classes: readonly ClassRecord[];
  readonly guides: Readonly<Record<string, ClassGuide>>;
  readonly guideSections: readonly { id: string; label: string; required: boolean }[];
}

/* ============================================================================
 * THE DATA
 * ==========================================================================*/

// The JSON is the source of truth; the cast is the only place its shape is
// asserted. `assertRosterIntegrity()` below checks at runtime what a cast
// cannot.
export const CLASS_DATA = rawData as unknown as ClassesData;

export const CLASSES: readonly ClassRecord[] = CLASS_DATA.classes;
export const BRANCHES: readonly Branch[] = CLASS_DATA.branches;
export const ARCHETYPES: readonly Archetype[] = CLASS_DATA.archetypes;
export const CLASS_META: ClassesMeta = CLASS_DATA.meta;

const BY_ID = new Map<string, ClassRecord>();
const BY_ALIAS = new Map<string, ClassRecord>();
for (const c of CLASSES) {
  BY_ID.set(c.id, c);
  BY_ALIAS.set(classKey(c.name), c);
  for (const a of c.aliases) BY_ALIAS.set(classKey(a), c);
}

/** Normalise any spelling of a class into a roster id. Identical to
 *  lib/damage.ts classKey, on purpose — see ClassRecord.id. */
export function classId(cls: string): string {
  return classKey(cls);
}

/** Resolve a class by id, name or alias. Returns undefined rather than a guess. */
export function findClass(cls: string): ClassRecord | undefined {
  const k = classKey(cls);
  return BY_ID.get(k) ?? BY_ALIAS.get(k);
}

export function branchOf(cls: string): Branch | undefined {
  const c = findClass(cls);
  return c ? BRANCHES.find((b) => b.id === c.branch) : undefined;
}

export function archetypeOf(cls: string): Archetype | undefined {
  const c = findClass(cls);
  return c ? ARCHETYPES.find((a) => a.id === c.archetype) : undefined;
}

export function classesInBranch(branchId: string): readonly ClassRecord[] {
  return CLASSES.filter((c) => c.branch === branchId);
}

export function classesByBranch(): { branch: Branch; classes: readonly ClassRecord[] }[] {
  return BRANCHES.map((branch) => ({ branch, classes: classesInBranch(branch.id) }));
}

/** Legacy names that must resolve to something sensible on a roster import:
 *  Beast Tamer became Lynn on 2024-05-01, Jett is gone, Lethe was never GMS. */
export function resolveLegacyName(name: string):
  | { status: string; note: string; nowClass: ClassRecord | undefined }
  | undefined {
  const k = classKey(name);
  const hit = CLASS_DATA.legacyClasses.find((l) => classKey(l.name) === k);
  if (!hit) return undefined;
  return {
    status: hit.status,
    note: hit.note,
    nowClass: hit.becameClassId ? BY_ID.get(hit.becameClassId) : undefined,
  };
}

/* ============================================================================
 * MARKS — the legally shippable "class icon"
 * ==========================================================================*/

export interface ClassMark {
  readonly monogram: string;
  readonly hex: string;
  readonly cssVar: string;
  readonly branchName: string;
  /** Say this out loud in any design review: the colour is ours, not Nexon's. */
  readonly colorIsADesignDecision: string;
}

/** A class's visual identity. There is deliberately no image URL anywhere in
 *  this module: Nexon's creator policy forbids commercial use of its game
 *  images regardless of which CDN serves them, and the community wiki that
 *  hosts a complete icon set is CC BY-NC-SA, which a paid tier contradicts on
 *  its own. See CLASS_META.licensing.icons for the full finding. */
export function markFor(cls: string): ClassMark | undefined {
  const c = findClass(cls);
  if (!c) return undefined;
  const b = BRANCHES.find((x) => x.id === c.branch);
  if (!b) return undefined;
  return {
    monogram: c.mark.monogram,
    hex: b.color.hex,
    cssVar: b.color.cssVar,
    branchName: b.name,
    colorIsADesignDecision: b.color.decidedBy,
  };
}

/* ============================================================================
 * VERIFICATION HELPERS
 * ==========================================================================*/

function patchNumber(patchVersion: string): number {
  const m = /(\d+(?:\.\d+)?)/.exec(patchVersion);
  return m ? Number(m[1]) : Number.NaN;
}

/** True when a record's patchVersion is behind the live game version. Most of
 *  this file is stale by construction: the best GMS source is stamped v.269 and
 *  the app declares v.271. That is honest, not broken. */
export function isStale(patchVersion: string, gameVersion = CLASS_META.gameVersion): boolean {
  const a = patchNumber(patchVersion);
  const b = patchNumber(gameVersion);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

export function isUnverified(v: { source: string }): boolean {
  return v.source.trim().toUpperCase().startsWith("UNVERIFIED");
}

/** Computed from the fields, never hand-typed. Unverified wins over stale:
 *  a number nobody could source is a bigger problem than an old one. */
export function verificationState(
  v: { source: string; patchVersion: string },
  gameVersion = CLASS_META.gameVersion,
): VerificationState {
  if (isUnverified(v)) return "unverified";
  return isStale(v.patchVersion, gameVersion) ? "stale" : "verified";
}

/** The "why" half of an UNVERIFIED source string, for rendering next to the badge. */
export function unverifiedReason(v: { source: string }): string | null {
  if (!isUnverified(v)) return null;
  return v.source.replace(/^UNVERIFIED\s*[—-]\s*/i, "").trim();
}

/* ============================================================================
 * GUIDES
 * ==========================================================================*/

export interface GuideStatus {
  readonly classId: string;
  readonly displayName: string;
  readonly written: boolean;
  readonly completeness: Completeness;
  /** Rendered verbatim in the empty state. Never replace it with filler. */
  readonly message: string;
  /** The taxonomy to render as empty slots when nothing is written. */
  readonly sections: readonly { id: string; label: string; required: boolean }[];
}

const NOT_WRITTEN =
  "Guide not yet written. The roster data above is sourced and complete; the judgement layer " +
  "(V matrix order, HEXA investment order, hyper stats, inner ability, rotation) is not, and " +
  "nothing has been generated to fill the gap. Bow Master is the worked reference class — its " +
  "structure is what this class will get. An empty, honest slot is worth more than a plausible " +
  "fabrication: a wrong skill build costs weeks of misallocated resources.";

export function guideFor(cls: string): ClassGuide | undefined {
  const c = findClass(cls);
  if (!c || !c.guide) return undefined;
  return CLASS_DATA.guides[c.guide];
}

export function guideStatus(cls: string): GuideStatus | undefined {
  const c = findClass(cls);
  if (!c) return undefined;
  const g = c.guide ? CLASS_DATA.guides[c.guide] : undefined;
  return {
    classId: c.id,
    displayName: c.name,
    written: Boolean(g),
    completeness: c.completeness,
    message: g ? g.summary : NOT_WRITTEN,
    sections: CLASS_DATA.guideSections,
  };
}

export function writtenGuides(): readonly ClassGuide[] {
  return Object.values(CLASS_DATA.guides);
}

/** Roster coverage vs guide coverage, for a status line that does not overclaim. */
export function coverage(): {
  classes: number;
  guidesWritten: number;
  rosterOnly: number;
  linkSkillsNamed: number;
  linkSkillsUnresolved: readonly string[];
} {
  const unresolved = CLASSES.filter((c) => c.linkSkill.name === null).map((c) => c.name);
  return {
    classes: CLASSES.length,
    guidesWritten: Object.keys(CLASS_DATA.guides).length,
    rosterOnly: CLASSES.filter((c) => !c.guide).length,
    linkSkillsNamed: CLASSES.length - unresolved.length,
    linkSkillsUnresolved: unresolved,
  };
}

/* ============================================================================
 * DAMAGE JOIN — resolve, never restate
 * ==========================================================================*/

/** Resolve a guide effect's `from` path against lib/damage.ts BOW_MASTER.
 *  Returns the SourcedNumber itself, citation attached, so the UI can show
 *  where the value came from without this module holding a copy of it. */
export function damageConstant(ref: string): SourcedNumber | undefined {
  switch (ref as DamageConstantRef) {
    case "weaponMultiplier": return BOW_MASTER.weaponMultiplier;
    case "mastery": return BOW_MASTER.mastery;
    case "minCritDamageBonus": return BOW_MASTER.minCritDamageBonus;
    case "finalDamageSources[0]": return BOW_MASTER.finalDamageSources[0];
    case "finalDamageSources[1]": return BOW_MASTER.finalDamageSources[1];
    case "finalDamageSources[2]": return BOW_MASTER.finalDamageSources[2];
    case "finalDamageSources[3]": return BOW_MASTER.finalDamageSources[3];
    case "alreadyInStatWindow.critRate": return BOW_MASTER.alreadyInStatWindow.critRate;
    case "alreadyInStatWindow.critDamage": return BOW_MASTER.alreadyInStatWindow.critDamage;
    case "alreadyInStatWindow.bossDamage": return BOW_MASTER.alreadyInStatWindow.bossDamage;
    case "alreadyInStatWindow.ied": return BOW_MASTER.alreadyInStatWindow.ied;
    case "alreadyInStatWindow.attPct": return BOW_MASTER.alreadyInStatWindow.attPct;
    default: return undefined;
  }
}

export interface ResolvedEffect {
  readonly kind: string;
  /** The number, wherever it legitimately came from. Null when unsourced. */
  readonly value: number | null;
  readonly source: string;
  readonly note: string;
  /** True when lib/damage.ts owns this value and this module merely points at it. */
  readonly fromDamageModule: boolean;
  readonly partOf: string | null;
}

export function resolveEffect(e: SkillEffect): ResolvedEffect {
  if (e.from) {
    const sn = damageConstant(e.from);
    return {
      kind: e.kind,
      value: sn ? sn.value : null,
      source: sn ? sn.source : `UNVERIFIED — unknown lib/damage.ts path "${e.from}"`,
      note: e.note,
      fromDamageModule: true,
      partOf: e.from,
    };
  }
  return {
    kind: e.kind,
    value: e.value,
    source: e.source ?? "UNVERIFIED — no source recorded on this effect",
    note: e.note,
    fromDamageModule: false,
    partOf: e.partOf,
  };
}

export function resolveSkillEffects(skill: Skill): readonly ResolvedEffect[] {
  return skill.effects.map(resolveEffect);
}

export function skillsWithRole(guide: ClassGuide, role: string): readonly Skill[] {
  return guide.skills.filter((s) => s.roleTags.includes(role));
}

/* ============================================================================
 * CONDITIONAL RULES — the part a video structurally cannot do
 * ==========================================================================*/

export interface RuleContext {
  /** Effective critical rate as a FRACTION (0.98 for a 98% stat window). */
  readonly critRate: number;
  /** Effective IED as a FRACTION (0.929 for 92.9%). */
  readonly ied: number;
  /** Key into lib/damage.ts BOSS_PDR, e.g. "lucid". Falls back to DEFAULT_PDR. */
  readonly boss?: string;
}

export interface EvaluatedRule {
  readonly rule: ConditionalRule;
  readonly priority: RulePriority;
  /** The number the condition was actually compared against. */
  readonly threshold: number | null;
  readonly observed: number;
  readonly conditionHeld: boolean;
  /** One sentence about THIS character, which is the whole point. */
  readonly verdict: string;
}

function thresholdFor(rule: ConditionalRule, ctx: RuleContext): number | null {
  if (rule.condition.value !== null) return rule.condition.value;
  if (rule.condition.valueFrom && rule.condition.valueFrom.startsWith("iedWall")) {
    const pdr = (ctx.boss !== undefined ? BOSS_PDR[ctx.boss] : undefined) ?? DEFAULT_PDR;
    return iedWall(pdr);
  }
  return null;
}

function compare(op: ConditionalRule["condition"]["op"], a: number, b: number): boolean {
  switch (op) {
    case "lt": return a < b;
    case "lte": return a <= b;
    case "gt": return a > b;
    case "gte": return a >= b;
  }
}

/** Evaluate one conditional rule against a loaded character.
 *
 *  This is the thing a YouTube guide cannot do: it ranks a stat line for a
 *  video's imaginary average player, while this answers for the character in
 *  front of you. A Bow Master at 98% crit has two points of headroom on the
 *  crit line and then every further point is waste — that sentence is only
 *  sayable with the character's own numbers in hand. */
export function evaluateRule(rule: ConditionalRule, ctx: RuleContext): EvaluatedRule {
  const observed = rule.condition.term === "critRate" ? ctx.critRate : ctx.ied;
  const threshold = thresholdFor(rule, ctx);
  const held = threshold === null ? false : compare(rule.condition.op, observed, threshold);
  const priority = held ? rule.thenPriority : rule.elsePriority;

  let verdict: string;
  if (threshold === null) {
    verdict = "No threshold could be resolved for this rule — treat the priority as unknown.";
  } else {
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const gap = Math.abs(threshold - observed);
    // Say where the character actually SITS rather than which branch fired —
    // "past the threshold" is wrong half the time and a wrong sentence about a
    // real character is worse than no sentence.
    const where = observed < threshold
      ? `${pct(observed)} is ${pct(gap)} below the ${pct(threshold)} threshold`
      : observed > threshold
        ? `${pct(observed)} is ${pct(gap)} past the ${pct(threshold)} threshold`
        : `${pct(observed)} is exactly at the ${pct(threshold)} threshold`;
    verdict = `${where} — priority ${priority}.`;
  }
  return { rule, priority, threshold, observed, conditionHeld: held, verdict };
}

const PRIORITY_ORDER: Record<RulePriority, number> = {
  critical: 0, high: 1, medium: 2, diminishing: 3, dead: 4,
};

/** Every hyper-stat rule for a class, evaluated and ordered for one character. */
export function hyperStatPriorities(cls: string, ctx: RuleContext): readonly EvaluatedRule[] {
  const g = guideFor(cls);
  if (!g) return [];
  return [...g.hyperStats.conditionalRules]
    .map((r) => evaluateRule(r, ctx))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

/** Crit rate left to buy before the line goes dead, as a fraction. Negative
 *  means the character is over the cap and paying for nothing. */
export function critRateHeadroom(currentCritRate: number): number {
  return 1 - currentCritRate;
}

/** How far this character is from the IED wall for a boss. Below zero, the
 *  defence term is floored and lib/damage.ts's index stops meaning anything. */
export function iedHeadroom(currentIed: number, boss?: string): {
  wall: number; headroom: number; underWall: boolean;
} {
  const pdr = (boss !== undefined ? BOSS_PDR[boss] : undefined) ?? DEFAULT_PDR;
  const wall = iedWall(pdr);
  return { wall, headroom: currentIed - wall, underWall: currentIed < wall };
}

/* ============================================================================
 * LEGION BRIDGE — extend lib/legion.ts, never fork it
 * ==========================================================================*/

/** legion.ts keys LINK_EFFECT on lowercase-TRIMMED names ("demon avenger")
 *  while damage.ts classKey strips spaces ("demonavenger"). Both normalisations
 *  already exist in the repo; this is the adapter rather than a third one. */
export function linkEffectKeyFor(cls: string): string {
  const c = findClass(cls);
  return (c ? c.name : cls).toLowerCase().trim();
}

/** The roster's link-skill line for a class, falling back to legion.ts's table
 *  when the roster has no name (the Shine and Lynn cases). */
export function linkSkillFor(cls: string): LinkSkill | undefined {
  return findClass(cls)?.linkSkill;
}

/** The extension of lib/legion.ts LINK_EFFECT, which deliberately covers only
 *  the ten classes its author could verify. This covers all 53 by composing the
 *  roster's own sourced name and effect, and falls back to legion.ts's text
 *  where the roster has nothing. legion.ts is imported, not forked, and not
 *  edited: where the two disagree the roster wins and `legionCrossCheck()`
 *  reports the disagreement rather than silently papering over it.
 *
 *  Returns null only when neither source has anything — an unlabelled link is
 *  still better than an invented one. */
export function linkEffectText(cls: string): string | null {
  const c = findClass(cls);
  if (!c) return linkEffect(cls);
  const ls = c.linkSkill;
  const stacks = ls.stacks ? ` Stacks up to ${ls.stacks.max} across unique ${ls.stacks.group} characters.` : "";
  if (ls.name && ls.effect) return `${ls.name} — ${ls.effect}${stacks}`;
  if (ls.effect) return `${ls.effect}${stacks} (link skill NAME unresolved — sources disagree.)`;
  if (ls.nameCandidates?.length) {
    return `Link skill unresolved. Candidates: ${ls.nameCandidates.join(" / ")}.`;
  }
  return linkEffect(cls);
}

export interface LinkMismatch {
  readonly legionKey: string;
  readonly classId: string | null;
  readonly issue: "unmatched-key" | "name-mismatch";
  readonly rosterName: string | null;
  readonly legionText: string | null;
  readonly detail: string;
}

/** Cross-check lib/legion.ts LINK_EFFECT against this roster.
 *
 *  legion.ts is not edited from here — it is imported and compared, and the
 *  disagreements are reported as data. Three were known at the time this file
 *  was written: Demon Slayer and Demon Avenger have their link NAMES swapped,
 *  Luminous's link is Light Wash rather than Permeate, and the key "thunder"
 *  can never match a roster entry reading "Thunder Breaker". Run this rather
 *  than trusting that list — it stays true as either file changes. */
export function legionCrossCheck(): readonly LinkMismatch[] {
  const out: LinkMismatch[] = [];

  for (const [key, text] of Object.entries(LINK_EFFECT)) {
    const c = findClass(key);
    if (!c) {
      out.push({
        legionKey: key, classId: null, issue: "unmatched-key",
        rosterName: null, legionText: text,
        detail: `LINK_EFFECT key "${key}" resolves to no class on the roster, so linkEffect() can never return it.`,
      });
      continue;
    }
    const name = c.linkSkill.name;
    if (name && !text.toLowerCase().includes(name.toLowerCase())) {
      out.push({
        legionKey: key, classId: c.id, issue: "name-mismatch",
        rosterName: name, legionText: text,
        detail: `Roster says ${c.name}'s link skill is "${name}"; LINK_EFFECT describes it as "${text}".`,
      });
    }
  }

  return out;
}

/** Classes lib/legion.ts has no LINK_EFFECT row for. This is COVERAGE, not a
 *  bug — kept out of legionCrossCheck() so the three real defects there are not
 *  buried under forty rows. `linkEffectText()` already covers every one of
 *  these from the roster, so nothing renders unlabelled as long as callers use
 *  this module rather than legion.linkEffect() directly. */
export function classesMissingFromLinkEffect(): readonly ClassRecord[] {
  return CLASSES.filter((c) => !(c.name.toLowerCase().trim() in LINK_EFFECT));
}

/** Zero's Legion rank ladder is not the shared one. lib/legion.ts rankOf()
 *  returns "S" for a Lv 140 Zero, which is wrong — a Zero is rank B until 130
 *  and does not reach S until 180. Source: MapleStory Wiki, Legion System. */
export const LEGION_RANK_OVERRIDES: Readonly<Record<string, readonly [number, Rank][]>> = {
  zero: [[250, "SSS"], [200, "SS"], [180, "S"], [160, "A"], [130, "B"]],
};

/** Rank for a character, honouring the per-class override. Prefer this over
 *  legion.rankOf() anywhere the class is known. */
export function legionRankOf(cls: string, lvl: number): Rank {
  const c = findClass(cls);
  const override = c ? LEGION_RANK_OVERRIDES[c.id] : undefined;
  if (!override) return rankOf(lvl);
  for (const [at, r] of override) if (lvl >= at) return r;
  return "-";
}

/** Classes whose Legion square is not a stat ladder — the ones worth levelling
 *  for a specific effect rather than for raw stat. */
export function legionUtilitySquares(): readonly ClassRecord[] {
  return CLASSES.filter((c) => c.legion.unit !== "flat" || c.legion.stat === null);
}

/* ============================================================================
 * CREW HELPERS
 * ==========================================================================*/

/** Classes sorted by innate crit rate. The practical rule this supports: a
 *  40%-or-below class is where Phantom (+20%), Explorer Archer (+15%) and Lynn
 *  (+10%) links earn their slot; an 85-94% class should spend those slots on
 *  damage instead. */
export function byInnateCrit(direction: "asc" | "desc" = "desc"): readonly ClassRecord[] {
  const s = [...CLASSES].sort((a, b) => b.innateCritRate.value - a.innateCritRate.value);
  return direction === "asc" ? s.reverse() : s;
}

/** Every class that breaks the normal main/secondary stat assumption, with the
 *  reason. A gearing engine must special-case all of these. */
export function statExceptions(): readonly { classId: string; what: string; why: string }[] {
  return CLASS_DATA.statExceptions;
}

/** Link stacking groups (Explorer archetypes x3, Cygnus x5, Resistance x4) with
 *  their members, so "is a fourth Explorer Archer worth levelling" is a lookup
 *  rather than a guess. The marginal link value of one past the cap is zero. */
export function linkStackGroups(): { group: string; max: number; members: readonly ClassRecord[]; note: string }[] {
  const byGroup = new Map<string, { max: number; note: string; members: ClassRecord[] }>();
  for (const c of CLASSES) {
    const s = c.linkSkill.stacks;
    if (!s) continue;
    const hit = byGroup.get(s.group);
    if (hit) hit.members.push(c);
    else byGroup.set(s.group, { max: s.max, note: s.note, members: [c] });
  }
  return [...byGroup.entries()].map(([group, v]) => ({
    group, max: v.max, note: v.note, members: v.members,
  }));
}

/* ============================================================================
 * INTEGRITY
 * ==========================================================================*/

export interface IntegrityProblem {
  readonly where: string;
  readonly problem: string;
}

/** What the TypeScript cast on the JSON import cannot check. Cheap enough to
 *  call from a test or a verifier; it allocates nothing that matters. */
export function assertRosterIntegrity(): readonly IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];
  const seenIds = new Set<string>();
  const seenMonograms = new Set<string>();
  const branchIds = new Set(BRANCHES.map((b) => b.id));
  const archetypeIds = new Set(ARCHETYPES.map((a) => a.id));

  for (const c of CLASSES) {
    if (seenIds.has(c.id)) problems.push({ where: c.name, problem: `duplicate class id "${c.id}"` });
    seenIds.add(c.id);
    if (c.id !== classKey(c.name)) {
      problems.push({ where: c.name, problem: `id "${c.id}" is not classKey(name) — the join to lib/damage.ts will silently miss` });
    }
    if (seenMonograms.has(c.mark.monogram)) {
      problems.push({ where: c.name, problem: `monogram "${c.mark.monogram}" is not unique — two classes would render identically` });
    }
    seenMonograms.add(c.mark.monogram);
    if (!branchIds.has(c.branch)) problems.push({ where: c.name, problem: `unknown branch "${c.branch}"` });
    if (!archetypeIds.has(c.archetype) && c.archetype !== "thief and pirate") {
      problems.push({ where: c.name, problem: `unknown archetype "${c.archetype}"` });
    }
    if (c.guide && !CLASS_DATA.guides[c.guide]) {
      problems.push({ where: c.name, problem: `points at guide "${c.guide}" which does not exist` });
    }
    if (!c.guide && c.completeness === "reference") {
      problems.push({ where: c.name, problem: `completeness "reference" with no guide attached` });
    }
    if (c.linkSkill.name === null && !c.linkSkill.nameCandidates) {
      problems.push({ where: c.name, problem: `link skill has no name and no candidates — nothing to render` });
    }
    if (!isUnverified(c.linkSkill) && c.linkSkill.name === null) {
      problems.push({ where: c.name, problem: `link skill name is null but the record is not marked UNVERIFIED` });
    }
  }

  if (CLASSES.length !== CLASS_META.classCount) {
    problems.push({ where: "meta", problem: `classCount ${CLASS_META.classCount} but ${CLASSES.length} classes present` });
  }

  for (const g of writtenGuides()) {
    if (!BY_ID.has(g.classId)) problems.push({ where: `guide ${g.classId}`, problem: "guide has no matching class" });
    for (const s of g.skills) {
      for (const e of s.effects) {
        if (e.from && !damageConstant(e.from)) {
          problems.push({ where: `guide ${g.classId} / ${s.name}`, problem: `effect points at unknown lib/damage.ts path "${e.from}"` });
        }
      }
    }
  }
  return problems;
}
