// Recommendation engine. Everything the planner advises comes from here.
// Rules are current as of GMS v.271 (2026-09-09).

import type { RosterChar } from "./legion";

export type MainStat = "dex" | "str" | "int" | "luk";
export type Tier = "none" | "rare" | "epic" | "unique" | "legendary";
export type PotKind = "stat" | "atk" | "crit" | "no";

export interface Item {
  name: string;
  lvl: number;
  star: number;
  pot: Tier;
  sup: 0 | 1;
  p: string[];
  f: string[];
  /** From the item database, when the item was picked rather than typed. */
  itemId?: number;
  /** Boss-drop gear is flame advantaged: tier 4 minimum, up to tier 7. */
  bossDrop?: boolean;
  /** Icon cropped out of an imported screenshot, as a data URL. Used when the
   *  item database has no match — an imported item still shows its real sprite. */
  icon?: string;
  /** Item database subcategory, e.g. "Arrow Fletching" or "Shield". This is what
   *  decides star forceability in the secondary slot; the slot cannot. */
  sub?: string;
  // MapleStory has three independent enhancement systems and an item can opt
  // out of any combination of them — the tooltip spells it out, so read it
  // rather than inferring from the slot. A Glory Guard ring takes no stars
  // while every other ring does; a pocket item takes flames but no potential.
  /** "Star Force ... Can't Enhance". */
  noSf?: boolean;
  /** "... Bonus Stats Can't Enhance". */
  noFl?: boolean;
  /** "Potential : Can't Enhance". */
  noPot?: boolean;
}

export interface Stats {
  main: number;
  att: number;
  crit: number;
  critdmg: number;
  boss: number;
  ied: number;
  hp: number;
  arcane: number;
  starforce: number;
}

export interface Character {
  name: string;
  cls: string;
  main: MainStat;
  lvl: number;
  cp: number;
  stats: Stats;
  items: Record<string, Item>;
  /** Every character on the account, read from the Switch Character window. */
  roster?: RosterChar[];
}

export interface SlotDef {
  id: string;
  n: string;
  c: number;
  r: number;
  pot: PotKind;
  sf: boolean;
  fl: boolean;
}

export interface Rec {
  pri: 1 | 2 | 3 | 4;
  lv: "hi" | "mid" | "ok";
  t: string;
  w: string;
}

/* ---------- slots, laid out like the in-game equip window ---------- */
export const SLOTS: SlotDef[] = [
  { id: "ring1", n: "Ring 1", c: 1, r: 1, pot: "stat", sf: true, fl: false },
  { id: "ring2", n: "Ring 2", c: 1, r: 2, pot: "stat", sf: true, fl: false },
  { id: "ring3", n: "Ring 3", c: 1, r: 3, pot: "stat", sf: true, fl: false },
  { id: "ring4", n: "Ring 4", c: 1, r: 4, pot: "stat", sf: true, fl: false },
  { id: "pocket", n: "Pocket", c: 1, r: 5, pot: "stat", sf: false, fl: true },
  { id: "pendant1", n: "Pendant 1", c: 2, r: 2, pot: "stat", sf: true, fl: true },
  { id: "pendant2", n: "Pendant 2", c: 2, r: 3, pot: "stat", sf: true, fl: true },
  { id: "weapon", n: "Weapon", c: 2, r: 4, pot: "atk", sf: true, fl: true },
  { id: "belt", n: "Belt", c: 2, r: 5, pot: "stat", sf: true, fl: true },
  { id: "hat", n: "Hat", c: 3, r: 1, pot: "stat", sf: true, fl: true },
  { id: "face", n: "Face", c: 3, r: 2, pot: "stat", sf: true, fl: true },
  { id: "eye", n: "Eye", c: 3, r: 3, pot: "stat", sf: true, fl: true },
  { id: "top", n: "Top", c: 3, r: 4, pot: "stat", sf: true, fl: true },
  { id: "bottom", n: "Bottom", c: 3, r: 5, pot: "stat", sf: true, fl: true },
  { id: "shoes", n: "Shoes", c: 3, r: 6, pot: "stat", sf: true, fl: true },
  { id: "earring", n: "Earring", c: 4, r: 3, pot: "stat", sf: true, fl: true },
  { id: "shoulder", n: "Shoulder", c: 4, r: 4, pot: "stat", sf: true, fl: false },
  { id: "gloves", n: "Gloves", c: 4, r: 5, pot: "crit", sf: true, fl: true },
  { id: "cape", n: "Cape", c: 4, r: 6, pot: "stat", sf: true, fl: true },
  { id: "emblem", n: "Emblem", c: 5, r: 1, pot: "atk", sf: false, fl: false },
  { id: "badge", n: "Badge", c: 5, r: 2, pot: "no", sf: false, fl: false },
  { id: "medal", n: "Medal", c: 5, r: 3, pot: "no", sf: false, fl: false },
  { id: "secondary", n: "Secondary", c: 5, r: 4, pot: "atk", sf: true, fl: true },
  { id: "heart", n: "Heart", c: 5, r: 5, pot: "stat", sf: false, fl: false },
  { id: "android", n: "Android", c: 5, r: 6, pot: "no", sf: false, fl: false },
];

