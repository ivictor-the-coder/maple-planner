# Research: meso income, accounts and billing

Produced 2026-09-11 by a 37-agent research workflow: five dimensions researched in
parallel, every volatile number attacked by two independent refuters (one checking
server provenance, one checking patch currency), then a completeness critic.

**Read the disputed list before trusting any number in here.** The adversarial pass
refuted or failed to confirm 21 claims, including the one the entire meso
feature hangs on. 49 questions could not be answered from any source.

---

# MaplePlanner Backlog

Two features, each ordered cheapest-useful-slice first. Written against GMS Heroic, patch v.271 (live 2026-09-09).

**Confidence tag convention used throughout — adopt it in code and in the UI, not just in this doc:**

| Tag | Meaning |
|---|---|
| `[high]` | Multiple independent sources, server-tagged GMS, current patch |
| `[medium]` | One good source, or sources agree but server/patch not confirmed |
| `[low]` | Single weak source, or derived from an unverified input |
| `[UNVERIFIED]` | Number is in circulation but no reachable source states it for GMS Heroic at v.271 |
| `[DISPUTED]` | Two or more sources give different values and the conflict is unresolved |
| `⚠volatile` | Patch-tunable. Will change without notice. |

**Hard rule for both features: a `[UNVERIFIED]` or `[DISPUTED]` number never renders as a bare figure.** It renders with its tag visible and, where it drives a recommendation, with a user override control next to it. This is not a nice-to-have — the two constants the entire meso model hangs on (the crystal caps) are both disputed.

---

# FEATURE 1 — MESO POTENTIAL

> *"meso potential (from weekly bossing to daily bossing to min-max since selling crystals are limited)"*

## What this feature actually is

The crystal sale cap is the binding constraint, and it produces a three-stage progression that the tool should make visible and walk the player up:

1. **Weekly bossing** — fill your per-character weekly crystal slots with the highest-value crystals you can clear.
2. **Daily bossing** — only worth anything while the account has *unused* world-cap headroom. This is a phase you grow *out of*, not into.
3. **Min-max non-crystal income** — once slots are the limit and not clears, every additional meso has to come from farm multipliers, Ursus, and Maple Tour.

The single most important derivable fact in the whole research corpus, which appears nowhere in it explicitly:

> **Daily-boss crystals and weekly-boss crystals draw from the same world allowance `[high]`.** One character running the ~15 daily bosses generates roughly 18 crystals/day ≈ **126 crystals/week** for maybe 100–150M total. Meanwhile ~13 characters × 14 weekly slots = 182 ≥ the world cap. **Once the roster can fill the world cap with weekly crystals, daily crystals are worth exactly zero and must not be sold.** A naive "daily boss checklist" feature actively destroys meso.

The allocator must produce this conclusion on its own. Do not special-case it; let it fall out, then surface it as a headline.

---

## 1.1 Data model

### Schema shape

`data/guide-graph.json` already uses tagged nodes. **I did not have repo access when writing this — confirm the existing node envelope and conform to it rather than to the shape below.** What matters is that every one of these fields is present somewhere on each node:

```jsonc
{
  "id": "crystal.chaos_zakum",
  "type": "crystal",
  "value": 81000000,
  "unit": "meso",
  "server": "GMS/Heroic",
  "confidence": "high",           // high | medium | low | unverified | disputed
  "volatile": true,
  "patch": "v270",                // patch the value was last observed under
  "verifiedAt": "2026-09-11",
  "source": "https://en.namu.wiki/w/%EA%B0%95%EB%A0%AC%ED%95%9C%20%ED%9E%98%EC%9D%98%20%EA%B2%B0%EC%A0%95",
  "note": null,
  "dispute": null                 // present ONLY on disputed nodes, see below
}
```

Disputed nodes carry the whole conflict, because the UI has to render it:

```jsonc
"dispute": {
  "candidates": [
    { "value": 12, "source": "https://grandislibrary.com/content/progression-guide", "argument": "GMS-specific guide site, currently reads 12" },
    { "value": 14, "source": "https://maplestorywiki.net/w/Intense_Power_Crystal", "argument": "Explicitly splits GMS=14 from KMS/JMS/CMS/MSEA/TMS=12" }
  ],
  "default": 14,
  "userOverridable": true,
  "whyItMatters": "Sets the weekly ceiling for every character. ±2 slots ≈ ±120M meso/week on a main."
}
```

### Table A — `crystals` (one node per boss × difficulty)

Fields: `boss`, `difficulty`, `resetClass` (`daily` | `weekly` | `monthly`), `heroicValue`, `interactiveValue`, `slotCost` (see below), `entryLevel`, `forceRequirement` (`{ type: arcane|sacred|authentic, value }`), `prequestChain`.

Values `[high] ⚠volatile` — sourced from the GMS v270 table, Heroic column = Interactive × 5 `[high]`. Load the full table from the `crystals` research dimension; representative rows:

| Boss | Reset | Heroic meso | Entry Lv | Slot cost |
|---|---|---|---|---|
| Hard Verus Hilla | weekly | 762,105,000 | 250 | 1 |
| Hard Will | weekly | 621,810,000 | 235 | 1 |
| Normal Damien | weekly | 169,000,000 | 190 | 1 |
| Normal Lotus | weekly | 162,562,500 | 190 | 1 |
| Akechi Mitsuhide | weekly | 144,000,000 | 200 | 1 |
| Chaos Papulatus | weekly | 132,250,000 | 190 | 1 |
| Chaos Vellum | weekly | 105,062,500 | 180 | 1 |
| Hard Magnus | weekly | 95,062,500 | 175 | 1 |
| Chaos Zakum / CQ / Von Bon / Pierre / Princess No | weekly | 81,000,000 ea | 90–180 | 1 ea |
| Normal Cygnus | weekly | 72,250,000 | 165 | 1 |
| Chaos Pink Bean | weekly | 64,000,000 | 170 | 1 |
| Easy Cygnus | weekly | 45,562,500 | 165 | 1 |
| Normal Papulatus | daily | 13,322,500 | 155 | 1 |
| Hard Mori Ranmaru | daily | 13,322,500 | 180 | 1 |
| **Normal Root Abyss (all 4)** | daily | 19,360,000 total | 125 | **4** |
| Easy Zakum | daily | 1,000,000 | 50 | 1 |
| Hard Black Mage | monthly | 4,500,000,000 | 255 | 1 |

`slotCost` exists so Normal Root Abyss is modelled correctly: 19.36M across **4** world-cap slots = 4.84M/slot, the worst ratio in the game `[high]`.

**Two known data defects to encode, not silently fix:**
- Hard Chosen Seren `[DISPUTED]`: 1,096,560,000 (maplestorywiki) vs 1,096,562,500 (NamuWiki) Heroic — a **2,500 meso** gap in Heroic terms (the research says "500", which is the Interactive-column delta). Irrelevant to advice; keep it flagged so nobody "fixes" it by guessing.
- **Gollux at every difficulty has no crystal node at all** `[medium]`. Absence is the data. Add an explicit `crystal.gollux = null` node with the note, or a future contributor will assume it was an omission.
- v.271 removed the Yakuza Boss crystal `[high]`. Delete the node; keep a tombstone in `patchLog`.

### Table B — `caps` — **the most important table, and the least verified**

| Node | Value | Confidence | Overridable |
|---|---|---|---|
| `cap.world.weeklyCrystalSales` | 180 per **world** per week, all crystal types | `[DISPUTED]` ⚠volatile | yes |
| `cap.character.weeklyCategoryCrystals` | 12 or 14 | `[DISPUTED]` ⚠volatile | **yes — default configurable, ship 14 with the dispute visible** |
| `cap.resetTime` | Thursday 00:00 UTC | `[medium]` | no |
| `cap.crystalExpiry` | 7 days from acquisition | `[high]` | no |
| `cap.pricelock` | Price fixed at acquisition, not at sale | `[high]` | no |
| `cap.partySplit` | Value ÷ party size at **map entry**, not at kill | `[high]` | no |
| `cap.damageThreshold` | Must personally deal ≥5% of boss HP (Heroic) | `[medium]` | no |

**On `cap.world.weeklyCrystalSales = 180`:** five separate verification passes refuted or failed to confirm this. Findings a developer must not lose:
- It is **per world**, not per account. An account with characters in two Heroic worlds gets **two** 180 allowances `[medium]`. **`world` must therefore be a field on the character record.** This is currently absent from the data model and is the single highest-leverage schema addition in this feature.
- The last GMS-official world-shared figure anyone could source is **60** (Nov 2021) `[low]`.
- KMS/JMS/CMS/MSEA/TMS use 90, not 180 `[medium]` — never import a KMS cap.
- A 2026-09-10 Korea-side broadcast announced the weekly sale limit is being **removed entirely** with prices re-tiered. **That is KMS. It is not in the GMS v.271 notes** (the only v.271 crystal lines are the Yakuza drop removal and a description-text addition) `[high]`. Encode this as a negative constraint so nobody "updates" the app from an MMOHuts headline.

**On `cap.character.weeklyCategoryCrystals`:** 12 is the only value with a primary source (official KMS v1.2.393 notes, July 2024) and is what Grandis Library still says for GMS; 14 is what two current wikis say and traces plausibly to a GMS-only boss count (Princess No + Akechi). No GMS patch note raising 12→14 was ever found. **Ship 14 as the default, expose the toggle, and make every derived figure recompute from it.**

### Table C — `mesoMultipliers` (non-crystal farm income)

Store as a *multiplier stack*, never as mesos/hour.

| Node | Value | Confidence |
|---|---|---|
| `farm.baseBagChance` | 0.60 | `[UNVERIFIED]` ⚠volatile — traces to a 2022 abandoned repo, region-untagged; corroborated for GMS Reboot Jan 2024 |
| `farm.dropBreakpoint` | +67% | `[UNVERIFIED]` ⚠volatile — **and the stat may be mis-named**; the source's own context reads *meso* drop rate, not Item Drop Rate. Two verifiers split on this. |
| `farm.mesoObtainedPerLine` | +20% (Lv 71+ items, **Legendary tier only**) | `[medium]` ⚠volatile |
| `farm.eligibleSlots` | Ring ×4, Pendant ×2, Earring, Face Acc, Eye Acc = 9 slots | `[high]` |
| `farm.equipmentMesoCap` | +100% (equipment **+ familiar** potential combined) | `[high]` ⚠volatile |
| `farm.consumableMesoCap` | +100%, tracked separately | `[medium]` ⚠volatile |
| `farm.innerAbilityMeso` | +18–20% at Legendary | `[low]` — whether it stacks *above* the +100% cap is unresolved |
| `farm.legionPhantomMeso` | +5% at Lv 250+ | `[medium]` |
| `farm.wapMultiplier` | ×1.2 meso, +20% IDR, 2h | `[medium]` ⚠volatile |
| `farm.heroicWorldMesoMultiplier` | **5× or 6×** | `[DISPUTED]` — wiki says 600% with the stat window erroneously showing 500% |

**Naming discipline — a verifier already conflated these two and so will a developer:**
- `crystal.heroicMultiplier = 5×` — Heroic **crystal sale value** vs Interactive `[high]`
- `farm.heroicWorldMesoMultiplier = 5× or 6×` — Heroic **mob meso drop** rate `[DISPUTED]`

These are different constants governing different income streams. Give them names that cannot be confused and add a lint/test asserting they are never read interchangeably.

### Table D — `flatIncome`

| Source | Value | Confidence |
|---|---|---|
| Ursus | 3 clears/day/account, 2× during Golden Time; ~30M/run S-rank | `[low]` — figure traces to 2021–22 |
| Ursus Golden Time window | **3 conflicting windows across sources** | `[DISPUTED]` — **tell the user to check in-game; do not render a window** |
| Maple Tour | 2 free entries/day; ~380M/week | `[low]` — 4–5 years old, treat as a floor |
| Monster Park | **negative** — extra entry costs 3,500,000 meso in Reboot | `[medium]` ⚠volatile |

The **Ursus "5×/6× buff"** circulating in search results is a **player forum suggestion (Oct 2025), not a shipped change** `[high]`. Encode as a negative constraint.

### Table E — `gates`

Per boss: `entryLevel`, `force`, `prequestChain`. The reference character is Lv 244 and **level-locked, not CP-locked**, out of everything from Gloom (Lv 245) upward `[high]`. Prequest chains are a real third gate independent of level and CP `[high]`.

### Table F — `patchLog` / negative constraints

Encode these as machine-readable `mustNotAssert` entries with tests, not as prose comments:

- Kanna's Kishin has not increased spawn since v233; Wild/Frenzy Totems are gone. **Every pre-2023 Kanna-mule farming guide is wrong** `[high]`.
- KMS "Overdrive" (20-min boss timers, HP to 2/3, crystal prices −5–10%) is **KMS-only, not confirmed in GMS at v.271** `[high]`.
- The Sept 2026 "crystal sale limit removed" story is **KMS** `[high]`.
- `digitaltq`'s crystal calculator has stale Black Mage values; `maplestory-boss-crystal-calculator.vercel.app` numbers match neither GMS nor 5×-Heroic. **Do not seed from either** `[high]`.
- v.271 changed **symbol** economics (Arcane daily 20→40, weekly 40→80) `[medium]`, not meso or crystal economics `[high]`.

---

## 1.2 Computation

### Inputs

```
Character { id, world, level, combatPower, class,
            clearedPrequests[], arcaneForce, sacredForce, authenticForce,
            mesoObtainedPct, itemDropPct }
Account   { characters[], assumptions: { perCharWeeklyCap, worldCap, heroicFarmMultiplier } }
```

`world` is required. Without it the world cap cannot be applied correctly for multi-world accounts.

### Step 1 — Feasibility per character per boss

```
canClear(char, boss) =
  char.level   >= boss.entryLevel        // [high] hard gate
  && char.force >= boss.forceRequirement // [high] hard gate
  && boss.prequestChain ⊆ char.clearedPrequests  // [high] hard gate
  && cpSignal(char.combatPower, boss)    // SOFT — see below
```

**`cpSignal` must be advisory, never a filter.** Three published CP charts disagree by up to **3.4×** in exactly the band this player sits in (Normal Lotus: 3.5M vs 7M vs 12M CP) `[low]`. Render CP as a three-state band — `comfortable` / `marginal` / `out of reach` — with all three chart values shown, and route the actual decision to **Practice Mode: 5 free attempts/day on any weekly or monthly boss, no rewards, does not consume the weekly entry** `[high]`.

*Caveat to check before shipping the Practice Mode recommendation:* the reference character's live question is Gloom at Lv 245, and Practice Mode most likely respects the level gate — in which case it cannot answer that specific question. Verify.

### Step 2 — Slot allocation (the core algorithm)

Maximize total meso subject to:
- per character: at most `perCharWeeklyCap` **weekly-category** crystals
- per world: at most `worldCap` crystals of **all** categories, `slotCost`-weighted
- daily/monthly crystals consume world-cap slots but **no** per-character weekly slots `[low]` — weakly sourced, flag it

**This is a laminar matroid** (per-character bounds nested inside a global bound), so **greedy by descending meso-per-slot is provably optimal.** No LP, no DP, no solver. Sort all feasible `(character, boss)` pairs by `heroicValue / slotCost` descending; take greedily while both caps allow.

Two things that would break optimality — check before relying on greedy:
- The **"difference of mesos" partial-credit** mechanic on higher-value weekly crystals `[low]`. If real, sale *order* stops mattering per character but still matters for the world pool. Unresolved branch.
- **7-day expiry vs Thursday reset** `[high]`/unresolved interaction. A crystal acquired Thursday 00:01 expires the following Thursday 00:01, straddling a reset. Whether it survives into the new allowance decides every "bank your crystals" recommendation. **Until settled, the planner must not advise banking crystals across a reset.**

### Step 3 — Three numbers, recomputed, never hardcoded

```
currentTake  = allocate(roster as-is)
ceiling_now  = allocate(roster with every feasible boss assumed clearable)
ceiling_true = allocate(roster at target levels/force)
```

**Recompute at build time from Table A. Do not hardcode a weekly ceiling.** The research's "~1.88B/week from the top 14 accessible weeklies" **does not reproduce** — summing its own table gives **~1.41B** `[medium, derived]`, a 33% overstatement. Likewise "~1.55B without Lotus/Damien" recomputes to **~1.12B**. And at `perCharWeeklyCap = 12` instead of 14 the same roster gives **~1.29B**. Ship a unit test asserting the displayed ceiling equals the sum of the allocator's output.

### Step 4 — Farm income as a multiplier, never mesos/hour

```
farmMultiplier = bagChance(dropPct) × (1 + mesoPct/100) × consumables × wap
bagChance(d)   = min(1.0, farm.baseBagChance × (1 + d/100))   // [UNVERIFIED]
```

Derived ladder relative to a bare character `[high, derived from UNVERIFIED inputs]`:

| Stack | Multiplier |
|---|---|
| baseline (0 drop, 0 meso) | 1.00× |
| +67% drop only | 1.67× |
| +67% drop, +100% equip meso | 3.33× |
| + 20% IA | 3.67× |
| + 5% Phantom legion | 3.75× |
| + Legion's Wealth 50% | 4.58× |
| + WAP ×1.2 | 5.50× |

**For the reference player specifically:** they hold 40% Mesos Obtained (Silver Blossom Ring 20/20). Closing to the +100% equipment cap is `2.00 / 1.40 = ` **1.43× — a permanent 43% raise on all farmed meso** `[high, derived]`. Reaching the drop breakpoint if not already there is worth up to **1.67×** and should be priced **first** `[high, derived]`.

**Never multiply this by a mesos/hour figure.** Every meso/hour number in circulation is either pre-Kishin-removal (assumes a spawn mechanic that no longer exists) or self-contradictory by ~4× between two guides on the same site `[UNVERIFIED]`. The UI shows "×1.43 on everything you farm," not "+230M/hr."

### Step 5 — Level lever

At Lv 244 the player's farming ground is Esfera/Moonbridge. Lv 250 unlocks Labyrinth of Suffering; **Lv 260 + 6th job** unlocks Cernium `[high]`. Gloom needs Lv 245 — one level `[high]`. The level lever is likely the largest single item in the whole model, and **we have no EXP numbers for it**: not 244→245, not →250, not →260, not what v.271's "EXP reduced for Lv 210–259" `[medium]` numerically amounts to, and no EXP/hour at this level band. **Slice 3 ships the lever as an ordered recommendation with no time estimate attached.** See Open Questions.

---

## 1.3 UI, in shipping order

### Slice 1 — **Crystal Ledger** (cheapest useful slice; ships value on day one)

One table, one number, one instruction. Requires only Tables A + B and the greedy allocator.

```
This week you can sell 42 of 180 crystals in Kronos.        [assumptions ▾]

SELL THESE (highest meso per slot)
  Archerroni   Chaos Papulatus          132.25M
  Archerroni   Chaos Vellum             105.06M
  ...                                   14 slots used

DO NOT SELL
  Normal Root Abyss ×4       19.36M across 4 slots (4.84M/slot)
  — worst ratio in the game. Clear it for coins if you want; don't sell the crystals.

Weekly total if you clear all of the above:  1.41B
```

Non-negotiable elements of Slice 1:

- **Assumptions drawer, always one click away, never hidden.** Shows `perCharWeeklyCap` (14 `[DISPUTED]`, toggle 12/14), `worldCap` (180 `[DISPUTED]`, editable), and for each a one-line "why this is disputed" with both source links. Changing either recomputes everything on screen immediately.
- **"Verify in game" callout.** The Collector NPC displays a record of weekly crystals sold this week. That readout beats every source we have. One sentence telling the player to check it and correct the assumption, with a link straight into the drawer.
- **Per-world grouping.** Characters group by world; each world gets its own allowance. If the roster is single-world this is invisible; if not, it prevents a 2× error.
- **Solo-is-better banner.** Crystal value divides by party size at **entry**, and leaving mid-fight does not restore your share `[high]`. In Heroic, solo is always the max-meso clear.

### Slice 2 — **Meso Ceiling** (needs Tables C + D)

A single horizontal bar: *current take* → *ceiling*, with the gap decomposed into named, clickable segments.

```
Weekly meso                                     [assumptions ▾]
██████████████░░░░░░░░░░░░░░░░  1.41B of a possible ~2.6B

  Crystals, slots you can't fill yet     +0.6B   → bosses you can't clear
  Farm multiplier 1.40 → 2.00           ×1.43    → 3 more 20% meso lines
  Drop breakpoint                       ×?       → CHECK YOUR DROP%
  Ursus / Maple Tour                     ~?      → figures are 4–5 yrs old [low]
```

Every segment renders its confidence tag. Segments built on `[UNVERIFIED]` inputs render greyed with the tag inline — visible, honest, still useful as an ordering.

### Slice 3 — **Next Action** (needs the allocator + gates)

Exactly one card. Ranked by *(estimated meso delta) × (confidence)*, not by meso delta alone — so a `[high]` 1.43× farm upgrade outranks a `[low]` Ursus optimisation even at similar headline value.

For the reference player the card should currently read approximately:

