import { NextResponse } from "next/server";
import { SLOTS, canStarForce, sfCap, type Item, type SlotDef, type Tier } from "@/lib/rules";
import type { ImportFailure, ImportOutcome, OpenRouterUsage } from "@/lib/entitlement";
import { guardImport } from "@/lib/entitlementStore";
import { STAT_WINDOW_DAMAGE_PROMPT } from "@/lib/import/damageReadings";
import { num, str, tidyStatWindow, type VisionStats } from "@/lib/import/visionFields";

// Reads a MapleStory item tooltip out of a screenshot using a vision model.
//
// THIS IS THE ONLY ROUTE IN THE APP WITH A MARGINAL COST. Everything else the
// planner does is static computation; this one spends real OpenRouter vision
// tokens, and until this wave it spent them for any anonymous caller on the
// internet. So POST() below now begins — before the body is read, before the
// data URL is validated, and a long way before fetch("https://openrouter.ai") —
// with guardImport(). Hiding the button in the UI is not gating; this is.
//
// The gate is a demo, not a paywall: DEMO_IMPORTS (10) screenshot imports per
// visitor, which is one full batch and one character's worth of gear. When it
// runs out the refusal carries `interest: true` and a path to a form that asks
// whether someone would use a paid plan. It never asks for money — see
// INTEREST_FORM_PATH in lib/entitlement.ts for why that distinction is a
// deployment constraint rather than a preference.
//
// Local OCR (tesseract) could not do this: the tooltip is semi-transparent over
// the game world, and the cursor always occludes a line because you have to
// hover an item to see its tooltip at all. A vision model handles both, and
// handles a full uncropped screenshot.
//
// This is the paid feature, so the governing principle is: NOTHING the model
// says is trusted on its own. Every field that can be checked against evidence
// is checked — the item database supplies the required level, the level supplies
// the star cap, the cap contradicts an impossible star count — and every field
// ships with a confidence derived from that evidence, never from the model's
// own self-report. A model that is confidently wrong about 15 stars on a 12-star
// item sends a real person to grind for an upgrade they already have.
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
// muse-spark-1.3-contributor was dropped. A "-contributor" endpoint shares
// prompts with the provider by definition, and this account requires Zero Data
// Retention for all other models, so every request to it was rejected 403. The
// only way to admit it is to drop ZDR account-wide, which is a bad trade for a
// model that would only ever be reached when both of these had already failed.
const DEFAULT_MODELS = [
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4.1-flash",
];

/* ------------------------------------------------------------------ *
 * Assumptions recorded against files owned by other builders
 * ------------------------------------------------------------------ *
 * - lib/rules.ts is imported for `sfCap`, `canStarForce`, `SLOTS`. The star
 *   cap table there (Lv95→8, 108→10, 118→15, 129→20, 138→30, Superior→15)
 *   matches the community reference and is deliberately NOT duplicated here;
 *   one table, one place to fix. See maplestorywiki.net/w/Star_Force_Enhancement
 *   and strategywiki.org/wiki/MapleStory/Spell_Trace_and_Star_Force.
 * - lib/import/starPixels.ts (another builder) counts gold pixels in the browser
 *   and posts the result here as `pixelStars`. This route treats it as an
 *   optional input: if it never arrives, star confidence simply never reaches
 *   "high". Nothing here breaks if that file does not exist yet.
 * - components/ImportDialog.tsx destructures j.item.{p,f,star,lvl,pot,sup},
 *   j.slotGuess, j.iconBox, j.stats, j.roster. Every one of those keys keeps its
 *   name, type and meaning below. `conf`, `reasons`, `tooltipBox`, `db`,
 *   `accuracy` and `flags` are ADDITIVE and ignored by the current dialog.
 * - `stats.damagePct` and `stats.finalDamagePct` are likewise ADDITIVE: the
 *   dialog's StatsPatch and the planner's apply step each enumerate their own
 *   key list, so both fields are carried to the edge of this route and dropped
 *   there until those two files list them. Nothing here breaks meanwhile —
 *   they simply never arrive, which is the same as not being read.
 * - app/api/items/route.ts already maps the upstream subcategory to our slot id
 *   and returns it as `slot`, so that mapping is consumed rather than copied.
 * ------------------------------------------------------------------ */

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
  "superior": boolean,         // true ONLY if the name contains Tyrant, or the tooltip says Superior.
                               // A "Can't Enhance" line is NOT superior — superior items still take 15 stars.
  "noStarForce": boolean,      // true if the tooltip has a line like "Star Force, Bonus Stats Can't Enhance"
                               // or "Star Force Can't Enhance". Most secondary weapons say this.
  "noFlame": boolean,          // true if that same line mentions "Bonus Stats" — the item takes no flame.
  "noPotential": boolean,      // true if the tooltip reads "Potential : Can't Enhance" instead of a tier.
                               // Note an item can say "Star Force, Bonus Stats Can't Enhance" and STILL
                               // have a real "Potential : Legendary" with lines — read the two separately.
  "iconBox": [number, number, number, number],
                               // bounding box of the item's ICON — the small square picture of the item
                               // inside the tooltip, usually top-left under the name. Give it as
                               // [x, y, width, height] normalised 0-1 relative to the whole image.
                               // Use [0,0,0,0] if you cannot locate it.
  "tooltipBox": [number, number, number, number]
                               // bounding box of the STAR ROW ONLY — the horizontal strip of star
                               // graphics directly ABOVE the item name, at the very top of the tooltip.
                               // Include every star in the row, gold and grey alike, and as little else
                               // as possible: no name text, no icon. Same normalised [x, y, width, height]
                               // form as iconBox. Use [0,0,0,0] if the item shows no star row at all.
}

If there is NO item tooltip visible, set "name" to "" — do not invent one.

SEPARATELY: the screenshot may also show the CHARACTER STAT window (headed
"Character Info" / "STAT", showing Combat Power, DAMAGE RANGE, STR/DEX/INT/LUK,
CRITICAL RATE, BOSS DAMAGE, IGNORE DEFENSE, ARCANE POWER, STAR FORCE and so on).
If and only if that window is visible, add a "stats" key. Read the numbers exactly
as displayed, stripping commas and % signs. Use null for any field you cannot see,
and null for the whole "stats" key when no stat window is on screen.

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
    "starForce": number,     // the STAR FORCE total, not any single item's stars