/* ---------- gear ladders ---------- */
type Rung = [string, number];
export const LADDER: Record<string, Rung[]> = {
  hat: [["CRA Root Abyss hat", 150], ["Arcane Umbra", 200], ["Eternal", 250]],
  top: [["CRA top", 150], ["Arcane Umbra overall", 200], ["Eternal", 250]],
  bottom: [["CRA bottom", 150], ["Arcane Umbra overall", 200], ["Eternal", 250]],
  gloves: [["Absolab", 160], ["Arcane Umbra", 200], ["Eternal", 250]],
  shoes: [["Absolab", 160], ["Arcane Umbra", 200], ["Eternal", 250]],
  cape: [["Absolab", 160], ["Arcane Umbra", 200], ["Eternal", 250]],
  shoulder: [["Royal Black Metal", 120], ["Absolab", 160], ["Arcane Umbra", 200]],
  weapon: [["Fafnir / CRA", 150], ["Absolab", 160], ["Arcane Umbra", 200], ["Genesis (liberated)", 200]],
  secondary: [["Class secondary", 0], ["Absolab-tier", 160], ["Astra secondary", 200]],
  belt: [["Reinforced Gollux", 140], ["Superior Gollux", 150], ["Dreamy Belt", 160]],
  pendant1: [["Dominator Pendant", 140], ["Superior Gollux", 150], ["Source of Suffering", 160]],
  pendant2: [["Daybreak Pendant", 140], ["Superior Gollux", 150], ["Source of Suffering", 160]],
  earring: [["Reinforced Gollux", 140], ["Superior Gollux", 150], ["Commanding Force Earring", 160]],
  ring1: [["Meister Ring", 140], ["Superior Gollux", 150], ["Guardian Angel Ring", 160]],
  ring2: [["Kanna's Treasure", 140], ["Superior Gollux", 150], ["Boss ring", 160]],
  ring3: [["Silver Blossom Ring", 110], ["Superior Gollux", 150], ["Boss ring", 160]],
  ring4: [["Noble Ifia's Ring", 110], ["Superior Gollux", 150], ["Boss ring", 160]],
  face: [["Condensed Power Crystal", 140], ["Papulatus Mark", 145], ["Sweetwater face", 160]],
  eye: [["Papulatus Mark", 145], ["Magic Eyepatch", 150], ["Berserked", 160]],
  heart: [["Lidium Heart", 0], ["Mechanical Heart", 120], ["Black Heart", 150]],
  pocket: [["Pink Bean pocket", 140], ["Cursed Spellbook", 150], ["Stone of Eternal Life", 160]],
  emblem: [["Gold Maple Leaf Emblem", 100]],
  badge: [["Crystal Ventus Badge", 130], ["Genesis Badge", 200]],
  android: [["Any android", 0]],
  medal: [["Best available", 0]],
};

