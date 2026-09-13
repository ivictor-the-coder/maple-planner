import { NextResponse } from "next/server";
import { importQuota } from "@/lib/entitlementStore";

/**
 * GET /api/import/quota — the counter the dialog shows BEFORE anyone spends
 * anything, and the answer to "is this deployment actually gated?".
 *
 * WHY IT EXISTS AT ALL. A quota a visitor only meets at the moment of refusal
 * is not a budget, it is an ambush: ten screenshots go in, the fourth one is
 * turned away, and nothing on screen ever said there was a limit. This endpoint
 * is what lets the dialog say "3 of 10 used" while someone is still choosing
 * files. It charges nothing and reserves nothing.
 *
 * IT CANNOT DISAGREE WITH THE REFUSAL. importQuota() resolves the same quota
 * profile against the same ledger as guardImport(), so the number in the header
 * and the number in the denial come from one piece of arithmetic. Two counters
 * that drift apart is worse than one counter that is absent.
 *
 * THE SECOND ANSWER: `ledger`. Every response carries the store's own account of
 * itself — backend, durable, survivesColdStart, enforcing, warning. What it reads
 * depends on the backend chooseEntitlementBackend() selected at startup: with
 * DATABASE_URL set it is `neon-postgres` and `enforcing: true`; without one it
 * falls back to the volatile in-memory store and reads `enforcing: false`,
 * because those counts live in a single serverless instance's memory and a cold
 * start hands the visitor a fresh demo.
 *
 * This paragraph asserted the false half of that unconditionally until the Neon
 * store landed, which is the same defect inverted: a comment claiming the gate is
 * open while the code has closed it teaches the next reader to distrust the flag.
 * That fact ships in the JSON rather than living in a lib/ comment, so an
 * honest deployment cannot silently claim to be gated when it is not, and so
 * anyone can check without reading the source. See the OWNER PREREQUISITES at
 * the foot of app/api/interest/route.ts for what makes it true.
 *
 * FAILS CLOSED, IN ITS OWN WAY. A ledger it cannot read produces `quota: null`
 * and a 503, never a number. "10 left" from a ledger nobody could read is worse
 * than no number at all, because a UI will render it and a visitor will believe
 * it.
 *
 * READING THE SHAPE:
 *   quota.used / limit / remaining   the counter
 *   quota.plan                       "anonymous" — there is no sign-in here yet
 *   quota.resetsAt                   JSON null means NEVER, not "unknown". The
 *                                    demo is a lifetime ceiling; it does not
 *                                    refill, which is why the exhausted state
 *                                    leads to a form and not to a clock.
 *   quota.windowLabel                "in your demo" — drops into a sentence
 *   ledger.enforcing                 whether a refusal from here means anything
 *   interestPath                     where an exhausted visitor goes
 */

// Per-visitor and computed from a mutable ledger: it must never be cached, by
// Next's data cache or by anything downstream. A cached quota is one visitor's
// counter shown to a different visitor.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const report = await importQuota(req);
  return NextResponse.json(report, {
    status: report.quota ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
