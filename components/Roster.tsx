"use client";

import { useMemo, useState } from "react";
import {
  // linkEffect() used to be the row's tooltip; the tooltip now says what
  // clicking does, which is the more urgent fact. The link effect is still
  // printed by rosterAdvice() in the column beside the list.
  BOARD_MIN, LINK_TRANSFER, linkLevel, nextLink, nextRank,
  rankOf, rosterAdvice, type RosterChar,
} from "@/lib/legion";
import { rosterKey } from "@/lib/rules";

const RANK_ORDER = ["SSS", "SS", "S", "A", "B", "-"] as const;

/** What the account knows about one roster entry: which sheet it opens, and how
 *  much is on that sheet. Absent from the map means "no sheet yet", which is the
 *  common case — 31 characters came off the Switch Character window and one of
 *  them has gear recorded. */
export interface RosterSheet {
  id: string;
  items: number;
}

export default function Roster({
  chars,
  sheets,
  activeKey,
  onOpen,
  onClear,
}: {
  chars: RosterChar[];
  /** rosterKey(name) -> the sheet that row opens. */
  sheets: Record<string, RosterSheet>;
  /** rosterKey(name) of the row whose sheet the planner is editing right now. */
  activeKey: string | null;
  /** Click a row: make that character the one the planner is editing. */
  onOpen: (c: RosterChar) => void;
  onClear: () => void;
}) {
  const [all, setAll] = useState(false);
  const sum = useMemo(() => rosterAdvice(chars), [chars]);
  const sorted = useMemo(() => [...chars].sort((a, b) => b.lvl - a.lvl), [chars]);
  if (!chars.length) return null;

  const recs = all ? sum.recs : sum.recs.slice(0, 6);
  const withSheets = chars.filter((c) => sheets[rosterKey(c.name)]).length;

  return (
    <section className="card roster" id="roster" style={{ gridColumn: "1 / -1" }}>
      <h2>
        Legion roster
        <span className="h2-for">click a character to plan it</span>
        <button className="btn" style={{ float: "right", fontSize: ".7rem" }} onClick={onClear}>
          Clear roster
        </button>
      </h2>

      <div className="roster-sum">
        <span><b>{sum.onBoard}</b> on the board</span>
        {sum.offBoard > 0 && <span className="warn"><b>{sum.offBoard}</b> below Lv {BOARD_MIN}</span>}
        <span><b>{sum.totalLevel.toLocaleString()}</b> total levels</span>
        <span><b>{withSheets}</b> of {chars.length} with gear recorded</span>
        {RANK_ORDER.filter((r) => sum.counts[r] > 0 && r !== "-").map((r) => (
          <span key={r}><b className={`rank r${r}`}>{r}</b> ×{sum.counts[r]}</span>
        ))}
      </div>

      <div className="roster-split">
        <div>
          <div className="sub-h">Characters ({chars.length})</div>
          <p className="railnote roster-how">
            Clicking a row switches the equipment grid, the stat panel and the ranked advice above
            to that character. A character with no sheet yet gets a blank one seeded with its name,
            class and level — clicking again returns to it rather than making a second copy.
          </p>
          <div className="roster-list">
            {sorted.map((c) => {
              const nr = nextRank(c.lvl);
              const nl = nextLink(c.lvl);
              const ll = linkLevel(c.lvl);
              const key = rosterKey(c.name);
              const sheet = sheets[key];
              const on = activeKey === key;
              return (
                <button
                  type="button"
                  className={`roster-row${on ? " on" : ""}`}
                  key={c.name}
                  aria-current={on ? "true" : undefined}
                  title={
                    on
                      ? `${c.name} is the character you are planning`
                      : sheet
                        ? `Plan ${c.name} — ${sheet.items} item${sheet.items === 1 ? "" : "s"} recorded`
                        : `Start a sheet for ${c.name} (${c.cls} Lv. ${c.lvl})`
                  }
                  onClick={() => onOpen(c)}
                >
                  <span className={`rank r${rankOf(c.lvl)}`}>{rankOf(c.lvl)}</span>
                  <span className="mono lv">{c.lvl}</span>
                  <span className="nm">
                    {c.name}
                    {c.current && <i className="cur">in game</i>}
                    {on && <i className="editing">planning</i>}
                    <em>{c.cls}</em>
                  </span>
                  <span className={`gear${sheet ? "" : " none"}`}>
                    {sheet ? `${sheet.items} item${sheet.items === 1 ? "" : "s"}` : "no sheet"}
                  </span>
                  <span className="nx mono">
                    {ll === 0 ? `link @${LINK_TRANSFER}` : `link ${ll}`}
                    {nr ? ` · ${nr.rank} @${nr.at}` : nl ? ` · @${nl.at}` : " · max"}
                  </span>
                </button>
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
