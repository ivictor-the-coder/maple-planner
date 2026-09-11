// Legion board + link skill advice for a whole account roster.
//
// Two ladders drive everything here, and they are NOT the same ladder — which is
// exactly what makes "what should I level next" non-obvious:
//
//   Legion rank   B 60 · A 100 · S 140 · SS 200 · SSS 250
//   Link skill    transferable at 70 · level 2 at 120 · level 3 at 210
//
// So a character parked at 160 is 40 levels from SS but 50 from link 3, while one
// at 195 is five levels from a whole rank. Sorting by "levels until the next
// payoff" is the entire point of this file: it turns a roster into an order.

export interface RosterChar {
  name: string;
  cls: string;
  lvl: number;
  /** The one marked CURRENT in the Switch Character window. */
  current?: boolean;
}

/** Fold one page of characters into an existing roster.
 *
 *  The Switch Character window is paginated, so a full account arrives across
 *  several screenshots and often across several separate imports - replacing
 *  would mean only ever keeping the last page you happened to upload. Matching
 *  is by name, which is the one field that is stable: levels go up, and the
 *  CURRENT badge moves whenever you switch characters. */
export function mergeRoster(prev: RosterChar[], next: RosterChar[]): RosterChar[] {
  const by = new Map(prev.map((c) => [c.name.toLowerCase(), c]));
  for (const c of next) {
    const k = c.name.toLowerCase();
    const had = by.get(k);
    // A character never loses levels, so on a disagreement the higher number is
    // the real one - a misread digit drops a level far more often than it
    // invents one. Everything else on the newer read wins.
    by.set(k, had ? { ...had, ...c, lvl: Math.max(had.lvl, c.lvl) } : c);
  }

  // Exactly one character is ever CURRENT, but the badge follows whoever you
  // were playing when each page was captured - merging pages shot at different
  // times otherwise leaves two. A page that carries the badge is the newer
  // truth, so it clears the badge everywhere else.
  const moved = new Set(next.filter((c) => c.current).map((c) => c.name.toLowerCase()));
  const out = [...by.values()].map((c) =>
    moved.size ? { ...c, current: moved.has(c.name.toLowerCase()) } : c
  );
  return out.sort((a, b) => b.lvl - a.lvl);
}

export type Rank = "-" | "B" | "A" | "S" | "SS" | "SSS";

/** Descending, so the first match wins. */
const RANK_AT: Array<[number, Rank]> = [
  [250, "SSS"],
  [200, "SS"],
  [140, "S"],
  [100, "A"],
  [60, "B"],
];

export const BOARD_MIN = 60;
export const LINK_TRANSFER = 70;

export function rankOf(lvl: number): Rank {
  for (const [at, r] of RANK_AT) if (lvl >= at) return r;
  return "-";
}

/** The next rank this character can reach, or null once it is SSS. */
export function nextRank(lvl: number): { rank: Rank; at: number; need: number } | null {
  for (let i = RANK_AT.length - 1; i >= 0; i--) {
    const [at, rank] = RANK_AT[i];
    if (lvl < at) return { rank, at, need: at - lvl };
  }
  return null;
}

/** 0 = not transferable yet. Otherwise the link skill level this character gives. */
export function linkLevel(lvl: number): 0 | 1 | 2 | 3 {
  if (lvl >= 210) return 3;
  if (lvl >= 120) return 2;
  if (lvl >= LINK_TRANSFER) return 1;
  return 0;
}

export function nextLink(lvl: number): { lv: 1 | 2 | 3; at: number; need: number } | null {
  if (lvl < LINK_TRANSFER) return { lv: 1, at: LINK_TRANSFER, need: LINK_TRANSFER - lvl };
  if (lvl < 120) return { lv: 2, at: 120, need: 120 - lvl };
  if (lvl < 210) return { lv: 3, at: 210, need: 210 - lvl };
  return null;
}