${STAT_WINDOW_DAMAGE_PROMPT}
  }

SEPARATELY AGAIN: the screenshot may show the SWITCH CHARACTER window — a grid of
character cards, each card showing "Lv.NNN" on top, the CLASS under it ("Bow
Master", "Demon Avenger", "Dawn Warrior"), and the CHARACTER NAME on the bottom
line next to a small job icon ("Archerroni"). One card may carry a CURRENT badge,
and there is a page counter like "01 / 03" at the bottom. If and only if that
window is visible, add a "roster" key with every card you can read, left to right
then top to bottom:

  "roster": [ { "name": string, "class": string, "level": number, "current": boolean } ]

Class is the MIDDLE line and name is the BOTTOM line — do not swap them. Set
"current" true only for the card badged CURRENT. Skip a card you cannot read
rather than guessing at it. Also add "rosterPage": [n, total] from the page
counter, so [1, 3] for "01 / 03". Use null for "roster" and "rosterPage" when no
Switch Character window is on screen.

Output the JSON object and nothing else. Do not narrate what you see, do not
think out loud, do not write "Let me analyze". The first character you emit must
be { and the last must be }.`;

/** The second pass. A 200x40 native-resolution crop asking one question beats a
 *  2000px screenshot asking twenty — the model has no tooltip text to be
 *  distracted by and no chance to conflate the player's level with the item's. */
const STAR_PROMPT = `Count the filled gold stars in this row. Filled stars are \
saturated yellow/orange; unearned stars are grey outlines. Reply \
{"stars":N,"grey":M,"sure":true|false} and nothing else.`;

/* ---------- request shaping ---------- */

/** Structured output beats salvage. Strict mode (OpenAI's dialect, which
 *  OpenRouter forwards) demands that every property appear in `required` and
 *  that `additionalProperties` be false, so "optional" is expressed as a
 *  nullable type instead — hence the null-tolerance in num() below. */
const NUM_OR_NULL = { type: ["number", "null"] } as const;
const STR_OR_NULL = { type: ["string", "null"] } as const;

const STATS_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  required: [
    "name", "class", "level", "combatPower", "mainStat", "attack", "critRate",
    "critDamage", "bossDamage", "ignoreDefense", "maxHp", "arcanePower", "starForce",
    // The two stat-window damage readings. `required` is not optionality —
    // strict mode demands every property be listed, and NUM_OR_NULL is how a
    // field the model could not read says so. See lib/import/damageReadings.ts
    // for why null has to survive all the way to the character sheet.
    "damagePct", "finalDamagePct",
  ],
  properties: {
    name: STR_OR_NULL, class: STR_OR_NULL, level: NUM_OR_NULL,
    combatPower: NUM_OR_NULL, mainStat: NUM_OR_NULL, attack: NUM_OR_NULL,
    critRate: NUM_OR_NULL, critDamage: NUM_OR_NULL, bossDamage: NUM_OR_NULL,
    ignoreDefense: NUM_OR_NULL, maxHp: NUM_OR_NULL, arcanePower: NUM_OR_NULL,
    starForce: NUM_OR_NULL,
    // Declared as numbers because that is what a schema-honouring provider
    // should send. The parser still accepts "115.79%" as a string: widening the
    // schema to invite one would buy nothing, while the `object` and `none`
    // rungs of the format ladder (weaken(), below) deliver whatever the model
    // felt like typing and are the reason the parser is defensive at all.
    damagePct: NUM_OR_NULL, finalDamagePct: NUM_OR_NULL,
  },
} as const;

const BOX_SCHEMA = { type: "array", items: { type: "number" } } as const;

const TOOLTIP_SCHEMA = {
  name: "maple_tooltip",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "name", "level", "slot", "tier", "potential", "flame", "starforce",
      "superior", "noStarForce", "noFlame", "noPotential", "iconBox",
      "tooltipBox", "stats", "roster", "rosterPage",
    ],
    properties: {
      name: { type: "string" },
      level: { type: "number" },
      slot: { type: "string" },
      tier: { type: "string", enum: ["legendary", "unique", "epic", "rare", "none"] },
      potential: { type: "array", items: { type: "string" } },
      flame: { type: "array", items: { type: "string" } },
      starforce: { type: "number" },
      superior: { type: "boolean" },
      noStarForce: { type: "boolean" },
      noFlame: { type: "boolean" },
      noPotential: { type: "boolean" },
      iconBox: BOX_SCHEMA,
      tooltipBox: BOX_SCHEMA,
      stats: STATS_SCHEMA,
      roster: {
        type: ["array", "null"],
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "class", "level", "current"],
          properties: {
            name: { type: "string" }, class: { type: "string" },
            level: { type: "number" }, current: { type: "boolean" },
          },
        },
      },
      rosterPage: { type: ["array", "null"], items: { type: "number" } },
    },
  },
} as const;

const STARS_SCHEMA = {
  name: "maple_star_row",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["stars", "grey", "sure"],
    properties: {
      stars: { type: "number" }, grey: { type: "number" }, sure: { type: "boolean" },
    },
  },
} as const;

/** json_schema first; a provider that 400s on it drops to json_object; one that
 *  400s on that too runs bare. Each step is strictly weaker, never a dead end. */
type FormatMode = "schema" | "object" | "none";
const weaken = (m: FormatMode): FormatMode => (m === "schema" ? "object" : "none");

/* ---------- types ---------- */

interface VisionRosterEntry {
  name?: string | null; class?: string | null; level?: number | null; current?: boolean | null;
}

interface VisionItem {
  name?: string; level?: number; slot?: string; tier?: string;
  potential?: string[]; flame?: string[]; starforce?: number; superior?: boolean;
  noStarForce?: boolean; noFlame?: boolean; noPotential?: boolean;
  iconBox?: number[]; tooltipBox?: number[]; stats?: VisionStats | null;
  roster?: VisionRosterEntry[] | null; rosterPage?: number[] | null;
}

interface VisionStarRow {
  stars?: number | null; grey?: number | null; sure?: boolean | null;
}

export type Conf = "high" | "med" | "low";

/** Per-field confidence. Derived from evidence — a database match, a cap
 *  contradiction, two independent star counts agreeing — and never from the
 *  model telling us how sure it feels. */
export interface ConfMap {
  name: Conf; lvl: Conf; star: Conf; slot: Conf; pot: Conf; p: Conf; f: Conf;
}

export type ReasonMap = Partial<Record<keyof ConfMap, string>>;

function tidyRoster(r: unknown) {
  if (!Array.isArray(r)) return undefined;
  const out: Array<{ name: string; cls: string; lvl: number; current: boolean }> = [];
  for (const e of r) {
    const x = (e ?? {}) as VisionRosterEntry;
    const name = str(x.name) ?? "";
    const cls = str(x.class) ?? "";
    const lvl = num(x.level, 300);
    if (!name || lvl === undefined) continue;
    out.push({ name, cls, lvl, current: !!x.current });
  }
  return out.length ? out : undefined;
}

const TIERS: Tier[] = ["none", "rare", "epic", "unique", "legendary"];

const SLOT_ALIASES: Record<string, string> = {
  ring: "ring1", pendant: "pendant1", earrings: "earring", overall: "top",
  glove: "gloves", "face accessory": "face", "eye accessory": "eye",
};

/** Models wrap JSON in prose or fences, and a chatty preamble can push the
 *  closing brace past the token limit. Dig the object out, and if it was cut
 *  off mid-object, close it and salvage what arrived.
 *
 *  `salvaged` says whether we had to rebuild a truncated object. That is the
 *  signal that json_schema was NOT honoured, which step 10 logs — a provider
 *  silently ignoring the schema is invisible otherwise. */
function extractJson<T>(text: string): { value: T | null; salvaged: boolean } {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return { value: null, salvaged: false };

  // Some models emit more than one object — deepseek echoes {"type":"json_object"}
  // before the real answer. Walk every balanced object and take the one that
  // actually carries our payload, rather than slicing first-brace to last.
  const candidates: Record<string, unknown>[] = [];
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
        try { candidates.push(JSON.parse(cleaned.slice(objStart, i + 1))); } catch { /* skip */ }
        objStart = -1;
      }
    }
  }
  const useful = candidates.find(
    (c) => c && (c.name !== undefined || c.stats !== undefined || c.roster !== undefined || c.stars !== undefined)
  );
  if (useful) return { value: useful as unknown as T, salvaged: false };
  if (candidates.length === 1) return { value: candidates[0] as unknown as T, salvaged: false };

  // Truncated: balance the braces/brackets and drop any half-written pair.
  let frag = cleaned.slice(start);
  frag = frag.replace(/,\s*"[^"]*"\s*:\s*[^,}\]]*$/, "");
  frag = frag.replace(/,\s*$/, "");
  const opens = (frag.match(/\{/g) ?? []).length - (frag.match(/\}/g) ?? []).length;
  const brackets = (frag.match(/\[/g) ?? []).length - (frag.match(/\]/g) ?? []).length;
  frag += "]".repeat(Math.max(0, brackets)) + "}".repeat(Math.max(0, opens));
  try {
    return { value: JSON.parse(frag) as T, salvaged: true };
  } catch {
    return { value: null, salvaged: false };
  }
}

/* ---------- line-shape validation (replaces the old tidy()) ---------- */

// A potential or flame line is a tiny, rigid grammar. Anything else is the model
// narrating, and narration used to be stored verbatim as a potential line and
// handed to lib/rules.ts, which then advised on a sentence. Shape-check instead
// of trusting, and report what was dropped so the field's confidence can fall.

/** "DEX: +9%", "STR +20", "Attack Power : +12" — the overwhelming majority. */
const SHAPE_STAT = /^[A-Za-z][A-Za-z .]*?\s*:?\s*[+\-]\s*\d+(?:\.\d+)?%?$/;
/** "+9% DEX" — some locales and some models put the number first. */
const SHAPE_LEADING_NUM = /^[+\-]\s*\d+(?:\.\d+)?%?\s+[A-Za-z][A-Za-z .]*$/;
/** "Cooldown Reduction: -2 sec", "Damage: +1% per 10 character levels". */
const SHAPE_UNIT_TAIL = /^[A-Za-z][A-Za-z .]*?\s*:?\s*[+\-]?\s*\d+(?:\.\d+)?%?\s+(?:sec(?:ond)?s?|per\s+\d+\s+[A-Za-z ]+)$/i;
/** "Decent Sharp Eyes" and friends carry no number at all and are still real. */
const SHAPE_DECENT = /^decent\s+[A-Za-z' ]{3,30}$/i;
/** Families whose lines can be wordy but always contain a figure. Keeping this
 *  list explicit is what stops "The tooltip shows 3 lines" from surviving. */
const POT_FAMILY =
  /^(?:boss damage|ignore (?:enemy )?def(?:ense)?|item drop rate|drop rate|mesos? obtained|meso|cooldown reduction|attack power|magic att(?:ack)?|all stats?|critical (?:rate|damage)|damage|max hp|max mp|str|dex|int|luk|hp|mp|def(?:ense)?|speed|jump|invincib)/i;
/** Hard tells that the "line" is prose. Cheap, and it costs a real line nothing. */
const NARRATION = /\b(?:i |let me|the (?:image|screenshot|tooltip|item)|appears|cannot|unable|looks like|seems|shows|there (?:is|are))\b/i;

/** True when `s` is plausibly a real tooltip stat line rather than commentary. */
function isStatLine(s: string): boolean {
  const t = s.replace(/\s+/g, " ").trim();
  // No real potential or flame line is this long; every narration is.
  if (!t || t.length > 60) return false;
  if (NARRATION.test(t)) return false;
  if (SHAPE_STAT.test(t) || SHAPE_LEADING_NUM.test(t) || SHAPE_UNIT_TAIL.test(t) || SHAPE_DECENT.test(t)) return true;
  return POT_FAMILY.test(t) && /\d/.test(t);
}

/** Keep only lines that pass the shape check, and say how many were rejected. */
function keepStatLines(arr: unknown, max = 3): { lines: string[]; dropped: number } {
  if (!Array.isArray(arr)) return { lines: [], dropped: 0 };
  const seen = arr
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.replace(/^[•*\-\s]+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const lines: string[] = [];
  let dropped = 0;
  for (const l of seen) {
    if (lines.length >= max) break;
    if (isStatLine(l)) lines.push(l);
    else dropped++;
  }
  return { lines, dropped };
}

/* ---------- server-side item database lookup ---------- */

// lib/itemLookup.ts does this in the browser with a relative fetch, which is
// unusable here — and by the time it runs, the response has already been sent
// and the star count has already been accepted. Cross-validation has to happen
// BEFORE we answer, so a server-side twin lives here. The matching rules are
// deliberately identical so the two never disagree about which item this is.

export interface DbHit {
  itemId: number;
  name: string;
  /** Subcategory string from the upstream database, e.g. "Shield", "Ring". */
  sub: string;
  /** Our slot id, already mapped by app/api/items. Null for weapons. */
  slot: string | null;
  level: number;
  superior: boolean;
  bossDrop: boolean;
  /** Edit distance between what the model read and what the database calls it. */
  distance: number;
}

interface ItemsRouteHit {
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
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

async function lookupItem(origin: string, name: string, slot: string | null): Promise<DbHit | null> {
  const clean = name.trim();
  if (clean.length < 2) return null;

  let hits: ItemsRouteHit[] = [];
  try {
    const r = await fetch(`${origin}/api/items?q=${encodeURIComponent(clean)}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    hits = ((await r.json())?.items ?? []) as ItemsRouteHit[];
  } catch {
    // The database being down must degrade the confidence of a field, never the
    // availability of the import. Fall through to null.
    return null;
  }

  const target = norm(clean);
  const pool = slot ? hits.filter((h) => !h.slot || fam(h.slot) === fam(slot)) : hits;
  let win: ItemsRouteHit | null = null;
  let winD = Infinity;
  for (const h of pool) {
    const d = distance(target, norm(h.name));
    if (d < winD) { winD = d; win = h; }
  }
  // A quarter of the name may differ. "iffas ring" -> "ifias ring" is 2 of 10;
  // two unrelated rings are nowhere near that close.
  if (!win || winD > Math.max(1, Math.floor(target.length * 0.25))) return null;
  return {
    itemId: win.itemId, name: win.name, sub: win.subcategory, slot: win.slot,
    level: win.level, superior: win.superior, bossDrop: win.bossDrop, distance: winD,
  };
}

