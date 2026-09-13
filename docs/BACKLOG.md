# Backlog

Decisions made, and what is still open. Research that backs a number lives in
`data/guide-graph.json`; this file is only what to build and why.

---

## 1. Accounts and profile

**Decided.** Today one character persists to `localStorage` via the `Store`
interface in `lib/storage.ts`, which already declares `kind: "local" | "account"`
and carries a note saying an `ApiStore` should slot in behind it. That was built
for this. Nothing in the UI should have to change.

What an account has to hold, based on what the app already produces:

- the character: stats, 25 equipment slots, potentials, flames, star force
- the Legion roster: 31 characters for this user, merged across three screenshot
  pages — this is the part that is genuinely painful to re-enter
- imported sprites are **not** user data; they are `itemId` references into the
  item database and re-resolve from the name

The motivation is re-entry. A user who has imported thirty tooltips and three
roster pages has put real work in, and today it lives in one browser.

## 2. Billing — $10/month, gating the screenshot importer

**Decided.** One paid plan at **$10/month**. The gated feature is the
**screenshot importer**.

This is cost-coherent, which is worth stating because it constrains the
implementation: the importer is the only feature in the app with a real
per-invocation cost (OpenRouter vision tokens, currently `glm-5.3-flash` then
`deepseek-v4.1-flash`). Everything else — the rules engine, the guide, the
Legion maths — is static computation that costs nothing per user.

Consequences that follow from that, not optional:

- **The entitlement check belongs in `app/api/import/route.ts`, server-side.**
  Hiding the button is not gating. The route spends money on every call, so an
  unauthenticated or unentitled request must be rejected before the fetch to
  OpenRouter, not after.
- **Per-account rate limiting is needed regardless of plan.** Ten screenshots per
  import at three concurrent requests is already the batch ceiling; a paid
  account should still have a ceiling, or one user can run up the bill.
- The free tier keeps manual entry, the item picker, the rules engine, the guide
  and the Legion roster. Those cost nothing to serve.

One risk worth naming once, then moving on: the importer is the app's main
answer to "entering 25 slots by hand is tedious", so gating it gates the
strongest reason to stay. The counter-argument is that it is also the only thing
with marginal cost, and a tool that loses money per free user does not survive
either. The call is made; this note is here so the tradeoff is not rediscovered
later as a surprise.

**Not to be built:** the app never collects card details itself. Payment happens
on the provider's own hosted page.

## 3. Meso potential

**Decided in shape, pending research.** The user's framing:

> meso potential (from weekly bossing to daily bossing to min-max since selling
> crystals are limited)

The interesting part is the constraint. Boss crystal sales are capped per week,
so meso income is not a single number to maximise — it is a staircase:

1. **Weekly bossing** — the crystals worth the most per clear, until the cap
2. **Daily bossing** — added once weeklies alone no longer fill the allowance
3. **Min-max** — everything above the cap has to come from non-crystal income,
   which means meso/drop gear and farming

The planner already knows the inputs this needs: level, combat power, and the
gear in each slot (including the `Mesos Obtained +20%` lines it reads off
potentials). So it can say both *what you are earning* and *what your ceiling
is* — and, in the same voice as the rest of the app, which single boss or which
gear slot is the next step.

Numbers are being researched before any of this is specified, because crystal
prices and the sale cap are exactly the figures that differ between Reboot and
regular servers and go stale between patches.

---

## Prerequisites — owner only

These need the account holder and cannot be done from here.

- [ ] Choose the auth + database provider (recommendation pending research)
- [ ] Create the database and add its connection string to Vercel env
- [ ] Create the OAuth app(s) for whichever sign-in methods are offered
- [ ] Create the payment provider account and the $10/month product
- [ ] Add the payment provider's keys and webhook secret to Vercel env
- [ ] Decide the business entity / tax handling, which drives the choice between
      a direct processor and a merchant-of-record

Keys and card details are entered by the account holder in the provider's own
dashboard, the same way `OPENROUTER_API_KEY` was.

## Open questions

