// App preferences: a tiny store in localStorage with a React hook.

import { useSyncExternalStore } from "react";

export type Settings = {
  /** Accent color for actions and "live" states. */
  accent: string;
  /** Whole-UI zoom, 0.85–1.25. */
  uiScale: number;
  /** System notifications when an agent finishes or waits for a reply elsewhere. */
  notifications: boolean;
  /** "enter": Enter sends, Shift+Enter breaks; "mod-enter": ⌘Enter sends, Enter breaks. */
  sendWith: "enter" | "mod-enter";
  /** Open the model's reasoning block by default. */
  thinkingExpanded: boolean;
  /** Session tiles (agent, tokens, plan, context): a column on the right, or small rings under the
   *  composer. A window too narrow for the column shows the rings either way. */
  tilesMode: "full" | "compact";
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
  tilesMode: "full",
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
    if (raw) return sanitize(JSON.parse(raw));
  } catch {
    /* fall back to defaults */
  }
  return DEFAULT_SETTINGS;
}

/** Keeps only stored values of the right shape; anything else falls back to the default. */
function sanitize(v: unknown): Settings {
  if (!v || typeof v !== "object" || Array.isArray(v)) return DEFAULT_SETTINGS;
  const o = v as Record<string, unknown>;
  const pick = <K extends keyof Settings>(k: K, ok: (x: unknown) => boolean): Settings[K] =>
    ok(o[k]) ? (o[k] as Settings[K]) : DEFAULT_SETTINGS[k];
  const oneOf = (...xs: string[]) => (x: unknown) => typeof x === "string" && xs.includes(x);
  const limit = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x) && x > 0);
  return {
    accent: pick("accent", (x) => typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x)),
    uiScale: pick("uiScale", (x) => typeof x === "number" && x >= 0.85 && x <= 1.25),
    notifications: pick("notifications", (x) => typeof x === "boolean"),
    sendWith: pick("sendWith", oneOf("enter", "mod-enter")),
    thinkingExpanded: pick("thinkingExpanded", (x) => typeof x === "boolean"),
    // Before the modes there was an on/off switch; "off" maps to the least space taken.
    tilesMode: o.tilesMode === undefined && o.showTiles === false ? "compact" : pick("tilesMode", oneOf("full", "compact")),
    language: pick("language", oneOf("auto", "ru", "en")),
    theme: pick("theme", oneOf("auto", "dark", "light")),
    budgetDaily: pick("budgetDaily", limit),
    budgetSession: pick("budgetSession", limit),
  };
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
  root.style.setProperty("--accent-deep", readableOnPaper(s.accent));
  root.dataset.theme = s.theme;
  root.dataset.scheme = resolveScheme(s.theme);
  watchScheme();
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

/** The scheme the CSS paints: "auto" follows the system. */
export function resolveScheme(theme: Settings["theme"]): "light" | "dark" {
  if (theme !== "auto") return theme;
  const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : null;
  return mq?.matches ? "light" : "dark";
}

let watching = false;
function watchScheme() {
  if (watching || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  watching = true;
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applySettings());
}

const PAPER = [255, 253, 249];

function luminance([r, g, b]: number[]) {
  const c = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: number[], b: number[]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The accent darkened, keeping its hue, until it reads as text (4.5:1) on the light tiles. */
export function readableOnPaper(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#c4261a";
  const n = parseInt(m[1], 16);
  let rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  for (let i = 0; i < 40 && contrast(rgb, PAPER) < 4.5; i++) rgb = rgb.map((v) => Math.round(v * 0.94));
  return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
}
