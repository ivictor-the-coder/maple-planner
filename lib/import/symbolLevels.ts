// The six Arcane symbol LEVELS, on their way from a screenshot (or a keyboard)
// to Character.symbols — and the two different rules those two sources get.
//
// WHY THIS IS A FILE OF ITS OWN, and not a few lines inside the route. Exactly
// the reason lib/import/damageReadings.ts gives: app/api/import/route.ts imports
// next/server and the entitlement store, it is a Next route module, and the only
// way to reach it is an HTTP request that spends real vision tokens. The code
// that decides whether a model's answer becomes a number on somebody's character
// sheet has to live where a node script can call it with fixed inputs.
// `__selfTest()` at the bottom is that call.
//
// WHAT THE DESTINATION EXPECTS. lib/rules.ts `Character.symbols` is a
// `SymbolState` — per-area LEVELS, never a derived total, because Arcane Power
// is a sum and a sum does not invert to a spread (lib/symbols.ts,
// NO_ARCANE_LEVELS_WHY). So this file produces levels or it produces nothing.
//
// THE TWO RULES, and the difference between them is the whole point:
//
//   parseModelLevel()  a VISION MODEL said this. Rejects 0.
//   parseTypedLevel()  a PERSON typed this.       Accepts 0.
//
// 0 is a real claim — "I have not unlocked this symbol" — and lib/symbols.ts
// branches on it: planArcane() marks the area `unlocked: false` and attaches
// "You do not have this symbol yet", rankArcaneNextLevel() drops the area from
// the ranking entirely, and hasArcaneLevels() counts it as nothing entered. It
// is also exactly what a model emits when it is filling in a required field it
// could not see, and the two are indistinguishable on the wire. A keystroke is a
// human measurement; a model's 0 is filler. Same reasoning, same trade and the
// same escape hatch as parsePrintedPercent(): the player can always type it.

import {
  ARCANE_AREAS,
  ARCANE_LEVEL_CAP,
  AREA_NAME,
  type ArcaneArea,
  type ArcaneLevels,
} from "../symbols";

/* ---------------------------------------------------------------- the wire */

/**
 * The keys the six levels travel under inside the import dialog's stats patch.
 *
 * FLAT, and inside `stats`, for one reason: components/ImportDialog.tsx is the
 * only channel that exists between this route and a character sheet, its
 * `StatsPatch` merge across several screenshots is a SHALLOW spread, and its
 * confirmation table renders scalars. A nested object would be replaced whole by
 * the next screenshot instead of merged, and would render as "[object Object]"
 * in the one list a player approves an import from.
 *
 * Written out rather than computed so the compiler checks every one of the six
 * against the template type, and `Record<ArcaneArea, ...>` makes a missing area
 * a compile error rather than a key that silently never arrives.
 */
export type ArcaneLevelPatchKey = `sym${Capitalize<ArcaneArea>}`;
export type ArcaneLevelPatch = Partial<Record<ArcaneLevelPatchKey, number>>;

export const ARCANE_PATCH_KEY: Record<ArcaneArea, ArcaneLevelPatchKey> = {
  vj: "symVj",
  chuchu: "symChuchu",
  lach: "symLach",
  arcana: "symArcana",
  morass: "symMorass",
  esfera: "symEsfera",
};

/* -------------------------------------------------------------- the parsers */

/**
 * The whole accepted grammar for a level: digits, optionally behind the "Lv."
 * the tab prints. Anchored at both ends.
 *
 * No decimal tail, because a symbol level is a whole number and "12.5" is a
 * misread of something else in the window (an EXP bar, a percentage). No
 * salvage out of a sentence, for the reason damageReadings.ts gives at length:
 * prose is a refusal, and turning hedged prose into a measurement is how a
 * guess ends up wearing the same badge as a clean read.
 */
const LEVEL_SHAPE = /^(?:lv\.?\s*)?\d{1,3}$/i;

/** Shared by both rules: shape, integer, and the cap. Returns undefined, never NaN. */
function parseLevel(v: unknown, floor: number): number | undefined {
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string") {
    const t = v.trim().replace(/,/g, "");
    if (!LEVEL_SHAPE.test(t)) return undefined;
    n = parseInt(t.replace(/^lv\.?\s*/i, ""), 10);
  } else {
    return undefined;
  }
  // Number.isInteger is false for NaN and for both infinities, which is the
  // whole of the NaN guard: a non-finite level is what produces a confident
  // completion date computed from nothing.
  if (!Number.isInteger(n)) return undefined;
  if (n < floor || n > ARCANE_LEVEL_CAP) return undefined;
  return n;
}