export const SOURCE: Record<string, string> = {
  "Arcane Umbra": "Lucid / Will drops, or craft with Arcane River Droplets",
  Absolab: "Lotus coins (all but hat/shoulder) and Damien Stigma Coins (weapon/shoulder)",
  "Superior Gollux": "Belt + Earrings from Hell Gollux; Ring + Pendant from Lucia's shop",
  Eternal: "Kalos the Guardian (~85M CP)",
  "Source of Suffering": "Verus Hilla",
  "Commanding Force Earring": "Darknell",
  "Guardian Angel Ring": "Guardian Angel Slime (weekly)",
  "Papulatus Mark": "Chaos Papulatus",
  "Magic Eyepatch": "Damien",
  Berserked: "Lotus",
  "Genesis (liberated)": "Tenebris liberation questline",
  "CRA Root Abyss hat": "Chaos Vellum / Pierre / Von Bon / Crimson Queen",
  "CRA top": "Root Abyss weekly",
  "CRA bottom": "Root Abyss weekly",
  "Lidium Heart": "Free from the Frieren Lotus mission",
};

export const STAT_LABEL: Record<MainStat, string> = { dex: "DEX", str: "STR", int: "INT", luk: "LUK" };
const OFF: Record<MainStat, MainStat[]> = {
  dex: ["str", "int", "luk"],
  str: ["dex", "int", "luk"],
  int: ["str", "dex", "luk"],
  luk: ["str", "int", "dex"],
};
// Flat defense, MP and movement stats do nothing for damage.
const JUNK = /\b(max ?mp|mp|speed|jump|avoid|accuracy|knockback)\b/i;
const FLAT_DEF = /\bdef(ense)?\b/i;
// ...but Ignore Defense is a premium line and must never be mistaken for flat
// defense just because it contains the same word.
const IGNORE_DEF = /\bignore\s*(enemy\s*)?def(ense)?\b|\bied\b/i;
const TIER_NEXT: Record<Tier, Tier | null> = {
  none: "rare", rare: "epic", epic: "unique", unique: "legendary", legendary: null,
};
export const TIER_LABEL: Record<Tier, string> = {
  none: "None", rare: "Rare", epic: "Epic", unique: "Unique", legendary: "Legendary",
};

/* ---------- line analysis ---------- */
export function isDeadLine(txt: string, main: MainStat): boolean {
  if (!txt) return false;
  const t = txt.toLowerCase();
  if (IGNORE_DEF.test(t)) return false;
  if (JUNK.test(t) || FLAT_DEF.test(t)) return true;
  if (/all ?stat/.test(t)) return false;
  return OFF[main].some((o) => new RegExp(`\\b${o}\\b`).test(t));
}

export function statPct(txt: string, main: MainStat): number {
  if (!txt) return 0;
  const t = txt.toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  if (/all ?stat/.test(t)) return v;
  if (new RegExp(`\\b${main}\\b`).test(t)) return v;
  return 0;
}

// Most secondary weapons take no star force at all — arrow fletchings, charms,
// chess pieces, wristbands and the rest of the class-specific secondaries have no
// upgrade slots. Shields are the exception: they sit in the secondary slot but
// enhance like armour. A per-slot boolean cannot express that, so it lives here.
const SF_SECONDARY = /shield|katara|magic arrow/i;

export function canStarForce(slot: SlotDef, it: Item | null): boolean {
  if (!slot.sf || !it) return false;
  if (it.noSf) return false;
  if (slot.id === "secondary") return SF_SECONDARY.test(it.sub || it.name || "");
  return true;
}

export function sfCap(it: Item | null): number {
  if (!it) return 0;
  if (it.sup) return 15;
  const L = it.lvl || 0;
  if (L >= 138) return 30;
  if (L >= 129) return 20;
  if (L >= 118) return 15;
  if (L >= 108) return 10;
  if (L >= 95) return 8;
  return 5;
}
function sfTarget(it: Item): number {
  const cap = sfCap(it);
  return cap >= 20 ? 17 : cap;
}

