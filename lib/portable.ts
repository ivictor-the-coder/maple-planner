// Portable profiles: schema, validation, migration, JSON export/import and a
// compact share link.
//
// WHY THIS FILE EXISTS
// Everything the planner knows about a player — 25 equip slots, their
// potentials and flames, and a 31-character Legion roster merged out of three
// screenshots — lives in one browser's localStorage as an untagged JSON blob.
// It cannot be backed up, moved to a phone, posted in a Discord thread for
// advice, or read by a future version of this app that needs to know what
// shape it is looking at. Raidbots answers all of that with one pasted string
// and a report URL; this is the same idea in MapleStory's vocabulary.
//
// WHY ONE FILE
// The eleven-agent build split gave this work a single file to own. Schema,
// validator, migration, codec and their tests would normally be five modules
// under lib/profile/; they are five clearly marked sections here instead, and
// splitting them later is a pure move — nothing below reaches sideways into
// anything but lib/rules.ts, lib/legion.ts and lib/itemLookup.ts.
//
// THE ONE THING THAT IS NOT LOSSLESS, STATED UP FRONT
// Item.icon is a 72x72 PNG data URL that ImportDialog's cropIcon() mints from
// a screenshot — 2-8 KB each, up to 25 of them, ~200 KB of derived pixels that
// re-resolve from itemId. The canonical profile is defined as ICON-FREE.
// Export drops icons and says so in the file header (`icons: "omitted"`); the
// share link never carries them; round-trip claims below are claims about the
// canonical, icon-free form and nothing else. Profiles held in memory or in
// localStorage may still carry icons and are tagged `icons: "inline"`.

import {
  SLOTS,
  sfCap,
  type Character,
  type Item,
  type MainStat,
  type Stats,
  type Tier,
} from "./rules";
import type { RosterChar } from "./legion";
import { resolveItem, type Resolved } from "./itemLookup";

/* ==========================================================================
   SECTION 1 — SCHEMA
   ========================================================================== */

/** Bumped whenever `Profile` changes shape. A reader must refuse what it does
 *  not understand, and MIGRATIONS must gain an entry for every bump. */
export const SCHEMA_VERSION = 1 as const;

/** Written into every file so a stray JSON blob can be identified on sight. */
export const APP_ID = "maple-planner" as const;

export const STORAGE_KEY = "maple-planner:character";
/** Where load() parks a blob it could not parse, so a bad read never costs the
 *  user the work that produced it. */
export const CORRUPT_KEY = "maple-planner:character.corrupt";

/** Does this profile still carry the screenshot-cropped sprites?
 *  - "omitted": icons were deliberately dropped (every export, every share link)
 *  - "inline": Item.icon may be present (in-memory and localStorage profiles)
 *  The field is descriptive, never a request: nothing re-attaches icons. */
export type IconPolicy = "omitted" | "inline";

export interface Profile {
  v: typeof SCHEMA_VERSION;
  app: typeof APP_ID;
  /** ISO 8601, UTC. Informational — never used to order or resolve anything. */
  exported: string;
  icons: IconPolicy;
  /** Exactly the shape in lib/rules.ts. Imported, not re-declared: a field
   *  added to Item or Stats becomes a type error in the codec below until the
   *  codec handles it, which is the entire point of not forking the shape. */
  char: Character;
}

/* -------------------------------------------------------------------------
   Transport limits.

   These are limits of this FILE FORMAT, not facts about MapleStory. They exist
   so a hostile or corrupt file cannot allocate unbounded memory, and so every
   field has a known worst-case width on the wire. Where a real game rule was
   available it is cited; where it was not, the constant is exported and marked
   unverified so it can be corrected in one place.
   ------------------------------------------------------------------------- */

/** MapleStory IGNs are far shorter than this. Deliberately loose: a transport
 *  cap is not the place to reject a name the game itself accepted.
 *  UNVERIFIED as a game rule — this is a memory bound only. */
export const MAX_NAME_CHARS = 64;
/** Class names ("Bow Master", "Blaze Wizard"). Same reasoning as above.
 *  UNVERIFIED as a game rule — memory bound only. */
export const MAX_CLS_CHARS = 48;
/** One potential / bonus-stat line, e.g. "Ignore Enemy DEF +40%".
 *  UNVERIFIED as a game rule — memory bound only. */
export const MAX_LINE_CHARS = 64;
/** Lines per potential block and per flame block. The game shows three
 *  potential lines plus three bonus-potential lines, and lib/import/tooltip.ts
 *  records at most three of each; four is headroom for bonus potential being
 *  folded into the same array later.
 *  UNVERIFIED as a game rule — transport allowance only. */
export const MAX_LINES = 4;
/** Character level ceiling used for validation. Sourced from this repo rather
 *  than from patch notes: lib/import/tooltip.ts discards a parsed level above
 *  300, and lib/legion.ts tops its rank ladder out at 250.
 *  UNVERIFIED against GMS v.271 patch notes. */
export const LEVEL_CAP = 300;
/** Star force domain. Sourced: sfCap() in lib/rules.ts:212-222 returns at most
 *  30. Note this is the DOMAIN, not the per-item cap — an item whose level
 *  caps it at 15 but which reads 22 stars is a real, useful input: advise() at
 *  lib/rules.ts:298 detects exactly that and tells the user which of the two
 *  numbers was misread. Clamping it here would delete that advice. */
export const STAR_MAX = 30;
/** Decimals are carried as integers scaled by this. 100, not 10: the live
 *  profile holds `ied: 92.67` and `critdmg: 41.5` (lib/rules.ts:410), and a
 *  x10 scale silently rounds 92.67 to 92.7 — on the single most
 *  damage-relevant number in the file. */
export const DECIMAL_SCALE = 100;
/** Largest scaled integer the varint writer will accept. 2^40 / 100 leaves
 *  room for every stat the game can produce (max HP in the tens of millions,
 *  combat power in the billions) while keeping every value inside the exact
 *  integer range of a double. Engineering bound, not a game number. */
export const MAX_SCALED = Math.floor(Math.pow(2, 40) / DECIMAL_SCALE);

/* ==========================================================================
   SECTION 2 — CANONICAL FORM
   ==========================================================================
   The canonical form is what round-trip claims are about. Two rules:
     1. no `icon` (see the header note);
     2. an optional flag that is absent, undefined or false is ABSENT.
   Rule 2 exists because `{}` and `{bossDrop: false}` are the same profile to
   every consumer in this repo but not to deepEqual, and the codec would
   otherwise have to spend a bit distinguishing states nothing can observe. */

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function canonicalItem(it: Item): Item {
  const out: Item = {
    name: it.name,
    lvl: it.lvl,
    star: it.star,
    pot: it.pot,
    sup: it.sup,
    p: [...it.p],
    f: [...it.f],
  };
  if (typeof it.itemId === "number") out.itemId = it.itemId;
  if (it.sub) out.sub = it.sub;
  if (it.bossDrop) out.bossDrop = true;
  if (it.noSf) out.noSf = true;
  if (it.noFl) out.noFl = true;
  if (it.noPot) out.noPot = true;
  // it.icon is dropped here and nowhere else. This is the drop.
  return out;
}

export function canonicalRoster(r: RosterChar): RosterChar {
  const out: RosterChar = { name: r.name, cls: r.cls, lvl: r.lvl };
  if (r.current) out.current = true;
  return out;
}

/** Icon-free, flag-normalised copy. Pure; the input is never mutated. */
export function canonicalCharacter(ch: Character): Character {
  const items: Record<string, Item> = {};
  // SLOTS order, not insertion order, so two profiles with the same gear
  // serialise identically regardless of the order the slots were filled in.
  for (const s of SLOTS) {
    const it = ch.items[s.id];
    if (it) items[s.id] = canonicalItem(it);
  }
  const out: Character = {
    name: ch.name,
    cls: ch.cls,
    main: ch.main,
    lvl: ch.lvl,
    cp: ch.cp,
    stats: {
      main: num(ch.stats.main),
      att: num(ch.stats.att),
      crit: num(ch.stats.crit),
      critdmg: num(ch.stats.critdmg),
      boss: num(ch.stats.boss),
      ied: num(ch.stats.ied),
      hp: num(ch.stats.hp),
      arcane: num(ch.stats.arcane),
      starforce: num(ch.stats.starforce),
    },
    items,
  };
  // undefined roster and [] roster are different states: "never imported a
  // roster" versus "imported and it was empty". Both survive.
  if (ch.roster) out.roster = ch.roster.map(canonicalRoster);
  return out;
}

export function makeProfile(ch: Character, icons: IconPolicy = "inline", at: Date = new Date()): Profile {
  return {
    v: SCHEMA_VERSION,
    app: APP_ID,
    exported: at.toISOString(),
    icons,
    char: icons === "omitted" ? canonicalCharacter(ch) : ch,
  };
}

/* ==========================================================================
   SECTION 3 — VALIDATION
   ========================================================================== */

export interface FieldError {
  /** JSON-pointer-ish and slot-aware: `char.items.weapon.star`. */
  path: string;
  /** What was actually there, rendered short. */
  got: string;
  /** The domain, in words a player can act on. */
  want: string;
  /** What the importer DID about it, so "import anyway" is an informed click. */
  fix: string;
}

export type ParseResult =
  | { ok: true; profile: Profile; warnings: FieldError[] }
  | { ok: false; errors: FieldError[]; partial: Profile };

