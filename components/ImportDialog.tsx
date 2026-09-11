"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseTooltip, type ParsedItem } from "@/lib/import/tooltip";
import { SLOTS, TIER_LABEL } from "@/lib/rules";

/** MapleStory tooltips are light text on a dark panel, and small. Tesseract
 *  does much better on large dark-on-light text, so upscale and invert. */
function preprocess(img: HTMLImageElement): string {
  const scale = Math.min(4, Math.max(2, 900 / Math.max(img.width, 1)));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext("2d");
  if (!ctx) return c.toDataURL();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);

  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
  const mean = sum / (px.length / 4);
  const dark = mean < 128;

  for (let i = 0; i < px.length; i += 4) {
    let g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (dark) g = 255 - g;
    g = g < 110 ? Math.max(0, g - 45) : Math.min(255, g + 45);
    px[i] = px[i + 1] = px[i + 2] = g;
  }
  ctx.putImageData(d, 0, 0);
  return c.toDataURL("image/png");
}

export default function ImportDialog({
  onApply,
  onClose,
}: {
  onApply: (slotId: string, parsed: ParsedItem) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"shot" | "text">("shot");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParsedItem | null>(null);
  const [slotId, setSlotId] = useState<string>("hat");
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const accept = useCallback((parsed: ParsedItem) => {
    setResult(parsed);
    if (parsed.slotGuess) setSlotId(parsed.slotGuess);
  }, []);

  const runOcr = useCallback(async (file: File | Blob) => {
    setBusy(true); setError(null); setProgress(0);
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("That file could not be read as an image."));
        i.src = url;
      });
      const prepped = preprocess(img);
      URL.revokeObjectURL(url);

      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng", 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === "recognizing text") setProgress(Math.round(m.progress * 100));
        },
      });
      const { data } = await worker.recognize(prepped);
      await worker.terminate();

      if (!data.text || data.text.trim().length < 10) {
        setError("Nothing readable came out of that image. Try a larger screenshot, or use the Paste text tab.");
        return;
      }
      accept(parseTooltip(data.text));
    } catch (e) {
      setError(e instanceof Error ? e.message : "OCR failed.");
    } finally {
      setBusy(false);
    }
  }, [accept]);

  // paste an image straight from the clipboard
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (tab !== "shot") return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const blob = item?.getAsFile();
      if (blob) { e.preventDefault(); void runOcr(blob); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [tab, runOcr]);

  const it = result?.item;

  return (
    <div className="ed-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ed-in" style={{ maxWidth: 620 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 15px", borderBottom: "1px solid var(--line)" }}>
          <h3 style={{ fontSize: "1rem", marginRight: "auto" }}>Import from tooltip</h3>
          <button className={`btn${tab === "shot" ? " p" : ""}`} onClick={() => setTab("shot")}>Screenshot</button>
          <button className={`btn${tab === "text" ? " p" : ""}`} onClick={() => setTab("text")}>Paste text</button>
        </div>

        <div style={{ padding: "14px 15px", display: "flex", flexDirection: "column", gap: 13 }}>
          {!result && tab === "shot" && (
            <>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) void runOcr(f);
                }}
                onClick={() => fileRef.current?.click()}
                style={{
                  border: "1px dashed var(--line)", borderRadius: 3, padding: "34px 16px",
                  textAlign: "center", cursor: "pointer", background: "var(--panel-2)",
                }}
              >
                <p style={{ margin: 0, fontSize: ".9rem" }}>
                  {busy ? `Reading… ${progress}%` : "Drop a tooltip screenshot, paste one, or click to pick a file"}
                </p>
                <p style={{ margin: "6px 0 0", fontSize: ".76rem", color: "var(--ink-3)" }}>
                  Runs in your browser — the image is never uploaded.
                </p>
              </div>
              <input
                ref={fileRef} type="file" accept="image/*" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void runOcr(f); }}
              />
            </>
          )}

          {!result && tab === "text" && (
            <div className="fld">
              <label htmlFor="paste">Tooltip text</label>
              <textarea
                id="paste" rows={10} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={"Royal Ranger Beret\nArmor\nHat\nRequired Level Lv. 150\n…"}
                style={{ width: "100%", background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 2, padding: "8px 10px", color: "var(--ink)", fontFamily: "var(--font-jetbrains), monospace", fontSize: ".8rem" }}
              />
              <button className="btn p" style={{ alignSelf: "flex-start", marginTop: 8 }}
                disabled={text.trim().length < 10}
                onClick={() => accept(parseTooltip(text))}>
                Parse
              </button>
            </div>
          )}

          {error && (
            <p style={{ margin: 0, fontSize: ".83rem", color: "var(--bad)", background: "var(--panel-2)", borderLeft: "2px solid var(--bad)", padding: "9px 12px" }}>
              {error}
            </p>
          )}

          {result && it && (
            <>
              <div className="sub-h">Check this before applying</div>
              <div style={{ background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 3, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 6 }}>
                <Row k="Name" v={it.name || "— not read —"} ok={result.found.name} />
                <Row k="Item level" v={it.lvl ? String(it.lvl) : "— not read —"} ok={result.found.lvl} />
                <Row k="Potential" v={TIER_LABEL[it.pot]} ok={result.found.pot} />
                <Row k="Potential lines" v={it.p.filter(Boolean).join(" · ") || "none"} ok={result.found.potLines > 0} />
                <Row k="Flame" v={it.f.filter(Boolean).join(" · ") || "none"} ok={result.found.flameLines > 0} />
                <Row k="Superior" v={it.sup ? "yes" : "no"} ok />
              </div>

              <div className="fld">
                <label htmlFor="slot">Put it in</label>
                <select id="slot" value={slotId} onChange={(e) => setSlotId(e.target.value)}>
                  {SLOTS.map((s) => <option key={s.id} value={s.id}>{s.n}</option>)}
                </select>
              </div>

              {result.warnings.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: ".78rem", color: "var(--ink-3)" }}>
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: "12px 15px", borderTop: "1px solid var(--line)" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          {result && <button className="btn" onClick={() => { setResult(null); setError(null); }}>Start over</button>}
          {result && <button className="btn p" onClick={() => onApply(slotId, result)}>Apply to {SLOTS.find((s) => s.id === slotId)?.n}</button>}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: ".82rem" }}>
      <span style={{ color: "var(--ink-3)" }}>{k}</span>
      <span style={{ textAlign: "right", color: ok ? "var(--ink)" : "var(--warn)" }}>{v}</span>
    </div>
  );
}
