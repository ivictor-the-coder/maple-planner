import type { Metadata } from "next";
import graph from "@/data/guide-graph.json";

export const metadata: Metadata = {
  title: "Progression Guide — Maple Planner",
  description:
    "Gear ladders, star force tables, symbol costs, boss CP, training and HEXA for MapleStory on Heroic worlds.",
};

interface Node {
  id: string;
  tab: string;
  title: string;
  tags: string[];
  type: string;
  headers?: string[];
  rows: (string[] | string)[];
  notes?: string;
  source: string;
  lastVerified: string;
  patchVersion: string;
}
interface Tab { id: string; name: string; order: number }

export default function GuidePage() {
  const meta = graph.meta as Record<string, string>;
  const tabs = ([...(graph.tabs as Tab[])]).sort((a, b) => a.order - b.order);
  const nodes = graph.nodes as unknown as Node[];
  const cur = meta.gameVersion;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "26px 20px 80px" }}>
      <header style={{ borderBottom: "1px solid var(--line)", paddingBottom: 18, marginBottom: 28 }}>
        <h1 style={{ fontSize: "1.6rem", fontWeight: 700 }}>Progression Guide</h1>
        <p className="mono" style={{ fontSize: ".67rem", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-3)", marginTop: 6 }}>
          {meta.gameVersionName} · patch {meta.patchDate} · {meta.region}, {meta.worldAssumption} ·{" "}
          <a href={meta.patchNotesUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold)" }}>
            patch notes
          </a>
        </p>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
        {tabs.map((tab) => {
          const mine = nodes.filter((n) => n.tab === tab.id);
          if (!mine.length) return null;
          return (
            <section key={tab.id} id={tab.id} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <h2 className="mono" style={{ fontSize: ".72rem", letterSpacing: ".16em", textTransform: "uppercase", color: "var(--ink-3)", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                {tab.name}
              </h2>

              {mine.map((n) => {
                // Fresh means current patch AND actually sourced. This used to test the
                // literal words "patch notes", which silently stopped matching when the
                // graph moved to real URLs and explicit UNVERIFIED markers - every badge
                // on the page disappeared and nothing failed.
                const fresh = n.patchVersion === cur && !/^s*UNVERIFIED/i.test(n.source ?? "");
                return (
                  <article key={n.id} className="card" style={{ padding: "16px 18px 12px", display: "flex", flexDirection: "column", gap: 11 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <h3 style={{ fontSize: "1.03rem", fontWeight: 600 }}>{n.title}</h3>
                      {fresh && <span className="tag" style={{ color: "var(--gold)", borderColor: "var(--gold)" }}>{cur}</span>}
                    </div>

                    {n.type === "table" && n.headers ? (
                      <div style={{ overflowX: "auto" }}>
                        <table className="gtable">
                          <thead>
                            <tr>{n.headers.map((h) => <th key={h}>{h}</th>)}</tr>
                          </thead>
                          <tbody>
                            {(n.rows as string[][]).map((r, i) => (
                              <tr key={i}>
                                {r.map((c, j) => (
                                  <td key={j} style={j === 0 ? { fontWeight: 500, whiteSpace: "nowrap" } : undefined}>{c}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 7 }}>
                        {n.rows.map((r, i) => (
                          <li key={i} style={{ position: "relative", paddingLeft: 17, fontSize: ".9rem" }}>
                            <span style={{ position: "absolute", left: 3, top: ".62em", width: 5, height: 5, background: "var(--gold)", borderRadius: "50%" }} />
                            {Array.isArray(r) ? r[0] : r}
                          </li>
                        ))}
                      </ul>
                    )}

                    {n.notes && (
                      <p style={{ margin: 0, fontSize: ".84rem", color: "var(--ink-2)", background: "var(--panel-2)", borderLeft: "2px solid var(--gold)", padding: "9px 12px" }}>
                        {n.notes}
                      </p>
                    )}

                    <p className="mono" style={{ margin: 0, paddingTop: 4, borderTop: "1px solid var(--line-soft)", fontSize: ".63rem", color: "var(--ink-3)" }}>
                      {n.source} · verified {n.lastVerified} · {n.patchVersion}
                    </p>
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
