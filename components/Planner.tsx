"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CONFIDENCE_VOCABULARY, SLOTS, TIER_LABEL, STAT_LABEL, advise,
  activeCharacter, addCharacter, characterIdForRoster, damageModelStatus,
  emptyCharacter, exampleAccount, exampleCharacter, isDeadLine, listCharacters,
  openRosterCharacter, planAdvice, removeCharacter, rosterKey, selectCharacter,
  setRoster, sfCap, withActiveCharacter, EXAMPLE_CHARACTER_ID,
  type Account, type Character, type CharacterStats, type Conf, type Item,
  type Rec, type SlotDef, type Tier,
} from "@/lib/rules";
import {
  DEFAULT_PDR, REFERENCE_CHARACTER, WEAPON_MULTIPLIER, WEAPON_MULTIPLIER_CONF,
  damageRange, fractionToPrintedPercent, fractionalInputsFromCharacter,
  printedPercentToFraction, referenceCheck,
  type DamageWarning,
} from "@/lib/damage";
import {
  CLASS_META, guideFor, guideStatus, hyperStatPriorities, isUnverified,
  unverifiedReason, verificationState,
  type EvaluatedRule,
} from "@/lib/classes";
import { getAccountStore } from "@/lib/storage";
import { resolveItem } from "@/lib/itemLookup";
import { mergeRoster, type RosterChar } from "@/lib/legion";
import ImportDialog from "@/components/ImportDialog";
import ItemSearch from "@/components/ItemSearch";
import Roster, { type RosterSheet } from "@/components/Roster";
import type { ItemHit } from "@/app/api/items/route";

const PRI_LABEL = ["", "NOW", "SOON", "LATER", "DONE"];

/* ---------- the numbers ----------
 * lib/rules.ts already formats its damage/cost prefix INTO Rec.t, because until
 * this wave nothing rendered r.dmg / r.cost / r.eff and the string was the only
 * way a number could reach the screen. Now that the fields are rendered as
 * their own typed, confidence-marked chips, that prefix would appear twice.
 *
 * These two formatters are deliberate byte-for-byte mirrors of fmtDmg/fmtMeso
 * in lib/rules.ts (which are module-private) so the prefix can be reconstructed
 * EXACTLY and removed by equality, never by a regex that might eat a real title.
 * If the engine ever changes its formatting the match simply fails and the full
 * string renders as it does today — the failure mode is a duplicated number,
 * not a lost one. */
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
/** eff is damage-fraction per 1e9 mesos. 0.0752 -> "+7.5%". */
function fmtEff(e: number): string {
  const pct = e * 100;
  const s = pct >= 10 ? pct.toFixed(0) : pct >= 0.1 ? pct.toFixed(1) : pct.toFixed(2);
  return `+${s}%`;
}

/** r.t with the engine's own number prefix removed, when it is present. */
function bareTitle(r: Rec): string {
  if (r.dmg === undefined) return r.t;
  const priced = r.cost !== undefined ? `${fmtDmg(r.dmg)} · ${fmtMeso(r.cost)} — ` : null;
  if (priced && r.t.startsWith(priced)) return r.t.slice(priced.length);
  const dmgOnly = `${fmtDmg(r.dmg)} — `;
  if (r.t.startsWith(dmgOnly)) return r.t.slice(dmgOnly.length);
  return r.t;
}

const CONF_INFO: Record<Conf, { badge: string; meaning: string }> = Object.fromEntries(
  CONFIDENCE_VOCABULARY.map((v) => [v.conf, { badge: v.badge, meaning: v.meaning }]),
) as Record<Conf, { badge: string; meaning: string }>;

/* One vocabulary, one badge. rules.Conf is the only confidence type that
 * reaches this component — cubes' 'ranking-only' and farming's
 * 'needs-measurement' are folded into it by rules.confFrom*() before a Rec is
 * built, so there is nothing here to reconcile. */
function ConfBadge({ conf }: { conf: Conf }) {
  const info = CONF_INFO[conf];
  return <span className={`conf ${conf}`} title={info.meaning}>{info.badge}</span>;
}

/* The legend used to print all three tiers unconditionally, which advertised
 * "Sourced — safe to budget against" on a page where nothing carries it: every
 * meso cost the engine can price leans on at least one constant rules.ts marks
 * unverified (see its SOURCED table — STARFORCE_COST_PER_ATTEMPT and every cube
 * and flame placeholder are false), so confFromUnverified() never returns
 * 'sourced'. A legend entry for a badge nothing wears is a promise the page
 * does not keep, so the tiers are now derived from what is actually rendered
 * and the rest is named as absent rather than offered. */
function ConfLegend({ present }: { present: ReadonlySet<Conf> }) {
  const shown = CONFIDENCE_VOCABULARY.filter((v) => present.has(v.conf));
  const absent = CONFIDENCE_VOCABULARY.filter((v) => !present.has(v.conf));
  return (
    <div className="conf-legend">
      {shown.map((v) => (
        <span key={v.conf}>
          <span className={`conf ${v.conf}`}>{v.badge}</span>
          {v.meaning}
        </span>
      ))}
      {absent.length > 0 && (
        <span className="absent">
          <span className="conf-none">Not shown</span>
          {absent.map((v) => v.badge).join(", ")} — nothing on this page carries{" "}
          {absent.length === 1 ? "that tier" : "those tiers"}, so the{" "}
          {absent.length === 1 ? "badge is" : "badges are"} withheld rather than advertised.
        </span>
      )}
    </div>
  );
}

const SLOT_NAME: Record<string, string> = Object.fromEntries(SLOTS.map((s) => [s.id, s.n]));

/** How many of the ranked account-wide moves to show before "show all". */
const TOP_N = 12;

