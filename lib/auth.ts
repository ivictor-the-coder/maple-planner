// Identity. The thing that turns "this browser" into "this person on any device".
//
// WHAT THIS FILE IS FOR
// The planner's 25 gear slots and 31-row Legion roster live in one browser's
// localStorage. The MacBook cannot see them. Accounts exist for exactly one
// reason — so the same data opens on both machines — and an account needs an
// identity to hang off. This file is that identity, and nothing else: it does
// not read or write the planner payload. lib/db.ts owns the payload;
// app/api/profile/route.ts is the bridge between the two.
//
// WHY BETTER AUTH
// MIT, runs inside this Next app, no per-user cost, and — the reason it beat
// Supabase Auth and Clerk — the identity rows live in OUR Postgres. "user",
// "session", "account" and "verification" are tables in the same Neon database
// as "profile", created by db/migrations/0001_init.sql. Leaving a vendor later
// is a connection-string change, not a re-mapping of every user id and a forced
// OAuth re-link for the account holder.
//
// EMAIL AND PASSWORD, TODAY
// Discord and Google both need the account holder to go and register an OAuth
// app first (and Google's consent screen caps at 100 users until it is moved to
// production). None of that exists yet, and cross-device sync is wanted now, so
// email + password is the only method enabled. See SECTION 4: adding a provider
// later is an environment-variable pair, not an edit to this file — and it adds
// ROWS to "account" (providerId = 'discord'), never columns.
//
// HOW IT TALKS TO THE DATABASE
// Better Auth's Postgres support is Kysely underneath, and the documented path
// is `database: new Pool(...)` from node-postgres. That is the wrong shape here:
// a Pool holds live connections open, and every serverless invocation on Vercel
// would open its own, which is precisely the connection-slot exhaustion the
// pooled Neon endpoint was chosen to avoid. So SECTION 1 is a ~40 line Kysely
// dialect that compiles to Postgres SQL and executes it through the SAME lazy,
// pooled, never-logged `getSql()` client lib/db.ts already owns. One connection
// story for the whole app, and no second place where a connection string could
// be read, printed or committed.

import { betterAuth, type BetterAuthOptions } from "better-auth";
import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from "kysely";
import { getSql } from "./db";

/* ==========================================================================
   SECTION 1 — THE DIALECT

   Kysely asks for four things: something that compiles SQL (Postgres', taken as
   is), something that knows the engine's capabilities (Postgres', taken as is),
   something that can introspect (Postgres', taken as is), and a driver. Only
   the driver is ours, and all it does is hand the compiled SQL to Neon's HTTP
   query function.

   The HTTP driver is stateless — one fetch per statement, no session, no
   connection to acquire or release — which is why acquire/release/destroy are
   no-ops and why there is exactly one connection object rather than a pool.
   ========================================================================== */

/** The one thing the HTTP driver genuinely cannot do. Better Auth is configured
 *  with `transaction: false` below so this is never reached; it throws rather
 *  than silently running the statements unwrapped, because a half-applied
 *  "create user + create account" is worse than a loud failure. */
function noInteractiveTransactions(): never {
  throw new Error(
    "auth: the Neon HTTP driver has no interactive transactions. " +
      "Better Auth is configured with transaction:false and must not start one; " +
      "if a future plugin needs real transactions, give it its own client."
  );
}

const httpConnection: DatabaseConnection = {
  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    // fullResults gives us `rowCount`, which is what Kysely reports back as
    // numUpdatedRows / numDeletedRows. Without it, "revoke this user's other
    // sessions" would come back as NaN rows affected.
    const res = await getSql().query<false, true>(
      compiled.sql,
      compiled.parameters as unknown[],
      { fullResults: true }
    );
    return {
      rows: res.rows as R[],
      numAffectedRows: BigInt(res.rowCount ?? 0),
    };
  },

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("auth: streaming is not supported over the Neon HTTP driver");
  },
};

