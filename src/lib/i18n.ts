// Interface language: Russian source strings, English dictionary.
//
// Copy is written in Russian right in the components and passed through t():
//   t("Новая сессия")                       → "New session" in English
//   t("Агент работает в папке «{name}»", { name })
//   tn(3, "файл|файла|файлов")              → "3 файла" / "3 files"  ({n} optional)
// A missing translation falls back to the Russian text. Dictionaries live in
// src/i18n/en/*.ts, keyed by the exact Russian string.

import { getSettings } from "./settings";
import { EN } from "../i18n/en";

export type Lang = "ru" | "en";
export type LangSetting = "auto" | Lang;

/** Language of the OS / webview: Russian for ru-*, English for everything else. */
export function systemLang(): Lang {
  const first = (typeof navigator !== "undefined" && (navigator.languages?.[0] ?? navigator.language)) || "en";
  return first.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function currentLang(): Lang {
  const s = getSettings().language;
  return s === "ru" || s === "en" ? s : systemLang();
}

/** BCP 47 locale for dates and numbers. */
export function locale(): string {
  return currentLang() === "en" ? "en-US" : "ru-RU";
}

function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Translate a Russian UI string. */
export function t(ru: string, vars?: Record<string, string | number>): string {
  const s = currentLang() === "en" ? EN[ru] ?? ru : ru;
  return fill(s, vars);
}

/**
 * Plural word for n. `forms` is the Russian "one|few|many" key; its English
 * entry is "one|other". Forms may contain {n}; otherwise "n word" is returned.
 */
export function tn(n: number, forms: string, vars?: Record<string, string | number>): string {
  const lang = currentLang();
  const parts = (lang === "en" ? EN[forms] ?? forms : forms).split("|");
  let word: string;
  if (lang === "ru" && parts.length >= 3) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    word = a > 10 && a < 20 ? parts[2] : b > 1 && b < 5 ? parts[1] : b === 1 ? parts[0] : parts[2];
  } else {
    word = n === 1 ? parts[0] : parts[1] ?? parts[0];
  }
  const out = word.includes("{n}") ? word : `{n} ${word}`;
  return fill(out, { n: n.toLocaleString(locale()), ...vars });
}

/** Plural word only, without the number. */
export function tw(n: number, forms: string): string {
  const lang = currentLang();
  const parts = (lang === "en" ? EN[forms] ?? forms : forms).split("|");
  if (lang === "ru" && parts.length >= 3) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    return a > 10 && a < 20 ? parts[2] : b > 1 && b < 5 ? parts[1] : b === 1 ? parts[0] : parts[2];
  }
  return n === 1 ? parts[0] : parts[1] ?? parts[0];
}

/**
 * Error text from the backend or the agent: an exact dictionary match, else the
 * "Prefix: details" form with only the prefix translated.
 */
export function tErr(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (currentLang() !== "en" || EN[raw]) return t(raw);
  const m = /^([^:\n]{3,80}):\s([\s\S]*)$/.exec(raw);
  return m && EN[m[1]] ? `${EN[m[1]]}: ${m[2]}` : raw;
}