/**
 * One level as read by a VISION MODEL, or undefined.
 *
 * Rejects null / undefined / "" (strict json_schema has no way to omit a
 * required property, so null IS the model's omission), prose, NaN, Infinity,
 * non-integers, negatives, anything above ARCANE_LEVEL_CAP — and 0, for the
 * reason at the top of this file.
 */
export function parseModelLevel(v: unknown): number | undefined {
  return parseLevel(v, 1);
}

/**
 * One level as TYPED BY A PERSON, or undefined for "this box is empty".
 *
 * Accepts 0: a player who has not unlocked Esfera is making a real claim about
 * their account and there is no other way to state it. Everything else is
 * rejected the same way — and rejection means the box holds no level, NOT that
 * it holds zero, because those are different claims and lib/symbols.ts branches
 * on which one it is given.
 */
export function parseTypedLevel(v: string): number | undefined {
  return parseLevel(v, 0);
}

/* ------------------------------------------------------ model answer -> wire */

/** What the vision model is allowed to put in the "symbols" slot. */
export type RawArcaneSymbols = Partial<Record<ArcaneArea, unknown>>;

/**
 * The model's symbol window, tidied into the flat patch keys.
 *
 * An area that could not be read is ABSENT from the returned object rather than
 * present holding 0 or undefined — same contract as readDamageReadings(), and
 * for the same reason: `"symVj" in patch` has to stay false, or every downstream
 * "did we get this?" check reads true and is bypassed by an undefined.
 *
 * Returns `{}` when nothing was readable, which spreads into the stats payload
 * as nothing at all.
 */
export function readArcaneLevelPatch(raw: unknown): ArcaneLevelPatch {
  const out: ArcaneLevelPatch = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as RawArcaneSymbols;
  for (const area of ARCANE_AREAS) {
    const n = parseModelLevel(o[area]);
    if (n !== undefined) out[ARCANE_PATCH_KEY[area]] = n;
  }
  return out;
}

/* ------------------------------------------------------ wire -> the sheet */

/**
 * The six levels back out of an import dialog's stats patch.
 *
 * Takes `unknown` deliberately. The patch arrives typed as ImportDialog's
 * `StatsPatch`, an interface this change does not own and which does not
 * declare these keys yet; the route sends them and the dialog's shallow merge
 * carries them through untouched. Accepting `unknown` reads them without a cast
 * and without pretending the declaration says something it does not — and every
 * value is re-validated here, so nothing is trusted merely because it arrived.
 */
export function arcaneLevelsFromPatch(patch: unknown): Partial<ArcaneLevels> {
  const out: Partial<ArcaneLevels> = {};
  if (!patch || typeof patch !== "object") return out;
  const o = patch as Record<string, unknown>;
  for (const area of ARCANE_AREAS) {
    const n = parseModelLevel(o[ARCANE_PATCH_KEY[area]]);
    if (n !== undefined) out[area] = n;
  }
  return out;
}

/**
 * Six levels, or nothing at all.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. `ArcaneLevels` has no room for "not
 * entered" — every area holds a number, and 0 there means "you do not own this
 * symbol", which is a claim about the player's account. So a partial read must
 * not be completed with zeroes: five real levels and one invented 0 is a
 * spread nobody has, and the model ranks and dates it as confidently as a true
 * one. Absent beats fabricated.
 *
 * `base` is what makes a partial read useful: overlaid on levels the player has
 * already entered, four re-read areas still leave a complete, entirely-measured
 * set. With no base, all six must be present or this returns undefined.
 */
export function completeArcaneLevels(
  partial: Partial<ArcaneLevels>,
  base?: ArcaneLevels,
): ArcaneLevels | undefined {
  const out = {} as ArcaneLevels;
  for (const area of ARCANE_AREAS) {
    const v = partial[area] ?? base?.[area];
    if (v === undefined) return undefined;
    out[area] = v;
  }
  return out;
}