const httpDriver: Driver = {
  async init() {
    /* Nothing to open. getSql() is lazy and stays lazy — importing this module
       must never touch the network or throw, or `next build` fails on a machine
       with no .env.local. */
  },
  async acquireConnection() {
    return httpConnection;
  },
  async beginTransaction() {
    noInteractiveTransactions();
  },
  async commitTransaction() {
    noInteractiveTransactions();
  },
  async rollbackTransaction() {
    noInteractiveTransactions();
  },
  async releaseConnection() {
    /* stateless */
  },
  async destroy() {
    /* stateless */
  },
};

const neonHttpDialect: Dialect = {
  createDriver: () => httpDriver,
  createQueryCompiler: () => new PostgresQueryCompiler(),
  createAdapter: () => new PostgresAdapter(),
  createIntrospector: (db) => new PostgresIntrospector(db),
};

/* ==========================================================================
   SECTION 2 — WHERE THIS APP LIVES

   Better Auth needs to know its own origin: it signs and scopes cookies with
   it, and it refuses callbacks and redirects to anywhere else. Getting this
   wrong on Vercel is the classic "sign-in works locally, does nothing in
   production" bug, so it is resolved explicitly rather than left to inference.
   ========================================================================== */

/** Preference order, and why:
 *   1. BETTER_AUTH_URL — what the account holder sets to the real domain. It is
 *      the only one that is stable across deployments, which is what keeps a
 *      session alive when a new build ships.
 *   2. VERCEL_URL — the per-deployment hostname. Right for preview deployments,
 *      wrong as a production default (it changes every deploy), so it is only
 *      the fallback.
 *   3. undefined — local `next dev`, where Better Auth falls back to the
 *      request origin. Fine for one machine; not fine in production, which is
 *      why BETTER_AUTH_URL is listed as a prerequisite. */
function resolveBaseURL(): string | undefined {
  const explicit = process.env.BETTER_AUTH_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return vercel.startsWith("http") ? vercel : `https://${vercel}`;
  return undefined;
}

const baseURL = resolveBaseURL();

/** HTTPS anywhere that is not a developer's laptop. Drives the Secure flag and
 *  the `__Secure-` cookie name prefix: on Vercel the session cookie is
 *  `__Secure-better-auth.session_token`, HttpOnly, SameSite=Lax, Secure. A
 *  browser silently DROPS a `__Secure-` cookie sent over http, which would look
 *  exactly like "sign-in succeeded and then forgot me" — hence deriving this
 *  from the resolved origin instead of guessing from NODE_ENV. */
const useSecureCookies = baseURL ? baseURL.startsWith("https://") : process.env.NODE_ENV === "production";

/* ==========================================================================
   SECTION 3 — SOCIAL PROVIDERS, WHEN THEY EXIST

   Deliberately env-driven rather than a commented-out block. The account holder
   registers a Discord application (or a Google OAuth client), sets two
   variables, redeploys — and the provider is live with no code change and no
   migration. A provider that is not configured is simply absent, so a missing
   variable can never half-enable a broken sign-in button.

   Nothing about the database changes when one is added: linking an account adds
   a ROW to "account" with providerId = 'discord' | 'google' beside the existing
   providerId = 'credential' row. That is the portability Better Auth was picked
   for. To add a third (GitHub, Twitch, Apple — all built in), add one line here
   and the matching pair of variables.

   Callback URL to register with the provider:
     <BETTER_AUTH_URL>/api/auth/callback/discord
     <BETTER_AUTH_URL>/api/auth/callback/google
   ========================================================================== */

type SocialProviders = NonNullable<BetterAuthOptions["socialProviders"]>;