- Does a paid account get more than the importer, or is the importer the whole
  product? Affects whether the roster and multi-character support are free.
- Is there a free trial or a small free quota of screenshots? A hard gate at
  zero means nobody experiences the feature before paying for it.
- Multi-character: the roster proves the account has 31 characters. Does the
  planner store gear for more than one?

---

# Findings that change decisions above

Added 2026-09-11 from `docs/RESEARCH-MESO-ACCOUNTS.md` (37-agent research workflow with
adversarial verification). These contradict or constrain what is written above, so they
sit here rather than being quietly folded in.

## Billing is blocked before it starts — Vercel Hobby forbids it

**Vercel's Hobby plan prohibits commercial use, and defines that to include "any method
of requesting or processing payment from visitors of the site."** Taking $10/month means
upgrading to Vercel Pro at $20 per seat per month **first**. The plan costs $20/month to
operate before it earns $10/month, so it does not break even until the third subscriber.

Vercel **explicitly exempts donations**, so a Ko-fi or Patreon link is free-tier-legal
and needs no plan change. That is the only monetisation path with no fixed cost.

## The niche has effectively no paid-gating precedent

MapleTools is free with Ko-fi. Maple Meta Calculator is free with a $3 Patreon. The
closest analogues in other games — WoWAnalyzer, Warcraft Logs — keep *all analysis* free
and sell ad removal, priority queue and higher API limits instead. $10/month is roughly
three times the observed norm for this audience, and gating the importer is a visible
norm-break rather than an invisible one.

This does not overturn the decision, which stands. It means the decision should be made
knowing it is an outlier, and that annual or one-time pricing beats monthly badly at this
price point: the $0.30 fixed processor fee is 6% of a $5 charge and 0.6% of a $50 annual
charge. A lifetime unlock also avoids Stripe Billing's 0.7% subscription fee entirely.

## Recommended stack: Better Auth + Neon Postgres

- **Auth.js/NextAuth was absorbed by Better Auth, and Vercel acquired Better Auth on
  2026-07-07.** Auth.js now gets security patches rather than features. Better Auth is
  MIT, runs inside the Next app, and costs nothing at any user count.
- **Vercel Postgres no longer exists** — it migrated to Neon through the Vercel
  Marketplace. Neon is usage-based with no monthly minimum, which suits bursty traffic.
- **Not Supabase:** free projects pause after one week of inactivity, which forces the
  $25/month before it is technically needed.
- **Not Clerk:** auth only, so a database is still needed on top; most expensive at
  scale and the hardest to leave, since user identity lives there.

## The meso feature's key constant cannot be sourced

The weekly crystal sale cap — "180 per world" — **could not be verified by any of five
independent passes.** The last GMS-official world-shared figure anyone found is 60, from
2021. KMS and others use 90. The per-character weekly sub-limit is disputed between 12
and 14, with no patch note anywhere raising it. Even "Heroic prices are 5x Interactive"
was refuted.

Consequence, and it is a design requirement rather than a caveat: **the cap ships as a
user-settable value with the dispute visible, never as a hardcoded number.** Both figures
are checkable in about thirty seconds at the Collector NPC, which makes the player a
better source than the internet here.

## Daily bossing is a phase you grow OUT of, not into

This inverts the ordering in the feature request. Daily-boss and weekly-boss crystals
appear to draw from the **same world allowance**. One character running the daily roster
produces roughly 126 crystals a week for perhaps 100-150M total, while about 13
characters filling weekly slots already meets or exceeds the world cap.

So once a roster can fill the cap with weekly crystals, **daily crystals are worth
approximately nothing and selling them destroys value.** A naive "daily boss checklist"
feature would actively lose the player mesos. The allocator must derive this rather than
special-case it. Note this account has 31 characters, so it is very likely already past
that threshold.

Caveat kept deliberately: the claim that daily and monthly crystals consume zero
per-character weekly slots has only weak corroboration, and the whole conclusion rests
on it.

## Nexon's API terms would constrain a paid product — but may not apply

