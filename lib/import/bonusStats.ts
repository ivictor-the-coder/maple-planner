// Reads BONUS STATS from the panel the game states them on, and refuses to
// manufacture a line list out of the item tooltip's aggregate stat block.
//
// THE BUG THIS FILE EXISTS FOR is recorded verbatim as OBSERVED_BONUS_STAT_PANEL
// in ./damageReadings.ts. Short version: the importer read bonus stats off the
// item tooltip, where base + star force + bonus are already ADDED TOGETHER and
// only the colour of each number tells them apart. From that block it produced
// "STR +31" (star force, not a bonus stat), "DEX +59" (two separate lines
// summed) and "INT +24" (half of a combined "DEX, INT +24" line), and it dropped
// "Attack Power +6" and "Max HP +2340" entirely.
//
// THE FIX IS STRUCTURAL, NOT A BETTER REGEX. The Enhance > Bonus Stats panel
// states every line unambiguously: one row per line, the stats it names, the one
// value it grants, and a tier badge. Read that. What the tooltip's aggregate
// block can still tell us is kept — and kept clearly labelled as a per-stat
// TOTAL rather than as a list of lines, because those are different facts and
// only one of them prices a reset.
//
// THREE INVARIANTS, each one a way the old reader was wrong:
//
//   1. A LINE CAN NAME MORE THAN ONE STAT. "DEX, INT +24" is ONE line granting
//      +24 to each. `BonusStatLine.stats` is therefore a list and `.value` is a
//      single number. Splitting it into two lines, or keeping only one of the
//      two stats, both lose the fact that a reset rerolls it as a unit.
//   2. TWO LINES CAN NAME THE SAME STAT. "DEX +24" and "DEX +35" are two rows
//      that happen to share a stat. Nothing here ever adds them: a single
//      "DEX +59" cannot be told apart from a real one-line +59, and those two
//      items are worth different amounts of rerolling.
//   3. EVERY STAT THE PANEL LISTS IS A BONUS STAT LINE, not just main stats.
//      Attack Power is the most valuable flame line there is; dropping it
//      biases every flame recommendation the app makes.
//
// WHY A SEPARATE FILE, like ./damageReadings.ts and ./visionFields.ts before it:
// app/api/import/route.ts imports next/server and the entitlement store and is
// reachable only through an HTTP request that spends real vision tokens, so the
// code that decides whether a number becomes a bonus stat cannot be run against
// fixed inputs from there. `__selfTest()` at the bottom is that run.

/* ------------------------------------------------------------------ *
 * The vocabulary
 * ------------------------------------------------------------------ */

/**
 * The canonical spelling of every stat this file will name in a wire line.
 *
 * THESE EXACT SPELLINGS ARE LOAD-BEARING, not cosmetic. lib/rules.ts reads a
 * flame line back with plain regexes — `statFlat` matches /\b(str|dex|int|luk)\b/
 * and /all ?stat/, `attFlat` matches /\b(att|attack power|magic att)\b/,
 * `isDeadLine` matches /\b(max ?mp|mp|speed|jump)\b/ and /\bdef(ense)?\b/ — so
 * "Attack Power" is understood downstream and "ATK" would silently be worth
 * zero. Normalising here is what keeps a renamed line from becoming an unpriced
 * one.
 *
 * COMPLETENESS IS `unverified`. This is the set the panel was observed to use
 * (Attack Power, Max HP, DEX, INT on the Black Bean Mark) plus the set
 * lib/import/tooltip.ts already named, plus the movement and defence lines the
 * tooltip prints. Nobody has enumerated every stat a bonus stat can roll. An
 * unlisted name is therefore NOT dropped — see `canonicalStat` — it is kept
 * verbatim and flagged, so a gap in this table costs a tidy spelling rather
 * than a whole line.
 */
export const BONUS_STAT_NAMES = [
  "STR", "DEX", "INT", "LUK", "All Stats",
  "Max HP", "Max MP", "Attack Power", "Magic ATT", "Defense", "Speed", "Jump",
] as const;

export type KnownBonusStat = (typeof BONUS_STAT_NAMES)[number];

/**
 * Lowercased spellings a model, an OCR pass or a locale might hand us, mapped to
 * the canonical one above. Keys are matched after lowercasing, collapsing
 * whitespace and stripping trailing punctuation.
 */
