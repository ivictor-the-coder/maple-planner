// Swappable persistence. Today: this browser. Later: the signed-in user's account.
//
// When accounts land, add an ApiStore that hits /api/characters and have
// getStore() return it whenever a session exists. Nothing in the UI changes.

import type { Character } from "./rules";

export interface Store {
  readonly kind: "local" | "account";
  load(): Promise<Character | null>;
  save(c: Character): Promise<void>;
  clear(): Promise<void>;
}

const KEY = "maple-planner:character";

const localStore: Store = {
  kind: "local",
  async load() {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as Character) : null;
    } catch {
      return null;
    }
  },
  async save(c) {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(c));
    } catch {
      /* private mode, quota, blocked storage — the app still works, it just won't persist */
    }
  },
  async clear() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};

export function getStore(): Store {
  return localStore;
}