/* ---------- star reconciliation ---------- */

export interface StarInputs {
  /** Deterministic pixel count from lib/import/starPixels.ts, if the client ran it. */
  pixel?: number;
  /** What the model said while reading the whole screenshot. */
  model?: number;
  /** What the model said when shown only the star row at native resolution. */
  second?: number;
  /** sfCap() for this item, after the database has supplied the real level. */
  cap: number;
  /** The tooltip declared "Star Force ... Can't Enhance", or the slot cannot star. */
  cannotStar: boolean;
}

export interface StarVerdict { star: number; conf: Conf; reason?: string }

/** The highest star force any GMS item can show, post Star Force reorganisation:
 *  Lv.138+ gear goes to 30. Sourced from maplestorywiki.net/w/Star_Force_Enhancement
 *  and strategywiki.org/wiki/MapleStory/Spell_Trace_and_Star_Force (95→8, 108→10,
 *  118→15, 129→20, 138→30; Superior/Tyrant capped at 15). The per-level table
 *  itself lives in lib/rules.ts sfCap() and is not duplicated here. */
const MAX_STARS = 30;

/**
 * Three independent readings, none of them trusted alone.
 *
 * The pixel count is deterministic and wins ties on principle: it is the only
 * input that cannot hallucinate. But its thresholds are calibrated against a
 * fixture set, not extracted from the client, so a disagreement of more than one
 * star is treated as "neither of you is reliable here" — we still return the
 * pixel count, but at low confidence, which forces the UI to demand a human look
 * rather than writing a number nobody verified.
 */
