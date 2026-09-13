// Turns the raw fields of a vision model's answer into planner values.
//
// WHY THIS IS NOT STILL INSIDE app/api/import/route.ts. It was, and it could
// not be run: route.ts imports next/server and the entitlement store, it is a
// Next route module whose exported members are validated at build time, and
// the only way to reach it is an HTTP request that spends real vision tokens.
// So the coercion layer — the part that decides whether a model's answer
// becomes a number on somebody's character sheet — moved to where a node
// script can call it with fixed inputs. `__selfTest()` at the bottom is that
// call. route.ts imports these and its behaviour is unchanged: `num`, `str`
// and the stat-window field list are the same code, moved verbatim.

import { readDamageReadings } from "./damageReadings";
import { readArcaneLevelPatch, type ArcaneLevelPatch } from "./symbolLevels";

/** What the model is allowed to say about the CHARACTER STAT window. */
export interface VisionStats {
  name?: string | null; class?: string | null; level?: number | null;
  combatPower?: number | null; mainStat?: number | null; attack?: number | null;
  critRate?: number | null; critDamage?: number | null; bossDamage?: number | null;
  ignoreDefense?: number | null; maxHp?: number | null; arcanePower?: number | null;
  starForce?: number | null;
  // `unknown` rather than `number | null` on purpose: these two are the only
  // fields whose raw value is inspected by a parser that has to tell a number
  // from a sentence, and typing them as numbers here would be a claim about
  // what arrives that the `object`/`none` format rungs cannot keep.
  damagePct?: unknown; finalDamagePct?: unknown;
}

export const num = (v: unknown, max: number): number | undefined => {
  // Strict json_schema makes every optional field explicitly null, and
  // Number(null) is 0 — which would quietly write a zeroed stat window over a
  // real one. Reject null before it can become a number.
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "string" ? parseFloat(v.replace(/[,%\s]/g, "")) : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined;
};

export const str = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s || undefined;
};

/**
 * The stat window, tidied into the keys the import dialog patches onto a
 * character. Every field is independently optional: a window with the cursor
 * over one line still imports the other twelve.
 *
 * Returns undefined when nothing at all was readable, which is how the route
 * tells "no stat window in this screenshot" from "a stat window I read badly".
 */
export function tidyStatWindow(s: VisionStats | null | undefined) {
  if (!s || typeof s !== "object") return undefined;
  const out = {
    name: str(s.name),
    cls: str(s.class),
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
    // Spread, not two more `num()` calls. num() accepts 0 and would happily
    // record "the model could not see this line" as a measured zero, which is
    // the one outcome the DamageReadings contract exists to prevent. A field
    // that could not be read is ABSENT from this object, so it is absent from
    // the JSON the dialog receives, which is the same shape the character
    // sheet already understands. Keys match lib/rules.ts DamageReadings exactly
    // so nothing renames them on the way in.
    ...readDamageReadings(s),
  };
  return Object.values(out).some((v) => v !== undefined && v !== "") ? out : undefined;
}

/** Everything tidyStatWindow() can produce, with every field optional — the
 *  shape, named, so the two-window version below can be annotated rather than
 *  inferred through a spread of a possibly-undefined value. */
export type StatWindowPatch = NonNullable<ReturnType<typeof tidyStatWindow>>;

/** The stat window's fields plus the Symbol window's six levels, flattened into
 *  the one patch object the import dialog carries. */
export type CharacterWindowsPatch = Partial<StatWindowPatch> & ArcaneLevelPatch;

/**
 * Both character windows, merged into the single patch the import dialog knows
 * how to carry.
 *
 * SEPARATE FROM tidyStatWindow() ON PURPOSE, rather than a seventh argument to
 * it: the Symbol window is a DIFFERENT window and can be screenshotted on its
 * own. Folding the levels into tidyStatWindow would make "was a stat window
 * visible?" answer yes for a screenshot that never showed one — and that
 * question is exactly what the route uses to decide whether the image had
 * anything in it at all.
 *
 * Returns undefined only when NEITHER window yielded anything, which is how the
 * route still tells "no character windows in this shot" from "a window I read
 * badly".
 */
export function tidyCharacterWindows(
  s: VisionStats | null | undefined,
  rawSymbols: unknown,
): CharacterWindowsPatch | undefined {
  const stats = tidyStatWindow(s);
  const levels = readArcaneLevelPatch(rawSymbols);
  if (!stats && Object.keys(levels).length === 0) return undefined;
  return { ...stats, ...levels };
}