/* `partial` on the failure branch is the reason this returns a result object
   instead of throwing. The expensive thing in a profile is the 31-row roster;
   one bad `star` should never cost it. Every error below is repaired in
   `partial` (clamped, defaulted or dropped) and named in `errors`, so the
   import dialog can render the list and offer "import anyway, skipping N
   fields" without re-parsing anything. */

const MAIN_STATS: readonly MainStat[] = ["dex", "str", "int", "luk"]; // lib/rules.ts:6
const TIERS: readonly Tier[] = ["none", "rare", "epic", "unique", "legendary"]; // lib/rules.ts:7
const SLOT_IDS: readonly string[] = SLOTS.map((s) => s.id); // the 25 ids, lib/rules.ts:82-108
const STAT_KEYS: ReadonlyArray<keyof Stats> = [
  "main", "att", "crit", "critdmg", "boss", "ied", "hp", "arcane", "starforce",
];

/** Data-URL icons go straight into an <img src>. Only real raster images, and
 *  only inline ones: `javascript:`, `http:` and SVG (which can carry script)
 *  are all rejected. Size bound keeps a hostile file from hanging the tab. */
const ICON_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_ICON_CHARS = 64 * 1024;

function show(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 37) + "..." : v);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  if (v === undefined) return "missing";
  if (Array.isArray(v)) return `array(${v.length})`;
  return `object(${Object.keys(v as object).slice(0, 3).join(", ")})`;
}

function levenshtein(a: string, b: string): number {
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

/** Nearest real slot id to a key that is not one. Used only to write a useful
 *  error message — nothing is ever silently remapped onto it. */
export function nearestSlot(key: string): string {
  const k = key.toLowerCase().trim();
  let best = SLOT_IDS[0], bestD = Infinity;
  for (const id of SLOT_IDS) {
    const d = levenshtein(k, id);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

type Sink = (e: FieldError) => void;

function readStr(v: unknown, path: string, max: number, fallback: string, err: Sink): string {
  if (typeof v !== "string") {
    err({ path, got: show(v), want: `string, at most ${max} characters`, fix: `replaced with ${JSON.stringify(fallback)}` });
    return fallback;
  }
  if (v.length > max) {
    err({ path, got: `string(${v.length})`, want: `at most ${max} characters`, fix: `truncated to ${max}` });
    return v.slice(0, max);
  }
  return v;
}

function readInt(v: unknown, path: string, lo: number, hi: number, fallback: number, err: Sink, domain?: string): number {
  const want = domain ?? `integer ${lo}-${hi}`;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    // A spreadsheet round-trip or a hand-written file quotes its numbers. That
    // is a fixable mistake, not a corrupt file — repair it and say so.
    const n = Number(v);
    err({ path, got: show(v), want, fix: `read as the number ${n}` });
    return readInt(n, path, lo, hi, fallback, () => {}, domain);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    err({ path, got: show(v), want, fix: `replaced with ${fallback}` });
    return fallback;
  }
  let n = v;
  if (!Number.isInteger(n)) {
    err({ path, got: String(v), want, fix: `rounded to ${Math.round(n)}` });
    n = Math.round(n);
  }
  if (n < lo || n > hi) {
    const c = Math.min(hi, Math.max(lo, n));
    err({ path, got: String(n), want, fix: `clamped to ${c} on import` });
    return c;
  }
  return n;
}

function readDec(v: unknown, path: string, lo: number, hi: number, err: Sink): number {
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    const n = Number(v);
    err({ path, got: show(v), want: `number ${lo}-${hi}`, fix: `read as the number ${n}` });
    return readDec(n, path, lo, hi, () => {});
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    err({ path, got: show(v), want: `number ${lo}-${hi}`, fix: "replaced with 0" });
    return 0;
  }
  if (v < lo || v > hi) {
    const c = Math.min(hi, Math.max(lo, v));
    err({ path, got: String(v), want: `number ${lo}-${hi}`, fix: `clamped to ${c} on import` });
    return c;
  }
  return v;
}

function readLines(v: unknown, path: string, err: Sink): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    err({ path, got: show(v), want: `array of at most ${MAX_LINES} strings`, fix: "replaced with an empty list" });
    return [];
  }
  const src = v as unknown[];
  let arr = src;
  if (src.length > MAX_LINES) {
    err({ path, got: `array(${src.length})`, want: `at most ${MAX_LINES} lines`, fix: `kept the first ${MAX_LINES}` });
    arr = src.slice(0, MAX_LINES);
  }
  return arr.map((l, i) => {
    // Empty strings are meaningful: lib/import/tooltip.ts pads p and f to three
    // entries with "" so the edit UI has a row per line. They round-trip.
    if (typeof l === "string") {
      if (l.length > MAX_LINE_CHARS) {
        err({ path: `${path}[${i}]`, got: `string(${l.length})`, want: `at most ${MAX_LINE_CHARS} characters`, fix: `truncated to ${MAX_LINE_CHARS}` });
        return l.slice(0, MAX_LINE_CHARS);
      }
      return l;
    }
    err({ path: `${path}[${i}]`, got: show(l), want: "string", fix: "replaced with an empty line" });
    return "";
  });
}

function parseItem(raw: unknown, slotId: string, err: Sink): Item {
  const base = `char.items.${slotId}`;
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    err({ path: base, got: show(raw), want: "object with name, lvl, star, pot, sup, p, f", fix: "read as an empty item" });
  }

  const lvl = readInt(o.lvl, `${base}.lvl`, 0, LEVEL_CAP, 0, err, `integer 0-${LEVEL_CAP} (the item's REQUIRED level, not yours)`);

  const it: Item = {
    name: readStr(o.name ?? "", `${base}.name`, MAX_NAME_CHARS, "", err),
    lvl,
    star: 0,
    pot: "none",
    sup: 0,
    p: readLines(o.p, `${base}.p`, err),
    f: readLines(o.f, `${base}.f`, err),
  };

  // sup first: it changes the star force cap, which the star message quotes.
  if (o.sup === true || o.sup === 1) it.sup = 1;
  else if (o.sup === false || o.sup === 0 || o.sup === undefined || o.sup === null) it.sup = 0;
  else {
    err({ path: `${base}.sup`, got: show(o.sup), want: "0 or 1 (1 = superior / Tyrant gear)", fix: "treated as 0" });
    it.sup = 0;
  }

  const cap = sfCap(it); // per-item cap, for the message only — see STAR_MAX.
  it.star = readInt(
    o.star, `${base}.star`, 0, STAR_MAX, 0, err,
    `integer 0-${STAR_MAX} (cap for this item is ${cap} per sfCap())`
  );

  const pot = o.pot ?? "none";
  if (typeof pot === "string" && (TIERS as readonly string[]).includes(pot)) it.pot = pot as Tier;
  else {
    const guess = typeof pot === "string" ? TIERS.find((t) => t.startsWith(pot.toLowerCase().slice(0, 3))) : undefined;
    err({
      path: `${base}.pot`,
      got: show(pot),
      want: `one of ${TIERS.join(", ")}`,
      fix: guess ? `read as ${guess}` : "treated as none",
    });
    it.pot = guess ?? "none";
  }

  if (o.itemId !== undefined && o.itemId !== null) {
    const id = readInt(o.itemId, `${base}.itemId`, 0, 99_999_999, -1, err, "positive integer (maplestory.net item id)");
    if (id >= 0) it.itemId = id;
  }
  if (o.sub !== undefined && o.sub !== null && o.sub !== "") {
    it.sub = readStr(o.sub, `${base}.sub`, MAX_CLS_CHARS, "", err) || undefined;
  }
  for (const k of ["bossDrop", "noSf", "noFl", "noPot"] as const) {
    const v = o[k];
    if (v === undefined || v === null || v === false) continue;
    if (v === true) { it[k] = true; continue; }
    err({ path: `${base}.${k}`, got: show(v), want: "true or absent", fix: v ? "treated as true" : "treated as absent" });
    it[k] = true;
  }
  if (typeof o.icon === "string" && o.icon) {
    if (o.icon.length > MAX_ICON_CHARS) {
      err({ path: `${base}.icon`, got: `string(${o.icon.length})`, want: `data: URL under ${MAX_ICON_CHARS} characters`, fix: "icon dropped; the sprite re-resolves from itemId" });
    } else if (!ICON_RE.test(o.icon)) {
      err({ path: `${base}.icon`, got: show(o.icon), want: "data:image/png;base64,... (inline raster only)", fix: "icon dropped; the sprite re-resolves from itemId" });
    } else {
      it.icon = o.icon;
    }
  } else if (o.icon !== undefined && o.icon !== null && o.icon !== "") {
    err({ path: `${base}.icon`, got: show(o.icon), want: "data: URL string, or absent", fix: "icon dropped" });
  }
  return it;
}

