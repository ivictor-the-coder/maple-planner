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