> **Get to Lv 245.** You are one level from Gloom (297.68M/week `[high]`), the highest-value weekly you cannot currently enter. Everything above it is level-locked too: Verus Hilla 250, Darknell 255, Seren 260. *We cannot yet estimate how long this takes — see the EXP gap in Open Questions.*
>
> Runner-up: **three more 20% Mesos Obtained lines** (40% → 100% cap) = ×1.43 on every meso you farm, permanently `[high]`.

Card explicitly names what it is **not** telling you to do and why: "We're not telling you to run daily bosses. With your roster, daily crystals would consume world-cap slots worth ~130M each for ~5–13M each."

### Slice 4 — Roster view (deferred)

Per-character slot usage across the world allowance. **Blocked on a real input we don't have:** the roster's level distribution. 5,039 levels / 31 characters ≈ **Lv 162 average** — a Lv 162 mule cannot clear Chaos Papulatus, Akechi, or Lotus, so the "31 × 14 = 434 potential weekly crystals" framing is fiction. Slice 4 needs per-character level and world captured first, which is what Feature 2's profile store provides. **Sequence Feature 2 before Slice 4.**

---

# FEATURE 2 — ACCOUNTS, PROFILE, BILLING

## 2.1 Recommended stack — one recommendation

> **Better Auth + Neon Postgres, deployed on Vercel. No in-app billing. Donations via a Ko-fi link only, at least initially.**

### Reasoning

**Auth: Better Auth.** Auth.js/NextAuth was absorbed by Better Auth, and Vercel acquired Better Auth on 2026-07-07 `[high]`; Auth.js now receives security patches rather than features `[low, secondary sources only]`. Better Auth is MIT, self-hosted inside the Next.js app, and costs **$0 at any user count** `[high]`. Sessions and profile rows both live in our own Postgres, which means the `Store` interface stays untouched behind our own API routes.

**Database: Neon.** Vercel Postgres no longer exists — stores migrated to Neon via the Vercel Marketplace across Q4 2024/Q1 2025 `[medium]`, so that comparison branch collapses. Neon free tier: 100 CU-hours, 0.5 GB storage `[high] ⚠volatile`. Paid is pure usage-based with **no monthly minimum** `[high] ⚠volatile` — the right shape for a niche tool with bursty Reddit-driven traffic.

**Why not Supabase:** free projects **pause after 1 week of inactivity** `[high]`, which is a real operational hazard here and effectively forces the $25/mo before it is technically needed. Moderate lock-in (Auth, RLS, client SDK are not portable).

**Why not Clerk:** auth only — we still pay for a database on top, making it the most expensive at scale (~$65/mo at 10k users vs ~$40 for Better Auth + Neon and ~$45 for Supabase `[medium, my arithmetic — not a vendor quote]`). It is also the hardest to leave: user identity lives in Clerk, and migrating means re-mapping every user ID and forcing an OAuth re-link `[medium]`. Its free tier is genuinely generous (50k MRU, billed on *retained* users so a one-visit Reddit click is never billed `[high]`) but is not production-grade: no MFA, no passkeys, Clerk branding, 7-day sessions `[high]`.

**Billing: don't, yet.** Two reasons, one legal and one cultural:

1. **Vercel Hobby forbids commercial use**, defined to include *"any method of requesting or processing payment from visitors of the site"* `[high]`. The moment MaplePlanner takes money, Hobby is off the table and Pro is $20/seat/mo `[high] ⚠volatile`. But Vercel **explicitly exempts donations** `[high]` — a Ko-fi link keeps the app free-tier-legal.
2. **MapleStory community tooling has effectively no paid-gating precedent.** MapleTools is free with Ko-fi only; Maple Meta Calculator is free with a $3 Patreon `[medium]`. The closest analogues in other games — WoWAnalyzer, Warcraft Logs — keep *all analysis* free and sell ad-removal, priority queue, higher API limits, cosmetics `[low]`. Charging is a visible norm-break this app has to earn.

**If billing ever happens: hosted Stripe Checkout or Payment Links only. The app never sees or collects payment details.** Per-transaction fixed fees are the real enemy at game-tool price points — at $5/mo, Stripe direct is ~9.6% effective, Stripe Managed Payments ~13%, Paddle ~15% `[medium, derived]`. The $0.30 fixed fee is 6.0% of a $5 charge and 0.6% of a $50 annual charge `[high]` — **a one-time lifetime unlock or an annual plan is worth more than any processor choice.** A one-time unlock also avoids Stripe Billing's 0.7% entirely `[high] ⚠volatile`.

### A licensing constraint that shapes the product, not just the bill

**Nexon Open API terms §8.13 prohibits commercial use without prior written agreement, and names paid premium features specifically** `[high]`. §8.7 additionally imposes a **30-day maximum TTL on all Nexon game data** `[high]`, which would directly constrain what a profile can persist.

**Therefore: staying screenshot-only is a licensing feature, not just a UX choice.** If MaplePlanner never calls the Nexon API, neither constraint applies. **Verify whether the current codebase calls it at all before any billing work begins** — this was never checked.

If billing is ever built and the Nexon API is ever used, the eventual terms/privacy pages also need a "not affiliated with Nexon" disclaimer, matching MapleTools' practice `[medium]`.

---

## 2.2 Implementation sequence

### Slice 1 — `Store` interface hardening (no auth, no accounts, ships alone)

Before adding a backend, make the existing localStorage implementation satisfy a stable async interface. Everything after this is an adapter swap.

```ts
interface Store {
  getProfile(): Promise<Profile | null>
  putProfile(p: Profile): Promise<void>
  listCharacters(): Promise<Character[]>
  putCharacter(c: Character): Promise<void>
  deleteCharacter(id: string): Promise<void>
  getAssumptions(): Promise<Assumptions>   // the disputed crystal caps live here
  putAssumptions(a: Assumptions): Promise<void>
  export(): Promise<StoreSnapshot>         // needed by the merge in Slice 3
  import(s: StoreSnapshot, mode: 'replace'|'merge'): Promise<void>
}
```

Make every method async **now**, even against localStorage, so the later swap is not a refactor. Add `schemaVersion` to `StoreSnapshot` on day one. Add `world` to `Character` here (Feature 1 §1.2 depends on it).

### Slice 2 — Neon + schema + `ApiStore`, behind a flag

Provision Neon, write the migration, implement `ApiStore` against Next.js API routes. Ship it behind a flag with **no login** — anonymous session cookie only. This proves the storage path before auth is in the way.

Schema, minimum:

```sql
users(id, email, created_at)
profiles(user_id, display_name, default_world)
characters(id, user_id, name, world, level, combat_power, class,
           arcane_force, sacred_force, authentic_force,
           meso_obtained_pct, item_drop_pct, cleared_prequests jsonb,
           updated_at)
assumptions(user_id, per_char_weekly_cap, world_cap, heroic_farm_multiplier,
            updated_at)
snapshots(id, user_id, character_id, taken_at, payload jsonb)  -- gear history
```

`assumptions` is a real table, not a config constant. The disputed caps are per-user state by design.

### Slice 3 — Auth + **claim-on-first-login merge**

**This is the single most likely bug in the whole feature and it has no vendor solution** `[medium]`. Today's data is in localStorage. Without an explicit merge, users sign in and appear to have lost their characters.

Required flow, exactly once per browser per account:

1. On successful first login, read the complete local snapshot via `Store.export()`.
2. If non-empty, **show it to the user before writing anything**: "We found 31 characters saved in this browser. Add them to your account?" — with Merge / Replace / Discard, and a downloadable JSON copy.
3. On confirm, `POST` to `ApiStore.import(snapshot, mode)`.
4. Only after a `200`, clear local state and set a `claimed:<userId>` marker.
5. On failure, **keep local state untouched** and retry later. Never clear first.

Conflict rule: `characters` are keyed by `(user_id, world, name)`; last-write-wins on `updated_at` with the losing row preserved in `snapshots` for one release cycle.

This flow is identical whichever auth vendor is chosen — it is our problem regardless.

**Providers, in order of expected conversion for this audience: Discord first, Google second.** MapleStory's community lives on Discord.

### Slice 4 — Gated capacity, *not* gated advice (only if monetising)

Derived from the WoWAnalyzer / Warcraft Logs precedent `[low]`: gate **convenience, capacity, automation, and vanity** — never the "what to do next" recommendation. Candidates:

- storage and history (more than N characters; gear snapshots over time; progression graphs)
- automation (scheduled re-scan; Discord alert when a boss or symbol threshold is met)
- export (CSV / image / share cards)
- cosmetics

Single-character analysis stays free and unauthenticated, forever.

### Slice 5 — Payments, hosted only (only if Slice 4 proves demand)

Upgrade Vercel to Pro **first** (required before any paid feature goes live `[high]`). Then a **Stripe Payment Link** for a one-time lifetime unlock — genuinely zero-code, no webhook strictly required if reconciled manually; upgrade to Checkout + one webhook when volume justifies it `[medium]`.

**The app must never render a card field, never accept a card number, and never store one.** The user leaves for Stripe's hosted page and comes back. This is non-negotiable regardless of what the billing UI would look like.

Merchant-of-record (Paddle or Stripe Managed Payments) removes EU/UK VAT filing — owed **from the first sale with no threshold** if we are our own merchant `[high]` — but adds an eligibility review that **can be refused** `[high]`, restricts us to Checkout/Payment Links only, shows `LINK.COM*` rather than MaplePlanner on statements, and hands Stripe authority to refund without our approval if we don't respond within 48 hours `[high]`. Paddle additionally flags sub-$10 products as needing custom pricing `[high] ⚠volatile` — exactly our price band. **Do not design the billing flow assuming MoR approval.**

---

## 2.3 Prerequisites — owner only, cannot be done by a developer

Nothing below can be delegated to application code. Each blocks the slice named.

**Blocks Slice 2**
1. **Neon account** + project provisioned; connection string into Vercel env vars. Free tier is sufficient at 0–100 users `[high] ⚠volatile`.
2. **Vercel account** with the project deployed. Hobby is fine *only while the app takes no payment* `[high]`.

**Blocks Slice 3**
3. **Discord Developer Portal application** — client ID, client secret, OAuth2 redirect URI. Highest-value item on this list for this audience `[medium]`.
4. **Google Cloud project** — OAuth consent screen configured and moved from **Testing to In Production**. Testing caps the app at **100 users** `[medium] ⚠volatile`. With only `email`/`profile`/`openid` (non-sensitive scopes) no verification audit is required `[medium]`.
5. **Domain + DNS access at the registrar.** If magic-link/email login is used, SPF/DKIM records must be added to verify a sending domain `[medium]`.
6. **Published Terms of Service and Privacy Policy URLs** `[high]`. Required by Google's consent screen before production publishing, and surfaced by Stripe Checkout later. The privacy policy must state whether uploaded screenshots are persisted and for how long — a decision nobody has made yet (see Open Questions).

**Blocks Slice 5 (only if monetising)**
7. **Vercel Pro upgrade** with a payment card on the team — $20/developer seat/month `[high] ⚠volatile`. Must precede any paid feature going live.
8. **Stripe account activation** — legal business identity, bank account, tax ID. Then live secret key, publishable key, webhook signing secret, price IDs, Customer Portal config, all stored as Vercel env vars `[high]`.
9. **Stripe Managed Payments eligibility review** and an assigned product tax code, *if* MoR is chosen. Can be refused `[high]`.

**Blocks nothing; do early and cheaply**
10. **Ko-fi (or Patreon) account.** Donations are explicitly exempt from Vercel's commercial-use definition `[high]`, so this is the one monetisation path that requires no plan upgrade and no norm-break.

---

# Open questions

Must be settled before build. Grouped by what they block.

### Blocks Feature 1 Slice 1 (the Crystal Ledger)

1. **What is the real per-character weekly crystal cap in GMS Heroic — 12 or 14?** `[DISPUTED]` No Nexon patch note raising 12→14 was ever found. Two current wikis say 14; Grandis Library says 12; the only primary source (KMS, Jul 2024) says 12. **Settleable in ~30 seconds in-game:** the Collector NPC shows a record of weekly crystals sold this week. Ship the toggle regardless.
2. **What is the real world cap, and is it per world or per account?** `[DISPUTED]` 180 could not be traced to any official or GMS-confirmed source across five verification passes; the last GMS-official world-shared figure anyone found is 60 (2021). Also in-game-checkable.
3. **Does a crystal acquired just after Thursday reset survive the *next* Thursday reset?** 7-day expiry vs weekly reset. Decides whether "bank your crystals" is ever correct advice. Currently unresolved — until settled, the planner must not suggest banking.
4. **Is the per-character count by sale or by acquisition, and do both caps reset at the same instant?**
5. **Does the "difference of mesos" partial-credit mechanic on higher-value weekly crystals exist?** `[low]` If it does, sale order stops mattering per character — a branch in the allocator nobody has chosen.
6. **Do daily and monthly crystals really consume zero per-character weekly slots?** `[low]` — only weak corroboration, and the whole daily-boss conclusion depends on it.

### Blocks Feature 1 Slice 2/3 (Ceiling, Next Action)

7. **Is `farm.dropBreakpoint` measured in Item Drop Rate or Meso Drop Rate?** `[UNVERIFIED]` Two verifiers reached opposite readings of the same source. The advice "stack drop rate to +67%" is either right or points the player at the wrong stat entirely.
8. **Is the Heroic mob meso multiplier 5× or 6×?** `[DISPUTED]` The wiki says 600% with the stat window erroneously showing 500%. If OCR reads the stat window, this is also an OCR trap.
9. **Does Inner Ability's %Mesos Obtained stack above the +100% equipment cap?** `[low]` Decides whether IA is a real lever or already counted.
10. **Do familiar meso lines count against the +100% cap, or are they a separate "meso drop rate" stat?** The two published framings cannot both be right, and the answer decides whether familiars are worth building for meso at all.
11. **EXP required for 244→245, →250, →260 at v.271, and EXP/hour at Esfera/Moonbridge.** The single most actionable recommendation in the product currently has no time estimate attached. Also: what did v.271's "EXP reduced for Lv 210–259" numerically amount to?
12. **Does Practice Mode respect the boss level gate?** If it does — likely — it cannot answer the Gloom-at-244 question the research assigns it, and the readiness-test recommendation needs rewording.
13. **Boss clear times at any power level in GMS Heroic.** None exist in any source. The app's natural output unit is hours; we have no denominator. Until then, rank strictly by meso-per-crystal-slot (which *is* sourced) and never claim meso-per-minute.

### Blocks Feature 1 Slice 4 and Feature 2 schema

14. **Which world(s) do the 31 characters live in?** Multi-world doubles the allowance. Must be captured per character.
15. **What is the actual level distribution of the 31 characters?** Average Lv 162 means most cannot clear the bosses the allocator wants to assign them.

### Blocks Feature 2 costing and Slice 5

16. **Does MaplePlanner currently call the Nexon MapleStory Open API?** Never checked. If yes, §8.13 (no commercial use) and §8.7 (30-day data TTL) both bind, and the billing plan changes shape.
17. **What is the per-upload vision/OCR inference cost?** The entire $40/mo-at-10k-users estimate is database arithmetic. If screenshot parsing is model-based, inference is the dominant unit cost and the estimate is wrong by an unknown factor. **This is the largest hole in the billing analysis.**
18. **Are screenshots persisted at all, and for how long?** Nothing decided. Determines object-storage cost, Neon sizing, and what the privacy policy must say — which is itself a Slice 3 blocker.
19. **Does a subscription created via a Stripe Payment Link incur the 0.7% Billing fee?** Stripe's docs confirm Payment Links create Subscription objects; no page states the fee treatment explicitly.
20. **Is Neon purchased via the Vercel Marketplace billed at Neon-direct rates?** No primary page confirming rate parity was found.
21. **Nexon's fan-content / ToS stance on screenshot-derived tools.** MapleTools ships a "not affiliated with Nexon" disclaimer; nobody checked what obligation that reflects.

### Not blocking, but will cause a wrong "update" later if unwritten

22. **If GMS ever inherits the KMS crystal changes** (tier-wide price cuts, removal of the per-character weekly limit), the entire value table and the optimal strategy invert at once — from "cap-allocate across mules" to "clear everything you can." Every crystal node needs a visible `verifiedAt` and the app needs a staleness banner, not a silent stale table.
23. **Does the v.271 3,000,000-meso bonus-stat reset apply bonus stats to an item that has none, or only re-roll existing ones?** Decides whether Rebirth Flames are needed in Heroic at all — relevant to Feature 1's ceiling if meso *sinks* are ever modelled alongside income.

---

# Completeness critic

# COMPLETENESS CRITIQUE — MaplePlanner research backlog

## 1. The core input pipeline has zero research behind it

The app's premise is "concrete advice from screenshots of gear." Nothing in four dimensions of research touches the screenshot path. Missing entirely:

- **No item database.** No GMS item name list, level table, set-effect table, or icon reference. You cannot map a screenshot region to "Silver Blossom Ring, Lv 110, 20/20 meso" without one. The research *assumes* the player's gear is known (it cites the Silver Blossom Ring at 40% meso) but never says where that fact comes from in-product.
- **No OCR/vision approach, cost, or accuracy budget.** If parsing is model-based, inference cost per upload is the dominant unit economic — and the entire `stack` billing analysis is built on a database-cost model ($20/mo Neon at 10k users) that ignores it. The Neon estimate is arithmetic on storage; the real bill is vision calls.
- **No screenshot storage decision.** Object storage appears in no finding. Neither does retention, nor whether screenshots are persisted at all — which determines both the Neon sizing and the privacy policy the `stack` dimension correctly says you need.
- **A known OCR trap is flagged and abandoned:** `nonCrystal` notes the stat window "shows 500% when the real value is 600%." That is exactly the kind of field an OCR pipeline will read and trust. Nobody enumerated which displayed stats are unreliable.

## 2. There is no damage or combat-power model, so the app cannot rank anything

This is the structural hole. The research prices every upgrade and values none of them.

- **No combat power formula.** CP thresholds are quoted from three charts that disagree 3.4x, but CP itself is never defined. There is no CP-per-star, CP-per-cube-line, CP-per-symbol-level, or CP-per-main-stat figure anywhere. The app cannot say "do this and your CP goes from 5.26M to X."
- **No damage formula at all** — main stat, ATT, %boss, %final damage, crit damage appear nowhere.
- **IED is used as a gate and never explained.** The charts cite 93/95/96 IED. IED stacks multiplicatively — `1-(1-a)(1-b)…` — so marginal value collapses near the top and depends entirely on current total. Advice to "get IED" without that formula is wrong advice.
- **Star Force stat gains are missing.** `sinks` prices 0→22★ at ~13.9B + 7 booms, and 0→17★ at ~0.68B, and never states what 22★ gives over 17★. That difference *is* the decision.
- **Flame tiers are unquantified.** "Tier 1-4" vs "Tier 2-5" vs "Tier 4-7" is stated repeatedly, but no finding says what a tier is worth in stat. The headline v.271 claim — that the 3M reset makes the 9.5M flame obsolete — is therefore unpriced.

Consequence: the four dimensions share no common currency. A builder cannot answer "starforce, cubes, symbols, or level?" — which is the only question the product exists to answer.

## 3. The headline roster numbers do not reproduce from the research's own table

I summed the 14 accessible weeklies listed in `rosters` (N.Damien 169.00 + N.Lotus 162.56 + Akechi 144.00 + C.Papulatus 132.25 + C.Vellum 105.06 + H.Magnus 95.06 + C.Zakum 81.00 + C.CQ/VonBon/Pierre 81.00 ea + Princess No 81.00 + N.Cygnus 72.25 + C.Pink Bean 64.00 + H.Hilla 56.25):

**~1.41B/week, not the claimed ~1.88B.** Off by ~33%. The "~1.55B if Lotus/Damien are not clearable" figure computes to ~1.12B. Both stated with [medium] confidence and neither is derivable from the value table in the same dimension. Do not ship either.

Related: the Chosen Seren discrepancy is described as "500 mesos on Hard." In the Heroic column it is **2,500** (219,312,000 vs 219,312,500, ×5).

## 4. The daily-boss arithmetic nobody did — and it inverts the routine advice

`crystals` establishes that all crystal types draw from the same 180, and `rosters` lists ~15 daily bosses. Daily bosses reset **daily**, so one character running them generates roughly 18 crystals/day ≈ **126 crystals/week from a single character** — 70% of the entire world allowance, for maybe 100-150M total.

Meanwhile 13 characters × 14 weekly slots = 182 > 180. The derivable rule is stark and appears nowhere: **once ~13 characters can clear weeklies, daily boss crystals are worth exactly zero and should never be sold.** The research says only that dailies are "a poor use of slots." A builder reading the daily boss table will implement a daily-boss checklist that actively destroys meso.

## 5. The roster's level distribution — the one input that makes the plan real — was never captured

`rosters` computes "31 characters × 14 weekly slots = 434 potential weekly crystals." With 5,039 total levels across 31 characters, the average is **Lv 162**. A Lv 162 mule cannot clear Chaos Papulatus, Akechi, or Lotus. The 434 figure is fantasy, and the "push Easy Cygnus/Hard Hilla onto mules" advice is unverifiable without knowing how many characters clear which tier.