function parseRoster(raw: unknown, err: Sink): RosterChar[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    err({ path: "char.roster", got: show(raw), want: "array of { name, cls, lvl }", fix: "roster dropped" });
    return undefined;
  }
  const out: RosterChar[] = [];
  (raw as unknown[]).forEach((r, i) => {
    const base = `char.roster[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      err({ path: base, got: show(r), want: "object with name, cls, lvl", fix: "row skipped" });
      return;
    }
    const o = r as Record<string, unknown>;
    const name = readStr(o.name ?? "", `${base}.name`, MAX_NAME_CHARS, "", err);
    if (!name) {
      // A nameless row cannot be merged by mergeRoster() (it keys on name), so
      // keeping it would quietly corrupt the next screenshot import.
      err({ path: `${base}.name`, got: show(o.name), want: "non-empty character name", fix: "row skipped — mergeRoster() keys on name" });
      return;
    }
    const row: RosterChar = {
      name,
      cls: readStr(o.cls ?? "", `${base}.cls`, MAX_CLS_CHARS, "", err),
      lvl: readInt(o.lvl, `${base}.lvl`, 1, LEVEL_CAP, 1, err),
    };
    if (o.current === true) row.current = true;
    else if (o.current !== undefined && o.current !== null && o.current !== false) {
      err({ path: `${base}.current`, got: show(o.current), want: "true or absent", fix: "treated as true" });
      row.current = true;
    }
    out.push(row);
  });
  return out;
}

function parseCharacter(raw: unknown, err: Sink): Character {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    err({ path: "char", got: show(raw), want: "object with name, cls, main, lvl, cp, stats, items", fix: "read as an empty character" });
  }

  const mainRaw = o.main;
  let main: MainStat = "dex";
  if (typeof mainRaw === "string" && (MAIN_STATS as readonly string[]).includes(mainRaw)) {
    main = mainRaw as MainStat;
  } else {
    err({
      path: "char.main",
      got: show(mainRaw),
      want: `one of ${MAIN_STATS.join(", ")} — the stat your class scales with`,
      fix: "treated as dex",
    });
  }

  const statsRaw = (o.stats && typeof o.stats === "object" && !Array.isArray(o.stats) ? o.stats : {}) as Record<string, unknown>;
  if (!o.stats || typeof o.stats !== "object" || Array.isArray(o.stats)) {
    err({ path: "char.stats", got: show(o.stats), want: `object with ${STAT_KEYS.join(", ")}`, fix: "every stat read as 0" });
  }
  const stats = {} as Stats;
  for (const k of STAT_KEYS) {
    // Upper bound is the codec's, not the game's: anything larger cannot be
    // encoded into a share link, and a number that large is a parse artefact.
    stats[k] = readDec(statsRaw[k] ?? 0, `char.stats.${k}`, 0, MAX_SCALED / DECIMAL_SCALE, err);
  }

  const itemsRaw = (o.items && typeof o.items === "object" && !Array.isArray(o.items) ? o.items : {}) as Record<string, unknown>;
  if (o.items !== undefined && (typeof o.items !== "object" || o.items === null || Array.isArray(o.items))) {
    err({ path: "char.items", got: show(o.items), want: "object keyed by slot id", fix: "read as no equipment" });
  }
  const items: Record<string, Item> = {};
  for (const key of Object.keys(itemsRaw)) {
    if (!SLOT_IDS.includes(key)) {
      err({
        path: `char.items.${key}`,
        got: JSON.stringify(key),
        want: `one of the 25 slot ids in SLOTS — did you mean "${nearestSlot(key)}"?`,
        fix: `slot dropped on import; re-enter it under "${nearestSlot(key)}" if that is the one`,
      });
      continue;
    }
    const v = itemsRaw[key];
    if (v === null || v === undefined) continue; // an explicitly empty slot is not an error
    items[key] = parseItem(v, key, err);
  }

  const ch: Character = {
    // An empty name is allowed and round-trips: the user cleared the input,
    // and substituting "Unnamed" for them would make a share link disagree
    // with the page it was made from.
    name: readStr(o.name ?? "Unnamed", "char.name", MAX_NAME_CHARS, "Unnamed", err),
    cls: readStr(o.cls ?? "", "char.cls", MAX_CLS_CHARS, "", err),
    main,
    lvl: readInt(o.lvl, "char.lvl", 1, LEVEL_CAP, 1, err, `integer 1-${LEVEL_CAP}`),
    cp: readInt(o.cp ?? 0, "char.cp", 0, MAX_SCALED, 0, err, "integer combat power, 0 or more"),
    stats,
    items,
  };
  const roster = parseRoster(o.roster, err);
  if (roster) ch.roster = roster;
  return ch;
}

/** Validate an already-migrated (v1) profile.
 *
 *  Never throws, and returns EVERY error rather than the first — the import
 *  dialog renders the whole list. On failure the repaired `partial` is still
 *  a usable Profile, which is what makes "import anyway, skipping N fields"
 *  possible without a second pass. */
export function parseProfile(input: unknown): ParseResult {
  const errors: FieldError[] = [];
  const warnings: FieldError[] = [];
  const err: Sink = (e) => errors.push(e);

  const o = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push({ path: "", got: show(input), want: "a MaplePlanner profile object", fix: "nothing was imported" });
  }

  if (o.v !== SCHEMA_VERSION) {
    if (typeof o.v === "number" && o.v > SCHEMA_VERSION) {
      // Forward-incompatible. Say so plainly instead of guessing at fields.
      errors.push({
        path: "v",
        got: String(o.v),
        want: `${SCHEMA_VERSION} — this file was written by a newer MaplePlanner`,
        fix: "fields this version does not know about are ignored",
      });
    } else {
      errors.push({
        path: "v",
        got: show(o.v),
        want: `${SCHEMA_VERSION} (run migrate() before parseProfile())`,
        fix: `read as version ${SCHEMA_VERSION}`,
      });
    }
  }
  if (o.app !== APP_ID) {
    warnings.push({ path: "app", got: show(o.app), want: `"${APP_ID}"`, fix: "imported anyway" });
  }

  let exported: string;
  if (typeof o.exported === "string" && !Number.isNaN(Date.parse(o.exported))) {
    exported = o.exported;
  } else {
    warnings.push({ path: "exported", got: show(o.exported), want: "ISO 8601 timestamp", fix: "stamped with the time of import" });
    exported = new Date().toISOString();
  }

  let icons: IconPolicy;
  if (o.icons === "omitted" || o.icons === "inline") icons = o.icons;
  else {
    warnings.push({ path: "icons", got: show(o.icons), want: '"omitted" or "inline"', fix: 'treated as "omitted"' });
    icons = "omitted";
  }

  const char = parseCharacter(o.char, err);
  const profile: Profile = { v: SCHEMA_VERSION, app: APP_ID, exported, icons, char };

  if (errors.length) return { ok: false, errors, partial: profile };
  return { ok: true, profile, warnings };
}

/* ==========================================================================
   SECTION 4 — MIGRATION
   ==========================================================================
   Absence of `v` is version 0, and that is load-bearing rather than tidy:
   every byte in every existing user's localStorage was written by
   lib/storage.ts as a bare `JSON.stringify(character)` with no version field.
   A schema that started at 1 and rejected everything else would orphan all of
   it on the day this shipped. */

export type Migration = (x: unknown) => unknown;

/** Keyed by the version being migrated FROM. Append only. */
export const MIGRATIONS: Record<number, Migration> = {
  0: migrate0to1,
};

export function schemaVersionOf(x: unknown): number {
  if (!x || typeof x !== "object" || Array.isArray(x)) return 0;
  const v = (x as Record<string, unknown>).v;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface MigrationReport {
  value: unknown;
  from: number;
  to: number;
  steps: string[];
  /** True when the blob claims a version this build has no migration for. */
  unknownVersion: boolean;
}

/** v0 (a bare Character, as written by today's lib/storage.ts) -> v1.
 *
 *  This is the SYNCHRONOUS half of what the effect at
 *  components/Planner.tsx:48-84 does today: envelope the blob and normalise
 *  the fields that do not need a network round-trip. The half that does need
 *  one — resolving a name to an itemId, sub and bossDrop — is backfillItems()
 *  below, because a migration that cannot run without `fetch` cannot be
 *  tested, and a migration living in a render effect double-fires. */
export function migrate0to1(x: unknown): unknown {
  const src = (x && typeof x === "object" && !Array.isArray(x) ? x : {}) as Record<string, unknown>;
  // Tolerate someone having wrapped the character already but lost `v`.
  const charSrc = (src.char && typeof src.char === "object" ? src.char : src) as Record<string, unknown>;

  const itemsSrc = (charSrc.items && typeof charSrc.items === "object" && !Array.isArray(charSrc.items)
    ? charSrc.items
    : {}) as Record<string, unknown>;
  const items: Record<string, unknown> = {};
  for (const [slotId, raw] of Object.entries(itemsSrc)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;
    items[slotId] = {
      ...it,
      // Pre-v1 blobs written before the tooltip parser existed can miss these
      // entirely; advise() indexes them with `(it.p || [])` today and would
      // keep working, but the codec and the validator want real arrays.
      p: Array.isArray(it.p) ? it.p : [],
      f: Array.isArray(it.f) ? it.f : [],
      star: typeof it.star === "number" ? it.star : 0,
      sup: it.sup === 1 || it.sup === true ? 1 : 0,
      pot: typeof it.pot === "string" ? it.pot : "none",
      lvl: typeof it.lvl === "number" ? it.lvl : 0,
    };
  }

  const icons = Object.values(items).some(
    (it) => typeof (it as Record<string, unknown>).icon === "string"
  ) ? "inline" : "omitted";

  return {
    v: 1,
    app: APP_ID,
    exported: typeof src.exported === "string" ? src.exported : new Date().toISOString(),
    icons,
    char: { ...charSrc, items },
  };
}

/** Run every migration from the blob's version up to SCHEMA_VERSION. */
export function migrate(raw: unknown): MigrationReport {
  const from = schemaVersionOf(raw);
  let value = raw;
  const steps: string[] = [];
  let v = from;
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) return { value, from, to: v, steps, unknownVersion: true };
    value = step(value);
    steps.push(`v${v} -> v${v + 1}`);
    v++;
  }
  return { value, from, to: v, steps, unknownVersion: v !== SCHEMA_VERSION && from > SCHEMA_VERSION };
}

/** The asynchronous half of migrate0to1, and the replacement for the backfill
 *  effect in Planner.tsx.
 *
 *  Injectable resolver so this is testable without a browser or a network:
 *  pass a stub in tests, nothing in the app. Returns a NEW character (or the
 *  same reference when nothing changed, so a caller can skip the save). */
export async function backfillItems(
  ch: Character,
  resolve: (name: string, slot?: string) => Promise<Resolved | null> = resolveItem
): Promise<Character> {
  const missing = Object.entries(ch.items).filter(([, it]) => it?.name && !it.itemId);
  if (!missing.length) return ch;

  const items = { ...ch.items };
  let changed = false;
  for (const [slotId, it] of missing) {
    const db = await resolve(it.name, slotId);
    if (!db) continue;
    items[slotId] = {
      ...it,
      name: db.name,
      itemId: db.itemId,
      sub: db.sub,
      bossDrop: db.bossDrop,
      lvl: it.lvl || db.level || 0,
      sup: it.sup || (db.superior ? 1 : 0),
    };
    changed = true;
  }
  return changed ? { ...ch, items } : ch;
}

/* ==========================================================================
   SECTION 5 — FILE EXPORT / IMPORT
   ========================================================================== */

/** Two-space pretty print, with a header a human can read in a text editor. */
export function exportProfileJson(ch: Character, at: Date = new Date()): string {
  const p = makeProfile(ch, "omitted", at);
  // Key order is chosen for reading, not for the machine: what this is, when,
  // and what it deliberately does not contain, before the payload.
  const ordered = {
    app: p.app,
    v: p.v,
    exported: p.exported,
    icons: p.icons,
    _note:
      "icons: \"omitted\" — item sprites are cropped out of screenshots and are not user data. " +
      "They re-resolve from itemId on import. Every other field round-trips exactly.",
    char: p.char,
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

export function exportProfile(ch: Character, at: Date = new Date()): Blob {
  return new Blob([exportProfileJson(ch, at)], { type: "application/json" });
}

/** `Archerroni-243-20260911.json`. Safe on every filesystem this runs on. */
export function exportFilename(ch: Character, at: Date = new Date()): string {
  const safe = (ch.name || "character").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 32) || "character";
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${safe}-${ch.lvl}-${y}${m}${d}.json`;
}

/** Text in, validated profile out. Migration runs first, so a file produced by
 *  a pre-versioning build (or a raw localStorage dump) imports cleanly. */
export function importProfileJson(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      errors: [{
        path: "",
        got: e instanceof Error ? e.message : "unparseable",
        want: "a JSON file exported by MaplePlanner",
        fix: "nothing was imported",
      }],
      partial: makeProfile(emptyChar(), "omitted"),
    };
  }
  const m = migrate(raw);
  if (m.unknownVersion && m.from < SCHEMA_VERSION) {
    // An OLD version with no migration step is unreadable: the fields have
    // moved and guessing at them would invent data.
    return {
      ok: false,
      errors: [{
        path: "v",
        got: String(m.from),
        want: `a version this build can migrate (0-${SCHEMA_VERSION})`,
        fix: "nothing was imported — this file predates every migration in this build",
      }],
      partial: makeProfile(emptyChar(), "omitted"),
    };
  }
  // A NEWER version is read anyway: its `char` is a superset of this one's, so
  // parseProfile reports the version plus whatever it did not recognise, and
  // the user still gets their gear through "import anyway".
  return parseProfile(m.value);
}