/** How many of the six a partial set actually carries. For sentences that have
 *  to say "4 of 6" rather than implying the other two are zero. */
export function countArcaneLevels(partial: Partial<ArcaneLevels>): number {
  return ARCANE_AREAS.filter((a) => partial[a] !== undefined).length;
}

/* ------------------------------------------------------------- the prompt */

/**
 * The block added to the vision prompt for the Symbol window, held in the same
 * file as the parser that has to survive whatever it produces — the precedent
 * is STAT_WINDOW_DAMAGE_PROMPT in lib/import/damageReadings.ts.
 *
 * The area names are built from AREA_NAME rather than retyped, so the labels the
 * model is told to look for cannot drift from the labels the rest of the app
 * prints. What is NOT stated is where in the window anything sits, or what the
 * window's exact title is in each region: nobody has recorded that, and an
 * instruction to look somewhere that may not exist is a good way to make a model
 * produce something. "If you can see it" is the whole of what is sourced.
 */
export const SYMBOL_TAB_PROMPT = `SEPARATELY AGAIN: the screenshot may show the SYMBOL window — the panel listing
the six ARCANE SYMBOLS, one per Arcane River area, each showing that area's name
and that symbol's level. The six areas are, exactly:
${ARCANE_AREAS.map((a) => AREA_NAME[a]).join(", ")}.
If and only if that window is visible, add a "symbols" key:

  "symbols": {
${ARCANE_AREAS.map((a, i) => {
  // No trailing comma on the last line: this block is an example of the JSON we
  // are asking for, and an example containing invalid JSON is an invitation to
  // return some.
  const tail = i === ARCANE_AREAS.length - 1 ? " " : ",";
  return `    "${a}": number${tail}${" ".repeat(Math.max(1, 10 - a.length))}// ${AREA_NAME[a]}`;
}).join("\n")}
  }

Give the SYMBOL's own level — a whole number from 1 to ${ARCANE_LEVEL_CAP}. It is not the
character's Lv., not the symbol EXP, and not how many symbols are held.
Return null for any symbol whose level you cannot read, null for one the window
shows as locked or not yet obtained, and null for the whole "symbols" key when
this window is not on screen. Do NOT return 0 and do NOT estimate. A guessed
level here is worse than a missing one: it produces a confident "level this one
next" answer for a symbol spread the player does not have.`;

/* -------------------------------------------------------------- self test */

