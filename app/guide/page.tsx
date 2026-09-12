import type { Metadata } from "next";
import graph from "@/data/guide-graph.json";
import patchesRaw from "@/data/patches.json";
import {
  BRANCHES,
  CLASSES,
  CLASS_META,
  assertRosterIntegrity,
  byInnateCrit,
  classesByBranch,
  classesMissingFromLinkEffect,
  coverage,
  findClass,
  guideStatus,
  isUnverified,
  legionCrossCheck,
  legionUtilitySquares,
  linkEffectText,
  linkStackGroups,
  markFor,
  resolveLegacyName,
  statExceptions,
  unverifiedReason,
  verificationState,
  type Branch,
  type ClassRecord,
} from "@/lib/classes";

/* ── class-guide research files ────────────────────────────────────────────────
 * All 54 files, statically imported so the bundler sees every one of them. Only
 * the SELECTED guide's endgame sections render: the five endgame sections across
 * the written files are three quarters of a megabyte of claims, which is not one
 * page's worth of HTML. Everything else about every file — the written flag, the
 * blockedReason, the contest state, the source counts — renders unconditionally,
 * because that is the part that has to be visible to be honest.
 * ---------------------------------------------------------------------------*/
import gAdele from "@/data/class-guides/adele.json";
import gAngelicBuster from "@/data/class-guides/angelic-buster.json";
import gAran from "@/data/class-guides/aran.json";
import gArchMageFp from "@/data/class-guides/arch-mage-fp.json";
import gArchMageIl from "@/data/class-guides/arch-mage-il.json";
import gArk from "@/data/class-guides/ark.json";
import gBattleMage from "@/data/class-guides/battle-mage.json";
import gBeastTamer from "@/data/class-guides/beast-tamer.json";
import gBishop from "@/data/class-guides/bishop.json";
import gBladeMaster from "@/data/class-guides/blade-master.json";
import gBlaster from "@/data/class-guides/blaster.json";
import gBlazeWizard from "@/data/class-guides/blaze-wizard.json";
import gBowMaster from "@/data/class-guides/bow-master.json";
import gBuccaneer from "@/data/class-guides/buccaneer.json";
import gCadena from "@/data/class-guides/cadena.json";
import gCannoneer from "@/data/class-guides/cannoneer.json";
import gCorsair from "@/data/class-guides/corsair.json";
import gDarkKnight from "@/data/class-guides/dark-knight.json";
import gDawnWarrior from "@/data/class-guides/dawn-warrior.json";
import gDemonAvenger from "@/data/class-guides/demon-avenger.json";
import gDemonSlayer from "@/data/class-guides/demon-slayer.json";
import gDualBlade from "@/data/class-guides/dual-blade.json";
import gErelLight from "@/data/class-guides/erel-light.json";
import gEvan from "@/data/class-guides/evan.json";
import gHayato from "@/data/class-guides/hayato.json";
import gHero from "@/data/class-guides/hero.json";
import gHoyoung from "@/data/class-guides/hoyoung.json";
import gIllium from "@/data/class-guides/illium.json";
import gKain from "@/data/class-guides/kain.json";
import gKaiser from "@/data/class-guides/kaiser.json";
import gKanna from "@/data/class-guides/kanna.json";
import gKhali from "@/data/class-guides/khali.json";
import gKinesis from "@/data/class-guides/kinesis.json";
import gLara from "@/data/class-guides/lara.json";
import gLuminous from "@/data/class-guides/luminous.json";
import gLynn from "@/data/class-guides/lynn.json";
import gMarksman from "@/data/class-guides/marksman.json";
import gMechanic from "@/data/class-guides/mechanic.json";
import gMercedes from "@/data/class-guides/mercedes.json";
import gMihile from "@/data/class-guides/mihile.json";
import gMoXuan from "@/data/class-guides/mo-xuan.json";
import gNightLord from "@/data/class-guides/night-lord.json";
import gNightWalker from "@/data/class-guides/night-walker.json";
import gPaladin from "@/data/class-guides/paladin.json";
import gPathfinder from "@/data/class-guides/pathfinder.json";
import gPhantom from "@/data/class-guides/phantom.json";
import gShade from "@/data/class-guides/shade.json";
import gShadower from "@/data/class-guides/shadower.json";
import gSiaAstelle from "@/data/class-guides/sia-astelle.json";
import gThunderBreaker from "@/data/class-guides/thunder-breaker.json";
import gWildHunter from "@/data/class-guides/wild-hunter.json";
import gWindArcher from "@/data/class-guides/wind-archer.json";
import gXenon from "@/data/class-guides/xenon.json";
import gZero from "@/data/class-guides/zero.json";
import contestSummary from "@/data/class-guides/_contest-summary.json";

export const metadata: Metadata = {
  title: "Class reference — Maple Planner",
  description:
    "All 53 GMS classes with sourced branch, stats, weapon, weapon multiplier, innate crit rate, Legion ladder and link skill; the written class guides with their source counts; and the v.271 patch ledger kept separate from the KMS-ahead layer.",
};

/* ============================================================================
 * TYPES
 *
 * Loose on purpose. The 54 research files do not share one schema — a shape
 * survey of the five endgame sections found nine distinct vMatrix shapes alone.
 * What they DO share is a citation envelope: sources, sourceCount, consensus,
 * verifiedAt. So the renderer below walks whatever structure is present and
 * lifts that envelope out of it, rather than asserting a shape the files do not
 * have and silently dropping everything that differs.
 * ==========================================================================*/

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

interface SourceEntry {
  readonly url?: string;
  readonly what?: string;
  readonly dated?: string;
  readonly independent?: boolean | string;
  readonly independenceNote?: string;
}

interface GuideFile {
  readonly slug: string;
  readonly className: string;
  readonly branch?: string;
  readonly archetype?: string | null;
  /** The authority on whether this file may render as guidance. */
  readonly written?: boolean;
  readonly blockedReason?: string;
  /** Only present on files for classes that are not live in GMS. */
  readonly exists?: boolean;
  readonly status?: string;
  readonly statusSummary?: string;
  readonly successorClass?: string;
  readonly consensusLevel?: string;
  readonly lastVerified?: string;
  readonly patchVersion?: string;
  readonly sources?: readonly SourceEntry[];
  readonly conflicts?: readonly Json[];
  readonly gaps?: readonly string[];
  readonly contest?: {
    readonly ranAt?: string;
    readonly method?: string;
    readonly defects?: readonly Json[];
    readonly resolved?: readonly Json[];
    readonly clearedOnInspection?: readonly Json[];
    readonly shipReady?: boolean;
  };
  readonly gearingNotes?: Json;
  readonly commonMistakes?: Json;
  readonly vMatrix?: Json;
  readonly hexa?: Json;
  readonly hyperStats?: Json;
  readonly hyperSkills?: Json;
  readonly innerAbility?: Json;
}

interface PatchChange {
  readonly area: string;
  readonly region: string;
  readonly status: string;
  readonly corroborated: boolean;
  readonly summary: string;
  readonly detail: string;
  readonly classes?: string;
  readonly source: string;
  readonly route: string;
  readonly corroboratedBy?: string;
  readonly caveat?: string;
  readonly scopeNote?: string;
  readonly repoImpact?: string;
  readonly economics?: Json;
  readonly values?: Json;
  readonly qol?: Json;
  readonly bands?: Json;
}

interface PerClassRetune {
  readonly classId: string;
  readonly patchNotesName: string;
  readonly commonCoreRetune: Json;
  readonly notable: string | null;
}

interface LivePatch {
  readonly version: string;
  readonly name: string;
  readonly region: string;
  readonly status: string;
  readonly dated: Record<string, Json>;
  readonly source: string;
  readonly route: string;
  readonly liveConfirmation?: string;
  readonly corroboration?: Record<string, string>;
  readonly classBalance?: {
    readonly shape: string;
    readonly oldSharedBaselinesPercent: Record<string, number>;
    readonly classesListed: number;
    readonly rosterMatch: string;
    readonly unitNote: string;
    readonly perClass: readonly PerClassRetune[];
    readonly solHecate: {
      readonly scope: string;
      readonly note: string;
      readonly changes: readonly { skill: string; from: number; to: number }[];
    };
  };
  readonly changes: readonly PatchChange[];
  readonly negativeFindings: readonly PatchChange[];
  readonly rosterImpact?: Record<string, Json>;
}

interface UpcomingItem {
  readonly id: string;
  readonly region: string;
  readonly status: string;
  readonly kmsShipped: boolean;
  readonly kmsState: string;
  readonly dated: string;
  readonly area: string;
  readonly korea: string;
  readonly gms: string;
  readonly alterationRisk: string;
  readonly source: string;
  readonly route: string;
  readonly corroborated: boolean;
  readonly themes?: readonly string[];
  readonly notableClasses?: Json;
  readonly communityDirectional?: Json;
  readonly seeAlso?: Json;
}

interface PatchesFile {
  readonly meta: {
    readonly title: string;
    readonly purpose: string;
    readonly builtOn: string;
    readonly gmsCurrentVersion: string;
    readonly worldAssumption: string;
    readonly hardRule: string;
    readonly fieldContract: Record<string, string>;
    readonly layers: Record<string, string>;
  };
  readonly live: {
    readonly region: string;
    readonly currentVersion: string;
    readonly patches: readonly LivePatch[];
  };
  readonly upcoming: {
    readonly region: string;
    readonly readOn: string;
    readonly standingWarning: string;
    readonly regionState: Record<string, string>;
    readonly items: readonly UpcomingItem[];
  };
  readonly negativeConstraints: readonly {
    readonly id: string;
    readonly claimNotTrueOfGms: string;
    readonly whySomeoneWouldAddIt: string;
    readonly truth: string;
    readonly doNot: string;
    readonly source?: string;
    readonly gmsCheckSource?: string;
    readonly dated?: string;
  }[];
  readonly unresolved: readonly {
    readonly id: string;
    readonly question: string;
    readonly state: string;
    readonly nextStep: string;
    readonly region?: string;
    readonly source?: string;
    readonly dated?: string;
  }[];
}

interface GraphNode {
  readonly id: string;
  readonly tab: string;
  readonly title: string;
  readonly type: string;
  readonly headers?: readonly string[];
  readonly rows: readonly (readonly string[] | string)[];
  readonly notes?: string;
  readonly source: string;
  readonly lastVerified: string;
  readonly patchVersion: string;
}
interface GraphTab {
  readonly id: string;
  readonly name: string;
  readonly order: number;
}

/* ============================================================================
 * THE DATA
 * ==========================================================================*/

const PATCHES = patchesRaw as unknown as PatchesFile;