/** Minimal character used only as the carrier for a failed parse. Kept local
 *  rather than importing emptyCharacter() so this file never depends on the
 *  planner's idea of a default class. */
function emptyChar(): Character {
  return {
    name: "Unnamed", cls: "", main: "dex", lvl: 1, cp: 0,
    stats: { main: 0, att: 0, crit: 0, critdmg: 0, boss: 0, ied: 0, hp: 0, arcane: 0, starforce: 0 },
    items: {},
  };
}

/* ---- storage helpers, for the lib/storage.ts rewrite -------------------- */

export interface StoredRead {
  profile: Profile | null;
  errors: FieldError[];
  /** True when the raw blob could not be read and should be parked under
   *  CORRUPT_KEY rather than overwritten by the next save. */
  corrupt: boolean;
  migratedFrom: number | null;
}

/** Pure: takes the raw localStorage string, returns what to do about it.
 *  Keeping it pure is what lets the storage layer be tested in node. */
export function readStoredProfile(raw: string | null): StoredRead {
  if (!raw) return { profile: null, errors: [], corrupt: false, migratedFrom: null };
  const res = importProfileJson(raw);
  const from = schemaVersionOf(safeJson(raw));
  if (res.ok) return { profile: res.profile, errors: res.warnings, corrupt: false, migratedFrom: from };
  // A profile that merely needs repair is not corrupt — the user keeps their
  // gear and the errors are reported. Corrupt means nothing survived.
  const salvageable = Object.keys(res.partial.char.items).length > 0 || !!res.partial.char.roster?.length;
  return {
    profile: salvageable ? res.partial : null,
    errors: res.errors,
    corrupt: !salvageable,
    migratedFrom: from,
  };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** What save() should write: always versioned, icons kept (they are this
 *  browser's fallback sprites and cost nothing here). */
export function serializeProfile(ch: Character, at: Date = new Date()): string {
  const anyIcon = Object.values(ch.items).some((it) => !!it?.icon);
  return JSON.stringify(makeProfile(ch, anyIcon ? "inline" : "omitted", at));
}

/* ==========================================================================
   SECTION 6 — SHARE LINK CODEC
   ==========================================================================
   Base64 of the JSON was measured and rejected: the live example profile is
   ~1.4 KB of JSON for five slots, and the payload is dominated by repeated
   free text ("DEX +9%", "All Stats +3%") and by 31 roster rows. A full
   25-slot profile is 6-8 KB of JSON, ~9 KB of base64 — five times over any
   sane link budget before it has left the tab.

   So: a bit-packed format with a dictionary-coded line table, varints scaled
   by 100, 3 bits for potential tier, 6 for star force, 1 for superior, and a
   class-name dictionary for the roster. Then deflate-raw and base64url.

   WIRE COMPATIBILITY. WIRE_VERSION, LINE_DICT and CLASS_DICT are append-only
   forever. A link in a Discord message from last month must still decode: an
   index that changes meaning silently turns "DEX +9%" into "Speed +9%", which
   is worse than a link that fails to open. */

export const WIRE_VERSION = 1;
/** Conservative target for the whole URL. Mail clients wrap long lines and
 *  Discord truncates link previews; 1800 characters of payload leaves room
 *  for an origin and a path inside every limit worth caring about.
 *  UNVERIFIED as a hard limit of any specific client — it is a product target
 *  taken from the brief, not a measured constant. */
export const URL_SIZE_BUDGET = 1800;
/** Fragment key. A fragment is never sent to the server, so a shared build
 *  never reaches Vercel's logs. */
export const SHARE_FRAGMENT_KEY = "b";
/** `/b/[code]` needs a path segment to match on; the payload rides the
 *  fragment, so the segment is a constant and carries nothing. */
export const SHARE_PATH_SEGMENT = "v1";

/* ---- line dictionary ----------------------------------------------------
   A line is stored as (template index, number x100). The templates below are a
   CODEBOOK, not game data: a wrong or missing entry costs bytes and nothing
   else, because the encoder verifies that re-rendering the template reproduces
   the original string byte for byte and falls back to a literal escape when it
   does not. Nothing here can corrupt a line.

   Sources for the stat names: bonus-stat lines are STR/DEX/INT/LUK, the paired
   stats, Max HP/MP, Defense, Attack Power, Magic Attack, All Stats, Boss
   Damage, Damage, Speed, Jump and Required Level (maplestorywiki.net/w/
   Bonus_Stats); potential lines add Boss Damage %, Ignore Enemy DEF % and
   Critical Damage % (grandislibrary.com/content/stat-terms). Formatting
   follows what this repo actually produces: lib/import/tooltip.ts rewrites
   "DEX : +9%" to "DEX +9%", and lib/rules.ts:412-421 shows the result. */
export const LINE_DICT: readonly string[] = [
  // percent main-stat lines — by far the most common thing in a profile
  "DEX +{n}%", "STR +{n}%", "INT +{n}%", "LUK +{n}%", "All Stats +{n}%",
  // flat stat lines (flames)
  "DEX +{n}", "STR +{n}", "INT +{n}", "LUK +{n}", "All Stats +{n}",
  "Attack Power +{n}", "Magic Att +{n}", "Magic Attack +{n}",
  "Attack Power +{n}%", "Magic Att +{n}%",
  // paired flame lines
  "STR & DEX +{n}", "STR & INT +{n}", "STR & LUK +{n}",
  "DEX & INT +{n}", "DEX & LUK +{n}", "INT & LUK +{n}",
  // the damage lines the rules engine looks for (lib/rules.ts:280)
  "Boss Damage +{n}%", "Damage +{n}%", "Damage to Boss Monsters +{n}%",
  "Ignore Enemy DEF +{n}%", "Ignore Monster DEF +{n}%", "Ignore DEF +{n}%",
  "Critical Damage +{n}%", "Critical Rate +{n}%", "ATT +{n}%", "ATT +{n}",
  // survivability
  "Max HP +{n}%", "Max HP +{n}", "Max MP +{n}%", "Max MP +{n}",
  "DEF +{n}", "DEF +{n}%", "Defense +{n}", "Defense +{n}%",
  // utility lines that show up on rings and secondaries
  "Mesos Obtained +{n}%", "Meso Obtained +{n}%", "Item Drop Rate +{n}%",
  "Drop Rate +{n}%", "Abnormal Status Resistance +{n}",
  "All Skill Levels +{n}", "Skill Cooldown Reduction -{n} seconds",
  "Chance to ignore {n}% damage when hit",
  // junk the engine calls dead (lib/rules.ts:166) — cheap to store, and a
  // profile full of junk lines is exactly the one that needs the compression
  "Speed +{n}", "Jump +{n}", "Accuracy +{n}", "Avoidability +{n}",
  "Knockback Resistance +{n}%", "Required Level -{n}",
  // the padding lib/import/tooltip.ts writes for an unread line
  "",
] as const;

interface Template { pre: string; suf: string; exact: boolean }
const TEMPLATES: Template[] = LINE_DICT.map((t) => {
  const i = t.indexOf("{n}");
  return i < 0 ? { pre: t, suf: "", exact: true } : { pre: t.slice(0, i), suf: t.slice(i + 3), exact: false };
});

/* ---- class dictionary ---------------------------------------------------
   31 roster rows each carry a class name; most accounts repeat a handful.
   Same rule as LINE_DICT: append-only, and a miss costs bytes only. */
export const CLASS_DICT: readonly string[] = [
  "Hero", "Paladin", "Dark Knight", "Fire/Poison Archmage", "Ice/Lightning Archmage",
  "Bishop", "Bow Master", "Marksman", "Pathfinder", "Night Lord", "Shadower",
  "Dual Blade", "Buccaneer", "Corsair", "Cannoneer", "Jett",
  "Dawn Warrior", "Blaze Wizard", "Wind Archer", "Night Walker", "Thunder Breaker", "Mihile",
  "Aran", "Evan", "Mercedes", "Phantom", "Luminous", "Shade",
  "Blaster", "Battle Mage", "Wild Hunter", "Mechanic", "Xenon", "Demon Slayer", "Demon Avenger",
  "Kaiser", "Angelic Buster", "Cadena", "Kain", "Kanna", "Hayato", "Adele", "Ark", "Illium",
  "Khali", "Hoyoung", "Lara", "Zero", "Kinesis", "Beast Tamer", "Lynn", "Mo Xuan", "Sia Astelle",
] as const;

/* ---- bit IO ------------------------------------------------------------- */

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private n = 0;
  bit(b: number): void {
    this.cur = ((this.cur << 1) | (b & 1)) & 0xff;
    if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
  }
  bits(v: number, w: number): void { for (let i = w - 1; i >= 0; i--) this.bit((v >> i) & 1); }
  byte(v: number): void { this.bits(v & 0xff, 8); }
  /** LEB128, bit-aligned. Division rather than shifts: >>> truncates at 2^32
   *  and combat power alone can exceed that. */
  uvar(v: number): void {
    let x = Math.floor(v);
    if (!Number.isFinite(x) || x < 0) x = 0;
    for (;;) {
      const g = x % 128;
      x = Math.floor(x / 128);
      this.byte(x > 0 ? g | 0x80 : g);
      if (!x) return;
    }
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.uvar(b.length);
    for (const x of b) this.byte(x);
  }
  finish(): Uint8Array {
    if (this.n) { this.cur = (this.cur << (8 - this.n)) & 0xff; this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    return Uint8Array.from(this.bytes);
  }
}

export class DecodeError extends Error {}

class BitReader {
  private i = 0;
  private n = 0;
  constructor(private readonly buf: Uint8Array) {}
  bit(): number {
    if (this.i >= this.buf.length) throw new DecodeError("share link ended mid-value");
    const b = (this.buf[this.i] >> (7 - this.n)) & 1;
    if (++this.n === 8) { this.n = 0; this.i++; }
    return b;
  }
  bits(w: number): number { let v = 0; for (let i = 0; i < w; i++) v = (v << 1) | this.bit(); return v; }
  byte(): number { return this.bits(8); }
  uvar(): number {
    let v = 0, mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      v += (b & 0x7f) * mul;
      if (!(b & 0x80)) return v;
      mul *= 128;
    }
    throw new DecodeError("varint too long — this is not a MaplePlanner link");
  }
  str(max: number): string {
    const len = this.uvar();
    if (len > max) throw new DecodeError(`string longer than ${max} bytes`);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.byte();
    return new TextDecoder().decode(out);
  }
}

/* ---- numbers ------------------------------------------------------------
   Every decimal is (value x 100) as a varint, with a one-bit escape to a
   decimal string for anything that is not an exact hundredth. The escape is
   what makes "lossless" true rather than nearly true: 41.5 and 92.67 encode
   exactly, and a hand-edited 1.005 survives as text instead of silently
   becoming 1.01. */
function writeNum(w: BitWriter, v: number): void {
  const scaled = Math.round(v * DECIMAL_SCALE);
  if (Number.isFinite(v) && v >= 0 && scaled / DECIMAL_SCALE === v && scaled <= MAX_SCALED) {
    w.bit(0);
    w.uvar(scaled);
    return;
  }
  w.bit(1);
  w.str(String(v));
}
function readNum(r: BitReader): number {
  if (r.bit() === 0) return r.uvar() / DECIMAL_SCALE;
  const n = Number(r.str(32));
  if (!Number.isFinite(n)) throw new DecodeError("bad number in share link");
  return n;
}

/** Render a scaled integer back to the text a template expects. */
function renderScaled(scaled: number): string {
  if (scaled % DECIMAL_SCALE === 0) return String(scaled / DECIMAL_SCALE);
  const s = (scaled / DECIMAL_SCALE).toFixed(2);
  return s.endsWith("0") ? s.slice(0, -1) : s;
}

function writeLine(w: BitWriter, line: string): void {
  for (let i = 0; i < TEMPLATES.length; i++) {
    const t = TEMPLATES[i];
    if (t.exact) {
      if (line === t.pre) { w.uvar(i + 1); return; }
      continue;
    }
    if (line.length <= t.pre.length + t.suf.length) continue;
    if (!line.startsWith(t.pre) || !line.endsWith(t.suf)) continue;
    const mid = line.slice(t.pre.length, line.length - t.suf.length);
    if (!/^\d+(\.\d{1,2})?$/.test(mid)) continue;
    const scaled = Math.round(Number(mid) * DECIMAL_SCALE);
    if (scaled > MAX_SCALED) continue;
    // The guard that makes the dictionary safe: only use it when rendering it
    // back reproduces the original text exactly. "09" and "9.0" fall through.
    if (renderScaled(scaled) !== mid) continue;
    w.uvar(i + 1);
    w.uvar(scaled);
    return;
  }
  w.uvar(0); // literal escape
  w.str(line);
}

function readLine(r: BitReader): string {
  const tok = r.uvar();
  if (tok === 0) return r.str(MAX_LINE_CHARS * 4);
  const t = TEMPLATES[tok - 1];
  if (!t) throw new DecodeError(`unknown line token ${tok} — link written by a newer MaplePlanner`);
  if (t.exact) return t.pre;
  return t.pre + renderScaled(r.uvar()) + t.suf;
}

function writeDictStr(w: BitWriter, s: string, dict: readonly string[]): void {
  const i = dict.indexOf(s);
  if (i >= 0) { w.uvar(i + 1); return; }
  w.uvar(0);
  w.str(s);
}
function readDictStr(r: BitReader, dict: readonly string[], max: number): string {
  const tok = r.uvar();
  if (tok === 0) return r.str(max * 4);
  const s = dict[tok - 1];
  if (s === undefined) throw new DecodeError(`unknown dictionary token ${tok}`);
  return s;
}

/* ---- the payload -------------------------------------------------------- */

const SLOT_INDEX = new Map(SLOTS.map((s, i) => [s.id, i]));

function writePayload(ch: Character, withRoster: boolean): Uint8Array {
  const w = new BitWriter();
  w.bits(WIRE_VERSION, 4);
  w.bits(withRoster ? 0 : 1, 4); // flags: bit3 = roster deliberately omitted

  w.str(ch.name);
  writeDictStr(w, ch.cls, CLASS_DICT);
  w.bits(MAIN_STATS.indexOf(ch.main), 2);
  w.uvar(ch.lvl);
  writeNum(w, ch.cp);
  for (const k of STAT_KEYS) writeNum(w, ch.stats[k]);

  const entries = SLOTS.map((s) => [s.id, ch.items[s.id]] as const).filter((e): e is readonly [string, Item] => !!e[1]);
  w.uvar(entries.length);
  for (const [slotId, it] of entries) {
    w.bits(SLOT_INDEX.get(slotId) ?? 0, 5);
    w.str(it.name);
    w.uvar(typeof it.itemId === "number" ? it.itemId + 1 : 0);
    w.uvar(it.lvl);
    w.bits(it.star, 6);
    w.bits(TIERS.indexOf(it.pot), 3);
    w.bit(it.sup);
    w.bit(it.bossDrop ? 1 : 0);
    w.bit(it.noSf ? 1 : 0);
    w.bit(it.noFl ? 1 : 0);
    w.bit(it.noPot ? 1 : 0);
    w.bit(it.sub ? 1 : 0);
    if (it.sub) w.str(it.sub);
    w.bits(it.p.length, 3);
    for (const l of it.p) writeLine(w, l);
    w.bits(it.f.length, 3);
    for (const l of it.f) writeLine(w, l);
  }

  const roster = withRoster ? ch.roster : undefined;
  w.bit(roster ? 1 : 0);
  if (roster) {
    w.uvar(roster.length);
    for (const r of roster) {
      w.str(r.name);
      writeDictStr(w, r.cls, CLASS_DICT);
      w.uvar(r.lvl);
      w.bit(r.current ? 1 : 0);
    }
  }
  return w.finish();
}

function readPayload(bytes: Uint8Array): { char: Character; rosterOmitted: boolean } {
  const r = new BitReader(bytes);
  const wire = r.bits(4);
  if (wire !== WIRE_VERSION) {
    throw new DecodeError(`share link format v${wire}, this build reads v${WIRE_VERSION}`);
  }
  const flags = r.bits(4);
  const rosterOmitted = (flags & 1) === 1;

  const name = r.str(MAX_NAME_CHARS * 4);
  const cls = readDictStr(r, CLASS_DICT, MAX_CLS_CHARS);
  const main = MAIN_STATS[r.bits(2)];
  const lvl = r.uvar();
  const cp = readNum(r);
  const stats = {} as Stats;
  for (const k of STAT_KEYS) stats[k] = readNum(r);

  const items: Record<string, Item> = {};
  const count = r.uvar();
  if (count > SLOTS.length) throw new DecodeError(`${count} equipment slots, but there are only ${SLOTS.length}`);
  for (let i = 0; i < count; i++) {
    const slot = SLOTS[r.bits(5)];
    if (!slot) throw new DecodeError("unknown equipment slot in share link");
    const it: Item = {
      name: r.str(MAX_NAME_CHARS * 4),
      lvl: 0, star: 0, pot: "none", sup: 0, p: [], f: [],
    };
    const rawId = r.uvar();
    if (rawId > 0) it.itemId = rawId - 1;
    it.lvl = r.uvar();
    it.star = r.bits(6);
    const tier = TIERS[r.bits(3)];
    if (!tier) throw new DecodeError("unknown potential tier in share link");
    it.pot = tier;
    it.sup = r.bit() ? 1 : 0;
    const bossDrop = r.bit(), noSf = r.bit(), noFl = r.bit(), noPot = r.bit(), hasSub = r.bit();
    if (hasSub) it.sub = r.str(MAX_CLS_CHARS * 4);
    if (bossDrop) it.bossDrop = true;
    if (noSf) it.noSf = true;
    if (noFl) it.noFl = true;
    if (noPot) it.noPot = true;
    const pn = r.bits(3);
    for (let j = 0; j < pn; j++) it.p.push(readLine(r));
    const fn = r.bits(3);
    for (let j = 0; j < fn; j++) it.f.push(readLine(r));
    items[slot.id] = it;
  }

  const char: Character = { name, cls, main, lvl, cp, stats, items };
  if (r.bit()) {
    const n = r.uvar();
    if (n > 1000) throw new DecodeError(`${n} roster rows is not a MapleStory account`);
    const roster: RosterChar[] = [];
    for (let i = 0; i < n; i++) {
      const row: RosterChar = {
        name: r.str(MAX_NAME_CHARS * 4),
        cls: readDictStr(r, CLASS_DICT, MAX_CLS_CHARS),
        lvl: r.uvar(),
      };
      if (r.bit()) row.current = true;
      roster.push(row);
    }
    char.roster = roster;
  }
  return { char, rosterOmitted };
}

/* ---- container: compression + base64url --------------------------------- */

/** First byte: high nibble container version, low nibble compression method.
 *  Outside the bitstream so a decoder knows how to get at the bitstream. */
const C_NONE = 0x10;
const C_DEFLATE_RAW = 0x11;

async function deflateRaw(b: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const src = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(src).arrayBuffer());
  } catch {
    return null; // an environment that types the API but does not implement it
  }
}