/* ---------- per-slot advice ---------- */
export function advise(slot: SlotDef, ch: Character): Rec[] {
  const it = ch.items[slot.id] || null;
  const main = ch.main;
  const label = STAT_LABEL[main];
  const recs: Rec[] = [];
  const add = (pri: Rec["pri"], lv: Rec["lv"], t: string, w = "") => recs.push({ pri, lv, t, w });

  if (!it) {
    const lad = LADDER[slot.id];
    if (slot.pot === "no" && slot.id !== "emblem") {
      add(3, "mid", "Slot is empty.", "Free stat even with a basic item. No potential or star force here.");
    } else if (lad) {
      const [nm, lv] = lad[0];
      add(1, "hi", `Empty — put a ${nm} here.`, `${SOURCE[nm] || ""}${lv ? ` · Lv. ${lv}` : ""}`);
    } else {
      add(1, "hi", "Slot is empty.");
    }
    return recs;
  }

  if (slot.pot !== "no" && !it.noPot) {
    const tier: Tier = it.pot || "none";
    const lines = (it.p || []).filter(Boolean);
    const dead = lines.filter((l) => isDeadLine(l, main));
    const pct = lines.reduce((a, l) => a + statPct(l, main), 0);

    if (tier === "none") {
      add(1, "hi", "No potential. Unlock it, then cube to Epic.", "Free Mystical and Hard cubes from bossing and Monster Park.");
    } else if (tier !== "legendary") {
      const nx = TIER_LABEL[TIER_NEXT[tier]!];
      const how =
        tier === "rare" || tier === "epic"
          ? "Free Hard / Solid cubes from bossing. Cheap — do this before chasing extra lines."
          : "The expensive step. Save Bright cubes for it — they can double rank-up and let you pick a line.";
      add(1, "hi", `Tier up: ${TIER_LABEL[tier]} → ${nx}.`, how);
    }

    if (slot.pot === "stat") {
      if (dead.length) {
        add(2, "mid", `${dead.length} dead line${dead.length > 1 ? "s" : ""} — reroll toward ${label}%.`,
          `${dead.join(" · ")} does nothing for you.`);
      }
      if (tier === "legendary") {
        if (pct < 18) add(2, "mid", `Only ${pct}% ${label}. Aim for 18–21%.`, "A second good line is the next milestone.");
        else if (pct < 30) add(3, "ok", `${pct}% ${label} — solid. Endgame is 30%+.`, "Third line. Low priority until symbols and star force are done.");
        else add(4, "ok", `${pct}% ${label} — this slot is finished.`, "Leave it alone.");
      } else if (pct) {
        add(3, "mid", `Currently ${pct}% effective ${label}.`);
      }
    } else if (slot.pot === "atk") {
      // Plain "Damage +12%" is a strong line here too, not just boss/IED/ATT.
      const good = lines.filter((l) => /boss|ignore|\batt\b|attack|damage/i.test(l)).length;
      if (good < 2) add(2, "mid", "Aim for Boss Damage % / Ignore DEF % / ATT %.",
        "Highest damage-per-cube slot in the game. Target boss/boss/IED or att/boss/IED.");
      else add(3, "ok", `${good} damage lines — good.`,
        good >= 3 ? "This slot is finished." : "A third damage line is the next step.");
    } else if (slot.pot === "crit") {
      const cd = lines.filter((l) => /crit/i.test(l)).length;
      if (!cd) add(3, "mid", "Gloves are the only slot that rolls Critical Damage %.",
        `Run ${label}% until the rest of your gear is done, then switch.`);
      else add(3, "ok", `${cd} crit damage line${cd > 1 ? "s" : ""}.`);
    }
  } else if (it.noPot && slot.pot !== "no") {
    add(4, "ok", "This item cannot take potential.", "Its tooltip reads \u201cPotential : Can't Enhance\u201d.");
  }

  if (canStarForce(slot, it)) {
    const cap = sfCap(it), tgt = sfTarget(it), raw = it.star || 0;
    const cur = Math.min(raw, cap);
    if (raw > cap) {
      // The cap is derived from the item's level, so more stars than the cap
      // allows means the LEVEL is wrong, not the stars. Say which to check.
      add(1, "hi", `Reads ${raw} stars, but Lv ${it.lvl} caps at ${cap}.`,
        "One of the two was misread. Fix the required level first — the cap comes from it.");
    }
    if (it.sup && cur < 15) {
      add(1, "hi", `Superior gear — caps at 15 stars, currently ${cur}.`,
        "Expensive per star. Consider a non-superior replacement that goes to 30 instead.");
    } else if (cur === 0) {
      add(1, "hi", "0 stars. This is free power sitting on the floor.",
        "Stars 0–14 cannot boom. Push to 15 during a 5/10/15 event.");
    } else if (cur < tgt) {
      add(2, "mid", `${cur} → ${tgt} stars.`,
        `${cap >= 20 ? "Below 15 there is no boom risk. " : ""}Only tap past 15 during a 5/10/15 or 30%-off event.`);
    } else if (cap >= 20 && cur < 22) {
      add(3, "ok", `${cur} stars. Next milestone is 22.`, "Safeguard through 18, and only on event weekends.");
    } else {
      add(4, "ok", `${cur}/${cap} stars.`);
    }
  } else if (slot.sf && it) {
    add(4, "ok", "This item cannot be star forced.",
      slot.id === "secondary"
        ? "Only shields take star force in the secondary slot. Fletchings, charms, chess pieces and the rest have no upgrade slots."
        : "Its tooltip has no star force row.");
  }

  if (slot.fl && !it.noFl) {
    const fl = (it.f || []).filter(Boolean);
    const badf = fl.filter((l) => isDeadLine(l, main));
    const advantaged = it.bossDrop
      ? " This is boss-drop gear, so it is flame advantaged — tier 4 minimum and up to tier 7. Worth more rerolls than ordinary gear."
      : "";
    if (!fl.length) {
      add(2, "mid", "No flame. Roll one.",
        `Bonus stats reset for 3,000,000 mesos since v.271 — at Black Flame rates.${advantaged}`);
    } else if (badf.length) {
      add(1, "hi", `${badf.length} wasted flame line${badf.length > 1 ? "s" : ""} — reset it.`,
        `${badf.join(" · ")}. A reset is 3,000,000 mesos. The cheapest fix on the page.${advantaged}`);
    } else {
      add(4, "ok", "Flame is working.",
        `Best lines are All Stat %, then flat ${label}, then ATT.${advantaged}`);
    }
  } else if (slot.fl && it.noFl) {
    add(4, "ok", "This item cannot take flames.");
  } else if (slot.id === "shoulder" || slot.id.startsWith("ring")) {
    add(4, "ok", "This slot cannot take flames.");
  }

  const lad = LADDER[slot.id];
  if (lad) {
    let idx = -1;
    lad.forEach((rung, i) => { if (it.lvl >= rung[1]) idx = i; });
    if (idx > -1 && idx < lad.length - 1) {
      const [nm, lv] = lad[idx + 1];
      add(3, "ok", `Next tier: ${nm}${lv ? ` (Lv. ${lv})` : ""}.`,
        `${SOURCE[nm] || ""} — potential does not transfer, so do not over-cube what you will replace.`);
    }
  }

  return recs.sort((a, b) => a.pri - b.pri);
}