Nexon Open API terms §8.13 prohibits commercial use without written agreement and names
paid premium features specifically; §8.7 caps retention of Nexon game data at 30 days,
which would directly limit what a saved profile may hold.

**This app does not call the Nexon Open API.** `app/api/items/route.ts` calls
`api.maplestory.net`, a third-party service, and the screenshot importer reads the user's
own screenshots. Staying screenshot-only is therefore a licensing feature and not only a
UX one. Still open: `api.maplestory.net` publishes only a Swagger UI with no reachable
terms of use, so its own licensing and rate limits are unverified.

## Settleable by the account holder in-game

- [ ] Weekly crystals sellable per character — 12 or 14? Collector NPC shows the record.
- [ ] The world cap, and whether it is per world or per account.
- [ ] Whether a crystal bought just after Thursday reset survives the next reset. Until
      this is known the planner must never advise banking crystals.

---

# Decisions, 2026-09-11

## Damage model: Bow Master first, not class-general

Decided by the account holder. The engine models one class properly rather than
every class approximately.

What this buys: real weapon multiplier, real mastery, real skill coefficients,
and an answer that can actually be checked against the live character's combat
power instead of being plausible. A class-general model would have had to carry
every class's constants at the same confidence as the one class anyone can
verify, which is how a tool ends up confidently wrong everywhere at once.

What it costs: every other class is unsupported until someone does the same
verification work for it. The shape of the engine should keep that cheap -
class constants behind one named table, never inlined into the formula - but
the work is real and is not being done now.

Bow Master is also the right reference case: Archerroni is Lv 244 at ~5.26M
combat power with a full gear set, so the model has something to be wrong
against.

## Crystal cap: ship 12, offer 14 as an optional override

12 is the only value with a primary source (KMS v1.2.393, July 2024) and is what
Grandis Library says for GMS. 14 is what two current wikis say and traces to GMS
having two bosses KMS does not. No GMS patch note raising 12 to 14 exists.

Effect on this account: ~1.41B/week ceiling at 14 against ~1.29B at 12, and the
roster size needed to fill the 180 world cap moves from 13 characters to 15.
At 31 characters this account is past that line either way, but for a 13 or 14
character account the two values give opposite advice about running dailies.

REVISED by the account holder: **default 12, offer 14 as an optional override.**

This is the more defensible way round. 12 is the only value carrying a primary
source, so the default is the sourced number and the disputed one is the thing a
player opts into - rather than shipping the unsourced figure and asking everyone
to opt out of it. A tool that overstates your ceiling by 120M a week is worse
than one that understates it, because the overstatement is what makes someone
plan around income that never arrives.

The toggle lives in an always-visible assumptions drawer with both source links
and a one-line note on why it is disputed. Every derived figure recomputes from
it immediately. Never hardcoded anywhere.

Also: the widely repeated "~1.88B/week from the top 14 weeklies" does not
reproduce - summing the source's own table gives ~1.41B, a 33% overstatement.
The ceiling is computed from the boss table with a test asserting the displayed
number equals the allocator's own sum.

---

# Scope: the guide covers endgame only

Decided 2026-09-12 by the product owner, and binding on every future wave.

> "as a maplestory gamer I want to be able to make sure I have the right hyper skills
> selected and v matrix and beyond, the skills from job 1-4 is moot, it's the endgame
> content that we're concerned about or mid game. Jobs 1-4 is early game as you can get
> to 200 in less than a day"
>
> "1-200 is strictly doing quests anyways"

## What is in scope

- V matrix: which boost nodes, what order, which trios
- HEXA / 6th job: investment order
- Hyper skills: which passives and actives to select
- Hyper stats: priority order
- Inner ability: the lines worth chasing

## What is out, and why it is out rather than merely deprioritised

Skill builds for jobs 1 to 4, skill damage coefficients, job tiers, rotations.

Levels 1 to 200 are quest-driven. There is no allocation decision to advise on, so a
guide covering it answers a question nobody asks. That is a stronger reason than "low
value" and it means the content should eventually be DELETED rather than carried - it
adds defect surface and implies the tool cares about something it does not.

