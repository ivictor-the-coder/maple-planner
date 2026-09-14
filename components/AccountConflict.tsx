"use client";

// The one screen in this feature that exists because a computer must not decide.
//
// It appears when this device and the account each hold a planner sheet, they
// differ, and nothing proves which is newer - the owner edited on the PC and on
// the MacBook without the two ever meeting. lib/profileSync.ts will resolve
// every case it can prove; what reaches here is the residue, and the residue is
// a question, not a bug.
//
// THREE THINGS THIS SCREEN MUST DO, in order of how badly they fail:
//
//   1. Say what is on each side in numbers the owner recognises - item count,
//      roster count, who the sheet is. "Local" and "Remote" with no figures is
//      a coin flip with extra steps.
//   2. Make the losing side recoverable BEFORE the click. "Save a copy" writes
//      the device's sheet to a .json file that the existing import dialog
//      reads back. The account's side is recoverable too, but by a route the
//      owner cannot see from here (profile_history keeps ten revisions), so the
//      copy button is offered for the side that has no such net.
//   3. Never have a default. No button is primary, nothing is pre-selected,
//      and the dialog does not close on a backdrop click - a stray click
//      landing on a data-losing choice is exactly the failure mode.

import { useState } from "react";
import { exportProfile, exportFilename } from "@/lib/portable";
import { summarize, type SheetSummary } from "@/lib/profileSync";
import type { Character } from "@/lib/rules";

export interface AccountConflictProps {
  /** The sheet on this device. */
  local: Character;
  /** The sheet on the account. */
  server: Character;
  /** Server-clock ISO timestamp of the account's last save, or "" if unknown.
   *  Shown only for the account side: the server's clock is the one clock in
   *  this system that is worth anything, and a client "exported" stamp is not
   *  evidence of anything, so this screen never prints one for the local side. */
  serverUpdatedAt: string;
  busy: boolean;
  onKeepLocal: () => void;
  onTakeServer: () => void;
  onDismiss: () => void;
}

function Side({ title, sub, s }: { title: string; sub: string; s: SheetSummary }) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 4,
        padding: "10px 12px",
        background: "var(--well)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div className="sub-h">{title}</div>
      <div style={{ fontSize: ".95rem", fontWeight: 600, color: "var(--gold-2)" }}>
        {s.name || "Unnamed"}
      </div>
      <div style={{ fontSize: ".74rem", color: "var(--ink-2)" }}>
        {s.cls || "class not set"} &middot; Lv {s.lvl}
      </div>
      <div className="mono" style={{ fontSize: ".8rem", color: "var(--ink)" }}>
        {s.items} item{s.items === 1 ? "" : "s"} &middot; {s.roster} roster row{s.roster === 1 ? "" : "s"}
      </div>
      <div style={{ fontSize: ".68rem", color: "var(--ink-3)" }}>{sub}</div>
    </div>
  );
}

/** Hand the device's sheet to the browser as a file, using the app's own
 *  exporter so what comes out is exactly what the import dialog reads back in.
 *  Icons are dropped by exportProfile() and the sprites re-resolve from itemId;
 *  everything else round-trips. */
function saveCopy(ch: Character): void {
  const blob = exportProfile(ch);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(ch);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can race the download in some browsers; a tick is
  // enough and the object is a few kilobytes.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export default function AccountConflict({
  local,
  server,
  serverUpdatedAt,
  busy,
  onKeepLocal,
  onTakeServer,
  onDismiss,
}: AccountConflictProps) {
  const [saved, setSaved] = useState(false);
  const ls = summarize(local);
  const ss = summarize(server);

  let when = "last saved at an unknown time";
  if (serverUpdatedAt) {
    const t = Date.parse(serverUpdatedAt);
    when = Number.isNaN(t) ? "last saved at an unknown time" : "last saved " + new Date(t).toLocaleString();
  }

  return (
    // No backdrop-click-to-close: see note 3 in the header.
    <div className="ed-back" role="dialog" aria-modal="true" aria-labelledby="conf-h">
      <div className="ed-in">
        <div style={{ padding: "12px 15px", borderBottom: "1px solid var(--line)" }}>
          <h3 id="conf-h" style={{ fontSize: "1rem" }}>Two sheets, and they differ</h3>
        </div>

        <div style={{ padding: "14px 15px", display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: ".84rem", color: "var(--ink-2)" }}>
            This device and your account each hold a planner sheet, and they are not the same.
            Nothing has been changed on either side. Pick the one to keep &mdash; the other is
            replaced.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Side title="On this device" sub="not yet on the account" s={ls} />
            <Side title="On your account" sub={when} s={ss} />
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <button
              className="btn"
              onClick={() => {
                saveCopy(local);
                setSaved(true);
              }}
              title="Download this device's sheet as a .json file you can import again later"
            >
              {saved ? "Copy saved ✓" : "Save a copy of this device's sheet"}
            </button>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn" disabled={busy} onClick={onKeepLocal}>
              Keep this device&rsquo;s sheet
            </button>
            <button className="btn" disabled={busy} onClick={onTakeServer}>
              Use the account&rsquo;s sheet
            </button>
            <button className="btn" disabled={busy} onClick={onDismiss} style={{ marginLeft: "auto" }}>
              Decide later
            </button>
          </div>

          <p className="fineprint" style={{ margin: 0 }}>
            &ldquo;Decide later&rdquo; changes nothing and stops syncing until you choose; your
            edits keep saving to this browser as they always have. Replacing the account&rsquo;s
            sheet archives the revision it replaces in the database, but there is no screen to
            restore one from yet &mdash; the file above is the copy you can actually open.
          </p>
        </div>
      </div>
    </div>
  );
}