function reconcileStars(i: StarInputs): StarVerdict {
  if (i.cannotStar) {
    const claimed = Math.max(i.pixel ?? 0, i.model ?? 0, i.second ?? 0);
    return claimed > 0
      ? { star: 0, conf: "low", reason: `tooltip says this item takes no star force, but ${claimed} star${claimed === 1 ? "" : "s"} were read` }
      : { star: 0, conf: "high", reason: undefined };
  }

  let star: number;
  let conf: Conf;
  let reason: string | undefined;

  if (i.pixel !== undefined) {
    const other = i.model ?? i.second;
    if (other === undefined) {
      star = i.pixel; conf = "med";
      reason = `pixel count ${i.pixel}, no model read to corroborate it`;
    } else if (other === i.pixel) {
      star = i.pixel; conf = "high";
    } else if (Math.abs(other - i.pixel) === 1) {
      star = i.pixel; conf = "med";
      reason = `pixel count ${i.pixel} vs model ${other}`;
    } else {
      star = i.pixel; conf = "low";
      reason = `pixel count ${i.pixel} vs model ${other} — disagree by ${Math.abs(other - i.pixel)}`;
    }
  } else if (i.second !== undefined && i.model !== undefined) {
    if (i.second === i.model) {
      // Two reads by the same family of model are correlated, not independent.
      // Agreement is evidence, but it is not the pixel count, so: med, not high.
      star = i.second; conf = "med";
    } else {
      // The native-resolution crop of just the star row is the better look.
      star = i.second; conf = "low";
      reason = `star-row read ${i.second} vs full-screenshot read ${i.model}`;
    }
  } else if (i.second !== undefined) {
    star = i.second; conf = "low";
    reason = `single star-row read, ${i.second}, uncorroborated`;
  } else {
    star = i.model ?? 0; conf = "low";
    reason = `single model read of the full screenshot, uncorroborated`;
  }

  star = Math.max(0, Math.round(star));

  // Nothing in the game reads higher than the Lv.138+ ceiling, so a higher
  // number is a misread rather than a value, and it says so.
  if (star > MAX_STARS) {
    reason = `${reason ? reason + "; " : ""}read ${star} stars; ${MAX_STARS} is the game maximum`;
    star = i.cap > 0 ? i.cap : MAX_STARS;
    conf = "low";
  }

  // A count above the item's own cap is not a value to be quietly trimmed — it
  // is positive evidence that the read is wrong, and it is exactly what the old
  // code hid by correcting the level afterwards.
  if (i.cap > 0 && star > i.cap) {
    reason = `${reason ? reason + "; " : ""}read ${star} stars but this item caps at ${i.cap}`;
    star = i.cap;
    conf = "low";
  }
  return { star, conf, reason };
}