This also retires a conclusion reached earlier in the day. The absence of machine-
readable GMS skill coefficients was treated as fatal to a skill guide. It is not:
telling someone a hyper skill box is ticked wrong needs no damage coefficient. The
blocker was never the missing data, it was aiming at the wrong content.

## What this does NOT rescue

Narrowing scope does not rescue the mined data. Of 313 recorded defects, 250 land in
the endgame sections and only 2 in jobs 1 to 4. The contested claims ARE the endgame
claims. Four classes came through with endgame content and no defects: Demon Avenger
(30 HEXA steps), Pathfinder, Night Walker, Hoyoung.

## The product shape this implies

Validation, not instruction. The owner's words are "make sure I have the RIGHT hyper
skills selected" - they are checking a build, not learning one. So the app compares a
player's actual build against sourced claims and reports the difference:

  "3 independent sources put this node first; you do not have it"
  "you have levelled this node and no source recommends it"

It never says "you are wrong". That distinction is what makes weakly sourced data
usable: a disagreement is information when it is labelled with its source count, and
poison when it is presented as a verdict. It also means accuracy of the CONFIDENCE
LABEL matters more than completeness of the content.

It reuses the screenshot importer - a V matrix window and a hyper skill window are two
more window types for a pipeline that already exists - which puts it naturally behind
the paid convenience tier where the owner drew that line.

---

# Decision: Neon is the datastore

Chosen 2026-09-12. One provisioning step covers two features that both need
persistence: the demo quota ledger, and accounts later.

## Why it was needed at all

The demo gate cannot be enforced without it. Vercel functions are stateless, so
an in-memory counter resets on every cold start and a browser-side counter is
trivially bypassed - and every bypass spends real OpenRouter vision tokens.
/api/import is the only route in the app with a marginal cost, so an unenforced
gate is not a cosmetic problem, it is a bill.

## Why Neon rather than the alternatives

Carried over from docs/RESEARCH-MESO-ACCOUNTS.md, verified 2026-09-11:
- Usage-based with NO monthly minimum, which suits bursty traffic - the app
  costs nothing while idle, which is most of the time for a niche tool.
- Vercel Postgres no longer exists; it migrated to Neon through the Vercel
  Marketplace, so that comparison branch is gone.
- NOT Supabase: free projects pause after one week of inactivity, which is a
  real operational hazard and effectively forces $25/mo before it is needed.
- NOT Clerk: auth only, so a database is still needed on top; most expensive at
  scale and the hardest to leave.

## Connection shape, which matters on serverless

Use the POOLED connection string, not the direct one. Serverless functions open
a connection per invocation, and a direct Postgres connection limit is reached
quickly under any real traffic. Neon's pooler exists for exactly this.

## Owner-only steps

Nothing below can be done from the code side.

1. Create a Neon project.
2. Copy its POOLED connection string.
3. Add it to Vercel as an environment variable for all environments.
4. Say when it is set; the adapter seam is already being built to drop into.

The connection string is a credential. It gets entered in Vercel's dashboard by
the account holder, the same way OPENROUTER_API_KEY was - it should not be
pasted into a chat, a commit, or a file in this repo.

## What it unblocks

- The demo quota becomes durably enforced rather than advisory.
- /api/interest signups survive a deploy instead of vanishing.
- Accounts, when they land, have somewhere to persist a profile - which is the
  stated motivation for accounts in the first place.

---

# Bug: the gear ladder never fires for gear that is below it

Found by the owner, 2026-09-12, looking at Pensalir Sentinel Gloves (Lv 140) on a
Lv 245 character: "Shouldn't these equips have a suggested next upgrade? What do
i even replace this with?"

## The defect

lib/rules.ts around line 1877:

    let idx = -1;
    lad.forEach((rung, i) => { if (it.lvl >= rung[1]) idx = i; });
    if (idx > -1 && idx < lad.length - 1) { ... }