/* ---------- character-level advice ---------- */
export function charAdvice(ch: Character): Rec[] {
  const st = ch.stats;
  const label = STAT_LABEL[ch.main];
  const out: Rec[] = [];
  const add = (pri: Rec["pri"], lv: Rec["lv"], t: string, w = "") => out.push({ pri, lv, t, w });

  if (st.crit >= 100)
    add(1, "hi", `Crit rate is capped at ${st.crit}%.`,
      "Every point of crit rate hyper stat and every crit rate line is dead. Move it all to crit damage.");
  else if (st.crit >= 95)
    add(2, "mid", `Crit rate ${st.crit}% — nearly capped.`, "Find the last few points cheaply, then stop investing.");

  if (st.critdmg && st.critdmg < 60)
    add(2, "mid", `Crit damage ${st.critdmg}% is low.`, "Hyper stat, gloves potential, link skills and legion. Target 60%+.");
  if (st.ied && st.ied < 95)
    add(2, "mid", `IED ${st.ied}% — push toward 95%.`, "Arcane bosses sit at 300% defense, Grandis at 380%.");
  if (st.boss && st.boss < 250)
    add(3, "mid", `Boss damage ${st.boss}%.`, "Hyper stat, weapon/secondary/emblem lines, familiars. Endgame is 300%+.");
  if (st.hp && st.hp < 60000)
    add(2, "mid", `HP ${st.hp.toLocaleString()} is thin for Lucid/Will.`,
      "Max HP hyper stat, Decent Hyper Body on your bottom, Demon Avenger link.");

  if (st.arcane) {
    const lv = Math.max(0, Math.round((st.arcane - 120) / 10));
    const left = 120 - lv;
    if (left > 0)
      add(1, "hi", `${left} Arcane symbol levels left (+${(left * 100).toLocaleString()} ${label}).`,
        `Arcane Power ${st.arcane} of 1,320. Symbol stat is flat and is not multiplied by your %stat — which is why %lines are worth less than they look right now.`);
  }
  if (st.starforce && st.starforce < 260)
    add(2, "mid", `Total star force ${st.starforce}.`,
      "Everything at 17 stars is roughly 290+. One of the two biggest levers you have.");

  return out.sort((a, b) => a.pri - b.pri);
}