const STAT_ALIASES: Record<string, KnownBonusStat> = {
  str: "STR", strength: "STR",
  dex: "DEX", dexterity: "DEX",
  int: "INT", intelligence: "INT",
  luk: "LUK", luck: "LUK",
  "all stat": "All Stats", "all stats": "All Stats", allstat: "All Stats", allstats: "All Stats",
  hp: "Max HP", "max hp": "Max HP", maxhp: "Max HP", "max. hp": "Max HP",
  mp: "Max MP", "max mp": "Max MP", maxmp: "Max MP", "max. mp": "Max MP",
  att: "Attack Power", atk: "Attack Power", attack: "Attack Power",
  "attack power": "Attack Power", "weapon att": "Attack Power",
  "weapon attack": "Attack Power", watt: "Attack Power",
  "magic att": "Magic ATT", "magic atk": "Magic ATT", matt: "Magic ATT",
  "m. att": "Magic ATT", "m att": "Magic ATT", "magic attack": "Magic ATT",
  "magic attack power": "Magic ATT",
  def: "Defense", defense: "Defense", defence: "Defense", armor: "Defense",
  speed: "Speed", jump: "Jump",
};

/* ------------------------------------------------------------------ *
 * The shape of one line
 * ------------------------------------------------------------------ */

/**
 * ONE ROW of the Bonus Stat panel.
 *
 * `stats` is a list because "DEX, INT +24" is one row granting +24 to BOTH — see
 * invariant 1 at the top of this file. `value` is the number printed once on
 * that row, and it applies to each stat named; it is NOT divided between them
 * and NOT summed with any other row.
 */
export interface BonusStatLine {
  /** Every stat this one row names, canonicalised, in the order printed. */
  stats: string[];
  /** The single value the row grants to EACH stat in `stats`. Always > 0. */
  value: number;
  /** True only when a % was printed on the row. */
  pct: boolean;
  /**
   * The small tier badge printed beside the row. Absent when unreadable.
   * The observed panel showed 6, 6, 5, 6. No range is claimed here — the
   * accepted span below is a guard, not a sourced cap.
   */
  tier?: number;
  /**
   * False when at least one stat name was not in BONUS_STAT_NAMES and was kept
   * verbatim. The line is still real; its spelling is just unconfirmed, and
   * lib/rules.ts will price it at zero rather than misprice it.
   */
  recognised: boolean;
}

/** What one reading of the panel yielded. */
export interface BonusStatPanelReading {
  /** One entry per printed row, in the order printed. */
  lines: BonusStatLine[];
  /** Rows that did not survive the shape check, so confidence can fall. */
  dropped: number;
  /**
   * The headline figure beside the item name, e.g. "+23".
   *
   * RECORDED, NEVER USED. On the observed item the headline read +23 while the
   * rows read 24, 6, 35 and 2340, so it is plainly not their sum and nobody has
   * established what it is. Cross-checking the rows against it would be
   * arithmetic on an unknown, which is how the bug this file fixes started.
   * Provenance: `unverified`.
   */
  headline?: number;
  /** The item name printed in the panel header, when readable. */
  itemName?: string;
}

/* ------------------------------------------------------------------ *
 * Guards. Not game constants — see THE HONESTY LEDGER in CLAUDE.md.
 * ------------------------------------------------------------------ */

/**
 * Loose upper bound on a flat bonus stat value. A GUARD, not a cap: nobody has
 * measured the largest Max HP flame, and a tight bound would be an invented
 * constant. Its only job is to reject a seven-figure neighbour that landed in
 * this field — a Combat Power or a DAMAGE RANGE.
 */
export const BONUS_STAT_FLAT_SANITY_MAX = 1_000_000;

/** Same idea for a percent row: above 100% is not a bonus stat, it is a misread. */
export const BONUS_STAT_PCT_SANITY_MAX = 100;

/** Most rows a panel reading will accept. A guard against a model that starts
 *  listing the whole tooltip, not a claim about how many bonus stats an item
 *  can hold — the observed item had four and no maximum has been sourced. */
export const BONUS_STAT_MAX_LINES = 8;

/** Most stats one row will accept. The observed combined row named two. */
const MAX_STATS_PER_LINE = 4;

/** Hard tells that a "row" is the model talking rather than reading. Same list
 *  as the one app/api/import/route.ts applies to potential lines, plus the two
 *  words a refusal to read this panel would use. */
const NARRATION =
  /\b(?:i |let me|the (?:image|screenshot|tooltip|item|panel|window)|appears|cannot|unable|looks like|seems|shows|there (?:is|are)|unreadable|unknown)\b/i;

/* ------------------------------------------------------------------ *
 * Field readers
 * ------------------------------------------------------------------ */

const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * One stat name, canonicalised.
 *
 * Returns `known: false` rather than undefined for a name that is shaped like a
 * stat but is not in the table. DROPPING IT WOULD BE THE OLD BUG IN MINIATURE:
 * the whole reason Attack Power went missing is that a reader decided which
 * stats were worth keeping. A row that names something this file has not heard
 * of is still a row the player paid to roll.
 */
