"use client";

// The account strip: sign in, sign out, and the state of the sync.
//
// =============================================================================
// WHAT THIS IS FOR
// =============================================================================
// The owner's words for why accounts exist at all: "so i can persist between pc
// and macbook". So this component is judged on one thing - whether the sheet
// typed on the PC opens on the MacBook - and everything else here is in service
// of that, or is an honest admission that something did not work.
//
// =============================================================================
// THE THREE RULES IT IS BUILT AROUND
// =============================================================================
//  1. SIGNED OUT IS NOT A DEGRADED MODE. The planner is a useful tool with no
//     account and always has been. Nothing here gates it, nothing here blocks
//     on a request, and a failed /api/auth/get-session settles as "signed out"
//     rather than as a spinner. The only thing a signed-out visitor sees is one
//     extra button on a strip that already had four.
//
//  2. NO FAILURE BECOMES A SPINNER. Every request has an outcome that is
//     rendered - saved, conflicted, refused, offline, or invalid - and the
//     status line in the strip says which, in words, with the next action
//     attached.
//
//  3. NOTHING OVERWRITES A SHEET WITHOUT PROOF OR A HUMAN. The proof lives in
//     lib/profileSync.ts; this file is what asks the human when the proof does
//     not exist. See components/AccountConflict.tsx.
//
// =============================================================================
// WHAT SYNCS, EXACTLY - the honest scope
// =============================================================================
// ONE character sheet - the one being edited - plus the account-wide Legion
// roster. Not all of them.
//
// That is not a shortcut, it is the shape of the thing on the other end:
// /api/profile stores lib/portable.ts's Profile envelope, whose `char` field is
// a single Character. There is nowhere in that document to put a second
// character. Syncing the whole local Account would mean changing the stored
// schema, its validator and its migration ladder - none of which this wave
// owns.
//
// The consequence is stated in the UI rather than left to be discovered: other
// characters on the account stay on the machine that made them. They are never
// touched, never uploaded and never deleted; they are simply local.
//
// =============================================================================
// WHY SO MANY REFS
// =============================================================================
// useSession() returns a fresh object every render, and Planner re-renders on
// hover. Anything captured in a useCallback dependency array from either would
// change identity constantly, and the arrival handshake below is keyed on
// identity - a handshake that re-fires on every render is a GET per keystroke
// and, worse, a conflict question that reopens itself. The refs are what keep
// check() genuinely stable while still reading current values.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { MIN_PASSWORD_LENGTH, authClient, authErrorText, useSession } from "@/lib/authClient";
import {
  adoptRemote,
  characterSignature,
  planFor,
  pushLocal,
  readMarker,
  readRemote,
  rescuedFields,
  summarize,
  writeMarker,
  type SyncMarker,
} from "@/lib/profileSync";
import AccountConflict from "@/components/AccountConflict";
import type { FieldError, Profile } from "@/lib/portable";
import type { Character } from "@/lib/rules";

/** How long an edit rests before it is sent. Long enough that typing a level
 *  into a number box is one save rather than three, short enough that closing
 *  the laptop a couple of seconds after an edit still catches it. Every save is
 *  a compare-and-swap, so a lost race costs a retry, never data. */
const PUSH_DEBOUNCE_MS = 1500;

type SyncState =
  /** Signed out, or signed in with nothing on either side yet. */
  | { t: "idle"; note: string }
  | { t: "checking" }
  | { t: "saving" }
  /** Agreed with the account at `rev`. `rev` is null when the agreement is
   *  "we both have nothing". */
  | { t: "synced"; rev: number | null }
  /** A request did not complete. LOCAL DATA IS UNTOUCHED and still saves to
   *  this browser exactly as it does signed out. */
  | { t: "offline"; detail: string }
  /** Something was refused or did not validate. Nothing was written. */
  | { t: "problem"; detail: string; errors: FieldError[] }
  /** Two populated sheets, no proof of which is newer. A human decides. */
  | { t: "ask"; rev: number; updatedAt: string; server: Profile }
  /** This device's sheet is empty and the account's is not. Refused, and asked. */
  | { t: "empty-guard"; rev: number; server: Profile }
  /** The sheet here is still the demo and the account is empty. One click seeds
   *  it; nothing happens without that click. */
  | { t: "offer-seed"; baseRev: number | null; why: string };