// Link skill effects, only where verified. A class missing from this table still
// gets the level ladder above — an unlabelled link is better than an invented one.
export const LINK_EFFECT: Record<string, string> = {
  "demon avenger": "Fury Unleashed - flat damage %. One of the strongest links in the game.",
  luminous: "Permeate - Ignore DEF %. Top tier for bossing.",
  phantom: "Phantom Instinct - critical rate %.",
  "demon slayer": "Defense - boss damage %.",
  mercedes: "Elven Blessing - EXP %. Level this one early; it pays for the others.",
  "dawn warrior": "Cygnus Blessing - ATT. Stacks with every other Cygnus Knight you own.",
  "blaze wizard": "Cygnus Blessing - ATT. Stacks with every other Cygnus Knight you own.",
  "wind archer": "Cygnus Blessing - ATT. Stacks with every other Cygnus Knight you own.",
  "night walker": "Cygnus Blessing - ATT. Stacks with every other Cygnus Knight you own.",
  thunder: "Cygnus Blessing - ATT. Stacks with every other Cygnus Knight you own.",
};

export function linkEffect(cls: string): string | null {
  return LINK_EFFECT[(cls || "").toLowerCase().trim()] ?? null;
}

export interface RosterRec {
  /** Lower sorts first. This is literally "levels of grinding until a payoff". */
  cost: number;
  who: string;
  t: string;
  w: string;
  lv: "hi" | "mid" | "ok";
}

export interface RosterSummary {
  onBoard: number;
  offBoard: number;
  totalLevel: number;
  counts: Record<Rank, number>;
  recs: RosterRec[];
}

export function rosterAdvice(chars: RosterChar[]): RosterSummary {
  const counts: Record<Rank, number> = { "-": 0, B: 0, A: 0, S: 0, SS: 0, SSS: 0 };
  let onBoard = 0;
  let totalLevel = 0;
  const recs: RosterRec[] = [];

  for (const c of chars) {
    const r = rankOf(c.lvl);
    counts[r]++;
    if (c.lvl >= BOARD_MIN) {
      onBoard++;
      totalLevel += c.lvl;
    }

    const nr = nextRank(c.lvl);
    const nl = nextLink(c.lvl);
    const effect = linkEffect(c.cls);

    if (c.lvl < BOARD_MIN) {
      recs.push({
        cost: BOARD_MIN - c.lvl,
        who: `${c.name} (${c.cls})`,
        lv: "hi",
        t: `Lv ${c.lvl} - ${BOARD_MIN - c.lvl} levels off the Legion board entirely.`,
        w: `Nothing below Lv ${BOARD_MIN} contributes. This is the cheapest power on the account.`,
      });
      continue;
    }

    // Whichever payoff is closer is the one worth naming first.
    if (nr && (!nl || nr.need <= nl.need)) {
      recs.push({
        cost: nr.need,
        who: `${c.name} (${c.cls})`,
        lv: nr.need <= 15 ? "hi" : nr.need <= 45 ? "mid" : "ok",
        t: `Lv ${c.lvl} -> ${nr.at} for rank ${nr.rank}. ${nr.need} levels.`,
        w: nl
          ? `Link skill ${nl.lv} also waits at Lv ${nl.at}.${effect ? ` ${effect}` : ""}`
          : `Link skill is already maxed.${effect ? ` ${effect}` : ""}`,
      });
    } else if (nl) {
      recs.push({
        cost: nl.need,
        who: `${c.name} (${c.cls})`,
        lv: nl.need <= 15 ? "hi" : nl.need <= 45 ? "mid" : "ok",
        t: `Lv ${c.lvl} -> ${nl.at} for link skill level ${nl.lv}. ${nl.need} levels.`,
        w: nr
          ? `Rank ${nr.rank} is further out at Lv ${nr.at}.${effect ? ` ${effect}` : ""}`
          : `Already rank SSS.${effect ? ` ${effect}` : ""}`,
      });
    } else {
      recs.push({
        cost: 9999,
        who: `${c.name} (${c.cls})`,
        lv: "ok",
        t: `Lv ${c.lvl} - rank SSS and link 3. Finished.`,
        w: effect ?? "",
      });
    }
  }

  recs.sort((a, b) => a.cost - b.cost);
  return {
    onBoard,
    offBoard: chars.length - onBoard,
    totalLevel,
    counts,
    recs,
  };
}
