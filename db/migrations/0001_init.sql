-- 0001_init — identity, and one JSON document per player.
--
-- Two halves, and they have different owners:
--
--   1. "user" / "session" / "account" / "verification" are BETTER AUTH's core
--      schema, transcribed from better-auth 1.7.4's own table definitions
--      (@better-auth/core/db getAuthTables) and from the type map its Kysely
--      migrator uses for postgres:
--         string -> text · boolean -> boolean · date -> timestamptz ·
--         id / foreign key id -> text · required -> not null ·
--         references -> on delete cascade
--      Column names are camelCase and therefore quoted, everywhere, forever.
--      Field-level `index: true` becomes "<table>_<column>_idx", which is the
--      exact name better-auth's own migrator generates, so `npx auth migrate`
--      later sees these as already applied rather than creating duplicates.
--      Assumed defaults: no modelName/fields overrides, no plugins, and the
--      default id strategy (random text, generated in the app — NOT serial and
--      NOT uuid). If the auth wave changes advanced.database.generateId, the id
--      columns here must change with it.
--
--   2. "profile" and "profile_history" are OURS: the planner payload, stored as
--      one JSONB document per user with a schemaVersion column beside it.
--      Deliberately NOT normalised — lib/rules.ts's Character shape is under
--      active change, and a column per field would owe a migration every time
--      one moved. lib/portable.ts already versions and validates this exact
--      document; "schemaVersion" mirrors its Profile.v.
--
-- Everything here is idempotent: re-running this file changes nothing.

-- ---------------------------------------------------------------------------
-- Better Auth core schema
-- ---------------------------------------------------------------------------

create table if not exists "user" (
  "id" text primary key not null,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null default false,
  "image" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);

create table if not exists "session" (
  "id" text primary key not null,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz not null default current_timestamp,
  -- better-auth always writes updatedAt itself; the default is here so a hand
  -- written insert during support or testing cannot fail on a NOT NULL column.
  "updatedAt" timestamptz not null default current_timestamp,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);

create index if not exists "session_userId_idx" on "session" ("userId");

create table if not exists "account" (
  "id" text primary key not null,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  -- Email+password sign-in stores the hash in "password" with
  -- "providerId" = 'credential'. Adding Discord or Google later adds ROWS
  -- here, not columns: same table, providerId = 'discord' / 'google', tokens
  -- in the columns below. That is the portability the auth choice was made for.
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);

create index if not exists "account_userId_idx" on "account" ("userId");

create table if not exists "verification" (
  "id" text primary key not null,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);

create index if not exists "verification_identifier_idx" on "verification" ("identifier");

-- ---------------------------------------------------------------------------
-- "Is there anything in this document worth keeping?"
--
-- The guard in lib/db.ts saveProfile() leans on this: a write whose payload is
-- empty is refused when the stored payload is not. Signing in on the MacBook
-- with an empty localStorage must never be able to erase the PC's gear set.
-- Kept in SQL, not only in TypeScript, so it holds for every writer.
-- Mirrored by isEmptyProfile() in lib/db.ts.
-- ---------------------------------------------------------------------------

create or replace function profile_payload_is_empty(payload jsonb)
returns boolean
language sql
immutable
as $fn$
  select
    (
      coalesce(jsonb_typeof(payload #> '{char,items}'), 'null') <> 'object'
      or payload #> '{char,items}' = '{}'::jsonb
    )
    and
    (
      case
        when jsonb_typeof(payload #> '{char,roster}') = 'array'
          then jsonb_array_length(payload #> '{char,roster}')
        else 0
      end
    ) = 0;
$fn$;

-- ---------------------------------------------------------------------------
-- The planner payload
-- ---------------------------------------------------------------------------

create table if not exists "profile" (
  -- One document per user; the user id IS the key. No surrogate id, because
  -- there is no second profile to disambiguate.
  "userId" text primary key not null references "user" ("id") on delete cascade,
  -- lib/portable.ts SCHEMA_VERSION, mirrored out of "data"->>'v' so a future
  -- migration can find stale documents without parsing all of them.
  "schemaVersion" integer not null,
  -- The lib/portable.ts Profile envelope: { v, app, exported, icons, char }.
  "data" jsonb not null,
  -- Optimistic concurrency. Read it, send it back, and a write from a stale
  -- read is refused instead of winning by arriving last. A PC and a MacBook
  -- both open on the same account is the normal case, not the edge case.
  "rev" integer not null default 1,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint "profile_schemaVersion_positive" check ("schemaVersion" >= 1),
  constraint "profile_rev_positive" check ("rev" >= 1),
  constraint "profile_data_is_object" check (jsonb_typeof("data") = 'object')
);

-- Last resort. Every overwrite parks the document it replaced here, so even a
-- forced merge or a mistaken "yes, overwrite" is recoverable. Bounded to the
-- most recent revisions per user by the trigger below, because these documents
-- carry inline icons and run to a couple of hundred KB each.
create table if not exists "profile_history" (
  "id" bigint generated always as identity primary key,
  "userId" text not null references "user" ("id") on delete cascade,
  "rev" integer not null,
  "schemaVersion" integer not null,
  "data" jsonb not null,
  "replacedAt" timestamptz not null default now(),
  constraint "profile_history_userId_rev_key" unique ("userId", "rev")
);

create index if not exists "profile_history_userId_rev_idx"
  on "profile_history" ("userId", "rev" desc);

create or replace function profile_archive_revision()
returns trigger
language plpgsql
as $fn$
begin
  if old."data" is distinct from new."data" then
    insert into "profile_history" ("userId", "rev", "schemaVersion", "data")
    values (old."userId", old."rev", old."schemaVersion", old."data")
    on conflict ("userId", "rev") do nothing;

    -- Keep the ten most recent revisions for this user, drop the rest.
    delete from "profile_history" h
     where h."userId" = old."userId"
       and h."rev" < coalesce(
         (select "rev" from "profile_history"
           where "userId" = old."userId"
           order by "rev" desc
           offset 9 limit 1),
         0);
  end if;
  return new;
end;
$fn$;

drop trigger if exists "profile_archive" on "profile";

create trigger "profile_archive"
before update on "profile"
for each row
execute function profile_archive_revision();