/* ---------- OpenRouter call ---------- */

// The usage object OpenRouter returns beside `choices`. It used to be read for
// the log line and thrown away; settle() now hands it to reconcileImportCost(),
// which prefers the provider's own `cost` when it is present. That is the
// measurement that eventually replaces IMPORT_UNIT_COST_USD_PLACEHOLDER, so the
// shape is the entitlement layer's rather than a second local copy of it.
type Usage = OpenRouterUsage;

type CallResult =
  | { kind: "ok"; text: string; finish: string; usage: Usage }
  | { kind: "status"; status: number }
  // `failure` is the same word the ledger settles on, decided where the cause is
  // actually known rather than re-derived later from the prose in `why`.
  | { kind: "error"; why: string; failure: Extract<ImportFailure, "timeout" | "network_error"> };

const PER_CALL_TIMEOUT_MS = 20_000;
/** json_schema → json_object → bare, plus one 429 backoff, plus the real call. */
const MAX_ATTEMPTS = 5;

async function callModel(
  key: string,
  model: string,
  mode: FormatMode,
  schema: typeof TOOLTIP_SCHEMA | typeof STARS_SCHEMA,
  prompt: string,
  image: string,
  maxTokens: number
): Promise<CallResult> {
  // A free endpoint that hangs must not consume the whole request budget and
  // leave the user staring at a spinner.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PER_CALL_TIMEOUT_MS);
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
        max_tokens: maxTokens,
        // These models burn output tokens narrating before they emit the object,
        // and reasoning tokens count against this budget. effort:"none" disables
        // reasoning outright on providers that honour it
        // (openrouter.ai/docs/use-cases/reasoning-tokens); the ones that ignore
        // it still narrate, which is why the message.reasoning fallback below
        // stays, and why the budget stays generous.
        reasoning: { effort: "none" },
        ...(mode === "schema"
          ? {
              response_format: { type: "json_schema", json_schema: schema },
              // Only route to endpoints that actually implement the schema
              // rather than silently dropping it and returning prose.
              provider: { require_parameters: true },
            }
          : mode === "object"
            ? { response_format: { type: "json_object" } }
            : {}),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) return { kind: "status", status: res.status };

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning?: string }; finish_reason?: string }>;
      usage?: Usage;
    };
    const choice = json.choices?.[0];
    // Reasoning models routinely return an empty content with the real answer
    // sitting in "reasoning". extractJson walks whatever it is given, so handing
    // it the reasoning text costs nothing and recovers the reply.
    const text = choice?.message?.content?.trim() || choice?.message?.reasoning?.trim() || "";
    return { kind: "ok", text, finish: choice?.finish_reason ?? "", usage: json.usage ?? {} };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return aborted
      ? { kind: "error", why: `timed out after ${PER_CALL_TIMEOUT_MS / 1000}s`, failure: "timeout" }
      : { kind: "error", why: "network error", failure: "network_error" };
  } finally {
    // Every exit — return, throw, abort — clears the timer. The previous shape
    // leaked one per `continue` and one per early return.
    clearTimeout(timer);
  }
}

/* ---------- instrumentation ---------- */

// This is the feature people are being charged for, so its behaviour is logged
// per request rather than inferred from complaints: which model answered, what
// it finished on, whether the structured-output contract was actually honoured,
// what it cost in tokens and wall time, and how confident the answer was.
interface LogLine {
  rid: string;
  mode: "tooltip" | "stars";
  model?: string;
  format?: FormatMode;
  schemaHonoured?: boolean;
  finish?: string;
  tokIn?: number;
  tokOut?: number;
  ms: number;
  conf?: ConfMap;
  outcome: string;
}

const logImport = (l: LogLine) => console.log(`[import] ${JSON.stringify(l)}`);

/**
 * Rolling per-field accuracy from tools/import-eval.ts, injected as JSON at
 * deploy time (e.g. IMPORT_EVAL_ACCURACY='{"star":0.94,"name":0.98}').
 *
 * UNVERIFIED BY CONSTRUCTION: this route does not know how good it is. It
 * returns null when the harness has not published a number, and the UI must
 * then say nothing rather than invent a figure. Selling a guess obliges us to
 * publish how good the guess is; it does not entitle us to make one up.
 */
function evalAccuracy(): Record<string, number> | null {
  const raw = process.env.IMPORT_EVAL_ACCURACY;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === "number" && n >= 0 && n <= 1) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/* ---------- the route ---------- */

interface ImportBody {
  image?: string;
  /** "stars" runs the single-question second pass over a star-row crop. */
  mode?: string;
  /** Deterministic count from lib/import/starPixels.ts, when the client ran it. */
  pixelStars?: number;
  /** What the first pass said, so the second pass can be reconciled against it. */
  modelStar?: number;
  /** Item level and superiority, so the second pass can apply the same cap. */
  lvl?: number;
  sup?: number;
}

const box = (v: unknown): number[] | null =>
  Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(Number(n)))
    ? v.map(Number)
    : null;

/**
 * One trip through the vision chain, as a value rather than a Response.
 *
 * The route has ten exits — three of them successful, seven not — and every one
 * of them owes the ledger a settle(). Returning the body and the outcome
 * together instead of a Response means the settle happens in exactly one place
 * (POST, below) and cannot be forgotten by the next person who adds an eleventh
 * exit. A leaked concurrency slot is a visitor who cannot import again until
 * the process restarts, which is not a failure anyone would connect to the edit
 * that caused it.
 */
