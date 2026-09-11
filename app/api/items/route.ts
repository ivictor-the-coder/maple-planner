import { NextResponse } from "next/server";

// Proxies item lookups to the community item database.
//
// Going through our own route rather than calling it from the browser means
// we control caching and never hammer a volunteer-run service, and it sidesteps
// whatever CORS policy they happen to have.

const UPSTREAM = "https://api.maplestory.net/items/";
const REVALIDATE = 60 * 60 * 24; // item data is static; a day is conservative

/** Their subcategory strings → our slot ids. */
const SUBCATEGORY_TO_SLOT: Record<string, string> = {
  Hat: "hat",
  Top: "top",
  Overall: "top",
  Bottom: "bottom",
  Shoes: "shoes",
  Glove: "gloves",
  Gloves: "gloves",
  Cape: "cape",
  Shoulder: "shoulder",
  Belt: "belt",
  Ring: "ring1",
  Pendant: "pendant1",
  Earrings: "earring",
  Earring: "earring",
  "Face Accessory": "face",
  "Eye Decoration": "eye",
  Badge: "badge",
  Medal: "medal",
  Emblem: "emblem",
  "Mechanical Heart": "heart",
  "Pocket Item": "pocket",
  Android: "android",
};

export interface ItemHit {
  itemId: number;
  name: string;
  slot: string | null;
  subcategory: string;
  level: number;
  jobs: string[];
  superior: boolean;
  bossDrop: boolean;
  icon: string;
}

interface UpstreamItem {
  itemId: number;
  name: string;
  subcategory?: string;
  category?: string;
  requiredStats?: { level?: number; jobTrees?: string[] };
  availability?: { superior?: boolean; bossDrop?: boolean; cash?: boolean };
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ items: [] as ItemHit[] });

  const url = `${UPSTREAM}?nameText=${encodeURIComponent(q)}&overallCategory=Equip&maxEntries=25`;

  let raw: { result?: UpstreamItem[] };
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) {
      return NextResponse.json(
        { items: [], error: `Item database returned ${res.status}.` },
        { status: 502 }
      );
    }
    raw = await res.json();
  } catch {
    return NextResponse.json({ items: [], error: "Could not reach the item database." }, { status: 502 });
  }

  // The database carries several ids for what is, to a player, one item.
  // Collapse them so the dropdown does not show four identical rows.
  const seen = new Set<string>();
  const items: ItemHit[] = (raw.result ?? [])
    .filter((r) => !r.availability?.cash)
    .filter((r) => {
      const key = `${r.name}|${r.subcategory ?? ""}|${r.requiredStats?.level ?? 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({
      itemId: r.itemId,
      name: r.name,
      subcategory: r.subcategory ?? r.category ?? "",
      slot: SUBCATEGORY_TO_SLOT[r.subcategory ?? ""] ?? null,
      level: r.requiredStats?.level ?? 0,
      jobs: r.requiredStats?.jobTrees ?? [],
      superior: !!r.availability?.superior,
      bossDrop: !!r.availability?.bossDrop,
      icon: `https://api.maplestory.net/item/${r.itemId}/icon`,
    }))
    // highest level first: that's almost always the one you meant
    .sort((a, b) => b.level - a.level)
    .slice(0, 12);

  return NextResponse.json(
    { items },
    { headers: { "cache-control": `public, s-maxage=${REVALIDATE}, stale-while-revalidate=86400` } }
  );
}
