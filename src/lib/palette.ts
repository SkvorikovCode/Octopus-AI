// An outside color palette: a file another program writes so Octopus follows
// the desktop's colors (on Omarchy, its plugin writes one from the current theme).
// The native side reads `<config dir>/octopus/palette.json` and reports changes.
//
// {
//   "format": 1,
//   "name": "tokyo-night",          // optional, shown in Settings
//   "scheme": "dark",               // or "light": shadows, overlays, form controls
//   "colors": { "bg": "#1a1b26", "ink": "#c0caf5", "accent": "#7aa2f7", ... }
// }
//
// Color keys are the names of the CSS variables in styles.css. Missing keys keep
// the scheme's own value; unknown keys and anything but #rrggbb are ignored.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Palette = {
  name?: string;
  scheme: "dark" | "light";
  colors: Partial<Record<PaletteKey, string>>;
};

export const PALETTE_KEYS = [
  "bg",
  "panel",
  "panel-2",
  "raise",
  "line",
  "line-2",
  "line-3",
  "dot",
  "ink",
  "ink-2",
  "ink-3",
  "mute",
  "dim",
  "accent",
  "on-accent",
  "code-bg",
  "composer",
  "syn-str",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];

const HEX = /^#[0-9a-f]{6}$/i;

/** The palette in the file's text, or null when it is not one. */
export function parsePalette(text: string | null | undefined): Palette | null {
  if (!text) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.format !== 1 || (o.scheme !== "dark" && o.scheme !== "light")) return null;
  const raw = o.colors && typeof o.colors === "object" && !Array.isArray(o.colors) ? (o.colors as Record<string, unknown>) : {};
  const colors: Palette["colors"] = {};
  for (const key of PALETTE_KEYS) {
    const c = raw[key];
    if (typeof c === "string" && HEX.test(c)) colors[key] = c.toLowerCase();
  }
  if (!colors.bg || !colors.ink) return null;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : undefined;
  return { name, scheme: o.scheme, colors };
}

/** Reads the palette now and on every change; resolves after the first read. */
export function followPalette(apply: (p: Palette | null) => void): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  const read = () =>
    invoke<string | null>("palette_read")
      .then((text) => apply(parsePalette(text)))
      .catch(() => {});
  listen("palette-changed", () => void read()).catch(() => {});
  return read();
}
