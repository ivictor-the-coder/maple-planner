"use client";

import { useState } from "react";
import {
  BOARD_MIN, LINK_TRANSFER, linkEffect, linkLevel, nextLink, nextRank,
  rankOf, rosterAdvice, type RosterChar,
} from "@/lib/legion";

const RANK_ORDER = ["SSS", "SS", "S", "A", "B", "-"] as const;

export default function Roster({
  chars,
  onClear,
}: {
  chars: RosterChar[];
  onClear: () => void;
}) {
  const [all, setAll] = useState(false);
  if (!chars.length) return null;

  const sum = rosterAdvice(chars);
  const recs = all ? sum.recs : sum.recs.slice(0, 6);

  return (
    <section className="card" style={{ gridColumn: "1 / -1" }}>
      <h2>
        Legion roster
        <button className="btn" style={{ float: "right", fontSize: ".7rem" }} onClick={onClear}>
          Clear roster
        </button>
      </h2>

      <div className="roster-sum">
        <span><b>{sum.onBoard}</b> on the board</span>
        {sum.offBoard > 0 && <span className="warn"><b>{sum.offBoard}</b> below Lv {BOARD_MIN}</span>}
        <span><b>{sum.totalLevel.toLocaleString()}</b> total levels</span>
        {RANK_ORDER.filter((r) => sum.counts[r] > 0 && r !== "-").map((r) => (
          <span key={r}><b className={`rank r${r}`}>{r}</b> ×{sum.counts[r]}</span>
        ))}
      </div>

      <div className="roster-split">
        <div>
          <div className="sub-h">Characters ({chars.length})</div>
          <div className="roster-list">
            {[...chars].sort((a, b) => b.lvl - a.lvl).map((c) => {
              const nr = nextRank(c.lvl);
              const nl = nextLink(c.lvl);
              const ll = linkLevel(c.lvl);
              return (
                <div className="roster-row" key={c.name} title={linkEffect(c.cls) ?? c.cls}>
                  <span className={`rank r${rankOf(c.lvl)}`}>{rankOf(c.lvl)}</span>
                  <span className="mono lv">{c.lvl}</span>
                  <span className="nm">
                    {c.name}
                    {c.current && <i className="cur">current</i>}
                    <em>{c.cls}</em>
                  </span>
                  <span className="nx mono">
                    {ll === 0 ? `link @${LINK_TRANSFER}` : `link ${ll}`}
                    {nr ? ` · ${nr.rank} @${nr.at}` : nl ? ` · @${nl.at}` : " · max"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="sub-h">Level these next</div>
          <p className="hint" style={{ marginTop: 0 }}>
            Ordered by how few levels stand between the character and its next payoff —
            a rank on the board, or the next level of its link skill.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {recs.map((r, i) => (
              <div className={`rec ${r.lv}`} key={i}>
                <span className="p mono">{r.cost >= 9999 ? "—" : `+${r.cost}`}</span>
                <span>
                  <b>{r.who}</b>
                  <span className="why" style={{ color: "var(--ink-2)" }}>{r.t}</span>
                  {r.w && <span className="why">{r.w}</span>}
                </span>
              </div>
            ))}
          </div>
          {sum.recs.length > 6 && (
            <button className="btn" style={{ marginTop: 9 }} onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${sum.recs.length}`}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
