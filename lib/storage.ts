// Swappable persistence. Today: this browser. Later: the signed-in user's account.
//
// When accounts land on a server, add an ApiAccountStore that hits /api/account
// and have getAccountStore() return it whenever a session exists. Nothing in the
// UI changes.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED AND WHY THE OLD KEY IS STILL THERE
// ---------------------------------------------------------------------------
// This module used to persist exactly ONE Character at "maple-planner:character".
// It now persists an Account — many characters, one active — at
// "maple-planner:account", and migrates the old key into it on first load.
//
// The old key is NEVER DELETED by the migration. A real store holds 25 slots of
// hand-entered and screenshot-imported gear that took hours to build, and the
// failure modes of a browser are not hypothetical: quota errors, private mode,
// blocked storage, an exception halfway through a write. So the write is
// VERIFIED — read back, parsed, and counted against what we meant to store —
// before the migration is recorded as done, and the legacy payload stays exactly
// where it was either way. If the new key is ever lost, the old one is still a
// complete character and the next load migrates it again.
//
// clear() is the one place both keys go, because clear() is the player saying
// "wipe this" and a clear that left a copy behind would resurrect it on the next
// load.

import {
  ACCOUNT_KEY,
  LEGACY_CHARACTER_KEY,
  activeCharacter,
  countItems,
  describeMigration,
  emptyAccount,
  migrateToAccount,
  normalizeAccount,
  setRoster,
  withActiveCharacter,
  type Account,
  type Character,
  type MigrationReport,
} from "./rules";

/** Written the moment a legacy migration is CONFIRMED on disk. Its presence is
 *  what stops a later load from migrating a second time over newer data. */
export const MIGRATION_MARKER_KEY = "maple-planner:migrated-from-character";

export interface MigrationRecord {
  at: string;
  /** The key the data came from. Kept so a human reading localStorage can see
   *  exactly which payload was promoted. */
  from: string;
  report: MigrationReport;
}

export interface AccountStore {
  readonly kind: "local" | "account";
  load(): Promise<Account | null>;
  save(a: Account): Promise<void>;
  clear(): Promise<void>;
  /** Non-null once a legacy character has been migrated and the write verified. */
  migration(): Promise<MigrationRecord | null>;
}

/**
 * The pre-account interface, kept working ON PURPOSE.
 *
 * components/Planner.tsx is written against a single Character and is not owned
 * by this change. Rather than break it, the character store became a VIEW over
 * the account: load() hands back the active character (with the account roster
 * projected onto the deprecated `Character.roster` field, so the existing Roster
 * panel keeps rendering), and save() writes it back into the active slot and
 * hoists any roster edit up into the account.
 *
 * @deprecated New UI should take getAccountStore(). This exists so the two can
 * coexist for one wave, not forever.
 */
export interface Store {
  readonly kind: "local" | "account";
  load(): Promise<Character | null>;
  save(c: Character): Promise<void>;
  clear(): Promise<void>;
}

/* ---------- the raw localStorage plumbing, in one place ---------- */

function ls(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Blocked storage. The app still works; it just will not persist.
    return null;
  }
}

function readRaw(key: string): string | null {
  try {
    return ls()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write, then READ BACK. Returns false on quota, on blocked storage, and on the
 *  silent partial write — which is the one a plain setItem hides. */
function writeVerified(key: string, value: string): boolean {
  const s = ls();
  if (!s) return false;
  try {
    s.setItem(key, value);
  } catch {
    return false;
  }
  try {
    return s.getItem(key) === value;
  } catch {
    return false;
  }
}

function removeRaw(key: string): void {
  try {
    ls()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ---------- the migration, run at most once per browser ---------- */

/**
 * Promote the legacy single Character into an Account.
 *
 * Returns the account it produced EVEN WHEN THE WRITE FAILS, so a player with
 * full storage still gets their character on screen — they just get it from the
 * legacy key again on the next load, which is the correct degradation.
 *
 * The verification is not ceremonial. It re-reads the key through the same door
 * the app uses and compares character and item COUNTS, so a truncated or
 * quota-clipped write is caught before the marker claims the data is safe.
 */
function migrateLegacy(): { account: Account | null; record: MigrationRecord | null } {
  const raw = readRaw(LEGACY_CHARACTER_KEY);
  if (!raw) return { account: null, record: null };

  const account = migrateToAccount(raw);
  if (!account) return { account: null, record: null };

  const report = describeMigration(raw, account);

  if (!writeVerified(ACCOUNT_KEY, JSON.stringify(account))) return { account, record: null };

  const back = migrateToAccount(readRaw(ACCOUNT_KEY));
  if (!back || Object.keys(back.characters).length !== report.characters || countItems(back) !== report.items) {
    return { account, record: null };
  }

  const record: MigrationRecord = { at: new Date().toISOString(), from: LEGACY_CHARACTER_KEY, report };
  // Best-effort: a failed marker write costs an idempotent re-migration on the
  // next load, which normalizeAccount() makes harmless. Not worth failing over.
  writeVerified(MIGRATION_MARKER_KEY, JSON.stringify(record));
  return { account, record };
}

const localAccountStore: AccountStore = {
  kind: "local",

  async load() {
    const raw = readRaw(ACCOUNT_KEY);
    if (raw) {
      // A present-but-unreadable account key must NOT fall through to the legacy
      // key: that would silently resurrect an older character on top of newer
      // work. Hand back nothing and let the caller start fresh; the bytes stay
      // on disk for a human to look at.
      return migrateToAccount(raw);
    }
    return migrateLegacy().account;
  },

  async save(a) {
    writeVerified(ACCOUNT_KEY, JSON.stringify(normalizeAccount(a)));
  },

  async clear() {
    // Both keys, and the marker. See the header.
    removeRaw(ACCOUNT_KEY);
    removeRaw(LEGACY_CHARACTER_KEY);
    removeRaw(MIGRATION_MARKER_KEY);
  },

  async migration() {
    const raw = readRaw(MIGRATION_MARKER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MigrationRecord;
    } catch {
      return null;
    }
  },
};

export function getAccountStore(): AccountStore {
  return localAccountStore;
}

/* ---------- the single-character view over the account ---------- */

const localStore: Store = {
  kind: "local",

  async load() {
    const a = await localAccountStore.load();
    return a ? activeCharacter(a) : null;
  },

  async save(c) {
    // Read-modify-write rather than blind overwrite: the other characters on the
    // account are not in this caller's hands and must survive its save.
    const a = (await localAccountStore.load()) ?? emptyAccount();
    // The character came out of activeCharacter(), which projects the account
    // roster down onto it, so `c.roster` is this view's authority for the roster
    // — including when the player cleared it and it came back undefined.
    await localAccountStore.save(setRoster(withActiveCharacter(a, c), c.roster));
  },

  async clear() {
    await localAccountStore.clear();
  },
};

/** @deprecated Use getAccountStore(). See the Store doc comment. */
export function getStore(): Store {
  return localStore;
}
