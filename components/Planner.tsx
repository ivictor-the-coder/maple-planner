"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CONFIDENCE_VOCABULARY, SLOTS, TIER_LABEL, STAT_LABEL, advise,
  emptyCharacter, exampleCharacter, isDeadLine, planAdvice, sfCap,
  type Character, type Conf, type Item, type Rec, type SlotDef, type Tier,
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
import { getStore } from "@/lib/storage";
import { resolveItem } from "@/lib/itemLookup";
import { mergeRoster } from "@/lib/legion";
import ImportDialog from "@/components/ImportDialog";
import ItemSearch from "@/components/ItemSearch";
import Roster from "@/components/Roster";
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
 * WEAPON_MULTIPLIER[weaponKey] out of the module rather than naming a figure. */
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

export default function Planner() {
  const [ch, setCh] = useState<Character>(() => exampleCharacter());
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [ready, setReady] = useState(false);
  // Damage per meso is the right axis and the wrong answer to "what next?" when
  // the player has no budget: a 3M flame roll beats a 1.5B tier-up on the ratio
  // while being a fiftieth of the step. The engine has no budget input yet, so
  // the honest stopgap is to let the reader flip the axis rather than to pick
  // one and hide the other.
  const [sortBy, setSortBy] = useState<"eff" | "dmg">("eff");
  const [showAll, setShowAll] = useState(false);
  const store = useMemo(() => getStore(), []);

  useEffect(() => {
    let live = true;
    store.load().then((saved) => {
      if (live && saved) setCh(saved);
      if (live) setReady(true);
    });
    return () => { live = false; };
  }, [store]);

  // Items saved before the database lookup existed carry a name but no
  // itemId, so the grid had no sprite to draw and fell back to rendering the
  // name as text. Resolve them once in the background rather than making the
  // user re-import gear that is already correct.
  const backfilled = useRef(false);
  useEffect(() => {
    if (!ready || backfilled.current) return;
    const missing = Object.entries(ch.items).filter(([, it]) => it?.name && !it.itemId);
    backfilled.current = true;
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
      if (live && changed) {
        const next = { ...ch, items };
        setCh(next);
        void store.save(next);
      }
    })();
    return () => { live = false; };
  }, [ready, ch, store]);

  const update = useCallback((next: Character) => {
    setCh(next);
    void store.save(next);
  }, [store]);

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

  // One computation of the range, shared by the panel that prints it and the
  // legend that has to know which confidence tiers this page actually uses.
  const range = useMemo(() => damageRangeFor(ch), [ch]);
  const confsPresent = useMemo(() => {
    const s = new Set<Conf>();
    // Only counts when the panel actually prints a number.
    if (range.range.max > 0) s.add(range.conf);
    for (const r of shown) if (r.conf) s.add(r.conf);
    return s;
  }, [shown, range]);

  const statGroups: Array<[string, Array<[string, keyof Character["stats"]]>]> = [
    ["Offense", [[label, "main"], ["Attack", "att"], ["Crit rate %", "crit"], ["Crit dmg %", "critdmg"], ["Boss dmg %", "boss"], ["Ignore DEF %", "ied"]]],
    ["Survivability", [["Max HP", "hp"]]],
    ["Progression", [["Arcane Power", "arcane"], ["Star Force", "starforce"]]],
  ];

  function statClass(k: keyof Character["stats"]) {
    const st = ch.stats;
    if (k === "crit" && st.crit >= 100) return "stat ok";
    if (k === "critdmg" && st.critdmg && st.critdmg < 60) return "stat flag";
    if (k === "ied" && st.ied && st.ied < 95) return "stat flag";
    if (k === "hp" && st.hp && st.hp < 60000) return "stat flag";
    if (k === "arcane" && st.arcane && st.arcane < 1320) return "stat flag";
    return "stat";
  }

  const editItem = editing ? ch.items[editing] : undefined;
  const editSlot = SLOTS.find((s) => s.id === editing);

  return (
    <div className="wrap">
      {/* character */}
      <section className="card">
        <h2>Character</h2>
        <div className="body">
          <input
            className="nameInput"
            value={ch.name}
            aria-label="Character name"
            onChange={(e) => update({ ...ch, name: e.target.value })}
          />
          <p style={{ fontSize: ".76rem", color: "var(--ink-3)", margin: "3px 0 11px" }}>
            {ch.cls} · Lv. {ch.lvl}
          </p>
          <div className="cp">
            <div className="l">Combat Power</div>
            <div className="v">{ch.cp ? ch.cp.toLocaleString() : "—"}</div>
          </div>
          {/* Damage Range sits directly under Combat Power on purpose: CP is
              Nexon's undocumented formula and we make no claim to reproduce it,
              while Damage Range is a published formula we do compute — so the
              two together are "their number, then the one you can check us on". */}
          <DamageRange ch={ch} d={range} />
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
          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn p" onClick={() => setImporting(true)}>Import screenshots</button>
            <button className="btn" onClick={() => update(exampleCharacter())}>Example</button>
            <button className="btn" onClick={() => update(emptyCharacter())}>Clear</button>
          </div>
          {ready && (
            <p style={{ fontSize: ".68rem", color: "var(--ink-3)", marginTop: 8 }}>
              Saved to this browser. Accounts coming.
            </p>
          )}
        </div>
      </section>

      {/* equipment */}
      <section className="card">
        <h2>Equipment</h2>
        <div className="eqwin">
          <div className="grid-eq" onMouseLeave={() => setHover(null)}>
            {SLOTS.map((s) => {
              const it = ch.items[s.id];
              const urgent = it ? advise(s, ch).some((r) => r.lv === "hi") : false;
              return (
                <button
                  key={s.id}
                  className={`slot${it ? "" : " empty"}`}
                  style={{ gridColumn: s.c, gridRow: s.r }}
                  title={it ? `${it.name} — click to edit` : `${s.n} — empty`}
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

      {/* advice */}
      <section className="card">
        <h2>{slot ? slot.n : "Best next upgrades"}</h2>
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
              <HyperStats ch={ch} />
              <div className="ranktools">
                <span className="sub-h">
                  {recs.length} move{recs.length === 1 ? "" : "s"}, account-wide
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
              <p className="railnote">
                {sortBy === "eff"
                  ? "Ranked by damage per meso with no budget, so a 3M flame roll outranks a 1.5B tier-up on the ratio while being a fiftieth of the step. Flip to raw damage for size."
                  : "Ranked by the size of the gain alone. Cost is ignored here — the top of this list can be the worst value on the page."}
              </p>
              <ConfLegend present={confsPresent} />
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
        </div>
      </section>

      {ch.roster?.length ? (
        <Roster
          chars={ch.roster}
          onClear={() => update({ ...ch, roster: undefined })}
        />
      ) : null}

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onApply={(entries, patch, roster) => {
            const items = { ...ch.items };
            for (const e of entries) items[e.slot] = e.item;

            // Only overwrite what the stat window actually yielded.
            const next: Character = { ...ch, items };
            if (patch) {
              if (patch.name) next.name = patch.name;
              if (patch.cls) next.cls = patch.cls;
              if (patch.lvl) next.lvl = patch.lvl;
              if (patch.cp) next.cp = patch.cp;
              const s = { ...ch.stats };
              (["main", "att", "crit", "critdmg", "boss", "ied", "hp", "arcane", "starforce"] as const)
                .forEach((k) => { if (patch[k] !== undefined) s[k] = patch[k] as number; });
              next.stats = s;
            }
            // Merge rather than replace: the Switch Character window is
            // paginated, so uploading page 2 must not discard page 1.
            if (roster?.length) next.roster = mergeRoster(ch.roster ?? [], roster);

            update(next);
            setImporting(false);
            setHover(entries[entries.length - 1]?.slot ?? null);
          }}
        />
      )}

      {editing && editSlot && (
        <ItemEditor
          slot={editSlot}
          item={editItem}
          onCancel={() => setEditing(null)}
          onSave={(next) => {
            const items = { ...ch.items };
            if (next) items[editing] = next;
            else delete items[editing];
            update({ ...ch, items });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ItemEditor({
  slot, item, onSave, onCancel,
}: {
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
          <h3 style={{ fontSize: "1rem", marginRight: "auto" }}>{slot.n}</h3>
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
          <button className="btn p" onClick={() => onSave(f.name.trim() ? f : null)}>Save</button>
        </div>
      </div>
    </div>
  );
}
