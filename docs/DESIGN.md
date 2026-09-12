# MaplePlanner — Visual Design and Information Architecture

Status: specification. Not applied. One integrator applies it.

Target: `app/globals.css`, `app/layout.tsx`, `app/guide/page.tsx`,
`components/Planner.tsx`, `components/Roster.tsx`, `components/ImportDialog.tsx`,
`components/ItemSearch.tsx`.

Audited against the tree at 2026-09-11 (`globals.css` 308 lines, `Planner.tsx`
448 lines). Line numbers below are from that state; if another builder has moved
them, match on the selector, not the number.

Every number in this document is either measured from the shipped CSS box model
or computed. Where a number is an assumption, it is marked **[assumption]** and
repeated in §12. The live deployment could not be opened from this session
(navigation denied), so every browser-rendered measurement is derived from the
stylesheet rather than observed — §12 says which.

---

## 0. The diagnosis, in one paragraph

The product's job is to answer *"which single upgrade buys me the most damage per
meso?"*. The current first screen answers a different question: *"what does my
equip window look like?"*. The three things with the most visual weight — the
24px gold Combat Power figure, the 62px × 6-row equip doll, and the card
chrome — are all **static**: none of them changes when the planner computes
anything. The one element that does change, the advice rail, is in the third
grid column, has no numeric column, and at ≤1240px is pushed onto a second row
where its first line lands at y≈677px. So the tool's output is simultaneously the
least prominent thing on screen and the only thing on screen that is actually a
result. Everything below follows from fixing that inversion: a **ranked numeric
table is the page**, and the doll is a filter control for it.

---

## 1. Type scale

### 1.1 The problem, measured

`app/globals.css` carries **36 `font-size` declarations** (35 real plus one
`font-size: inherit` on `button`). `app/` and `components/` carry **35 more as
inline `style={{ fontSize }}`**. 71 sites, **24 distinct values**, no system.

`rem` here resolves against the root, which has no `font-size` — so `1rem` =
16px, and `body { font-size: 14px }` does not change it. At that root:

| value | px | value | px | value | px |
|---|---|---|---|---|---|
| `.48rem` | **7.68** | `.7rem` | **11.2** | `.8rem` | 12.8 |
| `.52rem` | **8.32** | `.72rem` | **11.52** | `.81rem` | 12.96 |
| `.53rem` | **8.48** | `.74rem` | **11.84** | `.84rem` | 13.44 |
| `.54rem` | **8.64** | `.745rem` | **11.92** | `.86rem` | 13.76 |
| `.55rem` | **8.8** | `.76rem` | 12.16 | `1.02rem` | 16.32 |
| `.58rem` | **9.28** | `.77rem` | 12.32 | `1.06rem` | 16.96 |
| `.6rem` | **9.6** | `.78rem` | 12.48 | `1.22rem` | 19.52 |
| `.66rem` | **10.56** | `.79rem` | 12.64 | `1.5rem` | 24 |

**Eleven of the twenty-four distinct sizes render below 11px.** The smallest,
`.slot-label` at 7.68px, is a slot name. The panel titles (`.card > h2`) are
9.6px in `--ink-3` — 9.6px at 3.40:1. That is not a small label; that is a label
that cannot be read.

### 1.2 The tokens

Add to `:root` in `app/globals.css`. Seven sizes, two line-heights, nothing else.

```css
:root {
  /* Type scale. 11px is a hard floor — nothing below it ships.
     Sized in px deliberately: every existing value is a rem multiple of a
     16px root that no user setting moves, so px is what already shipped,
     written honestly. The rem column below is the drop-in if the app later
     takes a pass at honouring the browser's default-font-size setting. */
  --fs-micro: 11px;    /* .6875rem  — mono labels, column heads, tags */
  --fs-sm:    12.5px;  /* .78125rem — secondary prose, dense rows */
  --fs-base:  14px;    /* .875rem   — body, table cells, form inputs */
  --fs-md:    16px;    /* 1rem      — item names, dialog titles, wordmark */
  --fs-lg:    20px;    /* 1.25rem   — character name, section leads */
  --fs-num:   22px;    /* 1.375rem  — the GAIN figure, and only that */
  --fs-hero:  34px;    /* 2.125rem  — the one answer sentence per page */

  --lh-tight: 1.2;     /* numerals, headlines, anything single-line */
  --lh-body:  1.45;    /* prose, wrapping cells */
}
```

Then `body { font-size: var(--fs-base); line-height: var(--lh-body); }`
(replacing `14px` / `1.5`).

**Rule for the integration PR:** a literal `font-size` value anywhere in
`app/`, `components/` or `globals.css` — CSS or inline — is a failing diff. The
only permitted values are `var(--fs-*)` and the existing `font-size: inherit` on
`button`.

### 1.3 The decision rule for anything not in the table

Two rules resolve every remaining case without judgement:

1. **Anything that was below 12px becomes `--fs-micro` if it is a label
   (uppercase, tracked, mono, non-sentence), and `--fs-sm` if it is a
   sentence.** A label is scanned; a sentence is read; a sentence at 11px is a
   sentence you decided not to have read.
2. **Anything that carries a numeral a user will compare gets `.num`.**

### 1.4 Mapping — `app/globals.css`

| line | selector | was | becomes |
|---|---|---|---|
| 34 | `body` | `14px` | `--fs-base` |
| 57 | `.brand` | `1.06rem` | `--fs-md` |
| 60 | `.navlink` | `.78rem` | `--fs-sm` |
| 80 | `.card > h2` | `.6rem` | `--fs-micro` |
| 91 | `.nameInput` | `1.22rem` | `--fs-lg` |
| 95 | `.who .sub` | `.74rem` | `--fs-sm` |
| 107 | `.cp .l` | `.55rem` | *deleted with the block — §6a* |
| 110 | `.cp .v` | `1.5rem` | *deleted with the block — §6a* |
| 114 | `.statgroup` | `.55rem` | `--fs-micro` |
| 116 | `.stat` | `.79rem` | `--fs-sm` |
| 121 | `.stat input` | `.77rem` | `--fs-sm` |
| 130 | `.btn` | `.78rem` | `--fs-sm` |
| 163 | `.slot-label` | `.48rem` | `--fs-micro` |
| 168 | `.slot-abbr` | `.58rem` | `--fs-micro` |
| 173 | `.slot-star` | `.53rem` | *deleted — §5* |
| 191 | `.eq-legend` | `.55rem` | *deleted — §5* |
| 200 | `.tiphead h3` | `1.02rem` | `--fs-md` |
| 202 | `.tag` | `.54rem` | `--fs-micro` |
| 211 | `.sub-h` | `.55rem` | `--fs-micro` |
| 213 | `.line` | `.79rem` | `--fs-sm` |
| 216 | `.line .b` | `.55rem` | `--fs-micro` |
| 222 | `.rec` | `.81rem` | `--fs-sm` |
| 226 | `.rec .p` | `.52rem` | `--fs-micro` |
| 231 | `.rec .why` | `.745rem` | `--fs-base` *(prose, not a label)* |
| 232 | `.hint` | `.8rem` | *replaced by `.empty-state` — §9* |
| 243 | `.fld label` | `.55rem` | `--fs-micro` |
| 246 | `.fld input` | `.84rem` | `--fs-base` |
| 251 | `.gtable` | `.86rem` | `--fs-base` |
| 254 | `.gtable th` | `.6rem` | `--fs-micro` |
| 274 | `.roster-sum` | `.78rem` | `--fs-sm` |
| 287 | `.roster-row` | `.79rem` | `--fs-sm` |
| 292 | `.roster-row .nm em` | `.72rem` | `--fs-micro` |
| 293 | `.roster-row .nx` | `.7rem` | `--fs-micro` |
| 295 | `.roster-row .cur` | `.6rem` | `--fs-micro` |
| 300 | `.rank` | `.66rem` | `--fs-micro` |