interface RunResult {
  body: Record<string, unknown>;
  /** Omitted means 200. */
  status?: number;
  outcome: ImportOutcome;
}

/**
 * THE GATE. Nothing expensive happens above this line.
 *
 * guardImport() runs the whole fail-closed sequence — identity, ledger read,
 * concurrency, the demo ceiling, then an atomic commitSpend — and it runs
 * BEFORE req.json(), before the data URL is validated, and before any fetch to
 * openrouter.ai. That ordering is the entire point: a refusal must cost nothing
 * but a ledger read. Do not move a body parse or a validation above it "to
 * return a better error first" — a malformed request from an exhausted visitor
 * would then still be free to arrive a thousand times.
 */
export async function POST(req: Request) {
  const key = process.env.OPENROUTER_API_KEY;
  const guard = await guardImport(req, {
    // The dialog posts one image per request; MAX_BATCH_FILES is the ceiling if
    // that ever changes.
    batchSize: 1,
    // Folds the route's old bare 501 into the same vocabulary as every other
    // refusal, so the dialog has one rendering path.
    configured: Boolean(key),
  });

  if (!guard.allow) {
    // Verbatim. The body already carries `error` as a finished sentence, which
    // is the field ImportDialog reads today, plus reason/interest/interestPath
    // for a better rendering when someone gets to it.
    return NextResponse.json(guard.body, { status: guard.status, headers: guard.headers });
  }

  if (!key) {
    // Unreachable: `configured: false` denies with not_configured above. Kept so
    // the compiler sees a string below, and so an edit that loosens `configured`
    // still settles instead of leaking the slot it just reserved.
    await guard.settle({ ok: false, failure: "not_configured" });
    return NextResponse.json(
      { error: "Screenshot import isn't configured — OPENROUTER_API_KEY is not set.", reason: "not_configured" },
      { status: 501 }
    );
  }

  try {
    const run = await runImport(req, key);
    // EVERY exit path, including the ones that return an error body: settle
    // releases the concurrency slot as well as refunding the unit.
    await guard.settle(run.outcome);
    return NextResponse.json(
      run.outcome.ok
        ? {
            ...run.body,
            // Additive. The keys ImportDialog already reads are untouched.
            entitlement: { remaining: guard.remaining, limit: guard.limit, ledger: guard.ledger },
          }
        : run.body,
      { status: run.status ?? 200 }
    );
  } catch (err) {
    // Something outside the modelled failures — settle is idempotent, so this is
    // safe even if runImport already settled on its way out.
    await guard.settle({ ok: false, failure: "network_error" });
    throw err;
  }
}

