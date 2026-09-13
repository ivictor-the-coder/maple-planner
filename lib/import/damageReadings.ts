// Reads the stat window's two printed damage percentages out of whatever a
// vision model hands back, and refuses to invent one.
//
// WHY THIS IS A SEPARATE FILE. The rest of the screenshot importer lives in
// app/api/import/route.ts, which cannot be required from a node script: it
// imports next/server and the entitlement store, and it is reachable only
// through an HTTP request that spends real vision tokens. The two functions
// below are the ones that decide whether a number becomes a measurement, so
// they live where they can be run directly against fixed inputs. `__selfTest()`
// at the bottom is that run; route.ts calls `readDamageReadings` and nothing
// else.
//
// WHAT THE DESTINATION EXPECTS. lib/rules.ts `DamageReadings` stores the
// PRINTED percent for both fields — 73 for "DAMAGE 73.00%", 115.79 for "FINAL
// DAMAGE 115.79%". The adapter in lib/damage.ts is what converts, and the
// stat window's "FINAL DAMAGE 115.79%" means a multiplier of 2.1579, not
// 1.1579 (DAMAGE_RANGE_VALIDATION.finalDamageReading is the authority). So
// this file must NOT convert, normalise or rescale anything. It copies the
// printed figure or it returns nothing. A second representation of the same
// number is how the two readings would start disagreeing.
//
// THE ONE RULE. Absence is meaningful. `DamageReadings` leaves both fields
// optional precisely so that "nobody has read this" stays distinguishable from
// "this character reads zero", and lib/rules.ts branches on that distinction:
// a present damagePct flips the boss-damage rec's badge from `placeholder` to
// `modelled`. A model that guesses would therefore mint a `modelled` badge out
// of nothing. Every rejection below returns undefined, and `readDamageReadings`
// omits the key entirely rather than writing a zero.

import type { DamageReadings } from "../rules";

/**
 * Upper plausibility bound for a printed percent from this window.
 *
 * This is a GUARD, not a game constant — nobody has measured a cap and this
 * file does not claim one. Its only job is to reject a number that cannot be
 * one of these two lines at all. The same stat window prints DAMAGE RANGE
 * (6,231,358 on the observed character), COMBAT POWER (5,399,368) and MAX HP
 * alongside them, and a model that puts one of those in the wrong field is the
 * realistic failure; six and seven figures are what this excludes. A percent
 * in the thousands is already far past anything the game shows, so the bound is
 * loose on purpose: a tight one would be an invented cap presented as fact.
 */
export const PRINTED_PCT_SANITY_MAX = 10_000;

/**
 * The whole accepted grammar: digits, an optional decimal tail, an optional
 * percent sign. Anchored at both ends on purpose.
 *
 * WHY ANCHORED RATHER THAN "PULL THE NUMBER OUT". The model answers this
 * question in one of three shapes — 115.79, "115.79", "115.79%" — and those
 * are the three this accepts. Anything else is the model talking: "about 116",
 * "115.79 (final damage)", "I cannot read that line". Salvaging a number from
 * a sentence would turn hedged prose into a measurement carrying the same
 * weight as a clean read, and this is the one field where a wrong number is
 * worse than a missing one. Prose is a refusal; treat it as one. The importer
 * already applies exactly this reasoning to tooltip lines (see NARRATION in
 * app/api/import/route.ts).
 *
 * Commas are stripped before the test, so "1,234.5%" is read as 1234.5.
 */
const PRINTED_PCT_SHAPE = /^\+?\d+(?:\.\d+)?\s*%?$/;