const GUIDE_FILES = [
  gAdele, gAngelicBuster, gAran, gArchMageFp, gArchMageIl, gArk, gBattleMage,
  gBeastTamer, gBishop, gBladeMaster, gBlaster, gBlazeWizard, gBowMaster,
  gBuccaneer, gCadena, gCannoneer, gCorsair, gDarkKnight, gDawnWarrior,
  gDemonAvenger, gDemonSlayer, gDualBlade, gErelLight, gEvan, gHayato, gHero,
  gHoyoung, gIllium, gKain, gKaiser, gKanna, gKhali, gKinesis, gLara, gLuminous,
  gLynn, gMarksman, gMechanic, gMercedes, gMihile, gMoXuan, gNightLord,
  gNightWalker, gPaladin, gPathfinder, gPhantom, gShade, gShadower, gSiaAstelle,
  gThunderBreaker, gWildHunter, gWindArcher, gXenon, gZero,
] as readonly unknown[] as readonly GuideFile[];

const CONTEST = contestSummary as {
  readonly ranAt: string;
  readonly defectsRecorded: number;
  readonly filesBlocked: readonly string[];
  readonly note: string;
};

/** The five endgame sections this page renders, in the order the files use. */
const ENDGAME_SECTIONS = [
  { key: "vMatrix", label: "V Matrix — 5th job" },
  { key: "hexa", label: "HEXA Matrix — 6th job" },
  { key: "hyperSkills", label: "Hyper skills" },
  { key: "hyperStats", label: "Hyper stats" },
  { key: "innerAbility", label: "Inner ability" },
] as const;

/* ── the guide-file ↔ roster join ─────────────────────────────────────────────
 * By className through findClass(), which already knows the aliases ("Arch Mage
 * (Fire/Poison)" and friends). Files that do not join are NOT guessed into
 * place — they are reported in the integrity section with the reason, because
 * a guide filed under the wrong class is worse than a guide nobody can find.
 * ---------------------------------------------------------------------------*/
type GuideState =
  | { readonly kind: "written"; readonly file: GuideFile }
  | { readonly kind: "blocked"; readonly file: GuideFile }
  | { readonly kind: "missing" };

const GUIDE_BY_CLASS = new Map<string, GuideFile>();
const UNJOINED: { file: GuideFile; why: string }[] = [];

for (const f of GUIDE_FILES) {
  const c = findClass(f.className);
  if (!c) {
    const legacy = resolveLegacyName(f.className);
    UNJOINED.push({
      file: f,
      why: legacy
        ? `No live roster class of this name. resolveLegacyName() reports status "${legacy.status}"` +
          (legacy.nowClass ? `, now ${legacy.nowClass.name}` : "") +
          `. ${legacy.note}`
        : "No roster class resolves from this className and it is not a known legacy name. Left unjoined rather " +
          "than attached to a guess — a guide filed under the wrong class is worse than one nobody can find.",
    });
    continue;
  }
  const prior = GUIDE_BY_CLASS.get(c.id);
  if (prior) {
    // Two files claim one class. Prefer the written one when exactly one is
    // written; otherwise keep the first. Never merge them, never average them.
    const keep =
      prior.written === true && f.written !== true
        ? prior
        : f.written === true && prior.written !== true
          ? f
          : prior;
    const drop = keep === prior ? f : prior;
    GUIDE_BY_CLASS.set(c.id, keep);
    UNJOINED.push({
      file: drop,
      why:
        `Two guide files resolve to ${c.name}: ${prior.slug}.json and ${f.slug}.json. ` +
        `Rendering ${keep.slug}.json (written: ${String(keep.written === true)}) and holding this one back. ` +
        "The duplicate is a data defect, not a rendering choice.",
    });
    continue;
  }
  GUIDE_BY_CLASS.set(c.id, f);
}

function guideStateFor(classId: string): GuideState {
  const f = GUIDE_BY_CLASS.get(classId);
  if (!f) return { kind: "missing" };
  return f.written === true ? { kind: "written", file: f } : { kind: "blocked", file: f };
}

const WRITTEN_CLASSES = CLASSES.filter((c) => guideStateFor(c.id).kind === "written");
const BLOCKED_CLASSES = CLASSES.filter((c) => guideStateFor(c.id).kind === "blocked");
const MISSING_CLASSES = CLASSES.filter((c) => guideStateFor(c.id).kind === "missing");

/** Every written guide that can be shown, whether or not it joins a roster
 *  class. A written file that does not join is still rendered — under its own
 *  file name, with the join failure stated — rather than being dropped or
 *  quietly filed under the class it probably means. */
interface Selectable {
  readonly file: GuideFile;
  readonly displayName: string;
  readonly classId: string | null;
  readonly unjoinedWhy: string | null;
}

const SELECTABLE: Selectable[] = [];
for (const c of WRITTEN_CLASSES) {
  const f = GUIDE_BY_CLASS.get(c.id);
  if (f) SELECTABLE.push({ file: f, displayName: c.name, classId: c.id, unjoinedWhy: null });
}
for (const u of UNJOINED) {
  if (u.file.written === true) {
    SELECTABLE.push({ file: u.file, displayName: u.file.className, classId: null, unjoinedWhy: u.why });
  }
}

const RETUNE_BY_CLASS = new Map<string, PerClassRetune>();
const V271 = PATCHES.live.patches.find((p) => p.version === PATCHES.live.currentVersion);
for (const p of V271?.classBalance?.perClass ?? []) RETUNE_BY_CLASS.set(p.classId, p);

/* ── claim census ─────────────────────────────────────────────────────────────
 * Counted from the files, never typed by hand. The distribution is the argument
 * for the pips: if 72% of claims carry exactly one source family and they all
 * render identically, the page is lying by uniformity.
 * ---------------------------------------------------------------------------*/
interface Census {
  total: number;
  zero: number;
  one: number;
  two: number;
  many: number;
  bytes: number;
}

function censusWalk(v: Json | undefined, out: Census): void {
  if (v === null || v === undefined || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) censusWalk(x, out);
    return;
  }
  const o = v as Record<string, Json>;
  if (typeof o.sourceCount === "number") {
    out.total += 1;
    if (o.sourceCount <= 0) out.zero += 1;
    else if (o.sourceCount === 1) out.one += 1;
    else if (o.sourceCount === 2) out.two += 1;
    else out.many += 1;
  }
  for (const k of Object.keys(o)) censusWalk(o[k], out);
}

const CENSUS: Census = (() => {
  const out: Census = { total: 0, zero: 0, one: 0, two: 0, many: 0, bytes: 0 };
  for (const f of GUIDE_FILES) {
    if (f.written !== true) continue;
    const rec = f as unknown as Record<string, Json | undefined>;
    for (const { key } of ENDGAME_SECTIONS) {
      censusWalk(rec[key], out);
      out.bytes += JSON.stringify(rec[key] ?? null).length;
    }
  }
  return out;
})();

/* ============================================================================
 * SMALL HELPERS
 * ==========================================================================*/

/** Fractions are the storage unit everywhere in lib/. Printed percent is a
 *  DISPLAY concern, and both halves are shown, so nobody reads 0.75 as 0.75%. */
function pctOf(fraction: number): string {
  const p = fraction * 100;
  return `${Number.isInteger(p) ? p : Math.round(p * 1000) / 1000}%`;
}

function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, "") : url;
}

/** strong | moderate | weak | none, taken from the first word of the label.
 *  The labels are frequently whole sentences ("moderate - membership is game
 *  data on three independent references..."), so the tier is derived for the
 *  chip and the full sentence is rendered next to it, never instead of it. */
function consensusTier(label: string): "strong" | "moderate" | "weak" | "none" {
  const l = label.trim().toLowerCase();
  if (l.startsWith("strong")) return "strong";
  if (l.startsWith("moderate")) return "moderate";
  if (l.startsWith("weak")) return "weak";
  return "none";
}

const CITE_KEYS = new Set([
  "sources", "sourceCount", "consensus", "verifiedAt",
  "notesSources", "notesVerifiedAt", "sourcesNote", "sourceNote",
  "sourceCountNote", "consensusNote", "consensusWhy", "consensusReason",
  "sourceLabels", "reVerifiedAt",
]);

const CITE_NOTE_KEYS = [
  "consensusNote", "consensusWhy", "consensusReason",
  "sourceCountNote", "sourcesNote", "sourceNote",
] as const;

const TITLE_KEYS: readonly string[] = [
  "node", "step", "item", "line", "name", "skill", "stat", "trio", "pick",
  "slot", "core", "claim", "verifiedClaim", "what", "topic", "mistake", "goal",
  "role", "group", "preset", "label", "nodeType", "case", "when", "id",
];

const TAG_KEYS: readonly string[] = ["tier", "quality", "status", "verdict", "rank", "level", "targetLevel"];

const MUTED_KEY = /^(why|note|notes|rationale|detail|caveat|.*Note|.*Reason|.*Why)$/;

function isPlain(v: Json): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function toSourceList(v: Json | undefined): SourceEntry[] {
  if (!Array.isArray(v)) return [];
  const out: SourceEntry[] = [];
  for (const s of v) {
    if (typeof s === "string") {
      out.push(isUrl(s) ? { url: s } : { what: s });
    } else if (s && typeof s === "object" && !Array.isArray(s)) {
      const o = s as Record<string, Json>;
      out.push({
        url: typeof o.url === "string" ? o.url : undefined,
        what: typeof o.what === "string" ? o.what : undefined,
        dated: typeof o.dated === "string" ? o.dated : undefined,
        independent:
          typeof o.independent === "boolean" || typeof o.independent === "string" ? o.independent : undefined,
        independenceNote: typeof o.independenceNote === "string" ? o.independenceNote : undefined,
      });
    }
  }
  return out;
}

/* ============================================================================
 * VERIFICATION CHROME
 * ==========================================================================*/

/** Source count as filled pips. A one-source claim must not look like a
 *  three-source claim; this is the whole mechanism for that. */
function Pips({ n }: { n: number }) {
  const tier = n <= 0 ? "zero" : n === 1 ? "one" : n === 2 ? "two" : "many";
  const shown = Math.min(Math.max(n, 0), 4);
  return (
    <span className={`g-pips ${tier}`} title={`${n} independent source ${n === 1 ? "family" : "families"}`}>
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={i < shown ? "on" : undefined} />
      ))}
      <b className="mono">{n}</b>
    </span>
  );
}

function StateBadge({ v }: { v: { source: string; patchVersion: string } }) {
  const state = verificationState(v);
  const label =
    state === "verified" ? `verified ${v.patchVersion}` : state === "stale" ? `stale ${v.patchVersion}` : "unverified";
  return <span className={`g-state ${state}`}>{label}</span>;
}

