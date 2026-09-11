"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseTooltip, type ParsedItem } from "@/lib/import/tooltip";
import { SLOTS, TIER_LABEL, type Item } from "@/lib/rules";
import { mergeRoster, rankOf, type RosterChar } from "@/lib/legion";
import { resolveItem } from "@/lib/itemLookup";

const MAX_FILES = 10;
/** In-flight requests. All ten at once trips the provider's rate limit; one at
 *  a time makes ten screenshots a 45-second wait. Three is the compromise. */
const CONCURRENCY = 3;
/** Stagger worker starts so the first three don't land on the same instant. */
const STAGGER_MS = 400;

export interface ImportEntry {
  id: number;
  parsed: ParsedItem;
  slot: string;
  include: boolean;
  via: string;
}

/** Whatever the stat window yielded. Every field is optional — the model omits
 *  anything it couldn't see, and we only overwrite what actually came back. */
export interface StatsPatch {
  name?: string; cls?: string; lvl?: number; cp?: number;
  main?: number; att?: number; crit?: number; critdmg?: number;
  boss?: number; ied?: number; hp?: number; arcane?: number; starforce?: number;
}

const STAT_LABELS: Array<[keyof StatsPatch, string]> = [
  ["name", "Name"], ["cls", "Class"], ["lvl", "Level"], ["cp", "Combat Power"],
  ["main", "Main stat"], ["att", "Attack"], ["crit", "Crit rate"], ["critdmg", "Crit damage"],
  ["boss", "Boss damage"], ["ied", "Ignore DEF"], ["hp", "Max HP"],
  ["arcane", "Arcane Power"], ["starforce", "Star Force"],
];

/** Slots that come in interchangeable sets: ring1..ring4, pendant1..pendant2.
 *  Derived from SLOTS rather than hardcoded, so a future numbered family is
 *  covered without touching this. Returns [] for a one-of-a-kind slot. */
function familyOf(slot: string): string[] {
  const base = slot.replace(/\d+$/, "");
  if (base === slot) return [];
  return SLOTS.filter((s) => s.id.replace(/\d+$/, "") === base).map((s) => s.id);
}

/** Crop the item's icon out of the screenshot so the grid can show the real
 *  sprite even for items the item database doesn't match. Box is normalised. */
function cropIcon(img: HTMLImageElement, box: number[], size = 72): string | undefined {
  if (!Array.isArray(box) || box.length !== 4) return undefined;
  let [x, y, w, h] = box.map(Number);
  if (![x, y, w, h].every(Number.isFinite)) return undefined;
  // tolerate a model returning pixels instead of 0-1
  if (w > 1.5 || h > 1.5) {
    x /= img.width; y /= img.height; w /= img.width; h /= img.height;
  }
  if (w <= 0.002 || h <= 0.002 || w > 0.6 || h > 0.6) return undefined;
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));

  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return undefined;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    img,
    Math.round(x * img.width), Math.round(y * img.height),
    Math.round(w * img.width), Math.round(h * img.height),
    0, 0, size, size
  );
  return c.toDataURL("image/png");
}

function loadImage(file: File | Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => { setTimeout(() => URL.revokeObjectURL(url), 5000); res(i); };
    i.onerror = () => rej(new Error("That file could not be read as an image."));
    i.src = url;
  });
}

function toDataUrl(img: HTMLImageElement, max = 2000): string {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.92);
}