Note `.slot-label` goes from 7.68px to 11px. At the new 46px tile (§5) an 11px
label wraps; that is correct — it is an *empty* slot's name and wrapping to two
lines is legible where 7.68px on one line was not. Give it
`line-height: var(--lh-tight)` and `overflow-wrap: anywhere`.

### 1.5 Mapping — inline styles to strip

Every one of these becomes a class. Add the classes in `globals.css`; do not
leave a `fontSize` key behind.

**`app/layout.tsx`**

| line | inline | becomes |
|---|---|---|
| 22 | `fontSize: "1.05rem"` on the `h1` | drop the `style`, keep `className="brand"` — `.brand` already sets `--fs-md` and `margin-right: auto` |
| 23 | `style={{ color: "var(--gold)" }}` on the span | drop — `.brand span` already does it |

**`components/Planner.tsx`**

| line | inline | becomes |
|---|---|---|
| 126 | `.76rem`, `--ink-3` | `className="who-sub"` → `--fs-sm`, `--ink-2` |
| 157 | `.68rem`, `--ink-3` | `className="who-note"` → `--fs-sm`, `--ink-2` |
| 358 | `1rem` on `ItemEditor` `h3` | `className="dlg-title"` → `--fs-md` |
| 392 | `.78rem` on the checkbox row | `className="fld-inline"` → `--fs-sm` |

**`components/Roster.tsx`**

| line | inline | becomes |
|---|---|---|
| 28/61 | `float:right; fontSize:.7rem` on the clear button | `className="btn btn-xs"` → `--fs-micro`; replace the `float` with `.card > h2 { display:flex; align-items:center; gap:10px; }` and `margin-left:auto` on the button. `float` inside a flex/grid header is a layout accident waiting to happen. |

**`components/ImportDialog.tsx`** — ten sites (294, 295, 312, 317, 330, 340,
353, 359, 377, 381, 386, 403, 427, 436, 449, 453, 456, 471). Apply §1.3: the
`1rem` title → `.dlg-title` (`--fs-md`); `.9/.88/.85/.84` → `--fs-base`;
`.8/.78/.76/.74` → `--fs-sm`; `.72/.6` mono badges → `--fs-micro`. The `.72rem`
at 295 and the `.6rem` at 453 are counters and provenance labels — `--fs-micro`.
The `.74rem` at 381 and 471 are sentences — `--fs-sm`.

**`components/ItemSearch.tsx`** — 82 (`.6rem`, mono badge → `--fs-micro`), 87
(`.72rem`, a warning *sentence* → `--fs-sm`), 113 (`.82rem` → `--fs-base`), 116
(`.62rem`, mono meta → `--fs-micro`).

**`app/guide/page.tsx`** — 34 (`1.6rem` page `h1` → `--fs-hero`; the guide is a
page and gets the page-title token, same as `.answer`), 35 (`.67rem` →
`--fs-micro`), 49 (`.72rem` section head → `--fs-micro`), 58 (`1.03rem` →
`--fs-md`), 82 (`.9rem` → `--fs-base`), 91 (`.84rem` → `--fs-base`), 96
(`.63rem` → `--fs-micro`).

### 1.6 The numeral utility

```css
/* Every figure a user might compare down a column. The tabular-nums is
   belt-and-braces: JetBrains Mono is already monospaced, but the fallback
   stack is not guaranteed to be, and a column that jitters on a font-load
   failure reads as a column you cannot trust. */
.num {
  font-family: var(--font-jetbrains), ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}
```

Apply to: every `.rank-row` cell in columns 4–6, `.stat input`, `.roster-row .lv`,
`.roster-sum b`, the two figures inside `.answer`, and the `.tag` that carries
`★ n/cap`. The existing `.mono` class stays for non-numeric mono text (labels,
provenance strings); `.num` is the one that guarantees alignment. Do not use
`.mono` on a number again.

---

## 2. Colour

### 2.1 The problem