export function __selfTest(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const eq = (what: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };

  /* ---- the model's rule ---- */
  const modelCases: Array<[string, unknown, number | undefined]> = [
    ["json number 20", 20, 20],
    ["json number 1", 1, 1],
    ['string "12"', "12", 12],
    ['printed "Lv. 12"', "Lv. 12", 12],
    ['printed "Lv.7"', "Lv.7", 7],
    ["null (schema omission)", null, undefined],
    ["undefined (key absent)", undefined, undefined],
    ['empty string ""', "", undefined],
    ["zero (indistinguishable from filler)", 0, undefined],
    ['string zero "0"', "0", undefined],
    ["negative", -3, undefined],
    ["above the cap", ARCANE_LEVEL_CAP + 1, undefined],
    ["non-integer", 12.5, undefined],
    ['non-integer string "12.5"', "12.5", undefined],
    ["NaN", NaN, undefined],
    ["Infinity", Infinity, undefined],
    ["-Infinity", -Infinity, undefined],
    ["a sentence", "I cannot read that symbol", undefined],
    ["a number inside a sentence", "Vanishing Journey is level 20", undefined],
    ["a hedged number", "about 12", undefined],
    ["a range", "12-14", undefined],
    ['the word "null"', "null", undefined],
    ["a boolean", true, undefined],
    ["an array", [12], undefined],
    ["an object", { level: 12 }, undefined],
    // The character's level is the neighbour most likely to land in this field.
    ["a character level", 245, undefined],
    ["exponent notation", "1e1", undefined],
  ];
  for (const [what, input, want] of modelCases) {
    eq(`model: ${what}`, parseModelLevel(input), want);
  }

  /* ---- the human's rule: the same, except 0 ---- */
  eq("typed: empty box", parseTypedLevel(""), undefined);
  eq("typed: whitespace", parseTypedLevel("   "), undefined);
  eq("typed: zero is a claim, and it is kept", parseTypedLevel("0"), 0);
  eq("typed: 20", parseTypedLevel("20"), 20);
  eq("typed: above the cap", parseTypedLevel(String(ARCANE_LEVEL_CAP + 1)), undefined);
  eq("typed: negative", parseTypedLevel("-1"), undefined);
  eq("typed: half-typed exponent", parseTypedLevel("1e"), undefined);
  eq("typed: exponent", parseTypedLevel("1e3"), undefined);
  eq("typed: decimal", parseTypedLevel("12.5"), undefined);
  eq("typed: prose", parseTypedLevel("twelve"), undefined);
  eq("typed: hex", parseTypedLevel("0x10"), undefined);
  eq("typed: lone minus", parseTypedLevel("-"), undefined);
  for (const bad of ["", "   ", "1e", "abc", "-", "12.5", "21", "-1"]) {
    const got = parseTypedLevel(bad);
    if (got !== undefined && !Number.isFinite(got)) {
      failures.push(`typed: "${bad}" produced a non-finite level`);
    }
  }

  /* ---- the wire ---- */
  const full = readArcaneLevelPatch({
    vj: 20, chuchu: 20, lach: 20, arcana: 20, morass: 20, esfera: 15,
  });
  eq("patch: six read", full, {
    symVj: 20, symChuchu: 20, symLach: 20, symArcana: 20, symMorass: 20, symEsfera: 15,
  });

  const partial = readArcaneLevelPatch({ vj: 20, chuchu: null, lach: "Lv. 18", esfera: 0 });
  if (has(partial, "symChuchu")) failures.push("patch: a key survived a null");
  if (has(partial, "symEsfera")) failures.push("patch: a key survived a model-side 0");
  if (has(partial, "symArcana")) failures.push("patch: a key appeared for a missing area");
  eq("patch: what survived", partial, { symVj: 20, symLach: 18 });

  eq("patch: no window", readArcaneLevelPatch(null), {});
  eq("patch: not an object", readArcaneLevelPatch("Symbol tab not visible"), {});
  eq("patch: an array", readArcaneLevelPatch([20, 20, 20, 20, 20, 15]), {});
  eq("patch: all null", readArcaneLevelPatch({
    vj: null, chuchu: null, lach: null, arcana: null, morass: null, esfera: null,
  }), {});

  /* ---- back off the wire ---- */
  eq("fromPatch: round trip", arcaneLevelsFromPatch(full), {
    vj: 20, chuchu: 20, lach: 20, arcana: 20, morass: 20, esfera: 15,
  });
  eq("fromPatch: ignores the rest of the stat patch", arcaneLevelsFromPatch({
    main: 20790, att: 1497, arcane: 1070, symVj: 20,
  }), { vj: 20 });
  eq("fromPatch: nothing", arcaneLevelsFromPatch(undefined), {});

  /* ---- complete or nothing ---- */
  const six: ArcaneLevels = { vj: 20, chuchu: 20, lach: 20, arcana: 20, morass: 20, esfera: 15 };
  eq("complete: all six", completeArcaneLevels(six), six);
  if (completeArcaneLevels({ vj: 20 }) !== undefined) {
    failures.push("complete: one level was completed with zeroes");
  }
  if (completeArcaneLevels({}) !== undefined) failures.push("complete: nothing became a spread");
  eq("complete: partial over a base", completeArcaneLevels({ esfera: 16 }, six), { ...six, esfera: 16 });
  // 0 is a legitimate entered level, so it must survive the overlay rather than
  // being swallowed by `??` and replaced from the base.
  eq("complete: an entered 0 beats the base", completeArcaneLevels({ esfera: 0 }, six), { ...six, esfera: 0 });
  eq("count: partial", countArcaneLevels({ vj: 20, esfera: 0 }), 2);
  eq("count: none", countArcaneLevels({}), 0);

  /* ---- the prompt names all six areas ---- */
  for (const area of ARCANE_AREAS) {
    if (!SYMBOL_TAB_PROMPT.includes(AREA_NAME[area])) {
      failures.push(`prompt: does not name ${AREA_NAME[area]}`);
    }
    if (!SYMBOL_TAB_PROMPT.includes(`"${area}"`)) {
      failures.push(`prompt: does not ask for the key "${area}"`);
    }
  }

  return { ok: failures.length === 0, failures };
}