async function inflateRaw(b: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new DecodeError("this browser cannot decompress share links");
  }
  try {
    const src = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(src).arrayBuffer());
  } catch {
    throw new DecodeError("share link is damaged — it may have been split across lines");
  }
}

function toBase64Url(b: Uint8Array): string {
  let s = "";
  // Chunked: String.fromCharCode(...b) blows the argument limit past ~100 KB.
  for (let i = 0; i < b.length; i += 0x2000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x2000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 ? "=".repeat(4 - (t.length % 4)) : "";
  let bin: string;
  try { bin = atob(t + pad); } catch { throw new DecodeError("not a valid share code"); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface ShareResult {
  /** base64url payload. Goes after `#b=`. */
  code: string;
  chars: number;
  /** Uncompressed payload size, for the "is the dictionary earning its keep"
   *  question. */
  rawBytes: number;
  /** Set when the roster was dropped to fit the budget. The UI must say so:
   *  "character + stats + slots, roster omitted". */
  degraded: "roster-omitted" | null;
  /** True when even the degraded code is over budget. The link still works —
   *  nothing is ever truncated — but it may not survive every client, and the
   *  UI should offer the JSON export instead. */
  oversize: boolean;
  compressed: boolean;
  /** Fields that were out of domain and were repaired before encoding. Empty
   *  for every profile the app itself produced. Show them: a link that quietly
   *  disagrees with the page it was made from is worse than no link. */
  repaired: FieldError[];
}

/** Encode a build into a share code. Always encodes the CANONICAL form: no
 *  icons (see the file header), optional false flags dropped.
 *
 *  The profile is validated first, because the wire format has fixed-width
 *  fields — 6 bits of star force, 2 of main stat — and handing it a value
 *  outside the domain would wrap rather than fail. Anything repaired is
 *  reported rather than silently accepted. */
export async function encodeShare(ch: Character, budget: number = URL_SIZE_BUDGET): Promise<ShareResult> {
  const checked = parseProfile(makeProfile(ch, "omitted"));
  const repaired = checked.ok ? [] : checked.errors;
  const canon = canonicalCharacter(checked.ok ? checked.profile.char : checked.partial.char);

  const attempt = async (withRoster: boolean) => {
    const raw = writePayload(canon, withRoster);
    const z = await deflateRaw(raw);
    const useZ = !!z && z.length < raw.length;
    const body = useZ && z ? z : raw;
    const out = new Uint8Array(body.length + 1);
    out[0] = useZ ? C_DEFLATE_RAW : C_NONE;
    out.set(body, 1);
    return { code: toBase64Url(out), rawBytes: raw.length, compressed: useZ };
  };

  const full = await attempt(true);
  if (full.code.length <= budget || !canon.roster?.length) {
    return {
      code: full.code, chars: full.code.length, rawBytes: full.rawBytes,
      degraded: null, oversize: full.code.length > budget, compressed: full.compressed, repaired,
    };
  }
  // The roster is the only part that can be dropped without changing the
  // advice on the page the link opens: rosterAdvice() is a separate rail.
  const lean = await attempt(false);
  return {
    code: lean.code, chars: lean.code.length, rawBytes: lean.rawBytes,
    degraded: "roster-omitted", oversize: lean.code.length > budget, compressed: lean.compressed, repaired,
  };
}

export type DecodeResult =
  | { ok: true; profile: Profile; rosterOmitted: boolean; warnings: FieldError[] }
  /** `partial` is present when the bytes decoded but a field was out of
   *  domain — a hand-edited link, or one from a newer build. The read-only
   *  view can still render it and say which fields were repaired. */
  | { ok: false; errors: FieldError[]; partial?: Profile };

/** Decode a share code. The result is run through parseProfile() before it is
 *  returned: a link is untrusted input that arrived from a stranger's Discord
 *  message, and advise() must never see a blob this file did not check. */
export async function decodeShare(code: string): Promise<DecodeResult> {
  const clean = code.trim().replace(/^#/, "").replace(/^b=/, "");
  let char: Character;
  let rosterOmitted: boolean;
  try {
    const bytes = fromBase64Url(clean);
    if (!bytes.length) throw new DecodeError("empty share code");
    const container = bytes[0];
    if ((container & 0xf0) !== 0x10) {
      throw new DecodeError(`share container v${container >> 4}, this build reads v1`);
    }
    const body = bytes.subarray(1);
    const payload =
      (container & 0x0f) === 1 ? await inflateRaw(body) :
      (container & 0x0f) === 0 ? body :
      (() => { throw new DecodeError("unknown compression in share link"); })();
    const res = readPayload(payload);
    char = res.char;
    rosterOmitted = res.rosterOmitted;
  } catch (e) {
    return {
      ok: false,
      errors: [{
        path: "#b",
        got: `${clean.length} characters`,
        want: "a MaplePlanner share code",
        fix: e instanceof DecodeError ? e.message : "link could not be read — ask for it again, unwrapped",
      }],
    };
  }

  const parsed = parseProfile({
    v: SCHEMA_VERSION, app: APP_ID, exported: new Date().toISOString(), icons: "omitted", char,
  });
  if (!parsed.ok) return { ok: false, errors: parsed.errors, partial: parsed.partial };
  return { ok: true, profile: parsed.profile, rosterOmitted, warnings: parsed.warnings };
}

/** `https://…/b/v1#b=<code>`. The path segment is a route hook for
 *  `/b/[code]`; the build itself is in the fragment and never leaves the
 *  browser, so a shared profile never appears in a server log. */
export function shareUrl(origin: string, code: string): string {
  return `${origin.replace(/\/$/, "")}/b/${SHARE_PATH_SEGMENT}#${SHARE_FRAGMENT_KEY}=${code}`;
}

/** Pull the code out of a `location.hash` (or a whole URL). Returns null when
 *  there is nothing to decode. */
export function readShareFragment(hashOrUrl: string): string | null {
  const hash = hashOrUrl.includes("#") ? hashOrUrl.slice(hashOrUrl.indexOf("#") + 1) : hashOrUrl;
  if (!hash) return null;
  for (const part of hash.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === SHARE_FRAGMENT_KEY) {
      const v = part.slice(eq + 1);
      return v ? v : null;
    }
  }
  return null;
}

/* ==========================================================================
   SECTION 7 — TESTS
   ==========================================================================
   There is no test runner in package.json yet, and adding one is another
   agent's file. So the suite is an exported async function of pure inputs:
   `await runSelfTest()` returns a report, from node or from a browser console,
   and drops straight into whatever runner lands later. */

export interface TestFailure { test: string; detail: string }
export interface SelfTestReport {
  passed: number;
  failed: TestFailure[];
  notes: string[];
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/** Deterministic PRNG — a property test that cannot be reproduced is a flake
 *  generator, not a test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCharacter(rnd: () => number): Character {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const word = () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '·é".charAt(Math.floor(rnd() * 65));
  const text = (n: number) => Array.from({ length: 1 + Math.floor(rnd() * n) }, word).join("").slice(0, MAX_NAME_CHARS);
  const line = () => {
    const r = rnd();
    if (r < 0.55) {
      const t = pick(LINE_DICT.filter((x) => x.includes("{n}")));
      const nRaw = rnd() < 0.25 ? Math.floor(rnd() * 4000) / 100 : Math.floor(rnd() * 60);
      return t.replace("{n}", renderScaled(Math.round(nRaw * 100)));
    }
    if (r < 0.65) return "";
    return text(30);
  };
  const items: Record<string, Item> = {};
  for (const s of SLOTS) {
    if (rnd() < 0.35) continue;
    const it: Item = {
      name: text(24),
      lvl: Math.floor(rnd() * 251),
      star: Math.floor(rnd() * (STAR_MAX + 1)),
      pot: pick(TIERS),
      sup: rnd() < 0.15 ? 1 : 0,
      p: Array.from({ length: Math.floor(rnd() * (MAX_LINES + 1)) }, line),
      f: Array.from({ length: Math.floor(rnd() * (MAX_LINES + 1)) }, line),
    };
    if (rnd() < 0.6) it.itemId = Math.floor(rnd() * 2_000_000);
    if (rnd() < 0.2) it.sub = text(16);
    if (rnd() < 0.2) it.bossDrop = true;
    if (rnd() < 0.1) it.noSf = true;
    if (rnd() < 0.1) it.noFl = true;
    if (rnd() < 0.1) it.noPot = true;
    items[s.id] = it;
  }
  const ch: Character = {
    name: text(12),
    cls: rnd() < 0.8 ? pick(CLASS_DICT) : text(20),
    main: pick(MAIN_STATS),
    lvl: 1 + Math.floor(rnd() * LEVEL_CAP),
    cp: Math.floor(rnd() * 90_000_000),
    stats: {
      main: Math.floor(rnd() * 60000),
      att: Math.floor(rnd() * 3000),
      crit: Math.round(rnd() * 10000) / 100,
      critdmg: Math.round(rnd() * 10000) / 100,
      boss: Math.round(rnd() * 40000) / 100,
      ied: Math.round(rnd() * 10000) / 100,
      hp: Math.floor(rnd() * 200000),
      arcane: Math.floor(rnd() * 1320),
      starforce: Math.floor(rnd() * 400),
    },
    items,
  };
  if (rnd() < 0.7) {
    ch.roster = Array.from({ length: Math.floor(rnd() * 42) }, () => {
      // Always non-empty: a nameless row is dropped by design (mergeRoster
      // keys on name), which is a documented repair, not a codec bug.
      const row: RosterChar = { name: "R" + text(12), cls: rnd() < 0.85 ? pick(CLASS_DICT) : text(18), lvl: 1 + Math.floor(rnd() * LEVEL_CAP) };
      if (rnd() < 0.05) row.current = true;
      return row;
    });
  }
  return ch;
}

/** Every slot filled, four potential and four flame lines each, every line a
 *  non-dictionary literal, every optional flag set, and a full roster. This is
 *  the profile that decides whether the share link needs to degrade. */
export function worstCaseCharacter(): Character {
  const items: Record<string, Item> = {};
  for (const s of SLOTS) {
    items[s.id] = {
      name: `Superior Arcane Umbra ${s.n} of the Eternal Flame`.slice(0, MAX_NAME_CHARS),
      lvl: 250,
      star: 30,
      pot: "legendary",
      sup: 1,
      itemId: 1_234_567,
      sub: "Two-handed Bow Fletching",
      bossDrop: true,
      noSf: true,
      noFl: true,
      noPot: true,
      p: Array.from({ length: 4 }, (_, i) => `Unlisted Potential Line ${s.id} #${i} +${17 + i}.${i}3%`),
      f: Array.from({ length: 4 }, (_, i) => `Unlisted Bonus Stat ${s.id} #${i} +${29 + i}`),
    };
  }
  return {
    name: "Archerroniwithaverylongname",
    cls: "Bow Master",
    main: "dex",
    lvl: 300,
    cp: 92_345_678,
    stats: { main: 65432, att: 2871, crit: 100, critdmg: 141.55, boss: 389.5, ied: 92.67, hp: 1_234_567, arcane: 1320, starforce: 397 },
    items,
    roster: Array.from({ length: 31 }, (_, i) => ({
      name: `Alternate${String(i).padStart(2, "0")}Char`,
      cls: CLASS_DICT[i % CLASS_DICT.length],
      lvl: 60 + i * 7,
      ...(i === 3 ? { current: true } : {}),
    })),
  };
}

/** A blank profile carrying nothing but the account's roster — the shape a
 *  user has after three screenshot imports and no gear entry. */
export function rosterOnlyCharacter(): Character {
  return {
    name: "Unnamed", cls: "Bow Master", main: "dex", lvl: 200, cp: 0,
    stats: { main: 0, att: 0, crit: 0, critdmg: 0, boss: 0, ied: 0, hp: 0, arcane: 0, starforce: 0 },
    items: {},
    roster: Array.from({ length: 31 }, (_, i) => ({
      name: `Roster${i}`, cls: CLASS_DICT[i % CLASS_DICT.length], lvl: 200 - i * 3,
      ...(i === 0 ? { current: true } : {}),
    })),
  };
}

export async function runSelfTest(exampleChar?: Character): Promise<SelfTestReport> {
  const failed: TestFailure[] = [];
  const notes: string[] = [];
  let passed = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    if (cond) passed++;
    else failed.push({ test: name, detail });
  };

  /* --- fixture: a v0 blob (no `v`) migrates and validates clean ---------- */
  if (exampleChar) {
    const rawV0 = JSON.parse(JSON.stringify(exampleChar)) as unknown; // exactly what storage.ts wrote
    check("v0 blob has no version field", schemaVersionOf(rawV0) === 0);
    const m = migrate(rawV0);
    check("v0 -> v1 in one step", m.steps.length === 1 && m.to === SCHEMA_VERSION, JSON.stringify(m.steps));
    const parsed = parseProfile(m.value);
    if (!parsed.ok) {
      failed.push({ test: "migrated v0 blob validates", detail: JSON.stringify(parsed.errors) });
    } else {
      passed++;
      check("migrated profile is v1", parsed.profile.v === SCHEMA_VERSION);
      check(
        "migration preserved every slot",
        Object.keys(parsed.profile.char.items).length === Object.keys(exampleChar.items).length,
        `${Object.keys(parsed.profile.char.items).length} of ${Object.keys(exampleChar.items).length}`
      );
      const before = stable(canonicalCharacter(exampleChar));
      const after = stable(canonicalCharacter(parsed.profile.char));
      check("migration changed no value", before === after, diff(before, after));
    }
  } else {
    notes.push("skipped the v0 fixture: pass exampleCharacter() from lib/rules.ts to run it");
  }

  /* --- round trip: fixtures --------------------------------------------- */
  const fixtures: Array<[string, Character]> = [
    ...(exampleChar ? ([["exampleCharacter()", exampleChar]] as Array<[string, Character]>) : []),
    ["rosterOnlyCharacter()", rosterOnlyCharacter()],
    ["worstCaseCharacter()", worstCaseCharacter()],
  ];
  for (const [label, ch] of fixtures) {
    const canon = stable(canonicalCharacter(ch));

    const json = importProfileJson(exportProfileJson(ch));
    if (!json.ok) failed.push({ test: `JSON round trip ${label}`, detail: JSON.stringify(json.errors) });
    else {
      passed++;
      const back = stable(canonicalCharacter(json.profile.char));
      check(`JSON round trip is lossless: ${label}`, back === canon, diff(canon, back));
      check(`JSON export declares icons omitted: ${label}`, json.profile.icons === "omitted");
    }

    const enc = await encodeShare(ch);
    const dec = await decodeShare(enc.code);
    if (!dec.ok) failed.push({ test: `share round trip ${label}`, detail: JSON.stringify(dec.errors) });
    else {
      passed++;
      const expected = enc.degraded === "roster-omitted"
        ? stable(canonicalCharacter({ ...ch, roster: undefined }))
        : canon;
      const back = stable(canonicalCharacter(dec.profile.char));
      check(`share round trip is lossless: ${label}`, back === expected, diff(expected, back));
      check(`degradation is reported, not silent: ${label}`, (enc.degraded === "roster-omitted") === dec.rosterOmitted);
    }
    notes.push(
      `${label}: ${enc.rawBytes} B packed -> ${enc.chars} chars base64url` +
      `${enc.compressed ? " (deflate-raw)" : " (uncompressed)"}` +
      `${enc.degraded ? ` · DEGRADED: ${enc.degraded}` : ""}${enc.oversize ? " · OVER BUDGET" : ""}` +
      ` · JSON for comparison: ${exportProfileJson(ch).length} chars`
    );
  }

  /* --- the budget assertion, stated as an assertion ---------------------- */
  const worst = await encodeShare(worstCaseCharacter());
  check(
    "worst case never truncates silently",
    !worst.oversize || worst.degraded !== null || worst.chars > URL_SIZE_BUDGET,
    "an oversize code must be reported as oversize"
  );
  if (worst.chars > URL_SIZE_BUDGET) {
    notes.push(
      `worst case is ${worst.chars} chars, over the ${URL_SIZE_BUDGET} budget even with ${worst.degraded ?? "no"} degradation — ` +
      `the UI must offer the JSON export for profiles this large rather than a link`
    );
  }

  /* --- the number that breaks a x10 scale ------------------------------- */
  {
    const ch = rosterOnlyCharacter();
    ch.stats.ied = 92.67;
    ch.stats.critdmg = 41.5;
    const dec = await decodeShare((await encodeShare(ch)).code);
    check("92.67 survives the share codec", dec.ok && dec.profile.char.stats.ied === 92.67,
      dec.ok ? String(dec.profile.char.stats.ied) : "decode failed");
    check("41.5 survives the share codec", dec.ok && dec.profile.char.stats.critdmg === 41.5,
      dec.ok ? String(dec.profile.char.stats.critdmg) : "decode failed");
  }

  /* --- property test ----------------------------------------------------- */
  const rnd = mulberry32(0x5eed);
  let props = 0;
  for (let i = 0; i < 200; i++) {
    const ch = randomCharacter(rnd);
    const enc = await encodeShare(ch, Number.MAX_SAFE_INTEGER); // never degrade: test the codec, not the budget
    const dec = await decodeShare(enc.code);
    if (!dec.ok) { failed.push({ test: `property #${i}`, detail: JSON.stringify(dec.errors) }); continue; }
    const a = stable(canonicalCharacter(ch));
    const b = stable(canonicalCharacter(dec.profile.char));
    if (a !== b) { failed.push({ test: `property #${i}`, detail: diff(a, b) }); continue; }
    props++;
  }
  check(`200 generated profiles round trip`, props === 200, `${props}/200`);

  /* --- validator: every error is reported, nothing throws ---------------- */
  {
    const bad = {
      v: 1, app: APP_ID, exported: "not a date", icons: "maybe",
      char: {
        name: 42, cls: "Bow Master", main: "dexterity", lvl: 999, cp: "4900000",
        stats: { main: 19051, att: 1452, crit: 98, critdmg: "41.5", boss: 154, ied: -3, hp: 44190, arcane: 910, starforce: 188 },
        items: {
          weapon: { name: "Genesis Bow", lvl: 200, star: 32, pot: "legendry", sup: 2, p: ["a", "b", "c", "d", "e"], f: "nope" },
          wepon: { name: "typo slot" },
          ring1: null,
        },
        roster: [{ name: "Ok", cls: "Hero", lvl: 210 }, { cls: "Hero", lvl: 10 }, "nope"],
      },
    };
    const res = parseProfile(bad);
    check("bad profile fails", !res.ok);
    if (!res.ok) {
      const at = (p: string) => res.errors.find((e) => e.path === p);
      check("star 32 is clamped to 30 and named", at("char.items.weapon.star")?.fix.includes("30") ?? false, JSON.stringify(at("char.items.weapon.star")));
      check("star error quotes the per-item cap", at("char.items.weapon.star")?.want.includes("sfCap()") ?? false);
      check("unknown slot names the nearest id", at("char.items.wepon")?.want.includes("weapon") ?? false, JSON.stringify(at("char.items.wepon")));
      check("unknown slot is not silently dropped", !("wepon" in res.partial.char.items));
      check("main is domain-checked", at("char.main")?.want.includes("dex") ?? false);
      check("lvl 999 is clamped", res.partial.char.lvl === LEVEL_CAP);
      check("quoted cp is recovered", res.partial.char.cp === 4900000, String(res.partial.char.cp));
      check("quoted critdmg is recovered", res.partial.char.stats.critdmg === 41.5, String(res.partial.char.stats.critdmg));
      check("negative ied is clamped", res.partial.char.stats.ied === 0);
      check("pot typo is recovered", res.partial.char.items.weapon.pot === "legendary");
      check("sup 2 is rejected", res.partial.char.items.weapon.sup === 0);
      check("5 potential lines truncate to 4", res.partial.char.items.weapon.p.length === MAX_LINES);
      check("non-array flames become []", res.partial.char.items.weapon.f.length === 0);
      check("an explicitly null slot is not an error", !at("char.items.ring1"));
      check("the roster survives a bad row", res.partial.char.roster?.length === 1, JSON.stringify(res.partial.char.roster));
      check("every error has a fix", res.errors.every((e) => !!e.fix && !!e.want && !!e.path));
    }
  }

  /* --- validator: the icon gate ----------------------------------------- */
  {
    const evil = makeProfile({ ...rosterOnlyCharacter(), items: {
      hat: { name: "H", lvl: 1, star: 0, pot: "none", sup: 0, p: [], f: [], icon: "javascript:alert(1)" },
    } }, "inline");
    const res = parseProfile(evil);
    check("a non-data: icon is rejected", !res.ok && !res.partial.char.items.hat.icon);
  }

  /* --- out-of-domain input cannot corrupt the wire format --------------- */
  {
    // 6 bits of star force would wrap a 99 into 35 and hand the viewer a build
    // that never existed. It must be repaired and reported instead.
    const ch = rosterOnlyCharacter();
    ch.items.weapon = { name: "Genesis Bow", lvl: 200, star: 99, pot: "legendary", sup: 0, p: [], f: [] };
    ch.name = "";
    const enc = await encodeShare(ch);
    check("out-of-domain star is reported, not wrapped", enc.repaired.some((e) => e.path === "char.items.weapon.star"));
    const dec = await decodeShare(enc.code);
    check("repaired star is the clamp, not a wrap", dec.ok && dec.profile.char.items.weapon.star === STAR_MAX,
      dec.ok ? String(dec.profile.char.items.weapon.star) : "decode failed");
    check("an empty character name round-trips", dec.ok && dec.profile.char.name === "");
    check("a clean profile reports no repairs", (await encodeShare(rosterOnlyCharacter())).repaired.length === 0);
  }

  /* --- a file from a newer build still gives up its gear ---------------- */
  {
    const future = JSON.parse(exportProfileJson(rosterOnlyCharacter())) as Record<string, unknown>;
    future.v = SCHEMA_VERSION + 1;
    const res = importProfileJson(JSON.stringify(future));
    check("a newer file fails", !res.ok);
    if (!res.ok) {
      check("a newer file still yields its roster", res.partial.char.roster?.length === 31,
        String(res.partial.char.roster?.length));
      check("the version error says what happened", res.errors.some((e) => e.path === "v" && e.want.includes("newer")));
    }
  }

  /* --- share fragment plumbing ------------------------------------------ */
  {
    const code = (await encodeShare(rosterOnlyCharacter())).code;
    const url = shareUrl("https://maple-planner-blond.vercel.app/", code);
    check("share url puts the payload in the fragment", url.includes("#b=") && url.indexOf("#") < url.indexOf(code));
    check("the code survives the URL", readShareFragment(url) === code);
    check("base64url needs no escaping", encodeURIComponent(code) === code);
    check("a bare hash parses", readShareFragment(`#b=${code}`) === code);
    check("no fragment reads as null", readShareFragment("https://example.com/b/v1") === null);
    const junk = await decodeShare("this-is-not-a-share-code");
    check("junk decodes to an error, never a throw", !junk.ok);
  }

  return { passed, failed, notes };
}

function diff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `diverges at ${i}: expected ...${a.slice(Math.max(0, i - 40), i + 60)} | got ...${b.slice(Math.max(0, i - 40), i + 60)}`;
}
