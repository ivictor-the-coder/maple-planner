# Maple Planner

Two static tools for MapleStory on Heroic (Reboot) worlds, built from one shared rules set.

| Path | What it is |
|---|---|
| `/` | **Maple Planner** — enter your gear, potentials, flames and stats; hover any slot for ranked advice on what to fix next |
| `/guide` | **Progression Guide** — gear ladders, star force tables, symbol costs, boss CP, training, HEXA. Filterable. |
| `/tools` | The content graph and the build scripts that render it |

No backend, no accounts, no tracking. Planner data is stored in your own browser via `localStorage`.

## Deploying to Vercel

It is a plain static site — no build step required.

1. Vercel → **Add New → Project** → import this repo
2. Framework preset: **Other**
3. Build command: leave empty. Output directory: leave empty (root)
4. Deploy

`index.html` is served at `/` and the guide at `/guide`.

## The content graph

`tools/guide-graph.json` is the source of truth. The guide is a render of it; the planner's recommendation engine uses the same rules.

Every section is a node:

```json
{
  "id": "symbols.income",
  "tab": "symbols",
  "title": "Symbol income after v.271",
  "tags": ["symbols", "income", "daily", "weekly"],
  "type": "table",
  "headers": ["Source", "Before", "After", "Per week"],
  "rows": [["Arcane River daily quest", "20", "40", "280"]],
  "notes": "optional",
  "source": "v.271 patch notes",
  "lastVerified": "2026-09-11",
  "patchVersion": "v.271"
}
```

`tags` are what a patch-notes update matches against, so only the affected sections get rewritten. A node whose `lastVerified` predates the current patch has simply not been re-checked — that is information, not a bug.

## Rebuilding

```bash
npm install
npm run build
```

That regenerates `guide/index.html` and `guide/guide.csv` from the graph. `tools/build-sheet.js` additionally renders a 14-tab `.xlsx` if you want a spreadsheet copy.

## Accuracy

Everything is current as of **v.271 — MapleStory x Frieren: Beyond Journey's End** (September 9, 2026). Each section on the guide carries its own source and verified date. Notable things v.271 changed:

- Arcane symbol income roughly doubled (daily 20 → 40, weekly 40 → 80 per area)
- EXP to level cut sharply for Lv. 210–259 (up to ~58% at 250–259)
- Star Catching removed; its success bonus is now permanent
- Bonus Stats can be reset for 3,000,000 mesos at Black Rebirth Flame rates
- Powerful / Eternal / Black Rebirth Flames no longer drop from bosses or elites
- A 3rd HEXA Common Node was added per class line

## Roadmap

- Drop / meso gear planner: max obtainable Item Drop % per slot on Heroic, with approximate cost
- Cube odds from real rate tables, so each slot can estimate cubes and mesos to reach a target
- Map mob-count data for picking training and event-grind maps