Related, never asked: **which world(s)?** The 180 cap is per world. If the 31 characters span Kronos and Hyperion, the account has 360 slots, not 180. `world` appears in no data model discussion.

## 6. Level-gating is the #1 recommendation and has no numbers

Both `rosters` and `nonCrystal` conclude the biggest lever is 244→245 (Gloom), →250 (Labyrinth), →260 (Cernium + 6th job). Nobody sourced:
- EXP required for 244→245, →250, →260 post-v.271.
- What v.271's "EXP reduced for Lv 210-259" actually amounts to numerically.
- EXP/hour at Esfera or Moonbridge at Lv 244.

The single most actionable piece of advice in the entire backlog cannot be turned into a time estimate.

## 7. Entire progression systems are absent

Not "under-sourced" — absent:
- **HEXA / 6th job / Sol Erda / Sol Erda Fragments.** v.271 shipped HEXA Common Nodes (noted in passing, never researched). Sol Erda Fragments are the main *non-meso* justification for drop rate above 67% — mentioned twice, never quantified.
- **Symbol force tables.** `rosters` gates Normal Will at 760 ARC and Normal Lucid at 360 ARC; `sinks` gives meso cost to max symbols; `nonCrystal` reports the v.271 reward doubling. Nobody supplies force-per-symbol-level or a days-to-target calculation, so the ARC gate cannot be forecast.
- **Legion board, link skills, inner ability, guild skills, Monster Collection, Union artifact, Mu Lung Dojo, Boss Arena/Grandis coins.** The player has 8 SS-rank characters and 5,039 levels — a large Legion asset that is referenced only via a single +5% Phantom meso line.
- **AbsoLab coin acquisition rate.** `sinks` correctly notes AbsoLab costs 0 mesos, then never says how many Lotus/Damien clears produce the 19 coins needed — or how a Heroic player obtains the ~7 spare copies the 22★ Mode-1 path consumes.

## 8. Internal contradictions a builder will hit on day one

- **Star Force formula is arithmetically broken as written.** `cost = 1000 + round(L^3 × (S+1)^2.7 / D)` with "D for stars 0-9 = (S+1)^1/25" evaluates to 25 × L³ × (S+1)^1.7 — off by 600-3,000×. Stars 0-9 need **exponent 1**, not a modified divisor. This is a literal implementation bug sitting in the backlog; a verifier caught it, but the original bullet is the one a builder will copy.
- **Two Lv 150 cost tables disagree.** 14→15 is 67,400,800 in one bullet and 67,393,000 in a verifier recompute; 15→16 is 30,087,200 vs 30,099,300. The rounding rule (floor vs round; +10 then ×100 vs round-to-100-then-+1000) is unresolved. Pick one and document it.
- **5x vs 6x.** `crystals` says Heroic crystal *sale value* is 5x Interactive. `nonCrystal` says the Heroic *mob meso drop* multiplier is 600%. These are two different constants and no finding says so plainly — a verifier already conflated them. Name them separately in the schema or this bug is guaranteed.
- **12 vs 14 weekly crystals per character.** Unresolved across dimensions (`crystals` says 14 medium-confidence, `nonCrystal`'s last bullet says 12), and the entire main-character routine and weekly-ceiling estimate are built on 14. Make it configurable, as the research itself recommends — but also make the *ceiling estimate* recompute from it, which the current numbers don't.
- **Enhancement Mode vs Safeguard.** `sinks` says Enhancement Mode "replaces Safeguard for 15-21★," then separately describes Safeguard as live at 15-17★ at +200%, then says Mode 4 is unavailable at 15-17★ "because it is identical to Safeguard there." Whether the player sees one control or two is unanswered, and the mode multipliers come from a fan calculator with no official table.
- **Practice Mode is recommended as the readiness test without checking it applies.** The player is Lv 244 and the open question is Gloom (Lv 245). If Practice Mode respects the level gate — which is likely — it cannot answer the exact question the research assigns it.
- **Chance Time is never mentioned.** GMS guarantees success after consecutive fails. A verifier notes its omission shifts the 19★ share of 17→22 spend from ~27% to ~33%. Every expected-cost figure in `sinks` omits it.

## 9. Mechanics that change core algorithms and remain unresolved

- **Crystal "difference of mesos" partial credit** [low]. If the per-character cap pays "the top 12/14 Weekly crystals you sell," sale *order* is irrelevant per character but decisive for the 180 world pool. This is a branch in the allocation algorithm and nobody chose it.
- **7-day expiry vs Thursday reset interaction.** A crystal acquired Thursday 00:01 expires the following Thursday 00:01, straddling a reset. Whether it survives into the new allowance determines all "bank your crystals" advice.
- **Whether the per-character count is by sale or by acquisition**, and whether both caps reset at the same instant.

## 10. The optimization problem is never stated

The app must solve: *maximize weekly meso subject to* 180/world, 12-or-14 weekly/character, per-character clear feasibility, 7-day expiry, and a time budget. That is a constrained knapsack. No finding frames it, and two of its five constraints (per-character feasibility, time) have no data at all. `rosters` explicitly flags that **no boss clear time exists for GMS Heroic at any power level** — which means the app's output unit (hours) has no denominator anywhere in the research.

## What is solid — take it and move on

- **`stack` is decision-ready.** The Vercel commercial-use blocker, the Nexon §8.13 licensing consequence for staying screenshot-only, the Better Auth/Neon vs Supabase vs Clerk cost arithmetic, the fixed-fee analysis at $5/mo, and the localStorage claim-on-first-login merge warning are all actionable as written. Two gaps: vision-inference cost is missing from every estimate (see §1), and nobody checked Nexon's fan-content/ToS stance on screenshot-derived tools despite noting MapleTools ships a "not affiliated" disclaimer.
- **The Heroic crystal value table is internally consistent.** I spot-checked the ×5 derivation across tiers (Chaos Zakum 16.2M→81M, Hard Verus Hilla 152.421M→762.105M, Easy Lucid 47.401875M→237.009375M, Extreme Kaling 1.2052B→6.026B) — all exact. The *values* are trustworthy; the *caps* are not.
- **The meso-multiplier derivation in `nonCrystal`** (0.60 × 1.67 = 1.00; 40%→100% = 1.43x; the 5.50x full-kit stack) is clean arithmetic and the right shape to ship — as a relative multiplier, never as mesos/hour.
- **The stale-guide warnings are the most valuable output here**: Kanna/Kishin spawn removal (v233), the Ursus 5x/6x "buff" being a forum suggestion, the KMS-vs-GMS firewall on Overdrive and the Sept 2026 crystal rework, and the two public crystal calculators being unusable. Encode these as negative constraints in the codebase, not just prose.

---

# Disputed claims (21)

### [crystals] Weekly crystal sale cap is 180 crystals per world per week in GMS, shared across the whole account (all characters in that world), not per character

- **Stated:** 180 crystals / world / week (account-wide)
- **Why refuted:** Refuted on provenance and on the "not per character" assertion. Four problems:

(1) THE CITATION IS UNVERIFIABLE. https://maplestorywiki.net/w/Intense_Power_Crystal returned HTTP 403 to WebFetch, to its api.php endpoint, and browser navigation was denied. I could not confirm the page says 180, or says it about GMS. A number nobody can open is not a source. maplestorywiki.net is also a multi-region wiki that routinely documents KMS values without region tags.

(2) THE 180 FIGURE TRACES TO A KMST DISCUSSION, NOT AN OFFICIAL GMS SOURCE. The only place I found 180 in context is a January 2025 player post on the official forums (https://forums.maplestory.nexon.net/discussion/35048/january-2025-kmst-feedback), which introduces it while discussing "the most recent KMST (Korea MapleStory Test Server)" and argues "if the Boss Crystal Sell Limit was cut in half to 90 from 180 would make the GMS audience extremely angry." That post is a GMS player reacting to a KOREAN TEST SERVER proposal. It is one player's assertion, not a Nexon patch note, and it is exactly the KMS-to-GMS import path the task warns about. I found no Nexon-authored text stating 180 anywhere. Nothing in any source tied 180 specifically to Heroic/Reboot as opposed to regular GMS worlds.

(3) THE "NOT PER CHARACTER" CLAIM IS CONTRADICTED. GMS sources document a per-character cap that binds far below 180. https://forums.maplestory.nexon.net/discussion/34937/boss-crystals (Nov 2024) discusses a cap of 12 crystals per week with players asking for 14, and separately mentions a "180 boss crystal account cap" — i.e. BOTH exist, a per-character limit and an account ceiling. https://forums.maplestory.nexon.net/discussion/35424/boss-crystal-sell-limit (Jul 2025) has a player unable to sell after "about 12 bosses this week," which is impossible under a 180-only cap. Historically the per-character number was 60 (https://forums.maplestory.nexon.net/discussion/22210/boss-crystal-limit, Reboot-specific, 2018-2020). The claim states the cap is account-wide "not per character," which inverts the constraint that actually matters: for Archerroni as a single main, the binding limit is the per-character weekly cap (~12-14), not 180. A planner built on this claim would tell the player they have ~180 crystals of headroom when they may have ~12-14 on that character.

(4) v.271 IS TWO DAYS OLD AND TOUCHED EXACTLY THIS SYSTEM. Every source above predates v.271 (2026-09-09); the newest is July 2025. I could not read the official v.271 notes (https://www.nexon.com/maplestory/news/update/44597/... is a JS app returning an empty shell to WebFetch) and my WebSearch budget ran out. A search summary and a Sept 2025 Heroic suggestion thread (https://forums.maplestory.nexon.net/discussion/35478/heroic-and-interactive-progression-improvement) both reference Heroic boss crystal sell value moving "from 5x to 6x to match the Heroic World's mesos multiplier passive" — I confirmed the 5x Reboot multiplier independently via https://www.digitaltq.com/maplestory-boss-crystal-calculator, but could NOT confirm the 6x landed in v.271. If v.271 was tuning Heroic crystal economics, any pre-patch cap figure is unverified for the player's current patch.

volatile: true (a weekly cap and a sell multiplier are both patch-tunable; KMST has already proposed halving this one to 90).

NOTE: I am not asserting 180 is false. It may well be the correct account/world ceiling in GMS. I am asserting it is UNSOURCED to an official or GMS-confirmed source, wrong in claiming no per-character limit exists, and unverified against v.271 — which per the task's rules means it must not ship in the planner as stated.
- **Correction:** COULD NOT VERIFY A SINGLE NUMBER — do not ship one. Best reconstruction from GMS player sources (all unofficial, all pre-v.271, all should be re-checked in-game): GMS appears to use a TWO-TIER cap, not one. (a) A per-character weekly cap on Intense Power Crystals, ~12 with 14 discussed as an increase (https://forums.maplestory.nexon.net/discussion/34937/boss-crystals, Nov 2024; corroborated by a player capping out after ~12 bosses in https://forums.maplestory.nexon.net/discussion/35424/boss-crystal-sell-limit, Jul 2025) — historically 60 per character in Reboot (https://forums.maplestory.nexon.net/discussion/22210/boss-crystal-limit). (b) An account/world ceiling referenced as 180, but sourced only to player posts, one of which is discussing a KMST proposal to halve it to 90 (https://forums.maplestory.nexon.net/discussion/35048/january-2025-kmst-feedback). Separately confirmed and more useful for Heroic: Reboot/Heroic crystals sell at a 5x multiplier vs regular servers (https://www.digitaltq.com/maplestory-boss-crystal-calculator), with an unconfirmed 5x->6x change associated with v.271. RECOMMENDED ACTION: have the player open the Collector NPC in-game on Heroic and read the actual remaining-sales counter, which states the real current cap and its scope; until then MaplePlanner should surface "per-character weekly crystal cap applies — verify in game" rather than any hard number.

### [crystals] Weekly crystal sale cap is 180 crystals per world per week in GMS, shared across the whole account (all characters in that world), not per character

- **Stated:** 180 crystals / world / week (account-wide)
- **Why refuted:** REFUTED on two independent grounds, and unverifiable on a third.

(1) The "account-wide, not per character" framing is wrong. A per-character weekly boss-crystal cap demonstrably exists in GMS: forums.maplestory.nexon.net/discussion/34937/boss-crystals (Nov 2024) is a GMS thread about a 12-crystals-per-character weekly cap with requests to raise it to 14, including Reboot meso math in replies. Whatever the world total is, no single character approaches it — reaching 180 would take roughly 13-15 bossing mules. For a planner advising one Lv 244 Bow Master, the binding constraint is the per-character cap, not 180.

(2) The 180 figure is KMS-sourced, not GMS-sourced. The only corroboration found is Korean NamuWiki (en.namu.wiki/w/%EA%B0%95%EB%A0%AC%ED%95%9C%20%ED%9E%98%EC%9D%98%20%EA%B2%B0%EC%A0%95, ~June 2026, KMS Overdrive): world total "remains the same at 180," per-character 12 -> 14. KMS numbers are not GMS numbers. The only GMS-official figure I located is older and different: forums.maplestory.nexon.net/discussion/31841/intense-power-crystal-limit-per-character (Nov 2021) documents 60 crystals shared across all characters in a world ("It is only allowing 60 to be shared across ALL characters of the same world"), with no Nexon confirmation of a later rise to 180 in GMS.

(3) The cited source could not be read at all: maplestorywiki.net/w/Intense_Power_Crystal returned HTTP 403 on every attempt, including ?action=raw. It is a community wiki with no visible server or patch stamp. Nothing in it is verified.

Staleness/patch risk: the official v.271 notes (nexon.com/maplestory/news/update/44597) returned only the site shell; the community mirror at 7mmo.com/threads/v-271-maplestory-x-frieren-beyond-journeys-end-patch-notes.3873/ contains no mention of boss crystals, crystal sale limits, or meso economy — it is Frieren collab, HEXA, familiars, Sol Hecate skins and skill balance. Meanwhile mmohuts.com/news/maplestory-september-update-reworks-combat-feel-boss-crystals-and-teases-blue-archive-collab (2026-09-10) reports: "Boss Crystal sell prices are being adjusted by tier, and the weekly Boss Crystal sale limit is being removed, though boss clear limits remain." Honest caveat: that broadcast is Korea-side (the same article announces an escape-room cafe near Hongdae, Seoul), so it is KMS-facing and does NOT establish that GMS v.271 shipped the removal — but it does mean the number is actively in motion in the exact window the claim asserts it as current.

VOLATILE: true. Both the per-character cap and any world cap are patch-tunable numbers that moved in GMS Nov 2024 (per-character 12 introduced), in KMS mid-2026 (12 -> 14), and are announced for removal in KMS as of 2026-09-10. Note: this session exhausted its 200-call web search budget before a GMS-official confirmation of the live v.271 value could be obtained, so MaplePlanner should not hardcode any crystal cap without an in-game or Nexon-official check.
- **Correction:** Do not use a flat "180 per world, account-wide, not per character." The real structure is two-tier, and only the per-character tier is GMS-confirmed:

- Per character, per week: 12 boss crystals sellable in GMS as of Nov 2024 (forums.maplestory.nexon.net/discussion/34937/boss-crystals). KMS raised this to 14 in the mid-2026 Overdrive update (en.namu.wiki/w/%EA%B0%95%EB%A0%AC%ED%95%9C%20%ED%9E%98%EC%9D%98%20%EA%B2%B0%EC%A0%95, ~June 2026); GMS parity on the 12 -> 14 bump is UNVERIFIED.
- Per world, per week (account-wide across all characters in that world): 180 is a KMS figure only. The last GMS-official world-shared number I could source is 60 (forums.maplestory.nexon.net/discussion/31841/intense-power-crystal-limit-per-character, Nov 2021). GMS's current world cap: COULD NOT VERIFY.
- Status at v.271 (2026-09-09): the v.271 notes visible to me contain no boss-crystal or crystal-sale-limit changes, but a 2026-09-10 Korea-side broadcast announced the weekly Boss Crystal sale limit is being removed entirely with sell prices retiered, boss clear limits retained (mmohuts.com/news/maplestory-september-update-reworks-combat-feel-boss-crystals-and-teases-blue-archive-collab). GMS applicability UNVERIFIED.

For the Bow Master this tool serves, the actionable and best-supported constraint is the per-character weekly cap (12, possibly 14), not 180 — 180 is only relevant as an account-wide ceiling across a mule roster, and its GMS value is unconfirmed. Surface it to the user as "verify in game" rather than as a hard number.

### [crystals] The 180 cap is explicitly account-wide across all characters (independent confirmation)

- **Stated:** "You can only sell up to 180 per week across all your characters on your account"
- **Why refuted:** REFUTED on scope, not on the number. The claim says the 180 cap is "across all your characters on your account" (account-wide). The documented GMS mechanic is 180 per WORLD per week, plus a per-character sub-cap the claim omits entirely.

1) SCOPE IS WRONG. MapleStory Wiki, Intense Power Crystal (https://maplestorywiki.net/w/Intense_Power_Crystal) states verbatim: "Limit of 180 per world per week, 14 Weekly per character per week (GMS)." and "Limit of 90 per world per week, 12 Weekly per character per week (KMS JMS CMS MSEA TMS)." Independently corroborated by an official Nexon forum thread (Nov 2021, https://forums.maplestory.nexon.net/discussion/31841/intense-power-crystal-limit-per-character), where the reporter describes the cap as "shared across ALL characters of the same world." Per-world is not per-account: an account with characters in more than one Heroic world (Kronos, Hyperion, etc.) gets a separate 180 allowance in EACH world. For a 31-character account this is materially different from a single 180 account pool.

2) THE CLAIM OMITS THE BINDING PER-CHARACTER CAP. GMS also limits 14 Weekly crystals per character per week. This is load-bearing for a planner: you cannot reach 180 on one character, so the advice "sell 180" implies running roughly 13+ characters. A tool modeling only a flat 180 account pool would give wrong mule-count advice. VOLATILE:true.

3) THE CITED SOURCE ESTABLISHES NO PROVENANCE. https://www.digitaltq.com/maplestory-boss-guide names no server (no GMS/Reboot/Heroic/KMS) and no patch version, and is dated June 20, 2024 - over two years stale and predating v.271 (2026-09-09). It cannot function as "independent confirmation" of an account-wide scope it never establishes. (It does separately say Reboot crystals sell at 5x, but does not tie the 180 to any server.)

4) PARTIAL DEFENSE OF THE NUMBER: 180 is genuinely a GMS figure and was NOT imported from KMS or a private server - KMS/JMS/CMS/MSEA/TMS use 90 per world and 12 per character. So the researcher's number is in the right family for GMS; the word "account" is the error.

5) UNRESOLVED RISK I CHECKED AND COULD NOT CONFIRM. MMOHuts (Sept 10, 2026, https://mmohuts.com/news/maplestory-september-update-reworks-combat-feel-boss-crystals-and-teases-blue-archive-collab) claims "the weekly Boss Crystal sale limit is being removed, though boss clear limits remain." I loaded the official GMS v.271 patch notes in a browser and full-text searched them (https://www.nexon.com/maplestory/news/update/44597/v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes): there is NO occurrence of "180", "sell limit", "sale limit", or "per world per week". The ONLY v.271 crystal changes are "Changed so Intense Power Crystal will no longer drop from Yakuza Boss" and an item-description note that crystals can be sold via the "Crystals & Elixirs" Quick Move option. So the "limit removed" report is UNVERIFIED for GMS and may describe a KMS change; do not encode it. But it means the 180 figure's current status carries live patch risk - mark VOLATILE:true.

6) ALSO UNVERIFIED: a "Heroic crystal sell value 5x to 6x" change appears only in a player SUGGESTION thread (Sept 2025, https://forums.maplestory.nexon.net/discussion/35478/heroic-and-interactive-progression-improvement), not in the v.271 patch notes. The Heroic multiplier should not be stated as 6x. The wiki's GMS value table is labeled v270, so per-boss meso values were not re-verified against v271 either.
- **Correction:** GMS (incl. Heroic/Reboot): 180 Intense Power Crystals per WORLD per week, with a sub-cap of 14 Weekly crystals per character per week. The cap is per world, NOT per account - an account with characters in multiple worlds gets a separate 180 allowance in each world. (Other regions - KMS/JMS/CMS/MSEA/TMS - are 90 per world per week and 12 per character per week, so 180 must not be applied to them.) Source: https://maplestorywiki.net/w/Intense_Power_Crystal (value table labeled GMS v270); world-scope corroborated by https://forums.maplestory.nexon.net/discussion/31841/intense-power-crystal-limit-per-character. VOLATILE:true - both the 180 and the 14 are patch-tunable, and a secondary outlet reports the weekly sale limit may be removed in the Sept 2026 update, which the official v.271 patch notes do NOT confirm. Verify in-game against the Collector NPC before relying on it.

### [crystals] The 180 cap is explicitly account-wide across all characters (independent confirmation)

- **Stated:** "You can only sell up to 180 per week across all your characters on your account"
- **Why refuted:** STALE AND MIS-SCOPED. Three independent problems.

1) The source predates v.271 by over two years and predates a known crystal rework. https://www.digitaltq.com/maplestory-boss-guide carries a publication date of 2024-06-20, names no patch version and no server (Reboot vs regular is never stated). v.271 released 2026-09-08/09 (date confirmed at https://7mmo.com/threads/v-271-maplestory-x-frieren-beyond-journeys-end-patch-notes.3873/). More damaging than the calendar gap: the boss crystal system was restructured AFTER that article was written. Crystals were split into daily / weekly / monthly categories with a new per-character weekly sell cap - KMS 2024-07-18, reaching MapleSEA in v237 on 2024-11-12, which states verbatim "Maximum of 12 weekly crystals can now be sold per character" (http://www.maplesea.com/updates/view/v237_Patch_Notes/). A June 2024 guide is describing the pre-rework system.