function envPair(idVar: string, secretVar: string): { clientId: string; clientSecret: string } | null {
  const clientId = process.env[idVar]?.trim();
  const clientSecret = process.env[secretVar]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function configuredSocialProviders(): SocialProviders {
  const providers: SocialProviders = {};
  const discord = envPair("DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET");
  if (discord) providers.discord = discord;
  const google = envPair("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  if (google) providers.google = google;
  return providers;
}

/** Which providers this deployment can actually offer. The UI should render
 *  buttons from THIS list rather than hardcoding them, so a provider that was
 *  never configured never shows a button that 500s. */
export const enabledSocialProviders: readonly string[] = Object.keys(configuredSocialProviders());

/* ==========================================================================
   SECTION 4 — THE AUTH INSTANCE
   ========================================================================== */

export const auth = betterAuth({
  appName: "maple-planner",
  baseURL,

  // `{ dialect, type }` rather than a Pool — see the header. `transaction:
  // false` makes the Kysely adapter run its statements sequentially instead of
  // opening a transaction the HTTP driver cannot give it.
  database: {
    dialect: neonHttpDialect,
    type: "postgres",
    transaction: false,
  },

  emailAndPassword: {
    enabled: true,
    // No mail sender is configured. Requiring verification with nothing able to
    // send the mail would lock the account holder out of their own data on the
    // first sign-up, which is the opposite of the point of this wave.
    requireEmailVerification: false,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    // Sign-up hands back a session immediately, so the client can claim the
    // browser's local data in the same breath — see app/api/profile/route.ts.
    autoSignIn: true,
  },

  socialProviders: configuredSocialProviders(),

  session: {
    // 30 days, refreshed whenever a session is used and is more than a day old.
    // Long on purpose: this is a single-player planner opened a few times a
    // week from two machines, and being signed out is pure friction here.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      // Read the session from a short-lived signed cookie instead of hitting
      // Postgres on every request. 5 minutes is short enough that a sign-out on
      // the PC is felt on the MacBook almost immediately.
      enabled: true,
      maxAge: 60 * 5,
    },
  },

  user: {
    // Deleting the user cascades to "session", "account", "profile" and
    // "profile_history" (see 0001_init.sql). That is genuinely unrecoverable,
    // so it stays off until there is a UI that says so in words.
    deleteUser: { enabled: false },
  },

  advanced: {
    // Secure + __Secure- prefix in production, plain over http on localhost.
    // Defaults elsewhere: HttpOnly, SameSite=Lax, Path=/. Lax is correct here —
    // the app and /api/auth are the same origin, and Lax still survives the
    // top-level redirect back from an OAuth provider when one is added.
    useSecureCookies,

    database: {
      // Do NOT set generateId to "serial" or "uuid": the id columns in
      // 0001_init.sql are `text` and the app generates the ids. Changing this
      // means changing the migration.

      // Kysely would otherwise introspect the whole database on every cold
      // start and block auth requests on the result. The schema is fixed by
      // db/migrations/0001_init.sql and checked by `node db/migrate.mjs
      // --verify`; paying a round trip per lambda — and adding a failure mode
      // where a slow introspection breaks sign-in — buys nothing.
      validateSchema: false,
    },
  },

  // Nothing about this app's usage is anyone else's business.
  telemetry: { enabled: false },

  // NOTE ON RATE LIMITING: left at the default, which is in-memory and
  // therefore per-lambda-instance. Real distributed rate limiting would need a
  // "rateLimit" table (rateLimit.storage = "database") and a migration; for a
  // single-account planner it is not worth the write amplification.
});

/* ==========================================================================
   SECTION 5 — WHAT THE REST OF THE APP USES

   Two helpers, so no other file has to know the shape of a Better Auth session.
   ========================================================================== */

export type AuthSession = typeof auth.$Infer.Session;

/** The signed-in user's id, or null. Takes the raw Request because that is what
 *  a route handler has; it reads the session cookie out of its headers.
 *
 *  null means "not signed in". It never means "the database was unreachable" —
 *  that throws, and a caller that cannot tell those apart will eventually treat
 *  an outage as a fresh empty account, which is how data gets lost. */
export async function getUserId(req: Request): Promise<string | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  return session?.user.id ?? null;
}

/** The full session (user + session rows), or null. For anything that needs the
 *  email or name as well as the id. */
export async function getAuthSession(req: Request): Promise<AuthSession | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  return (session as AuthSession | null) ?? null;
}