LADDER.gloves is [["Absolab",160],["Arcane Umbra",200],["Eternal",250]].
A Lv 140 item clears none of those thresholds, so idx stays -1 and the guard
rejects it. Gear BELOW the first rung gets no upgrade advice at all.

The logic is inverted: it only tells you the next tier once you are already on a
tier. The further behind the gear, the less likely the app mentions replacing it.

## Why it is worse than a missing line

On the same panel the app recommended 12 -> 17 stars at 518,000,000 mesos. Star
force does not move between items except by Transfer Hammer, which spans roughly
ten levels upward - 140 to 160 is outside it. So the app priced an investment
that dies with the item, while omitting that the item is four tiers stale. Each
recommendation is locally sensible; together they are backwards.

## The fix

1. idx === -1 means the item is BELOW the first rung. Recommend that rung, at
   high priority, because it is the largest upgrade available for the slot.
2. When an item is below the first rung, star force and potential advice for it
   must be DEMOTED and must say that the investment is lost on replacement.
   Ordering by damage-per-meso cannot see this on its own: it prices the tap
   correctly and has no concept of the item being temporary.
3. Verify the Transfer Hammer level span before the copy asserts it. The ten-level
   figure is from memory and is exactly the kind of number this project keeps
   catching itself on.

## FIXED, 2026-09-13

Point 1 as written. idx === -1 now gets its own branch that names rung zero at
priority 1. Every laddered slot is covered by a test that puts a below-rung item
in it and asserts the slot does not stay silent.

Point 2 came out differently, and the difference matters. The plan said demote
star force and potential advice outright. Reading assignPri() first changed
that: it ranks priced recs by damage per meso, and that ranking is not wrong -
star forcing a Pensalir glove to 15 does buy damage today, and a player who
cannot reach Lotus yet is entitled to it. A blanket demotion would also have
been silently undone, because assignPri() overwrites pri for anything carrying
an eff number.

What shipped instead:
  - Every spend-on-this-item rec is marked `invest` at its call site, and
    `replaced` when the plan has told the player to replace the item.
  - UNPRICED investment recs drop to LATER. "Tier up to Legendary" at NOW
    directly under "replace this item" is the planner contradicting itself.
  - PRICED ones keep their band but are CAPPED below NOW, because NOW is
    competing against the replacement and the ranking cannot see that contest -
    a gear-tier delta has no price in this repo, so the upgrade enters with no
    number and loses to anything carrying one. Without the cap the page showed
    "+0.09% for 3M mesos, reroll the flame" ABOVE "replace this".
  - All of them gain a sentence naming what does not survive the swap.

Point 3 is resolved by NOT asserting it. Nothing in this repo sources the
Transfer Hammer level span or its star cost, so the copy says potential and
flames are lost and stays silent on hammering. The ten-level figure quoted
above is still unverified and should not be repeated until someone reads it in
game.

Found while fixing it: an item with lvl 0 - an import that failed to read the
required level - cleared no rung either, and would have been called outclassed
on the strength of a missing field. That now says the level is unknown instead.

Harness: scratchpad/harness.js, 19 assertions, all passing, including the
degradation contract in __selfTest().

---

# The app speaks a dialect the game does not

**Reported by the owner, 2026-09-13.** They asked "where is the 3m flame reset?"
and had to hunt for it, then found it themselves. The game calls it **Bonus
Stats**, under **Enhance > Bonus Stats**. The app calls it a "flame" in
seventeen strings a player can read, across five files, plus one type union that
teaches every future reader the same wrong word — and it never names the menu.
"Flame" is community jargon; the in-game UI never uses it. A player reading our
advice cannot find the button.

This is not a copy-polish task. It is the same class of defect as the retracted
secondary ladder: the app states something confidently that a player cannot act
on. There the failure was a fact that did not exist; here it is a name that does
not exist. Both end with somebody in the game looking for the thing we told them
about and not finding it.

## The rule to apply

