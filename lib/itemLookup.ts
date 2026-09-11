// Resolving a typed or vision-read item name to a database entry.
//
// Shared by the importer and by the one-time backfill in the planner, because
// they need exactly the same answer: given a name, find the real item so the
// grid can show a pixel-perfect sprite instead of a screenshot crop.
//
// The search is a substring match, which already covers a truncated or
// partial name: querying "Pensalir Sentinel Boot" returns "…Boots", and the
// distance ranking below picks it. What it cannot cover is a transposition
// inside the word - a model reading "Ifia's Ring" as "Iffa's Ring" returns
// zero results, and no prefix of the wrong name is a prefix of the right one.
// Querying 2-3 character stems instead just returns an arbitrary 25-item slice
// with nothing close in it, so this gives up and says so, and the importer
// shows the item as unmatched for the user to correct in two clicks.

export interface Resolved {
  itemId: number;
  name: string;
  sub?: string;
  level?: number;
  superior?: boolean;
  bossDrop?: boolean;
  /** True when the name we searched for was not the name we matched. */
  corrected?: boolean;
}

interface Hit {
  itemId: number; name: string; slot: string | null; subcategory: string;
  level: number; superior: boolean; bossDrop: boolean;
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[‘’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Slot family, ignoring the trailing digit: ring1 and ring3 are both "ring". */
const fam = (s: string | null | undefined) => (s ?? "").replace(/\d+$/, "");

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

async function search(q: string): Promise<Hit[]> {
  if (q.trim().length < 2) return [];
  try {
    const r = await fetch(`/api/items?q=${encodeURIComponent(q)}`);
    return ((await r.json())?.items ?? []) as Hit[];
  } catch {
    return [];
  }
}

/** Closest hit to `want`, subject to a slot family and a similarity floor. */
function best(hits: Hit[], want: string, slot?: string): Hit | null {
  const target = norm(want);
  const pool = slot ? hits.filter((h) => !h.slot || fam(h.slot) === fam(slot)) : hits;
  let win: Hit | null = null;
  let winD = Infinity;
  for (const h of pool) {
    const d = distance(target, norm(h.name));
    if (d < winD) { winD = d; win = h; }
  }
  // A quarter of the name may differ. "iffas ring" -> "ifias ring" is 2 of 10;
  // two unrelated rings are nowhere near that close.
  if (!win || winD > Math.max(1, Math.floor(target.length * 0.25))) return null;
  return win;
}

const pack = (h: Hit, searched: string): Resolved => ({
  itemId: h.itemId,
  name: h.name,
  sub: h.subcategory,
  level: h.level,
  superior: h.superior,
  bossDrop: h.bossDrop,
  corrected: norm(h.name) !== norm(searched),
});

export async function resolveItem(name: string, slot?: string): Promise<Resolved | null> {
  const clean = name.trim();
  if (clean.length < 2) return null;

  const hits = await search(clean);
  const exact = hits.find((h) => norm(h.name) === norm(clean));
  if (exact) return pack(exact, clean);

  const near = best(hits, clean, slot);
  return near ? pack(near, clean) : null;
}