2) The claim omits the cap that actually binds this player. For a 31-character account, the ~12-weekly-crystals-per-character ceiling is the real constraint, not 180. The claim's "you can only sell up to 180 per week across all your characters" implies the only thing standing between the player and 180 is having enough bosses cleared - which is exactly the planning error that sends someone to grind for nothing. GMS players discussing the post-rework state reference 12 and petition for 14 ("increase cap to 14", "14 bosses and not 12 bosses like in KMS", https://forums.maplestory.nexon.net/discussion/34937/boss-crystals, Nov 2024).

3) "Account-wide" is the wrong scope, and the cited "independent confirmation" is not independent. The 180 is documented as PER WORLD, not per account across worlds. Nexon forums describe the pool as shared "across ALL characters of the same world" (https://forums.maplestory.nexon.net/discussion/31841/intense-power-crystal-limit-per-character), and the NamuWiki crystal article likewise frames it as sold per world. The only "account cap" phrasing I could find is a single player comment (user Stacona) in the Nov 2024 forum thread above - a forum post, not an official source. This matters concretely for a Heroic player: Heroic is several separate worlds (Kronos, Hyperion, Solis, ...), so characters split across two Heroic worlds would not share one 180 pool.

VERIFICATION LIMITS - stated honestly. I could not read any official GMS source confirming 180 for v.271. The official patch notes at https://www.nexon.com/maplestory/news/update/44597/v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes are JavaScript-rendered and returned no body; maplestorywiki.net returned 403, en.namu.wiki 403, maplestory.fandom.com 402. So I can neither confirm 180 survived v.271 nor confirm it was changed. v.271 did demonstrably touch meso economics (bonus stat reset priced at 3,000,000 mesos, skin unlocks at 1,000,000,000 mesos, World Leap meso refunds, EXP curve changes Lv.210-259), so the patch was in the neighborhood of this system. Per the default-to-refuted rule, an unverifiable 2-year-old number stated with a wrong scope qualifier should not ship into a planning tool. Every number in the corrected value is volatile:true (subject to change by patch) and should be re-verified against official v.271 notes or in-game NPC text before MaplePlanner acts on it.
- **Correction:** Best available characterization, NOT fully verified for GMS v.271 - treat as provisional and volatile:true. The weekly boss crystal sell cap is approximately 180 crystals PER WORLD (not per account spanning multiple worlds), AND since the mid-2024 crystal rework there is a second, usually-binding cap of ~12 weekly crystals sold PER CHARACTER, with crystals now split into daily / weekly / monthly categories. Sources: 12-per-character is officially worded in MapleSEA v237 patch notes, 2024-11-12 (http://www.maplesea.com/updates/view/v237_Patch_Notes/); per-world scoping of the 180 appears at https://forums.maplestory.nexon.net/discussion/31841/intense-power-crystal-limit-per-character and in the NamuWiki Crystal of Intense Power article. Neither figure was confirmable against an official GMS v.271 source - the Nexon patch notes page would not render. For MaplePlanner: model the per-character cap as the primary constraint for a 31-character account, surface both numbers as unverified, and do not present 180 as account-wide.

### [crystals] GMS has a SECOND, per-character sub-limit that applies only to Weekly-category crystals: 14 per character per week (KMS/JMS/CMS/MSEA/TMS use 12). WEAKEST LINK — see couldNotVerify; Grandis Library still states 12

- **Stated:** 14 Weekly crystals / character / week (GMS); 12 in KMS et al.
- **Why refuted:** REFUTED — the mechanic is real, but the GMS-specific value "14" is unverified and rests on a single uncited community-wiki sentence that is contradicted by the other GMS-specific source and by the only primary-source numbers that exist.

WHAT IS ACTUALLY DOCUMENTED (primary/near-primary):
1. The per-character Weekly-crystal sub-limit is a KMS mechanic introduced in KMS v1.2.393 / KMST v1.2.176 (July 2024). Orange Mushroom's Blog, translating the official KMS notes: "It has been changed so that only up to 12 Weekly Crystals can be sold per character" (https://orangemushroom.net/2024/07/19/kms-ver-1-2-393-maplestory-milestone-limbo/) and "The total number of Crystals that can be sold per week remain the same at 180. However, you will now only receive the mesos for the top 12 Weekly Crystals you sell" (https://orangemushroom.net/2024/07/13/kmst-ver-1-2-176-new-boss-limbo/). Korean press coverage of the same patch: "a maximum of 12 weekly crystals can be sold per character" (https://koreaagain.net/en-news-game-20240712-maplestory/). All KMS, July 2024. The claim's parenthetical (KMS = 12) is correct; the GMS = 14 half is what fails.
2. GMS received this revamp at the November 20, 2024 maintenance and shipped it at 12, not 14. Nexon's own forums, November 2024: players protesting the change reference "12 crystals" as the live cap and ~20-33% boss income loss (https://forums.maplestory.nexon.net/discussion/34937/boss-crystals; that thread explicitly discusses Reboot meso values). A companion thread the same month is titled "GMS has 14 Early Weekly Bosses, Not 12" and argues "we needed the extra +2 for 14 to properly match our extra bosses" — Princess No and Akechi (https://forums.maplestory.nexon.net/discussion/34930/gms-has-14-early-weekly-bosses-not-12). That is a player REQUEST for 14, filed in Suggestions/Feedback/Requests, with no Nexon staff reply. It is almost certainly the origin of the "14" number in circulation.
3. I could find no GMS patch note, Nexon news post, or staff statement anywhere raising the GMS per-character weekly cap from 12 to 14. A July/August 2025 GMS forum thread complaining about the cap still describes a player doing "about 12 bosses" with leftover unsellable crystals (https://forums.maplestory.nexon.net/discussion/35424/boss-crystal-sell-limit).

WHY THE CITED SOURCE DOES NOT CARRY THE CLAIM:
- https://maplestorywiki.net/w/Intense_Power_Crystal does say, verbatim today: "Limit of 180 per world per week, 14 Weekly per character per week (GMS). Limit of 90 per world per week, 12 Weekly per character per week (KMS JMS CMS MSEA TMS)." So the researcher transcribed it accurately — but that line carries NO citation (the page's only reference, [1], is attached to the meso value table, not the Notes).
- Wayback shows the Notes section as recently as 2025-07-24 listed ONLY the world caps ("Limit of 180 per world per week (GMS)" / "Limit of 90 per world per week (non-GMS)") — the per-character line lived only in the page's uncited intro prose ("A maximum of 12 weekly crystals (14 in GlobalMS) can be sold per character") and was promoted into the Notes box at some later, unsourced edit (http://web.archive.org/web/20250724130906/https://maplestorywiki.net/w/Intense_Power_Crystal). I attempted to identify the editor and edit summary via the page's revision history but the wiki began serving a Cloudflare bot-check; I did not attempt to bypass it, so the provenance of the "14" edit remains unestablished.
- Grandis Library, the GMS-specific guide site, states the opposite: "the Collector will only accept 12 weekly crystals" per character, alongside "accepts 180 crystals a week per world and resets on Thursdays 12am UTC" (https://grandislibrary.com/content/progression-guide). The 180/world figure confirms that page is describing GMS, not KMS — so this is a GMS source saying 12. The researcher flagged this conflict themselves and still shipped 14.

SERVER PROVENANCE (the specific thing I was asked to check): no source I found — wiki, Grandis Library, or forum — states the per-character Weekly sub-limit for Heroic/Reboot specifically. The wiki's note is regional (GMS vs KMS et al.), never server-type. Heroic is untested in every source. Reboot's meso economics differ and the Nov 2024 protest thread shows Reboot players were affected by this cap, but that only establishes the cap exists in Reboot, not its value.

PATCH CURRENCY: I read the live v.271 patch notes directly (https://www.nexon.com/maplestory/news/update/44597/updated-9-10-v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes, released 2026-09-09). Its only Intense Power Crystal changes are that the crystal no longer drops from Yakuza Boss and an item-description line about selling via the "Crystals & Elixirs" Quick Move option. No limit changes in v.271 — so whatever the number is, v.271 did not alter it.

CAVEAT ON MY OWN COVERAGE: this session exhausted its WebSearch budget mid-investigation and I finished on direct fetches plus browser-driven DuckDuckGo; maplestorywiki's history and Fandom's mirror (HTTP 402) were not readable. So I cannot prove 14 is wrong — I can only show it is unsourced, contradicted, and traceable to a player request rather than a patch note. Under the "default to refuted when provenance cannot be established" rule, and because this figure directly sets how many weekly bosses MaplePlanner tells the player to run, it must not ship as stated.
- **Correction:** Best-supported value: 12 Weekly-category crystals per character per week — with the account/world cap of 180 crystals per world per week in GMS (90 in KMS/JMS/CMS/MSEA/TMS). volatile:true on all three numbers.

Confidence: MEDIUM for 12, LOW-to-NONE for anything Heroic-specific. 12 is the only figure with a primary source (official KMS v1.2.393 notes, July 2024, via https://orangemushroom.net/2024/07/19/kms-ver-1-2-393-maplestory-milestone-limbo/) and is corroborated for GMS by Grandis Library (https://grandislibrary.com/content/progression-guide) and by GMS player reports at the Nov 20 2024 launch of the revamp (https://forums.maplestory.nexon.net/discussion/34937/boss-crystals). The 180/world GMS figure is the one number both conflicting sources agree on and is the safest of the three.

Recommendation for MaplePlanner: do NOT hardcode 14. Either (a) surface 12 with an explicit "unconfirmed for Heroic; verify in-game at the Collector NPC" flag, or (b) drop the per-character sub-limit from the planner entirely and plan against the 180/world/week cap, which is well corroborated. The player can settle this himself in about 30 seconds: the Collector NPC shows a record of Weekly boss crystals sold this week (a UI added in the same KMS patch), which displays the actual live cap on his own Heroic character — that in-game readout beats every source above.

### [rosters] The Collector buys a hard-capped number of Intense Power Crystals per week per world — this, not clear time, is the binding constraint for a 31-character account

- **Stated:** 180 crystals per week per world
- **Why refuted:** REFUTED on three independent grounds — provenance, staleness, and misreading of the cited source itself.

1) SERVER PROVENANCE NOT ESTABLISHED. I fetched the cited page (https://grandislibrary.com/content/progression-guide). It does contain the number: "accepts 180 crystals a week per world and resets on Thursdays 12am UTC. However, the Collector will only accept 12 weekly crystals". But the Collector passage never states which world type it describes — it does not say Heroic/Reboot anywhere near the cap, and the site has no Reboot/Heroic mechanics page at all (index: https://grandislibrary.com/content). The site is GMS-scoped (its footer reads "GMS Ver. 269 [Ride the Lightning Update]"), so this is probably not a KMS or private-server import, but "probably GMS-wide" is not "verified for GMS Heroic," and the claim's entire framing is Heroic-roster-specific. Per the standing rule, an unqualified source = unverified.

2) THE SOURCE IS TWO PATCHES STALE, ACROSS THE EXACT ECONOMY PATCH IN QUESTION. Grandis Library is stamped GMS Ver. 269 sitewide; the player is on v.271, whose patch notes Nexon posted 2026-09-08 and updated 2026-09-10 (https://www.nexon.com/maplestory/news/update/44597/updated-9-10-v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes, plus https://www.nexon.com/maplestory/news/update/44705/v-271-update-preview and https://www.nexon.com/maplestory/news/maintenance/45226/v-271-known-issues). Since v.271 reworked meso/symbol economics, a v.269-era crystal figure is stale by construction. I could NOT read the official notes to check whether the cap moved: nexon.com serves a JavaScript shell that WebFetch only sees as "MapleStory | Official Website". So the 180 figure is neither confirmed nor refuted at v.271 — which is itself disqualifying for a planner.

3) THE CLAIM CONTRADICTS ITS OWN SOURCE ON THE LOAD-BEARING POINT. The claim's substance is not "180 exists," it is "180, not clear time, is the binding constraint for a 31-character account." The same sentence in the same source imposes a second, far tighter cap: only 12 WEEKLY crystals. A 31-character Heroic roster earns its meso from weekly boss mules (CRA/Lomien/Damien/Lucid/Will/Gloom/VHilla tier), so the 12-weekly-crystal ceiling binds roughly 15x sooner than the 180 total. The claim quotes the loose cap and drops the tight one, which inverts the planning advice. Worse, the source does not say whether that 12 is per world, per account, or per character, so neither number is usable as stated.

4) NO INDEPENDENT CORROBORATION OBTAINABLE. Every cross-check failed: maplestory.fandom.com returned HTTP 402, maplestorywiki.net HTTP 403, strategywiki.org HTTP 403, old.reddit.com is blocked for this tool, the WebSearch budget for this session was already exhausted (200/200), and both DuckDuckGo endpoints served a CAPTCHA (which I did not attempt). So the number rests on exactly one stale, server-agnostic secondary source and zero primary sources. Do not ship it.

volatile: true — every number here (180, 12, crystal prices) is patch-sensitive and v.271 is two days old.
- **Correction:** No verified value; do not publish a number. What is actually sourced, at GMS v.269 and unqualified as to world type (https://grandislibrary.com/content/progression-guide): the Collector "accepts 180 crystals a week per world", resetting Thursday 00:00 UTC, AND "will only accept 12 weekly crystals". If MaplePlanner must model a roster constraint, the candidate binding cap for a 31-character boss-mule account is the 12-weekly-crystal ceiling, not 180 — but flag it in-product as unverified for GMS Heroic at v.271, with the per-world vs per-account scope of the 12 unresolved. Verify against the in-game Collector NPC dialogue or the v.271 patch notes read in a real browser (nexon.com is a JS SPA and cannot be fetched as text) before any of this drives a recommendation.

### [rosters] The Collector buys a hard-capped number of Intense Power Crystals per week per world — this, not clear time, is the binding constraint for a 31-character account

- **Stated:** 180 crystals per week per world
- **Why refuted:** REFUTED as unverified-for-v.271, on two independent grounds. (1) STALE SOURCE: the cited site self-declares its currency in its own footer as "GMS Ver. 269 [Ride the Lightning Update]" (https://grandislibrary.com/ — quoted verbatim), i.e. two versions behind GMS v.271, which shipped 2026-09-09 (two days ago) and which the project brief states altered meso and symbol economics. A crystal-to-meso sale cap is exactly the kind of knob a meso-economy patch touches, so a v.269-era figure cannot be asserted as a v.271 fact. (2) MISSTATED MECHANIC: even at v.269 the cited page does not say what the claim says. Verbatim from https://grandislibrary.com/content/progression-guide: "accepts 180 crystals a week per world and resets on Thursdays 12am UTC. However, the Collector will only accept 12 weekly crystals". The source states TWO limits; the claim reports only the 180 and then asserts it is "the binding constraint." I could not recover the qualifier on the second clause (text extraction truncates mid-sentence — per character? per world?), but if it is 12 weekly-boss crystals per character, then 180/12 means only ~15 of the 31 characters can contribute sellable weekly crystals at all, which is a materially different planning conclusion than "180 is the cap." I could NOT verify the figure against v.271 primary sources: the official notes exist at https://www.nexon.com/maplestory/news/update/44597/updated-9-10-v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes (lastmod 2026-09-08, revised 9/10), https://www.nexon.com/maplestory/news/update/44705/v-271-update-preview and https://www.nexon.com/maplestory/news/maintenance/45226/v-271-known-issues (all found via https://www.nexon.com/maplestory/sitemap.xml), but every one is client-rendered and returned only the page shell to WebFetch and to an r.jina.ai render; browser navigation to nexon.com was denied in this non-interactive session, and the session's WebSearch budget (200/200) was exhausted before the first query. Only weak negative signal available: no Aug-Sep 2026 sitemap slug mentions crystal, collector, meso, symbol, boss or reward. Also note the claim's secondary assertion — that the cap, "not clear time," binds for a 31-character roster — is unsourced editorializing, not a numeric claim; for a Lv 244 Bow Master main it depends entirely on how many mules can actually clear the relevant bosses, which no source I reached quantifies. volatile:true (weekly sale cap, per-patch tunable). DO NOT ship 180 as a hard v.271 constant in MaplePlanner until someone reads the v.271 notes at the URL above.
- **Correction:** No verified v.271 value. The last sourceable figure is 180 Intense Power Crystals per week per world, reset Thursday 00:00 UTC, from a guide that self-declares currency at GMS v.269 (https://grandislibrary.com/content/progression-guide + footer at https://grandislibrary.com/) — and that same source attaches a second, separate cap of "12 weekly crystals" that the claim omits. Treat 180 as UNVERIFIED for v.271 (volatile:true) and surface it in-product with the v.269 provenance and the second cap, or suppress it, until the v.271 patch notes (https://www.nexon.com/maplestory/news/update/44597/updated-9-10-v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes) are read directly.

### [rosters] Of those 180, only a limited number may be WEEKLY-boss crystals per character; GMS is on a different number than KMS

- **Stated:** 14 per character in GMS (KMS is 12, and KMS's world cap was cut to 90)
- **Why refuted:** REFUTED — server provenance cannot be established, and the cited source is structurally incapable of supporting the GMS half of the claim.

1) The source is a KMS source being used to assert a GMS number. https://en.namu.wiki/w/%EA%B0%95%EB%A0%AC%ED%95%9C%20%ED%9E%98%EC%9D%98%20%EA%B2%B0%EC%A0%95 is the namu.wiki article on 강렬한 힘의 결정 (Intense Power Crystal), a Korean-community wiki documenting KMS. The claim itself concedes the KMS values differ ("KMS is 12, and KMS's world cap was cut to 90"). So the load-bearing figure — 14 per character in GMS — has no source attached at all. A KMS wiki page cannot establish a GMS Heroic number, and the claim supplies nothing else. This is exactly the KMS-numbers-presented-as-GMS-numbers failure mode the brief warns about.

2) I could not verify even the KMS half. Direct fetch of the cited namu.wiki URL returned HTTP 403 Forbidden, so the "12 per character / 90 world cap" figures are unread and unconfirmed. Corroboration attempts also failed: maplestorywiki.net 403, maplestory.fandom.com 402, strategywiki.org 403, official nexon.com/maplestory guide page returned only the site shell with no mechanics text, old.reddit.com unfetchable, and DuckDuckGo served a CAPTCHA (which I will not complete). The session's WebSearch budget (200/200) was already spent before I started, so no keyword search was available. Net: zero readable sources on either side.

3) The mechanic appears to be misdescribed, independent of the numbers. The claim frames 14 as a per-character sub-quota carved out of the 180 and specific to WEEKLY bosses. The 180 figure in GMS is a world/account-level weekly sell cap; the per-character limiter is a separate constraint and is not, as far as I can establish, a weekly-boss-only allowance. Splicing a per-character number out of the world cap and restricting it to weekly bosses conflates two different limiters, so even if "14" came from somewhere real, the semantics attached to it in this claim are unsupported.

4) v.271 recency. v.271 shipped 2026-09-09, two days before this check, and per the brief it changed meso and symbol economics. Any crystal cap number that predates that date is stale until re-verified against GMS v.271 patch notes, which I could not retrieve. The claim gives no date for its figures.

Practical consequence for MaplePlanner: do not ship "14 weekly-boss crystals per character" as a GMS Heroic planning constant. A wrong per-character crystal quota directly mis-sizes the roster-wide weekly boss mule plan — it tells a player with 31 characters how many mules are worth gearing and bossing, so an unverified number here sends real hours at the wrong target.

I am deliberately NOT supplying a corrected value. I could not read a single GMS-authoritative source this session, and inventing a replacement number would reproduce the same error with more confidence. To close this properly, someone needs to verify against (a) the official GMS v.271 patch notes on nexon.com/maplestory, or (b) the in-game Intense Power Crystal merchant NPC dialogue on a Heroic world character, which states the caps directly. Both figures should be marked volatile:true when they are eventually sourced.

### [rosters] Of those 180, only a limited number may be WEEKLY-boss crystals per character; GMS is on a different number than KMS

- **Stated:** 14 per character in GMS (KMS is 12, and KMS's world cap was cut to 90)
- **Why refuted:** REFUTED — not because "14" is invented, but because the claim's comparative half is misattributed and the whole limit structure is mid-rework as of the patch in question. Three findings:

(1) The GMS figure of 14 is real but its provenance is Dec 2024, not v.271. GMS moved the per-character weekly Intense Power Crystal sell limit from 12 to 14 at the December 5, 2024 maintenance ("The maximum Weekly Intense Power Crystals that can be sold per character will be adjusted from 12 weekly crystals to 14" — https://www.reddit.com/r/Maplestory/comments/1h6g5ul/psa_wait_until_after_the_maintenance_to_do_bosses/, Dec 4 2024; confirmed next day by https://www.reddit.com/r/Maplestory/comments/1h7m005/psa_weekly_boss_crystals_hard_reset_to_14_after/, Dec 5 2024). That is ~21 months before v.271. Also note the 180 is NOT "weekly crystals only" — it is the world/account-wide weekly total across daily (blue) + weekly (purple) + monthly (gold) crystals (https://www.reddit.com/r/Maplestory/comments/1e1gn29/thoughts_on_the_12_weekly_boss_crystal_limit/, Jul 12 2024). The claim's framing of "of those 180, only 14 may be weekly" conflates a per-character cap with a share of the world cap.

(2) The parenthetical is wrong about the server. The "12 per character" and the "cut to 90" are MapleSEA facts, not KMS. MSEA v237 patch notes, 12 November 2024, state verbatim "Maximum of 12 weekly crystals can now be sold per character" (http://www.maplesea.com/updates/view/v237_Patch_Notes/ — I fetched this page directly). The 90 cut is likewise MSEA: "MapleSEA reducing sell limit of weekly boss crystals to 90" (https://www.reddit.com/r/Maplestory/comments/1l27c3o/maplesea_reducing_sell_limit_of_weekly_boss/, Jun 3 2025). I found no source placing KMS at a 90 world cap. MSEA usually ports KMS changes, so KMS may share the 12, but the researcher stated an MSEA number as a KMS number, and for a Heroic/Reboot planner that is the kind of cross-region substitution that produces wrong advice.

(3) The cited source cannot carry the claim, and the system is actively being replaced. en.namu.wiki is CAPTCHA-gated (403/challenge on direct fetch and via reader), so it is not independently verifiable; the indexed revision is dated June 30, 2026 — before v.271 (2026-09-09). Its indexed snippet does support GMS-14-vs-12 ("14 weekly boss crystals can be sold per character instead of 12. The reason KMS's boss decision nerf was not introduced like this is because Heroic World is the..."), but it is a pre-patch Korean wiki page, not a GMS source. More importantly: on the September 10, 2026 Maple Now broadcast Nexon announced that "Boss Crystal sell prices are being adjusted by tier, and the weekly Boss Crystal sale limit is being removed, though boss clear limits remain" (https://mmohuts.com/news/maplestory-september-update-reworks-combat-feel-boss-crystals-and-teases-blue-archive-collab, Sep 10 2026). That article does not name a region; the "Maple Now" broadcast format, the November Blue Archive collab and Catch! Teenieping content all indicate KMS, so treat it as a KMS-first change not yet confirmed for GMS Heroic. Historically GMS has followed these crystal reworks within months (it took the 12→14 change), so hardcoding 14/180 into a planner without a volatility flag is exactly the stale-guide failure mode.

Verification gaps I will not paper over: this session's WebSearch budget was exhausted, so I worked via WebFetch against search engines (Brave returned results then rate-limited; Bing/DDG/Startpage/Qwant were bot-blocked or served junk; Reddit and Fandom are unfetchable). The official GMS v.271 patch notes (https://www.nexon.com/maplestory/news/update/44597/v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes, updated 9/10) rendered only partially through a reader — the readable portion contains no mention of "Crystal", "Intense Power Crystal" or "boss crystal", and the table of contents shows no economy/boss-reward section, but the document truncated before "Boss/Mob Changes and Bug Fixes", so I cannot state conclusively that v.271 left the crystal caps untouched. That unresolved gap is itself a reason to refuse the claim as "current".

volatile: true — every number here (14, 12, 180, 90) is patch-mutable and at least one service has announced removing the cap outright.
- **Correction:** For GMS Heroic (Reboot), the best-supported current values, all flagged volatile:true:

- Per-character weekly Intense Power Crystal sell limit: 14 (raised from 12 at the GMS maintenance of 2026-12-05... correction: 2024-12-05). Source: https://www.reddit.com/r/Maplestory/comments/1h6g5ul/psa_wait_until_after_the_maintenance_to_do_bosses/ and https://www.reddit.com/r/Maplestory/comments/1h7m005/psa_weekly_boss_crystals_hard_reset_to_14_after/ (both Dec 2024). Last independent confirmation found: 2026-06-30 (namu.wiki indexed revision). NOT re-confirmed against v.271 — treat as "believed 14, unconfirmed post-2026-09-09".
- World/account-wide weekly cap: 180 crystals TOTAL, spanning daily (blue) + weekly (purple) + monthly (gold) crystals — not 180 weekly-boss crystals. Source: https://www.reddit.com/r/Maplestory/comments/1e1gn29/thoughts_on_the_12_weekly_boss_crystal_limit/ (2024-07-12). At 14/character this caps out at roughly 13 crystal-selling characters (13 x 14 = 182), which matches community practice (https://www.reddit.com/r/Maplestory/comments/1gvcust/do_we_need_15_bossing_mules_to_cap_on_weekly/, 2024-11-20).

Corrections to the claim's parenthetical:
- 12 per character = MapleSEA, sourced to MSEA v237 patch notes dated 2024-11-12: "Maximum of 12 weekly crystals can now be sold per character" (http://www.maplesea.com/updates/view/v237_Patch_Notes/).
- The cut to 90 = MapleSEA, announced ~2025-06 (https://www.reddit.com/r/Maplestory/comments/1l27c3o/maplesea_reducing_sell_limit_of_weekly_boss/). KMS's own per-character and world-cap numbers are UNVERIFIED — I could not reach a Korean primary source (namu.wiki CAPTCHA-gated, KMS official site not fetchable). Do not print a KMS number.

Forward-looking flag for the planner: on 2026-09-10 Nexon announced boss crystal sell prices adjusted by tier and the weekly Boss Crystal sale limit REMOVED, with boss clear limits retained (https://mmohuts.com/news/maplestory-september-update-reworks-combat-feel-boss-crystals-and-teases-blue-archive-collab). Evidence points to this being KMS; it is NOT confirmed live in GMS Heroic. Any MaplePlanner advice of the form "spread bosses across ~13 mules to hit the 180 cap" should carry an expiry and be re-verified against the next GMS patch notes, because if GMS inherits the removal the optimal play changes from "cap-allocate across mules" to "clear everything you can".

### [rosters] Heroic/Reboot crystal prices are exactly 5x the Interactive-world price, and GMS prices are on an independent track from KMS (GMS did not take the 2025 KMS silver-tier crystal nerfs)

- **Stated:** Heroic = 5x Interactive world
- **Why refuted:** REFUTED on server provenance — the claim's own citation disproves its central premise.

1) The cited source is a KMS source, not a GMS one. https://en.namu.wiki/w/%EA%B0%95%EB%A0%AC%ED%95%9C%20%ED%9E%98%EC%9D%98%20%EA%B2%B0%EC%A0%95 is en.namu.wiki, the English mirror of the Korean-language namu.wiki, and the article slug is the Korean item name 강렬한 힘의 결정 (Intense Power Crystal). namu.wiki documents KMS. The terms the claim turns on — "Heroic" and "Interactive world" — are GMS-specific nomenclature (GMS renamed Reboot to Heroic and relabeled normal servers Interactive); KMS has no world called either. A KMS wiki page structurally cannot establish a GMS Heroic-vs-Interactive multiplier, so the value is imported from the wrong region. This is exactly the failure mode the accuracy rules call out.

2) The claim is self-contradicting. It asserts "GMS prices are on an independent track from KMS" while offering a KMS wiki as its only evidence. If the two tracks are independent, the KMS source cannot speak to the GMS number; if the KMS source is authoritative for GMS, the tracks are not independent. Both halves cannot stand on this citation.

3) The source is unverifiable and stale even on its own terms. The URL returns HTTP 403 (Cloudflare) to direct fetch and through a reader proxy, so I could not confirm it says anything about a 5x multiplier at all. The Wayback availability API (http://archive.org/wayback/available) reports its only snapshot as 2024-11-19T11:32:52Z — roughly 22 months before today (2026-09-11). That snapshot predates both the alleged "2025 KMS silver-tier crystal nerfs" and GMS v.271 (2026-09-09), the patch flagged as having changed meso economics. The cited page therefore cannot evidence the post-v.271 GMS state regardless of what it says.

4) The negative half is unsourceable as framed. "GMS did not take the 2025 KMS silver-tier crystal nerfs" is an absence claim about GMS; establishing it requires GMS patch notes (nexon.com/maplestory news), not a Korean wiki. No GMS patch note is offered, and I could not reach nexon.com's patch-note content (the pages returned only the site shell).

5) "Exactly 5x" is an unverified universal quantifier. It would have to hold for every boss tier and every crystal, post-v.271, in GMS Heroic. I could not source even one Heroic/Interactive price pair to spot-check it.

Verification was further limited: this session's WebSearch budget was exhausted (200/200) before I could run any search, and every independent source I attempted was blocked — maplestorywiki.net (403), maplestory.fandom.com (402), old.reddit.com and web.archive.org content (fetch disallowed), DuckDuckGo (CAPTCHA, which I did not attempt to bypass). So this is a refutation on provenance and staleness, not a demonstration that some different number is correct.

Recommendation for MaplePlanner: do not ship this figure. Any Heroic crystal value must carry a GMS-specific citation dated on or after v.271 (2026-09-09) — a GMS patch note or an in-game Heroic-world Collector NPC reading — and should be marked volatile:true when it is shipped.
- **Correction:** Could not be established. No GMS Heroic/Reboot crystal price — and no Heroic-to-Interactive multiplier — could be verified from any reachable source, so no replacement number should be entered. Treat as unknown pending a GMS-specific source dated on or after v.271 (2026-09-09); mark volatile:true when eventually sourced.

### [nonCrystal] Base chance for any monster to drop a meso bag, before Item Drop Rate

- **Stated:** 60% flat
- **Why refuted:** Refuted on provenance and staleness, NOT on the number being demonstrably wrong — an important distinction for how MaplePlanner should use it.

(1) SERVER PROVENANCE FAILS. The cited source (https://github.com/Francesco149/mapleguide) states it verbatim under "* meso farming / ** meso drop rate" as: "mobs have a 60% base chance to drop meso bags. this means that if you have at least 67% drop rate you can guarantee that meso bags always drop because ~0.6 * 1.67 = 1~". The section names no server — not Reboot, not Heroic, not GMS. The guide explicitly spans KMS, GMS, JMS, TMS, MSEA and CMS and calls KMS "the original, upstream, reference version," so a region-unlabeled mechanic in it cannot be attributed to GMS Heroic. Per the brief's rule, unlabeled = unverified.

(2) STALE BY ~4 YEARS. README.org's last commit is 2022-11-15 ("move rotations to separate file", 6da2dbc) per https://github.com/Francesco149/mapleguide/commits/master/README.org. That predates v.271 (2026-09-09) by nearly four years, and the repo self-describes as "(WORK IN PROGRESS)". Since v.271 reworked meso/symbol economics, this source cannot speak to the current patch.

(3) NO v.271 VERIFICATION. I found nothing addressing whether the 60% base survived v.271. My WebSearch budget (200/200) was exhausted before I could retrieve official patch notes; WebFetch of https://maplestorywiki.net/w/Meso returned HTTP 403, and https://www.digitaltq.com/maplestory-item-drop-rate (2024-08-30) covers Item Drop Rate but contains nothing on meso-bag base chance, so it does not corroborate.

(4) "FLAT" / "ANY MONSTER" OVERREACHES. No source I read says "flat" or "any monster." Corroboration covers ordinary farming mobs only; bosses and special spawns are unverified.

EVIDENCE THE NUMBER IS SUBSTANTIVELY RIGHT ANYWAY (stated for calibration): https://gamerempire.net/maplestory-reboot-meso-farming-guide/ (last modified 2024-01-14) is Reboot-specific and gives identical figures — "mobs only have a 60% chance to drop meso pouches" and "you need to have minimum +67% drop rate." The well-known Reboot ~67% Item Drop Rate breakpoint is only arithmetically coherent (0.60 x 1.67 = 1.00) if the base is 60% and IDR scales it multiplicatively, which is real evidence the figure describes Reboot practice. However the two sources plausibly share one lineage, so this is corroboration, not independent confirmation, and neither is post-v.271.

RECOMMENDATION FOR MaplePlanner: do not ship 60% as an authoritative constant. If used, label it "community figure, Reboot-corroborated as of Jan 2024, unverified for v.271" and set volatile:true. The actionable downstream number — the ~67% IDR breakpoint for guaranteed meso bags — inherits the same uncertainty and should carry the same caveat, since routing the player's grind hours off an unverified base is exactly the failure mode the brief warns about.
- **Correction:** Best available value, properly scoped: ~60% base meso-bag drop chance on ordinary farming mobs, scaled multiplicatively by Item Drop Rate, implying the ~67% IDR breakpoint for guaranteed meso bags (0.60 x 1.67 = 1.00). Corroborated for GMS Reboot as of 2024-01-14 (https://gamerempire.net/maplestory-reboot-meso-farming-guide/), NOT verified for GMS Heroic at v.271. volatile:true. Do not present as a confirmed constant; no source establishes it post-2026-09-09.

### [nonCrystal] Base chance for any monster to drop a meso bag, before Item Drop Rate

- **Stated:** 60% flat
- **Why refuted:** Refuted as *unverified for v.271*, not as numerically wrong — the distinction matters and should survive into the tool.

WHAT IS ACTUALLY BROKEN — THE CITATION:
The cited source cannot support a v.271 claim. GitHub blame on https://github.com/Francesco149/mapleguide/blame/master/README.org shows the exact line ("mobs have a 60% base chance to drop meso bags. this means that if you have at least 67% drop rate you can guarantee that meso bags always drop because ~0.6 * 1.67 = 1~") was last edited 2022-07-18, and the repo's most recent commit of ANY kind is 2022-11-16 ("rotations: sort gate 4 list", 775e72d) — https://github.com/Francesco149/mapleguide/commits/master. That is 4+ years before v.271 (2026-09-09). The repo is self-labeled "(WORK IN PROGRESS)" and explicitly mixes regions (it discusses KMS vs GMS Reboot vs MSEA spawn-enhancer differences), so it is not a GMS-Heroic-specific source. A dead 2022 repo is not an acceptable citation for a current-patch constant.

WHAT I COULD NOT DO:
I could not retrieve the v.271 patch notes. nexon.com/maplestory/news/update and maplestory.nexon.net return an SPA shell with no article text to WebFetch; maplestorywiki.net returns 403 and maplestory.fandom.com returns 402. My WebSearch budget was exhausted (200/200) before I located a post-2026-09-09 source. So I have ZERO evidence from after the patch, in either direction.

IMPORTANT COUNTER-EVIDENCE — DO NOT CONCLUDE THE NUMBER IS WRONG:
I found no source anywhere stating a value other than 60%, and two independent corroborations that predate the patch:
1. https://gamerempire.net/maplestory-reboot-meso-farming-guide/ (last modified 2024-01-14, explicitly GMS Reboot): "By default, mobs only have a 60% chance to drop meso pouches," needing "+67% drop rate" to guarantee them, governed by Item Drop Rate. This is the single most on-point source: right game, right server family, and it independently confirms the Item-Drop-Rate-not-Meso-Rate part of the claim.
2. https://vortexgaming.io/en/postdetail/536655 (undated, region unstated — treat as unverified): "A drop rate of 67% guarantees that monsters will drop meso pouches with a 100% probability," which is arithmetically 0.60 x 1.67 = 1.00 and therefore implies the same 60% base.

Weak evidence the patch did NOT touch this: the pre-release GMS roadmap at https://www.mmoexp.com/News/maplestory-gms-update-roadmap-august-november-2026-events-qol-new-class-endgame-overhauls.html (2026-08-12) describes September as a leveling overhaul (EXP to 260 halved), auto-cubing/auto-flaming QoL, Kalin balance, and the Night Troupe event — it lists no meso, drop-rate, or symbol economy changes. That is a third-party pre-release roadmap, not patch notes, so it is suggestive only. Note this also partly contradicts the briefing's premise that v.271 changed meso economics; I could not confirm that premise either.

Also note two framing defects in the claim independent of staleness: (a) "any monster" overstates the sources, which all say "mobs" — nothing I found establishes that bosses roll meso bags on this same 60%; (b) "flat" implies a verified game constant, which no reachable current source supports.

BOTTOM LINE FOR THE PLANNER: 60% is the best available estimate and is probably still correct, but it must not ship as a sourced, current-patch constant on a 2022 citation. Mark volatile:true and confidence "unverified for v.271". The downstream advice that actually depends on this — the ~+67% Item Drop Rate breakpoint for guaranteed meso bags — should be presented as a widely-used community target whose arithmetic basis was last confirmed for GMS Reboot in Jan 2024, not as a v.271-verified fact. Re-verify against the official v.271 patch notes before relying on it.
- **Correction:** 60% base chance for normal mobs (not bosses) to drop a meso bag, gated by Item Drop Rate — UNVERIFIED for v.271. Last confirmed for GMS Reboot on 2024-01-14 (gamerempire.net); implied by the 67% guarantee threshold (0.60 x 1.67 = 1.00). No post-2026-09-09 source located and no contradicting value found. Ship as volatile/unverified with a re-verification flag, not as a fixed constant.

### [nonCrystal] Item Drop Rate needed to guarantee a meso bag from every mob. This is the single most important breakpoint in meso farming: 0.60 x 1.67 = 1.00. Drop rate ABOVE +67% adds no further meso bags (it only adds item drops such as Sol Erda Fragments)

- **Stated:** +67% Item Drop Rate
- **Why refuted:** REFUTED on three independent grounds: server provenance, staleness, and a stat mislabel that inverts the advice.

1. SERVER PROVENANCE CANNOT BE ESTABLISHED (the disqualifying test). I fetched the source's own text at https://raw.githubusercontent.com/Francesco149/mapleguide/master/README.org. The passage reads verbatim: "a lot of people fail to take the meso drop rate into account. mobs have a 60% base chance to drop meso bags. this means that if you have at least 67% drop rate you can guarantee that meso bags always drop because ~0.6 * 1.67 = 1~." It carries NO region label, NO server label, NO citation, and NO datamine reference. This matters because the same repo (https://github.com/Francesco149/mapleguide) is explicitly a multi-region comparison covering KMS, GMS, MSEA, JMS, TMS and CMS, and both Reboot and non-Reboot GMS. An unlabeled number inside a multi-region document cannot be assumed to be GMS Heroic. Per the standing rule, unverified server = refuted.

2. THE SOURCE IS ABANDONED AND ~4 YEARS STALE. GitHub API (https://api.github.com/repos/Francesco149/mapleguide): created_at 2022-07-16, pushed_at 2022-11-16, 9 stars, self-described "(WORK IN PROGRESS)". The `updated_at` of 2026-08-27 is metadata (star/watch), not a content push — no content has been pushed since 16 Nov 2022. That predates the v.253 Item Drop Rate 400% cap added 2024-08-29 (https://www.digitaltq.com/maplestory-item-drop-rate, published 2024-08-30) and predates v.271 (2026-09-09) by nearly four years. Drop mechanics have demonstrably been patched in that window.

3. THE CLAIM MISLABELS THE STAT — this is the load-bearing error. The source's sentence is introduced by "the MESO drop rate", i.e. the "67% drop rate" in context is meso drop rate, not Item Drop Rate. The same README separately and explicitly warns: "familiar drop rate does NOT affect meso drop rate. you need it to be meso drop rate specifically", and tabulates meso drop rate as its own stat with its own sources (inner ability, potentials, bonus potentials, Monster Life, familiars, consumables) distinct from item drop rate. The researcher's claim relabels it "+67% Item Drop Rate" and then compounds the error with "Drop rate ABOVE +67% adds no further meso bags (it only adds item drops such as Sol Erda Fragments)" — fusing two stats the cited source deliberately keeps apart. Shipping this would tell Archerroni to chase Item Drop Rate potential lines to a breakpoint that the source attributes to a different stat.

4. NO INDEPENDENT CORROBORATION. The only other source repeating 60%/67% is https://gamerempire.net/maplestory-reboot-meso-farming-guide/ ("by default, mobs only have a 60% chance to drop meso pouches", "+67% drop rate"), which IS Reboot-specific but was last modified 2024-01-14 (20 months before v.271) and cites nothing — it reads as downstream of the same unsourced figure, not as confirmation of it. https://gamemarket.gg/news/maplestory-global/maplestory-meso-farming-guide-2026-how-gms-players-actually-fund-their-gear (20 June 2026, GMS) discusses meso farming at length and does NOT mention a 60% base or any 67% breakpoint at all.

5. THE UNDERLYING MODEL IS AN ASSUMPTION, NOT A VERIFIED MECHANIC. 0.60 x 1.67 = 1.002, and the derivation assumes drop rate is a pure linear multiplier on the meso-bag roll with a hard 100% ceiling. I could not source the 60% base to any Nexon/official or post-v.271 material. Nexon's v.271 patch notes (https://www.nexon.com/maplestory/news/update/44597/v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes, updated 2026-09-10) is a JS-rendered SPA and returned no body text to fetch, so I could not confirm or rule out a v.271 change to meso drop mechanics — another reason not to ship this number.

CAVEAT ON MY OWN COVERAGE: the session's WebSearch budget (200/200) was exhausted after two queries, so this rests on direct WebFetch of the primary source plus three secondary pages. That limits breadth but does not weaken points 1-3, which come from the primary source itself.

volatile: true — any base meso-bag chance or drop-rate breakpoint is a per-patch number.
- **Correction:** Do NOT ship a number. Correct handling: mark this breakpoint UNVERIFIED for GMS Heroic v.271. The closest defensible restatement of the cited source is "+67% MESO Drop Rate (not Item Drop Rate) against a claimed 60% base meso-bag chance" — but even that is unattributed to any server and frozen at 2022-11-16, so it must not be presented to the player as a GMS Heroic v.271 breakpoint. If MaplePlanner needs a meso-farming gear target, it should be sourced from a dated post-2026-09-09 GMS Heroic source or omitted. volatile: true.

### [nonCrystal] Item Drop Rate needed to guarantee a meso bag from every mob. This is the single most important breakpoint in meso farming: 0.60 x 1.67 = 1.00. Drop rate ABOVE +67% adds no further meso bags (it only adds item drops such as Sol Erda Fragments)

- **Stated:** +67% Item Drop Rate
- **Why refuted:** REFUTED on provenance and staleness. The +67% figure cannot be established as current for GMS Heroic v.271 (2026-09-09), and the cited source is four years dead.

1) The cited source is abandoned and predates the patch by ~46 months. https://github.com/Francesco149/mapleguide does contain the exact sentence: "mobs have a 60% base chance to drop meso bags. this means that if you have at least 67% drop rate you can guarantee that meso bags always drop because `0.6 * 1.67 = 1`". But its last commit via https://api.github.com/repos/Francesco149/mapleguide/commits is 2022-11-16 ("rotations: sort gate 4 list"). The repo is self-labelled "(WORK IN PROGRESS)" and states "this is a work in progress". A 2022-11 figure cannot be a v.271 (2026-09-09) figure, and this is exactly the "old guide ranking highly in search" failure mode.

2) The source fails the server-specificity test. The guide covers GMS Reboot AND non-Reboot, KMS, MSEA, TMS, JMS and CMS in one document and does not scope the 60%/67% line to GMS Heroic. Per the accuracy rules, that makes it unverified for Heroic, not merely old.

3) Drop-rate mechanics demonstrably changed AFTER the source was written, so it is provably stale on adjacent numbers. https://www.digitaltq.com/maplestory-item-drop-rate (pub. 2024-08-30) states total Item Drop Rate "is capped at 400% as of patch V253" — a cap change the 2022 guide could not know about. A guide already wrong about the drop-rate cap is not a citable authority on the drop-rate breakpoint. (volatile:true — the 400% cap is itself a v.253 number, also pre-v.271.)

4) Every corroborating source is also pre-patch; zero post-2026-09-09 confirmation exists. https://gamerempire.net/maplestory-reboot-meso-farming-guide/ ("By default, mobs only have a 60% chance to drop meso pouches" / "you need to have minimum +67% drop rate") is last-modified 2024-01-14. I found no source dated after 2026-09-09 restating 60%/67%. All apparent "confirmation" traces back to the same 2022 mapleguide sentence being copied forward.

5) v.271 plausibly touched this. Per https://patchbot.io/games/maplestory, v.271's headline features include "Familiar Updates". Familiars are one of the primary Item Drop Rate sources on Heroic, so a familiar rework is directly upstream of any drop-rate breakpoint. I could not confirm the detail: the official notes at https://www.nexon.com/maplestory/news/update/44597/v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes are a JS-rendered SPA that returns only the page title to WebFetch, and maplestorywiki.net returns HTTP 403. Inability to read the primary source is a reason to withhold the number, not to publish it.

6) The claim's arithmetic assumes a purely linear multiplier, which Nexon has contradicted for other drops. On https://forums.maplestory.nexon.net/discussion/15714/changes-to-drop-rate-formula-confirmation/p6, Nexon's response states "additional drop rate multipliers will be applied in smaller increments" alongside a base-rate increase for Nodestones. "0.60 x 1.67 = 1.00" only holds if drop rate scales meso-bag chance linearly with no diminishing returns and no separate meso-bag handling — an assumption the claim asserts rather than sources.

7) The second half of the claim is unsourced even in the cited guide. "Drop rate ABOVE +67% adds no further meso bags (it only adds item drops such as Sol Erda Fragments)" does not appear in mapleguide and I found no source for it. It also presumes a uniform 60% base across all mobs; meso drop chance is generally a per-mob drop-table value, so a single global breakpoint is suspect regardless of patch.

Practical impact for MaplePlanner: this is presented as "the single most important breakpoint in meso farming." Telling a Lv 244 Bow Master to stop stacking drop rate at exactly +67% — or to chase it as a hard target — on the authority of a 2022 work-in-progress file is precisely the "grind for nothing" outcome the tool must avoid. Note the claim is stated as nonCrystal, meaning it would be treated as a stable structural fact; it is not — it is a volatile:true rate number in a patch cycle that reworks meso and drop economics.

Web search budget for this session was exhausted (200/200) partway through, so this rests on the fetches above rather than a broader sweep. That does not change the verdict: the burden is on the claim, and nothing dated after 2026-09-09 supports it.
- **Correction:** No verified v.271 value could be established — do not ship a number here. MaplePlanner should mark this UNVERIFIED (volatile:true) rather than display "+67%". The literal 60%/67% pair traces to a single 2022-11-16 source (github.com/Francesco149/mapleguide) that does not scope it to GMS Heroic and is already wrong on the adjacent drop-rate cap. If the figure is shown at all, label it: "+67% Item Drop Rate — community figure, last sourced 2022, unconfirmed for GMS Heroic v.271; v.271 reworked Familiars, a primary drop-rate source." The only patch-dated drop-rate number I could source is the total Item Drop Rate cap of 400% as of v.253 (https://www.digitaltq.com/maplestory-item-drop-rate, pub. 2024-08-30), which is itself pre-v.271 and also volatile:true. Resolving this needs the v.271 Familiar Updates section read from the rendered Nexon patch notes plus a post-2026-09-09 Heroic-specific drop test.

### [nonCrystal] %Mesos Obtained per potential line, scaled by the item's level

- **Stated:** item lvl 0-30: 10%; lvl 31-70: 15%; lvl 71+: 20%. All endgame accessories are lvl 71+, so 20% per line
- **Why refuted:** Server provenance cannot be established, and the claim misquotes its own source.

1) SOURCE IS STALE AND NOT REBOOT-SCOPED. GitHub API (https://api.github.com/repos/Francesco149/mapleguide) shows pushed_at = 2022-11-16 (created 2022-07-16, 9 stars, self-described "(WORK IN PROGRESS)", single author, unreviewed). The repo's updated_at of 2026-08-27 is metadata (a star/watch), not a content change. The content is ~4 years old as of 2026-09-11 and predates v.271 (2026-09-09) by nearly four years. It also predates GMS's "Heroic" world naming, so it cannot be describing GMS Heroic at v.271. The repo is explicitly a multi-region guide covering "regional differences across various MapleStory localizations" (GMS/KMS/MSEA) and attaches no region tag to the meso bracket table the claim quotes. (volatile:true — these are per-patch numbers.)

2) THE GUIDE ITSELF MIXES SERVERS, PROVING THE TABLES ARE NOT UNIFORMLY REBOOT-VALID. Its meso BONUS-potential row is flagged verbatim "(non-reboot only)" (https://github.com/Francesco149/mapleguide). So the author does distinguish Reboot from non-Reboot in the meso section, and at least one meso row does NOT apply to Heroic. The accessory-potential row cited carries no such tag either way — absence of a tag is not evidence it applies to Reboot.

3) THE CLAIM MISREADS THE TABLE IT CITES. In the guide the bracket column is headed "item level | drop rate" (0-30 10%, 31-70 15%, 71+ 20%) and the SAME table is reproduced under both the drop-rate and meso-obtained sections. The researcher has presented a drop-rate-labeled bracket table as the %Mesos Obtained scaling table. No source I could reach independently confirms that %Mesos Obtained uses the same 0-30/31-70/71+ brackets; the 10% and 15% low-level values trace to this single stale source only.

4) THE CLAIM DROPS A MATERIAL QUALIFIER. The source says these are the LEGENDARY-tier values. The claim says "per potential line" with no tier qualification. %Mesos Obtained does not roll below Legendary on accessory potential (https://gamerempire.net/maplestory-reboot-meso-farming-guide/, modified 2024-01-14, Reboot-specific: "An item has to be of legendary rarity before the +% Mesos Obtained line can be rolled on their potential"). A planner applying 20%/line to a Unique accessory would produce a wrong answer.

5) PARTIAL CORROBORATION EXISTS FOR THE ENDGAME NUMBER BUT NOT AT v.271. Reboot-specific sources agree on 20% per Legendary line on the accessories used at endgame and a +100% equipment cap: https://gamerempire.net/maplestory-reboot-meso-farming-guide/ (modified 2024-01-14) and https://gametaco.net/reboot-meso-guide/ (last updated 2021-12-05, "There is a limit to how much Mesos Obtained % you can get from items. It is 100%"). Both are pre-v.271 (2.5 and 4.75 years old). gamerempire additionally contradicts the flat 71+ framing by stating "items over level 151" give better results, an inconsistency I could not resolve.

6) COULD NOT REACH AN AUTHORITATIVE CURRENT SOURCE. maplestorywiki.net/w/Meso and /w/Potential both returned HTTP 403; maplestory.wiki returned an empty shell; Nexon's official patch notes (https://www.nexon.com/maplestory/news/patch-notes) are JS-rendered and returned no content, so I could not check whether v.271 touched meso potential values. The session's WebSearch budget (200/200) was exhausted before further chasing was possible.

Bottom line: the practical endgame figure is probably right, but the claim as written — level-bracket scaling table, no tier qualifier, sourced to a 2022 multi-region WIP repo whose meso section is itself partly non-Reboot — is not established for GMS Heroic v.271 and should not ship unqualified.
- **Correction:** Best-supported statement, with its limits stated (do NOT present as v.271-verified):

%Mesos Obtained on GMS Reboot/Heroic rolls ONLY at LEGENDARY potential tier, and only on Ring, Pendant, Earring, Face Accessory and Eye Accessory. On the level-71+ accessories used at endgame it is +20% per line (volatile:true). Equipment total caps at +100% Mesos Obtained (volatile:true), on top of which Inner Ability contributes up to +20% (Legendary) and the Legion grid up to +5%.
Sources: https://gamerempire.net/maplestory-reboot-meso-farming-guide/ (Reboot-specific, last modified 2024-01-14) and https://gametaco.net/reboot-meso-guide/ (Reboot-specific, last updated 2021-12-05). Both PRE-v.271 — treat the figures as unverified for the current patch.

Do NOT ship the 10% (lvl 0-30) / 15% (lvl 31-70) brackets as meso values. They trace to one 2022 multi-region WIP repo where the column is literally labeled "drop rate," and no Reboot-specific or post-v.271 source confirms they apply to %Mesos Obtained. Since the claim itself concedes all endgame accessories are 71+, the brackets are load-bearing for nothing in the planner and should simply be dropped.

To make this shippable, verify against in-game v.271 data or Nexon's v.271 patch notes directly — no reachable source dated after 2026-09-09 confirms any of these numbers.

### [nonCrystal] %Mesos Obtained per potential line, scaled by the item's level

- **Stated:** item lvl 0-30: 10%; lvl 31-70: 15%; lvl 71+: 20%. All endgame accessories are lvl 71+, so 20% per line
- **Why refuted:** REFUTED — but not for the reason the brief anticipated. I checked the actual v.271 notes, and they do NOT touch this line; the claim fails instead on sourcing, server-scope, and a materially wrong conclusion.

1) v.271 did not change %Mesos Obtained potential. I loaded the official GMS notes (https://www.nexon.com/maplestory/news/update/44597/updated-9-10-v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes, posted 2026-09-08, "[UPDATED 9/10]", update live 2026-09-09) and string-searched the full 111k-char body: 0 occurrences of "Mesos Obtained" or "Meso Obtained", and no potential-system value changes anywhere. v.271 DID change symbol economics (Arcane River daily 20 -> 40 Arcane Symbols, weekly 40 -> 80; Grandis daily Cernium 20 -> 30 Sacred, Hotel Arcus/Odium/Shangri-La/Arteria/Carcion 10 -> 15 Sacred, Tallahart/Geardock 10 -> 15 Grand Sacred) and the Rebirth Flame / Bonus Stat economy (bonus-stat reset for 3,000,000 mesos; Powerful/Eternal/Black Rebirth Flames removed from boss/elite drops) — so "v.271 changed meso and symbol economics" is true for symbols and flames, false for the meso potential line. Do not mark this figure stale-by-patch; that specific hypothesis is falsified. [volatile:true on all symbol/flame figures]

2) The cited source is ~4 years stale and not GMS-specific. Francesco149/mapleguide's newest commit on master is 2022-11-16 ("rotations: sort gate 4 list", 775e72d) — https://github.com/Francesco149/mapleguide/commits/master. Its README is explicitly a cross-region guide comparing KMS/GMS/MSEA/TMS/JMS/CMS and never states which region the potential table is from, and it says nothing about Heroic/Reboot for this table. Under MaplePlanner's own rule ("if a source does not say which server it describes, treat it as unverified"), this figure is unverified for GMS Heroic v.271. I could not find any post-2026-09-09 GMS source stating the per-line value, and I could not read the live game data — so the 20% is plausible-but-unconfirmed, not confirmed.