/** The citation envelope, lifted out of any claim object that carries one. */
function Cite({ o }: { o: Record<string, Json> }) {
  const n = typeof o.sourceCount === "number" ? o.sourceCount : null;
  const consensus = typeof o.consensus === "string" ? o.consensus : null;
  const verifiedAt =
    typeof o.verifiedAt === "string" ? o.verifiedAt : typeof o.notesVerifiedAt === "string" ? o.notesVerifiedAt : null;
  const srcs = toSourceList(o.sources ?? o.notesSources ?? undefined);
  const notes = CITE_NOTE_KEYS.filter((k) => typeof o[k] === "string").map((k) => [k, o[k] as string] as const);

  if (n === null && !consensus && !verifiedAt && srcs.length === 0 && notes.length === 0) return null;

  const tier = consensus ? consensusTier(consensus) : null;
  const firstClause = consensus ? consensus.split(/\s+[-–—]\s+/)[0].split(/,\s/)[0] : null;
  const chip = firstClause && firstClause.length <= 24 ? firstClause : tier;

  return (
    <div className="g-cite">
      <div className="g-cite-row">
        {n !== null ? <Pips n={n} /> : <span className="g-state unverified">no source count</span>}
        {tier && <span className={`g-cons ${tier}`}>{chip}</span>}
        {verifiedAt && <span className="mono g-dim">read {verifiedAt}</span>}
      </div>
      {(srcs.length > 0 || notes.length > 0 || (consensus && chip !== consensus)) && (
        <details className="g-det">
          <summary>
            {srcs.length > 0 ? `${srcs.length} cited source${srcs.length === 1 ? "" : "s"}` : "citation notes"}
          </summary>
          <div className="g-det-body">
            {consensus && chip !== consensus && <p className="g-p g-dim">{consensus}</p>}
            {srcs.length > 0 && (
              <ol className="g-srcs">
                {srcs.map((s, i) => (
                  <li key={i}>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {hostOf(s.url)}
                      </a>
                    ) : (
                      <span className="g-dim">{s.what ?? "unnamed source"}</span>
                    )}
                    {s.url && s.what ? <span className="g-dim"> — {s.what}</span> : null}
                    {s.dated ? <span className="mono g-dim"> · {s.dated}</span> : null}
                    {s.independent !== undefined ? (
                      <span className={`g-indep ${s.independent === true ? "yes" : "no"}`}>
                        {s.independent === true
                          ? "independent"
                          : typeof s.independent === "string"
                            ? s.independent
                            : "not independent"}
                      </span>
                    ) : null}
                    {s.independenceNote ? <span className="g-dim"> {s.independenceNote}</span> : null}
                  </li>
                ))}
              </ol>
            )}
            {notes.map(([k, v]) => (
              <p key={k} className="g-p g-dim">
                <span className="mono g-keytag">{humanize(k)}</span> {v}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/* ============================================================================
 * THE GENERIC CLAIM RENDERER
 *
 * Walks whatever structure is present, lifts the citation envelope into Cite,
 * and renders the remainder as labelled rows. A JSON null renders as an
 * explicit "no value recorded" and never as a blank or a zero: in
 * classBalance.perClass a null means "the official page listed no line for that
 * skill", which is a finding, not the absence of one.
 * ==========================================================================*/

function Val({ v, depth }: { v: Json; depth: number }) {
  if (v === null) return <span className="g-null mono">no value recorded</span>;
  if (typeof v === "boolean") return <span className="mono">{v ? "yes" : "no"}</span>;
  if (typeof v === "number") return <span className="mono g-num">{v}</span>;
  if (typeof v === "string") {
    if (isUrl(v)) {
      return (
        <a href={v} target="_blank" rel="noopener noreferrer">
          {hostOf(v)}
        </a>
      );
    }
    return <span>{v}</span>;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="g-null mono">empty</span>;
    if (v.every(isPlain)) {
      return (
        <ul className="g-bul">
          {v.map((x, i) => (
            <li key={i}>
              <Val v={x} depth={depth + 1} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <div className="g-claims">
        {v.map((x, i) => (
          <Val key={i} v={x} depth={depth + 1} />
        ))}
      </div>
    );
  }
  return <Claim o={v as Record<string, Json>} depth={depth} />;
}

function Claim({ o, depth }: { o: Record<string, Json>; depth: number }) {
  const keys = Object.keys(o).filter((k) => !CITE_KEYS.has(k));
  const titleKey: string | undefined = TITLE_KEYS.find((k) => keys.includes(k) && isPlain(o[k]));
  const tagKeys = TAG_KEYS.filter((k) => k !== titleKey && keys.includes(k) && isPlain(o[k]));
  const bodyKeys = keys.filter((k) => k !== titleKey && !tagKeys.includes(k));
  const hasHead = Boolean(titleKey) || tagKeys.length > 0;

  return (
    <div className={`g-claim d${Math.min(depth, 4)}`}>
      {hasHead && (
        <div className="g-claim-head">
          {titleKey && <span className="g-claim-title">{String(o[titleKey])}</span>}
          {tagKeys.map((k) => (
            <span key={k} className="g-chip">
              <span className="g-chip-k">{humanize(k)}</span>
              {String(o[k])}
            </span>
          ))}
        </div>
      )}
      <Cite o={o} />
      {bodyKeys.map((k) => {
        const val = o[k];
        const muted = MUTED_KEY.test(k);
        if (val === null || isPlain(val)) {
          return (
            <p key={k} className={muted ? "g-kv g-dim" : "g-kv"}>
              <span className="mono g-keytag">{humanize(k)}</span> <Val v={val} depth={depth + 1} />
            </p>
          );
        }
        return (
          <div key={k} className="g-kvblock">
            <div className="mono g-keytag">{humanize(k)}</div>
            <Val v={val} depth={depth + 1} />
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * ROSTER
 * ==========================================================================*/

function ClassCard({ c }: { c: ClassRecord }) {
  const mark =
    markFor(c.id) ?? {
      monogram: c.mark.monogram,
      hex: "#9dabc7",
      cssVar: "--branch-other",
      branchName: c.branch,
      colorIsADesignDecision: "",
    };
  const wm = c.weaponMultiplier;
  const retune = RETUNE_BY_CLASS.get(c.id);
  const gs = guideStateFor(c.id);
  const link = linkEffectText(c.id);

  return (
    <article className="card g-cc" id={`class-${c.id}`}>
      <div className="g-cc-head">
        <span
          className="g-mark"
          style={{ color: mark.hex, background: `${mark.hex}1c`, borderColor: `${mark.hex}66` }}
          aria-hidden="true"
        >
          {mark.monogram}
        </span>
        <div className="g-cc-id">
          <h3>{c.name}</h3>
          <p className="mono g-dim">
            {mark.branchName} · {c.archetype} · {c.primaryStat}
            {c.secondaryStat ? ` / ${c.secondaryStat}` : ""}
          </p>
        </div>
        <StateBadge v={c} />
      </div>

      <dl className="g-dl">
        <div>
          <dt>Weapon</dt>
          <dd>
            {c.weapon}
            {c.secondaryWeapon ? <span className="g-dim"> + {c.secondaryWeapon}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Weapon mult.</dt>
          <dd>
            {wm.value !== null ? (
              <span className="mono g-num">{wm.value}×</span>
            ) : wm.variants ? (
              <span className="mono g-num">
                {Object.entries(wm.variants)
                  .map(([k, v]) => `${k} ${v}×`)
                  .join(" · ")}
              </span>
            ) : (
              <span className="g-null mono">not sourced</span>
            )}
            {wm.note ? <span className="g-dim g-tiny"> {wm.note}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Innate crit rate</dt>
          <dd>
            <span className="mono g-num">{pctOf(c.innateCritRate.value)}</span>{" "}
            <span className="mono g-dim g-tiny">stored {c.innateCritRate.value}</span>
            {c.innateCritRate.note ? <span className="g-dim g-tiny"> {c.innateCritRate.note}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Innate crit dmg</dt>
          <dd>
            {c.innateCritDamage.value !== null ? (
              <>
                <span className="mono g-num">{pctOf(c.innateCritDamage.value)}</span>{" "}
                <span className="mono g-dim g-tiny">stored {c.innateCritDamage.value}</span>
              </>
            ) : (
              <span className="g-null mono">not sourced</span>
            )}
            {c.innateCritDamage.note ? <span className="g-dim g-tiny"> {c.innateCritDamage.note}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Legion square</dt>
          <dd>
            <span className="mono g-num">{c.legion.effect}</span>
            <span className="g-dim g-tiny">
              {" "}
              {c.legion.unit}
              {c.legion.stat ? ` · ${c.legion.stat}` : " · not a stat ladder"}
            </span>
          </dd>
        </div>
        <div>
          <dt>Link skill</dt>
          <dd>
            {link ? <span>{link}</span> : <span className="g-null mono">no sourced link line</span>}
            {c.linkSkill.name === null && c.linkSkill.nameCandidates ? (
              <span className="g-dim g-tiny"> No name is printed: the sources disagree on it.</span>
            ) : null}
            {isUnverified(c.linkSkill) ? (
              <span className="g-dim g-tiny"> UNVERIFIED — {unverifiedReason(c.linkSkill)}</span>
            ) : null}
          </dd>
        </div>
        {c.exceptions.length > 0 && (
          <div>
            <dt>Exceptions</dt>
            <dd>
              <ul className="g-bul">
                {c.exceptions.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>

      {retune && (
        <details className="g-det">
          <summary>{PATCHES.live.currentVersion} common-core retune</summary>
          <div className="g-det-body">
            {retune.notable && <p className="g-p">{retune.notable}</p>}
            <Val v={retune.commonCoreRetune} depth={1} />
          </div>
        </details>
      )}

      <div className="g-cc-foot">
        {gs.kind === "written" ? (
          <a className="g-gchip written" href={`?class=${gs.file.slug}#guide`}>
            guide written — open
          </a>
        ) : gs.kind === "blocked" ? (
          <a className="g-gchip blocked" href={`#blocked-${c.id}`}>
            guide not shippable
          </a>
        ) : (
          <a className="g-gchip none" href={`#blocked-${c.id}`}>
            no guide research file
          </a>
        )}
        {isUrl(c.source) ? (
          <a className="mono g-dim g-tiny" href={c.source} target="_blank" rel="noopener noreferrer">
            {hostOf(c.source)}
          </a>
        ) : (
          <span className="mono g-dim g-tiny">{c.source}</span>
        )}
        {c.lastVerified ? <span className="mono g-dim g-tiny">read {c.lastVerified}</span> : null}
        <span className="mono g-dim g-tiny">{c.claimType}</span>
      </div>
    </article>
  );
}

function BranchBlock({ branch, classes }: { branch: Branch; classes: readonly ClassRecord[] }) {
  if (classes.length === 0) return null;
  return (
    <section className="g-branch" id={`branch-${branch.id}`}>
      <h3 className="g-branch-h">
        <span className="g-swatch" style={{ background: branch.color.hex }} aria-hidden="true" />
        {branch.name}
        <span className="mono g-dim">
          {classes.length} class{classes.length === 1 ? "" : "es"}
        </span>
        <span className="mono g-dim g-tiny">
          {branch.color.hex} · {branch.color.cssVar}
        </span>
      </h3>
      <div className="g-grid">
        {classes.map((c) => (
          <ClassCard key={c.id} c={c} />
        ))}
      </div>
    </section>
  );
}

/* ============================================================================
 * GUIDES
 * ==========================================================================*/

function GuideHeader({ file, displayName }: { file: GuideFile; displayName: string }) {
  const contest = file.contest;
  const shipReady = contest?.shipReady;
  const srcs = file.sources ?? [];
  const independent = srcs.filter((s) => s.independent === true).length;
  const openDefects = contest?.defects?.length ?? 0;

  return (
    <div className="g-gh">
      <div className="g-gh-top">
        <h3>{displayName}</h3>
        <span className="mono g-dim">{file.slug}.json</span>
        <span className="g-state verified">written</span>
        {shipReady === false && (
          <span className="g-state unverified">
            contest: not ship-ready — {openDefects} open defect{openDefects === 1 ? "" : "s"}
          </span>
        )}
        {file.patchVersion ? <span className="mono g-dim">{file.patchVersion}</span> : null}
        {file.lastVerified ? <span className="mono g-dim">read {file.lastVerified}</span> : null}
      </div>

      {file.consensusLevel && (
        <p className="g-p">
          <span className={`g-cons ${consensusTier(file.consensusLevel)}`}>{consensusTier(file.consensusLevel)}</span>{" "}
          <span className="g-dim">{file.consensusLevel}</span>
        </p>
      )}

      {typeof file.archetype === "string" && file.archetype.length > 0 ? (
        <p className="g-p">{file.archetype}</p>
      ) : null}

      <div className="g-gh-strip">
        <span className="mono g-dim">
          {srcs.length} file-level source{srcs.length === 1 ? "" : "s"} · {independent} marked independent
        </span>
        {file.conflicts?.length ? (
          <span className="mono g-dim">
            {file.conflicts.length} recorded conflict{file.conflicts.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {file.gaps?.length ? <span className="mono g-dim">{file.gaps.length} declared gaps</span> : null}
      </div>

      {shipReady === false && contest?.defects?.length ? (
        <div className="g-warn">
          <p className="g-p">
            <b>This file is marked written, but its own contest pass is not satisfied.</b> The open defects are below
            in the file&apos;s own words. Read them before acting on anything further down.
          </p>
          <Val v={contest.defects as Json[]} depth={1} />
        </div>
      ) : null}

      {srcs.length > 0 && (
        <details className="g-det">
          <summary>File-level sources</summary>
          <div className="g-det-body">
            <ol className="g-srcs">
              {srcs.map((s, i) => (
                <li key={i}>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {hostOf(s.url)}
                    </a>
                  ) : (
                    <span className="g-dim">unnamed source</span>
                  )}
                  {s.what ? <span className="g-dim"> — {s.what}</span> : null}
                  {s.dated ? <span className="mono g-dim"> · {s.dated}</span> : null}
                  <span className={`g-indep ${s.independent === true ? "yes" : "no"}`}>
                    {s.independent === true
                      ? "independent"
                      : typeof s.independent === "string"
                        ? s.independent
                        : "not independent"}
                  </span>
                  {s.independenceNote ? <span className="g-dim"> {s.independenceNote}</span> : null}
                </li>
              ))}
            </ol>
          </div>
        </details>
      )}

      {file.conflicts?.length ? (
        <details className="g-det">
          <summary>Recorded conflicts between sources</summary>
          <div className="g-det-body">
            <Val v={file.conflicts as Json[]} depth={1} />
          </div>
        </details>
      ) : null}

      {file.gaps?.length ? (
        <details className="g-det">
          <summary>Declared gaps</summary>
          <div className="g-det-body">
            <ul className="g-bul">
              {file.gaps.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}

      {contest ? (
        <details className="g-det">
          <summary>
            Contest pass{contest.ranAt ? ` — ${contest.ranAt}` : ""} · ship-ready {String(shipReady)}
          </summary>
          <div className="g-det-body">
            <Val v={contest as unknown as Json} depth={1} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function GuideBody({ file }: { file: GuideFile }) {
  const rec = file as unknown as Record<string, Json | undefined>;
  return (
    <div className="g-gb">
      {ENDGAME_SECTIONS.map(({ key, label }) => {
        const v = rec[key];
        return (
          <section key={key} className="g-esec">
            <h4 className="g-esec-h">{label}</h4>
            {v === undefined || v === null ? (
              <p className="g-empty">
                Nothing recorded for this section. That is the file&apos;s own state and not a rendering failure: no
                source published an order this file was willing to attribute, so it records none.
              </p>
            ) : (
              <Val v={v} depth={0} />
            )}
          </section>
        );
      })}

      {file.gearingNotes !== undefined && file.gearingNotes !== null && (
        <section className="g-esec">
          <h4 className="g-esec-h">Gearing notes</h4>
          <Val v={file.gearingNotes} depth={0} />
        </section>
      )}
      {file.commonMistakes !== undefined && file.commonMistakes !== null && (
        <section className="g-esec">
          <h4 className="g-esec-h">Common mistakes</h4>
          <Val v={file.commonMistakes} depth={0} />
        </section>
      )}
    </div>
  );
}

function EmptySlots({ classId }: { classId: string }) {
  const status = guideStatus(classId);
  if (!status) return null;
  return (
    <>
      <p className="mono g-dim g-tiny">
        guideStatus() section taxonomy — all {status.sections.length} slots unfilled
      </p>
      <div className="g-slots">
        {status.sections.map((s) => (
          <span key={s.id} className={s.required ? "g-slot req" : "g-slot"}>
            {s.label}
            {s.required ? <i>required</i> : null}
          </span>
        ))}
      </div>
    </>
  );
}

function BlockedCard({ cls, file }: { cls: ClassRecord; file: GuideFile }) {
  const status = guideStatus(cls.id);
  const mark = markFor(cls.id);
  const reason =
    file.blockedReason ??
    file.statusSummary ??
    (file.status
      ? `The file records status "${file.status}" and carries no blockedReason.`
      : "The file carries neither a blockedReason nor a status. Treated as unshippable because written is not true.");

  return (
    <article className="card g-bc" id={`blocked-${cls.id}`}>
      <div className="g-cc-head">
        {mark && (
          <span
            className="g-mark"
            style={{ color: mark.hex, background: `${mark.hex}1c`, borderColor: `${mark.hex}66` }}
            aria-hidden="true"
          >
            {mark.monogram}
          </span>
        )}
        <div className="g-cc-id">
          <h3>{cls.name}</h3>
          <p className="mono g-dim">
            {file.slug}.json · written: false
            {file.patchVersion ? ` · ${file.patchVersion}` : ""}
            {file.lastVerified ? ` · read ${file.lastVerified}` : ""}
          </p>
        </div>
        <span className="g-state unverified">not shippable</span>
      </div>

      <p className="g-p g-reason">
        <span className="mono g-keytag">blockedReason</span> {reason}
      </p>

      {file.exists === false && file.successorClass ? (
        <p className="g-p g-dim">
          <span className="mono g-keytag">not live in GMS</span> successor class: {file.successorClass}
        </p>
      ) : null}

      <EmptySlots classId={cls.id} />

      {status?.written ? (
        <p className="g-p g-warn-inline">
          <b>The two guide layers disagree about this class.</b> guideStatus() reports written: true from
          data/classes.json guides.{cls.guide}, while {file.slug}.json reports written: false. The stricter of the two
          wins: nothing from either is rendered as guidance until they agree.
        </p>
      ) : null}
    </article>
  );
}

/* ============================================================================
 * PATCH LEDGER
 * ==========================================================================*/

function ChangeCard({
  c,
  negative,
  sharedRoute,
}: {
  c: PatchChange;
  negative?: boolean;
  /** The parent patch's route. Identical on most changes, so it is printed
   *  once for the patch and only repeated here when a change differs. */
  sharedRoute?: string;
}) {
  const extras = (["economics", "values", "qol", "bands"] as const).filter(
    (k) => c[k] !== undefined && c[k] !== null,
  );
  const routeDiffers = c.route !== sharedRoute;
  return (
    <article className={negative ? "g-chg neg" : "g-chg"}>
      <div className="g-chg-head">
        <span className="g-area mono">{c.area}</span>
        <span className={`g-corr ${c.corroborated ? "yes" : "no"}`}>
          {c.corroborated ? "corroborated" : "official page only"}
        </span>
        <span className="mono g-dim">
          {c.region} · {c.status}
        </span>
        {c.classes ? <span className="mono g-dim">classes: {c.classes}</span> : null}
      </div>
      <p className="g-chg-sum">{c.summary}</p>
      <p className="g-p">{c.detail}</p>
      {c.caveat ? (
        <p className="g-p g-dim">
          <span className="mono g-keytag">Caveat</span> {c.caveat}
        </p>
      ) : null}
      {c.scopeNote ? (
        <p className="g-p g-dim">
          <span className="mono g-keytag">Scope</span> {c.scopeNote}
        </p>
      ) : null}
      {c.repoImpact ? (
        <p className="g-p g-dim">
          <span className="mono g-keytag">Repo impact</span> {c.repoImpact}
        </p>
      ) : null}
      {extras.map((k) => (
        <div key={k} className="g-kvblock">
          <div className="mono g-keytag">{humanize(k)}</div>
          <Val v={c[k] as Json} depth={1} />
        </div>
      ))}
      <details className="g-det">
        <summary>Source{routeDiffers ? " and route" : ""}</summary>
        <div className="g-det-body">
          <p className="g-p">
            <a href={c.source} target="_blank" rel="noopener noreferrer">
              {hostOf(c.source)}
            </a>
          </p>
          {routeDiffers ? (
            <p className="g-p g-dim">{c.route}</p>
          ) : (
            <p className="g-p g-dim g-tiny">Read by the same route as the rest of this patch, printed once above.</p>
          )}
          {c.corroboratedBy ? (
            <p className="g-p g-dim">
              <span className="mono g-keytag">Corroborated by</span> {c.corroboratedBy}
            </p>
          ) : null}
        </div>
      </details>
    </article>
  );
}

function LivePatchBlock({ p }: { p: LivePatch }) {
  return (
    <section className="g-patch" id={`patch-${p.version.replace(/\W/g, "")}`}>
      <h3 className="g-patch-h">
        <span className="mono g-pv">{p.version}</span>
        {p.name}
        <span className="g-state verified">
          {p.region} · {p.status}
        </span>
      </h3>

      <div className="g-gh-strip">
        {Object.entries(p.dated).map(([k, v]) => (
          <span key={k} className="mono g-dim">
            {humanize(k)}: {Array.isArray(v) ? v.join(", ") : String(v)}
          </span>
        ))}
      </div>

      {p.liveConfirmation ? (
        <p className="g-p g-dim">
          <span className="mono g-keytag">Live confirmation</span> {p.liveConfirmation}
        </p>
      ) : null}

      <details className="g-det">
        <summary>How {p.version} was read</summary>
        <div className="g-det-body">
          <p className="g-p">
            <a href={p.source} target="_blank" rel="noopener noreferrer">
              {hostOf(p.source)}
            </a>
          </p>
          <p className="g-p g-dim">{p.route}</p>
        </div>
      </details>

      {p.classBalance && (
        <div className="g-cb">
          <h4 className="g-esec-h">Class balance — the shape of it</h4>
          <p className="g-p">{p.classBalance.shape}</p>
          <p className="g-p g-dim">{p.classBalance.rosterMatch}</p>
          <p className="g-p g-dim">{p.classBalance.unitNote}</p>
          <div className="g-tblwrap">
            <table className="gtable">
              <thead>
                <tr>
                  <th>Common-core skill</th>
                  <th>Old shared baseline, every class</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(p.classBalance.oldSharedBaselinesPercent).map(([k, v]) => (
                  <tr key={k}>
                    <td className="g-firstcol">{humanize(k)}</td>
                    <td className="mono">{v}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mono g-dim g-tiny">
            The per-class replacements for these baselines are on each class card in the roster below —{" "}
            {p.classBalance.perClass.length} of {p.classBalance.classesListed} listed classes joined to a roster
            record by classId.
          </p>

          <div className="g-warn">
            <p className="g-chg-sum">Sol Hecate — {p.classBalance.solHecate.scope}</p>
            <p className="g-p">{p.classBalance.solHecate.note}</p>
            <div className="g-tblwrap">
              <table className="gtable">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {p.classBalance.solHecate.changes.map((ch, i) => (
                    <tr key={i}>
                      <td className="g-firstcol">{ch.skill}</td>
                      <td className="mono">{ch.from}</td>
                      <td className="mono">{ch.to}</td>
                      <td className="mono g-down">{Math.round(((ch.to - ch.from) / ch.from) * 1000) / 10}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <h4 className="g-esec-h">
        What {p.version} changed — {p.changes.length} entries
      </h4>
      <div className="g-chgs">
        {p.changes.map((c, i) => (
          <ChangeCard key={i} c={c} sharedRoute={p.route} />
        ))}
      </div>

      {p.negativeFindings.length > 0 && (
        <>
          <h4 className="g-esec-h">
            What {p.version} did NOT change — {p.negativeFindings.length} negative findings
          </h4>
          <p className="g-p g-dim">
            A negative finding is a fact, and it is the half that stops a Korean headline being copied into a
            constant. Each one was read off the same page as the changes above.
          </p>
          <div className="g-chgs">
            {p.negativeFindings.map((c, i) => (
              <ChangeCard key={i} c={c} negative sharedRoute={p.route} />
            ))}
          </div>
        </>
      )}

      {p.rosterImpact ? (
        <details className="g-det">
          <summary>Roster impact — which data/classes.json fields {p.version} touches</summary>
          <div className="g-det-body">
            <Val v={p.rosterImpact as Json} depth={1} />
          </div>
        </details>
      ) : null}

      {p.corroboration ? (
        <details className="g-det">
          <summary>What corroborated means here</summary>
          <div className="g-det-body">
            <Val v={p.corroboration as unknown as Json} depth={1} />
          </div>
        </details>
      ) : null}
    </section>
  );
}

/* ============================================================================
 * PAGE
 * ==========================================================================*/

export default async function GuidePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const wanted = Array.isArray(sp.class) ? sp.class[0] : sp.class;

  const asked = wanted ? SELECTABLE.find((s) => s.file.slug === wanted) : undefined;
  const selected = asked ?? SELECTABLE[0];

  const meta = graph.meta as Record<string, string>;
  const tabs = [...(graph.tabs as GraphTab[])].sort((a, b) => a.order - b.order);
  const nodes = graph.nodes as unknown as GraphNode[];
  const cur = meta.gameVersion;

  const cov = coverage();
  const integrity = assertRosterIntegrity();
  const mismatches = legionCrossCheck();
  const missingFromLegion = classesMissingFromLinkEffect();
  // Two guide layers exist and they are NOT the same kind of thing:
  //   data/classes.json  guides{}  — the worked ClassGuide schema, one entry.
  //   data/class-guides/*.json     — the research layer, 54 files.
  // A research file being written while classes.json has no ClassGuide is
  // layer COVERAGE, not a conflict. The only real conflict is the other
  // direction: classes.json claims a written guide while the research file for
  // the same class says it is not shippable. There the stricter source wins.
  const strictBlocked = CLASSES.filter((c) => {
    const st = guideStatus(c.id);
    return Boolean(st?.written) && guideStateFor(c.id).kind !== "written";
  });
  const layerGap = CLASSES.filter((c) => {
    const st = guideStatus(c.id);
    return guideStateFor(c.id).kind === "written" && !st?.written;
  });
  const policyMessage = BLOCKED_CLASSES.map((c) => guideStatus(c.id)).find((s) => s && !s.written)?.message;
  const utility = legionUtilitySquares();
  const endgameKb = Math.round(CENSUS.bytes / 1024);

  return (
    <div className="g-wrap">
      <style>{CSS}</style>

      <header className="g-head">
        <h1>Class reference</h1>
        <p className="mono g-meta">
          {meta.gameVersionName} · patch {meta.patchDate} · {meta.region}, {meta.worldAssumption} ·{" "}
          <a href={meta.patchNotesUrl} target="_blank" rel="noopener noreferrer">
            patch notes
          </a>
        </p>
        <p className="g-claimline">
          {cov.classes} classes, every roster field sourced. {WRITTEN_CLASSES.length} class-guide research files are
          marked written and {BLOCKED_CLASSES.length + MISSING_CLASSES.length} classes have nothing shippable.{" "}
          {cov.linkSkillsNamed} of {cov.classes} link skills have a name the sources agree on.
        </p>
        <p className="g-p g-dim">
          Roster figures are stamped {CLASS_META.rosterPatchVersion} against a declared {CLASS_META.gameVersion}, so
          most of the roster reads <span className="g-state stale">stale</span> below. That is the honest state, not a
          defect: {CLASS_META.stalenessNote}
        </p>
        <p className="g-p g-dim g-tiny">
          No game art ships on this page, by design and for a stated legal reason. Every class mark is a monogram in a
          branch colour, and the branch colour is a MaplePlanner design decision rather than a game constant.
        </p>

        <nav className="g-nav">
          <a href="#patches">Patch ledger</a>
          <a href="#kms">Korea ahead</a>
          <a href="#roster">Roster ({cov.classes})</a>
          <a href="#crew">Crew tables</a>
          <a href="#guide">Written guides ({WRITTEN_CLASSES.length})</a>
          <a href="#blocked">Held back ({BLOCKED_CLASSES.length + MISSING_CLASSES.length})</a>
          <a href="#integrity">Integrity</a>
          <a href="#tables">Progression tables</a>
        </nav>
      </header>

      {/* ─────────── patch ledger: GMS live ─────────── */}
      <section className="g-sec" id="patches">
        <h2 className="g-sec-h">
          Patch ledger — GMS live
          <span className="mono g-dim">{PATCHES.live.currentVersion} current</span>
        </h2>
        <p className="g-p">{PATCHES.meta.purpose}</p>
        <div className="g-hardrule">
          <span className="mono g-keytag">Hard rule</span> {PATCHES.meta.hardRule}
        </div>
        {PATCHES.live.patches.map((p) => (
          <LivePatchBlock key={p.version} p={p} />
        ))}
      </section>

      {/* ─────────── patch ledger: KMS ahead ─────────── */}
      <section className="g-sec g-kmsblock" id="kms">
        <h2 className="g-sec-h">
          Korea is ahead — NOT IN GMS
          <span className="g-state unverified">{PATCHES.upcoming.region} · upcoming</span>
        </h2>
        <div className="g-kmswarn">
          <p className="g-p">
            <b>{PATCHES.upcoming.standingWarning}</b>
          </p>
          <p className="mono g-dim g-tiny">read {PATCHES.upcoming.readOn}</p>
        </div>

        <div className="g-gh-strip">
          {Object.entries(PATCHES.upcoming.regionState).map(([k, v]) => (
            <span key={k} className="mono g-dim">
              {humanize(k)}: {v}
            </span>
          ))}
        </div>

        <div className="g-chgs">
          {PATCHES.upcoming.items.map((it) => (
            <article key={it.id} className="g-chg kms">
              <div className="g-chg-head">
                <span className="g-area mono">{it.area}</span>
                <span className={`g-corr ${it.kmsShipped ? "yes" : "no"}`}>
                  {it.kmsShipped ? "shipped in KMS" : "not even KMS-live"}
                </span>
                <span className="g-state unverified">not in GMS</span>
                <span className="mono g-dim">{it.dated}</span>
              </div>
              <p className="g-chg-sum">Korea: {it.korea}</p>
              <p className="g-p">
                <span className="mono g-keytag">KMS state</span> {it.kmsState}
              </p>
              <p className="g-p g-gmsline">
                <span className="mono g-keytag">GMS</span> {it.gms}
              </p>
              <p className="g-p g-dim">
                <span className="mono g-keytag">Alteration risk</span> {it.alterationRisk}
              </p>
              {it.themes?.length ? (
                <details className="g-det">
                  <summary>{it.themes.length} themes reported in Korea</summary>
                  <div className="g-det-body">
                    <ul className="g-bul">
                      {it.themes.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </div>
                </details>
              ) : null}
              {(["notableClasses", "communityDirectional", "seeAlso"] as const)
                .filter((k) => it[k] !== undefined && it[k] !== null)
                .map((k) => (
                  <details key={k} className="g-det">
                    <summary>{humanize(k)}</summary>
                    <div className="g-det-body">
                      <Val v={it[k] as Json} depth={1} />
                    </div>
                  </details>
                ))}
              <details className="g-det">
                <summary>Source and route</summary>
                <div className="g-det-body">
                  <p className="g-p">
                    <a href={it.source} target="_blank" rel="noopener noreferrer">
                      {hostOf(it.source)}
                    </a>
                  </p>
                  <p className="g-p g-dim">{it.route}</p>
                </div>
              </details>
            </article>
          ))}
        </div>

        <h3 className="g-esec-h">Do not add these — {PATCHES.negativeConstraints.length} negative constraints</h3>
        <p className="g-p g-dim">{PATCHES.meta.layers.negativeConstraints}</p>
        <div className="g-chgs">
          {PATCHES.negativeConstraints.map((nc) => (
            <article key={nc.id} className="g-chg neg">
              <div className="g-chg-head">
                <span className="g-area mono">{nc.id}</span>
              </div>
              <p className="g-chg-sum">Not true of GMS: {nc.claimNotTrueOfGms}</p>
              <p className="g-p g-dim">
                <span className="mono g-keytag">Why someone would add it</span> {nc.whySomeoneWouldAddIt}
              </p>
              <p className="g-p">
                <span className="mono g-keytag">Truth</span> {nc.truth}
              </p>
              <p className="g-p g-donot">
                <span className="mono g-keytag">Do not</span> {nc.doNot}
              </p>
              <div className="g-gh-strip">
                {nc.source ? (
                  <a className="mono g-dim g-tiny" href={nc.source} target="_blank" rel="noopener noreferrer">
                    {hostOf(nc.source)}
                  </a>
                ) : null}
                {nc.gmsCheckSource ? (
                  <a className="mono g-dim g-tiny" href={nc.gmsCheckSource} target="_blank" rel="noopener noreferrer">
                    GMS check: {hostOf(nc.gmsCheckSource)}
                  </a>
                ) : null}
                {nc.dated ? <span className="mono g-dim g-tiny">{nc.dated}</span> : null}
              </div>
            </article>
          ))}
        </div>

        <details className="g-det">
          <summary>Honest unknowns — {PATCHES.unresolved.length} questions settled neither way</summary>
          <div className="g-det-body">
            <p className="g-p g-dim">{PATCHES.meta.layers.unresolved}</p>
            {PATCHES.unresolved.map((u) => (
              <div key={u.id} className="g-claim d1">
                <div className="g-claim-head">
                  <span className="g-claim-title">{u.question}</span>
                  <span className="mono g-dim">{u.id}</span>
                </div>
                <p className="g-kv">
                  <span className="mono g-keytag">State</span> {u.state}
                </p>
                <p className="g-kv g-dim">
                  <span className="mono g-keytag">Next step</span> {u.nextStep}
                </p>
              </div>
            ))}
          </div>
        </details>
      </section>

      {/* ─────────── roster ─────────── */}
      <section className="g-sec" id="roster">
        <h2 className="g-sec-h">
          Class roster
          <span className="mono g-dim">
            {cov.classes} classes · {BRANCHES.length} branches
          </span>
        </h2>
        <p className="g-p">
          Branch, stats, weapon, weapon multiplier, innate crit rate, Legion square and link skill — the part of the
          class work that is genuinely sourceable. Every field carries its own source, read date and patch stamp. Crit
          rate is stored as a fraction and both halves are printed, because a 0.75 read as 0.75% is how a gearing
          recommendation goes a hundred times wrong.
        </p>
        <p className="g-p g-dim">
          Innate crit rate and crit damage are from <b>passives only</b>. Legion, hyper stats, link skills and gear all
          stack on top, so these are a starting point for a gearing decision rather than a total.
          {V271?.classBalance ? ` Each card's ${PATCHES.live.currentVersion} retune block: ${V271.classBalance.unitNote}` : ""}
        </p>
        {classesByBranch().map(({ branch, classes }) => (
          <BranchBlock key={branch.id} branch={branch} classes={classes} />
        ))}
      </section>

      {/* ─────────── crew tables ─────────── */}
      <section className="g-sec" id="crew">
        <h2 className="g-sec-h">Crew tables</h2>

        <div className="card g-pad">
          <h3 className="g-esec-h">Innate crit rate ladder — passives only</h3>
          <p className="g-p g-dim">
            The highest-leverage single gearing number on the roster. A 40%-or-below class is where crit links earn
            their slot; an 85%-plus class should spend those slots on damage instead.
          </p>
          <div className="g-tblwrap">
            <table className="gtable">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Branch</th>
                  <th>Crit rate</th>
                  <th>Stored fraction</th>
                  <th>Verification</th>
                </tr>
              </thead>
              <tbody>
                {byInnateCrit("desc").map((c) => (
                  <tr key={c.id}>
                    <td className="g-firstcol">
                      <a href={`#class-${c.id}`}>{c.name}</a>
                    </td>
                    <td className="g-dim">{markFor(c.id)?.branchName ?? c.branch}</td>
                    <td className="mono">{pctOf(c.innateCritRate.value)}</td>
                    <td className="mono g-dim">{c.innateCritRate.value}</td>
                    <td>
                      <StateBadge v={c} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card g-pad">
          <h3 className="g-esec-h">Link stacking groups</h3>
          <p className="g-p g-dim">
            The marginal value of one past the cap is zero. These are the caps the roster actually records.
          </p>
          {linkStackGroups().map((g) => (
            <div key={g.group} className="g-claim d1">
              <div className="g-claim-head">
                <span className="g-claim-title">{g.group}</span>
                <span className="g-chip">
                  <span className="g-chip-k">Max</span>
                  {g.max}
                </span>
                <span className="mono g-dim">{g.members.length} on roster</span>
              </div>
              <p className="g-kv g-dim">{g.note}</p>
              <p className="g-kv">
                {g.members.map((m, i) => (
                  <span key={m.id}>
                    {i > 0 ? " · " : ""}
                    <a href={`#class-${m.id}`}>{m.name}</a>
                  </span>
                ))}
              </p>
            </div>
          ))}
        </div>

        <div className="card g-pad">
          <h3 className="g-esec-h">Legion squares that are not stat ladders</h3>
          <p className="g-p g-dim">
            {utility.length} of {cov.classes}. Worth levelling for the effect rather than for raw stat.
          </p>
          <div className="g-tblwrap">
            <table className="gtable">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Effect</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {utility.map((c) => (
                  <tr key={c.id}>
                    <td className="g-firstcol">
                      <a href={`#class-${c.id}`}>{c.name}</a>
                    </td>
                    <td>{c.legion.effect}</td>
                    <td className="mono g-dim">{c.legion.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card g-pad">
          <h3 className="g-esec-h">Stat exceptions</h3>
          <p className="g-p g-dim">
            Every class that breaks the normal main/secondary assumption. A gearing engine has to special-case all of
            them.
          </p>
          {statExceptions().map((e) => (
            <div key={e.classId} className="g-claim d1">
              <div className="g-claim-head">
                <span className="g-claim-title">{findClass(e.classId)?.name ?? e.classId}</span>
              </div>
              <p className="g-kv">{e.what}</p>
              <p className="g-kv g-dim">{e.why}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─────────── written guides ─────────── */}
      <section className="g-sec" id="guide">
        <h2 className="g-sec-h">
          Written class guides
          <span className="mono g-dim">
            {SELECTABLE.length} files · {WRITTEN_CLASSES.length} of {cov.classes} classes
          </span>
        </h2>
        <p className="g-p">
          The judgement layer: V matrix order, HEXA investment order, hyper skills, hyper stats, inner ability. Every
          claim below carries a source count, a consensus label and the date the source was opened. Of the{" "}
          {CENSUS.total} counted claims across the written files, {CENSUS.one} rest on exactly one source family,{" "}
          {CENSUS.two} on two, {CENSUS.many} on three or more and {CENSUS.zero} on none — so the pips are not
          decoration. If they all rendered identically the page would be lying by uniformity.
        </p>

        <div className="g-picker">
          {SELECTABLE.map((s) => {
            const on = selected ? s.file.slug === selected.file.slug : false;
            const notReady = s.file.contest?.shipReady === false;
            return (
              <a
                key={s.file.slug}
                className={`g-pick${on ? " on" : ""}${notReady ? " warn" : ""}`}
                href={`?class=${s.file.slug}#guide`}
              >
                {s.displayName}
                {s.classId === null ? <em>unjoined</em> : null}
                {notReady ? <i>!</i> : null}
              </a>
            );
          })}
        </div>

        {selected ? (
          <>
            <p className="mono g-dim g-tiny">
              {asked
                ? `Showing ${selected.file.slug}.json.`
                : "No class selected, so the first written guide in roster order is shown."}{" "}
              One guide renders at a time: the five endgame sections across all {SELECTABLE.length} written files come
              to {endgameKb} KB of claims, which is not one page&apos;s worth of HTML.
            </p>
            <div className="card g-pad g-guide">
              {selected.unjoinedWhy ? (
                <p className="g-p g-warn-inline">
                  <b>This file does not join the roster.</b> It is shown under its own file name rather than attributed
                  to a class, because attributing it would be a guess. {selected.unjoinedWhy}
                </p>
              ) : null}
              <GuideHeader file={selected.file} displayName={selected.displayName} />
              <GuideBody file={selected.file} />
            </div>
          </>
        ) : (
          <p className="g-empty">No guide file is marked written, so nothing is rendered as guidance.</p>
        )}
      </section>

      {/* ─────────── held back ─────────── */}
      <section className="g-sec" id="blocked">
        <h2 className="g-sec-h">
          Held back
          <span className="mono g-dim">
            {BLOCKED_CLASSES.length} blocked · {MISSING_CLASSES.length} with no file
          </span>
        </h2>
        {policyMessage ? <p className="g-p">{policyMessage}</p> : null}
        <div className="g-hardrule">
          <span className="mono g-keytag">Contest note</span> {CONTEST.note} {CONTEST.defectsRecorded} defects were
          recorded in the pass of {CONTEST.ranAt}.
        </div>

        <div className="g-grid wide">
          {BLOCKED_CLASSES.map((c) => {
            const st = guideStateFor(c.id);
            return st.kind === "blocked" ? <BlockedCard key={c.id} cls={c} file={st.file} /> : null;
          })}
        </div>

        {MISSING_CLASSES.length > 0 && (
          <>
            <h3 className="g-esec-h">Classes with no guide research file at all</h3>
            <p className="g-p g-dim">
              Distinct from blocked: no file was ever opened for these, so there is nothing to block. They render the
              same empty taxonomy.
            </p>
            <div className="g-grid wide">
              {MISSING_CLASSES.map((c) => {
                const mark = markFor(c.id);
                return (
                  <article key={c.id} className="card g-bc" id={`blocked-${c.id}`}>
                    <div className="g-cc-head">
                      {mark && (
                        <span
                          className="g-mark"
                          style={{ color: mark.hex, background: `${mark.hex}1c`, borderColor: `${mark.hex}66` }}
                          aria-hidden="true"
                        >
                          {mark.monogram}
                        </span>
                      )}
                      <div className="g-cc-id">
                        <h3>{c.name}</h3>
                        <p className="mono g-dim">no data/class-guides file</p>
                      </div>
                      <span className="g-state unverified">nothing researched</span>
                    </div>
                    <EmptySlots classId={c.id} />
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* ─────────── integrity ─────────── */}
      <section className="g-sec" id="integrity">
        <h2 className="g-sec-h">
          Integrity
          <span className="mono g-dim">computed on render, never typed by hand</span>
        </h2>
        <p className="g-p g-dim">
          Every list here is a function call against the data as it stands, so it stays true as the data changes. An
          empty list is a real result.
        </p>

        <div className="card g-pad">
          <h3 className="g-esec-h">assertRosterIntegrity() — {integrity.length} problems</h3>
          {integrity.length === 0 ? (
            <p className="g-p g-ok">
              No duplicate ids or monograms, every id equals classKey(name), every branch and archetype resolves.
            </p>
          ) : (
            <ul className="g-bul">
              {integrity.map((p, i) => (
                <li key={i}>
                  <b>{p.where}</b> — {p.problem}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card g-pad">
          <h3 className="g-esec-h">legionCrossCheck() — {mismatches.length} disagreements with lib/legion.ts</h3>
          <p className="g-p g-dim">
            lib/legion.ts is imported and compared, never forked. Where the two disagree the roster wins and the
            disagreement is reported rather than papered over. Separately, lib/legion.ts has no LINK_EFFECT row for{" "}
            {missingFromLegion.length} of {cov.classes} classes — that is coverage rather than a defect, and
            linkEffectText() covers every one of them from the roster.
          </p>
          {mismatches.length === 0 ? (
            <p className="g-p g-ok">No disagreements.</p>
          ) : (
            <ul className="g-bul">
              {mismatches.map((m, i) => (
                <li key={i}>
                  <span className="g-chip">
                    <span className="g-chip-k">Issue</span>
                    {m.issue}
                  </span>{" "}
                  {m.detail}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card g-pad">
          <h3 className="g-esec-h">Link skills the sources could not name — {cov.linkSkillsUnresolved.length}</h3>
          {cov.linkSkillsUnresolved.length === 0 ? (
            <p className="g-p g-ok">Every link skill has a name the sources agree on.</p>
          ) : (
            <p className="g-p">
              {cov.linkSkillsUnresolved.join(", ")}. The effect renders; the name does not, because two sources give
              two different names and an unlabelled link is better than an invented one.
            </p>
          )}
        </div>

        <div className="card g-pad">
          <h3 className="g-esec-h">Guide files that do not join the roster — {UNJOINED.length}</h3>
          {UNJOINED.length === 0 ? (
            <p className="g-p g-ok">Every guide file joins a roster class.</p>
          ) : (
            <ul className="g-bul">
              {UNJOINED.map(({ file, why }) => (
                <li key={file.slug}>
                  <b>{file.slug}.json</b> ({file.className}, written: {String(file.written === true)}) — {why}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card g-pad">
          <h3 className="g-esec-h">Where the two guide layers genuinely conflict — {strictBlocked.length}</h3>
          <p className="g-p g-dim">
            There are two guide layers and they are not the same kind of thing: data/classes.json carries the worked
            ClassGuide schema, and data/class-guides/ carries the research files. A conflict is only a conflict in one
            direction — classes.json claiming a written guide for a class whose research file says it is not
            shippable. There the stricter source wins and the class renders an empty slot.
          </p>
          {strictBlocked.length === 0 ? (
            <p className="g-p g-ok">No class is claimed as written by one layer and blocked by the other.</p>
          ) : (
            <ul className="g-bul">
              {strictBlocked.map((c) => {
                const gs = guideStateFor(c.id);
                return (
                  <li key={c.id}>
                    <b>{c.name}</b> — data/classes.json guides.{c.guide ?? "none"} is a written ClassGuide, but{" "}
                    {gs.kind === "blocked" ? `${gs.file.slug}.json` : "the research layer"} reports written: false.
                    Held back: <a href={`#blocked-${c.id}`}>see the empty slot and the blockedReason</a>.
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card g-pad">
          <h3 className="g-esec-h">
            Research written, no worked ClassGuide yet — {layerGap.length}
          </h3>
          <p className="g-p g-dim">
            Coverage rather than conflict, and stated so it is not mistaken for one. These classes have a written
            research file that this page renders, while data/classes.json still has no entry in its guides map, so
            guideStatus() reports written: false for them. Nothing here is rendered as more settled than its own
            source counts say.
          </p>
          {layerGap.length === 0 ? (
            <p className="g-p g-ok">The two layers have the same coverage.</p>
          ) : (
            <p className="g-p">{layerGap.map((c) => c.name).join(", ")}.</p>
          )}
        </div>
      </section>

      {/* ─────────── progression tables ─────────── */}
      <section className="g-sec" id="tables">
        <h2 className="g-sec-h">
          Progression tables
          <span className="mono g-dim">
            {nodes.length} nodes · {tabs.length} tabs
          </span>
        </h2>
        <div className="g-tabs">
          {tabs
            .filter((t) => nodes.some((n) => n.tab === t.id))
            .map((t) => (
              <a key={t.id} href={`#tab-${t.id}`}>
                {t.name}
              </a>
            ))}
        </div>
        {tabs.map((tab) => {
          const mine = nodes.filter((n) => n.tab === tab.id);
          if (!mine.length) return null;
          return (
            <section key={tab.id} id={`tab-${tab.id}`} className="g-branch">
              <h3 className="g-branch-h">{tab.name}</h3>
              <div className="g-stack">
                {mine.map((n) => {
                  // Fresh means current patch AND actually sourced — unchanged
                  // semantics. The predicate now comes from lib/classes.ts
                  // isUnverified(), because the local regex here read
                  // /^s*UNVERIFIED/ (a literal "s", not \s) and would miss any
                  // source string with leading whitespace.
                  const unverified = isUnverified(n);
                  const fresh = n.patchVersion === cur && !unverified;
                  return (
                    <article key={n.id} className="card g-pad">
                      <div className="g-cc-head">
                        <div className="g-cc-id">
                          <h3>{n.title}</h3>
                        </div>
                        {fresh ? (
                          <span className="g-state verified">{cur}</span>
                        ) : (
                          <span className="g-state unverified">
                            {unverified ? "unverified" : `stamped ${n.patchVersion}`}
                          </span>
                        )}
                      </div>

                      {n.type === "table" && n.headers ? (
                        <div className="g-tblwrap">
                          <table className="gtable">
                            <thead>
                              <tr>
                                {n.headers.map((h) => (
                                  <th key={h}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(n.rows as unknown as string[][]).map((r, i) => (
                                <tr key={i}>
                                  {r.map((cell, j) => (
                                    <td key={j} className={j === 0 ? "g-firstcol" : undefined}>
                                      {cell}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <ul className="g-bul">
                          {n.rows.map((r, i) => (
                            <li key={i}>{Array.isArray(r) ? r[0] : r}</li>
                          ))}
                        </ul>
                      )}

                      {n.notes ? <p className="g-note">{n.notes}</p> : null}

                      <p className="mono g-dim g-tiny g-foot">
                        {isUrl(n.source) ? (
                          <a href={n.source} target="_blank" rel="noopener noreferrer">
                            {hostOf(n.source)}
                          </a>
                        ) : (
                          n.source
                        )}{" "}
                        · verified {n.lastVerified || "never"} · {n.patchVersion}
                      </p>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </section>

      <footer className="g-footer mono g-dim g-tiny">
        <p>
          Roster: {CLASS_META.classCount} classes, built {CLASS_META.lastBuilt}, {CLASS_META.region},{" "}
          {CLASS_META.worldAssumption}. Patch ledger built {PATCHES.meta.builtOn}. Class-guide contest pass{" "}
          {CONTEST.ranAt}.
        </p>
        <p>
          Branch colours are MaplePlanner design decisions and not game constants. No damage constant is restated on
          this page — nothing here holds a copy of a number lib/damage.ts owns.
        </p>
      </footer>
    </div>
  );
}

/* ============================================================================
 * STYLES — scoped to this page, reusing the palette variables and the
 * .card / .gtable / .mono chrome already in app/globals.css.
 * ==========================================================================*/

const CSS = `
.g-wrap { max-width: 1240px; margin: 0 auto; padding: 26px 20px 90px; color: var(--ink); }
.g-wrap a { color: var(--blue); text-decoration: none; }
.g-wrap a:hover { text-decoration: underline; }

.g-head { border-bottom: 1px solid var(--line); padding-bottom: 18px; margin-bottom: 30px; }
.g-head h1 { font-size: 1.62rem; font-weight: 700; letter-spacing: -.01em; }
.g-meta { font-size: .67rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-3); margin-top: 6px; }
.g-meta a { color: var(--gold); }
.g-claimline { margin-top: 12px; font-size: .92rem; line-height: 1.6; }
.g-dim { color: var(--ink-3); }
.g-tiny { font-size: .68rem; line-height: 1.5; }
.g-num { color: var(--gold-2); }
.g-ok { color: var(--good); }
.g-down { color: var(--bad); }

.g-nav { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; }
.g-nav a, .g-tabs a {
  font-family: var(--font-jetbrains), monospace; font-size: .62rem; letter-spacing: .1em;
  text-transform: uppercase; color: var(--ink-2); border: 1px solid var(--line);
  background: rgba(255,255,255,.02); padding: 5px 9px; border-radius: 3px;
}
.g-nav a:hover, .g-tabs a:hover { border-color: var(--gold); color: var(--ink); text-decoration: none; }
.g-tabs { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0 18px; }

.g-sec { margin-bottom: 54px; }
.g-sec-h {
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  font-family: var(--font-jetbrains), monospace; font-size: .72rem; letter-spacing: .16em;
  text-transform: uppercase; color: var(--ink-2); border-bottom: 1px solid var(--line);
  padding-bottom: 8px; margin-bottom: 14px;
}
.g-sec-h .g-dim { letter-spacing: .08em; }
.g-esec-h {
  font-family: var(--font-jetbrains), monospace; font-size: .64rem; letter-spacing: .16em;
  text-transform: uppercase; color: var(--ink-3); margin: 20px 0 8px;
  border-bottom: 1px solid var(--line-soft); padding-bottom: 6px;
}
.g-p { font-size: .87rem; line-height: 1.62; margin: 7px 0; }
.g-pad { padding: 15px 17px; margin-bottom: 16px; }
.g-stack { display: flex; flex-direction: column; gap: 14px; }

.g-hardrule {
  background: var(--panel-2); border-left: 2px solid var(--gold); padding: 10px 13px;
  font-size: .84rem; line-height: 1.6; margin: 12px 0 18px; border-radius: 0 3px 3px 0;
}
.g-keytag {
  font-size: .56rem; letter-spacing: .14em; text-transform: uppercase; color: var(--gold-deep);
  border: 1px solid var(--line); border-radius: 2px; padding: 1px 5px; margin-right: 5px;
  white-space: nowrap;
}

.g-state {
  font-family: var(--font-jetbrains), monospace; font-size: .54rem; letter-spacing: .12em;
  text-transform: uppercase; padding: 2px 6px; border-radius: 2px; border: 1px solid; white-space: nowrap;
}
.g-state.verified { color: var(--good); border-color: rgba(95,211,155,.5); background: rgba(95,211,155,.09); }
.g-state.stale { color: var(--warn); border-color: rgba(240,169,79,.45); background: rgba(240,169,79,.08); }
.g-state.unverified { color: var(--bad); border-color: rgba(240,106,99,.5); background: rgba(240,106,99,.09); }

.g-pips { display: inline-flex; align-items: center; gap: 3px; }
.g-pips i { width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--edge); background: transparent; }
.g-pips b { font-size: .56rem; margin-left: 3px; color: var(--ink-3); font-weight: 500; }
.g-pips.zero i { border-color: rgba(240,106,99,.6); }
.g-pips.zero i.on { background: var(--bad); }
.g-pips.zero b { color: var(--bad); }
.g-pips.one i.on { background: var(--warn); border-color: var(--warn); }
.g-pips.one b { color: var(--warn); }
.g-pips.two i.on { background: var(--blue); border-color: var(--blue); }
.g-pips.two b { color: var(--blue); }
.g-pips.many i.on { background: var(--good); border-color: var(--good); }
.g-pips.many b { color: var(--good); }

.g-cons {
  font-family: var(--font-jetbrains), monospace; font-size: .54rem; letter-spacing: .12em;
  text-transform: uppercase; padding: 2px 6px; border-radius: 2px; border: 1px solid;
}
.g-cons.strong { color: var(--good); border-color: rgba(95,211,155,.5); background: rgba(95,211,155,.09); }
.g-cons.moderate { color: var(--blue); border-color: rgba(111,168,255,.45); background: rgba(111,168,255,.08); }
.g-cons.weak { color: var(--warn); border-color: rgba(240,169,79,.45); background: rgba(240,169,79,.07); }
.g-cons.none { color: var(--bad); border-color: rgba(240,106,99,.5); background: rgba(240,106,99,.08); }

.g-indep {
  font-family: var(--font-jetbrains), monospace; font-size: .52rem; letter-spacing: .1em;
  text-transform: uppercase; margin-left: 6px; padding: 1px 5px; border-radius: 2px; border: 1px solid;
}
.g-indep.yes { color: var(--good); border-color: rgba(95,211,155,.4); }
.g-indep.no { color: var(--ink-3); border-color: var(--line); }

.g-corr {
  font-family: var(--font-jetbrains), monospace; font-size: .54rem; letter-spacing: .12em;
  text-transform: uppercase; padding: 2px 6px; border-radius: 2px; border: 1px solid;
}
.g-corr.yes { color: var(--good); border-color: rgba(95,211,155,.45); }
.g-corr.no { color: var(--ink-2); border-color: var(--line); background: rgba(255,255,255,.03); }

.g-null { color: var(--ink-3); font-size: .7rem; letter-spacing: .05em; border-bottom: 1px dashed var(--edge); }

.g-claims { display: flex; flex-direction: column; gap: 9px; }
.g-claim { border-left: 2px solid var(--line); padding: 2px 0 2px 11px; }
.g-claim.d1 { border-left-color: var(--line-soft); }
.g-claim.d2 { border-left-color: #1a2338; }
.g-claim.d3, .g-claim.d4 { border-left-color: #17203a; }
.g-claim-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 3px; }
.g-claim-title { font-size: .9rem; font-weight: 600; color: var(--ink); }
.g-chip {
  font-family: var(--font-jetbrains), monospace; font-size: .55rem; letter-spacing: .08em;
  border: 1px solid var(--line); border-radius: 2px; padding: 1px 5px; color: var(--ink-2);
  background: rgba(255,255,255,.025); white-space: nowrap;
}
.g-chip-k { color: var(--ink-3); margin-right: 5px; text-transform: uppercase; letter-spacing: .12em; }
.g-kv { font-size: .84rem; line-height: 1.6; margin: 4px 0; }
.g-kvblock { margin: 7px 0; }
.g-kvblock > .mono { display: inline-block; margin-bottom: 4px; }
.g-bul { margin: 4px 0; padding-left: 16px; list-style: none; display: flex; flex-direction: column; gap: 5px; }
.g-bul > li { position: relative; font-size: .84rem; line-height: 1.55; }
.g-bul > li::before {
  content: ""; position: absolute; left: -13px; top: .62em; width: 4px; height: 4px;
  background: var(--gold-deep); border-radius: 50%;
}

.g-cite { display: flex; flex-direction: column; gap: 3px; margin: 4px 0 6px; }
.g-cite-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.g-cite-row .mono { font-size: .58rem; letter-spacing: .08em; }
.g-srcs { margin: 4px 0; padding-left: 18px; font-size: .78rem; line-height: 1.75; color: var(--ink-2); }

.g-det { margin: 6px 0; }
.g-det > summary {
  cursor: pointer; font-family: var(--font-jetbrains), monospace; font-size: .58rem;
  letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3);
  border: 1px solid var(--line); border-radius: 2px; padding: 3px 8px; display: inline-block;
  list-style: none;
}
.g-det > summary::-webkit-details-marker { display: none; }
.g-det > summary:hover { color: var(--ink); border-color: var(--edge); }
.g-det[open] > summary { color: var(--ink-2); border-color: var(--edge); }
.g-det-body { padding: 8px 0 4px 11px; border-left: 1px solid var(--line-soft); margin-top: 6px; }

.g-branch { margin-bottom: 26px; }
.g-branch-h {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: .95rem; font-weight: 600; margin-bottom: 10px;
}
.g-branch-h .g-dim { font-size: .6rem; letter-spacing: .12em; text-transform: uppercase; font-weight: 400; }
.g-swatch { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
.g-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 13px; align-items: start; }
.g-grid.wide { grid-template-columns: repeat(auto-fill, minmax(430px, 1fr)); }

.g-cc, .g-bc { padding: 13px 15px; display: flex; flex-direction: column; gap: 9px; }
.g-cc-head { display: flex; align-items: flex-start; gap: 10px; }
.g-cc-id { margin-right: auto; min-width: 0; }
.g-cc-id h3 { font-size: 1rem; font-weight: 600; }
.g-cc-id p { font-size: .6rem; letter-spacing: .1em; text-transform: uppercase; margin-top: 3px; }
.g-mark {
  flex: none; width: 38px; height: 38px; border-radius: 7px; border: 1px solid;
  display: grid; place-items: center; font-family: var(--font-inter-tight), system-ui, sans-serif;
  font-weight: 700; font-size: .78rem; letter-spacing: .02em;
}

.g-dl { display: flex; flex-direction: column; gap: 7px; margin: 0; }
.g-dl > div { display: grid; grid-template-columns: 108px minmax(0, 1fr); gap: 10px; align-items: baseline; }
.g-dl dt {
  font-family: var(--font-jetbrains), monospace; font-size: .55rem; letter-spacing: .13em;
  text-transform: uppercase; color: var(--ink-3); padding-top: 2px;
}
.g-dl dd { margin: 0; font-size: .83rem; line-height: 1.55; }

.g-cc-foot {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  border-top: 1px solid var(--line-soft); padding-top: 8px; margin-top: 2px;
}
.g-gchip {
  font-family: var(--font-jetbrains), monospace; font-size: .55rem; letter-spacing: .11em;
  text-transform: uppercase; padding: 3px 7px; border-radius: 2px; border: 1px solid;
}
.g-gchip.written { color: var(--good); border-color: rgba(95,211,155,.5); background: rgba(95,211,155,.08); }
.g-gchip.blocked { color: var(--warn); border-color: rgba(240,169,79,.45); background: rgba(240,169,79,.07); }
.g-gchip.none { color: var(--ink-3); border-color: var(--line); border-style: dashed; }

.g-picker { display: flex; flex-wrap: wrap; gap: 5px; margin: 12px 0; }
.g-pick {
  font-family: var(--font-jetbrains), monospace; font-size: .62rem; letter-spacing: .06em;
  color: var(--ink-2); border: 1px solid var(--line); background: rgba(255,255,255,.02);
  padding: 5px 9px; border-radius: 3px; white-space: nowrap;
}
.g-pick:hover { border-color: var(--gold); color: var(--ink); text-decoration: none; }
.g-pick.on { color: var(--bg); background: var(--gold); border-color: var(--gold); font-weight: 500; }
.g-pick.warn i { color: var(--bad); font-style: normal; margin-left: 5px; font-weight: 700; }
.g-pick.on.warn i { color: var(--bg); }
.g-pick em {
  font-style: normal; font-size: .5rem; letter-spacing: .12em; text-transform: uppercase;
  color: var(--ink-3); margin-left: 6px;
}
.g-pick.on em { color: var(--bg); }

.g-guide { padding: 16px 18px; }
.g-gh { display: flex; flex-direction: column; gap: 4px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
.g-gh-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.g-gh-top h3 { font-size: 1.2rem; font-weight: 700; }
.g-gh-top .mono { font-size: .6rem; letter-spacing: .08em; }
.g-gh-strip { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 5px 0; }
.g-gh-strip .mono { font-size: .6rem; letter-spacing: .06em; }
.g-gb { display: flex; flex-direction: column; }
.g-esec { margin-top: 6px; }

.g-warn {
  border: 1px solid rgba(240,106,99,.4); background: rgba(240,106,99,.05);
  border-radius: 3px; padding: 10px 13px; margin: 10px 0;
}
.g-warn-inline {
  border-left: 2px solid var(--bad); background: rgba(240,106,99,.05);
  padding: 8px 11px; border-radius: 0 3px 3px 0;
}
.g-reason { background: var(--well); border-left: 2px solid var(--warn); padding: 9px 12px; border-radius: 0 3px 3px 0; }
.g-donot { color: var(--bad); }
.g-note {
  font-size: .84rem; line-height: 1.6; color: var(--ink-2); background: var(--panel-2);
  border-left: 2px solid var(--gold); padding: 9px 12px; margin: 9px 0 0; border-radius: 0 3px 3px 0;
}
.g-foot { border-top: 1px solid var(--line-soft); padding-top: 7px; margin-top: 9px; }

.g-empty {
  font-size: .84rem; line-height: 1.6; color: var(--ink-3);
  border: 1px dashed var(--edge); border-radius: 3px; padding: 11px 13px; background: #0c1220;
}
.g-slots { display: flex; flex-wrap: wrap; gap: 5px; }
.g-slot {
  font-family: var(--font-jetbrains), monospace; font-size: .58rem; letter-spacing: .06em;
  color: var(--ink-3); border: 1px dashed var(--edge); background: #0c1220;
  border-radius: 2px; padding: 4px 7px;
}
.g-slot i {
  font-style: normal; font-size: .5rem; letter-spacing: .12em; text-transform: uppercase;
  color: var(--gold-deep); margin-left: 6px;
}

.g-patch { margin-bottom: 34px; }
.g-patch-h {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 1.06rem; font-weight: 600; margin-bottom: 8px;
}
.g-pv { color: var(--gold); font-size: .8rem; letter-spacing: .06em; }
.g-cb { margin: 14px 0; }
.g-chgs { display: flex; flex-direction: column; gap: 11px; }
.g-chg {
  background: linear-gradient(180deg, var(--panel) 0%, #121a2b 100%);
  border: 1px solid var(--line); border-radius: 4px; padding: 12px 14px;
}
.g-chg.neg { border-left: 3px solid var(--bad); }
.g-chg.kms { border-left: 3px solid var(--warn); background: #14131f; }
.g-chg-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.g-chg-head .mono { font-size: .58rem; letter-spacing: .08em; }
.g-area {
  font-size: .55rem; letter-spacing: .14em; text-transform: uppercase; color: var(--gold-2);
  border: 1px solid var(--gold-deep); border-radius: 2px; padding: 2px 6px; background: rgba(240,192,96,.06);
}
.g-chg-sum { font-size: .9rem; font-weight: 600; line-height: 1.5; }
.g-gmsline { border-left: 2px solid var(--good); padding-left: 10px; }

.g-kmsblock { border: 1px solid rgba(240,169,79,.35); border-radius: 5px; padding: 16px 18px; background: #100f18; }
.g-kmswarn {
  border: 1px solid rgba(240,169,79,.5); background: rgba(240,169,79,.07);
  border-radius: 3px; padding: 11px 13px; margin-bottom: 14px;
}
.g-kmswarn .g-p { color: var(--gold-2); }

.g-tblwrap { overflow-x: auto; margin: 9px 0; }
.g-firstcol { font-weight: 500; }

.g-footer {
  border-top: 1px solid var(--line); padding-top: 16px; margin-top: 20px;
  display: flex; flex-direction: column; gap: 6px;
}

@media (max-width: 720px) {
  .g-grid, .g-grid.wide { grid-template-columns: 1fr; }
  .g-dl > div { grid-template-columns: 1fr; gap: 2px; }
}
`;
