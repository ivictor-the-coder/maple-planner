// Parses the text of a MapleStory item tooltip into an Item.
//
// Works on OCR output or pasted text. OCR is lossy, so every rule here is
// deliberately tolerant and every result is reported with a confidence flag
// so the UI can make the user confirm before anything is written.

import type { Item, Tier } from "../rules";

export interface ParsedItem {
  item: Item;
  slotGuess: string | null;
  /** Fields we actually found, so the review step can highlight the rest. */
  found: {
    name: boolean;
    lvl: boolean;
    pot: boolean;
    potLines: number;
    flameLines: number;
    superior: boolean;
  };
  warnings: string[];
  raw: string;
}

/* Tooltip slot words → planner slot ids. Rings/pendants are ambiguous by
   nature (four ring slots), so they resolve to the first of their group and
   the user moves it if needed. */
const SLOT_WORDS: Array<[RegExp, string]> = [
  [/\bhat\b/i, "hat"],
  [/\boverall\b/i, "top"],
  [/\btop\b|\bcoat\b/i, "top"],
  [/\bbottom\b|\bpants\b/i, "bottom"],
  [/\bshoes\b/i, "shoes"],
  [/\bglove(s)?\b/i, "gloves"],
  [/\bcape\b/i, "cape"],
  [/\bshoulder\b/i, "shoulder"],
  [/\bbelt\b/i, "belt"],
  [/\bpendant\b/i, "pendant1"],
  [/\bring\b/i, "ring1"],
  [/\bearring(s)?\b/i, "earring"],
  [/\bface accessory\b|\bface\b/i, "face"],
  [/\beye accessory\b|\beye\b/i, "eye"],
  [/\bemblem\b/i, "emblem"],
  [/\bbadge\b/i, "badge"],
  [/\bmedal\b/i, "medal"],
  [/\bheart\b/i, "heart"],
  [/\bpocket\b/i, "pocket"],
  [/\bsecondary\b|\bshield\b/i, "secondary"],
  [/\bweapon\b/i, "weapon"],
  [/\bandroid\b/i, "android"],
];

const TIERS: Array<[RegExp, Tier]> = [
  [/legendary/i, "legendary"],
  [/unique/i, "unique"],
  [/epic/i, "epic"],
  [/rare/i, "rare"],
];

/** Lines that are chrome, not data. */
const NOISE =
  /^(untradable|tradable|combat power|currently equipped|check the enhancement|you can|required job|set effect|cash item|one-of-a-kind|item cannot|exclusive|category|bonus stats can)/i;

/** OCR frequently renders these wrong; normalise before matching. */
function normalise(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/[|]/g, "I")
    .replace(/[–—]/g, "-")
    .replace(/·/g, "•")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function titleCaseish(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/* Only these carry flames worth recording. Speed, Jump, Max HP, Max MP and
   Defense also show parentheticals, but those are almost always star force —
   reading them as flames is how you end up advising someone to reroll a
   perfectly good item. */
const FLAMEABLE = /^(str|dex|int|luk|all stats?|attack power|magic att)$/i;
const MAIN_STAT = /^(str|dex|int|luk)$/i;

interface StatParen { stat: string; nums: number[]; pct: boolean }

function readStatLine(line: string): StatParen | null {
  const m = line.match(/^([A-Za-z][A-Za-z .]*?)\s*\+?[\d,]+(%?)\s*\(([^)]+)\)/);
  if (!m) return null;
  const nums = m[3]
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => parseInt(p.replace(/[^\d]/g, ""), 10))
    .filter((n) => !Number.isNaN(n));
  return { stat: titleCaseish(m[1]), nums, pct: m[2] === "%" };
}

/**
 * A tooltip stat line reads `STR +111 (40 +51 +20)` — that is
 * (base + star force + flame), so three groups gives the flame outright.
 *
 * Two groups is ambiguous: `(50 +24)` could be base+flame or base+starforce.
 * Star force raises STR, DEX, INT and LUK by the *same* amount, so if a value
 * appears on only some of the main stats it must be a flame; if every main
 * stat present shares it, it is star force.
 */