function RecRow({ r, showSlot }: { r: Rec; showSlot?: boolean }) {
  // A rec the model could not price renders exactly as it did before this wave:
  // priority chip, bold sentence, prose. No badge, no empty number slot, no
  // implication that a missing figure is a zero.
  const priced = r.dmg !== undefined;
  const slotLabel = showSlot ? (r.slot === "character" ? "Character" : SLOT_NAME[r.slot ?? ""]) : null;
  return (
    // No conf on a priced rec should never happen — price() and
    // priceDamageOnly() both set it — but if it ever did, the number falls back
    // to neutral styling rather than borrowing a confidence it was not given.
    <div className={`rec ${r.lv}${priced ? ` has-num${r.conf ? ` ${r.conf}` : ""}` : ""}`}>
      <span className="p">{PRI_LABEL[r.pri]}</span>
      <span>
        {priced && (
          <span className="rnums">
            <span className="n dmg">{fmtDmg(r.dmg as number)}</span>
            <span className="n cost">
              {r.cost === undefined ? "no meso cost" : fmtMeso(r.cost)}
            </span>
            {r.eff !== undefined && Number.isFinite(r.eff) && (r.eff as number) > 0 && (
              <span className="n eff" title="Damage per 1 billion mesos — the sort key">
                {fmtEff(r.eff as number)} dmg / 1B
              </span>
            )}
            {r.conf && <ConfBadge conf={r.conf} />}
          </span>
        )}
        {slotLabel && <span className="rslot">{slotLabel}</span>}
        <b>{bareTitle(r)}</b>
        {r.w && <span className="why">{r.w}</span>}
      </span>
    </div>
  );
}

/* ---------- damage range: the one number the game prints back ----------
 * Everything else on this page is our arithmetic. Damage Range is Nexon's, and
 * lib/damage.ts computes it from the same published formula, so it is the only
 * external check the model has: if the stat window disagrees, the class weapon
 * multiplier is wrong and every figure downstream of it is wrong too.
 *
 * The number, its assumptions and its warnings all come from
 * fractionalInputsFromCharacter() — the ONE printed-percent -> fraction adapter.
 * Nothing here re-derives a constant; the legacy comparison reads
 * WEAPON_MULTIPLIER[weaponKey] out of the module rather than naming a figure.
 *
 * THIS PANEL IS ONLY MOUNTED FOR A CLASS THE MODEL IS VERIFIED FOR. For anyone
 * else the adapter falls back to the legacy bow multiplier and would print a
 * seven-digit number that looks exactly as authoritative as the real one —
 * UnmodelledDamage stands in its place and prints the reason instead. */
type RangeView = ReturnType<typeof damageRangeFor>;

function damageRangeFor(ch: Character) {
  const a = fractionalInputsFromCharacter(ch);
  const range = damageRange(a.inputs);
  const cc = a.classConstants;
  // The legacy per-weapon row is the rival reading of the same slot. Only worth
  // printing when the class table actually disagrees with it — with no class row
  // the adapter already fell back to it, so the two are one number.
  const legacyMult = cc ? WEAPON_MULTIPLIER[cc.weaponKey] : undefined;
  const legacy =
    cc && legacyMult !== undefined && legacyMult !== cc.weaponMultiplier.value
      ? {
          mult: legacyMult,
          max: damageRange(
            fractionalInputsFromCharacter(ch, { weaponMultiplierOverride: legacyMult }).inputs,
          ).max,
        }
      : null;
  /* Conf for the range itself, derived rather than chosen: the multiplier and
   * mastery are cited, but secondary stat is defaulted to 0 because the sheet
   * has no field for it, and that is a documented interpretation sitting on top
   * of sourced inputs — rules.ts calls that 'modelled'. With no class row the
   * multiplier IS the legacy placeholder, so the range inherits its confidence
   * instead. */
  const conf: Conf = cc
    ? cc.weaponMultiplier.conf === "sourced" ? "modelled" : cc.weaponMultiplier.conf
    : WEAPON_MULTIPLIER_CONF;
  return { a, range, cc, legacy, conf };
}

function DamageRange({ ch, d }: { ch: Character; d: RangeView }) {
  const [open, setOpen] = useState(false);
  const ref = useMemo(() => referenceCheck(), []);
  const isRef = useMemo(() => {
    const r = REFERENCE_CHARACTER;
    return (
      ch.cls === r.cls &&
      (["main", "att", "crit", "critdmg", "boss", "ied"] as const).every(
        (k) => ch.stats[k] === r.stats[k],
      )
    );
  }, [ch]);

  const has = d.range.max > 0;
  const n = (x: number) => Math.round(x).toLocaleString("en-US");
  const warnings: DamageWarning[] = d.a.warnings;

  return (
    <div className="dr">
      <div className="dr-top">
        <span className="l">Damage range</span>
        {/* No badge over a dash: a confidence marker belongs to a number, and
            with no stats entered there is no number to be confident about. */}
        {has && <ConfBadge conf={d.conf} />}
      </div>
      {has ? (
        <>
          <div className="v">{n(d.range.max)}</div>
          <div className="v2">
            min {n(d.range.min)} <span className="mut">at {fractionToPrintedPercent(d.a.inputs.mastery).toFixed(0)}% mastery</span>
          </div>
        </>
      ) : (
        <>
          <div className="v dash">—</div>
          <div className="v2">Enter {STAT_LABEL[ch.main]} and Attack to compute a range.</div>
        </>
      )}

      <p className="dr-note">
        This is the number the <b>game prints back at you</b> on the stat window.
        Ours is computed from the published range formula at a{" "}
        {d.cc ? d.cc.weaponMultiplier.value : d.a.inputs.weaponMultiplier}&times; weapon
        multiplier. If yours reads differently, that multiplier is wrong — and so is every
        figure on this page that depends on it.
      </p>

      {has && d.legacy && (
        <p className="dr-alt">
          The legacy {d.legacy.mult}&times; reading would print{" "}
          <b>{n(d.legacy.max)}</b> instead. Your stat window decides between them on sight.
        </p>
      )}

      {warnings.map((w) => (
        <p className="dr-warn" key={w.code}>{w.message}</p>
      ))}

      <div className="dr-fals">
        <div className="sub-h">
          {isRef ? "Falsifier — for this character" : "Falsifier — for the reference character"}
        </div>
        <p>{ref.falsifier}</p>
        {!isRef && (
          <p className="mut">
            Stated against {REFERENCE_CHARACTER.cls} Lv. {REFERENCE_CHARACTER.lvl}, the character
            the class constants were fitted to. The check above is the same test on your numbers.
          </p>
        )}
      </div>

      <button className="dr-more" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} the {d.a.assumptions.length} assumption
        {d.a.assumptions.length === 1 ? "" : "s"} behind this
      </button>
      {open && (
        <ul className="dr-asm">
          {d.a.assumptions.map((a, i) => <li key={i}>{a}</li>)}
        </ul>
      )}
    </div>
  );
}

