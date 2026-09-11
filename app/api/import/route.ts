import { NextResponse } from "next/server";
import type { Tier } from "@/lib/rules";

// Reads a MapleStory item tooltip out of a screenshot using a vision model.
//
// Local OCR (tesseract) could not do this: the tooltip is semi-transparent over
// the game world, and the cursor always occludes a line because you have to
// hover an item to see its tooltip at all. A vision model handles both, and
// handles a full uncropped screenshot.
//
// Configure with OPENROUTER_API_KEY. OPENROUTER_MODELS optionally overrides the
// fallback chain (comma separated, tried in order).

export const maxDuration = 60;

const DEFAULT_MODELS = [
  "google/gemma-4-31b-it:free",
  "inclusionai/ling-3.0-flash-vl:free",
  "thinkingmachines/inkling:free",
  "nex-agi/nex-n2.5-pro:free",
  "openrouter/free",
];

const PROMPT = `You are reading a screenshot of the game MapleStory.

Find the ITEM TOOLTIP panel — the floating box showing one item's name and stats.
Ignore everything else: the minimap, the character HUD at the bottom (the "Lv.244"
there is the PLAYER's level, never the item's), chat, the equipment inventory grid,
and any "Set Effect" list panel beside the tooltip.

The mouse cursor often covers part of a line. If a line is unreadable, omit it
rather than guessing.

Reply with ONLY a JSON object, no prose and no code fences:

{
  "name": string,              // item name from the tooltip title
  "level": number,             // from "Required Level Lv. N". If it shows "Lv. 135 (150 - 15)" use 135. 0 if unreadable
  "slot": string,              // one of: hat top bottom shoes gloves cape shoulder belt weapon secondary emblem
                               // ring pendant earring face eye badge medal heart pocket android. "" if unclear
  "tier": string,              // "legendary" | "unique" | "epic" | "rare" | "none" — from the "Potential : X" line
  "potential": string[],       // up to 3 potential lines exactly as shown, e.g. "DEX: +9%", "All Stats +3%"
  "flame": string[],           // up to 3 bonus-stat (flame) lines. A stat line reads "STR +111 (40 +51 +20)"
                               // = base + starforce + flame, so the THIRD number is the flame: "STR +20".
                               // If a line shows only two numbers it is ambiguous — omit it.
                               // If the tooltip says "Bonus Stats Can't Enhance", return [].
  "starforce": number,         // count the FILLED gold stars above the item name. 0 if none or unreadable
  "superior": boolean          // true if the name contains Tyrant, or it says superior, or "Bonus Stats Can't Enhance"
}`;

interface VisionItem {
  name?: string; level?: number; slot?: string; tier?: string;
  potential?: string[]; flame?: string[]; starforce?: number; superior?: boolean;
}

const TIERS: Tier[] = ["none", "rare", "epic", "unique", "legendary"];

const SLOT_ALIASES: Record<string, string> = {
  ring: "ring1", pendant: "pendant1", earrings: "earring", overall: "top",
  glove: "gloves", "face accessory": "face", "eye accessory": "eye",
};

/** Free models frequently wrap JSON in prose or fences. Dig it out. */
function extractJson(text: string): VisionItem | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as VisionItem;
  } catch {
    return null;
  }
}

function tidy(arr: unknown, max = 3): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.replace(/^[•*\-\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, max);
}

export async function POST(req: Request) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Screenshot import isn't configured — OPENROUTER_API_KEY is not set." },
      { status: 501 }
    );
  }

  let image: string;
  try {
    const body = (await req.json()) as { image?: string };
    image = body.image ?? "";
  } catch {
    return NextResponse.json({ error: "Bad request body." }, { status: 400 });
  }
  if (!image.startsWith("data:image/")) {
    return NextResponse.json({ error: "Expected a data:image/... URL." }, { status: 400 });
  }
  // ~6MB of base64 is plenty for a full-screen grab and keeps us inside limits
  if (image.length > 8_000_000) {
    return NextResponse.json({ error: "That image is too large — try a window capture." }, { status: 413 });
  }

  const models = (process.env.OPENROUTER_MODELS?.split(",").map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_MODELS;
  const tried: string[] = [];

  for (const model of models) {
    tried.push(model);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-Title": "Maple Planner",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 900,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: PROMPT },
                { type: "image_url", image_url: { url: image } },
              ],
            },
          ],
        }),
      });

      if (!res.ok) continue; // rate limited or model down — try the next one

      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(text);
      if (!parsed || !parsed.name) continue;

      const rawSlot = (parsed.slot ?? "").toLowerCase().trim();
      const slot = SLOT_ALIASES[rawSlot] ?? (rawSlot || null);
      const tier = TIERS.includes(parsed.tier as Tier) ? (parsed.tier as Tier) : "none";
      const level = Number.isFinite(parsed.level) ? Math.max(0, Math.min(300, Number(parsed.level))) : 0;
      const star = Number.isFinite(parsed.starforce) ? Math.max(0, Math.min(30, Number(parsed.starforce))) : 0;

      return NextResponse.json({
        model,
        item: {
          name: String(parsed.name).trim(),
          lvl: level,
          star,
          pot: tier,
          sup: parsed.superior ? 1 : 0,
          p: tidy(parsed.potential),
          f: tidy(parsed.flame),
        },
        slotGuess: slot,
      });
    } catch {
      // network hiccup on a free endpoint — fall through to the next model
    }
  }

  return NextResponse.json(
    { error: `No vision model answered. Tried: ${tried.join(", ")}. Free models rate-limit often — wait a moment and retry.` },
    { status: 503 }
  );
}
