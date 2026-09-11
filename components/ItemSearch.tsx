"use client";

import { useEffect, useRef, useState } from "react";
import type { ItemHit } from "@/app/api/items/route";

/** Name field that searches the item database and fills in what it knows. */
export default function ItemSearch({
  value,
  onText,
  onPick,
}: {
  value: string;
  onText: (v: string) => void;
  onPick: (hit: ItemHit) => void;
}) {
  const [hits, setHits] = useState<ItemHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const skip = useRef(false);

  useEffect(() => {
    if (skip.current) { skip.current = false; return; }
    const q = value.trim();
    if (q.length < 2) { setHits([]); setNote(null); return; }

    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true); setNote(null);
      try {
        const r = await fetch(`/api/items?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
        const j = await r.json();
        if (j.error) setNote(j.error);
        setHits(j.items ?? []);
        setActive(0);
        setOpen(true);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setNote("Lookup failed — type the name manually.");
      } finally {
        setBusy(false);
      }
    }, 280);

    return () => { clearTimeout(t); ctl.abort(); };
  }, [value]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  function choose(h: ItemHit) {
    skip.current = true;
    onPick(h);
    setOpen(false);
    setHits([]);
  }

  return (
    <div ref={box} style={{ position: "relative" }}>
      <input
        value={value}
        placeholder="Start typing — e.g. Royal Ranger"
        autoComplete="off"
        onChange={(e) => onText(e.target.value)}
        onFocus={() => hits.length && setOpen(true)}
        onKeyDown={(e) => {
          if (!open || !hits.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
          else if (e.key === "Enter") { e.preventDefault(); choose(hits[active]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />

      {busy && (
        <span className="mono" style={{ position: "absolute", right: 8, top: 8, fontSize: ".6rem", color: "var(--ink-3)" }}>
          …
        </span>
      )}

      {note && <p style={{ margin: "4px 0 0", fontSize: ".72rem", color: "var(--warn)" }}>{note}</p>}

      {open && hits.length > 0 && (
        <ul
          style={{
            position: "absolute", zIndex: 60, top: "calc(100% + 4px)", left: 0, right: 0,
            margin: 0, padding: 4, listStyle: "none", maxHeight: 260, overflowY: "auto",
            background: "var(--panel)", border: "1px solid var(--gold)", borderRadius: 3,
            boxShadow: "0 8px 24px rgba(0,0,0,.5)",
          }}
        >
          {hits.map((h, i) => (
            <li key={h.itemId}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(h)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "6px 8px",
                  background: i === active ? "var(--panel-3)" : "transparent",
                  border: 0, borderRadius: 2, cursor: "pointer", textAlign: "left", color: "var(--ink)",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={h.icon} alt="" width={28} height={28} style={{ imageRendering: "pixelated", flex: "none" }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: ".82rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {h.name}
                  </span>
                  <span className="mono" style={{ fontSize: ".62rem", color: "var(--ink-3)" }}>
                    {h.subcategory || "—"}{h.level ? ` · Lv. ${h.level}` : ""}
                    {h.superior ? " · superior" : ""}{h.bossDrop ? " · boss drop" : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
