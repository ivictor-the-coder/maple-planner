// Parses the text of a MapleStory item tooltip into an Item.
//
// Works on OCR output or pasted text. OCR is lossy, so every rule here is
// deliberately tolerant and every result is reported with a confidence flag
// so the UI can make the user confirm before anything is written.

import type { Item, Tier } from "../rules";
import {
  describeTooltipAggregate,
  readTooltipAggregate,
  type TooltipAggregateReading,
} from "./bonusStats";

export interface ParsedItem {
  item: Item;
  slotGuess: string | null;
  /** Fields we actually found, so the review step can highlight the rest. */
  found: {
    name: boolean;
    lvl: boolean;
    pot: boolean;
    potLines: number;
    /** Always 0 from this parser now — see the comment on `bonusStats`. */
    flameLines: number;
    superior: boolean;
  };
  /**
   * What the tooltip's combined stat block could honestly say about bonus
   * stats: per-stat TOTALS where the parenthetical spelled out three groups,
   * and the names of the stats it could not resolve. `lines` is always null.
   *
   * Undefined when the text carried no parentheticals at all.
   *
   * ADDITIVE. components/ImportDialog.tsx builds its own ParsedItem for the
   * screenshot path and ignores unknown keys, so nothing breaks by its absence.
   */
  bonusStats?: TooltipAggregateReading;
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

/**
 * The tooltip's stat lines, up to the potential block.
 *
 * WHAT USED TO BE HERE, and why it is gone. `extractFlames()` turned this block
 * into a confident list of flame lines: three parenthesised groups gave the
 * flame outright, and two groups were resolved with a uniformity heuristic —
 * star force lands on every main stat equally, so a value shared by three or
 * more main stats is star force and anything else is a flame.
 *
 * That produced, on the owner's Black Bean Mark, "STR +31" — which is star
 * force. The heuristic needed three two-group main stats and the item only had
 * two (DEX and INT carried a third group), so the shared +31 was promoted to a
 * flame. It also emitted "DEX +59", the sum of two separate bonus stat lines,
 * and it dropped Attack Power and Max HP because they were not on its list of
 * stats worth reading. The full observation is OBSERVED_BONUS_STAT_PANEL in
 * ./damageReadings.ts.
 *
 * So this parser no longer produces flame lines at all. ./bonusStats.ts records
 * what the block CAN state — a per-stat bonus TOTAL where the parenthetical had
 * three groups — and names the stats it cannot resolve, and the caller is told
 * to screenshot Enhance > Bonus Stats for the lines themselves. A missing flame
 * is a prompt to go look; an invented one sends someone to reroll a good item.
 */
function statBlockLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (/^potential/i.test(l)) break;
    out.push(l);
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

  /* ---- bonus stats: what the aggregate block can honestly support ---- */
  const bonusStats = cannotEnhance ? undefined : readTooltipAggregate(statBlockLines(lines));
  if (cannotEnhance) {
    warnings.push("This item can't take bonus stats, so no bonus stat was read.");
  } else if (bonusStats) {
    warnings.push(`Bonus stat lines ${describeTooltipAggregate(bonusStats)}.`);
  }

  const item: Item = {
    name,
    lvl,
    star: 0, // stars are drawn as graphics; OCR can't see them
    pot,
    sup: superior ? 1 : 0,
    p: [potLines[0] ?? "", potLines[1] ?? "", potLines[2] ?? ""],
    // Three empty strings, always. The padding is the wire format lib/portable.ts
    // expects; the emptiness is the point — see statBlockLines() above. A bonus
    // stat line only comes from the Bonus Stat panel, which is a screenshot this
    // text parser never sees.
    f: ["", "", ""],
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
      flameLines: 0,
      superior,
    },
    ...(bonusStats ? { bonusStats } : {}),
    warnings,
    raw: text,
  };
}