async function runImport(req: Request, key: string): Promise<RunResult> {
  const startedAt = Date.now();
  const rid = Math.random().toString(36).slice(2, 8);

  let body: ImportBody;
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    // A malformed request spent no vision tokens, so the unit comes back:
    // settleImport() refunds an outcome with no named failure.
    return { body: { error: "Bad request body." }, status: 400, outcome: { ok: false } };
  }
  const image = body.image ?? "";
  if (!image.startsWith("data:image/")) {
    return { body: { error: "Expected a data:image/... URL." }, status: 400, outcome: { ok: false } };
  }
  // ~6MB of base64 is plenty for a full-screen grab and keeps us inside limits
  if (image.length > 8_000_000) {
    return {
      body: { error: "That image is too large — try a window capture." },
      status: 413,
      outcome: { ok: false },
    };
  }

  const starsMode = body.mode === "stars";
  const models = process.env.OPENROUTER_MODELS?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_MODELS;
  const origin = new URL(req.url).origin;

  // Track *why* each model didn't answer. "No tooltip in the image" and "every
  // free endpoint is rate-limited" are completely different problems and must
  // not produce the same message.
  const outcomes: Array<{ model: string; why: string }> = [];
  let anyModelAnswered = false;
  // What the ledger is told when the chain runs out. Set beside every
  // outcomes.push() so the two cannot drift: `why` is prose for the user,
  // `lastFailure` is the word that decides whether the unit comes back.
  // Defaults to model_http_error for the "no models configured" case, which is
  // our problem and not the visitor's.
  let lastFailure: ImportFailure = "model_http_error";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const model of models) {
    let format: FormatMode = "schema";
    // A json-mode downgrade used to consume attempt 0, which silently disabled
    // the 429 backoff. The two concerns get their own state.
    let retriedOn429 = false;

    // Two parameter downgrades plus one 429 backoff plus the call itself.
    let attempt = 0;
    for (; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await callModel(
        key, model, format,
        starsMode ? STARS_SCHEMA : TOOLTIP_SCHEMA,
        starsMode ? STAR_PROMPT : PROMPT,
        image,
        // The star row answers in ~20 tokens. Only the full tooltip needs room.
        starsMode ? 200 : 3000
      );

      if (r.kind === "error") {
        outcomes.push({ model, why: r.why });
        lastFailure = r.failure; // the 20s abort, or a fetch rejection
        break;
      }
      if (r.kind === "status") {
        // 400 is "I don't accept that parameter"; 404/422 is what OpenRouter
        // returns when `require_parameters` leaves no endpoint standing —
        // structurally the same problem, and the same answer: ask for less.
        if ((r.status === 400 || r.status === 404 || r.status === 422) && format !== "none") {
          format = weaken(format);
          continue;
        }
        if (r.status === 429 && !retriedOn429 && Date.now() - startedAt < 28_000) {
          retriedOn429 = true;
          await sleep(2500);
          continue;
        }
        outcomes.push({ model, why: `HTTP ${r.status}${r.status === 429 ? " (rate limited)" : ""}` });
        lastFailure = "model_http_error"; // 429 / 403 / 404 from a model
        break;
      }

      anyModelAnswered = true;
      const truncated = r.finish === "length";

      /* ---------- second pass: one question, one answer ---------- */
      if (starsMode) {
        const { value } = extractJson<VisionStarRow>(r.text);
        if (!value || num(value.stars, MAX_STARS) === undefined) {
          outcomes.push({ model, why: `could not count the star row: "${r.text.replace(/\s+/g, " ").slice(0, 90)}"` });
          lastFailure = "unparseable";
          break;
        }
        const second = num(value.stars, MAX_STARS);
        const pixel = num(body.pixelStars, MAX_STARS);
        const modelStar = num(body.modelStar, MAX_STARS);
        // The crop carries no level text, so the cap has to come from the
        // caller. Without it sfCap() would read 0 and every count would be
        // clamped to nothing — so an absent lvl means "do not cap", not "cap 0".
        const capProbe: Item = {
          name: "", lvl: num(body.lvl, 300) ?? 0, star: 0, pot: "none",
          sup: body.sup ? 1 : 0, p: [], f: [],
        };
        const rowVerdict = reconcileStars({
          pixel, model: modelStar, second,
          cap: body.lvl || body.sup ? sfCap(capProbe) : 0,
          cannotStar: false,
        });
        logImport({
          rid, mode: "stars", model, format, schemaHonoured: format === "schema",
          finish: r.finish, tokIn: r.usage.prompt_tokens, tokOut: r.usage.completion_tokens,
          ms: Date.now() - startedAt, outcome: `star=${rowVerdict.star} conf=${rowVerdict.conf}`,
        });
        return {
          body: {
            model,
            mode: "stars",
            stars: rowVerdict.star,
            grey: num(value.grey, MAX_STARS) ?? null,
            sure: !!value.sure,
            modelStars: second ?? null,
            pixelStars: pixel ?? null,
            conf: rowVerdict.conf,
            reason: rowVerdict.reason ?? null,
          },
          outcome: { ok: true, model, usage: r.usage },
        };
      }

      /* ---------- first pass: the whole tooltip ---------- */
      const { value: parsed, salvaged } = extractJson<VisionItem>(r.text);
      if (!parsed) {
        // Surface what it actually said — guessing at this cost several rounds.
        const snip = r.text.replace(/\s+/g, " ").trim().slice(0, 160);
        outcomes.push({
          model,
          why: truncated
            ? `ran out of output tokens before closing the JSON: "${snip.slice(0, 90)}"`
            : snip
              ? `replied but not with JSON: "${snip}"`
              : "returned an empty message",
        });
        lastFailure = "unparseable";
        break;
      }

      const stats = tidyStatWindow(parsed.stats);
      const roster = tidyRoster(parsed.roster);
      const rawName = str(parsed.name) ?? "";
      if (!rawName && !stats && !roster) {
        outcomes.push({ model, why: "read the image but found no item tooltip, stat window or character list" });
        // NOT refunded (REFUND_ON_NO_CONTENT is false): the model read the image
        // and the vision tokens were really spent. The visitor sent a screenshot
        // with nothing in it, which is a different thing from us failing.
        lastFailure = "no_content";
        break;
      }
      if (!rawName) {
        // Stats and/or roster only — no item in this shot, which is fine.
        logImport({
          rid, mode: "tooltip", model, format, schemaHonoured: format === "schema" && !salvaged,
          finish: r.finish, tokIn: r.usage.prompt_tokens, tokOut: r.usage.completion_tokens,
          ms: Date.now() - startedAt, outcome: stats && roster ? "stats+roster" : stats ? "stats" : "roster",
        });
        return {
          body: {
            model, item: null, slotGuess: null, iconBox: null, tooltipBox: null,
            stats, roster, conf: null, reasons: null, db: null, flags: [],
            accuracy: evalAccuracy(),
          },
          outcome: { ok: true, model, usage: r.usage },
        };
      }

      /* ---- cross-validate against the database we already query ---- */
      const rawSlot = (parsed.slot ?? "").toLowerCase().trim();
      const modelSlot = SLOT_ALIASES[rawSlot] ?? (rawSlot || null);
      const db = await lookupItem(origin, rawName, modelSlot);

      const reasons: ReasonMap = {};
      const flags: string[] = [];

      // (a) the database level is the item's required level. The model reading
      // "Lv. 95" off a Lv. 110 item is what produced star counts above the cap —
      // but correcting the level silently is what HID that bug, so the star
      // read gets flagged below rather than rescued.
      const modelLvl = Number.isFinite(parsed.level) ? Math.max(0, Math.min(300, Number(parsed.level))) : 0;
      const lvl = db?.level || modelLvl;
      let confLvl: Conf = "low";
      if (db?.level) {
        confLvl = "high";
        if (modelLvl && modelLvl !== db.level) {
          reasons.lvl = `model read Lv.${modelLvl}, database says Lv.${db.level}`;
          flags.push("level");
        }
      } else if (modelLvl > 0) {
        confLvl = "med";
        reasons.lvl = "no database match, so the level is the model's read alone";
      } else {
        reasons.lvl = "no level could be read";
      }

      // (e) the database subcategory outranks the model's guess at the slot.
      let slot = modelSlot;
      let confSlot: Conf = "low";
      if (db?.slot) {
        if (!modelSlot || fam(db.slot) === fam(modelSlot)) {
          confSlot = "high";
          // Keep the model's numbered slot (ring3) when it agrees on the family.
          slot = modelSlot && fam(modelSlot) === fam(db.slot) ? modelSlot : db.slot;
        } else {
          slot = db.slot;
          confSlot = "low";
          reasons.slot = `model said ${modelSlot}, database subcategory "${db.sub}" is ${db.slot}`;
          flags.push("slot");
        }
      } else if (modelSlot) {
        // Weapons have no subcategory mapping upstream, so "unconfirmed" here is
        // the normal case for a weapon rather than a sign of a bad read.
        confSlot = "med";
      }

      const name = db?.name ?? rawName;
      const confName: Conf = !db ? "low" : db.distance === 0 ? "high" : "med";
      if (!db) reasons.name = "no database match — check the spelling";
      else if (db.distance > 0) reasons.name = `corrected from "${rawName}", edit distance ${db.distance}`;
      if (confName !== "high") flags.push("name");

      const tier: Tier = TIERS.includes(parsed.tier as Tier) ? (parsed.tier as Tier) : "none";
      const sup: 0 | 1 = parsed.superior || db?.superior ? 1 : 0;

      const pot = keepStatLines(parsed.potential);
      const flame = keepStatLines(parsed.flame);
      const noPot = !!parsed.noPotential;
      const noFl = !!parsed.noFlame;

      // "Potential : Can't Enhance" is itself a definite reading — there is
      // nothing left to be unsure about. A missing tier line is not.
      let confPot: Conf = "high";
      if (!noPot && tier === "none") { confPot = "med"; reasons.pot = "no potential tier line was read"; }

      let confP: Conf;
      if (noPot) confP = "high";
      else if (pot.dropped > 0) {
        confP = "low";
        reasons.p = `${pot.dropped} line${pot.dropped === 1 ? "" : "s"} did not look like a stat line and ${pot.dropped === 1 ? "was" : "were"} dropped`;
      } else if (tier !== "none" && pot.lines.length === 0) {
        confP = "low";
        reasons.p = `tier reads ${tier} but no potential lines survived`;
      } else confP = pot.lines.length ? "high" : "med";
      if (confP === "low") flags.push("potential");

      let confF: Conf;
      if (noFl) confF = "high";
      else if (flame.dropped > 0) {
        confF = "low";
        reasons.f = `${flame.dropped} line${flame.dropped === 1 ? "" : "s"} did not look like a stat line and ${flame.dropped === 1 ? "was" : "were"} dropped`;
      } else {
        // Never better than med: a tooltip showing no flame line is
        // indistinguishable from one whose flame line the cursor was covering.
        confF = "med";
      }
      if (confF === "low") flags.push("flame");

      /* ---- (b)(c)(d) stars, against the cap the database just gave us ---- */
      const capItem: Item = {
        name, lvl, star: 0, pot: tier, sup, p: [], f: [], sub: db?.sub,
        noSf: !!parsed.noStarForce,
      };
      const slotDef: SlotDef | undefined = slot ? SLOTS.find((s) => s.id === slot) : undefined;
      // canStarForce needs a slot to answer; with no slot at all, fall back to
      // the tooltip's own declaration rather than assuming either way.
      const cannotStar = slotDef ? !canStarForce(slotDef, capItem) : !!parsed.noStarForce;
      const verdict = reconcileStars({
        pixel: num(body.pixelStars, MAX_STARS),
        // Deliberately NOT pre-clamped to 30: an absurd read is evidence, and
        // the reason string should quote what the model actually said.
        model: Number.isFinite(parsed.starforce) ? Math.max(0, Math.min(99, Number(parsed.starforce))) : undefined,
        // With no level and no superior marking there is no cap to test against,
        // and sfCap()'s floor of 5 would wrongly trim a real 17-star item.
        cap: lvl > 0 || sup ? sfCap(capItem) : 0,
        cannotStar,
      });
      if (verdict.reason) reasons.star = verdict.reason;
      // Say so when the cap check — the one piece of hard evidence we have about
      // star force — could not run at all. Silence would read as corroboration.
      if (!lvl && !sup && verdict.conf !== "high") {
        reasons.star = `${reasons.star ? reasons.star + "; " : ""}no level, so the star cap could not be checked`;
      }
      if (verdict.conf !== "high") flags.push("star force");

      const conf: ConfMap = {
        name: confName, lvl: confLvl, star: verdict.conf, slot: confSlot,
        pot: confPot, p: confP, f: confF,
      };

      logImport({
        rid, mode: "tooltip", model, format, schemaHonoured: format === "schema" && !salvaged,
        finish: r.finish, tokIn: r.usage.prompt_tokens, tokOut: r.usage.completion_tokens,
        ms: Date.now() - startedAt, conf, outcome: `item "${name}"`,
      });

      return {
        body: {
          model,
          item: {
            name,
            lvl,
            star: verdict.star,
            pot: tier,
            sup,
            noSf: !!parsed.noStarForce,
            noFl,
            noPot,
            p: noPot ? [] : pot.lines,
            f: noFl ? [] : flame.lines,
          },
          slotGuess: slot,
          iconBox: box(parsed.iconBox),
          // Additive: the star-row crop region, for the native-resolution second
          // pass and for the pixel counter. Null when the model found no star row.
          tooltipBox: box(parsed.tooltipBox),
          stats,
          roster,
          // Additive: everything the UI needs to point at ONE field instead of
          // asking the user to re-verify all eight.
          conf,
          reasons,
          flags,
          db: db
            ? {
                itemId: db.itemId, name: db.name, sub: db.sub, level: db.level,
                superior: db.superior, bossDrop: db.bossDrop,
                corrected: db.distance > 0, distance: db.distance,
              }
            : null,
          accuracy: evalAccuracy(),
        },
        outcome: { ok: true, model, usage: r.usage },
      };
    }
    // Only reachable if every attempt asked for a retry and none succeeded —
    // without this the model would vanish from `outcomes` and the user would be
    // told "no models responded" with an empty parenthesis.
    if (attempt >= MAX_ATTEMPTS) {
      outcomes.push({ model, why: `gave up after ${MAX_ATTEMPTS} attempts (parameter downgrades and rate-limit backoff)` });
      // Every attempt ended in a status we retried — that is an HTTP failure.
      lastFailure = "model_http_error";
    }
  }

  const detail = outcomes.map((o) => `${o.model} — ${o.why}`).join("; ");
  const error = anyModelAnswered
    ? `A model read the image but found nothing it could use. Show an item tooltip, the Stat window, or the Switch Character list. (${detail})`
    : `No vision model responded — free endpoints are likely rate-limited right now. Wait a minute and retry. (${detail})`;

  logImport({
    rid, mode: starsMode ? "stars" : "tooltip", ms: Date.now() - startedAt,
    outcome: `failed: ${detail || "no models configured"}`,
  });

  // `lastFailure` is what decides whether the unit comes back. "no_content" —
  // a model read the image and found nothing in it — keeps it, because the
  // vision tokens were really spent. Every other ending here (timeout, HTTP,
  // network, unparseable) is our failure and is refunded in full: a visitor
  // must not lose demo to somebody else's rate limit.
  return {
    body: { error, outcomes },
    status: 503,
    outcome: { ok: false, failure: lastFailure },
  };
}