/* ---------- what stands where a number would be ----------
 * rules.damageModelStatus() is the gate and its `why` is written to be rendered
 * verbatim, so this panel prints that sentence and NOTHING ELSE. No "estimated",
 * no greyed-out figure, no wide error bar: the model has one measured class, and
 * a second number here would be indistinguishable from the first on sight. */
function UnmodelledDamage({ why, verified }: { why: string; verified: readonly string[] }) {
  return (
    <div className="dr off">
      <div className="dr-top">
        <span className="l">Damage range</span>
        <span className="conf-none">Not modelled</span>
      </div>
      <div className="v dash">—</div>
      <p className="dr-note">{why}</p>
      <p className="dr-note mut">
        Measured so far: {verified.join(", ")}. Everything else on this page — gear, stars,
        flames, potential tiers, set effects, Legion — is class-independent and still applies.
      </p>
    </div>
  );
}

/* ---------- hyper stats: the per-character verdict ----------
 * A static guide ranks hyper stat lines for an imagined average player.
 * classes.hyperStatPriorities() evaluates each rule against THIS character's
 * crit rate and IED — the IED rule's threshold is damage.iedWall() rather than
 * a typed number — so the same class can read "critical" for a fresh Lv 200 and
 * "diminishing" for a geared one. That difference is the product. */
function ruleProvenance(rule: EvaluatedRule["rule"]): string {
  if (isUnverified(rule)) return `Unverified — ${unverifiedReason(rule)}`;
  let host = rule.source;
  try { host = new URL(rule.source).hostname.replace(/^www\./, ""); } catch { /* not a URL */ }
  const state = verificationState(rule);
  return state === "stale"
    ? `${rule.claimType} · ${host} · read at ${rule.patchVersion}, game is ${CLASS_META.gameVersion}`
    : `${rule.claimType} · ${host} · read ${rule.lastVerified}`;
}

function HyperStats({ ch }: { ch: Character }) {
  const rules = useMemo(
    () =>
      hyperStatPriorities(ch.cls, {
        critRate: printedPercentToFraction(ch.stats.crit),
        ied: printedPercentToFraction(ch.stats.ied),
      }),
    [ch.cls, ch.stats.crit, ch.stats.ied],
  );
  const labels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const l of guideFor(ch.cls)?.hyperStats.lines ?? []) m[l.stat] = l.label;
    return m;
  }, [ch.cls]);
  const tablesNote = guideFor(ch.cls)?.hyperStats.tablesNote;
  const status = guideStatus(ch.cls);

  return (
    <div className="hs-block">
      <div className="ranktools">
        <span className="sub-h">Hyper stats — computed for this character</span>
      </div>
      {rules.length ? (
        <>
          {rules.map((e) => (
            <div className={`hs ${e.priority}`} key={e.rule.id}>
              <span className="hsp">{e.priority}</span>
              <span>
                <b>{labels[e.rule.stat] ?? e.rule.stat}</b>
                {/* A rule can be gated on a DIFFERENT stat than the one it
                    ranks: "Critical Damage" is promoted once crit RATE caps, so
                    evaluateRule()'s sentence carries crit rate's numbers under a
                    crit damage heading. Unlabelled, "98.0% is 2.0% below the
                    100.0% threshold" reads as this character's crit damage,
                    which is 41.5% — a wrong number about a real character. The
                    term the condition actually measured is printed against the
                    figures, on every row, so the pairing is never inferred. */}
                <span className="hsv">
                  <span className="hsterm">
                    {labels[e.rule.condition.term] ?? e.rule.condition.term}
                  </span>
                  {e.verdict}
                </span>
                <span className="why">{e.rule.rationale}</span>
                <span className="hssrc">{ruleProvenance(e.rule)}</span>
              </span>
            </div>
          ))}
          <p className="railnote">
            Thresholds are evaluated against your own crit rate and IED, at the default{" "}
            {fractionToPrintedPercent(DEFAULT_PDR).toFixed(0)}% boss defence.
            {tablesNote ? ` ${tablesNote}` : ""}
          </p>
        </>
      ) : (
        /* written:false must never render as advice. guideStatus().message is
         * the empty state the data layer wrote for exactly this case; it is
         * rendered verbatim and nothing is generated to fill the gap. */
        <p className="hint hs-empty">
          {status
            ? status.written
              ? `No hyper stat rules are written for ${status.displayName} yet.`
              : status.message
            : `"${ch.cls}" is not in the class roster, so no per-character hyper stat verdict can be computed.`}
        </p>
      )}
    </div>
  );
}

/** How many recorded items a sheet carries — the one honest measure of "is
 *  there anything here yet", used by the account strip and the roster rows. */