One hue means several things. `--gold` currently paints six unrelated things:
the wordmark, `.slot-star`, the `.cp` box, the focus ring, `.btn.p`, and
`.roster-row .lv`. A user cannot learn what gold means, because it does not mean
anything. Meanwhile `--ink-3` (#63708f) paints **eleven** text nodes at
**3.40:1** on `--panel` — below the 4.5:1 AA threshold — including every panel
title and every recommendation's explanatory sentence.

Two live defects found while auditing:

- **`--ink-1` is referenced twice and defined never** (`globals.css` L278
  `.roster-sum b`, L291 `.roster-row .nm`). `color: var(--ink-1)` with no
  fallback is invalid at computed-value time, so the property falls back to
  `inherit`. `.roster-sum` sets `color: var(--ink-3)`, so **`.roster-sum b` is
  currently rendering the roster's headline numbers at 3.40:1**, not as the
  emphasised white it was written to be. `.roster-row .nm` inherits from `body`
  and is fine by accident.
- **`--bg-2` and `--blue` are defined and never used.**

### 2.2 Four roles, no overlap

Each family owns exactly one meaning. A colour that appears in two families is a
bug.

```css
:root {
  /* ---- 1. SURFACE + INK ------------------------------------------------ */
  --bg:     #070a12;
  --panel:  #151d2e;
  --panel-2:#1b2540;
  --panel-3:#243052;
  --well:   #0a0e19;
  --line:      #2b3654;   /* panel borders */
  --line-soft: #1e2740;   /* in-panel dividers, table rules */
  --edge:      #3b4a70;   /* interactive borders, dropzone dash */

  --ink:       #eaf0fb;   /* 14.72:1 on --panel — primary text, key figures */
  --ink-2:     #9dabc7;   /*  7.28:1 — secondary text, prose, cost column */
  --ink-label: #8a97b5;   /*  5.75:1 — uppercase labels and column heads */
  --ink-3:     #63708f;   /*  3.40:1 — HAIRLINES AND :disabled ONLY.
                             Never a text colour. See §2.5. */

  /* ---- 2. RARITY — data about the item, never quality of advice -------- */
  --rarity-legendary: #4ecb76;
  --rarity-unique:    #f3cf4f;
  --rarity-epic:      #b47ce8;
  --rarity-rare:      #5aa9f0;
  --rarity-none:      #2f3a55;

  /* ---- 3. MAGNITUDE — a sequential ramp, not a traffic light ----------- */
  /* Fill only. Bigger gain = further up the ramp. Never a text colour:
     gain-0 is 1.41:1 and gain-1 is 3.20:1 on --panel. See §2.4. */
  --gain-0: #2b3654;
  --gain-1: #3d6ea8;
  --gain-2: #4f9fd6;
  --gain-3: #6fd3c0;
  --gain-4: #7cf0a8;
  --gain-bar: rgba(79, 159, 214, .10);   /* = --gain-2 at 10%, the row bar */

  /* Text ramp for the GAIN numeral. Three steps, all AA on --panel and
     --well, monotone in lightness so brighter really does mean bigger. */
  --gain-ink-hi:  #7cf0a8;   /* 11.94 : 1  — = --gain-4 */
  --gain-ink-mid: #6fd3c0;   /*  9.43 : 1  — = --gain-3 */
  --gain-ink-lo:  #9dabc7;   /*  7.28 : 1  — = --ink-2 */

  /* ---- 4. STATUS — three states, and none of them means "big" --------- */
  --bad:  #f06a63;   /* blocked / dead line / impossible */
  --warn: #f0a94f;   /* rests on an input we have not sourced */
  --good: #5fd39b;   /* already maxed, nothing left to buy */

  /* ---- 5. ACCENT — exactly two uses ---------------------------------- */
  --gold:   #f0c060;  /* .btn.p border, and the focus ring. Nothing else. */
  --gold-2: #ffe1a0;  /* .btn.p label only (8.68:1 on the .btn.p ground) */
  --gold-deep: #8a6a1f; /* .btn.p ground stop only */

  --mast-h: 54px;     /* measured from the masthead box — see §3.3 */
}
```

**Deleted:** `--bg-2`, `--blue`, `--leg`, `--uni`, `--epi`, `--rar`.
**Added:** `--ink-label`, `--rarity-*`, `--gain-*`, `--gain-bar`,
`--gain-ink-*`, `--mast-h`.
**`--ink-1` is not defined** — the two references are repointed instead: L278
`.roster-sum b` → `--ink`, L291 `.roster-row .nm` → `--ink`. Defining a token to
service two broken references is how you end up with nine inks.

### 2.3 Rarity: where it may and may not appear

Rarity is a property of the *item*. It is not a judgement about the *advice*.
Legendary green and "good" green are different greens for that reason, and a
legendary item with 0 stars must not read as a solved item.

| allowed | forbidden |
|---|---|
| the 2px `.slot-tier` strip | any text colour inside `.rec` or `.rank-row` |
| the bordered `.tag` in the detail panel | the GAIN, COST or PER 100M columns |
| — | the row bar |

Rename in place, same hex: `.slot-tier.legendary { background: var(--rarity-legendary) }`
and `.tag.legendary { color: var(--rarity-legendary); … }`, and so on for
unique / epic / rare. `.slot-tier.none` → `--rarity-none`.
`.tag.none, .tag.plain` currently use `--ink-3` for text — repoint to
`--ink-label`.

All four rarity hues pass AA as text on `--panel` (8.12 / 11.11 / 5.60 / 6.71),
so the `.tag` usage is safe.

### 2.4 Magnitude: the conflict, and its resolution

The build order asks for the GAIN cell to be "coloured by magnitude step:
gain-4 for the top row, stepping down", and separately for every text/background
pair to clear 4.5:1. Those two instructions collide. Measured on `--panel`:

| token | ratio on `--panel` | as text |
|---|---|---|
| `--gain-0` #2b3654 | **1.41 : 1** | fails |
| `--gain-1` #3d6ea8 | **3.20 : 1** | fails |
| `--gain-2` #4f9fd6 | 5.82 : 1 | passes |
| `--gain-3` #6fd3c0 | 9.43 : 1 | passes |
| `--gain-4` #7cf0a8 | 11.94 : 1 | passes |

Resolution, and it is not a compromise: **the five-step ramp is a fill ramp and
never paints a glyph. The GAIN numeral uses a three-step text ramp.** The bar
behind the row carries five levels of resolution; the numeral carries three
plus its own printed value, which is infinite resolution. Nothing is lost, and
the accessibility gate holds without inventing colours.

```css
.rank-row .gain            { color: var(--gain-ink-lo); }
.rank-row.g-mid .gain      { color: var(--gain-ink-mid); }
.rank-row.g-hi  .gain      { color: var(--gain-ink-hi); }
```

Band assignment, as a share of row 1's gain (`--pct` below):
`g-hi` ≥ 67, `g-mid` ≥ 34, otherwise the base class. This is a presentation
threshold, not a game constant.

### 2.5 The `--ink-3` demotion

After this change `--ink-3` must not appear in any `color:` declaration. It is
permitted in `border-color`, `background`, and `:disabled` rules only. The
eleven text sites repoint as follows:

| selector | currently | becomes | ratio |
|---|---|---|---|
| `.navlink` | `--ink-3` | `--ink-2` | 7.28 |
| `.card > h2` | `--ink-3` | `--ink-label` | 5.75 |
| `.who .sub` | `--ink-3` | `--ink-2` | 7.28 |
| `.statgroup` | `--ink-3` | `--ink-label` | 5.75 |
| `.slot-label` | `#3a4664` | `--ink-label` | 5.75 |
| `.eq-legend` | `--ink-3` | *deleted — §5* | — |
| `.sub-h` | `--ink-3` | `--ink-label` | 5.75 |
| `.tag.none/.plain` | `--ink-3` | `--ink-label` | 5.75 |
| `.rec .p` | `--ink-3` | `--ink-label` | 5.75 |
| `.rec .why` | `--ink-3` | `--ink-2` | 7.28 |
| `.hint` | `--ink-3` | *replaced — §9* | — |
| `.fld label` | `--ink-3` | `--ink-label` | 5.75 |
| `.gtable th` | `--ink-3` | `--ink-label` | 5.75 |
| `.roster-sum` | `--ink-3` | `--ink-2` | 7.28 |
| `.roster-row .nm em` | `--ink-3` | `--ink-label` | 5.75 |
| `.roster-row .nx` | `--ink-3` | `--ink-label` | 5.75 |
| `.rank` (base) | `--ink-3` | `--ink-label` | 5.75 |
| `.line.dead .t` | `#4b5570` | `--ink-label` + `line-through` | 5.75 |
| every inline `var(--ink-3)` in §1.5 | — | `--ink-2` for prose, `--ink-label` for labels | ≥5.75 |

All of these clear AA on `--well` too (`--ink-label` 6.58, `--ink-2` 8.34), which
matters because `.linebox`, `.stat input`, `.roster-row:nth-child(odd)` and the
`.eqwin` all sit on `--well`.

### 2.6 The gold demotion

| selector | currently | becomes |
|---|---|---|
| `.brand span` | `--gold` | `--ink` — the wordmark is not an action |
| `.slot-star` | `--gold` | *deleted — §5* |
| `.cp` box | `--gold-deep` border, `--gold-2` figure | *deleted — §6a* |
| `.roster-row .lv` | `--gold` | `--ink-2` |
| `.roster-row .cur` | `--gold` text + border | `--ink-label` text, `--line` border |
| `.btn.p` | `--gold` | **keep** |
| `:focus-visible` ring | `--gold` | **keep** |
| `.slot[aria-pressed="true"]` | — | **add** (§5) — selection is the focus-ring family |
| `.gtable td` left rule in guide L91 | `--gold` | `--edge` |

After this, gold on screen means exactly one of two things: *this is the button
to press* or *this is where you are*. That is a colour a user can learn in one
session.

---

## 3. The ranked result row

This component does not exist today. It is the product.

### 3.1 The data contract

The damage model is being written in parallel. Bind to this shape; if the model
exports different names, write one adapter at the top of the component file and
nothing else in this spec changes. **[assumption — §12]**

```ts
/** Whether every constant behind a figure has a citation. */
export type Confidence = "sourced" | "estimated";

export interface UpgradeRow {
  /** Stable key. Also the sort tiebreaker, so it must be deterministic. */
  id: string;
  /** SlotDef.id, so clicking a row can select the slot in the doll. */
  slot: string;
  itemId?: number;
  /** Line 1. Imperative, names the transition: "Cape 0★ → 17★". */
  title: string;
  /** Line 2. One clause, clamped to one line. */
  why: string;
  /** Signed percentage points of damage. 2.1 means "+2.1%". */
  gainPct: number;
  /** Whole mesos. */
  costMesos: number;
  /** gainPct / (costMesos / 1e8). Computed by the model, not the view, so
      the sort and the printed figure can never disagree. */
  gainPer100M: number;
  confidence: Confidence;
  /** Required iff confidence === "estimated". Names the exact input and its
      status, e.g. "17→18★ success rate — placeholder, not yet sourced". */
  estNote?: string;
}

export interface Ranking {
  rows: UpgradeRow[];
  /** Empty when the character has too little input to rank anything. */
  blockedBy?: Array<keyof import("@/lib/rules").Stats>;
}
```

The view sorts; it never computes a figure. If `gainPer100M` is absent the row
renders `—` in that cell and sorts last — it does not get a view-side division.

### 3.2 Markup — a real table

The build order asks for a CSS grid in §3 and a real `<table>` in §10. The table
wins, and the grid widths survive via `table-layout: fixed` + `<colgroup>`. A
screen reader then reads the row in order — ordinal, item, action, gain, cost,
per-100M — which is the whole point of building a table rather than a list of
divs that look like one.

```tsx
<div className="rank-wrap">
  <table className="rank-table">
    <caption className="vh">Upgrades ranked by damage gained per 100M mesos</caption>
    <colgroup>
      <col className="c-ord" /><col className="c-icon" /><col className="c-act" />
      <col className="c-gain" /><col className="c-cost" /><col className="c-per" />
    </colgroup>
    <thead>
      <tr className="rank-head">
        <th scope="col" className="c-ord"><span className="vh">Rank</span></th>
        <th scope="col" className="c-icon"><span className="vh">Item</span></th>
        <th scope="col" className="c-act">Upgrade</th>
        <th scope="col" className="c-gain" aria-sort={sortAria("gain")}>
          <button type="button" onClick={() => setSort("gain")}>Gain</button>
        </th>
        <th scope="col" className="c-cost" aria-sort={sortAria("cost")}>
          <button type="button" onClick={() => setSort("cost")}>Cost</button>
        </th>
        <th scope="col" className="c-per" aria-sort={sortAria("per")}>
          <button type="button" onClick={() => setSort("per")}>Per 100M mesos</button>
        </th>
      </tr>
    </thead>
    <tbody>
      {rows.map((r, i) => (
        <tr key={r.id}
            className={`rank-row ${band(r, rows[0])}`}
            style={{ "--pct": pct(r, rows[0]) } as CSSProperties}>
          <td className="c-ord num">{i + 1}</td>
          <td className="c-icon">{icon(r)}</td>
          <th scope="row" className="c-act">
            <span className="act-t">{r.title}</span>
            <span className="act-w">{r.why}</span>
          </th>
          <td className="c-gain num gain">{fmtGain(r.gainPct)}</td>
          <td className="c-cost num">{fmtMeso(r.costMesos)}</td>
          <td className="c-per num">{fmtPer(r.gainPer100M)}</td>
        </tr>
      ))}
    </tbody>
  </table>
  <p className="rank-note">Dotted numbers rest on an input we have not yet verified.</p>
</div>
```

`aria-sort` goes on the `<th>`, is `"ascending" | "descending"` on the active
column and **absent** (not `"none"`) on the others — `none` on three of six
columns is noise in a screen reader's column announcement.

The action cell is `<th scope="row">` because it is the row's name; that makes
every figure announce as "Cape 0 to 17 stars, Gain, plus 2.1 percent".

### 3.3 CSS

```css
.rank-wrap { position: relative; }

.rank-table {
  width: 100%;
  table-layout: fixed;          /* colgroup widths, honoured exactly */
  border-collapse: separate;
  border-spacing: 0;
}

/* ordinal | icon | action | gain | cost | per-100M */
.c-ord  { width: 26px; }
.c-icon { width: 34px; }
.c-act  { width: auto; }        /* takes the remainder */
.c-gain { width: 96px; }
.c-cost { width: 92px; }
.c-per  { width: 104px; }

.rank-head th {
  position: sticky;
  top: var(--mast-h);           /* sits directly under the masthead */
  z-index: 20;
  background: var(--panel);     /* opaque — rows scroll under it */
  font-size: var(--fs-micro);
  line-height: var(--lh-tight);
  font-family: var(--font-jetbrains), monospace;
  font-weight: 500;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ink-label);
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.rank-head .c-gain, .rank-head .c-cost, .rank-head .c-per { text-align: right; }
.rank-head button {
  background: none; border: 0; padding: 0; cursor: pointer;
  font: inherit; letter-spacing: inherit; color: inherit; text-transform: inherit;
}
.rank-head button:hover { color: var(--ink); }
.rank-head [aria-sort] button::after { content: " ▼"; }
.rank-head [aria-sort="ascending"] button::after { content: " ▲"; }

.rank-row {
  --pct: 0;
  /* The magnitude bar. A hard-stop gradient on the <tr> rather than an
     absolutely-positioned ::before, because position:relative on a table row
     is the one place that trick is historically unreliable. One encoding
     only — there is deliberately no zebra stripe, because a bar plus a
     stripe is two encodings and one of them means nothing. */
  background-image: linear-gradient(
    90deg,
    var(--gain-bar) 0 calc(var(--pct) * 1%),
    transparent     calc(var(--pct) * 1%)
  );
}
.rank-row td, .rank-row th {
  height: 52px;                 /* min-height, on a table cell */
  padding: 0 12px;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: middle;
}
.rank-row:hover td, .rank-row:hover th { background: rgba(255,255,255,.022); }
.rank-row .c-gain, .rank-row .c-cost, .rank-row .c-per { text-align: right; }

.c-ord  { color: var(--ink-label); font-size: var(--fs-sm); }
.c-icon img { width: 28px; height: 28px; image-rendering: pixelated; display: block; }

.c-act { min-width: 0; font-weight: 400; }   /* it is a <th>; do not let it bold */
.act-t {
  display: block; font-size: var(--fs-md); line-height: var(--lh-tight);
  color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.act-w {
  display: block; font-size: var(--fs-sm); line-height: var(--lh-tight);
  color: var(--ink-2); margin-top: 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.c-gain { font-size: var(--fs-num); line-height: var(--lh-tight); }
.c-cost { font-size: var(--fs-base); color: var(--ink-2); }
.c-per  { font-size: var(--fs-base); color: var(--ink); }

.rank-note {
  margin: 10px 0 0; padding: 0 12px;
  font-size: var(--fs-sm); color: var(--ink-2);
}
```

`--mast-h: 54px` is computed, not observed: `.mast-in` is `padding: 12px 22px`
around a flex row whose tallest child is `.navlink` at
`--fs-sm` × `--lh-body` + 5px + 5px = 28.1px, so 12 + 28.1 + 12 + 1px border =
53.1px → 54px. Keep it in a token so a masthead change is one edit and the
sticky header follows. **[assumption — §12: not verified in a browser.]**

### 3.4 Formatting

Three formatters, module scope, created once. A `new Intl.NumberFormat` per row
per render is a measurable cost at 25 rows and a pointless one.

```ts
/** Always signed, always unit-suffixed. "+2.1%" / "−0.4%". */
const GAIN = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero",
});
export const fmtGain = (p: number) => `${GAIN.format(p)}%`;

/** Compact mesos: 740K, 180M, 4.1B. */
const MESO = new Intl.NumberFormat("en-US", {
  notation: "compact", maximumFractionDigits: 1,
});
export const fmtMeso = (m: number) => MESO.format(m);

/** Damage percentage points bought per 100M mesos. */
const PER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
export const fmtPer = (v: number | undefined) =>
  v === undefined ? "—" : PER.format(v);
```

The PER 100M column prints the bare number; the unit lives once in the column
head (`PER 100M MESOS`), not repeated 25 times down the column. This is the
column the product exists for, so it is the default sort, descending.

### 3.5 Confidence

The project's hardest rule is that a confidently wrong number is worse than no
number. The table has to show the difference without faking precision, and
without burying it in a footnote nobody reads.

```css
.est {
  border-bottom: 1px dotted var(--warn);
  cursor: help;
}
.est:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
```

A `title` attribute alone is not enough — it is not reachable by keyboard and is
inconsistently announced. Every estimated figure ships as:

```tsx
<span className="est" tabIndex={0} title={r.estNote} aria-describedby={`est-${r.id}`}>
  {fmtGain(r.gainPct)}
</span>
<span id={`est-${r.id}`} className="vh">Estimate. {r.estNote}</span>
```

A figure whose every input is sourced carries no dotted rule and no wrapper.
The absence of the rule is the claim; it has to be earned.

Under the table, at `--fs-sm` / `--ink-2`:
**"Dotted numbers rest on an input we have not yet verified."**

Add the visually-hidden utility once:

```css
.vh {
  position: absolute; width: 1px; height: 1px; margin: -1px;
  padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
```

---

## 4. The primary screen

### 4.1 Source order

`.wrap` becomes two columns, and the answer spans both. The doll moves into the
left rail (§5), which is why the third column disappears.

```css
.wrap {
  max-width: 1340px;
  margin: 0 auto;
  padding: 22px 22px 80px;
  display: grid;
  grid-template-columns: 286px minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.demo-banner, .answer, .rank-wrap, .firstrun { grid-column: 1 / -1; }
```

The rail is **286px**, not 262px: a 5 × 46px doll with 4px gaps is 246px, plus
`.eqwin` padding 10px × 2 and the card's 1px borders is 268px, which does not
fit 262px. 286px leaves 18px of slack.

Order inside `.wrap`:

1. `.demo-banner` — only when the example character is loaded (§8)
2. `.answer` — the sentence
3. `.rank-wrap` — the table, top 8 rows + a "Show all 25" toggle
4. left rail: `.card` Character → name, stats, **doll**, import/clear buttons
5. right: `.card` detail panel for the selected slot
6. `Roster`, unchanged, `grid-column: 1 / -1`

### 4.2 `.answer`

One sentence, the two load-bearing figures in `.num`, the runner-up named
underneath so the number has a scale, and one primary button.

```tsx
<section className="answer">
  <div>
    <h2 className="answer-h">
      Next: <strong>{top.title}</strong> — <span className="num answer-n">{fmtGain(top.gainPct)} damage</span>
      {" for "}<span className="num answer-n">~{fmtMeso(top.costMesos)} mesos</span>
    </h2>
    <p className="answer-sub">
      Next best is {fmtGain(second.gainPct)} for {fmtMeso(second.costMesos)}.
    </p>
  </div>
  <button className="btn p" onClick={showAll}>Show the full ranking</button>
</section>
```

```css
.answer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  padding: 16px 18px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 5px;
}
.answer-h {
  font-size: var(--fs-hero);
  line-height: var(--lh-tight);
  font-weight: 600;
  color: var(--ink-2);            /* the frame words recede… */
}
.answer-h strong, .answer-n { color: var(--ink); font-weight: 700; }
.answer-n { font-size: var(--fs-hero); }   /* …the figures do not */
.answer-sub {
  margin: 6px 0 0;
  font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--ink-2);
}
```

Height, computed: 16 + (34 × 1.2 = 40.8) + 6 + (12.5 × 1.45 = 18.1) + 16 + 2 =
**98.9px**. Putting the button in a second column rather than under the subline
is what brings this in under the 120px budget — stacked it would be ~141px.

The sentence must hold one line down to ~900px. If it wraps to two the block is
139.7px, which is still acceptable; below 760px it is expected to wrap and the
button moves under (§7).

### 4.3 Kill the duplicate panel title

`Planner.tsx` L216 renders `<h2>{slot ? slot.n : "Character"}</h2>` on the advice
panel. When nothing is selected it prints "Character" — a 9.6px, 3.40:1 label
duplicating the left panel's own title and saying nothing. Delete the `"Character"`
fallback; the panel's `h2` renders the selected slot's name or, with nothing
selected, the panel renders the empty-advice state (§9) with no `h2` at all. The
ranking's own sticky header is the page's orientation now.

---

## 5. The equipment doll

It becomes a filter control: 25 tap targets that choose which slot the detail
panel explains. It is not the hero, and it is not a picture of the game.

```css
.grid-eq {
  display: grid;
  grid-template-columns: repeat(5, 46px);
  grid-auto-rows: 46px;
  gap: 4px;
  justify-content: center;
}
.eqwin { padding: 10px; background: var(--well); border-radius: 4px; }

.slot {
  position: relative; padding: 0; cursor: pointer; overflow: hidden;
  background: #141c30;                 /* flat — was a gradient */
  border: 1px solid var(--line-soft); border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
  transition: border-color .12s, box-shadow .12s;   /* no transform */
}
.slot:hover { border-color: var(--edge); }
.slot:focus-visible {
  outline: none;
  border-color: var(--gold);
  box-shadow: 0 0 0 2px rgba(240,192,96,.35);
}
.slot[aria-pressed="true"] {
  border-color: var(--gold);
  box-shadow: 0 0 0 2px rgba(240,192,96,.25);
}
```

**Deleted:** `.slot:hover { transform: translateY(-1px) }` — 25 cells that jump
under a moving cursor is noise, and it fires on the way to somewhere else.
**Deleted:** `.slot-star` — at 46px a `★17` overlay is unreadable, and it is a
third colour system (gold) inside a 46px box that already carries a rarity strip
and an alert dot. The star count already appears in the detail panel as a
`.tag plain` reading `★ n/cap` (`Planner.tsx` L231–235); that is the one place it
belongs, and it is legible there.
**Deleted:** `.eq-legend` entirely (`globals.css` L189–194, `Planner.tsx`
L204–210) — 28px of 8.8px chips decoding a 2px strip, and at the shipped 358px
column width the five chips wrap to two lines, so it is 52px. The tier word
already appears as a `.tag` in the detail panel, which is where a user looks
after clicking the thing they want to know about.
**Kept:** `.slot-tier` (2px strip) and `.slot-alert` (5px dot).

### 5.1 The selection model — the bug that makes advice unreadable

Today `Planner.tsx` holds `hover` state, sets it `onMouseEnter`, and clears it on
`onMouseLeave` of `.grid-eq` (L168). The advice panel is in the *third* grid
column, to the right of the grid. **Moving the cursor rightward out of the grid
toward the advice you are reading wipes it.** On a touch device there is no
hover at all, so a phone user gets zero per-slot advice — the feature does not
exist for them.

Replace, in `Planner.tsx`:

| now | becomes |
|---|---|
| `const [hover, setHover] = useState<string \| null>(null)` | `const [selected, setSelected] = useState<string \| null>(null)` |
| `<div className="grid-eq" onMouseLeave={() => setHover(null)}>` | `<div className="grid-eq" role="group" aria-label="Equipment slots">` |
| `onMouseEnter={() => setHover(s.id)}` `onFocus={() => setHover(s.id)}` | *removed* |
| `onClick={() => setEditing(s.id)}` | `onClick={() => setSelected(s.id)}` |
| — | `aria-pressed={selected === s.id}` |
| `const slot = SLOTS.find(s => s.id === hover)` | `… === selected` |
| `setHover(entries.at(-1)?.slot ?? null)` (L306) | `setSelected(…)` |

The `ItemEditor` no longer opens from the tile. It opens from an explicit button
in the detail-panel header:

```tsx
<div className="tiphead">
  {/* icon, h3, tags … */}
  <button className="btn" onClick={() => setEditing(slot.id)}>Edit item</button>
</div>
```

Two consequences worth stating: selecting a slot is now free (one click, no
modal), and editing is now deliberate (a named button, not a side effect of
pointing at something). That is the correct split — the common action is
reading, and it should be cheaper than the rare one.

### 5.2 Keyboard

`.grid-eq` gets a roving tabindex. The grid is column-major with holes
(`SlotDef.c` 1–5, `.r` 1–6, 25 of 30 cells filled), so arrow keys move by
coordinate, not array index:

- `ArrowRight` / `ArrowLeft` — next / previous populated slot with the same `r`,
  wrapping within the row
- `ArrowDown` / `ArrowUp` — next / previous populated slot with the same `c`
- `Home` / `End` — first / last slot in source order
- `Enter` / `Space` — native `<button>` activation, which sets `selected`

Exactly one `.slot` carries `tabIndex={0}` (the selected one, or the first if
none); all others `tabIndex={-1}`. Move focus with `ref.current?.focus()` after
setting state.

The detail panel gets `aria-live="polite"` so the new slot's name, tier and
ranking are announced on selection without moving focus out of the grid.

---

## 6. Delete the decoration

Nine things currently claim elevation: `.mast`, `.card`, `.card > h2`, `.cp`,
`.slot`, `.slot-star`, `.btn`, `.rec`, `.ed-in`. Elevation should mean *this
floats above the page*. Two things get to mean that.

**(a) The `.cp` block — `globals.css` L97–112, `Planner.tsx` L129–132.**
Delete the block, the `::after` glare sweep, `.cp .l` and `.cp .v`. That is
62.8px of box plus a 14px margin = **76.8px of vertical space**, a gold border,
and the largest type on the screen (24px) spent on an aggregate the planner never
moves. Combat Power becomes one more row in the Offense group:

```tsx
<div className="stat">
  <span className="k">Combat Power</span>
  <input type="number" className="num" value={ch.cp || 0} aria-label="Combat Power"
         onChange={e => update({ ...ch, cp: parseInt(e.target.value, 10) || 0 })} />
</div>
```

**(b) `body` background — L37–41.** Replace the two radial gradients and
`background-attachment: fixed` with `background: var(--bg);`. `fixed` forces a
full-viewport repaint on every scroll frame, which is precisely the wrong cost to
pay on a page whose main content is a long scrolling table.

**(c) `.card` — L72–77.** Flatten:

```css
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 5px;
}
.card > h2 {
  display: flex; align-items: center; gap: 10px;
  font-family: var(--font-jetbrains), monospace;
  font-size: var(--fs-micro); line-height: var(--lh-tight);
  letter-spacing: .19em; text-transform: uppercase; font-weight: 500;
  color: var(--ink-label);
  padding: 10px 14px;
  background: none;                       /* was a gradient */
  border-bottom: 1px solid var(--line-soft);
}
```

Elevation is reserved for `.ed-in` (a modal, which genuinely floats) and `.mast`
(which genuinely overlaps scrolled content).

**(d) `.slot`** — gradient → flat `#141c30` (§5).

**(e) `.rec`** — drop the `linear-gradient(180deg, rgba(255,255,255,.028), transparent)`
background; keep the 2px left border, which is the only part carrying meaning.

---

## 7. Responsive

### 7.1 The current failure

`@media (max-width: 1240px)` sends `.wrap > :nth-child(3)` — the advice rail, the
product's only output — to `grid-column: 1 / -1` on a second row. Measured against
the shipped stylesheet, the character card is ~583px tall and the equipment card
~512px, so on a 1280 × 800 laptop at 1240px width the advice rail's first row
starts at 54 + 22 + 583 + 18 = **677px**, leaving room for roughly one `.rec`
before the fold. Every 13" laptop sees a gear diagram and no answer.

### 7.2 After the reorder

Because `.answer` and `.rank-wrap` are now first in source order and span both
columns, this fixes itself — but assert it, because `nth-child` selectors are
exactly the kind of thing that silently re-targets when someone inserts a
banner:

```css
@media (max-width: 1240px) {
  .wrap { grid-template-columns: 1fr; }   /* rail and detail stack */
}
```

Delete the `.wrap > :nth-child(3) { grid-column: 1 / -1 }` rule outright, and use
explicit class-based spans (§4.1) so inserting `.demo-banner` cannot break the
layout.

**Verification at 1280 × 800** (all computed from the box model above):

| element | top | bottom |
|---|---|---|
| masthead | 0 | 54 |
| `.wrap` padding | 54 | 76 |
| `.answer` | 76 | 175 |
| gap | 175 | 193 |
| `.rank-head` | 193 | 227 |
| **`.rank-row` #1** | **227** | **279** |
| `.rank-row` #8 | 591 | 643 |
| `.rank-note` | 653 | 671 |

Eight ranked rows and the confidence note sit above the fold with 129px to
spare. The assertion to hold in review: **the first `.rank-row` renders above
300px at 1280 × 800, and the eighth above 800px.**

### 7.3 ≤760px

```css
@media (max-width: 760px) {
  .wrap { grid-template-columns: 1fr; padding: 14px 14px 60px; }

  /* The doll fills the width; cells stay square. */
  .grid-eq { grid-template-columns: repeat(5, 1fr); grid-auto-rows: auto; gap: 4px; }
  .slot { aspect-ratio: 1; }

  /* Drop the icon and the per-100M column; the ordinal, the action, the gain
     and the cost are what a phone can carry without truncating the title
     into meaninglessness. */
  .c-icon, .c-per { display: none; }
  .c-ord { width: 22px; } .c-gain { width: 78px; } .c-cost { width: 72px; }
  .rank-row td, .rank-row th { padding: 0 10px; }
  .c-gain { font-size: var(--fs-lg); }

  .answer { grid-template-columns: 1fr; }   /* button drops under */
}
```

At 375px: the doll is (375 − 28 wrap − 20 eqwin − 16 gaps) / 5 = **57.4px per
cell**, comfortably over the 44px touch minimum. The rank row spends 22 + 78 + 72
+ 20 padding + 30 gaps = 222px, leaving **153px** for the action cell — enough
for a truncated title plus its `why` line. Below 400px, hide `.act-w`; a
one-word fragment of a reason is worse than no reason.

Sorting by PER 100M is still the default on mobile even though the column is
hidden; add the column head back as a `<select>`-style sort control if the
hidden column proves confusing. **[assumption — untested with users.]**

---

## 8. First run

### 8.1 Stop showing a stranger's character

`Planner.tsx` L32: `useState<Character>(() => exampleCharacter())`. A new user's
first screen is somebody else's gear, with no label saying so, and the numbers
are wrong for them in a way they cannot detect. Change to
`useState<Character>(emptyCharacter)`.

Render `.firstrun` in place of all three cards whenever the character has no
items and no non-zero stats:

```ts
const isBlank = (c: Character) =>
  Object.keys(c.items).length === 0 &&
  Object.values(c.stats).every((v) => !v);
```

### 8.2 `.firstrun`

One box, one button. This is Raidbots' shape — a paste field and a Simulate
button — plus the labelled worked example Raidbots does not have.

```tsx
<section className="firstrun">
  <h1 className="fr-h">What should I upgrade next?</h1>
  <p className="fr-sub">
    Paste your character. Get every upgrade ranked by damage gained per meso spent.
  </p>

  <div className="fr-drop" onDrop={…} onDragOver={…}>
    <p className="fr-drop-t">Drop your Stat and Equip window screenshots</p>
    <button className="btn p" onClick={() => setImporting(true)}>Choose files</button>
  </div>

  <p className="fr-alt">
    <button className="linkish" onClick={() => setManual(true)}>or enter gear by hand</button>
    <button className="linkish" onClick={() => update(exampleCharacter())}>see a worked example →</button>
  </p>
</section>
```

```css
.firstrun {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: 64px 22px 80px;
}
.fr-h   { font-size: var(--fs-hero); line-height: var(--lh-tight); color: var(--ink); }
.fr-sub {
  margin: 10px 0 0; max-width: 46ch;
  font-size: var(--fs-md); line-height: var(--lh-body); color: var(--ink-2);
}
.fr-drop {
  width: 420px; max-width: 100%; margin-top: 28px;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  border: 1px dashed var(--edge); border-radius: 5px; padding: 32px;
  background: var(--well);
}
.fr-drop.over { border-color: var(--gold); background: rgba(240,192,96,.05); }
.fr-drop-t { margin: 0; font-size: var(--fs-base); color: var(--ink-2); }
.fr-alt { display: flex; gap: 20px; margin-top: 18px; }
.linkish {
  background: none; border: 0; padding: 0; cursor: pointer;
  font-size: var(--fs-sm); color: var(--ink-2); text-decoration: underline;
  text-underline-offset: 3px;
}
.linkish:hover { color: var(--ink); }
```

Nothing else renders on the first screen. No doll, no empty stat form, no cards.
A form with nine zeroed number inputs is a bill; a dropzone is an offer.

### 8.3 The example must be labelled, always

```tsx
{isExample && (
  <div className="demo-banner" role="status">
    <span>Example character — Archerroni, not yours.</span>
    <button className="linkish" onClick={() => update(emptyCharacter())}>
      Clear and start mine
    </button>
  </div>
)}
```

```css
.demo-banner {
  display: flex; align-items: center; gap: 14px;
  background: rgba(240,169,79,.10);
  border: 1px solid var(--warn);
  border-radius: 4px;
  padding: 8px 14px;
  font-size: var(--fs-sm);
  color: var(--ink);
}
.demo-banner .linkish { margin-left: auto; }
```

`isExample` needs a flag on `Character` — add `demo?: true` set by
`exampleCharacter()` and cleared by any edit, or compare `ch.name` against the
example's name. The flag is better; name comparison breaks the moment a real
user types the same name. **[assumption — `exampleCharacter()` is owned by
`lib/rules.ts`, which this spec does not edit. Record it as a one-line change
for whoever owns that file.]**

A user must never be unable to tell whether the numbers on screen are theirs.
The banner persists — it is not dismissible — until the character is cleared.

---

## 9. Empty advice state

`globals.css` L232: `.hint { color: var(--ink-3); font-size: .8rem; padding: 30px 14px; text-align: center; }`
rendering "Fill in your stats to get advice." — 12.8px at 3.40:1, passive voice,
no next step, and it does not say *which* stats or *what they buy*. Delete it and
the `.hint` class (also used in `Roster.tsx` L104, which becomes `.note` —
`--fs-sm` / `--ink-2`, left-aligned).

Replace with a checklist that earns the next keystroke. One row per field in
`Stats`, each naming what it unlocks in the ranking:

```ts
/** What each missing input buys the user, in the tool's own terms. Deliberately
    describes what the ranking can do once it has the number — not how large the
    gain is, because that claim would be a game constant nobody has sourced. */
export const UNLOCKS: Record<keyof Stats, string> = {
  main:      "unlocks every stat-line comparison — the ranking cannot compare %stat to flat ATT without it",
  att:       "unlocks weapon and emblem rows",
  crit:      "lets the ranking stop recommending crit rate once you are at 100%",
  critdmg:   "unlocks crit-damage potential rows",
  boss:      "unlocks boss-damage lines and separates boss from mob gain",
  ied:       "unlocks IED lines, which stack multiplicatively and so are ranked separately",
  hp:        "unlocks the survivability check that flags gear you cannot yet use",
  arcane:    "unlocks Arcane symbol rows",
  starforce: "unlocks the star-force cost curve and the set-bonus thresholds",
};
```

```tsx
<div className="empty-state">
  <h3 className="sub-h">To rank your upgrades, the planner needs</h3>
  <ul>
    {STAT_ROWS.map(([label, key]) => {
      const have = !!ch.stats[key];
      return (
        <li key={key}>
          <span className={have ? "es-ok" : "es-todo"} aria-hidden="true">{have ? "✓" : "○"}</span>
          <button type="button" onClick={() => focusStat(key)}>
            <b>{label}</b>
            {!have && <span> — {UNLOCKS[key]}</span>}
            <span className="vh">{have ? "filled in" : "missing, press to fill in"}</span>
          </button>
        </li>
      );
    })}
  </ul>
</div>
```

```css
.empty-state ul { list-style: none; margin: 10px 0 0; padding: 0; }
.empty-state li {
  display: grid; grid-template-columns: 16px minmax(0, 1fr);
  gap: 10px; padding: 7px 0;
  border-bottom: 1px solid var(--line-soft);
}
.empty-state li:last-child { border-bottom: 0; }
.empty-state button {
  background: none; border: 0; padding: 0; text-align: left; cursor: pointer;
  font-size: var(--fs-base); line-height: var(--lh-body); color: var(--ink-2);
}
.empty-state button b { color: var(--ink); font-weight: 600; }
.empty-state button:hover b { text-decoration: underline; }
.es-ok   { color: var(--good); }
.es-todo { color: var(--ink-label); }
```

`focusStat(key)` scrolls the left rail's matching `.stat input` into view and
focuses it. Give each input `id={`stat-${key}`}` so this is a
`document.getElementById` and not a query selector on a class.

Progress is visible: filled fields show a `--good` check, so the list shortens
as the user works and the tool visibly responds to them. The nine-row list is
also, incidentally, an honest statement of what the model needs — which is the
opposite of a tool that produces a number from nothing.

---

## 10. What is wasting space and attention

Measured, ranked, with the recovery:

| # | thing | cost | verdict |
|---|---|---|---|
| 1 | `.cp` Combat Power box | **76.8px** vertical, gold border, the page's largest type (24px) | Delete. It never changes in response to anything the planner does. §6a |
| 2 | `.eq-legend` | **28–52px** (wraps to two lines at the shipped column width) of 8.8px chips decoding a 2px strip | Delete. The tier word is already a `.tag` in the detail panel. §5 |
| 3 | 62px doll × 6 rows | **397px** of the first screen given to a static diagram | Shrink to 46px (**278px**, saving 119px) and move into the rail. §5 |
| 4 | `.card > h2` "Character" on the advice panel | a 9.6px, 3.40:1 label duplicating the panel next to it | Delete. §4.3 |
| 5 | `body` two radial gradients + `background-attachment: fixed` | a full-viewport repaint per scroll frame on a page whose content is a long table | Flat `var(--bg)`. §6b |
| 6 | nine elevation treatments | gradient + inset highlight + 30px shadow on every panel; "floats above the page" means nothing | Two: `.ed-in`, `.mast`. §6c |
| 7 | `.slot:hover { transform }` | 25 tiles that jump under a moving cursor, firing on the way past | Delete. §5 |
| 8 | the hover-driven selection model | per-slot advice is unreadable on desktop and absent on mobile | Click-to-select. §5.1 |
| 9 | 71 font-size sites, 24 values, 11 below 11px | no scale; the smallest label on screen is 7.68px | 7 tokens. §1 |
| 10 | `--gold` with six meanings, `--ink-3` painting 11 text nodes at 3.40:1 | the palette teaches nothing and fails AA | Four roles. §2 |

Total first-screen vertical recovered before the table is even added: **~270px**.

---

## 11. Accessibility gate for the integration PR

Each item is a check the reviewer can run, not an aspiration.

1. **No font-size below 11px.**
   `grep -rn "font-size" app components | grep -v "var(--fs-" | grep -v inherit`
   returns nothing, and `grep -rn "fontSize" app components` returns nothing.

2. **Every text/background pair ≥ 4.5:1.** Verified in this document:
   `--ink` 14.72 / 16.84, `--ink-2` 7.28 / 8.34, `--ink-label` 5.75 / 6.58,
   `--good` 9.04 / 10.35, `--warn` 8.41 / 9.63, `--bad` 5.57 / 6.37,
   `--gold-2` on the `.btn.p` ground 8.68, all four `--rarity-*` ≥ 5.60
   (on `--panel` / on `--well`). Plus:
   `grep -rn "color: var(--ink-3)" app components` returns nothing, and
   `--gain-0` / `--gain-1` appear only in `background`/`border` declarations
   (they are 1.41:1 and 3.20:1 and would fail as text — §2.4).

3. **The ranking is a real `<table>`** with `<th scope="col">` on every column
   head, `<th scope="row">` on the action cell, a `<caption>`, and `aria-sort`
   present on exactly one `<th>` at a time. Not a div grid. §3.2

4. **Slot selection works with the keyboard alone.** Tab reaches the doll once;
   arrows move within it; `aria-pressed` reflects selection; the detail panel is
   `aria-live="polite"`. Touch: one tap selects, no hover dependency anywhere.
   §5.1, §5.2

5. **No information carried by colour alone.**
   - the `.slot-tier` strip is decoded by the `.tag` text tier in the detail panel
   - the magnitude bar never carries the gain on its own — the signed,
     unit-suffixed number is always printed in the same row
   - `--good` / `--bad` / `--warn` are always paired with a word or glyph
     (`✓`/`○` in §9, "dead" in `.line .b`, the dotted rule plus its
     `aria-describedby` text in §3.5)
   - `.slot-alert` (the red dot) needs a text equivalent: add
     `<span className="vh">needs attention</span>` inside the tile.

6. **Focus is always visible.** Delete `.slot:hover, .slot:focus-visible` as a
   combined selector (L156) — combining them means a hovered slot and a focused
   slot are indistinguishable. Separate rules, §5.

7. **Reduced motion.** With the transforms and the glare sweep gone there is
   almost nothing left to guard, but add
   `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; } }`
   once, so future additions inherit the guard.

---

## 12. Assumptions and unverified inputs

Nothing here is a game constant — this document specifies presentation only, and
deliberately contains no damage formula, meso cost or drop rate. What it does
contain that is not verified:

1. **The `UpgradeRow` / `Ranking` interface (§3.1)** is a contract proposed for a
   module being written in parallel. If the shipped module differs, the
   integrator writes one adapter function and no CSS changes.
2. **`--mast-h: 54px` (§3.3)** is computed from the stylesheet's box model
   (12 + 28.1 + 12 + 1), not measured in a browser. The live app could not be
   opened from this session. Verify with
   `document.querySelector('.mast').getBoundingClientRect().height` and correct
   the token if it differs; the sticky header is the only thing that depends on
   it.
3. **Every figure in the worked examples** — `+3.4%`, `~410M`, `+2.9%`, `1.1B`,
   "17→18★ success 30%" — is illustrative placeholder copy carried from the
   brief. None of it is a computed result and none of it may ship as a literal
   string. The `.est` tooltip text must come from `UpgradeRow.estNote`,
   generated by the model.
4. **The `g-hi` / `g-mid` band thresholds (67% / 34% of row 1)** are a
   presentation choice, not a derived quantity. They need one look at a real
   ranking to confirm they do not put 24 of 25 rows in the same band.
5. **The vertical measurements in §7.2 and §10** are computed from the shipped
   CSS box model using default line-height behaviour and assumed font metrics
   for Inter Tight / Public Sans / JetBrains Mono. They are accurate to a few px,
   not exact. The assertion to test is the ordering and the fold, not the
   individual figures.
6. **The `.eq-legend` wrap calculation (28px vs 52px)** assumes average glyph
   advance for JetBrains Mono at 8.8px with `.1em` tracking. The conclusion —
   that it is more than one line at the shipped column width — should be
   confirmed by eye, though the recommendation (delete it) does not depend on
   which it is.
7. **`Character.demo` (§8.3)** does not exist yet and lives in `lib/rules.ts`,
   which this spec does not own. One-line change for that file's owner.
8. **The mobile sort control (§7.3)** — hiding the PER 100M column while it
   remains the default sort is untested with users. If it confuses, the fallback
   is a sort `<select>` above the table on small screens.
9. **The empty-state copy (§9)** was written to avoid magnitude claims. An
   earlier draft read "Arcane Power — unlocks symbol ranking, usually the largest
   single gain above Lv 240"; the "usually the largest single gain" clause is an
   unsourced comparative claim about the game and was cut. If the damage model
   can substantiate it, it belongs in the ranking as a computed row, not in
   prose.

---

## 13. Application order

The changes interlock; this order keeps the app rendering at every step.

1. §1.2 tokens + §2.2 tokens into `:root`. Nothing visually changes yet.
2. §1.4 CSS mapping. Every `font-size` becomes a token. Visual change is small
   and entirely upward.
3. §2.5 + §2.6 repointing. Contrast passes. `--ink-3` stops painting text.
4. §6 deletions — `.cp`, body gradients, `.card` chrome, `.slot` gradient.
5. §5 doll: 46px, deletions, and the §5.1 selection-model fix. **This is the
   change that makes the app usable on a phone**; if the release has to be cut
   short, cut after this step, not before it.
6. §4.1 `.wrap` regrid + §4.3 `h2` deletion + §7 breakpoints.
7. §3 `.rank-table`, wired to whatever the model exports, behind a flag if it is
   not ready. Until it is, `.answer` and `.rank-wrap` render a single line:
   "Ranking is being wired up." — not a fake number.
8. §9 `.empty-state`, §8 `.firstrun` and `.demo-banner`.
9. §1.5 inline-style strip across the five component files.
10. §11 gate.

Steps 1–6 are worth shipping on their own: they fix a broken interaction, a
failing contrast audit and 270px of wasted first screen, and none of them
depends on the damage model existing.