/* ---------- starting points ---------- */
export function emptyCharacter(): Character {
  return {
    name: "Unnamed", cls: "Bow Master", main: "dex", lvl: 200, cp: 0,
    stats: { main: 0, att: 0, crit: 0, critdmg: 0, boss: 0, ied: 0, hp: 0, arcane: 0, starforce: 0 },
    items: {},
  };
}

export function exampleCharacter(): Character {
  return {
    name: "Archerroni", cls: "Bow Master", main: "dex", lvl: 243, cp: 4900000,
    stats: { main: 19051, att: 1452, crit: 98, critdmg: 41.5, boss: 154, ied: 92.67, hp: 44190, arcane: 910, starforce: 188 },
    items: {
      hat: { name: "Royal Ranger Beret", lvl: 150, star: 16, pot: "unique", sup: 0,
        p: ["DEX +9%", "LUK +6%", "All Stats +3%"], f: ["DEX +12", "STR +20", "INT +32"] },
      top: { name: "Eagle Eye Ranger Cowl", lvl: 150, star: 16, pot: "epic", sup: 0,
        p: ["DEX +6%", "STR +12", "Max HP +3%"], f: ["DEX +28", "All Stats +6%", "LUK +12"] },
      bottom: { name: "Trixter Ranger Pants", lvl: 150, star: 14, pot: "epic", sup: 0,
        p: ["DEX +6%", "All Stats +3%", "DEF +120"], f: ["DEX +28", "STR +28", "All Stats +4%"] },
      cape: { name: "Tyrant Charon Cloak", lvl: 150, star: 0, pot: "unique", sup: 1,
        p: ["DEX +9%", "STR +6%", "DEX +6%"], f: ["STR +24", "INT +24"] },
      shoulder: { name: "Royal Black Metal Shoulder", lvl: 120, star: 12, pot: "legendary", sup: 0,
        p: ["All Stats +9%", "DEX +9%", "DEX +9%"], f: [] },
    },
  };
}