function gearCount(ch: Character): number {
  return Object.values(ch.items ?? {}).filter((i) => i && i.name).length;
}

export default function Planner() {
  /* ---------- an account, not a character ----------
   * The planner edits ONE character at a time, but the thing it loads, saves
   * and switches inside is the whole account. `ch` below is a derived view:
   * activeCharacter() hands back the active sheet with its id filled in, and
   * every edit goes home through withActiveCharacter(), which is THE save path
   * for planner edits. Nothing here writes ch.roster — the account owns the
   * roster and setRoster() is its only writer. */
  const store = useMemo(() => getAccountStore(), []);
  const [account, setAccount] = useState<Account>(() => exampleAccount());
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Damage per meso is the right axis and the wrong answer to "what next?" when
  // the player has no budget: a 3M flame roll beats a 1.5B tier-up on the ratio
  // while being a fiftieth of the step. The engine has no budget input yet, so
  // the honest stopgap is to let the reader flip the axis rather than to pick
  // one and hide the other.
  const [sortBy, setSortBy] = useState<"eff" | "dmg">("eff");
  const [showAll, setShowAll] = useState(false);
  const [showWorking, setShowWorking] = useState(false);

  useEffect(() => {
    let live = true;
    store.load().then((saved) => {
      if (live && saved) setAccount(saved);
      if (live) setReady(true);
    });
    return () => { live = false; };
  }, [store]);

  const commit = useCallback((next: Account) => {
    setAccount(next);
    void store.save(next);
  }, [store]);

  const ch = useMemo(() => activeCharacter(account), [account]);
  const chars = useMemo(() => listCharacters(account), [account]);
  const roster = useMemo(() => account.roster ?? [], [account]);

  /** THE save path for an edit to the sheet on screen. */
  const update = useCallback((next: Character) => {
    commit(withActiveCharacter(account, next));
  }, [account, commit]);

  // Items saved before the database lookup existed carry a name but no
  // itemId, so the grid had no sprite to draw and fell back to rendering the
  // name as text. Resolve them once PER CHARACTER in the background rather than
  // making the user re-import gear that is already correct.
  const backfilled = useRef<Set<string>>(new Set());
  useEffect(() => {
    const id = ch.id ?? "";
    if (!ready || backfilled.current.has(id)) return;
    const missing = Object.entries(ch.items).filter(([, it]) => it?.name && !it.itemId);
    backfilled.current.add(id);
    if (!missing.length) return;

    let live = true;
    void (async () => {
      const items = { ...ch.items };
      let changed = false;
      for (const [slotId, it] of missing) {
        const db = await resolveItem(it.name, slotId);
        if (!db) continue;
        items[slotId] = {
          ...it,
          name: db.name,
          itemId: db.itemId,
          sub: db.sub,
          bossDrop: db.bossDrop,
          lvl: it.lvl || db.level || 0,
          sup: it.sup || (db.superior ? 1 : 0),
        };
        changed = true;
      }
      if (live && changed) update({ ...ch, items });
    })();
    return () => { live = false; };
  }, [ready, ch, update]);

  // Switching sheets is otherwise invisible — the grid simply fills with
  // someone else's gear, which is the silent mistake this whole wave is about.
  // Every switch, import and removal says out loud WHO it happened to.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 7000);
    return () => clearTimeout(t);
  }, [note]);

  /* ---------- selecting a character ---------- */

  const select = useCallback((id: string) => {
    if (id === ch.id) return;
    const next = selectCharacter(account, id);
    commit(next);
    setHover(null);
    setEditing(null);
    setShowAll(false);
    const who = next.characters[id];
    if (who) setNote(`Now editing ${who.name} — ${who.cls} Lv. ${who.lvl}.`);
  }, [account, ch.id, commit]);

  /** THE product request: click a roster row, get that character's sheet.
   *  openRosterCharacter() is idempotent — a second click selects rather than
   *  forking, and an already-built character of the same name is adopted rather
   *  than duplicated. `created` is what the wording below turns on. */
  const openRoster = useCallback((entry: RosterChar) => {
    const { account: next, id, created } = openRosterCharacter(account, entry);
    commit(next);
    setHover(null);
    setEditing(null);
    setShowAll(false);
    const who = next.characters[id];
    const n = who ? gearCount(who) : 0;
    setNote(
      created
        ? `Started a sheet for ${entry.name} — ${entry.cls} Lv. ${entry.lvl}. Nothing is recorded yet: import screenshots, or click any equipment slot to add an item.`
        : `Now editing ${entry.name} — ${n} item${n === 1 ? "" : "s"} recorded.`,
    );
  }, [account, commit]);

  const addBlank = useCallback(() => {
    commit(addCharacter(account, emptyCharacter(), { makeActive: true }).account);
    setNote("New blank sheet. Name it, set the class and level, then add gear.");
  }, [account, commit]);

  const loadDemo = useCallback(() => {
    commit(
      account.characters[EXAMPLE_CHARACTER_ID]
        ? selectCharacter(account, EXAMPLE_CHARACTER_ID)
        : addCharacter(account, exampleCharacter(), { makeActive: true }).account,
    );
    setNote("Showing the demo Bow Master — the character the damage model was measured against.");
  }, [account, commit]);

  /* ---------- the damage model gate ----------
   * Asked once, here; every damage figure on the page is downstream of it.
   * rules.ts already refuses to price a Rec for an unverified class (dmg, cost,
   * eff and conf all come back undefined), and this component refuses to mount
   * the damage range panel for one. */
  const model = useMemo(() => damageModelStatus(ch), [ch]);
  const range = useMemo(() => (model.verified ? damageRangeFor(ch) : null), [ch, model.verified]);

  const slot = SLOTS.find((s) => s.id === hover) || null;
  // With no slot under the cursor the rail used to show charAdvice() — seven
  // sentences about the character sheet. planAdvice() is the same pool plus all
  // 25 slots, already ranked account-wide by damage per meso, which is the
  // question ("what do I do next?") the character-only list could not answer.
  // Nothing is lost: every charAdvice rec is in this list.
  const plan = useMemo(() => planAdvice(ch), [ch]);
  const ranked = useMemo(() => {
    if (sortBy === "eff") return plan; // the engine's own order
    // Compare, never subtract: dmg is absent on unpriced recs and eff can be
    // Infinity, and subtraction on either makes Array.sort's result undefined.
    const desc = (x: number, y: number) => (x === y ? 0 : y > x ? 1 : -1);
    return [...plan].sort((a, b) => desc(a.dmg ?? -1, b.dmg ?? -1));
  }, [plan, sortBy]);
  const recs = slot ? advise(slot, ch) : ranked;
  const shown = slot || showAll ? recs : recs.slice(0, TOP_N);
  const label = STAT_LABEL[ch.main];

  const confsPresent = useMemo(() => {
    const s = new Set<Conf>();
    // Only counts when the panel actually prints a number.
    if (range && range.range.max > 0) s.add(range.conf);
    for (const r of shown) if (r.conf) s.add(r.conf);
    return s;
  }, [shown, range]);

  const items = gearCount(ch);
  const blankSheet = items === 0 && !ch.stats.main && !ch.stats.att;

  /* ---------- the roster -> sheet join, for rendering ---------- */
  const sheets = useMemo(() => {
    const m: Record<string, RosterSheet> = {};
    for (const entry of roster) {
      const id = characterIdForRoster(account, entry.name);
      const who = id ? account.characters[id] : undefined;
      if (id && who) m[rosterKey(entry.name)] = { id, items: gearCount(who) };
    }
    return m;
  }, [account, roster]);
  const activeRosterKey = useMemo(() => {
    const hit = roster.find((e) => characterIdForRoster(account, e.name) === ch.id);
    return hit ? rosterKey(hit.name) : null;
  }, [account, roster, ch.id]);

  const statGroups: Array<[string, Array<[string, keyof CharacterStats]>]> = [
    ["Offense", [[label, "main"], ["Attack", "att"], ["Crit rate %", "crit"], ["Crit dmg %", "critdmg"], ["Boss dmg %", "boss"], ["Ignore DEF %", "ied"]]],
    ["Survivability", [["Max HP", "hp"]]],
    ["Progression", [["Arcane Power", "arcane"], ["Star Force", "starforce"]]],
  ];

  function statClass(k: keyof CharacterStats) {
    const st = ch.stats;
    if (k === "crit" && st.crit >= 100) return "stat ok";
    if (k === "critdmg" && st.critdmg && st.critdmg < 60) return "stat flag";
    if (k === "ied" && st.ied && st.ied < 95) return "stat flag";
    if (k === "hp" && st.hp && st.hp < 60000) return "stat flag";
    if (k === "arcane" && st.arcane && st.arcane < 1320) return "stat flag";
    return "stat";
  }

  /** PRINTED percents, written straight through — 73 means 73%. Clearing the
   *  box DELETES the field rather than writing 0: absent means "no reading",
   *  and a literal 0 would claim a measurement of zero. */
  const setReading = (k: "damagePct" | "finalDamagePct", v: string) => {
    const stats: CharacterStats = { ...ch.stats };
    if (v.trim() === "") delete stats[k];
    else stats[k] = parseFloat(v) || 0;
    update({ ...ch, stats });
  };

  const editItem = editing ? ch.items[editing] : undefined;
  const editSlot = SLOTS.find((s) => s.id === editing);

  return (
    <div className="wrap">
      {/* ---------- who am I editing ----------
          A strip, not a panel: it is the one control that changes what every
          other card on this page is about, so it sits above all of them and
          costs about forty pixels. */}
      <div className="acct">
        <span className="sub-h">Editing</span>
        <div className="chips">
          {chars.map((c) => {
            const on = c.id === ch.id;
            const n = gearCount(c);
            return (
              <button
                key={c.id}
                className={`chip${on ? " on" : ""}`}
                aria-current={on ? "true" : undefined}
                title={`${c.name} — ${c.cls} Lv. ${c.lvl} · ${n} item${n === 1 ? "" : "s"} recorded`}
                onClick={() => select(c.id as string)}
              >
                <b>{c.name}</b>
                <i>{c.cls} · Lv {c.lvl}</i>
                <span className="mono">{n}</span>
              </button>
            );
          })}
          <button className="chip add" onClick={addBlank} title="Start a blank character sheet">
            + New
          </button>
        </div>
        {roster.length > 0 && (
          <a className="acct-jump" href="#roster">Roster ({roster.length}) &darr;</a>
        )}
      </div>

      {/* ---------- the answer, first ----------
          This card used to sit third in the DOM and open with a 721px block of
          hyper stat provenance, which put the first ranked move at y=1049 on a
          1280x800 screen and four screens down on a phone — the research on top
          of the answer. The ranked list now leads; the working (ranking note,
          badge legend, hyper stat verdicts) follows it, one click away. */}
      <section className="card advice">
        <h2>
          {slot ? slot.n : "Best next upgrades"}
          <span className="h2-for">{ch.name}</span>
        </h2>
        <div className="tip">
          {slot && (
            <>
              <div className="tiphead">
                {ch.items[slot.id]?.itemId && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`https://api.maplestory.net/item/${ch.items[slot.id].itemId}/icon`} alt="" />
                )}
                <h3>{ch.items[slot.id]?.name ?? "Empty"}</h3>
                {ch.items[slot.id] && (
                  <>
                    <span className={`tag ${ch.items[slot.id].pot || "none"}`}>
                      {TIER_LABEL[ch.items[slot.id].pot || "none"]}
                    </span>
                    {slot.sf && (
                      <span className="tag plain">
                        ★ {ch.items[slot.id].star || 0}/{sfCap(ch.items[slot.id])}
                      </span>
                    )}
                    {ch.items[slot.id].lvl > 0 && <span className="tag plain">Lv. {ch.items[slot.id].lvl}</span>}
                    {ch.items[slot.id].bossDrop && <span className="tag plain">boss drop</span>}
                  </>
                )}
              </div>
              {(["p", "f"] as const).map((key) => {
                const arr = (ch.items[slot.id]?.[key] || []).filter(Boolean);
                if (!arr.length) return null;
                return (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div className="sub-h">{key === "p" ? "Potential" : "Flame"}</div>
                    <div className="linebox">
                      {arr.map((x, i) => {
                        const dead = isDeadLine(x, ch.main);
                        return (
                          <div className={`line${dead ? " dead" : ""}`} key={i}>
                            <span className="t">{x}</span>
                            {dead && <span className="b">dead</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <div className="sub-h">What to do next</div>
            </>
          )}

          {!slot && (
            <>
              {/* The one sentence that has to be read before a missing
                  percentage reads as a bug. damageModelStatus().why, verbatim. */}
              {!model.verified && (
                <p className="modelnote">
                  <span className="conf-none">Not modelled</span>
                  {model.why}
                </p>
              )}

              {/* Landing on an empty sheet is the COMMON case — 31 characters
                  came off the Switch Character screenshots and one has gear.
                  A blank grid with no explanation reads as broken. */}
              {blankSheet && (
                <div className="startup">
                  <b>Nothing is recorded for {ch.name} yet.</b>
                  <p>
                    {ch.cls} · Lv. {ch.lvl}. The ranked list fills in as soon as this sheet has
                    gear and a stat line. Two ways in, and the screenshots are much faster:
                  </p>
                  <div className="startup-do">
                    <button className="btn p" onClick={() => setImporting(true)}>Import screenshots</button>
                    <button className="btn" onClick={() => setEditing("weapon")}>Add the weapon by hand</button>
                  </div>
                </div>
              )}

              <div className="ranktools">
                <span className="sub-h">
                  {recs.length} move{recs.length === 1 ? "" : "s"} for {ch.name}
                </span>
                <div className="seg" role="group" aria-label="Sort recommendations">
                  <button
                    className={sortBy === "eff" ? "on" : ""}
                    aria-pressed={sortBy === "eff"}
                    onClick={() => setSortBy("eff")}
                  >
                    Per meso
                  </button>
                  <button
                    className={sortBy === "dmg" ? "on" : ""}
                    aria-pressed={sortBy === "dmg"}
                    onClick={() => setSortBy("dmg")}
                  >
                    Raw damage
                  </button>
                </div>
              </div>
            </>
          )}

          {shown.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {shown.map((r, i) => <RecRow r={r} showSlot={!slot} key={i} />)}
            </div>
          ) : (
            <p className="hint">Fill in your stats to get advice.</p>
          )}

          {!slot && recs.length > TOP_N && (
            <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setShowAll(!showAll)}>
              {showAll ? `Show top ${TOP_N}` : `Show all ${recs.length}`}
            </button>
          )}

          {/* ---------- the working, underneath ----------
              The sorting rationale, the confidence legend and the hyper stat
              verdicts are all still here and all still true. They are what you
              read once; the list is what you read every time, so the list gets
              the top of the card. */}
          {!slot && (
            <div className="working">
              <button
                className="dr-more"
                aria-expanded={showWorking}
                onClick={() => setShowWorking((v) => !v)}
              >
                {showWorking ? "Hide" : "Show"} how this list is ranked, what the badges mean,
                and the hyper stat verdicts
              </button>
              {showWorking && (
                <div className="working-in">
                  <p className="railnote">
                    {sortBy === "eff"
                      ? "Ranked by damage per meso with no budget, so a 3M flame roll outranks a 1.5B tier-up on the ratio while being a fiftieth of the step. Flip to raw damage for size."
                      : "Ranked by the size of the gain alone. Cost is ignored here — the top of this list can be the worst value on the page."}
                  </p>
                  <ConfLegend present={confsPresent} />
                  <HyperStats ch={ch} />
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* character */}
      <section className="card who">
        <h2>Character</h2>
        <div className="body">
          <input
            className="nameInput"
            value={ch.name}
            aria-label="Character name"
            onChange={(e) => update({ ...ch, name: e.target.value })}
          />
          {/* Class and level are editable now because a sheet seeded from a
              roster row carries whatever the screenshot said, and a misread
              class is the difference between advice and no advice. */}
          <div className="wholine">
            <input
              className="clsInput"
              value={ch.cls}
              aria-label="Class"
              onChange={(e) => update({ ...ch, cls: e.target.value })}
            />
            <span>Lv.</span>
            <input
              className="lvlInput"
              type="number"
              value={ch.lvl || 0}
              aria-label="Level"
              onChange={(e) => update({ ...ch, lvl: parseInt(e.target.value, 10) || 0 })}
            />
          </div>
          <div className="cp">
            <div className="l">Combat Power</div>
            <div className="v">{ch.cp ? ch.cp.toLocaleString() : "—"}</div>
          </div>
          {/* Damage Range sits directly under Combat Power on purpose: CP is
              Nexon's undocumented formula and we make no claim to reproduce it,
              while Damage Range is a published formula we do compute — so the
              two together are "their number, then the one you can check us on".
              For a class the model has not been measured on, the panel is
              replaced by the reason rather than filled from a fallback. */}
          {range ? (
            <DamageRange ch={ch} d={range} />
          ) : (
            <UnmodelledDamage why={model.why} verified={model.verifiedClasses} />
          )}
          {statGroups.map(([group, rows]) => (
            <div key={group}>
              <div className="statgroup">{group}</div>
              {rows.map(([lbl, key]) => (
                <div className={statClass(key)} key={key}>
                  <span className="k">{lbl}</span>
                  <input
                    type="number"
                    value={ch.stats[key] || 0}
                    aria-label={lbl}
                    onChange={(e) =>
                      update({ ...ch, stats: { ...ch.stats, [key]: parseFloat(e.target.value) || 0 } })
                    }
                  />
                </div>
              ))}
            </div>
          ))}

          {/* The two readings the stat window prints and the sheet had nowhere
              to put. Only offered for a class the model can actually use them
              on — anywhere else they would be data collected for nothing. */}
          {model.verified && (
            <div>
              <div className="statgroup">Stat window readings</div>
              {([
                ["Damage %", "damagePct"],
                ["Final damage %", "finalDamagePct"],
              ] as Array<[string, "damagePct" | "finalDamagePct"]>).map(([lbl, key]) => (
                <div className="stat" key={key}>
                  <span className="k">{lbl}</span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="—"
                    value={ch.stats[key] ?? ""}
                    aria-label={lbl}
                    onChange={(e) => setReading(key, e.target.value)}
                  />
                </div>
              ))}
              <p className="fineprint">
                Typed exactly as the game prints them — 73 means 73%, and FINAL DAMAGE 115.79
                means 115.79. Leave a box empty for &ldquo;not read&rdquo;; a zero would claim a
                measurement of zero.
              </p>
            </div>
          )}

          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn p" onClick={() => setImporting(true)}>Import screenshots</button>
            <button className="btn" onClick={loadDemo}>Demo</button>
            <button
              className="btn"
              title="Clear this character's gear and stats. The sheet, its name and its roster link stay."
              onClick={() =>
                update({ ...emptyCharacter(), id: ch.id, name: ch.name, cls: ch.cls, main: ch.main, lvl: ch.lvl })
              }
            >
              Clear gear
            </button>
            {chars.length > 1 && (
              <button
                className="btn"
                title={`Remove ${ch.name} from this account`}
                onClick={() => {
                  const gone = ch.name;
                  commit(removeCharacter(account, ch.id as string));
                  setNote(`Removed ${gone} from the account.`);
                }}
              >
                Remove
              </button>
            )}
          </div>
          {ready && (
            <p className="fineprint" style={{ marginTop: 8 }}>
              {chars.length} character{chars.length === 1 ? "" : "s"} saved to this browser.
              Accounts coming.
            </p>
          )}
        </div>
      </section>

      {/* equipment */}
      <section className="card eq">
        <h2>
          Equipment
          <span className="h2-for">{ch.name} · {items} item{items === 1 ? "" : "s"}</span>
        </h2>
        <div className="eqwin">
          {items === 0 && (
            <p className="eq-empty">
              No gear recorded for {ch.name}. Click any slot to enter an item, or{" "}
              <button className="linkish" onClick={() => setImporting(true)}>import screenshots</button>.
            </p>
          )}
          <div className="grid-eq" onMouseLeave={() => setHover(null)}>
            {SLOTS.map((s) => {
              const it = ch.items[s.id];
              const urgent = it ? advise(s, ch).some((r) => r.lv === "hi") : false;
              return (
                <button
                  key={s.id}
                  className={`slot${it ? "" : " empty"}`}
                  style={{ gridColumn: s.c, gridRow: s.r }}
                  title={it ? `${it.name} — click to edit` : `${s.n} — empty, click to add`}
                  onMouseEnter={() => setHover(s.id)}
                  onFocus={() => setHover(s.id)}
                  onClick={() => setEditing(s.id)}
                >
                  {it && s.pot !== "no" && <span className={`slot-tier ${it.pot || "none"}`} />}
                  {/* Database sprite first — it's pixel perfect. The screenshot
                      crop is only a fallback for items the database can't match. */}
                  {it?.itemId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="slot-icon" src={`https://api.maplestory.net/item/${it.itemId}/icon`} alt={it.name} />
                  ) : it?.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="slot-icon" src={it.icon} alt={it.name} />
                  ) : it ? (
                    <span className="slot-abbr">{it.name}</span>
                  ) : (
                    <span className="slot-label">{s.n}</span>
                  )}
                  {it && s.sf && (
                    <span className={`slot-star${(it.star || 0) === 0 ? " zero" : ""}`}>★{it.star || 0}</span>
                  )}
                  {urgent && <span className="slot-alert" />}
                </button>
              );
            })}
          </div>
          <div className="eq-legend">
            <span><i style={{ background: "var(--leg)" }} />Legendary</span>
            <span><i style={{ background: "var(--uni)" }} />Unique</span>
            <span><i style={{ background: "var(--epi)" }} />Epic</span>
            <span><i style={{ background: "var(--rar)" }} />Rare</span>
            <span><i style={{ background: "var(--bad)", borderRadius: "50%" }} />Needs attention</span>
          </div>
        </div>
      </section>

      {roster.length > 0 && (
        <Roster
          chars={roster}
          sheets={sheets}
          activeKey={activeRosterKey}
          onOpen={openRoster}
          onClear={() => commit(setRoster(account, undefined))}
        />
      )}

      {note && (
        <div className="toast" role="status">
          <span>{note}</span>
          <button aria-label="Dismiss" onClick={() => setNote(null)}>×</button>
        </div>
      )}

      {importing && (
        <ImportDialog
          target={{ name: ch.name, cls: ch.cls, lvl: ch.lvl, items }}
          onClose={() => setImporting(false)}
          onApply={(entries, patch, incoming) => {
            const nextItems = { ...ch.items };
            for (const e of entries) nextItems[e.slot] = e.item;

            // Only overwrite what the stat window actually yielded.
            const next: Character = { ...ch, items: nextItems };
            if (patch) {
              if (patch.name) next.name = patch.name;
              if (patch.cls) next.cls = patch.cls;
              if (patch.lvl) next.lvl = patch.lvl;
              if (patch.cp) next.cp = patch.cp;
              const s: CharacterStats = { ...ch.stats };
              (["main", "att", "crit", "critdmg", "boss", "ied", "hp", "arcane", "starforce"] as const)
                .forEach((k) => { if (patch[k] !== undefined) s[k] = patch[k] as number; });
              next.stats = s;
            }

            // The roster is ACCOUNT data, so it goes through setRoster() rather
            // than onto the character. Merge rather than replace: the Switch
            // Character window is paginated, so uploading page 2 must not
            // discard page 1.
            let acc = withActiveCharacter(account, next);
            if (incoming?.length) acc = setRoster(acc, mergeRoster(roster, incoming));
            commit(acc);

            setImporting(false);
            setHover(entries[entries.length - 1]?.slot ?? null);
            const bits = [
              entries.length ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : null,
              patch ? "the stat line" : null,
              incoming?.length ? `${incoming.length} roster entries` : null,
            ].filter(Boolean).join(" + ");
            setNote(`Applied ${bits || "nothing"} to ${next.name}.`);
          }}
        />
      )}

      {editing && editSlot && (
        <ItemEditor
          who={ch.name}
          slot={editSlot}
          item={editItem}
          onCancel={() => setEditing(null)}
          onSave={(next) => {
            const nextItems = { ...ch.items };
            if (next) nextItems[editing] = next;
            else delete nextItems[editing];
            update({ ...ch, items: nextItems });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ItemEditor({
  who, slot, item, onSave, onCancel,
}: {
  /** Named in the header and on the save button. An item editor with no owner
   *  on it is how gear ends up on the wrong sheet. */
  who: string;
  slot: SlotDef;
  item?: Item;
  onSave: (i: Item | null) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<Item>(
    item ?? { name: "", lvl: 0, star: 0, pot: "none", sup: 0, p: ["", "", ""], f: ["", "", ""] }
  );
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCancel]);

  const setLine = (k: "p" | "f", i: number, v: string) => {
    const arr = [...(f[k] || ["", "", ""])];
    arr[i] = v;
    setF({ ...f, [k]: arr });
  };

  return (
    <div className="ed-back" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="ed-in">
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 15px", borderBottom: "1px solid var(--line)" }}>
          <h3 style={{ fontSize: "1rem", marginRight: "auto" }}>
            {slot.n}
            <span className="h3-for">on {who}</span>
          </h3>
          <button className="btn" onClick={() => onSave(null)}>Empty slot</button>
        </div>

        <div style={{ padding: "14px 15px", display: "flex", flexDirection: "column", gap: 13 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="fld">
              <label htmlFor="i-name">Item name</label>
              <ItemSearch
                value={f.name}
                onText={(v) => setF({ ...f, name: v })}
                onPick={(h: ItemHit) =>
                  setF({
                    ...f,
                    name: h.name,
                    lvl: h.level || f.lvl,
                    sup: h.superior ? 1 : f.sup,
                    itemId: h.itemId,
                    bossDrop: h.bossDrop,
                  })
                }
              />
            </div>
            <div className="fld">
              <label htmlFor="i-lvl">Item level</label>
              <input id="i-lvl" type="number" value={f.lvl || ""} placeholder="150"
                onChange={(e) => setF({ ...f, lvl: parseInt(e.target.value, 10) || 0 })} />
            </div>
          </div>

          {/* The game states these per item, not per slot, and the vision read
              misses the line often enough to be worth a manual override. */}
          <div className="fld">
            <label>Can&apos;t enhance</label>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: ".78rem" }}>
              {([["noSf", "Star force"], ["noFl", "Bonus stats"], ["noPot", "Potential"]] as const).map(([k, lbl]) => (
                <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                  <input type="checkbox" checked={!!f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />
                  {lbl}
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div className="fld">
              <label htmlFor="i-star">Star force</label>
              <input id="i-star" type="number" min={0} max={30} value={f.star || 0}
                onChange={(e) => setF({ ...f, star: parseInt(e.target.value, 10) || 0 })} />
            </div>
            <div className="fld">
              <label htmlFor="i-pot">Potential</label>
              <select id="i-pot" value={f.pot} onChange={(e) => setF({ ...f, pot: e.target.value as Tier })}>
                {(["none", "rare", "epic", "unique", "legendary"] as Tier[]).map((t) => (
                  <option key={t} value={t}>{TIER_LABEL[t]}</option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="i-sup">Superior?</label>
              <select id="i-sup" value={f.sup} onChange={(e) => setF({ ...f, sup: Number(e.target.value) as 0 | 1 })}>
                <option value={0}>No</option>
                <option value={1}>Yes (Tyrant/Gollux)</option>
              </select>
            </div>
          </div>

          {(["p", "f"] as const).map((k) => (
            <div className="fld" key={k}>
              <label>{k === "p" ? "Potential lines" : "Flame / bonus stats"}</label>
              {[0, 1, 2].map((i) => (
                <input
                  key={i}
                  value={(f[k] || [])[i] || ""}
                  placeholder={k === "p" ? "DEX +9%" : "All Stats +5%"}
                  style={{ marginTop: i ? 6 : 0 }}
                  onChange={(e) => setLine(k, i, e.target.value)}
                />
              ))}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: "12px 15px", borderTop: "1px solid var(--line)" }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn p" onClick={() => onSave(f.name.trim() ? f : null)}>
            Save to {who}
          </button>
        </div>
      </div>
    </div>
  );
}
