// Per-session organisation in the sidebar: pinned, archived and custom display names.
// Kept in localStorage (keyed by session id) with a React hook. Every storage access
// is guarded, because localStorage can be blocked or throw (private windows, cleared data).

import { useSyncExternalStore } from "react";
import type { SessionMeta } from "./sessions";

export type SessionPrefs = {
  /** Session ids, oldest pin first. */
  pinned: string[];
  /** Session ids hidden from the list (shown under "Archive"). */
  archived: string[];
  /** Custom display names: session id → name. */
  names: Record<string, string>;
};

/** Cap for each list and for the name map; the newest entries are kept. */
export const MAX_SESSION_PREFS = 500;
const MAX_NAME_LENGTH = 200;

const KEY = "octopus.sessionPrefs";
const EMPTY: SessionPrefs = { pinned: [], archived: [], names: {} };
const listeners = new Set<() => void>();

function sanitizeIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ids = [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))];
  return ids.slice(-MAX_SESSION_PREFS);
}

function sanitizeNames(v: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  if (!v || typeof v !== "object") return names;
  for (const [id, name] of Object.entries(v as Record<string, unknown>)) {
    if (id === "__proto__" || typeof name !== "string") continue;
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (trimmed) names[id] = trimmed;
  }
  return trimNames(names);
}

/** Drops the oldest name overrides beyond the cap (object keys keep insertion order). */
function trimNames(names: Record<string, string>): Record<string, string> {
  const keys = Object.keys(names);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSION_PREFS))) delete names[k];
  return names;
}

function load(): SessionPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const o = parsed as Record<string, unknown>;
        return { pinned: sanitizeIds(o.pinned), archived: sanitizeIds(o.archived), names: sanitizeNames(o.names) };
      }
    }
  } catch {
    /* broken or unavailable storage: start empty */
  }
  return EMPTY;
}

// The snapshot is replaced (never mutated) on each change, so useSyncExternalStore stays stable.
let current: SessionPrefs = load();

function commit(next: SessionPrefs) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* kept for this run */
  }
  listeners.forEach((l) => l());
}

export function getSessionPrefs(): SessionPrefs {
  return current;
}

export function togglePin(id: string) {
  const pinned = current.pinned.includes(id)
    ? current.pinned.filter((x) => x !== id)
    : [...current.pinned, id].slice(-MAX_SESSION_PREFS);
  commit({ ...current, pinned });
}

export function toggleArchive(id: string) {
  const archived = current.archived.includes(id)
    ? current.archived.filter((x) => x !== id)
    : [...current.archived, id].slice(-MAX_SESSION_PREFS);
  commit({ ...current, archived });
}

/** Sets a custom display name; an empty (or blank) name removes the override. */
export function rename(id: string, name: string) {
  const value = name.trim().slice(0, MAX_NAME_LENGTH);
  const names = { ...current.names };
  delete names[id];
  if (value) names[id] = value;
  commit({ ...current, names: trimNames(names) });
}

/** The title to show: the custom name when there is one, else the session's own title. */
export function displayTitle(meta: SessionMeta, prefs: SessionPrefs): string {
  return Object.prototype.hasOwnProperty.call(prefs.names, meta.id) ? prefs.names[meta.id] : meta.title;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSessionPrefs(): SessionPrefs {
  return useSyncExternalStore(subscribe, getSessionPrefs);
}