function extractFlames(lines: string[], canEnhance: boolean): string[] {
  if (!canEnhance) return [];

  const parsed: StatParen[] = [];
  for (const l of lines) {
    if (/^potential/i.test(l)) break;
    const p = readStatLine(l);
    if (p && FLAMEABLE.test(p.stat)) parsed.push(p);
  }

  // Which two-group values look like a uniform main-stat bump? That's star force.
  const twoGroupMain = parsed.filter((p) => p.nums.length === 2 && MAIN_STAT.test(p.stat));
  const values = new Set(twoGroupMain.map((p) => p.nums[1]));
  const uniformStarForce = twoGroupMain.length >= 3 && values.size === 1;

  const out: string[] = [];
  for (const p of parsed) {
    if (out.length >= 3) break;
    if (p.nums.length >= 3) {
      const v = p.nums[p.nums.length - 1];
      if (v > 0) out.push(`${p.stat} +${v}${p.pct ? "%" : ""}`);
    } else if (p.nums.length === 2) {
      const [base, second] = p.nums;
      if (second <= 0) continue;
      if (uniformStarForce && MAIN_STAT.test(p.stat)) continue;
      if (base === 0 || MAIN_STAT.test(p.stat) || /all stats?/i.test(p.stat)) {
        out.push(`${p.stat} +${second}${p.pct ? "%" : ""}`);
      }
    }
  }
  return out;
}

export function parseTooltip(input: string): ParsedItem {
  const text = normalise(input);
  const lines = text.split("\n");
  const warnings: string[] = [];

  /* ---- name: first substantive line ---- */
  let name = "";
  for (const l of lines) {
    if (NOISE.test(l)) continue;
    if (/^(lv\.?|required|potential|bonus)/i.test(l)) continue;
    if (/^[+\-•*]/.test(l)) continue;
    if (l.length < 3) continue;
    name = titleCaseish(l);
    break;
  }
  if (!name) warnings.push("Could not read the item name.");

  /* ---- required level ----
     Only ever trust an explicit "Required Level". A bare "Lv. 244" also appears
     in the character HUD, and reading that gives you your own level instead of
     the item's. */
  let lvl = 0;
  const lvlMatch = text.match(/required\s*level\s*:?\s*lv\.?\s*(\d{1,3})/i);
  if (lvlMatch) lvl = parseInt(lvlMatch[1], 10);
  if (lvl > 300) lvl = 0;
  if (!lvl) warnings.push("Could not read the required level — crop tighter, or set it yourself.");

  /* ---- slot ---- */
  let slotGuess: string | null = null;
  for (const [re, id] of SLOT_WORDS) {
    if (re.test(text)) { slotGuess = id; break; }
  }

  /* ---- potential tier + lines ---- */
  let pot: Tier = "none";
  const potIdx = lines.findIndex((l) => /^potential\b/i.test(l) || /potential\s*:/i.test(l));
  if (potIdx >= 0) {
    const header = lines[potIdx];
    for (const [re, t] of TIERS) {
      if (re.test(header)) { pot = t; break; }
    }
    if (pot === "none") {
      const next = lines[potIdx + 1] || "";
      for (const [re, t] of TIERS) if (re.test(next)) { pot = t; break; }
    }
  }

  const potLines: string[] = [];
  if (potIdx >= 0) {
    for (let i = potIdx + 1; i < lines.length && potLines.length < 3; i++) {
      const l = lines[i];
      if (/^bonus potential/i.test(l)) break;
      const cleaned = l.replace(/^[•*\-•]\s*/, "").replace(/\s*:\s*\+/, " +").trim();
      if (!cleaned) continue;
      if (!/[+\-]\s*\d/.test(cleaned)) continue;
      potLines.push(titleCaseish(cleaned));
    }
  }
  if (pot !== "none" && potLines.length === 0) warnings.push("Found a potential tier but no lines.");

  /* ---- superior gear, and whether flames are possible at all ---- */
  const cannotEnhance = /bonus stats can'?t enhance/i.test(text);
  const superior = /\b(tyrant|superior)\b/i.test(text) || cannotEnhance;

  /* ---- flames, inferred from the stat parentheticals ---- */
  const flames = extractFlames(lines, !cannotEnhance);
  if (cannotEnhance) warnings.push("This item can't take bonus stats, so no flame was read.");

  const item: Item = {
    name,
    lvl,
    star: 0, // stars are drawn as graphics; OCR can't see them
    pot,
    sup: superior ? 1 : 0,
    p: [potLines[0] ?? "", potLines[1] ?? "", potLines[2] ?? ""],
    f: [flames[0] ?? "", flames[1] ?? "", flames[2] ?? ""],
  };

  warnings.push("Star force can't be read from a screenshot — set it yourself.");

  return {
    item,
    slotGuess,
    found: {
      name: !!name,
      lvl: lvl > 0,
      pot: pot !== "none",
      potLines: potLines.length,
      flameLines: flames.length,
      superior,
    },
    warnings,
    raw: text,
  };
}