3) The claim's operative conclusion — "All endgame accessories are lvl 71+, so 20% per line" — is wrong in a way that will mislead the planner. %Mesos Obtained rolls on only five slot types: Face Accessory, Eye Accessory, Ring, Earring, Pendant. That is stated by the cited source itself, and independently by https://gamerempire.net/maplestory-reboot-meso-farming-guide/ (2024-01-14, explicitly GMS Reboot) and https://thedigitalcrowns.com/maplestory-reboot-meso-farming-guide/ (2021-12-05, Reboot). It does not roll on hat, gloves, belt, shoulder, cape, shoes, badge, medal, emblem, pocket or heart. Worse, equipment-potential Mesos Obtained is hard-capped at +100% total (5 lines) — all three sources agree. A tool that applies "20% per line to all endgame accessories" will compute a meso multiplier the player can never reach and will tell them to cube gear that cannot carry the line.

4) The stated causal mechanism is contested. mapleguide attributes the 10/15/20 band to item level; gamerempire (GMS Reboot) attributes the 5/10/15/20 progression to potential rarity tier (Rare 5 / Epic 10 / Unique 15 / Legendary 20) while simultaneously saying Legendary is required to roll the line at all. Two published accounts, two different causes, neither traceable to game data. The "lvl 0-30 / 31-70" bands are untestable in practice for this player anyway and should not be shipped as fact.

