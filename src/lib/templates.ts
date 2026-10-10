// User prompt templates ("мои команды"): a tiny store in localStorage with a React hook.

import { useMemo, useSyncExternalStore } from "react";
import { currentLang, t as tr } from "./i18n";

export type Template = {
  id: string;
  /** Slash name, typed as /name in the composer. */
  name: string;
  /** Human title shown in lists and the palette. */
  title: string;
  /** The task text that gets sent. */
  body: string;
};

/** Allowed slash names: lowercase latin letters, digits and dashes, 1–32 chars. */
export const TEMPLATE_NAME_RE = /^[a-z0-9-]{1,32}$/;

export const DEFAULT_TEMPLATES: Template[] = [
  {
    id: "default-review",
    name: "review",
    title: "Ревью изменений",
    body: "Посмотри изменения в рабочей папке (git diff) и сделай код-ревью: ошибки, риски, что упростить. Ничего не меняй.",
  },
  {
    id: "default-tests",
    name: "tests",
    title: "Тесты к изменениям",
    body: "Найди изменённый код и добавь к нему тесты. Запусти их и почини, если падают.",
  },
  {
    id: "default-explain",
    name: "explain",
    title: "Объясни файл",
    body: "Объясни простыми словами, как устроен этот файл и зачем он нужен: ",
  },
];

const KEY = "octopus.templates";
const listeners = new Set<() => void>();

function isTemplate(v: unknown): v is Template {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.title === "string" &&
    typeof t.body === "string"
  );
}

function load(): Template[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isTemplate);
    }
  } catch {
    /* broken or unavailable storage: fall back to defaults */
  }
  return DEFAULT_TEMPLATES;
}

// The snapshot is replaced (never mutated) on each change, so useSyncExternalStore stays stable.
let current: Template[] = load();

function persist(next: Template[]) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* kept for this run */
  }
  listeners.forEach((l) => l());
}

export function getTemplates(): Template[] {
  return current;
}

/** Inserts the template, or replaces the one with the same id. */
export function saveTemplate(t: Template): void {
  const exists = current.some((x) => x.id === t.id);
  persist(exists ? current.map((x) => (x.id === t.id ? { ...t } : x)) : [...current, { ...t }]);
}

export function deleteTemplate(id: string): void {
  if (!current.some((x) => x.id === id)) return;
  persist(current.filter((x) => x.id !== id));
}

/**
 * Built-in templates are stored with their Russian text; shown and sent in the
 * interface language. User text is never translated (no dictionary entry).
 */
function localize(tpl: Template): Template {
  return tpl.id.startsWith("default-") ? { ...tpl, title: tr(tpl.title), body: tr(tpl.body) } : tpl;
}

export function useTemplates(): Template[] {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getTemplates,
  );
  const lang = currentLang();
  return useMemo(() => list.map(localize), [list, lang]);
}

export function newTemplateId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the fallback */
  }
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The text to send for a template: its body, plus any extra text typed after the command. */
export function expandTemplate(t: Template, rest: string): string {
  return t.body + (rest ? "\n\n" + rest : "");
}
