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

// Chain order matters. Probed against the live account:
//   google/gemma-4-31b-it:free     429 — rate limited
//   thinkingmachines/inkling:free  403 — not available to this account
//   nex-agi/nex-n2.5-pro:free      404 — no endpoints
//   inclusionai/ling-3.0-flash-vl  responded
//   openrouter/free                responded
// Costs are per million input tokens; one screenshot is a small fraction of one.
//   meta/muse-spark-1.3-contributor  $0.10  cheaper because prompts are shared
//                                           with the provider
//   z-ai/glm-5.3-flash               $0.15  note: plain glm-5.3 has NO vision,
//                                           only the -flash variant can see images
//   deepseek/deepseek-v4.1-flash     $0.15
//
// The free tier was dropped from the chain: of five probed, three returned
// 429/403/404 and the two that answered were weak at this task.
const DEFAULT_MODELS = [
  "meta/muse-spark-1.3-contributor",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4.1-flash",
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
  "starforce": number,         // Star force, above the item name. The stars are drawn in groups of five
                               // and the row shows EVERY possible star, most of them EMPTY. Count ONLY
                               // the solid gold/yellow filled ones. Grey, hollow or dim outlined stars
                               // are NOT earned and must not be counted. If the row shows 12 gold then
                               // 3 grey, the answer is 12, not 15. Never assume the item is maxed.
                               // Use 0 if there are no gold stars or you cannot tell.
  "superior": boolean,         // true if the name contains Tyrant, or it says superior, or "Bonus Stats Can't Enhance"
  "iconBox": [number, number, number, number]
                               // bounding box of the item's ICON — the small square picture of the item
                               // inside the tooltip, usually top-left under the name. Give it as
                               // [x, y, width, height] normalised 0-1 relative to the whole image.
                               // Use [0,0,0,0] if you cannot locate it.
}

If there is NO item tooltip visible, set "name" to "" — do not invent one.

SEPARATELY: the screenshot may also show the CHARACTER STAT window (headed
"Character Info" / "STAT", showing Combat Power, DAMAGE RANGE, STR/DEX/INT/LUK,
CRITICAL RATE, BOSS DAMAGE, IGNORE DEFENSE, ARCANE POWER, STAR FORCE and so on).
If and only if that window is visible, add a "stats" key. Read the numbers exactly
as displayed, stripping commas and % signs. Omit any field you cannot see.

  "stats": {
    "name": string,          // character name
    "class": string,         // e.g. "Bow Master"
    "level": number,         // the character's Lv.
    "combatPower": number,
    "mainStat": number,      // the STR/DEX/INT/LUK value that matches the class's main stat
    "attack": number,        // ATTACK POWER
    "critRate": number,      // CRITICAL RATE %
    "critDamage": number,    // CRITICAL DAMAGE %
    "bossDamage": number,    // BOSS DAMAGE %
    "ignoreDefense": number, // IGNORE DEFENSE %
    "maxHp": number,
    "arcanePower": number,
    "starForce": number      // the STAR FORCE total, not any single item's stars
  }