Coverage note: I exhausted the session's WebSearch budget early and Google/DuckDuckGo/Mojeek/Bing all bot-blocked or served CAPTCHAs (which I did not attempt), so the patch-note verification was done by pulling the official page directly in the browser. maplestorywiki.net returned 403 and maplestory.fandom.com returned 402, so I have no wiki-level corroboration.
- **Correction:** Best-supported value, with its limits stated: +20% Mesos Obtained per LEGENDARY potential line on an item of Lv.71+ — but only on Face Accessory, Eye Accessory, Ring, Earring, and Pendant, and the total from equipment potential is hard-capped at +100% (effectively 5 lines). Lower-level bands reported as Lv.0-30 = 10%, Lv.31-70 = 15%. [volatile:true]

Sourcing: https://github.com/Francesco149/mapleguide (region-unspecified, last commit 2022-11-16) for the level bands; https://gamerempire.net/maplestory-reboot-meso-farming-guide/ (2024-01-14, GMS Reboot) and https://thedigitalcrowns.com/maplestory-reboot-meso-farming-guide/ (2021-12-05, Reboot) for the 20% Legendary value, the five eligible slots, and the +100% equipment cap. All three predate v.271; v.271 (https://www.nexon.com/maplestory/news/update/44597/updated-9-10-v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes) contains no change to this line, so the figures are unchanged-by-that-patch but still not confirmed against current GMS Heroic game data.

For MaplePlanner: ship the +100% equipment cap and the five-slot restriction as the load-bearing facts (three independent sources agree), and surface the per-line 20% with an "unverified for v.271 — sources are 2021-2024 and region-mixed" flag. Do not model "20% x every endgame accessory".

### [sinks] Star Force base meso cost formula (GMS, all worlds including Heroic)

