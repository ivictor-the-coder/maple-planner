"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseTooltip, type ParsedItem } from "@/lib/import/tooltip";
import { SLOTS, TIER_LABEL, type Item } from "@/lib/rules";

const MAX_FILES = 10;

export interface ImportEntry {
  id: number;
  parsed: ParsedItem;
  slot: string;
  include: boolean;
  via: string;
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
  onApply: (entries: Array<{ slot: string; item: Item }>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"shot" | "text">("shot");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<{ done: number; total: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ImportEntry[]>([]);
  const [fails, setFails] = useState<Array<{ name: string; why: string }>>([]);
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const add = useCallback((parsed: ParsedItem, via: string) => {
    setEntries((prev) => [
      ...prev,
      { id: nextId.current++, parsed, slot: parsed.slotGuess ?? "hat", include: true, via },
    ]);
  }, []);

  /** One image, read by the vision route.
   *  There is deliberately no local-OCR fallback: tesseract never once read a
   *  real tooltip correctly, and running it on a full-size screenshot took
   *  minutes. A clear error beats a spinner that never ends. */
  const readOne = useCallback(async (file: File | Blob): Promise<{ parsed: ParsedItem; via: string } | string> => {
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
      if (res.ok && j.item?.name) {
        const p: string[] = j.item.p ?? [];
        const f: string[] = j.item.f ?? [];
        const icon = j.iconBox ? cropIcon(img, j.iconBox) : undefined;
        return {
          via: j.model,
          parsed: {
            item: { ...j.item, icon, p: [p[0] ?? "", p[1] ?? "", p[2] ?? ""], f: [f[0] ?? "", f[1] ?? "", f[2] ?? ""] },
            slotGuess: j.slotGuess ?? null,
            found: {
              name: !!j.item.name, lvl: j.item.lvl > 0, pot: j.item.pot !== "none",
              potLines: p.filter(Boolean).length, flameLines: f.filter(Boolean).length,
              superior: !!j.item.sup,
            },
            warnings: j.item.star ? [] : ["Star force came back 0 — check it."],
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
    // Sequential, and spaced: hitting a vision endpoint ten times back to back
    // trips its rate limit and most of the batch comes back 429.
    for (let i = 0; i < batch.length; i++) {
      setStep({ done: i, total: batch.length, label: batch[i].name || "screenshot" });
      const r = await readOne(batch[i]);
      if (typeof r === "string") {
        setFails((prev) => [...prev, { name: batch[i].name || `Screenshot ${i + 1}`, why: r }]);
      } else {
        add(r.parsed, r.via);
      }
      if (i < batch.length - 1) await new Promise((res) => setTimeout(res, 1200));
    }
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
            Import tooltips {entries.length > 0 && <span className="mono" style={{ color: "var(--ink-3)", fontSize: ".72rem" }}>{entries.length}/{MAX_FILES}</span>}
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
                      <span className="tag plain">★{it.star ?? 0}</span>
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
                        Two items are going to this slot — the later one wins.
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
          {entries.length > 0 && <button className="btn" onClick={() => { setEntries([]); setError(null); }}>Clear all</button>}
          {chosen.length > 0 && (
            <button className="btn p" onClick={() => onApply(chosen.map((e) => ({ slot: e.slot, item: e.parsed.item })))}>
              Apply {chosen.length} item{chosen.length > 1 ? "s" : ""}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
