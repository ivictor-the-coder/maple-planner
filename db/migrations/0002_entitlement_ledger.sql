-- 0002_entitlement_ledger — the durable half of the import demo gate.
--
-- WHAT THIS TABLE IS FOR
-- lib/entitlement.ts decides whether an import may proceed; it is pure and
-- remembers nothing. lib/entitlementStore.ts is the memory, and until now the
-- only implementation of that memory was a Map in one Node process
-- (VolatileMemoryEntitlementStore_NOT_A_PRODUCTION_GATE, named after its
-- defect). On Vercel a function is cold-started, recycled and scaled
-- horizontally, and none of those instances share a Map, so a visitor who
-- landed on a different instance started again at zero used and the
-- DEMO_IMPORTS = 10 ceiling never actually held. This table is where the count
-- goes so that it does.
--
-- ONE ROW PER SUBJECT, FIVE WINDOWS PER ROW
-- The shape mirrors LedgerSnapshot in lib/entitlement.ts exactly — minute,
-- hour, day, period, lifetime, each a { startedAt, units } pair — because the
-- arithmetic that moves those numbers lives in TypeScript and is NOT
-- reimplemented here. A ledger whose rollover rules exist twice, once in
-- lib/entitlement.ts and once in SQL CASE expressions, is a ledger whose two
-- halves will eventually disagree about what somebody spent. The database
-- stores and serialises; it does not compute.
--
-- HOW CONCURRENT WRITERS ARE SERIALISED: "rev"
-- components/ImportDialog.tsx fires three lanes at once. A read followed by an
-- unconditional write loses that race by granting more than the ceiling — two
-- requests both read 9, both write 10, and eleven imports happen. So every
-- write is a compare-and-swap on "rev", exactly as "profile" does it in
-- 0001_init.sql: the UPDATE carries `where "rev" = <the rev I read>`, the
-- loser matches zero rows, re-reads, and re-decides. See NeonEntitlementStore
-- in lib/entitlementNeonStore.ts.
--
-- WHY NOT SELECT ... FOR UPDATE: the runtime driver is @neondatabase/serverless
-- over HTTP (see lib/db.ts), which sends one statement per request and cannot
-- hold an interactive transaction open across a round trip. A row lock would
-- mean switching the runtime to a WebSocket pool for this one table. The CAS
-- gets the same guarantee over the driver the rest of the app already uses.
--
-- Everything here is idempotent: re-running this file changes nothing.

create table if not exists "entitlement_ledger" (
  -- subjectKey(subject) from lib/entitlement.ts: "ip:<addr>" or "user:<id>".
  -- It is the key because it is the only thing a visitor cannot choose —
  -- subjectFor() never derives identity from a header the client can set.
  "subjectKey" text primary key not null,

  -- The two halves of the key, stored rather than parsed back out, so an
  -- operational query can say `where "subjectKind" = 'user'` without string
  -- surgery on a value that may itself contain colons (IPv6). The check
  -- constraint at the bottom makes it impossible for these to drift out of
  -- agreement with "subjectKey".
  "subjectKind" text not null,
  "subjectId" text not null,

  -- LedgerSnapshot, flattened. epoch MILLISECONDS as bigint, not timestamptz:
  -- LedgerWindow.startedAt is epoch ms in lib/entitlement.ts and every span
  -- comparison there is in ms, so storing the same integer keeps the round trip
  -- lossless and keeps the comparison in one unit. 0 means "no window open".
  -- (The driver returns bigint as a string; lib/entitlementNeonStore.ts coerces
  -- it and refuses anything that is not a finite number.)
  "minuteStartedAt" bigint not null default 0,
  "minuteUnits" integer not null default 0,
  "hourStartedAt" bigint not null default 0,
  "hourUnits" integer not null default 0,
  "dayStartedAt" bigint not null default 0,
  "dayUnits" integer not null default 0,
  "periodStartedAt" bigint not null default 0,
  "periodUnits" integer not null default 0,

  -- THE DEMO COUNTER. Monotonic for the life of the row; nothing rolls it over
  -- and nothing prunes it. Every other column here can be reconstructed by
  -- waiting; this one is the number a visitor cannot wait out, and it is the
  -- entire reason this table is durable.
  "lifetimeStartedAt" bigint not null default 0,
  "lifetimeUnits" integer not null default 0,

  -- Concurrency slots reserved by imports that have started and not yet
  -- settled. In the Map implementation a crashed process forgot these for free.
  -- Here they would survive forever, and a subject with three leaked slots
  -- could never import again — so the reservation is a LEASE: it is ignored
  -- once "inFlightExpiresAt" is in the past. See RESERVATION_LEASE_MS in
  -- lib/entitlementNeonStore.ts for where the duration comes from.
  "inFlight" integer not null default 0,
  "inFlightExpiresAt" bigint not null default 0,

  -- The compare-and-swap token. Same role, same name and same convention as
  -- "profile"."rev": read it, send it back, and a write from a stale read is
  -- refused instead of winning by arriving last.
  "rev" integer not null default 1,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),

  constraint "entitlement_ledger_subjectKind_known"
    check ("subjectKind" in ('ip', 'user')),
  -- Mirrors subjectKey() in lib/entitlement.ts. If that format ever changes,
  -- this constraint is the thing that will notice.
  constraint "entitlement_ledger_subjectKey_agrees"
    check ("subjectKey" = "subjectKind" || ':' || "subjectId"),
  -- A negative count is a refund that ran twice or arithmetic that went
  -- backwards. Either way it hands out demo the visitor already spent, so it is
  -- refused at the table rather than discovered in a bill.
  constraint "entitlement_ledger_units_nonnegative"
    check ("minuteUnits" >= 0 and "hourUnits" >= 0 and "dayUnits" >= 0
           and "periodUnits" >= 0 and "lifetimeUnits" >= 0),
  constraint "entitlement_ledger_startedAt_nonnegative"
    check ("minuteStartedAt" >= 0 and "hourStartedAt" >= 0 and "dayStartedAt" >= 0
           and "periodStartedAt" >= 0 and "lifetimeStartedAt" >= 0),
  constraint "entitlement_ledger_inFlight_nonnegative"
    check ("inFlight" >= 0 and "inFlightExpiresAt" >= 0),
  constraint "entitlement_ledger_rev_positive" check ("rev" >= 1)
);

-- NO INDEX BEYOND THE PRIMARY KEY, ON PURPOSE. Every read and every write in
-- lib/entitlementNeonStore.ts is `where "subjectKey" = $1`, which the primary
-- key already serves. An index on "updatedAt" would only be there to support a
-- cleanup job, and see below for why there is no cleanup job.

-- NO FOREIGN KEY TO "user", ON PURPOSE. The obvious `references "user"("id")
-- on delete cascade` would make deleting an account delete its demo count,
-- which turns "delete account" into a button labelled "new demo". Subjects here
-- are mostly IPs anyway, which have no row to reference. The cost of the choice
-- is that a deleted user leaves a row behind; that row is a few dozen bytes and
-- is the point.

-- NO RETENTION POLICY, ON PURPOSE. Deleting rows that have not been touched
-- lately is exactly how a lifetime ceiling quietly becomes a rate limit: a
-- visitor who waits out the sweep gets another ten imports and nobody finds out
-- until the OpenRouter bill. If these rows ever need bounding, bound them by
-- something that is not time.

comment on table "entitlement_ledger" is
  'Durable import-demo ledger: one row per subject, five quota windows plus a leased in-flight count, compare-and-swap on "rev". Arithmetic lives in lib/entitlement.ts, not here. Do not add a time-based retention policy: "lifetimeUnits" is a lifetime ceiling.';