function canonicalStat(raw: unknown): { name: string; known: boolean } | undefined {
  if (typeof raw !== "string") return undefined;
  const t = tidy(raw).replace(/[:+\-]+$/, "").trim();
  if (!t) return undefined;
  const hit = STAT_ALIASES[t.toLowerCase()];
  if (hit) return { name: hit, known: true };
  // Shape gate for an unlisted name: one to three short alphabetic words, no
  // digits, no narration. "Boss Damage" passes; "I cannot read this" does not.
  if (!/^[A-Za-z][A-Za-z.' ]{0,23}$/.test(t)) return undefined;
  if (NARRATION.test(t)) return undefined;
  if (t.split(" ").length > 3) return undefined;
  return { name: t, known: false };
}

/** Split a printed stat cell into its names: "DEX, INT" -> ["DEX", "INT"]. */
function splitStats(raw: string): string[] {
  return raw
    .split(/\s*(?:,|\/|&|\+|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A number a model may have typed as a number, "24", "+24", "2,340" or "6%". */
function readValue(raw: unknown, pct: boolean): number | undefined {
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const t = raw.trim().replace(/,/g, "").replace(/%$/, "").replace(/^\+/, "");
    if (!/^\d+(?:\.\d+)?$/.test(t)) return undefined;
    n = parseFloat(t);
  } else {
    return undefined;
  }
  if (!Number.isFinite(n)) return undefined;
  // Zero is rejected for the same reason lib/import/damageReadings.ts rejects a
  // zero damage reading: the panel never prints a +0 row, so a 0 here is a model
  // filling in a required field it could not see.
  if (n <= 0) return undefined;
  return n <= (pct ? BONUS_STAT_PCT_SANITY_MAX : BONUS_STAT_FLAT_SANITY_MAX) ? n : undefined;
}

/** The tier badge, when it is a plausible badge. 1-9 is a guard; the real span
 *  is not sourced here and the badge is advisory either way. */
function readTier(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw.trim(), 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n : undefined;
}

/* ---- string form: "DEX, INT +24" ---- */

/** "DEX, INT +24", "Attack Power : +6", "Max HP +2,340", "All Stats +5%". */
const SHAPE_TRAILING_VALUE =
  /^([A-Za-z][A-Za-z.,/&' ]*?)\s*:?\s*\+?\s*([\d,]+(?:\.\d+)?)\s*(%?)$/;
/** "+24 DEX, INT" — some locales and some models put the number first. */
const SHAPE_LEADING_VALUE =
  /^\+?\s*([\d,]+(?:\.\d+)?)\s*(%?)\s+([A-Za-z][A-Za-z.,/&' ]*)$/;

/**
 * One row given as a printed string.
 *
 * The `object` and `none` rungs of the route's format ladder deliver whatever
 * the model felt like typing, so this path has to exist even though the schema
 * asks for structured rows.
 */
export function parseBonusStatLine(raw: unknown): BonusStatLine | undefined {
  if (typeof raw !== "string") return undefined;
  const t = tidy(raw).replace(/^[•*\-\s]+/, "");
  // No real row is this long; every narration is.
  if (!t || t.length > 60) return undefined;
  if (NARRATION.test(t)) return undefined;

  let statCell: string;
  let valueCell: string;
  let pctCell: string;
  const a = SHAPE_TRAILING_VALUE.exec(t);
  if (a) {
    statCell = a[1];
    valueCell = a[2];
    pctCell = a[3];
  } else {
    const b = SHAPE_LEADING_VALUE.exec(t);
    if (!b) return undefined;
    valueCell = b[1];
    pctCell = b[2];
    statCell = b[3];
  }
  return buildLine(splitStats(statCell), valueCell, pctCell === "%", undefined);
}

/* ---- object form: { stats: ["DEX","INT"], value: 24 } ---- */

interface RawBonusStatLine {
  stats?: unknown;
  /** Singular alias, for a model that read a one-stat row. */
  stat?: unknown;
  value?: unknown;
  percent?: unknown;
  tier?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Assemble and validate one row from already-separated cells. */
function buildLine(
  rawStats: unknown[],
  rawValue: unknown,
  pct: boolean,
  rawTier: unknown,
): BonusStatLine | undefined {
  const stats: string[] = [];
  let recognised = true;
  for (const s of rawStats) {
    const c = canonicalStat(s);
    if (!c) return undefined; // one unreadable name makes the whole row unreadable
    if (!c.known) recognised = false;
    // A row never names the same stat twice; a duplicate is a transcription
    // slip, not a second grant, so it is folded rather than doubled.
    if (!stats.includes(c.name)) stats.push(c.name);
  }
  if (!stats.length || stats.length > MAX_STATS_PER_LINE) return undefined;
  const value = readValue(rawValue, pct);
  if (value === undefined) return undefined;
  const tier = readTier(rawTier);
  const line: BonusStatLine = { stats, value, pct, recognised };
  if (tier !== undefined) line.tier = tier;
  return line;
}

/** One row in whichever shape it arrived: a structured object, or a string. */
export function readBonusStatLine(raw: unknown): BonusStatLine | undefined {
  if (typeof raw === "string") return parseBonusStatLine(raw);
  if (!isRecord(raw)) return undefined;
  const r = raw as RawBonusStatLine;
  const statsField = r.stats ?? r.stat;
  let rawStats: unknown[];
  if (Array.isArray(statsField)) rawStats = statsField;
  else if (typeof statsField === "string") rawStats = splitStats(statsField);
  else return undefined;
  // `percent` may arrive as a boolean, or not at all, or the % may be hiding in
  // the value string ("+5%"). All three mean the same thing.
  const pct =
    r.percent === true ||
    (typeof r.value === "string" && r.value.trim().endsWith("%"));
  return buildLine(rawStats, r.value, pct, r.tier);
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

/**
 * The Bonus Stat panel, or undefined when the screenshot did not show one.
 *
 * WHY AN EMPTY ROW LIST NEEDS CORROBORATION. An item really can carry zero
 * bonus stats, and "zero" is useful — it is what makes lib/rules.ts say "No
 * flame. Roll one." But a model told to return null for an absent panel will
 * sometimes return an empty object instead, and treating that as "panel seen,
 * nothing on it" fabricates the same confident claim this file exists to stop.
 * So an empty list only counts as a reading when something else on the panel —
 * its item name or its headline figure — was also read. Rows alone are enough;
 * nothing else is.
 */
export function readBonusStatPanel(raw: unknown): BonusStatPanelReading | undefined {
  let rawLines: unknown[] = [];
  let headline: number | undefined;
  let itemName: string | undefined;

  if (Array.isArray(raw)) {
    rawLines = raw;
  } else if (isRecord(raw)) {
    const lines = raw.lines ?? raw.bonusStats ?? raw.rows;
    if (Array.isArray(lines)) rawLines = lines;
    const h = readValue(raw.headline ?? raw.total, false);
    if (h !== undefined) headline = h;
    const n = typeof raw.itemName === "string" ? tidy(raw.itemName) : "";
    if (n && !NARRATION.test(n)) itemName = n;
  } else {
    return undefined;
  }

  const lines: BonusStatLine[] = [];
  let dropped = 0;
  for (const r of rawLines) {
    if (lines.length >= BONUS_STAT_MAX_LINES) {
      dropped++;
      continue;
    }
    const line = readBonusStatLine(r);
    if (line) lines.push(line);
    else dropped++;
  }

  if (!lines.length && headline === undefined && itemName === undefined) return undefined;

  const out: BonusStatPanelReading = { lines, dropped };
  if (headline !== undefined) out.headline = headline;
  if (itemName !== undefined) out.itemName = itemName;
  return out;
}

/* ------------------------------------------------------------------ *
 * The wire
 * ------------------------------------------------------------------ */

/**
 * One row, printed the way the game prints it: "DEX, INT +24".
 *
 * WHY A STRING AT ALL, when the richer shape is right there. lib/rules.ts
 * `Item.f` is `string[]` and lib/farming.ts reads the same array; both are owned
 * by other builders. Emitting the structured line would be a wire break in
 * files this change may not edit, so the structured form travels ALONGSIDE (see
 * the route's additive `bonusStats` key) and `f` keeps carrying strings.
 *
 * The comma form is chosen so the existing readers stay correct without being
 * changed: `statFlat("DEX, INT +24", "dex")` finds \bdex\b and reads 24, and the
 * same line read on an INT character finds \bint\b and reads 24 — which is
 * exactly what the row grants. The one reader that is NOT already correct is
 * `isDeadLine`, and that is called out in this wave's orchestratorMustApply
 * rather than patched here.
 */
export function formatBonusStatLine(line: BonusStatLine): string {
  return `${line.stats.join(", ")} +${line.value}${line.pct ? "%" : ""}`;
}

/** The `Item.f` payload for a panel reading: one string per printed row, in
 *  order, nothing merged. */
export function bonusStatWire(lines: readonly BonusStatLine[]): string[] {
  return lines.map(formatBonusStatLine);
}

/**
 * Per-stat totals across every row.
 *
 * DIAGNOSTIC ONLY. This is the number the item tooltip shows and it is NOT a
 * line list: `{ DEX: 59 }` is what two rows of 24 and 35 look like after the
 * information that prices a reset has been destroyed. Never feed the result of
 * this back into `Item.f`. It exists so a UI can show "DEX +59 total" beside the
 * rows, and so the self test can prove the rows were not summed.
 */
export function bonusStatTotals(lines: readonly BonusStatLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    if (l.pct) continue; // a % and a flat value are not addable
    for (const s of l.stats) out[s] = (out[s] ?? 0) + l.value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The item tooltip's aggregate block — what is left when there is no panel
 * ------------------------------------------------------------------ */

/**
 * What the tooltip's stat block can and cannot say.
 *
 * THE DECISION, stated plainly because the brief asks for it: from the
 * aggregate block this file emits NO LINE LIST AT ALL. `lines` is typed `null`
 * and there is no code path that fills it.
 *
 * WHY NOT "derive the lines and mark them unsure". Because the derivation is
 * impossible, not merely unreliable. The block prints one combined number per
 * stat with base, star force and bonus stats already added; only colour
 * separates them on screen, and colour does not survive a text read. Even when
 * the parenthetical is spelled out — "DEX +97 (7 +31 +59)" — the +59 is the
 * per-stat TOTAL of every bonus stat row that named DEX. On the observed item
 * that total came from two rows, 24 and 35, and nothing in the block records
 * that. A "DEX +59" line and a real one-roll +59 price a reset differently.
 *
 * WHAT IS STILL DERIVABLE, and is kept:
 *  - A three-group parenthetical states base, star force and bonus outright, so
 *    the third group is that stat's bonus-stat TOTAL. Recorded in `totals`.
 *  - A two-group parenthetical is base plus ONE of star force or bonus stats,
 *    and there is no way to tell which. Recorded in `ambiguous`, by name.
 *
 * AND NOTE WHAT IS DELIBERATELY *NOT* DONE HERE. The previous reader tried to
 * resolve two-group lines with a uniformity heuristic — star force lands on
 * every main stat equally, so a value shared by three or more main stats is star
 * force. That rule is true and it still produced "STR +31", because on this item
 * only STR and LUK were two-group (DEX and INT had a third group) and two is not
 * three, so the shared +31 was promoted to a flame. An inference that fails
 * exactly when the item is interesting is not worth its false confidence. Two
 * groups is ambiguous, full stop.
 */
export interface TooltipAggregateReading {
  /** Always null. The aggregate block cannot state a line list — see above. */
  lines: null;
  /** Per-stat bonus-stat totals from three-group parentheticals. */
  totals: Record<string, number>;
  /** Stats whose parenthetical had two groups: star force and bonus stats
   *  cannot be told apart, so neither is claimed. */
  ambiguous: string[];
}

/** "DEX +97 (7 +31 +59)" -> { stat: "DEX", groups: [7, 31, 59], pct: false }. */
const SHAPE_TOOLTIP_STAT =
  /^([A-Za-z][A-Za-z.' ]*?)\s*:?\s*\+?\s*[\d,]+(?:\.\d+)?\s*(%?)\s*\(([^)]*)\)\s*$/;

function readTooltipGroups(line: string): { stat: string; groups: number[]; pct: boolean } | undefined {
  const m = SHAPE_TOOLTIP_STAT.exec(tidy(line));
  if (!m) return undefined;
  const c = canonicalStat(m[1]);
  if (!c) return undefined;
  const groups = m[3]
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => parseFloat(p.replace(/[^\d.]/g, "")))
    .filter((n) => Number.isFinite(n));
  if (!groups.length) return undefined;
  return { stat: c.name, groups, pct: m[2] === "%" };
}

/**
 * Read the item tooltip's stat lines for whatever they can honestly say about
 * bonus stats. Returns undefined when no line carried a parenthetical at all,
 * which is how "there was no tooltip here" stays distinguishable from "there was
 * one and it told us nothing".
 *
 * Accepts the lines VERBATIM, parentheses included. The model is asked to copy
 * rather than to compute for exactly this reason: arithmetic done upstream
 * cannot be audited here.
 */
export function readTooltipAggregate(raw: unknown): TooltipAggregateReading | undefined {
  if (!Array.isArray(raw)) return undefined;
  const totals: Record<string, number> = {};
  const ambiguous: string[] = [];
  let sawParenthetical = false;

  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const p = readTooltipGroups(entry);
    if (!p) continue;
    sawParenthetical = true;
    if (p.groups.length >= 3) {
      // base + star force + bonus. The last group is the bonus-stat total.
      const v = p.groups[p.groups.length - 1];
      if (v > 0) totals[p.stat] = v;
    } else if (p.groups.length === 2) {
      const second = p.groups[1];
      // A +0 second group grants nothing, so there is nothing to be unsure
      // about. Anything else could be star force or bonus stats.
      if (second > 0 && !ambiguous.includes(p.stat)) ambiguous.push(p.stat);
    }
    // One group is the base alone: no enhancement of any kind on that stat.
  }

  if (!sawParenthetical) return undefined;
  return { lines: null, totals, ambiguous };
}

/**
 * The sentence a human is shown when only the tooltip was available. Says what
 * is known, says what is not, and names the window that would settle it.
 *
 * Built here rather than in the route so the wording and the reading that has to
 * justify it stay in one file.
 */
export function describeTooltipAggregate(r: TooltipAggregateReading): string {
  const totals = Object.entries(r.totals)
    .map(([s, v]) => `${s} +${v}`)
    .join(", ");
  const parts = [
    "read from the item tooltip's combined stat block, which cannot separate star force from bonus stats",
  ];
  if (totals) parts.push(`per-stat bonus totals ${totals} (how many lines those came from is not stated)`);
  if (r.ambiguous.length) parts.push(`${r.ambiguous.join(", ")} unresolved`);
  parts.push("screenshot Enhance > Bonus Stats to read the actual lines");
  return parts.join("; ");
}

/* ------------------------------------------------------------------ *
 * What the vision model is told
 * ------------------------------------------------------------------ */

/**
 * The Bonus Stat panel block of the vision prompt, held beside the parser that
 * has to survive whatever it produces.
 *
 * Everything asserted about the window — its route through Enhance, its heading,
 * the "Details" toggle, the headline figure, the Material Cost of 3,000,000
 * Mesos and the Mesos / Rebirth Flames tabs, the per-row tier badge — is from
 * the owner's 2026-09-13 reading recorded as OBSERVED_BONUS_STAT_PANEL in
 * ./damageReadings.ts. Naming those labels is the whole point: they are what
 * lets the model tell this window from the item tooltip, which shows the same
 * stats added together and would otherwise look like the same information.
 */
export const BONUS_STAT_PANEL_PROMPT = `SEPARATELY: the screenshot may show the BONUS STAT panel — the window reached in
game by Enhance > Bonus Stats, headed "BONUS STAT". It shows the item's icon and
name, a headline figure beside the name like "+23", a list headed "Bonus Stats"
with a "Details" toggle above it, and at the bottom a "Material Cost" of
3,000,000 Mesos with "Mesos" and "Rebirth Flames" tabs. Each listed line carries
a small tier badge — a single digit, drawn beside the line.

THIS IS NOT THE ITEM TOOLTIP. The tooltip shows one combined number per stat with
a parenthetical, like "DEX +97 (7 +31 +59)", where base, star force and bonus
stats have already been added together. The BONUS STAT panel lists each bonus
stat line separately. Only this panel can answer what the lines are. If both are
on screen, read each one into its own key.

If and only if the BONUS STAT panel is visible, add a "bonusStats" key:

  "bonusStats": {
    "itemName": string,      // the item name in the panel header
    "headline": number,      // the figure beside it, e.g. 23 for "+23". null if unreadable
    "lines": [               // ONE ENTRY PER PRINTED LINE, top to bottom
      { "stats": string[],   // every stat that line names
        "value": number,     // the number printed on that line, once
        "percent": boolean,  // true only if a % is printed on that line
        "tier": number }     // the small badge digit. null if unreadable
    ]
  }

Read the lines exactly as the panel states them:

  - A LINE CAN NAME MORE THAN ONE STAT. "DEX, INT +24" is ONE entry with
    "stats": ["DEX","INT"] and "value": 24. It is not two entries, and the 24 is
    not split between them — the line grants +24 to each.
  - TWO LINES CAN NAME THE SAME STAT. "DEX +24" and "DEX +35" are two separate
    entries. NEVER add them together into one "DEX +59" entry.
  - EVERY STAT THE PANEL LISTS COUNTS, not just STR/DEX/INT/LUK: Attack Power,
    Magic ATT, Max HP, Max MP, Defense, Speed, Jump, All Stats. Do not skip a
    line because it looks unimportant.
  - Keep the panel's own order, top to bottom.

OMIT a line you cannot read rather than guessing at it, and use null for the
whole "bonusStats" key when this panel is not on screen. Do NOT build this key
out of the item tooltip: a missing line is recoverable, an invented one is not.`;

/**
 * The tooltip stat-block block of the prompt.
 *
 * The model is asked to COPY, not to compute. The previous version asked it for
 * "the flame" and told it the third number in the parentheses was the answer,
 * which is how the model's arithmetic became the app's facts with no way to
 * audit it. Verbatim lines let readTooltipAggregate() decide what those numbers
 * can support — which, for a two-group parenthetical, is nothing.
 */
export const TOOLTIP_STAT_BLOCK_PROMPT = `  "statBlock": string[],       // If an ITEM TOOLTIP is visible: copy its stat lines VERBATIM,
                               // one per entry, parentheses included and unchanged —
                               // "DEX +97 (7 +31 +59)", "Attack Power +7 (1 +6)",
                               // "Max HP +2340 (0 +2340)". Copy every stat line, not just
                               // the ones that look interesting, and do NOT do the
                               // arithmetic, drop the parentheses or reorder the numbers.
                               // Omit a line the cursor covers. [] if there is no tooltip.`;

/* ------------------------------------------------------------------ *
 * Self test
 * ------------------------------------------------------------------ */

/** The four lines the owner read off the Black Bean Mark's panel, in the two
 *  shapes the format ladder can deliver them. Exported so a harness can print
 *  them verbatim rather than retyping them. */
export const __observedPanelStructured = {
  itemName: "Black Bean Mark",
  headline: 23,
  lines: [
    { stats: ["DEX", "INT"], value: 24, percent: false, tier: 6 },
    { stats: ["Attack Power"], value: 6, percent: false, tier: 6 },
    { stats: ["DEX"], value: 35, percent: false, tier: 5 },
    { stats: ["Max HP"], value: 2340, percent: false, tier: 6 },
  ],
};

/** The same four rows as printed strings, which is what the weaker format rungs
 *  produce. */
export const __observedPanelStrings = [
  "DEX, INT +24",
  "Attack Power +6",
  "DEX +35",
  "Max HP +2340",
];

/** The item tooltip for the same item, verbatim. This is the input that used to
 *  yield STR +31 / DEX +59 / INT +24. */
export const __observedTooltipBlock = [
  "STR +38 (7 +31)",
  "DEX +97 (7 +31 +59)",
  "INT +62 (7 +31 +24)",
  "LUK +38 (7 +31)",
  "Max HP +2340 (0 +2340)",
  "Attack Power +7 (1 +6)",
  "Defense +225 (120 +105)",
];

export function __selfTest(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const eq = (what: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };

  /* ---- the observed panel, structured ---- */
  const panel = readBonusStatPanel(__observedPanelStructured);
  if (!panel) {
    failures.push("observed panel: returned undefined");
  } else {
    eq("observed panel: wire", bonusStatWire(panel.lines), [
      "DEX, INT +24", "Attack Power +6", "DEX +35", "Max HP +2340",
    ]);
    eq("observed panel: dropped", panel.dropped, 0);
    eq("observed panel: combined line stays combined", panel.lines[0].stats, ["DEX", "INT"]);
    eq("observed panel: combined value is not split", panel.lines[0].value, 24);
    // The two DEX rows must remain two rows with their own values.
    const dexRows = panel.lines.filter((l) => l.stats.includes("DEX"));
    eq("observed panel: DEX appears on two separate rows", dexRows.map((l) => l.value), [24, 35]);
    if (bonusStatWire(panel.lines).some((s) => /\+59\b/.test(s)))
      failures.push("observed panel: the two DEX rows were summed into +59");
    // The two lines the old reader dropped entirely.
    if (!panel.lines.some((l) => l.stats[0] === "Attack Power" && l.value === 6))
      failures.push("observed panel: Attack Power +6 did not survive");
    if (!panel.lines.some((l) => l.stats[0] === "Max HP" && l.value === 2340))
      failures.push("observed panel: Max HP +2340 did not survive");
    // Nothing the panel did not list may appear. STR is the old invention.
    if (panel.lines.some((l) => l.stats.includes("STR")))
      failures.push("observed panel: invented an STR line");
    eq("observed panel: tiers", panel.lines.map((l) => l.tier), [6, 6, 5, 6]);
    eq("observed panel: headline recorded", panel.headline, 23);
    // Totals are a separate, diagnostic fact — and they are what the tooltip
    // shows, which is the point.
    eq("observed panel: totals", bonusStatTotals(panel.lines), {
      DEX: 59, INT: 24, "Attack Power": 6, "Max HP": 2340,
    });
  }

  /* ---- the same panel as strings ---- */
  const asStrings = readBonusStatPanel(__observedPanelStrings);
  if (!asStrings) failures.push("string panel: returned undefined");
  else {
    eq("string panel: wire", bonusStatWire(asStrings.lines), __observedPanelStrings);
    eq("string panel: combined line", asStrings.lines[0].stats, ["DEX", "INT"]);
    eq("string panel: dropped", asStrings.dropped, 0);
  }

  /* ---- the tooltip aggregate: no line list, ever ---- */
  const agg = readTooltipAggregate(__observedTooltipBlock);
  if (!agg) {
    failures.push("tooltip aggregate: returned undefined");
  } else {
    eq("tooltip aggregate: no lines", agg.lines, null);
    eq("tooltip aggregate: totals", agg.totals, { DEX: 59, INT: 24 });
    eq("tooltip aggregate: ambiguous", agg.ambiguous, [
      "STR", "LUK", "Max HP", "Attack Power", "Defense",
    ]);
    // The whole point: the shared star-force value must not surface as a stat.
    if (Object.prototype.hasOwnProperty.call(agg.totals, "STR"))
      failures.push("tooltip aggregate: STR got a bonus-stat total (+31 is star force)");
    if (Object.values(agg.totals).includes(31))
      failures.push("tooltip aggregate: 31 was recorded as a bonus stat somewhere");
  }
  // A tooltip with no parentheticals says nothing about bonus stats.
  if (readTooltipAggregate(["Max MP +360", "Enemy DEF Ignored +10%"]) !== undefined)
    failures.push("tooltip aggregate: a block with no parentheticals was treated as a reading");
  if (readTooltipAggregate(null) !== undefined) failures.push("tooltip aggregate: null was a reading");
  if (readTooltipAggregate([]) !== undefined) failures.push("tooltip aggregate: [] was a reading");

  /* ---- line parsing edge cases ---- */
  eq("percent row", parseBonusStatLine("All Stats +5%"), {
    stats: ["All Stats"], value: 5, pct: true, recognised: true,
  });
  eq("thousands separator", parseBonusStatLine("Max HP +2,340")?.value, 2340);
  eq("colon form", parseBonusStatLine("Attack Power : +6")?.stats, ["Attack Power"]);
  eq("leading value", parseBonusStatLine("+24 DEX, INT")?.stats, ["DEX", "INT"]);
  eq("slash separator", parseBonusStatLine("DEX/INT +24")?.stats, ["DEX", "INT"]);
  eq("alias normalising", parseBonusStatLine("ATT +6")?.stats, ["Attack Power"]);
  eq("duplicate stat folded", parseBonusStatLine("DEX, DEX +24")?.stats, ["DEX"]);
  // An unlisted stat name is kept, flagged, not dropped.
  const unlisted = parseBonusStatLine("Boss Damage +2%");
  eq("unlisted stat kept", unlisted?.stats, ["Boss Damage"]);
  eq("unlisted stat flagged", unlisted?.recognised, false);

  const rejects: Array<[string, unknown]> = [
    ["narration", "I cannot read the bonus stats"],
    ["prose with a number", "The panel shows DEX +24 and more"],
    ["empty string", ""],
    ["no value", "DEX"],
    ["zero value", "DEX +0"],
    ["negative value", "DEX -24"],
    ["seven-figure neighbour", "DEX +5399368"],
    ["percent above 100", "All Stats +900%"],
    ["a number alone", "24"],
    ["null", null],
    ["a boolean", true],
    ["a bare array", [1, 2]],
  ];
  for (const [what, input] of rejects) {
    const got = readBonusStatLine(input);
    if (got !== undefined) failures.push(`reject ${what}: got ${JSON.stringify(got)}`);
  }

  /* ---- panel absence, and the empty-list corroboration rule ---- */
  if (readBonusStatPanel(null) !== undefined) failures.push("null panel was a reading");
  if (readBonusStatPanel({ lines: [] }) !== undefined)
    failures.push("an uncorroborated empty line list was treated as a panel reading");
  const emptyButSeen = readBonusStatPanel({ itemName: "Black Bean Mark", lines: [] });
  if (!emptyButSeen) failures.push("a named panel with no rows was not a reading");
  else eq("named panel with no rows", emptyButSeen.lines.length, 0);
  const partial = readBonusStatPanel({
    lines: [{ stats: ["DEX"], value: 35 }, "I could not read the second line"],
  });
  if (!partial) failures.push("partial panel: returned undefined");
  else {
    eq("partial panel: kept the readable row", bonusStatWire(partial.lines), ["DEX +35"]);
    eq("partial panel: counted the dropped row", partial.dropped, 1);
  }

  /* ---- the wire stays readable by lib/rules.ts ---- */
  // Not an import of rules.ts (that would drag the whole engine into this
  // file's test); the regexes below are copied from it verbatim and the copy is
  // what is being checked — if rules.ts changes, this assertion goes stale
  // loudly rather than silently.
  const wire = "DEX, INT +24";
  if (!/\bdex\b/.test(wire.toLowerCase())) failures.push("wire: rules.statFlat would not see DEX");
  if (!/\bint\b/.test(wire.toLowerCase())) failures.push("wire: rules.statFlat would not see INT");
  if (!/\b(att|attack power|magic att)\b/i.test("Attack Power +6"))
    failures.push("wire: rules.attFlat would not see Attack Power");

  /* ---- the prompt says the things the parser depends on ---- */
  const mustSay = [
    "BONUS STAT", "Enhance", "Details", "3,000,000", "Rebirth Flames",
    "bonusStats", "NEVER add them together", "ONE ENTRY PER PRINTED LINE", "OMIT",
  ];
  for (const s of mustSay) {
    if (!BONUS_STAT_PANEL_PROMPT.includes(s)) failures.push(`prompt: does not say "${s}"`);
  }
  if (!TOOLTIP_STAT_BLOCK_PROMPT.includes("VERBATIM"))
    failures.push("statBlock prompt: does not ask for verbatim lines");

  return { ok: failures.length === 0, failures };
}