export default function ImportDialog({
  onApply,
  onClose,
}: {
  onApply: (entries: Array<{ slot: string; item: Item }>, stats?: StatsPatch, roster?: RosterChar[]) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"shot" | "text">("shot");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<{ done: number; total: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ImportEntry[]>([]);
  const [fails, setFails] = useState<Array<{ name: string; why: string }>>([]);
  const [stats, setStats] = useState<StatsPatch | null>(null);
  const [useStats, setUseStats] = useState(true);
  const [roster, setRoster] = useState<RosterChar[]>([]);
  const [useRoster, setUseRoster] = useState(true);
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const add = useCallback((parsed: ParsedItem, via: string) => {
    setEntries((prev) => {
      // An item tooltip cannot say WHICH ring you were hovering — every ring
      // reads as "ring" and resolves to ring1. Importing four of them used to
      // stack all four on ring1, where each overwrote the last and three were
      // silently lost. Spread them across the free slots in the family instead.
      const want = parsed.slotGuess ?? "hat";
      const taken = new Set(prev.map((e) => e.slot));
      const slot = taken.has(want) ? (familyOf(want).find((id) => !taken.has(id)) ?? want) : want;
      return [...prev, { id: nextId.current++, parsed, slot, include: true, via }];
    });
  }, []);

  /** One image, read by the vision route.
   *  There is deliberately no local-OCR fallback: tesseract never once read a
   *  real tooltip correctly, and running it on a full-size screenshot took
   *  minutes. A clear error beats a spinner that never ends. */
  const readOne = useCallback(async (file: File | Blob): Promise<{ parsed?: ParsedItem; stats?: StatsPatch; roster?: RosterChar[]; via: string } | string> => {
    let img: HTMLImageElement;
    try {
      img = await loadImage(file);
    } catch {
      return "Not a readable image.";
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 75_000);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: toDataUrl(img) }),
      });
      const j = await res.json();

      // A shot may hold a tooltip, the stat window, the Switch Character list,
      // or any combination — the Switch Character list never has a tooltip.
      if (res.ok && !j.item?.name && (j.stats || j.roster)) {
        return { via: j.model, stats: j.stats as StatsPatch | undefined, roster: j.roster as RosterChar[] | undefined };
      }

      if (res.ok && j.item?.name) {
        const p: string[] = j.item.p ?? [];
        const f: string[] = j.item.f ?? [];
        const icon = j.iconBox ? cropIcon(img, j.iconBox) : undefined;

        // A cropped screenshot region is never as clean as the real sprite, and
        // the model's boxes are loose. If the item database knows this item by
        // name, take its icon and metadata instead.
        // The database gives a pixel-perfect sprite plus real metadata, and
        // it repairs a misread name when the closest entry is unambiguous -
        // "Iffa's Ring" is one transposed letter from the real "Ifia's Ring".
        const db = await resolveItem(String(j.item.name), j.slotGuess ?? undefined);

        const warnings: string[] = [];
        if (!j.item.star) warnings.push("Star force came back 0 — check it.");
        if (!db) warnings.push("No database match, so no sprite. Check the spelling of the name.");
        else if (db.corrected) warnings.push(`Name corrected to "${db.name}".`);

        return {
          via: j.model,
          stats: j.stats as StatsPatch | undefined,
          roster: j.roster as RosterChar[] | undefined,
          parsed: {
            item: {
              ...j.item,
              name: db?.name ?? j.item.name,
              icon,
              itemId: db?.itemId,
              bossDrop: db?.bossDrop,
              sub: db?.sub,
              // The database level is authoritative. The model reading "Lv. 95"
              // off an item that is really Lv. 110 is what produced star counts
              // above the item's own cap.
              lvl: db?.level || j.item.lvl,
              sup: j.item.sup || (db?.superior ? 1 : 0),
              p: [p[0] ?? "", p[1] ?? "", p[2] ?? ""],
              f: [f[0] ?? "", f[1] ?? "", f[2] ?? ""],
            },
            slotGuess: j.slotGuess ?? null,
            found: {
              name: !!j.item.name, lvl: j.item.lvl > 0, pot: j.item.pot !== "none",
              potLines: p.filter(Boolean).length, flameLines: f.filter(Boolean).length,
              superior: !!j.item.sup,
            },
            warnings,
            raw: "",
          },
        };
      }
      return (j.error as string) || `Import failed (HTTP ${res.status}).`;
    } catch (e) {
      return (e as Error)?.name === "AbortError"
        ? "Timed out waiting for a vision model. Free endpoints are slow when busy — try again."
        : "Could not reach the import service.";
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const runFiles = useCallback(async (files: File[]) => {
    const room = MAX_FILES - entries.length;
    if (room <= 0) { setError(`That's the limit of ${MAX_FILES} screenshots.`); return; }
    const batch = files.slice(0, room);
    if (files.length > room) setError(`Only the first ${room} were taken — limit is ${MAX_FILES}.`);
    else setError(null);

    setBusy(true);
    setFails([]);

    // A few at a time rather than one after another. All ten at once trips the
    // provider's rate limit — that's what made nine of ten come back empty —
    // but three in flight is both fast and well under it. Each result lands in
    // the list the moment it arrives instead of waiting for the whole batch.
    let done = 0;
    let cursor = 0;
    setStep({ done: 0, total: batch.length, label: "" });

    const worker = async (lane: number) => {
      await new Promise((res) => setTimeout(res, lane * STAGGER_MS));
      for (;;) {
        const i = cursor++;
        if (i >= batch.length) return;
        const r = await readOne(batch[i]);
        if (typeof r === "string") {
          setFails((prev) => [...prev, { name: batch[i].name || `Screenshot ${i + 1}`, why: r }]);
        } else {
          if (r.stats) setStats((prev) => ({ ...(prev ?? {}), ...r.stats }));
          if (r.roster?.length) setRoster((prev) => mergeRoster(prev, r.roster!));
          if (r.parsed) add(r.parsed, r.via);
        }
        done++;
        setStep({ done, total: batch.length, label: "" });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batch.length) }, (_, lane) => worker(lane))
    );

    setStep(null);
    setBusy(false);
  }, [entries.length, readOne, add]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (tab !== "shot" || busy) return;
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length) { e.preventDefault(); void runFiles(files); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [tab, busy, runFiles]);

  const patch = (id: number, p: Partial<ImportEntry>) =>
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...p } : e)));

  const chosen = entries.filter((e) => e.include);
  const dupes = new Set(
    chosen.map((e) => e.slot).filter((s, i, a) => a.indexOf(s) !== i)
  );

  return (
    <div className="ed-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ed-in" style={{ maxWidth: 720 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 15px", borderBottom: "1px solid var(--line)" }}>
          <h3 style={{ fontSize: "1rem", marginRight: "auto" }}>
            Import from screenshots {entries.length > 0 && <span className="mono" style={{ color: "var(--ink-3)", fontSize: ".72rem" }}>{entries.length}/{MAX_FILES}</span>}
          </h3>
          <button className={`btn${tab === "shot" ? " p" : ""}`} onClick={() => setTab("shot")}>Screenshots</button>
          <button className={`btn${tab === "text" ? " p" : ""}`} onClick={() => setTab("text")}>Paste text</button>
        </div>

        <div style={{ padding: "14px 15px", display: "flex", flexDirection: "column", gap: 13, maxHeight: "64vh", overflowY: "auto" }}>
          {tab === "shot" && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = Array.from(e.dataTransfer.files ?? []); if (f.length) void runFiles(f); }}
              onClick={() => !busy && fileRef.current?.click()}
              style={{
                border: "1px dashed var(--line)", borderRadius: 3, padding: "26px 16px",
                textAlign: "center", cursor: busy ? "default" : "pointer", background: "var(--well)",
              }}
            >
              <p style={{ margin: 0, fontSize: ".9rem" }}>
                {busy && step
                  ? `Reading ${step.done + 1} of ${step.total}…`
                  : `Drop up to ${MAX_FILES} screenshots, paste with Ctrl/Cmd+V, or click to pick files`}
              </p>
              <p style={{ margin: "6px 0 0", fontSize: ".76rem", color: "var(--ink-3)" }}>
                Full screenshots are fine — no cropping needed. One item tooltip visible per shot.
              </p>
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) void runFiles(f); e.target.value = ""; }} />

          {tab === "text" && (
            <div className="fld">
              <label htmlFor="paste">Tooltip text</label>
              <textarea id="paste" rows={8} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={"Royal Ranger Beret\nArmor\nHat\nRequired Level Lv. 150\n…"}
                style={{ fontFamily: "var(--font-jetbrains), monospace", fontSize: ".8rem" }} />
              <button className="btn p" style={{ alignSelf: "flex-start", marginTop: 8 }}
                disabled={text.trim().length < 10 || entries.length >= MAX_FILES}
                onClick={() => { add(parseTooltip(text), "pasted text"); setText(""); }}>
                Parse and add
              </button>
            </div>
          )}

          {error && (
            <p style={{ margin: 0, fontSize: ".8rem", color: "var(--bad)", background: "var(--well)", borderLeft: "2px solid var(--bad)", padding: "9px 12px" }}>
              {error}
            </p>
          )}

          {stats && (
            <>
              <div className="sub-h">Character stats found</div>
              <div style={{
                background: "var(--well)", border: `1px solid ${useStats ? "var(--gold)" : "var(--line-soft)"}`,
                borderRadius: 3, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7,
                opacity: useStats ? 1 : 0.45,
              }}>
                <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: ".85rem", fontWeight: 600 }}>
                  <input type="checkbox" checked={useStats} onChange={(e) => setUseStats(e.target.checked)} />
                  Update the character panel with these
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: "3px 14px" }}>
                  {STAT_LABELS.filter(([k]) => stats[k] !== undefined && stats[k] !== "").map(([k, label]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: ".76rem" }}>
                      <span style={{ color: "var(--ink-3)" }}>{label}</span>
                      <span className="mono">{typeof stats[k] === "number" ? (stats[k] as number).toLocaleString() : String(stats[k])}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {roster.length > 0 && (
            <>
              <div className="sub-h">Characters found ({roster.length})</div>
              <div style={{
                background: "var(--well)", border: `1px solid ${useRoster ? "var(--gold)" : "var(--line-soft)"}`,
                borderRadius: 3, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8,
                opacity: useRoster ? 1 : 0.45,
              }}>
                <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: ".85rem", fontWeight: 600 }}>
                  <input type="checkbox" checked={useRoster} onChange={(e) => setUseRoster(e.target.checked)} />
                  Build the Legion roster from these
                </label>
                <p style={{ margin: 0, fontSize: ".74rem", color: "var(--ink-3)" }}>
                  The Switch Character window is paginated — add a shot of each page and they merge.
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: "3px 14px" }}>
                  {roster.map((c) => (
                    <div key={c.name} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: ".76rem" }}>
                      <span className="mono" style={{ color: "var(--gold)", minWidth: 34 }}>{c.lvl}</span>
                      <span style={{ color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                      <span className="mono" style={{ marginLeft: "auto", color: "var(--ink-3)" }}>{rankOf(c.lvl)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {fails.length > 0 && (
            <>
              <div className="sub-h">Couldn&apos;t read ({fails.length})</div>
              {fails.map((f, i) => (
                <div key={i} style={{
                  background: "var(--well)", borderLeft: "2px solid var(--bad)",
                  borderRadius: "0 3px 3px 0", padding: "8px 11px", fontSize: ".78rem",
                }}>
                  <b style={{ color: "var(--ink-2)" }}>{f.name}</b>
                  <span style={{ display: "block", color: "var(--ink-3)", marginTop: 2 }}>{f.why}</span>
                </div>
              ))}
            </>
          )}

          {entries.length > 0 && (
            <>
              <div className="sub-h">Check these before applying</div>
              {entries.map((e) => {
                const it = e.parsed.item;
                const clash = e.include && dupes.has(e.slot);
                return (
                  <div key={e.id} style={{
                    background: "var(--well)", border: `1px solid ${clash ? "var(--warn)" : "var(--line-soft)"}`,
                    borderRadius: 3, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7,
                    opacity: e.include ? 1 : 0.45,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                      <input type="checkbox" checked={e.include} aria-label="Include this item"
                        onChange={(ev) => patch(e.id, { include: ev.target.checked })} />
                      <b style={{ fontSize: ".88rem", color: e.parsed.found.name ? "var(--ink)" : "var(--warn)" }}>
                        {it.name || "— name not read —"}
                      </b>
                      <span className={`tag ${it.pot || "none"}`}>{TIER_LABEL[it.pot || "none"]}</span>
                      <span className="tag plain">{it.lvl ? `Lv. ${it.lvl}` : "Lv. ?"}</span>
                      {/* Star force is the least reliable field — models count the
                          whole star row rather than only the filled ones — so it is
                          editable right here instead of buried in the slot editor. */}
                      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ color: "var(--gold)", fontSize: ".8rem" }}>★</span>
                        <input
                          type="number" min={0} max={30} value={it.star ?? 0}
                          aria-label={`Star force for ${it.name}`}
                          onChange={(ev) => {
                            const star = Math.max(0, Math.min(30, parseInt(ev.target.value, 10) || 0));
                            setEntries((prev) => prev.map((x) =>
                              x.id === e.id ? { ...x, parsed: { ...x.parsed, item: { ...x.parsed.item, star } } } : x
                            ));
                          }}
                          style={{
                            width: "5ch", background: "var(--panel-2)", border: "1px solid var(--line)",
                            borderRadius: 2, padding: "1px 4px", color: "var(--ink)",
                            fontFamily: "var(--font-jetbrains), monospace", fontSize: ".72rem", textAlign: "right",
                          }}
                        />
                      </label>
                      <span className="mono" style={{ marginLeft: "auto", fontSize: ".6rem", color: "var(--ink-3)" }}>{e.via}</span>
                    </div>

                    <div style={{ fontSize: ".76rem", color: "var(--ink-3)" }}>
                      pot: {it.p.filter(Boolean).join(" · ") || "none"}
                      {" — flame: "}{it.f.filter(Boolean).join(" · ") || "none"}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <label className="sub-h" htmlFor={`slot-${e.id}`}>Slot</label>
                      <select id={`slot-${e.id}`} value={e.slot} style={{ flex: 1 }}
                        onChange={(ev) => patch(e.id, { slot: ev.target.value })}>
                        {SLOTS.map((s) => <option key={s.id} value={s.id}>{s.n}</option>)}
                      </select>
                      <button className="btn" onClick={() => setEntries((prev) => prev.filter((x) => x.id !== e.id))}>Remove</button>
                    </div>

                    {clash && (
                      <p style={{ margin: 0, fontSize: ".74rem", color: "var(--warn)" }}>
                        Two items are set to this slot — only the lower one will be applied.
                      </p>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: "12px 15px", borderTop: "1px solid var(--line)" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          {(entries.length > 0 || stats || roster.length > 0) && (
            <button className="btn" onClick={() => { setEntries([]); setFails([]); setStats(null); setRoster([]); setError(null); }}>Clear all</button>
          )}
          {(chosen.length > 0 || (stats && useStats) || (roster.length > 0 && useRoster)) && (
            <button
              className="btn p"
              onClick={() =>
                onApply(
                  chosen.map((e) => ({ slot: e.slot, item: e.parsed.item })),
                  stats && useStats ? stats : undefined,
                  roster.length > 0 && useRoster ? roster : undefined
                )
              }
            >
              Apply {[
                chosen.length ? `${chosen.length} item${chosen.length > 1 ? "s" : ""}` : null,
                stats && useStats ? "stats" : null,
                roster.length > 0 && useRoster ? `${roster.length} characters` : null,
              ].filter(Boolean).join(" + ")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