**Lead with the word on the game's own UI. Keep the community word in
parentheses on first use in a view, then drop it.** Not the reverse — a player
who knows "flame" will recognise "Bonus Stats (flames)" instantly, but a player
who only knows the game's UI gets nothing from "flame (bonus stats)" until the
end of the phrase, and nothing at all from "flame" alone.

Where a fix is a one-word swap, do the swap. Where the app could also say *where
the button is*, say it: that is the half the owner actually needed.

## Evidence: the game's own vocabulary, sourced

First-party, read from nexon.com on 2026-09-13 (Item Enhancement guide,
`/maple-guides/all/5897/item-enhancement`). The page is a JS app, so it must be
read in a real browser — WebFetch returns an empty shell and will tell you the
page has no content.

| The game's word | First-party quote |
| --- | --- |
| **Enhance menu**, hotkey **[O]** | "All forms of Enhancement can be done via the Enhance menu (available via the [O] key by default)." |
| **Bonus Stats** (the stat block) | "you can use a Rebirth Flame to reset an item's Bonus Stats" |
| **Rebirth Flame** (the consumable) | section heading "Rebirth Flames" |
| tooltip decomposition | "Base Stats + Bonus Stats + Enhancement Stats" |
| **Star Force tab** | "open the Enhance Menu and click on the Star Force tab" |
| **rarity** / **rank-up** (potential) | "a change to increase the rarity of the Potentials"; "There is a chance of double rank-up if used on Rare items." |
| **Superior-rank equipment** | "You cannot use the Safeguard function to protect Superior-rank equipment." |
| **Transfer** button | "clicking on the blue Transfer button on the bottom of the inventory screen" |

And from the Set Items guide (`/maple-guides/all/1301/set-items`): the game says
**Set Item Effect**, **N-piece Set Bonus**, **Boss Accessory Set**, **Lucky
Items**.

The **Bonus Stat panel's own labels** are already transcribed in this repo, in
`lib/import/bonusStats.ts` under `BONUS_STAT_PANEL_PROMPT`, read off the owner's
screenshots: the window is headed **"BONUS STAT"**, the list inside it is headed
**"Bonus Stats"**, there is a **"Details"** toggle, and the bottom shows a
**"Material Cost"** of **3,000,000 Mesos** with **"Mesos"** and **"Rebirth
Flames"** tabs. That is the exact vocabulary the advice should use, and it is
already in the building.

> The distinction that makes the fix precise: **"Rebirth Flame" is the name of
> the item. "Bonus Stats" is the name of the thing it changes.** So "flame" is
> not merely unofficial — it is the wrong noun. "Reset the Bonus Stats" is
> right; "roll a flame" names the consumable and calls the result by it.

## A. Bonus Stats — every player-facing string

Anchored on the string, not the line number: `lib/rules.ts`,
`components/Planner.tsx` and `lib/import/tooltip.ts` were all being edited while
this was written, so the numbers will have moved.