- **Stated:** cost = 1000 + round(L^3 x (S+1)^2.7 / D), rounded to nearest 100, where L = item level, S = current star. D by star: 0-9 use (S+1)^1 / 25; 10->11 = 400; 11->12 = 220; 12->13 = 150; 13->14 = 110; 14->15 = 75; 15->16 and 16->17 = 200; 17->18 = 150; 18->19 = 70; 19->20 = 45; 20->21 = 200; 21->22 = 125; 22->30 = 200
- **Why refuted:** REFUTED as stated — but NOT for the reason the assignment anticipated. The "wrong-server import" hypothesis is disproven: I fetched the raw wikitext of the cited page today (curl https://maplestorywiki.net/w/Star_Force_Enhancement?action=raw — WebFetch 403s, curl with a UA works) and the researcher transcribed the GMS column exactly, not the KMS one. The page's "Base Meso Cost" table has two columns: Meso Cost (GMS) = divisors 25 / 400 / 220 / 150 / 110 / 75 for 0-15★, versus Meso Cost (KMS, JMS, MSEA) = 36 / 571 / 314 / 214 / 157 / 107. Every divisor in the claim matches GMS; none matches KMS. From 15★ up the table is a single merged cell for all regions and reads 200 / 200 / 150 / 70 / 45 / 200 / 125 / 200 — again exactly as claimed. It is not a private-server number either.

Independently corroborated: the community GMS calculator at https://brendonmay.github.io/starforceCalculator/serverDiffs.js implements the same thing with divisors exactly 100x larger plus a x100 final multiply (makeMesoFn(2500, 1), 40000, 22000, 15000, 11000, 7500, 20000, and extraMult 4/3, 20/7, 40/9, 8/5 at stars 17/18/19/21 — which reduce to 150, 70, 45, 125). I ran both implementations numerically and they agree to the meso: Lv200 17→18★ = 130,688,600; Lv250 21→22★ = 526,565,100; Lv160 14→15★ = 81,799,500. So the arithmetic is sound and GMS-labelled.

What is actually wrong, and why this must not ship as written:

1. "all worlds including Heroic" is unsourced. The cited table is segmented by REGION (GMS vs KMS/JMS/MSEA), never by world type. Neither the Star Force Enhancement page nor https://maplestorywiki.net/w/Reboot_World (to which "Heroic World" redirects) nor https://maplestorywiki.net/w/Equipment_Enhancement contains any statement that Heroic base costs equal Interactive base costs. The Reboot World page enumerates Reboot differences in detail (no trading, cash-shop restrictions, scrolls and Bonus Potential disabled, +10 Star Force on guild passives, 6x meso obtained) and a star force cost difference is NOT among them — suggestive, but that is argument from absence, not a citation. Note the same calculator models "TMS Reboot" as a distinct cost function (item level capped at 150), proving Reboot-type worlds CAN diverge on star force cost in some regions. So the Heroic scope is plausible but unverified; per the brief that alone forces refuted.

2. Materially incomplete for GMS at exactly this player's star range. The same wiki page has a section "Enhancement Mode (GMS only)": 15★ to 21★ offers 4 enhancement levels, Level 1 being standard rates and cost, Level 4 having 0% destruction, and "The cost to enhance is based on the Enhancement Mode level, where higher Enhancement Mode levels will cost more Meso." The claimed formula is the Level 1 cost only. A Lv244 Bow Master pushing 17→22★ is squarely in that band and most players do not tap at Level 1. The wiki does not quantify the multipliers and I could not source them — so MaplePlanner would understate real meso spend by an amount I cannot bound. Also unmentioned: Safeguard at 15★-17★ adds +200% of base (3x total, and that surcharge is not discounted), and Superior items use a different formula entirely, 1000 + round(L^3.56).

3. Rounding is stated ambiguously. The source rounds X/D to the nearest hundred and then adds 1000; the claim's "cost = 1000 + round(...), rounded to nearest 100" can be read as rounding after adding 1000, which diverges at edge cases.

4. Minor unresolved source conflict: the calculator floors item level to the nearest 10 (floor(L/10)*10) before cubing; the wiki uses L directly. Irrelevant for gear at Lv 150/160/200/250 but the two sources genuinely disagree.

5. Freshness, partially reassuring: the Base Meso Cost section's last substantive edits were 2025-12-01 and 2025-12-08 (revision comments "/* Base Meso Cost */", preceded by a 2025-11-30 edit noting "validated gms numbers match overseas numbers post-rework"). It has NOT been revalidated since v.271. I checked what v.271 did: https://maplestorywiki.net/w/MapleStory:_Crown/Post-Update is the GMS "MapleStory x Frieren" update (the page cites a "Coming Sept 9" trailer) and states "In GlobalMS... Most of the Equipment Enhancement reorganization changes were omitted from this update, except for the Bonus Stats Reset System, Rebirth Flame changes, and removal of Star Catch." The page's 2026-09-09 and 2026-09-11 edits touched only Destruction and Success Rates (I pulled both diffs; the 09-11 edit moved Star Catch and 5/10/15 into History). So base costs were probably not changed at v.271 — but "probably" is from a fan wiki, not Nexon. I could not reach official patch notes: nexon.com/maplestory returns a 3.7KB SPA shell to curl, strategywiki.org is behind Cloudflare, reddit.com returns 403, and this session's WebSearch budget was exhausted (200/200) before my first search, so I could not run a single search. All figures here are volatile:true (per-patch).
- **Correction:** Correct as far as it goes, but scope it and flag it. Verified GMS base cost (volatile:true, source https://maplestorywiki.net/w/Star_Force_Enhancement, Base Meso Cost table last revised 2025-12-08, read 2026-09-11):

base = 1000 + 100 * round( L^3 * (S+1)^E / (100*D) )

equivalently 1000 + [ L^3*(S+1)^E / D rounded to the nearest hundred ], L = item level, S = current star. E = 1 and D = 25 for 0★→10★; E = 2.7 thereafter with D = 400 (10→11), 220 (11→12), 150 (12→13), 110 (13→14), 75 (14→15), 200 (15→16), 200 (16→17), 150 (17→18), 70 (18→19), 45 (19→20), 200 (20→21), 125 (21→22), 200 (22★→30★). Superior items instead: 1000 + round(L^3.56), rounded to 100, no discounts. Worked values: Lv160 14→15★ = 81,799,500; Lv200 17→18★ = 130,688,600; Lv250 21→22★ = 526,565,100.

Required scope corrections before use in MaplePlanner:
- Label this "GMS, region-level figure; Heroic-world applicability UNVERIFIED" — no source distinguishes Heroic from Interactive for star force cost, and no source affirms they are equal. Do not print "all worlds including Heroic".
- This is the Enhancement Mode Level 1 cost only. Between 15★ and 21★ GMS charges more for Enhancement Mode Levels 2-4; the multipliers are unsourced, so the planner must show 15-21★ as a floor, not an estimate.
- Add Safeguard (15★-17★): +200% of base, i.e. 3x, and the surcharge is not reduced by discounts.
- Discounts to apply on top where relevant: Sunny Sunday 30% multiplicative (applied before safeguard); MVP/VIP 3% / 5% / 10% up to 16→17★.
- Cost per attempt is not cost per star — the planner still needs current v.271 success/boom rates, which the wiki did edit on 2026-09-09 and 2026-09-11 (Star Catch was removed in GMS and its ~5% multiplicative bonus folded into base rates), so any expected-total-meso model built on pre-September rates is stale.

### [sinks] Star Force base meso cost formula (GMS, all worlds including Heroic)

- **Stated:** cost = 1000 + round(L^3 x (S+1)^2.7 / D), rounded to nearest 100, where L = item level, S = current star. D by star: 0-9 use (S+1)^1 / 25; 10->11 = 400; 11->12 = 220; 12->13 = 150; 13->14 = 110; 14->15 = 75; 15->16 and 16->17 = 200; 17->18 = 150; 18->19 = 70; 19->20 = 45; 20->21 = 200; 21->22 = 125; 22->30 = 200
- **Why refuted:** REFUTED — but not for staleness. The divisor table is current for v.271; the formula as written is arithmetically broken and materially incomplete for this player's gear band.

WHAT I CHECKED (3 independent sources, all read 2026-09-11)
1. The cited page, https://maplestorywiki.net/w/Star_Force_Enhancement. Its revision history (https://maplestorywiki.net/index.php?title=Star_Force_Enhancement&action=history) shows edits at 2026-09-11 02:43 (Success Rates) and 2026-09-09 01:35 (Destruction) — i.e. actively maintained across v.271 launch day — with the "Base Meso Cost" section untouched.
2. Official GMS v.271 patch notes, https://www.nexon.com/maplestory/news/update/44597/updated-9-10-v-271-maple-story-x-frieren-beyond-journey-s-end-patch-notes (posted Sep 8 2026, updated 9/10). The ENTIRE "Star Force Changes" section is one bullet: "[Updated 9/10/2026] Removed the Star Catching feature from Star Force Enhancement. The increased enhancement success rate from Star Catching is now permanently applied to Star Force Enhancement." No meso-cost change anywhere in the notes. (v.271 did change symbol economics — Arcane daily 20→40, weekly 40→80, Sacred daily 20→30 / 10→15 — confirming the patch touched the economy but not this formula.)
3. MathBro's calculator source, https://brendonmay.github.io/starforceCalculator/serverDiffs.js, which routes "gms" -> kmsCost. Decoding its divisors (its 20000 == wiki 200) yields 400/220/150/110/75/200/200/150/70/45/200/125/200 — an exact match to both the wiki and the claim. I ran both implementations side by side: identical to the meso for every item level divisible by 10.

So the DIVISOR TABLE is right and current. The claim still fails on four counts:

(a) FATAL — the 0-9 branch is wrong as written, by 623x to 3,131x. "D by star: 0-9 use (S+1)^1 / 25" substituted into the stated master formula 1000 + round(L^3 x (S+1)^2.7 / D) gives 25 x L^3 x (S+1)^1.7, not L^3 x (S+1)/25. Lv 200 item at 0 stars: formula-as-written = 200,001,000 mesos; correct = 321,000. At 9 stars: 10,023,745,700 vs 3,201,000. Stars 0-9 need a different EXPONENT (1, not 2.7), not a different divisor — the claim tried to fold that into D and broke it. Shipped verbatim into a planner this is a 3-order-of-magnitude error.

(b) The "L = item level" term is contested and I could not resolve it. MathBro floors item level to the nearest 10 before cubing: (Math.floor(itemLevel/10)*10)**3. maplestorywiki uses raw L. They agree exactly on levels divisible by 10, and diverge 8-17% otherwise (Lv 158 at 17 stars: 64,435,100 wiki vs 55,134,800 MathBro; Lv 145: 11.1% apart). Most endgame gear is Lv 140/150/160/200 so this rarely bites, but the planner must not print a single confident number for off-decade levels.

(c) "all worlds including Heroic" is an inference, not a sourced fact. Neither the wiki's Base Meso Cost section nor its Reboot World "Differences from Regular World" list (https://maplestorywiki.net/w/Reboot_World) mentions any Heroic star force cost difference, and MathBro gives GMS a single cost path with no Heroic branch — notable because that same file DOES carry a "tmsr" (TMS Reboot) branch, so the concept exists in the code and GMS simply doesn't get one. Consistent with the claim, but nothing affirmatively states it. Treat as unverified-but-plausible, not established.

(d) It is a BASE cost sold as the cost, and it omits the multipliers that dominate exactly where a Lv 244 / 5.26M CP Bow Master is tapping (15-22 stars). Safeguard costs +200% of base at 15/16/17 stars — i.e. 3x — confirmed both by the cited wiki and by MathBro's getSafeguardMultiplierIncrease() returning 2 for gms at stars 15-17. And GMS-exclusive Enhancement Mode (4 levels, available 15-21 stars, "higher Enhancement Mode levels will cost more Meso", Lv4 = 0% destruction) is documented on the very page cited, is modeled by neither the claim nor MathBro, and I found no published cost multipliers for it. A 17->22 plan built on the bare formula will under-quote badly.

ONE MORE TRAP FOR THE TOOL: v.271 did change Star Force, just not the cost. Star Catching was removed 2026-09-09/10 and its +5% multiplicative success bonus is now permanent. That changes EXPECTED total meso to reach a target star — which is what a planner actually reports — even though per-tap base cost is unchanged. MathBro's calculator still exposes a "Star Catching: yes/no" toggle and is therefore stale on rates as of 2026-09-11; do not ingest its rate tables.

Every figure above is volatile:true (per-patch).
- **Correction:** GMS v.271 base Star Force meso cost, per attempt, before any multiplier. Verified 2026-09-11 against maplestorywiki.net (edited through v.271 launch day, cost section unchanged), the official v.271 patch notes, and MathBro's serverDiffs.js — all three agree. volatile:true.

Stars 0-9 (0 -> 10):   cost = 1000 + L^3 * (S+1) / 25          <- exponent 1, NOT 2.7
Stars 10-29:           cost = 1000 + L^3 * (S+1)^2.7 / D_S
Result rounded to the nearest 100. L = item level, S = current star.

D_S: 10->400, 11->220, 12->150, 13->110, 14->75, 15->200, 16->200, 17->150, 18->70, 19->45, 20->200, 21->125, 22 through 29->200.
(The claim's divisor table is correct and current — only its 0-9 branch and its scope claims are wrong.)

UNRESOLVED: maplestorywiki uses raw L; MathBro uses floor(L/10)*10 before cubing. Identical for item levels divisible by 10 (covers Lv 140/150/160/200 gear); 8-17% apart otherwise. Flag off-decade item levels rather than printing one number.

MULTIPLIERS THE BASE FORMULA EXCLUDES (GMS):
- Safeguard, 15/16/17 stars: +200% of base = 3x total. Sourced (wiki + MathBro).
- Enhancement Mode (GMS only, 15-21 stars, levels 1-4): levels above 1 cost more meso. Magnitude NOT sourced — could not verify. Level 1 = the base formula above.
- Sunny Sunday: 30% off Star Force. Per v.271 notes, scheduled Sep 13, Sep 27, Oct 11, Oct 25, Nov 8 2026 (UTC). Excludes Superior equipment; mesos spent on safeguard are NOT discounted.
- MVP Silver/Gold/Diamond+: 3%/5%/10% off, up to 16->17 stars only.

Reference base costs, Lv 200 item, no multipliers (computed from the verified formula, both implementations agreeing to the meso):
  15->16:  71,316,500    16->17:  83,999,600    17->18: 130,688,600
  18->19: 324,061,900    19->20: 578,974,200    20->21: 148,612,400
  21->22: 269,601,800
Lv 160 item: 17->18 = 66,913,100; 18->19 = 165,920,200; 19->20 = 296,435,300.

Heroic/Interactive: no evidence of any GMS world-based cost difference, but no source affirmatively states equality either — label this as unverified in the tool rather than asserting it.

### [sinks] Per-tap base meso cost on a Lv 150 item (no event, Enhancement Mode 1)

- **Stated:** 0->1: 136,000 | 9->10: 1,351,000 | 10->11: 5,470,800 | 12->13: 22,900,700 | 14->15: 67,400,800 | 15->16: 30,087,200 | 16->17: 35,437,900 | 17->18: 55,134,800 | 18->19: 136,714,200 | 19->20: 244,255,300 | 20->21: 62,696,400 | 21->22: 113,738,800
- **Why refuted:** REFUTED — not because the numbers are miscalculated, but because their provenance is entirely pre-v.271, unversioned, and server-ambiguous. volatile:true on every figure.

1) THE CITED SOURCE IS UNVERIFIABLE. https://maplestorywiki.net/w/Star_Force_Enhancement returned HTTP 403 Forbidden on every attempt, as did the raw wikitext (index.php?action=raw). I could not confirm the page contains these 12 numbers, its last-edited date, whether it describes GMS or KMS, or whether it covers Reboot/Heroic. Per the accuracy rules, a source that does not state its server is unverified — and here I could not even read it. The researcher's citation cannot be checked.

2) THE NUMBERS ARE ARITHMETICALLY EXACT — FOR ONE SPECIFIC FORMULA. I reconstructed the cost table from two independent open-source GMS starforce calculators and recomputed all 12 values by hand. Formula: item level floored to nearest 10 (150 stays 150), L^3 = 3,375,000; stars 0-9 = L^3*(star+1)/2500; star 10 /40000, 11 /22000, 12 /15000, 13 /11000, 14 /7500, all with exponent 2.7 on (star+1); stars 15+ /20000 with multipliers 1, 1, 4/3, 20/7, 40/9, 1, 8/5 for stars 15,16,17,18,19,20,21; then floor(base)+10, x100. Every claimed value reproduces exactly: 0->1 = 136,000; 9->10 = 1,351,000; 10->11 = 5,470,800; 12->13 = 22,900,700; 15->16 = 30,087,200; 16->17 = 35,437,900; 18->19 = 136,714,200; 19->20 = 244,255,300; 20->21 = 62,696,400; 21->22 = 113,738,800. The figures are not invented. That is exactly why they are dangerous: they look authoritative because they are a faithful evaluation of a table nobody can date.

3) EVERY REACHABLE SOURCE FOR THAT TABLE PREDATES THE PATCH. v.271 released 2026-09-09. The two implementations encoding this table were last updated https://github.com/blushiemagic/Maplestory-Starforce-Calculator (2026-07-22, ~7 weeks before the patch) and https://github.com/wongsyu/Maplestory-Starforce-Calculator-Enhanced (2026-08-30, ~10 days before). Neither carries a version stamp, patch number, or date in code or docs. There is no post-2026-09-09 source anywhere in my reach confirming these values survived the patch.

4) THE MAINTAINERS THEMSELVES SAY YOU CANNOT DATE THESE NUMBERS. wongsyu's HANDOFF.md states rates "change every patch" and proposes adding a ratesVersion stamp that is explicitly not yet implemented. That is a community-maintained table openly documented as undatable — the exact failure mode the brief warns about, since v.271 changed meso economics.

5) NO REBOOT/HEROIC QUALIFIER. The claim gives no server. Neither calculator distinguishes Heroic from regular GMS worlds. For a tool advising a Heroic player, an unqualified starforce cost is unsafe on its face.

6) TWO COMMUNITY IMPLEMENTATIONS ALREADY DISAGREE. blushiemagic uses Math.round where the claim uses floor. At 14->15 that is 67,400,900 vs the claimed 67,400,800. A 100-meso gap is trivial in play but proves the table is reverse-engineered from observation, not read off an official spec — so it has no authority to resist a patch-note change.

7) "ENHANCEMENT MODE 1" IS ITSELF AN UNSOURCED ASSUMPTION. The qualifier implies a multi-mode system with per-mode multipliers (wongsyu's rates.js does carry mode multipliers), but I found no dated source establishing the v.271 mode-1 multiplier. The claim's own framing depends on a parameter it does not cite.

RESEARCH LIMITATION, STATED PLAINLY: this session's WebSearch budget (200/200) was exhausted before I began, so I worked entirely through direct fetches. nexon.com patch-note pages are JS-rendered and returned only a page title; forums.nexon.com does not resolve; reddit and strategywiki were blocked. I therefore could NOT read v.271 patch notes to check whether they touched starforce costs. Absence of confirmation is not confirmation of change — but under the brief's default (unverified = refuted), an undatable pre-patch table must not ship as current.

NO CORRECTED VALUE OFFERED. I could not establish the true GMS Heroic v.271 figures and will not guess; a fabricated replacement would be worse than the stale one. Recommended handling in MaplePlanner: do not hardcode these as current. Either gate them behind a visible "pre-v.271, unverified for Heroic" warning, or re-derive from the v.271 patch notes / in-game enhancement UI before use. The formula shape (L^3, exponent 2.7, the divisor ladder, +10 then x100) is likely still structurally right and is worth keeping as scaffolding — it is the multipliers, the mode-1 assumption, and the Heroic delta that need a post-2026-09-09 primary source.

### [sinks] Where the cost cliffs are

- **Stated:** Two cliffs, not one. (1) 14->15 is the most expensive tap below 17 (67.4M on Lv 150) and the cost then DROPS to 30.1M at 15->16. (2) The real wall is 17->18 / 18->19 / 19->20, which carry baked-in cost multipliers of 4/3, 20/7 and 40/9 and only 15.75% success; on a Lv 150 item the 19->20 tap alone costs 244M and absorbs ~28% of all mesos spent going 17->22. Cost then collapses again to 62.7M at 20->21.
- **Why refuted:** REFUTED on provenance, not arithmetic. The claim reads its source faithfully — I reproduced every figure exactly (14->15 = 67,393,000; 15->16 = 30,099,300; 19->20 = 244,246,500; 20->21 = 62,701,800 on a Lv150 item) using cost = 100*round(mult * lvl^3 * (star+1)^2.7 / divisor + 10). But the source cannot support a GMS Heroic/Reboot claim.

1) THE MULTIPLIERS ARE KMS COEFFICIENTS. I traced the cited file (https://starforce.tadeucci.dev/rates.js) to the upstream it names. Real path: https://raw.githubusercontent.com/brendonmay/brendonmay.github.io/master/starforceCalculator/serverDiffs.js (the path in the derivative's header comment, src/serverDiffs.js, 404s). Upstream, 4/3, 20/7 and 40/9 live in a function literally named `kmsMesoFn`. GMS inherits them only through a hand-written mapping — `const SERVER_COST_FUNCTIONS = { "gms": kmsCost, ... }` — annotated "As of the ignition update GMS uses KMS starforce prices." That is a community assumption, and upstream's own header sources everything to strategywiki.org, a player wiki, not Nexon. So these are KMS numbers relabeled GMS.

2) NO REBOOT/HEROIC DIMENSION EXISTS IN THE DATA. Upstream's server list is gms / old / gmsPre30 / tms / tmsr / kms. The only Reboot entry is `tmsr` = TMS Reboot, and it is materially different (`tmsRebootCost` caps item level at 150). There is NO GMS Heroic/Reboot cost function anywhere in the upstream model. The derivative file then strips the server dimension entirely and presents one table headed "GMS Star Force". The exact distinction MaplePlanner depends on is absent from the source, so the source cannot establish it either way — which under the brief's rule is a refutation.

3) THE "15.75% SUCCESS" IS AN UNSOURCED EDITORIAL TRANSFORM. Upstream `kmsRates` gives 15% at stars 17/18/19 ([0.15, 0.782, 0, 0.068]), with star catching as a separate user toggle. The derivative multiplied every success by 1.05 and rescaled maintain/boom in the old proportion (0.782:0.068 -> 0.7751:0.0674), justified by a header assertion that "Star Catching was removed from the game" and Nexon folded the +5% into displayed rates. That assertion appears nowhere upstream, cites no patch note, no version, no date, only an anonymous "Confirmed 1:1 against the in-game panel." The claim's 15.75% rests entirely on it.

4) AN ENTIRE SYSTEM IN THE DERIVATIVE IS UNCORROBORATED. Its "Enhancement Mode" (1-4 slider, cost mults up to 6.5x, said to "replace the Safeguard model" for 15->21) does not exist upstream, which models Safeguard instead (`getSafeguardMultiplierIncrease`: +2x cost at stars 15-17 for gms/kms). If Enhancement Mode is real, the claim's 17->22 cost picture is understated, since it implicitly assumes mode-1 pricing.

5) STALE BY THE BRIEF'S OWN CUTOFF. GitHub API reports the upstream repo `pushed_at` 2026-01-22 — about 7.5 months before v.271 (2026-09-09), the patch the brief says changed meso economics. The derivative carries no date or version stamp at all.

6) THE DERIVATIVE IS LOSSY. It exports divisor/expo/mult but drops the formula, including upstream's floor-to-nearest-10 on item level: `(Math.floor(itemLevel/10)*10)**3`. Harmless at Lv150, wrong for Lv145/158-type gear.

Also: the "~28%" is slightly off even on its own data — Monte Carlo (400k runs, boom resets to 12 stars, no chance time) gives 19->20 absorbing 26.6% of expected 17->22 spend on the derivative's rates, 25.8% on upstream base rates.

Caveat on my own work: this session's WebSearch budget was exhausted (200/200) before I could issue any search, so I verified by fetching primary files directly rather than by surveying independent GMS Heroic sources. I could NOT establish whether GMS Heroic/Reboot applies its own star force cost multiplier — and neither can the cited source, which is the point.
- **Correction:** Do not ship these as GMS Heroic/Reboot v.271 figures. What is actually defensible:

SHAPE (likely right, server-agnostic): the two-cliff structure is real in the Savior cost table and survives on both the derivative and upstream base rates. 14->15 is the most expensive tap below 17 because the divisor bottoms out at 7,500 at star 14 and snaps back to 20,000 at star 15; and 17/18/19 carry cost multipliers 4/3, 20/7, 40/9 before collapsing to 1 at star 20.

NUMBERS (arithmetically reproducible, but KMS-derived and pre-v271 — volatile:true, all of them): at Lv150, 12->13 22.9M, 13->14 38.1M, 14->15 67.4M, 15->16 30.1M, 16->17 35.4M, 17->18 55.1M, 18->19 136.7M, 19->20 244.3M, 20->21 62.7M, 21->22 113.7M. Formula: 100*round(mult * (floor(lvl/10)*10)^3 * (star+1)^2.7 / divisor + 10).

