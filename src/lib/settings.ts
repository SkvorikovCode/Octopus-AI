// App preferences: a tiny store in localStorage with a React hook.

import { useSyncExternalStore } from "react";

export type Settings = {
  /** Accent color for actions and "live" states. */
  accent: string;
  /** Whole-UI zoom, 0.85–1.25. */
  uiScale: number;
  /** macOS notifications while the window is in the background. */
  notifications: boolean;
  /** "enter": Enter sends, Shift+Enter breaks; "mod-enter": ⌘Enter sends, Enter breaks. */
  sendWith: "enter" | "mod-enter";
  /** Open the model's reasoning block by default. */
  thinkingExpanded: boolean;
  /** Right-hand tiles column (agent, tokens, plan, context). */
  showTiles: boolean;
  /** Interface language: follow the system, or fixed. */
  language: "auto" | "ru" | "en";
  /** Color theme: the dark brand look (default), light paper, or follow the system. */
  theme: "auto" | "dark" | "light";
  /** Spending limit per day across all projects, USD. null = off. */
  budgetDaily: number | null;
  /** Spending limit per session, USD. null = off. */
  budgetSession: number | null;
};

export const ACCENTS = ["#FF3D2E", "#FF8A1F", "#B8FF3D", "#3DE0FF", "#EEE9E2"] as const;

export const DEFAULT_SETTINGS: Settings = {
  accent: ACCENTS[0],
  uiScale: 1,
  notifications: true,
  sendWith: "enter",
  thinkingExpanded: false,
  showTiles: true,
  language: "auto",
  theme: "dark",
  budgetDaily: null,
  budgetSession: null,
};

const KEY = "octopus.settings";
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* fall back to defaults */
  }
  return DEFAULT_SETTINGS;
}

let current = load();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* kept for this run */
  }
  applySettings(current);
  listeners.forEach((l) => l());
}

export function resetSettings() {
  updateSettings(DEFAULT_SETTINGS);
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSettings,
  );
}

/** Pushes settings that live in CSS onto the document. */
export function applySettings(s: Settings = current) {
  const root = document.documentElement;
  root.style.setProperty("--accent", s.accent);
  root.style.setProperty("--accent-soft", hexAlpha(s.accent, 0.1));
  root.dataset.theme = s.theme;
  const nav = (typeof navigator !== "undefined" && (navigator.languages?.[0] ?? navigator.language)) || "en";
  root.lang = s.language === "auto" ? (nav.toLowerCase().startsWith("ru") ? "ru" : "en") : s.language;
  (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(s.uiScale);
}

function hexAlpha(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(255, 61, 46, ${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