/**
 * One printed percent, or undefined when the answer is not one.
 *
 * Rejects, and why each rejection is not a number we could have kept:
 *  - null / undefined / a missing key — the model was told to omit rather than
 *    guess, so this is it obeying. Strict json_schema has no way to omit a
 *    required property, so null IS the omission.
 *  - NaN and Infinity — Number.isFinite. A provider that ignored the schema can
 *    return either as a bare token, and both survive Number().
 *  - anything not matching the shape above — a sentence, an empty string, a
 *    range like "73-75", an object, a boolean, an array.
 *  - zero — see below. This is the one rejection that discards a number the
 *    game could genuinely print.
 *  - negative — not printed by this window, and a leading minus is a sign the
 *    field was read from something else entirely.
 *  - greater than PRINTED_PCT_SANITY_MAX — a seven-figure neighbour landed in
 *    the wrong field.
 *
 * ZERO IS REJECTED FROM THE MODEL PATH, DELIBERATELY. A freshly made character
 * really would print "DAMAGE 0.00%", so this throws away a true reading in that
 * one case. It is still the right trade: 0 is also exactly what a model emits
 * when it is filling in a required field it could not see, and the two are
 * indistinguishable here. Keeping a false 0 costs a fabricated `modelled`
 * badge on a boss-damage rec; dropping a true 0 costs nothing at all, because
 * DEFAULT_DAMAGE_PCT and DEFAULT_FINAL_DAMAGE_PCT are 0 — the app computes the
 * same figures either way, and only the badge changes, downward, to the truth
 * that nothing was measured. A player who really reads 0.00% can still type it
 * into the manual stat-window box, where a keystroke is a human measurement
 * rather than a model's filler.
 */
export function parsePrintedPercent(v: unknown): number | undefined {
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string") {
    const t = v.trim().replace(/,/g, "");
    if (!PRINTED_PCT_SHAPE.test(t)) return undefined;
    n = parseFloat(t);
  } else {
    return undefined;
  }
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0 || n > PRINTED_PCT_SANITY_MAX) return undefined;
  return n;
}

/** What the vision model is allowed to put in these two slots, before parsing. */
export interface RawDamageReadings {
  damagePct?: unknown;
  finalDamagePct?: unknown;
}

/**
 * The two readings, with any field that could not be read left OFF the object
 * rather than set to a default.
 *
 * Returns `{}` when neither was readable, which spreads into the stats payload
 * as nothing at all — so "could not read" travels the wire as an absent key,
 * the same shape lib/rules.ts already expects from a share link.
 */
export function readDamageReadings(raw: RawDamageReadings | null | undefined): DamageReadings {
  const out: DamageReadings = {};
  if (!raw || typeof raw !== "object") return out;
  const dmg = parsePrintedPercent(raw.damagePct);
  if (dmg !== undefined) out.damagePct = dmg;
  const fin = parsePrintedPercent(raw.finalDamagePct);
  if (fin !== undefined) out.finalDamagePct = fin;
  return out;
}

/**
 * The two lines added to the vision prompt's "stats" block, held here so that
 * the wording and the parser that has to survive it stay in one file.
 *
 * The labels are quoted the way the game prints them — all caps, two decimals —
 * from the 2026-09-12 reading of the live character recorded in lib/damage.ts.
 * What is NOT stated here is where in the window they sit, because nobody has
 * recorded that: telling the model to "expand Detailed Stats" would be an
 * invented instruction, and an instruction to look somewhere that does not
 * exist is a good way to make a model produce something. "If you can see it"
 * is the whole of what is sourced.
 *
 * "DAMAGE" and "DAMAGE RANGE" are called apart explicitly because they are
 * adjacent lines in the same window, one a two-decimal percent and one a
 * seven-figure number, and confusing them is the single most likely way this
 * field goes wrong.
 */
export const STAT_WINDOW_DAMAGE_PROMPT = `    "damagePct": number,     // the line labelled exactly "DAMAGE" — a percent with two decimals.
                             // "DAMAGE 73.00%" is 73. This is NOT "DAMAGE RANGE", which is a
                             // separate seven-figure number in the same window. null if unsure.
    "finalDamagePct": number // the line labelled exactly "FINAL DAMAGE" — also a percent with two
                             // decimals. "FINAL DAMAGE 115.79%" is 115.79. Copy the printed
                             // number as shown; do not convert or rescale it. null if unsure.
                             // FOR BOTH OF THESE: if the line is not on screen, or the cursor
                             // covers it, or you are not certain of a digit, return null.
                             // Do NOT return 0 and do NOT estimate. Leaving a field out is
                             // correct and useful here; 0 is a real reading that some characters
                             // have, so a guessed 0 is recorded as a measurement and cannot be
                             // told apart from one.`;