export function __selfTest(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

  // The observed character, in the strings the game prints (lib/damage.ts:465,
  // DAMAGE_RANGE_VALIDATION). Commas and percent signs included, because the
  // weaker rungs of the format ladder deliver exactly that.
  const observed = tidyStatWindow({
    name: "Archerroni", class: "Bow Master", level: 245,
    combatPower: 5399368, mainStat: 20790, attack: 1497,
    critRate: 100, critDamage: 85, bossDamage: 159, ignoreDefense: 94,
    maxHp: 41000, arcanePower: 1070, starForce: 188,
    damagePct: "73.00%", finalDamagePct: "115.79%",
  });
  if (!observed) failures.push("observed: tidyStatWindow returned undefined");
  else {
    if (observed.damagePct !== 73) failures.push(`observed: damagePct ${String(observed.damagePct)} !== 73`);
    if (observed.finalDamagePct !== 115.79) failures.push(`observed: finalDamagePct ${String(observed.finalDamagePct)} !== 115.79`);
    if (observed.main !== 20790 || observed.att !== 1497 || observed.cp !== 5399368)
      failures.push("observed: an existing stat field changed");
  }

  // A window the model read fine except for those two lines. The nine existing
  // figures must survive, and the two keys must not exist at all — not exist
  // holding undefined, which is what `"damagePct" in stats` would still see.
  const noReadings = tidyStatWindow({
    name: "Archerroni", class: "Bow Master", level: 245, mainStat: 20790,
    attack: 1497, damagePct: null, finalDamagePct: null,
  });
  if (!noReadings) failures.push("noReadings: tidyStatWindow returned undefined");
  else {
    if (has(noReadings, "damagePct") || has(noReadings, "finalDamagePct"))
      failures.push("noReadings: a reading key exists after a null");
    if (noReadings.main !== 20790 || noReadings.att !== 1497)
      failures.push("noReadings: existing stats did not survive");
  }

  // Garbage in the two new fields must not take the rest of the window with it.
  const garbage = tidyStatWindow({
    mainStat: 20790, damagePct: "I cannot read that line", finalDamagePct: "about 116",
  });
  if (!garbage) failures.push("garbage: tidyStatWindow returned undefined");
  else {
    if (has(garbage, "damagePct") || has(garbage, "finalDamagePct"))
      failures.push("garbage: a reading key exists after prose");
    if (garbage.main !== 20790) failures.push("garbage: mainStat did not survive");
  }

  // No stat window at all stays no stat window: the two new fields must not be
  // able to make an empty object look like a reading.
  if (tidyStatWindow(null) !== undefined) failures.push("null window did not return undefined");
  if (tidyStatWindow({}) !== undefined) failures.push("empty window did not return undefined");
  if (tidyStatWindow({ damagePct: 0, finalDamagePct: 0 }) !== undefined)
    failures.push("a window of zeroed readings was treated as a stat window");

  /* ---- the two windows together ---- */

  // A Symbol window on its own is a complete import. Before this existed the
  // route answered "found no item tooltip, stat window or character list" and
  // charged the visitor for a screenshot it had in fact read.
  const symOnly = tidyCharacterWindows(null, {
    vj: 20, chuchu: 20, lach: 20, arcana: 20, morass: 20, esfera: 15,
  });
  if (!symOnly) failures.push("symbols only: returned undefined");
  else {
    if (symOnly.symVj !== 20 || symOnly.symEsfera !== 15)
      failures.push(`symbols only: ${JSON.stringify(symOnly)}`);
    if (has(symOnly, "main")) failures.push("symbols only: invented a stat-window key");
  }

  // Both windows in one shot: neither displaces the other.
  const both2 = tidyCharacterWindows(
    { mainStat: 20790, arcanePower: 1070 },
    { vj: 20, esfera: null },
  );
  if (!both2) failures.push("both windows: returned undefined");
  else {
    if (both2.main !== 20790 || both2.arcane !== 1070 || both2.symVj !== 20)
      failures.push(`both windows: ${JSON.stringify(both2)}`);
    if (has(both2, "symEsfera")) failures.push("both windows: a level survived a null");
  }

  // Neither window is still neither — a "symbols" key full of nulls must not
  // make an empty screenshot look like a reading.
  if (tidyCharacterWindows(null, null) !== undefined)
    failures.push("neither window did not return undefined");
  if (tidyCharacterWindows(null, { vj: null, chuchu: null }) !== undefined)
    failures.push("a symbols object of nulls was treated as a window");
  if (tidyCharacterWindows(null, { vj: 0 }) !== undefined)
    failures.push("a model-side 0 was treated as a symbol level");

  return { ok: failures.length === 0, failures };
}
