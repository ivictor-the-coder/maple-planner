// Sanity-check the tooltip parser against real tooltip text.
// node --experimental-strip-types tools/parse-check.ts
//
// These are transcriptions of actual in-game tooltips. They test the parser,
// not the OCR — if a fixture passes here but the app fails on a screenshot of
// the same item, the fault is in reading the image, not in parsing the text.
import { parseTooltip } from "../lib/import/tooltip.ts";

const FIXTURES: Array<[string, string, Record<string, unknown>]> = [
  ["Royal Ranger Beret", `Royal Ranger Beret
Untradable
Combat Power Increase
Currently Equipped
Armor
Hat
Required Job Bowman
Required Level Lv. 150
Set Effect Root Abyss Set (Bowman)
STR +111 (40 +51 +20)
DEX +103 (40 +51 +12)
INT +32 (0 +32)
All Stats +5% (0% +5%)
Max HP +615 (360 +255)
Max MP +360
Attack Power +11 (2 +9)
Magic ATT +9 (0 +9)
Defense +700 (300 +368 +32)
Enemy DEF Ignored +10%
Potential : Unique
DEX: +9%
LUK: +6%
All Stats +3%`, { slot: "hat", lvl: 150, pot: "unique" }],

  ["Eagle Eye Ranger Cowl", `Eagle Eye Ranger Cowl
Untradable
Currently Equipped
Armor
Top
Required Job Bowman
Required Level Lv. 150
Set Effect Root Abyss Set (Bowman)
STR +97 (30 +51 +16)
DEX +109 (30 +51 +28)
LUK +12 (0 +12)
All Stats +6% (0% +6%)
Max HP +255 (0 +255)
Attack Power +11 (2 +9)
Magic ATT +12 (0 +9 +3)
Defense +306 (135 +171)
Enemy DEF Ignored +5%
Potential : Epic
DEX: +6%
STR: +12
Max HP +3%`, { slot: "top", lvl: 150, pot: "epic" }],

  ["Trixter Ranger Pants", `Trixter Ranger Pants
Untradable
Currently Equipped
Armor
Bottom
Required Job Bowman
Required Level Lv. 150
Set Effect Root Abyss Set (Bowman)
STR +95 (30 +37 +28)
DEX +95 (30 +37 +28)
All Stats +4% (0% +4%)
Max HP +230 (0 +230)
Max MP +2250 (0 +2250)
Attack Power +2
Defense +277 (135 +142)
Jump +4 (0 +4)
Enemy DEF Ignored +5%
Potential : Epic
DEX: +6%
All Stats +3%
DEF +120`, { slot: "bottom", lvl: 150, pot: "epic" }],

  ["Tyrant Charon Cloak", `Tyrant Charon Cloak
Untradable
Currently Equipped
Armor
Cape
Required Job Bowman
Required Level Lv. 135 (150 - 15)
STR +74 (50 +24)
DEX +50
INT +74 (50 +24)
LUK +50
Attack Power +34 (30 +4)
Magic ATT +30
Defense +150
Speed +3 (0 +3)
Allows you to gain even higher stats with successful item enhancement.
Potential : Unique
DEX: +9%
STR: +6%
DEX: +6%`, { slot: "cape", lvl: 135, pot: "unique", sup: 1 }],

  ["Pensalir Sentinel Gloves", `Pensalir Sentinel Gloves
Untradable
Currently Equipped
Armor
Gloves
Required Job Bowman
Required Level Lv. 140
Set Effect 8th Bowman Set
STR +57 (10 +31 +16)
DEX +102 (11 +31 +60)
INT +12 (0 +12)
Max HP +200
Attack Power +6 (2 +4)
Defense +97 (50 +47)
Potential : Epic
DEX: +6%
DEF +120
Max HP +120`, { slot: "gloves", lvl: 140, pot: "epic" }],

  ["Royal Black Metal Shoulder", `Royal Black Metal Shoulder
Untradable
Shoulder
Required Job Shared
Required Level Lv. 120
Set Effect Boss Accessory Set
STR +41 (10 +31)
DEX +41 (10 +31)
INT +41 (10 +31)
LUK +41 (10 +31)
Max HP +180 (0 +180)
Attack Power +6
Magic ATT +6
Defense +188 (100 +88)
Bonus Stats Can't Enhance
Potential : Legendary
All Stats +9%
DEX: +9%
DEX: +9%`, { slot: "shoulder", lvl: 120, pot: "legendary", flames: 0 }],
];

let pass = 0, fail = 0;
for (const [label, text, want] of FIXTURES) {
  const r = parseTooltip(text);
  const got = { slot: r.slotGuess, lvl: r.item.lvl, pot: r.item.pot, sup: r.item.sup, flames: r.item.f.filter(Boolean).length };
  const bad: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    if ((got as Record<string, unknown>)[k] !== v) bad.push(`${k}: want ${v}, got ${(got as Record<string, unknown>)[k]}`);
  }
  if (r.item.name !== label) bad.push(`name: want "${label}", got "${r.item.name}"`);
  if (bad.length) { fail++; console.log(`FAIL  ${label}\n      ${bad.join("\n      ")}`); }
  else { pass++; console.log(`ok    ${label}  ${got.slot} Lv.${got.lvl} ${got.pot}  pot[${r.item.p.filter(Boolean).join(", ")}]  flame[${r.item.f.filter(Boolean).join(", ")}]`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