/** Fixtures used by __selfTest, exported so a harness can print them verbatim. */
export const __selfTestCases: ReadonlyArray<{ what: string; input: unknown; want: number | undefined }> = [
  // Exactly what the game prints for the observed character (lib/damage.ts:465).
  { what: 'game string "73.00%"', input: "73.00%", want: 73 },
  { what: 'game string "115.79%"', input: "115.79%", want: 115.79 },
  // The same figures with the percent sign already stripped.
  { what: 'bare string "115.79"', input: "115.79", want: 115.79 },
  { what: "json number 115.79", input: 115.79, want: 115.79 },
  { what: "json number 73", input: 73, want: 73 },
  { what: 'spaced percent "73.00 %"', input: "73.00 %", want: 73 },
  { what: 'thousands "1,234.50%"', input: "1,234.50%", want: 1234.5 },
  // Absence, in every shape the ladder can deliver it.
  { what: "null (schema omission)", input: null, want: undefined },
  { what: "undefined (key absent)", input: undefined, want: undefined },
  { what: 'empty string ""', input: "", want: undefined },
  // Narration and garbage.
  { what: "a sentence", input: "I cannot read the FINAL DAMAGE line", want: undefined },
  { what: "a number inside a sentence", input: "Final damage is 115.79%", want: undefined },
  { what: "a hedged number", input: "about 116", want: undefined },
  { what: "a range", input: "73-75", want: undefined },
  { what: 'the word "null"', input: "null", want: undefined },
  { what: "NaN", input: NaN, want: undefined },
  { what: "Infinity", input: Infinity, want: undefined },
  { what: "a boolean", input: true, want: undefined },
  { what: "an array", input: [115.79], want: undefined },
  { what: "an object", input: { value: 115.79 }, want: undefined },
  // The rejections that are judgement calls, not type errors.
  { what: "zero (indistinguishable from filler)", input: 0, want: undefined },
  { what: 'string zero "0.00%"', input: "0.00%", want: undefined },
  { what: "negative", input: -73, want: undefined },
  { what: "a seven-figure neighbour (DAMAGE RANGE)", input: 6231358, want: undefined },
  { what: "a seven-figure neighbour as a string", input: "6,231,358", want: undefined },
];

export function __selfTest(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const c of __selfTestCases) {
    const got = parsePrintedPercent(c.input);
    if (got !== c.want) failures.push(`${c.what}: got ${String(got)}, want ${String(c.want)}`);
  }

  // The absence contract is about KEYS, not values: a rejected field must not
  // appear on the object at all, or `"damagePct" in stats` reads true and every
  // downstream `?? DEFAULT` is bypassed by an undefined.
  const both = readDamageReadings({ damagePct: "73.00%", finalDamagePct: "115.79%" });
  if (both.damagePct !== 73 || both.finalDamagePct !== 115.79)
    failures.push(`both: got ${JSON.stringify(both)}`);

  const half = readDamageReadings({ damagePct: "73.00%", finalDamagePct: null });
  if ("finalDamagePct" in half) failures.push("half: finalDamagePct key survived a null");
  if (half.damagePct !== 73) failures.push("half: damagePct did not survive alongside a null sibling");

  const none = readDamageReadings({ damagePct: null, finalDamagePct: null });
  if (Object.keys(none).length !== 0) failures.push(`none: ${JSON.stringify(none)}`);
  if (Object.keys(readDamageReadings(null)).length !== 0) failures.push("null input produced keys");
  if (Object.keys(readDamageReadings(undefined)).length !== 0) failures.push("undefined input produced keys");

  return { ok: failures.length === 0, failures };
}