| File | Current string | Proposed |
| --- | --- | --- |
| `lib/rules.ts` | `"No flame. Roll one."` | `"No Bonus Stats. Roll them."` |
| `lib/rules.ts` | `Bonus stats reset for 3,000,000 mesos since v.271 — at Black Flame rates.` | `Enhance > Bonus Stats, 3,000,000 mesos a reset since v.271 — at Black Rebirth Flame rates.` This is the string the owner needed, and the one place the menu path costs nothing to add. |
| `lib/rules.ts` | `${n} wasted flame line${s} — reset it.` | `${n} wasted Bonus Stat line${s} — reset it.` |
| `lib/rules.ts` | `"Flame is working."` | `"Bonus Stats are working."` |
| `lib/rules.ts` | `"This item cannot take flames."` | `"This item cannot take Bonus Stats."` |
| `lib/rules.ts` | `"This slot cannot take flames."` | `"This slot cannot take Bonus Stats."` |
| `lib/rules.ts` | `" This is boss-drop gear, so it is flame advantaged — tier 4 minimum and up to tier 7."` | `" This is boss-drop gear, so its Bonus Stats roll high — tier 4 minimum and up to tier 7."` — "flame advantaged" is jargon twice over. Keep "tier": the panel prints a digit badge per line, though whether the game calls that digit a tier is unverified. |
| `lib/rules.ts` | `"...this page shows gear, stars, flames and potential advice..."` | `"...gear, stars, Bonus Stats and Potential advice..."` |
| `lib/rules.ts` | `"Gear slots, star force, flames, potential tiers and set effects..."` | `"Gear slots, Star Force, Bonus Stats, Potential and set effects..."` |
| `lib/cubes.ts` | `Reflame (${dead} dead line${s})` | `Reset Bonus Stats (${dead} dead line${s})` — "reflame" is jargon built on jargon. |
| `lib/cubes.ts` | `"Roll a flame"` | `"Roll Bonus Stats"` |
| `lib/cubes.ts` | `UpgradeKind = "cube" / "starforce" / "flame"` | rename the third member to `"bonusStats"`. Internal, but it reaches the UI as a discriminant and every reader learns the wrong word from it. |
| `components/Planner.tsx` | `{key === "p" ? "Potential" : "Flame"}` | `"Bonus Stats"` |
| `components/Planner.tsx` | `{k === "p" ? "Potential lines" : "Flame / bonus stats"}` | `"Bonus Stat lines"` — the current label hedges by printing both names, which teaches neither. |
| `components/Planner.tsx` | `"...a 3M flame roll outranks a 1.5B tier-up..."` | `"...a 3M Bonus Stat reset outranks a 1.5B rank-up..."` |
| `components/Planner.tsx` | `"flames, potential tiers, set effects, Legion"` | `"Bonus Stats, Potential, set effects, Legion"` |
| `components/ImportDialog.tsx` | `{" — flame: "}` | `{" — bonus stats: "}` |
| `app/layout.tsx` | `"...gear, potentials, flames and stats."` | `"...gear, Potential, Bonus Stats and stats."` — this is the meta description, i.e. the search-result snippet. |

Already correct, and the precedent to copy: `components/Planner.tsx`'s
"Can't enhance" checkboxes already read `["noFl", "Bonus stats"]`, and
`lib/import/bonusStats.ts` is written in the game's vocabulary throughout. Two
files in the same app already do this right.

## B. The other mismatches, ranked by how lost a player gets

1. **"Tier up: Rare → Epic."** (`lib/rules.ts`), plus `TIER_LABEL` and "potential
   tiers" everywhere. Nexon's noun is **rarity** and its verb is **rank up**:
   "a chance of double rank-up if used on Rare items". The app's word is "tier",
   which the game does not use for Potential — and worse, the app ALSO uses
   "tier" for gear ladder rungs ("Next tier: Dreamy Belt") and for Bonus Stat
   line grades ("tier 4 minimum"). Three meanings, one word, none of them the
   game's. Propose **"Rank up: Rare → Epic."**, and reserve "tier" for the Bonus
   Stat digit badge alone.

2. **"IED"** (`lib/rules.ts` advice text, `components/Planner.tsx` prose). The
   app already prints **"Ignore DEF"** in `components/ImportDialog.tsx`'s
   stat-window label list and in `lib/cubes.ts`'s line formatter, and **"Ignore
   DEF %"** in the Planner's stat grid — those were written by reading the
   game's stat window. So the app contradicts itself: five places, two words,
   and the acronym is the one no game screen shows. Standardise on **Ignore
   DEF**, with "(IED)" once on the stat grid, where the community word helps a
   player match our advice against a guide.

3. **"CRA"** (`lib/rules.ts` LADDER: `"CRA Root Abyss hat"`, `"CRA top"`,
   `"CRA bottom"`, `"Fafnir / CRA"`). `lib/sets.ts` names the same set **"Chaos
   Root Abyss"**, and Nexon's Boss Content page names the four bosses as **Chaos
   Vellum / Chaos Pierre / Chaos Von Bon / Chaos Crimson Queen**. "CRA" is a
   community acronym, and "CRA Root Abyss hat" is redundant on top of that: the
   R and the A already stand for Root Abyss. Propose **"Chaos Root Abyss hat
   (CRA)"** on first use, "Chaos Root Abyss" after.

