# Maple Planner

A character planner and progression reference for MapleStory on Heroic (Reboot) worlds. Next.js, deployed on Vercel.

| Route | What it is |
|---|---|
| `/` | **Planner** — your gear, potentials, flames and stats. Hover any slot for ranked advice on what to fix next. |
| `/guide` | **Progression guide** — gear ladders, star force tables, symbol costs, boss CP, training, HEXA. |
| `/api/items` | Cached proxy to the community item database, for autocomplete and icons. |

Character data lives in your own browser. Nothing is uploaded.

## Running it

```bash
npm install
npm run dev
```

## Deploying

Vercel auto-detects Next.js — framework preset **Next.js**, everything else default. There is deliberately no `vercel.json`, so the dashboard settings govern.

## Getting gear in without typing it

Three routes, in decreasing order of effort saved:

1. **Import tooltip** — drop, paste (Cmd/Ctrl+V) or pick a screenshot of an in-game item tooltip. OCR runs in the browser via tesseract.js; the image is never uploaded. You confirm what was read before anything is written.
2. **Item autocomplete** — start typing a name. Picking a result fills the item level and sets the superior flag, and shows the real game sprite.
3. **Manual** — click any slot.

Star force can't be read from a screenshot (the stars are graphics, not text) and has no database source, so it's the one field you always enter yourself.

### Why there is no character import

Nexon's Open API covers **KMS, TMS and MSEA only** — its own docs say *"해당 API는 메이플스토리 한국의 데이터가 제공됩니다"* (this API provides MapleStory Korea data). There is no GMS equivalent, so a Heroic character can't be pulled automatically. `lib/import/` is structured so a Nexon adapter can be dropped in if that changes.

## The content graph

`data/guide-graph.json` is the source of truth for the guide, and the rules in `lib/rules.ts` follow it. Every section is a node:

```json
{
  "id": "symbols.income",
  "tab": "symbols",
  "title": "Symbol income after v.271",
  "tags": ["symbols", "income", "daily", "weekly"],
  "type": "table",
  "headers": ["Source", "Before", "After", "Per week"],
  "rows": [["Arcane River daily quest", "20", "40", "280"]],
  "source": "v.271 patch notes",
  "lastVerified": "2026-09-11",
  "patchVersion": "v.271"
}
```

`tags` are what a patch-notes update matches against, so only affected sections get rewritten. A node whose `lastVerified` predates the current patch simply hasn't been re-checked — that's information, not a bug.

## Layout

```
app/            routes: planner, guide, item API
components/     Planner, ItemSearch, ImportDialog
lib/rules.ts    recommendation engine — every piece of advice comes from here
lib/storage.ts  persistence behind an interface (local now, accounts later)
lib/import/     tooltip parser
data/           the content graph
tools/          graph → CSV / XLSX renderers, parser check
```

`tools/` is excluded from the app's typecheck. `tools/parse-check.ts` runs the tooltip parser against real tooltip text:

```bash
node --experimental-strip-types tools/parse-check.ts
```

## Accuracy

Current as of **v.271 — MapleStory x Frieren: Beyond Journey's End** (September 9, 2026). Each guide section carries its own source and verified date. What v.271 changed:

- Arcane symbol income roughly doubled (daily 20 → 40, weekly 40 → 80 per area)
- EXP to level cut sharply for Lv. 210–259 (up to ~58% at 250–259)
- Star Catching removed; its success bonus is now permanent
- Bonus Stats reset for 3,000,000 mesos at Black Rebirth Flame rates
- Powerful / Eternal / Black Rebirth Flames no longer drop from bosses or elites
- A 3rd HEXA Common Node per class line

## Roadmap

- Drop / meso gear: max obtainable Item Drop % per slot on Heroic, with approximate cost
- Real cube odds, so a slot can estimate cubes and mesos to reach a target
- Map mob counts for picking grind maps
- Accounts, so a character follows you between devices

## Branching

GitFlow. `main` is production, `dev` is integration, work happens on `feature/*` and merges down with `--no-ff`.
