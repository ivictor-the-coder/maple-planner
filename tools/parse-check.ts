// Sanity-check the tooltip parser against real tooltip text.
// node --experimental-strip-types tools/parse-check.ts
import { parseTooltip } from "../lib/import/tooltip.ts";

const BERET = `Royal Ranger Beret
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
Check the enhancement details by using the Interact/Harvest key.
Potential : Unique
DEX: +9%
LUK: +6%
All Stats +3%`;

const CLOAK = `Tyrant Charon Cloak
Untradable
Armor
Cape
Required Level Lv. 135 (150 - 15)
STR +74 (50 +24)
DEX +50
INT +74 (50 +24)
LUK +50
Attack Power +34 (30 +4)
Magic ATT +30
Defense +150
Speed +3 (0 +3)
Potential : Unique
DEX: +9%
STR: +6%
DEX: +6%`;

const SHOULDER = `Royal Black Metal Shoulder
Untradable
Shoulder
Required Level Lv. 120
Set Effect Boss Accessory Set
STR +41 (10 +31)
DEX +41 (10 +31)
Max HP +180 (0 +180)
Attack Power +6
Bonus Stats Can't Enhance
Potential : Legendary
All Stats +9%
DEX: +9%
DEX: +9%`;

for (const [label, text] of [["Beret", BERET], ["Cloak", CLOAK], ["Shoulder", SHOULDER]] as const) {
  const r = parseTooltip(text);
  console.log(`\n=== ${label} ===`);
  console.log("name:      ", JSON.stringify(r.item.name));
  console.log("slot guess:", r.slotGuess);
  console.log("level:     ", r.item.lvl);
  console.log("tier:      ", r.item.pot, "| superior:", r.item.sup);
  console.log("potential: ", r.item.p.filter(Boolean));
  console.log("flames:    ", r.item.f.filter(Boolean));
}
