"use client";

// The browser half of Better Auth. One instance, shared by every component.
//
// WHY THIS FILE IS FOUR LINES OF SUBSTANCE AND FORTY OF COMMENT
// lib/auth.ts is the server: it owns the database, the cookie flags and the
// password rules. This file owns none of that. It exists so that the UI calls
// a typed method instead of hand-rolling fetch("/api/auth/sign-in/email"),
// which is what the first draft of every auth client looks like and which
// silently rots the moment Better Auth changes a field name.
//
// THE IMPORT PATH, READ NOT GUESSED
// better-auth@1.7.4's package.json declares an "./react" export
// (dist/client/react/index.mjs) whose createAuthClient returns a client with a
// `useSession` hook. `better-auth/client` is the framework-free one and has no
// hook; `better-auth/next-js` is the SERVER handler. Only "./react" is right
// for a "use client" component.
//
// NO baseURL ON PURPOSE
// The client defaults to the page's own origin, which is correct on
// localhost:3010, on a Vercel preview and on the production domain, with no
// NEXT_PUBLIC_ variable to set, drift out of date, or leak. The SERVER still
// needs BETTER_AUTH_URL — see lib/auth.ts — because it signs cookies with it;
// the browser only has to talk to the page it was served from.
//
// "use client" is deliberate: importing this from a Server Component would
// otherwise fail deep inside nanostores with an unreadable message. Here it
// fails at the import, naming this file.

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

/** Subscribes the component to the session. `{ data, isPending, error }`.
 *
 *  isPending is true only while the FIRST /api/auth/get-session is in flight.
 *  A failed call settles with data === null and a non-null error — it does not
 *  hang — which is what lets the planner treat "not signed in" and "could not
 *  ask" as the same, harmless, fully-usable state. */
export const useSession = authClient.useSession;

/** The signed-in user, as the client sees them. */
export type ClientSession = typeof authClient.$Infer.Session;

/** Better Auth hands back `{ data, error }` rather than throwing. `error` is a
 *  BetterFetchError-ish object; every field on it is optional, so this never
 *  assumes one is there.
 *
 *  The fallback matters: an error with no message is what a dropped connection
 *  looks like, and "Something went wrong" with a spinner still turning is the
 *  exact failure the brief calls out. Every caller passes a fallback that says
 *  what to do next. */
export function authErrorText(err: unknown, fallback: string): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; statusText?: unknown; code?: unknown };
    if (typeof e.message === "string" && e.message.trim()) return e.message;
    if (typeof e.statusText === "string" && e.statusText.trim()) return e.statusText;
    if (typeof e.code === "string" && e.code.trim()) return e.code;
  }
  return fallback;
}

/** lib/auth.ts sets `minPasswordLength: 10`. Repeated here so the form can say
 *  so BEFORE a round trip, and deliberately NOT treated as the enforcement —
 *  the server is. If the two ever disagree the server wins and its message is
 *  what the user sees. */
export const MIN_PASSWORD_LENGTH = 10;