export interface AccountBarProps {
  /**
   * The sheet this browser has actually PERSISTED, or null if it has never
   * saved one.
   *
   * null is load-bearing and is not the same as an empty sheet. A first-time
   * visitor is looking at the demo character, which has seventeen pieces of
   * gear on it and is NOT their data; pushing that to a fresh account would put
   * a stranger's demo in the one place the owner's roster is supposed to live.
   * Planner.tsx passes null until the local store has been written at least
   * once.
   */
  localSheet: Character | null;
  /**
   * Is that sheet still the DEMO character? See PlanInput.localIsDemo in
   * lib/profileSync.ts — the short version is that Planner's item backfill
   * saves the demo to localStorage on first load, so "this browser has saved
   * something" is not the same as "this player has a sheet", and seeding a
   * fresh account with a sample character is exactly the mistake this wave is
   * meant to prevent.
   */
  /**
   * @deprecated IGNORED. lib/profileSync.ts planFor() proves the demo from
   * content now - see DEMO_SIGNATURE there. Optional so the prop can be dropped
   * from the call site; the field stays only until the last reference is gone.
   */
  localIsDemo?: boolean;
  /**
   * Put the account's sheet on this device. The caller decides where it lands
   * (the active slot, on top of the demo, or into a fresh account); this
   * component only decides WHEN, and never calls it without either proof or a
   * click.
   */
  onAdopt: (ch: Character) => void;
}

