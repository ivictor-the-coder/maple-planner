// Every Better Auth endpoint, mounted in one place.
//
// This file has no logic on purpose. `toNextJsHandler` forwards the request to
// the instance configured in lib/auth.ts, which is the only place that decides
// anything. What arrives here is the whole auth surface under /api/auth/*:
//
//   POST /api/auth/sign-up/email     create the account (and sign in)
//   POST /api/auth/sign-in/email     sign in on this device
//   POST /api/auth/sign-out          drop this device's session
//   GET  /api/auth/get-session       who is signed in on this device
//   GET  /api/auth/callback/:provider  Discord/Google, the day either is added
//
// The catch-all segment name must stay `[...all]` — Better Auth builds its own
// URLs from baseURL + "/api/auth", so renaming the folder silently breaks every
// callback and redirect rather than producing a 404 anyone would notice.

import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

// Node, not Edge: the Neon HTTP driver and Better Auth's password hashing both
// belong on the Node runtime, and this is the default — stated so a later
// "let's move it to Edge" is a deliberate change rather than an accident.
export const runtime = "nodejs";

// Sessions live in cookies and in Postgres. Nothing here is ever cacheable, and
// a cached sign-in response would be a security bug, not a performance win.
export const dynamic = "force-dynamic";

export const { GET, POST } = toNextJsHandler(auth);
