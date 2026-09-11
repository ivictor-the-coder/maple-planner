"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SLOTS, TIER_LABEL, STAT_LABEL, advise, charAdvice, emptyCharacter,
  exampleCharacter, isDeadLine, sfCap,
  type Character, type Item, type Rec, type SlotDef, type Tier,
} from "@/lib/rules";
import { getStore } from "@/lib/storage";
import ImportDialog from "@/components/ImportDialog";
import ItemSearch from "@/components/ItemSearch";
import type { ItemHit } from "@/app/api/items/route";

const PRI_LABEL = ["", "NOW", "SOON", "LATER", "DONE"];

function RecRow({ r }: { r: Rec }) {
  return (
    <div className={`rec ${r.lv}`}>
      <span className="p">{PRI_LABEL[r.pri]}</span>
      <span>
        <b>{r.t}</b>
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
  const store = useMemo(() => getStore(), []);

  useEffect(() => {
    let live = true;
    store.load().then((saved) => {
      if (live && saved) setCh(saved);
      if (live) setReady(true);
    });
    return () => { live = false; };
  }, [store]);

  const update = useCallback((next: Character) => {
    setCh(next);
    void store.save(next);
  }, [store]);

  const slot = SLOTS.find((s) => s.id === hover) || null;
  const recs = slot ? advise(slot, ch) : charAdvice(ch);
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
            <button className="btn p" onClick={() => setImporting(true)}>Import tooltip</button>
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
                  {it?.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="slot-icon" src={it.icon} alt={it.name} />
                  ) : it?.itemId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="slot-icon" src={`https://api.maplestory.net/item/${it.itemId}/icon`} alt={it.name} />
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
        <h2>{slot ? slot.n : "Character"}</h2>
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
          {recs.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {recs.map((r, i) => <RecRow r={r} key={i} />)}
            </div>
          ) : (
            <p className="hint">Fill in your stats to get advice.</p>
          )}
        </div>
      </section>

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onApply={(entries) => {
            const items = { ...ch.items };
            for (const e of entries) items[e.slot] = e.item;
            update({ ...ch, items });
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