export default function AccountBar({ localSheet, onAdopt }: AccountBarProps) {
  const session = useSession();
  const userId = session.data?.user?.id ?? null;
  const email = session.data?.user?.email ?? "";

  const [rawState, setState] = useState<SyncState>({ t: "idle", note: "" });
  const [rawMarker, setMarker] = useState<SyncMarker | null>(null);
  const [rawBanner, setBanner] = useState("");
  const [open, setOpen] = useState(false);
  /** The account revision whose conflict question the owner pushed aside. Kept
   *  as the rev rather than as a boolean so that a LATER conflict — a different
   *  revision, a different question — opens the dialog again instead of
   *  inheriting a dismissal from the last one. Derived state beats an effect
   *  that resets a flag. */
  const [askDismissedRev, setAskDismissedRev] = useState<number | null>(null);

  /* Signing out does not need a pile of setState calls in an effect; it needs
   * the signed-out render to ignore what the signed-in render was holding. The
   * marker is additionally checked against the CURRENT user, so a second
   * account signing in on the same browser can never be measured against the
   * first one's ancestor. */
  const state = useMemo<SyncState>(() => (userId ? rawState : { t: "idle", note: "" }), [userId, rawState]);
  const marker = useMemo(
    () => (userId && rawMarker?.userId === userId ? rawMarker : null),
    [userId, rawMarker]
  );
  const banner = userId ? rawBanner : "";

  /* Current values, readable from async handlers without becoming dependencies.
   *
   * Synced in an effect with no dependency array, which runs after EVERY
   * render, and declared before every other effect in this component so that
   * the handshake below always reads values from the render it was scheduled
   * by. (Writing a ref during render is what this looks like in most
   * codebases; React's own lint rule forbids it, and an effect is both legal
   * and — because effects run in declaration order — just as current here.) */
  const localRef = useRef<Character | null>(localSheet);
  const userRef = useRef<string | null>(userId);
  const adoptRef = useRef(onAdopt);
  const refetchRef = useRef(session.refetch);
  useEffect(() => {
    localRef.current = localSheet;
    userRef.current = userId;
    adoptRef.current = onAdopt;
    refetchRef.current = session.refetch;
  });

  const localSig = useMemo(() => (localSheet ? characterSignature(localSheet) : ""), [localSheet]);

  /** True when this device holds edits the account has not got. Derived, never
   *  stored: a stored flag and a real sheet drift apart, and the flag is the
   *  one that gets believed. */
  const dirty = !!localSheet && !!marker && localSig !== marker.local && localSig !== marker.server;

  const remember = useCallback((rev: number | null, mine: string, theirs: string) => {
    const uid = userRef.current;
    if (!uid) return;
    const m: SyncMarker = { userId: uid, rev, local: mine, server: theirs, at: new Date().toISOString() };
    setMarker(m);
    writeMarker(m);
  }, []);

  /* ---------- sending ---------- */

  const push = useCallback(
    async (ch: Character, baseRev: number | null, allowEmpty = false) => {
      setState({ t: "saving" });
      const res = await pushLocal(ch, { baseRev, allowEmpty });
      if (!userRef.current) return; // signed out while the request was in flight

      switch (res.kind) {
        case "saved":
          remember(res.rev, characterSignature(ch), characterSignature(res.stored.char));
          setState({ t: "synced", rev: res.rev });
          setBanner("");
          return;
        case "conflict":
          // Another device wrote between our read and our write. Nothing was
          // saved. This is the case the owner's two machines will actually hit.
          setState({ t: "ask", rev: res.rev, updatedAt: res.updatedAt, server: res.server });
          return;
        case "refused-empty":
          setState({ t: "empty-guard", rev: res.rev, server: res.server });
          return;
        case "invalid":
          setState({
            t: "problem",
            detail:
              "This device's sheet did not pass the account's validator, so nothing was saved. " +
              "Your sheet is untouched here.",
            errors: res.errors,
          });
          return;
        case "refused":
          // Permanent and self-explaining. No Retry button: retrying refuses
          // again, and the sheet is still safe on this device.
          setState({
            t: "problem",
            detail: res.detail + " Your sheet is untouched here and still saving to this browser.",
            errors: [],
          });
          return;
        case "signed-out":
          setState({ t: "idle", note: "Signed out." });
          void refetchRef.current();
          return;
        case "unavailable":
          setState({ t: "offline", detail: res.detail });
          return;
      }
    },
    [remember]
  );

  /* ---------- taking the account's sheet ---------- */

  const pull = useCallback(
    (rev: number, profile: Profile, why: string) => {
      const mine = localRef.current;
      const incoming = profile.char;
      const merged = adoptRemote(mine, incoming);
      const rescued = rescuedFields(mine, incoming);
      adoptRef.current(merged);
      remember(rev, characterSignature(merged), characterSignature(incoming));
      setState({ t: "synced", rev });
      const s = summarize(incoming);
      setBanner(
        why +
          " Opened " +
          (s.name || "the account's sheet") +
          " — " +
          s.items +
          " item" +
          (s.items === 1 ? "" : "s") +
          ", " +
          s.roster +
          " roster row" +
          (s.roster === 1 ? "" : "s") +
          "." +
          (rescued.length
            ? " Kept from this device, because the account cannot carry them yet: " + rescued.join(", ") + "."
            : "")
      );
    },
    [remember]
  );

  /* ---------- the arrival handshake, and the manual retry ---------- */

  const check = useCallback(async () => {
    if (!userRef.current) return;
    setState({ t: "checking" });
    const remote = await readRemote();
    const uid = userRef.current;
    if (!uid) return;

    if (remote.kind === "signed-out") {
      setState({ t: "idle", note: "Signed out." });
      void refetchRef.current();
      return;
    }
    if (remote.kind === "unavailable") {
      // NOT "the account is empty". The distinction is the whole reason
      // /api/profile answers 503 rather than 200-with-nothing.
      setState({ t: "offline", detail: remote.detail });
      return;
    }
    if (remote.kind === "unreadable") {
      setState({
        t: "problem",
        detail: "Your account holds a sheet this build cannot read. Nothing was changed on this device.",
        errors: remote.errors,
      });
      return;
    }

    const mine = localRef.current;
    const plan = planFor({ local: mine, remote, marker: readMarker(uid) });
    if (!plan) {
      setState({ t: "offline", detail: "No safe action for the account's answer. Nothing was changed." });
      return;
    }

    switch (plan.kind) {
      case "idle":
        remember(null, "", "");
        setState({ t: "idle", note: plan.note });
        setBanner("");
        return;
      case "in-sync":
        remember(
          plan.rev,
          mine ? characterSignature(mine) : "",
          remote.kind === "profile" ? characterSignature(remote.profile.char) : ""
        );
        setState({ t: "synced", rev: plan.rev });
        setBanner("");
        return;
      case "push":
        if (!mine) {
          setState({ t: "offline", detail: "Nothing on this device to send." });
          return;
        }
        setBanner(plan.why);
        await push(mine, plan.baseRev);
        return;
      case "pull":
        pull(plan.rev, plan.profile, plan.why);
        return;
      case "ask":
        setState({ t: "ask", rev: plan.rev, updatedAt: plan.updatedAt, server: plan.server });
        return;
      case "offer-seed":
        setState({ t: "offer-seed", baseRev: plan.baseRev, why: plan.why });
        setBanner("");
        return;
    }
  }, [push, pull, remember]);

  /* Once per signed-in identity. Deliberately NOT keyed on the sheet: this is
   * the arrival handshake, and re-running it on every keystroke would turn a
   * conflict question into a loop. Ongoing edits go through the debounce below. */
  useEffect(() => {
    if (!userId) return;
    // Off the render pass, deliberately. The handshake is a conversation with a
    // server, not a synchronisation of render state, and starting it inside the
    // effect body would put its first setState in the same tick as the commit
    // that scheduled it. The cleanup cancels it if the identity changes first -
    // a sign-out landing between the two would otherwise run a handshake for an
    // account nobody is signed in to any more.
    const id = setTimeout(() => void check(), 0);
    return () => clearTimeout(id);
  }, [userId, check]);

  /* The demo hold releases itself the moment the sheet stops being the demo.
   *
   * Without this, the popover's "edit the sheet and it will sync on its own"
   * would be a claim the code does not honour: the handshake runs once per
   * identity, the ongoing-save effect below only fires from `synced`, and
   * `offer-seed` is neither — so a player who took the hint and imported their
   * own gear would sit unsynced until they reloaded. Re-planning is the whole
   * fix, and re-planning is free: it is one GET that writes nothing. */
  // Re-plan whenever the sheet CHANGES while an offer-seed is on screen. This
  // used to hinge on a localIsDemo prop; that prop was the source of the
  // data-loss defect and is gone. The sheet's own signature is the honest
  // trigger - it moves exactly when the player edits something, which is the
  // event this effect cares about, and planFor() decides what that means.
  useEffect(() => {
    if (state.t !== "offer-seed") return;
    const id = setTimeout(() => void check(), 0);
    return () => clearTimeout(id);
  }, [state.t, localSig, check]);

  /* Ongoing saves. Only ever from a settled `synced` state, so a pending
   * question or a failure stops the flow instead of hammering the server. */
  useEffect(() => {
    if (!userId || !localSheet || !marker) return;
    if (state.t !== "synced") return;
    if (localSig === marker.local || localSig === marker.server) return;
    const sheet = localSheet;
    const baseRev = marker.rev;
    const t = setTimeout(() => {
      void push(sheet, baseRev);
    }, PUSH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [userId, localSheet, localSig, marker, state, push]);

  /* ---------- auth actions ---------- */

  const [mode, setMode] = useState<"in" | "up">("in");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (authBusy) return;
      setAuthError("");
      setAuthBusy(true);
      try {
        const res =
          mode === "in"
            ? await authClient.signIn.email({ email: form.email, password: form.password })
            : await authClient.signUp.email({ email: form.email, password: form.password, name: form.name });
        if (res.error) {
          setAuthError(
            authErrorText(
              res.error,
              mode === "in"
                ? "Could not sign in. Check the address and password, or create an account."
                : "Could not create the account. Try a different address, or sign in instead."
            )
          );
          return;
        }
        // Never keep the password in component state a moment longer than the
        // request needs it.
        setForm({ name: "", email: "", password: "" });
        setOpen(false);
        // autoSignIn is on (lib/auth.ts), so both paths land signed in; the
        // session store updates and the handshake effect above runs.
        await refetchRef.current();
      } catch (err) {
        // A thrown error here is a network fault, not a rejected credential.
        setAuthError(authErrorText(err, "Could not reach the server. Nothing was changed."));
      } finally {
        // Always. This is the "spinner that never resolves" the brief names.
        setAuthBusy(false);
      }
    },
    [authBusy, form, mode]
  );

  const doSignOut = useCallback(async () => {
    setAuthBusy(true);
    try {
      await authClient.signOut();
    } catch {
      /* Clearing this device's view of the session is what matters below. */
    } finally {
      setAuthBusy(false);
      setOpen(false);
      setState({ t: "idle", note: "" });
      setMarker(null);
      setBanner("");
      // The marker on disk is KEPT on purpose: it is this browser's record of
      // what it last agreed with, and throwing it away would turn the next
      // sign-in on this same machine into a needless choose-one question.
      // Planner data is untouched - signing out is not a wipe.
      await refetchRef.current();
    }
  }, []);

  /* ---------- what the strip says ---------- */

  const status = useMemo((): { text: string; tone: "ok" | "warn" | "bad" | "mute" } => {
    if (!userId) return { text: "", tone: "mute" };
    switch (state.t) {
      case "checking":
        return { text: "Checking account…", tone: "mute" };
      case "saving":
        return { text: "Saving…", tone: "mute" };
      case "synced":
        return dirty ? { text: "Unsaved edits", tone: "mute" } : { text: "Synced", tone: "ok" };
      case "offline":
        return { text: "Not saved to account", tone: "warn" };
      case "problem":
        return { text: "Sync problem", tone: "bad" };
      case "ask":
        return { text: "Two sheets differ", tone: "bad" };
      case "empty-guard":
        return { text: "Refused: empty sheet", tone: "bad" };
      case "offer-seed":
        return { text: "Demo sheet — not synced", tone: "warn" };
      case "idle":
        return { text: state.note ? "Nothing to sync yet" : "", tone: "mute" };
    }
  }, [dirty, state, userId]);

  const toneColor =
    status.tone === "ok"
      ? "var(--good)"
      : status.tone === "warn"
        ? "var(--warn)"
        : status.tone === "bad"
          ? "var(--bad)"
          : "var(--ink-3)";

  const boxStyle: CSSProperties = {
    position: "absolute",
    top: "calc(100% + 6px)",
    right: 0,
    zIndex: 50,
    width: 320,
    maxWidth: "80vw",
    background: "linear-gradient(180deg, var(--panel) 0%, #111828 100%)",
    border: "1px solid var(--edge)",
    borderRadius: 5,
    boxShadow: "0 20px 50px -18px rgba(0,0,0,.95)",
    padding: "12px 13px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };

  const detailLine =
    state.t === "offline" || state.t === "problem" ? state.detail : "How this device stands with your account";

  return (
    <div style={{ position: "relative", flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8 }}>
      {status.text && (
        <span className="mono" style={{ fontSize: ".62rem", color: toneColor, whiteSpace: "nowrap" }} title={detailLine}>
          {status.text}
        </span>
      )}

      {/* Always reachable from the strip itself, so a failure is never hidden
          behind a popover the owner has to think to open. */}
      {userId && state.t === "offline" && (
        <button className="btn" style={{ padding: "3px 8px", fontSize: ".7rem" }} onClick={() => void check()}>
          Retry
        </button>
      )}
      {userId && state.t === "offer-seed" && (
        <button
          className="btn"
          style={{ padding: "3px 8px", fontSize: ".7rem" }}
          onClick={() => setOpen(true)}
        >
          Put it on my account
        </button>
      )}
      {userId && (state.t === "ask" || state.t === "empty-guard") && (
        <button
          className="btn"
          style={{ padding: "3px 8px", fontSize: ".7rem", borderColor: "var(--bad)" }}
          onClick={() => {
            setAskDismissedRev(null);
            if (state.t === "empty-guard") setOpen(true);
          }}
        >
          Choose
        </button>
      )}

      <button
        className="btn"
        style={{ padding: "3px 9px", fontSize: ".72rem" }}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {session.isPending ? "Account" : userId ? email || "Account" : "Sign in"}
      </button>

      {open && (
        <div style={boxStyle}>
          {userId ? (
            <>
              <div className="sub-h">Signed in</div>
              <div style={{ fontSize: ".84rem", color: "var(--gold-2)", wordBreak: "break-all" }}>{email}</div>

              <div style={{ fontSize: ".74rem", color: "var(--ink-2)" }}>
                {state.t === "synced" && !dirty && "This device and your account hold the same sheet."}
                {state.t === "synced" && dirty && "Edits on this device are queued to save."}
                {state.t === "checking" && "Reading your account…"}
                {state.t === "saving" && "Saving to your account…"}
                {state.t === "idle" && (state.note || "Not syncing anything yet.")}
                {state.t === "offline" && state.detail}
                {state.t === "problem" && state.detail}
                {state.t === "ask" && "Your account and this device each hold a sheet, and they differ."}
                {state.t === "empty-guard" &&
                  "This device's sheet is empty and your account's is not, so nothing was sent."}
                {state.t === "offer-seed" && state.why}
              </div>

              {/* The same sentence the floating banner carries. It lives in both
                  places because the banner is suppressed while this panel is
                  open, and the one action that most needs explaining - a pull,
                  and what it had to keep from this device - is usually started
                  from the "Sync now" button six lines below. Explaining it only
                  in the element that is hidden at that moment is the same as
                  not explaining it. */}
              {banner && (
                <p
                  style={{
                    margin: 0,
                    fontSize: ".72rem",
                    color: "var(--ink-2)",
                    borderLeft: "2px solid var(--gold-deep)",
                    paddingLeft: 8,
                  }}
                  role="status"
                >
                  {banner}
                </p>
              )}

              {state.t === "offer-seed" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <button
                    className="btn p"
                    style={{ fontSize: ".72rem" }}
                    onClick={() => {
                      const mine = localRef.current;
                      if (mine) void push(mine, state.baseRev);
                    }}
                  >
                    Put this sheet on my account
                  </button>
                  <p className="fineprint" style={{ margin: 0 }}>
                    Or edit the sheet first &mdash; import your own screenshots, or start a new
                    character &mdash; and it will sync on its own from then on.
                  </p>
                </div>
              )}

              {state.t === "problem" && state.errors.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: ".7rem", color: "var(--ink-2)" }}>
                  {state.errors.slice(0, 6).map((e, i) => (
                    <li key={e.path + i}>
                      <span className="mono">{e.path || "(document)"}</span> &mdash; {e.want}. {e.fix}.
                    </li>
                  ))}
                </ul>
              )}

              {state.t === "empty-guard" && (
                <EmptyGuard
                  serverChar={state.server.char}
                  onPull={() => pull(state.rev, state.server, "Took the account's sheet.")}
                  onEraseAccount={() => {
                    const mine = localRef.current;
                    if (!mine) return;
                    void push(mine, state.rev, true);
                  }}
                />
              )}

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  className="btn"
                  style={{ fontSize: ".72rem" }}
                  disabled={state.t === "checking" || state.t === "saving"}
                  onClick={() => void check()}
                >
                  Sync now
                </button>
                <button
                  className="btn"
                  style={{ fontSize: ".72rem" }}
                  disabled={authBusy}
                  onClick={() => void doSignOut()}
                >
                  {authBusy ? "Signing out…" : "Sign out"}
                </button>
              </div>

              <p className="fineprint" style={{ margin: 0 }}>
                Your account carries the character you are editing plus the Legion roster. Other
                characters on this browser stay on this browser. Symbol levels and the three
                stat-window readings stay here too &mdash; the account format does not carry them
                yet. Signing out changes nothing that is saved on this device.
              </p>
            </>
          ) : (
            <>
              <div className="sub-h">{mode === "in" ? "Sign in" : "Create account"}</div>
              <p style={{ margin: 0, fontSize: ".74rem", color: "var(--ink-2)" }}>
                An account keeps one character sheet and your Legion roster on the server, so the
                same sheet opens on another machine. The planner works without one.
              </p>
              <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {mode === "up" && (
                  <div className="fld">
                    <label htmlFor="acct-name">Name</label>
                    <input
                      id="acct-name"
                      autoComplete="name"
                      required
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </div>
                )}
                <div className="fld">
                  <label htmlFor="acct-email">Email</label>
                  <input
                    id="acct-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </div>
                <div className="fld">
                  <label htmlFor="acct-pw">Password</label>
                  <input
                    id="acct-pw"
                    type="password"
                    autoComplete={mode === "in" ? "current-password" : "new-password"}
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </div>
                {mode === "up" && (
                  <p className="fineprint" style={{ margin: 0 }}>
                    At least {MIN_PASSWORD_LENGTH} characters. This deployment sends no mail, so
                    there is no password reset &mdash; use a password manager.
                  </p>
                )}
                {authError && (
                  <p style={{ margin: 0, fontSize: ".74rem", color: "var(--bad)" }} role="alert">
                    {authError}
                  </p>
                )}
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button className="btn p" type="submit" disabled={authBusy}>
                    {authBusy ? "Working…" : mode === "in" ? "Sign in" : "Create account"}
                  </button>
                  <button
                    className="linkish"
                    type="button"
                    style={{ fontSize: ".74rem" }}
                    onClick={() => {
                      setMode(mode === "in" ? "up" : "in");
                      setAuthError("");
                    }}
                  >
                    {mode === "in" ? "Create an account" : "I already have one"}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      )}

      {banner && !open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 40,
            width: 340,
            maxWidth: "80vw",
            background: "var(--panel-2)",
            border: "1px solid var(--gold-deep)",
            borderRadius: 4,
            padding: "8px 10px",
            fontSize: ".72rem",
            color: "var(--ink-2)",
          }}
          role="status"
        >
          {banner}{" "}
          <button className="linkish" style={{ fontSize: ".72rem" }} onClick={() => setBanner("")}>
            Dismiss
          </button>
        </div>
      )}

      {state.t === "ask" && askDismissedRev !== state.rev && localSheet && (
        <AccountConflict
          local={localSheet}
          server={state.server.char}
          serverUpdatedAt={state.updatedAt}
          busy={false}
          onKeepLocal={() => void push(localSheet, state.rev)}
          onTakeServer={() => pull(state.rev, state.server, "Took the account's sheet.")}
          onDismiss={() => setAskDismissedRev(state.rev)}
        />
      )}
    </div>
  );
}

/** The refusal that keeps a "Clear gear" click from erasing an account.
 *
 *  /api/profile will not write an empty sheet over a populated one without
 *  `allowEmpty`, so the choice arrives here instead of happening. Two clicks to
 *  erase, one to pull, and the numbers on the account's side are printed so the
 *  owner can see what they would be erasing. */
function EmptyGuard({
  serverChar,
  onPull,
  onEraseAccount,
}: {
  serverChar: Character;
  onPull: () => void;
  onEraseAccount: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const s = summarize(serverChar);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="mono" style={{ fontSize: ".72rem", color: "var(--ink)" }}>
        Account holds {s.items} item{s.items === 1 ? "" : "s"} and {s.roster} roster row
        {s.roster === 1 ? "" : "s"}.
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn" style={{ fontSize: ".72rem" }} onClick={onPull}>
          Bring the account&rsquo;s sheet here
        </button>
        <button
          className="btn"
          style={{ fontSize: ".72rem", borderColor: armed ? "var(--bad)" : undefined }}
          onClick={() => (armed ? onEraseAccount() : setArmed(true))}
        >
          {armed ? "Yes — erase the account's sheet" : "Erase the account's sheet"}
        </button>
      </div>
    </div>
  );
}
