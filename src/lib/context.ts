// Files pinned to a chat session: the agent gets them with every message of that session.
// Stored in localStorage as { sessionKey: string[] } (paths as they appear in @-mentions).

import { useSyncExternalStore } from "react";

/** Most files pinned to one session. */
export const MAX_PINNED = 20;
/** Most sessions kept in storage; the least recently changed are dropped first. */
const MAX_SESSIONS = 300;
const KEY = "octopus.pinned";

type Store = Record<string, string[]>;

const EMPTY: string[] = [];
const listeners = new Set<() => void>();

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Store = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!Array.isArray(value)) continue;
          const paths = value.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, MAX_PINNED);
          if (paths.length) out[key] = paths;
        }
        return out;
      }
    }
  } catch {
    /* start with nothing pinned */
  }
  return {};
}

// Kept in memory so that getPinned returns the same array until something changes.
let current = load();

function save(next: Store) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* kept for this run */
  }
  listeners.forEach((l) => l());
}

/** Pinned paths of a session. The array is shared: do not mutate it. */
export function getPinned(key: string | undefined): string[] {
  if (!key) return EMPTY;
  return Object.hasOwn(current, key) ? current[key] : EMPTY;
}

/** Replaces the pinned paths of a session (duplicates removed, capped at MAX_PINNED). */
export function setPinned(key: string, paths: string[]) {
  const clean = [...new Set(paths.map((p) => p.trim()).filter(Boolean))].slice(0, MAX_PINNED);
  const next: Store = { ...current };
  // Re-insert so that the most recently changed session comes last.
  delete next[key];
  if (clean.length) next[key] = clean;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete next[old];
  save(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Pinned paths of a session, re-rendering when they change. */
export function usePinned(key: string | undefined): string[] {
  return useSyncExternalStore(subscribe, () => getPinned(key));
}
