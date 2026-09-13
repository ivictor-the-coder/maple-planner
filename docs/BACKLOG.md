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