4. **"Absolab" vs "AbsoLab".** `lib/rules.ts` spells it one way, `lib/sets.ts`
   the other, and the game spells it AbsoLab. One of the two files is wrong on
   every render. Fix `lib/rules.ts` — but note `SOURCE` is keyed on this exact
   string, so the key and both LADDER spellings must move together or the obtain
   route silently disappears. That failure mode is already live on another rung;
   see `data/sources/nexon/ladder-provenance.json`.

5. **"Chosen Seren"** (`data/guide-graph.json`, node `bosses.cp`). Nexon's own
   boss list says **"Normal/Hard/Extreme Seren"**. "Chosen Seren" is the
   community name. Low harm — the boss is findable either way — but it is the
   same error and it is one word.

6. **"Reboot" in prose.** No action. `lib/farming.ts` already says **"Heroic"**
   in every player-facing string and keeps "Reboot" only in comments and
   citations, which is right: Nexon's own pages use both ("Heroic Worlds" in
   rules text, "Reboot World General Store" inside an obtain route). Recorded so
   the next sweep does not churn it.

## C. The structural one: the app never says where the button is

`grep -rniE "enhance ?>|Enhance menu|inventory" lib/ components/ app/` returns
**one hit, and it is a comment**. In the entire product there is not a single
in-game menu path. Every piece of advice ends at "do this" and never reaches
"here". That is the thing the owner actually hit: they knew what to do and could
not find where to do it.

Four paths are first-party sourced and cover most of what the app recommends:

- Bonus Stats → **Enhance menu ([O]) > Bonus Stats**
- Potential / cubes → **Enhance menu ([O])**
- Star force → **Enhance menu ([O]) > Star Force tab**
- Transfer Hammer → **the blue Transfer button at the bottom of the inventory**,
  not the Enhance menu — worth stating precisely because it is the one that
  lives somewhere else

Cheapest version: put the path in the `w` (detail) string of the rec that
recommends the action, which is where the 3,000,000 meso figure already sits. No
new UI, no new component.

## D. Deliberately not changed, and why

- **"Critical Damage" vs "Crit dmg %"** and **"Boss Monster Damage" vs "Boss dmg
  %"**: the repo disagrees with itself (`lib/sets.ts` comments say "+30% Boss
  Monster Damage"; `lib/rules.ts` fixtures use "Boss Damage +30%") and neither
  wording is sourced. Nexon publishes no stat-window label list. **Settle it
  with one reading of the in-game stat window**, then change both at once.
  Guessing here would only move the inconsistency.
- **"cube" as a verb** ("cube to Epic"). Cube is a real item name and the verb
  is universally understood. Left alone.
- **"dead line"**: the app's own analytic term for a line that does nothing for
  your main stat. It is not competing with a game word, so it is out of scope.
- Whether the in-game Potential UI literally prints "Rank Up" on the animation:
  believed, not verified. The proposal in B1 rests only on Nexon's published
  wording ("rarity", "double rank-up"), which is enough on its own.

## E. Adjacent: the gear ladder provenance audit

A separate pass audited all **66 rungs across all 24 gear ladders**. The full
per-rung table is in **`data/sources/nexon/ladder-provenance.json`**. Headline:
28 of 66 rungs have no `SOURCE` row, **13 slots render the secondary-bug
signature — an empty obtain route — today**, and the whole `LADDER` table is a
hand-copy of one `data/guide-graph.json` node whose own source field reads
*"UNVERIFIED — community gear progression; no citable source states this
slot-by-slot ladder."* The retracted secondary came from that same node's
Secondary row: it was not a uniquely bad rung, it was the rung somebody checked.

One rung is actively contradicted by the repo's own in-game transcription:
**Papulatus Mark is listed on both the face ladder and the eye ladder**, and
unlike the secondary it HAS a `SOURCE` row, so it prints a confident obtain
route and a confident Transfer Hammer instruction for a slot it cannot occupy.