Omit "stats" entirely when no stat window is on screen.`;

interface VisionStats {
  name?: string; class?: string; level?: number; combatPower?: number;
  mainStat?: number; attack?: number; critRate?: number; critDamage?: number;
  bossDamage?: number; ignoreDefense?: number; maxHp?: number;
  arcanePower?: number; starForce?: number;
}

interface VisionItem {
  name?: string; level?: number; slot?: string; tier?: string;
  potential?: string[]; flame?: string[]; starforce?: number; superior?: boolean;
  iconBox?: number[]; stats?: VisionStats;
}

const num = (v: unknown, max: number): number | undefined => {
  const n = typeof v === "string" ? parseFloat(v.replace(/[,%\s]/g, "")) : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined;
};

function tidyStats(s: VisionStats | undefined) {
  if (!s || typeof s !== "object") return undefined;
  const out = {
    name: typeof s.name === "string" ? s.name.trim() : undefined,
    cls: typeof s.class === "string" ? s.class.trim() : undefined,
    lvl: num(s.level, 300),
    cp: num(s.combatPower, 1e10),
    main: num(s.mainStat, 1e7),
    att: num(s.attack, 1e6),
    crit: num(s.critRate, 100),
    critdmg: num(s.critDamage, 1000),
    boss: num(s.bossDamage, 2000),
    ied: num(s.ignoreDefense, 100),
    hp: num(s.maxHp, 1e8),
    arcane: num(s.arcanePower, 1320),
    starforce: num(s.starForce, 1000),
  };
  return Object.values(out).some((v) => v !== undefined && v !== "") ? out : undefined;
}

const TIERS: Tier[] = ["none", "rare", "epic", "unique", "legendary"];

const SLOT_ALIASES: Record<string, string> = {
  ring: "ring1", pendant: "pendant1", earrings: "earring", overall: "top",
  glove: "gloves", "face accessory": "face", "eye accessory": "eye",
};

/** Models wrap JSON in prose or fences, and a chatty preamble can push the
 *  closing brace past the token limit. Dig the object out, and if it was cut
 *  off mid-object, close it and salvage what arrived. */
function extractJson(text: string): VisionItem | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;

  // Some models emit more than one object — deepseek echoes {"type":"json_object"}
  // before the real answer. Walk every balanced object and take the one that
  // actually carries our payload, rather than slicing first-brace to last.
  const candidates: VisionItem[] = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth === 0) objStart = i; depth++; continue; }
    if (c === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { candidates.push(JSON.parse(cleaned.slice(objStart, i + 1)) as VisionItem); } catch { /* skip */ }
        objStart = -1;
      }
    }
  }
  const useful = candidates.find((c) => c && (c.name !== undefined || c.stats !== undefined));
  if (useful) return useful;
  if (candidates.length === 1) return candidates[0];

  // Truncated: balance the braces/brackets and drop any half-written pair.
  let frag = cleaned.slice(start);
  frag = frag.replace(/,\s*"[^"]*"\s*:\s*[^,}\]]*$/, "");
  frag = frag.replace(/,\s*$/, "");
  const opens = (frag.match(/\{/g) ?? []).length - (frag.match(/\}/g) ?? []).length;
  const brackets = (frag.match(/\[/g) ?? []).length - (frag.match(/\]/g) ?? []).length;
  frag += "]".repeat(Math.max(0, brackets)) + "}".repeat(Math.max(0, opens));
  try {
    return JSON.parse(frag) as VisionItem;
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

  // Track *why* each model didn't answer. "No tooltip in the image" and "every
  // free endpoint is rate-limited" are completely different problems and must
  // not produce the same message.
  const outcomes: Array<{ model: string; why: string }> = [];
  let anyModelAnswered = false;
  const startedAt = Date.now();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const model of models) {
    // Not every model accepts response_format. If one rejects it we retry the
    // same model without it rather than losing the model entirely.
    let jsonMode = true;
    // Up to three attempts: 429 backoff, and a no-json-mode retry.
    for (let attempt = 0; attempt < 3; attempt++) {
    // Hard per-model deadline. A free endpoint that hangs must not consume the
    // whole request budget and leave the user staring at a spinner.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-Title": "Maple Planner",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          // Enough headroom that a preamble can't truncate the object.
          max_tokens: 1600,
          // Ask for guaranteed-parseable output where the model supports it.
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
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

      if (res.status === 400 && jsonMode) {
        jsonMode = false; // this model rejects response_format — retry plain
        continue;
      }
      if (res.status === 429 && attempt === 0 && Date.now() - startedAt < 28_000) {
        await sleep(2500);
        continue; // same model, second attempt
      }
      if (!res.ok) {
        outcomes.push({ model, why: `HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}` });
        break;
      }

      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content ?? "";
      anyModelAnswered = true;

      const parsed = extractJson(text);
      if (!parsed) {
        // Surface what it actually said — guessing at this cost several rounds.
        const snip = text.replace(/\s+/g, " ").trim().slice(0, 160) || "(empty reply)";
        outcomes.push({ model, why: `replied but not with JSON: "${snip}"` });
        break;
      }
      const stats = tidyStats(parsed.stats);
      if (!parsed.name && !stats) {
        outcomes.push({ model, why: "read the image but found no item tooltip or stat window" });
        break;
      }
      if (!parsed.name) {
        // Stat window only — no item in this shot, which is fine.
        return NextResponse.json({ model, item: null, slotGuess: null, iconBox: null, stats });
      }

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
        iconBox: Array.isArray(parsed.iconBox) && parsed.iconBox.length === 4 ? parsed.iconBox.map(Number) : null,
        stats,
      });
    } catch (e) {
      outcomes.push({ model, why: (e as Error)?.name === "AbortError" ? "timed out after 20s" : "network error" });
      clearTimeout(timer);
      break;
    }
    clearTimeout(timer);
    break;
    }
  }

  const detail = outcomes.map((o) => `${o.model} — ${o.why}`).join("; ");
  const error = anyModelAnswered
    ? `A model read the image but couldn't find an item tooltip in it. Make sure one item's tooltip is visible in the screenshot. (${detail})`
    : `No vision model responded — free endpoints are likely rate-limited right now. Wait a minute and retry. (${detail})`;

  return NextResponse.json({ error, outcomes }, { status: 503 });
}
