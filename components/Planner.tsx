"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CONFIDENCE_VOCABULARY, SLOTS, TIER_LABEL, STAT_LABEL, advise,
  emptyCharacter, exampleCharacter, isDeadLine, planAdvice, sfCap,
  type Character, type Conf, type Item, type Rec, type SlotDef, type Tier,
} from "@/lib/rules";
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

function ConfLegend() {
  return (
    <div className="conf-legend">
      {CONFIDENCE_VOCABULARY.map((v) => (
        <span key={v.conf}>
          <span className={`conf ${v.conf}`}>{v.badge}</span>
          {v.meaning}
        </span>
      ))}
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
              <ConfLegend />
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