RATES: use 15% base success at 17/18/19, not 15.75%. 15.75% is 15% x 1.05 (star catching) folded in by the derivative on an uncorroborated claim that star catching was removed. Source: upstream kmsRates 17: [0.15, 0.782, 0, 0.068], 19: [0.15, 0.765, 0, 0.085] — https://raw.githubusercontent.com/brendonmay/brendonmay.github.io/master/starforceCalculator/serverDiffs.js

SHARE: 19->20 absorbs ~26-27% of expected 17->22 spend, not ~28% (400k-run simulation, boom resets to 12 stars).

REQUIRED LABEL: "KMS cost coefficients applied to GMS by community convention; not verified for Heroic/Reboot; upstream last updated 2026-01-22, pre-v.271." To actually source this for Heroic, MaplePlanner needs either a v.271 GMS patch note or in-game screenshots of the star force panel taken on Heroic after 2026-09-09 — the cited calculator does not model GMS Reboot at all.

### [sinks] Where the cost cliffs are

- **Stated:** Two cliffs, not one. (1) 14->15 is the most expensive tap below 17 (67.4M on Lv 150) and the cost then DROPS to 30.1M at 15->16. (2) The real wall is 17->18 / 18->19 / 19->20, which carry baked-in cost multipliers of 4/3, 20/7 and 40/9 and only 15.75% success; on a Lv 150 item the 19->20 tap alone costs 244M and absorbs ~28% of all mesos spent going 17->22. Cost then collapses again to 62.7M at 20->21.
- **Why refuted:** REFUTED — stale by two patches, and mode-blind in a way that specifically breaks for Heroic.

VERSION (decisive). The cited file carries no internal date, version, or changelog. Its host page, however, self-labels as "v269 GMS" (https://starforce.tadeucci.dev/). Current GMS is v.271, confirmed on Nexon's own news index as "v.271 - MapleStory x Frieren: Beyond Journey's End Patch Notes," dated Sep 8 2026, updated 9/10 (https://www.nexon.com/maplestory/news). So every number in this claim is sourced to a build two patches behind the live game, in a patch cycle the brief flags as having moved meso economics. I could NOT retrieve the v.271 patch notes body to confirm or deny a Star Force change: nexon.com/maplestory is a JS SPA that returns only a page title to fetch, a reader proxy returned only the news index, reddit.com and old.reddit.com are blocked, maplestory.fandom.com returned 402, maplestorywiki.net and strategywiki 403, and this session's WebSearch budget was exhausted before I could search. Per the accuracy rules, unverified against the current patch = refuted. Note also that this is a reverse-engineered community table (its own metadata says rates were "verified against in-game panel at 18 stars"), not a Nexon-published formula — Nexon has never published the meso cost formula, so there is no primary source behind any version of this number.

INTERNAL ARITHMETIC IS FAITHFUL (so the claim is stale, not fabricated). I rebuilt the cost function from the raw file and reproduced every headline figure exactly at Lv 150: 13->14 38.1M, 14->15 67.4M, 15->16 30.1M, 16->17 35.4M, 17->18 55.1M, 18->19 136.7M, 19->20 244.3M, 20->21 62.7M. The raw coefficients are COST_COEFS[14]={divisor:7500} (the 14->15 spike), [15]/[16]={20000,mult 1}, [17]={mult 4/3}, [18]={mult 20/7}, [19]={mult 40/9}, [20]={mult 1}. The 15.75% success figure also checks out: GMS_RATES is indexed by CURRENT star, and 17/18/19 are [0.1575, ...] with booms of 6.74%/6.74%/8.425% (https://starforce.tadeucci.dev/rates.js). So the claim reads its source correctly — the source is just old.

THREE SUBSTANTIVE ERRORS INDEPENDENT OF THE PATCH:

1. Mode-blind — the worst one for a Reboot tool. The same file defines ENHANCE_MODE: four Enhancement Modes multiply 15*-21* cost by 1 / 1.5 / 2.5 / 3 at stars 15-17 and 1 / 2 / 3.5 / 6.5 at stars 18-21, scaling boom down to zero in Mode 4. Every figure in this claim is Mode 1 only — the cheapest, highest-boom setting. A Heroic player safeguarding a boss drop at 19* pays up to 1.59B on that tap, not 244M (6.5x). In Heroic there is no trading, so a boomed boss item cannot be re-bought; higher modes are the normal choice, which means 244M is close to the least likely number the player actually pays.

2. The "~28% of all mesos spent going 17->22" does not reproduce as a fixed number. Solving the Markov chain (fail = no star loss, boom returns the item to 12*, re-climb included) gives the 19* share as 26.6% in Mode 1 without Chance Time, 33.4% in Mode 1 with Chance Time, and 35.6% / 40.6% / 44.3% in Modes 2/3/4. "~28%" is one point in a 27-44% range. rates.js implements no Chance Time at all, so any figure derived from it ignores GMS's guaranteed-success-after-consecutive-fails mechanic.

3. "Cost then collapses again to 62.7M at 20->21" is true but truncated inside the claim's own stated 17->22 window: COST_COEFS[21] carries mult 8/5, so 21->22 costs 113.7M — nearly double the "collapsed" value. The claim's own framing of "two cliffs" is wrong on its own data; within 17->22 the cost curve rises, peaks at 19*, drops at 20*, then rises again at 21*.
- **Correction:** No v.271-verified figure can be stated — do not ship a meso number for this. Best available (v269 GMS, community reverse-engineered, UNVERIFIED for v.271):

Structure is roughly right but must be qualified three ways. Base per-tap cost at Lv 150 in Enhancement Mode 1: 14->15 = 67.4M (from divisor 7500, genuinely the priciest tap below 17*), 15->16 = 30.1M, 16->17 = 35.4M, 17->18 = 55.1M, 18->19 = 136.7M, 19->20 = 244.3M, 20->21 = 62.7M, 21->22 = 113.7M. Multipliers are 4/3 at 17*, 20/7 at 18*, 40/9 at 19*, and 8/5 at 21* (the claim omits the 21* multiplier). Success is 15.75% at 17/18/19 with booms of 6.74%/6.74%/8.425%.

Required qualifiers: (a) these are Mode 1 only — multiply 15*-17* by 1/1.5/2.5/3 and 18*-21* by 1/2/3.5/6.5 for Modes 1-4, so 19->20 ranges 244M to 1.59B; (b) the 19* share of total 17->22 spend is 27-44% depending on mode, not ~28%; (c) all of it is v269 data with no primary source and no confirmation it survived v.271 (2026-09-08). For MaplePlanner, surface this as a mode-dependent range labeled "v269 data, unconfirmed for v.271," or withhold the meso figures and give only the ordinal advice (14->15 and 17*-19* are the expensive taps; safeguard matters most at 18*-21* in Heroic because boomed boss gear cannot be re-acquired by trading). Mark volatile:true on every number above.

---

# Unanswered questions (49)

- crystals: Which GMS patch raised the per-character Weekly-crystal sale limit from 12 to 14. No official Nexon patch note found. Evidence FOR 14: maplestorywiki (edited 26 Aug 2026) explicitly splits GMS=14 from KMS/JMS/CMS/MSEA/TMS=12, and NamuWiki's GMS section (30 Aug 2026) says the same. Evidence FOR 12: Grandis Library's progression guide currently reads 'the Collector will only accept 12 weekly crystals'; a Nov 2024 GMS forum thread asked Nexon to raise it to 14 and a Jul 2025 forum post describes a player hitting the wall at 12. Best reading is that GMS changed 12 to 14 sometime after Aug 2025 and Grandis Library is stale, but I cannot prove it. RECOMMENDATION: make this value configurable and show the user which assumption is in play.
- crystals: Whether GMS runs the weekly price-fluctuation system (daily/weekly boss crystal prices drifting up to 3% each Thursday based on server-wide clear counts). KMS suspended this system on 4 Jan 2024 and has used discrete manual repricings since. NamuWiki presents GMS prices as fixed 'completely independent' values, and I found no GMS-specific statement either way. Assume GMS prices are static between patches, but do not promise that to users.
- crystals: Whether Hell Gollux (or any Gollux difficulty) drops an Intense Power Crystal at all. It appears in zero crystal value tables and DigitalTQ marks its crystal price N/A, but the maplestorywiki Reboot World page mentions Gollux in a sentence about the 5% damage requirement for 'non-quest rewards including Intense Power Crystal', which is ambiguous. I could not source any Gollux crystal meso figure, and I did not verify Gollux's direct meso/coin rewards, which are a separate income mechanic.
- crystals: Whether or when the KMS September 2026 crystal changes reach GMS: the tier-wide price cuts (-50% below Hard Lotus, -5% Hard bosses below Black Mage, -35% Extreme Seren and Extreme Black Mage) and the removal of the per-character weekly sale limit. GMS has historically declined KMS crystal nerfs (NamuWiki states the reason is that Heroic World is GMS's mainstream so meso value needs no protecting), but a future GMS patch could import them and would invalidate the entire value table at once.
- crystals: The exact Hard Chosen Seren value: maplestorywiki says 219,312,000 Interactive (1,096,560,000 Heroic), NamuWiki says 219,312,500 (1,096,562,500). A 500-meso discrepancy; one is a transcription error and I could not determine which.
- crystals: Official confirmation of the Thursday 00:00 UTC reset for the crystal sale allowance specifically. Two community sources state it and it matches the weekly boss reset, but I found no Nexon page stating it.
- crystals: The exact mechanics of the 'difference of mesos' payout on higher-value Weekly crystals (maplestorywiki). Whether it compares against the cheapest crystal already sold, whether it applies to the 180 world cap as well as the per-character weekly slots, and whether it works across characters — all unverified.
- crystals: PROCESS NOTE, not a research question: during this session my browser tab unexpectedly redirected from en.namu.wiki to a third-party site, maplestory.kotenarok.com ('MapleStory Heroic Boss Optimizer'). I did not navigate there. I treated its content as untrusted data, followed no instructions from it, and used it only as weak corroboration on the 14-slot / 180-cap / monthly-boss interaction. Every load-bearing number in the findings above is sourced elsewhere.
- rosters: Realistic clear times in minutes for any boss at this character's power level. I found no sourced per-boss clear-time data for GMS Heroic. The only figures I could surface were unattributed forum estimates ('a full daily boss run is 6-8 minutes per account', 'a Lv 200-210 mule earns ~200m/week in 5 minutes a day', 'boss mules can take 30 minutes to earn 1.4 billion meso per week'), none of which name a server, a date, or a character power level. The meso-per-minute ordering in my findings is therefore built on meso-per-crystal-slot, which IS sourced, plus the unambiguous level and difficulty ordering.
- rosters: Whether GMS v.271 (2026-09-09) changed any crystal price, boss entry requirement, or reset rule. The official Nexon patch-notes page is JS-rendered and returned only its title to every fetch attempt; the 7mmo mirror and the Massively OP summary both omit boss sections entirely. Everything I report as 'current' is therefore accurate as of GMS v.269-v.270 plus a NamuWiki price table last edited 2026-08-30, ten days before v.271 shipped.
- rosters: Whether GMS has received the KMS Overdrive changes (20-minute boss timers, boss HP cut to 2/3, crystal prices down 5-10%). I found no GMS patch note announcing any of them. A low-quality gold-selling site (mmoexp.com) asserts the 20-minute limit went live 'with the June 18, 2026 patch' — June 18 2026 is the KMS date, and I would not trust that source. MapleTools still shows 30-minute limits for GMS bosses.
- rosters: Whether Baldrix (Lv 290) and 'First Adversary' are actually live and enterable in GMS Heroic right now. NamuWiki's GMS-specific price table lists GMS crystal values for both, which strongly implies yes, and GMS demonstrably has the later Jupiter, but I could not find a GMS patch note confirming Baldrix's release date in Global. Irrelevant to a Lv 244 character either way.
- rosters: The identity of one boss in NamuWiki's GMS table that machine-translates as 'brilliant chest sound' (Normal 290.4M interactive / 1.452B Heroic, Hard 798M / 3.99B). It sits between Kaling and Limbo in value. I could not map it to a known GMS boss name.
- rosters: The 14-vs-12 weekly-crystal-per-character question for GMS. NamuWiki (2026-08-30) and the kotenarok tool both say 14; Grandis Library (GMS v.269) says 12. I found no official Nexon statement. This matters: it changes a main character's weekly ceiling by roughly 150-250M meso.
- rosters: Exact combat-power thresholds for any boss. All three published charts self-describe their numbers as community estimates, two are undated, one is explicitly Korean-sourced, and they disagree by up to 3.4x in exactly the band this character sits in. I would not ship any of these numbers as a hard gate.
- rosters: Ursus's actual meso payout at Lv 244 in Heroic, and the current Golden Time hours. A forum post claims '~30,000,000 mesos per run at S rank during Golden Time, 90mil a day' but gives no date or server, and another thread gives Golden Time as 9PM-11PM UTC with a note that older sources disagree. Neither is usable.
- rosters: Whether any GMS boss has a hard minimum-party-size entry requirement. I found none documented, and every boss I checked lists a max party size with no stated minimum, but I could not find an explicit source confirming that solo entry is permitted for all of them.
- nonCrystal: Actual mesos per hour for a Lv 244 Bow Master farming Esfera or Moonbridge in GMS Heroic, with or without meso gear. Every per-hour figure I found is either pre-Kishin-removal (2021-2022, assumes a spawn mechanic that no longer exists), or from gg-pass.com which contradicts itself by a factor of ~4 between two of its own 2026 guides. MaplePlanner should present the relative multiplier (which is solid) and NOT a hard mesos/hour number.
- nonCrystal: Which specific Esfera / Moonbridge maps are best for meso farming at Lv 244, and their spawn counts. No current source ranks maps in this level band; all the map-ranking content I found is for Lv 260-290 Grandis zones the player cannot enter.
- nonCrystal: Whether a third 20% Mesos Obtained line (60% on a single accessory) is obtainable, and the per-cube odds of hitting 20/20. No source published the line-probability tables; the cubing calculators that use them do not publish the numbers.
- nonCrystal: Current expected meso cost to cube a full +100% Mesos Obtained accessory set in Heroic. The only figure in circulation (~2B) is from Dec 2021 and predates the cube revamp entirely.
- nonCrystal: Current Ursus meso reward per run at Lv 244 in Heroic. The ~30M/run S-rank figure traces to 2021-2022 sources. I confirmed that the widely-repeated '5x base / 6x Heroic Ursus buff' is a player forum SUGGESTION from Oct 2025, not an implemented change — search engines are summarizing that suggestion as if it were fact, which is an active misinformation trap.
- nonCrystal: Ursus Golden Time windows. Three different UTC windows appear across sources (1-3 AM / 6-8 PM; 1-5 AM / 6-10 PM; 9-11 PM). The tool should tell users to check in-game rather than display a window.
- nonCrystal: Current Maple Tour meso payout at Lv 244 in Heroic. The ~380M/week (2 runs/day) figure is corroborated by two sources but both are 4-5 years old and predate any Heroic multiplier change, so it is probably a floor rather than a current value.
- nonCrystal: Whether the Heroic meso multiplier is 5x or 6x. The MapleStory Wiki (current as of ~June 2026) says 600% with the stat window erroneously showing 500%; older sources say 5x. I could not find an official Nexon statement of either. The 'boss crystal 5x to 6x' line that search engines keep surfacing is from the same player suggestion thread, not a patch note.
- nonCrystal: Whether Inner Ability's %Mesos Obtained genuinely stacks above the +100% equipment cap. mapleguide asserts it does; the MapleStory Wiki only says equipment and familiar potential lines count toward the cap, and is silent on Inner Ability.
- nonCrystal: Whether familiar 'Meso Drop Rate' lines count against the +100% Mesos Obtained cap or are a separate stat. The wiki says familiar potential lines count toward the cap; mapleguide and digitaltq describe familiar meso lines as a distinct 'meso drop rate' stat that changes drop chance rather than value. These two framings cannot both be right, and the difference materially changes whether familiars are worth building for meso.
- nonCrystal: Whether the +400% total Item Drop Rate cap and +200% equipment drop cap still hold in v.271. The only source is dated Aug 2024 and cites v253 — 18 patches ago.
- nonCrystal: The full official v.271 patch notes. The Nexon page is JavaScript-rendered and returns only a page title to WebFetch; browser navigation to nexon.com was denied in this session; maplestorywiki.net, strategywiki.org, maplestory.fandom.com and global.hidden-street.net all return 403/402 to WebFetch. Every v.271 claim above came from search-engine snippets attributed to the official URL and should be re-verified by a human before shipping.
- sinks: Current GMS cube tier-up probabilities for Glowing and Bright Cubes. The only machine-readable table I found was last edited 2022-11-26, which predates the GMS v239 (Feb 2023) cube revamp that the wiki explicitly says changed tier-up probabilities, and predates the 'can increase up to 2 ranks' mechanic now in the official Nexon guide. A 2026 SEO calculator page claims Unique->Legendary is 1-3% for Bright vs the 2022 table's 5%, and I could not find a Nexon probability disclosure page to settle it. Any cube-count number in the app should be labelled as an estimate until someone reads the in-game disclosure.
- sinks: Expected number of cubes to hit specific line goals (e.g. 3-line 30%+ boss damage on a weapon, triple 9%/12% stat on armor). This needs the per-line probability tables; the community dataset (cubeRates.js) was last scraped from the KMS site on 2023-08-28 and is not a GMS Heroic source.
- sinks: Whether the 3,000,000-meso bonus-stat reset can APPLY bonus stats to an item that has none, or only re-roll an item that already has them. The patch notes say 'reset', which implies existing bonus stats, but this is not stated either way. It decides whether flames are needed at all in Heroic now.
- sinks: Whether there is a daily/weekly cap or level restriction on the 3,000,000-meso bonus-stat reset. None is mentioned in the patch notes.
- sinks: Whether Powerful Rebirth Flames are still sold at 9,500,000 mesos in Heroic general stores after v.271. v.271 removed them from boss drops, the Legion Coin Shop, Monster Collection and the Mu Lung Dojo shop, but said nothing about the Heroic general-store listing.
- sinks: The exact wording of the GMS 5/10/15 event. Community wiki and a maintained calculator both model it as 100% success on the 5->6, 10->11 and 15->16 taps, but I could not open a Nexon page saying so, and the alternative reading (guaranteed at 4->5, 9->10, 14->15) would make it substantially more valuable since 14->15 is the expensive tap.
- sinks: Whether the Star Force Transfer step itself costs mesos. The calculator's fodder module states the transfer is free and only costs 1 star, but the MapleStory wiki has no Item/Equip Transfer page and I found no Nexon source confirming or pricing it.
- sinks: An explicit Nexon or wiki statement that Heroic Worlds use the same Star Force meso costs as Interactive Worlds. I am inferring it from the absence of any Heroic modifier in GMS-specific cost sources, not quoting it.
- sinks: Official per-mode numeric tables for Enhancement Mode. Nexon's v.269 notes describe the 4 levels qualitatively but publish no multipliers or rates; the 1/1.5/2.5/3 and 1/2/3.5/6.5 multipliers come from a fan calculator's stated in-game measurements.
- stack: Lemon Squeezy's current fee schedule and whether new sellers can still sign up — lemonsqueezy.com returned HTTP 403 to direct fetch on 2026-09-11, so the 5% + $0.50 figure and the 'no announced sunset date' status come only from secondary summaries.
- stack: Raider.IO Premium's price and gated feature list — raider.io/premium returned HTTP 403.
- stack: Warcraft Logs' exact per-tier subscription prices (Silver/Gold/Platinum) — warcraftlogs.com returned HTTP 403; only 'starting at as little as $2 a month' from a secondary summary.
- stack: WoWAnalyzer Premium's exact price and perk list — both wowanalyzer.com/premium and the Patreon tier listing were unfetchable.
- stack: Mobalytics Plus's exact monthly and annual price from a primary source — mobalytics.gg returned HTTP 403.
- stack: Whether Auth.js has a formal, primary-source statement that it is security-patch-only with no new features — only secondary reporting was retrievable.
- stack: Whether MaplePlanner currently calls the Nexon MapleStory Open API at all. I could not inspect the repository, so the Nexon commercial-use prohibition is stated as conditional. This needs a direct check before any billing work starts.
- stack: Whether Neon purchased through the Vercel Marketplace is billed at the same rates as Neon direct — I found no primary page confirming rate parity.
- stack: Whether a subscription created via a Stripe Payment Link incurs the 0.7% Billing fee. Stripe's docs confirm Payment Links create Subscription objects (i.e. Billing objects) but I found no page stating the fee treatment explicitly.
- stack: GMS-specific applicability of Nexon's Open API terms. The terms page did not enumerate covered games/regions in the section I retrieved; the openapi.nexon.com site lists MapleStory and MapleStorySEA endpoints, but I could not confirm GMS/Heroic coverage from the terms themselves.
- stack: Actual Neon compute consumption for this app's real traffic shape — my ~$20/mo figure at 10k users assumes a 0.25 CU instance running most of the month and is arithmetic, not a measurement or a vendor quote.
