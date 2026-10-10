// Agent rules: short Markdown files the agent follows. «Всегда» rules go into every prompt;
// «По теме» rules are listed by description and read when the topic fits.
// Real data comes from the Rust `rules_list` / `rule_save` / `rule_delete` commands. Outside Tauri
// (browser preview) an in-memory copy with demo rules is used, so saves persist for the page session.
// Error texts from the backend start with "Правила: " and are translated by tErr().

import { invoke, isTauri } from "@tauri-apps/api/core";

export type RuleScope = "project" | "global";

export type Rule = {
  name: string;
  scope: "project" | "global" | "foreign";
  /** Location of the rule file. Shown for foreign rules only (own rules are shown by name). */
  rel: string;
  always: boolean;
  description: string | null;
  globs: string[];
  enabled: boolean;
  /** Stream-triggered rule with conditions; the backend keeps the conditions on save. */
  special: boolean;
  /** The agent never uses it: not «всегда» and no description. */
  ignored: boolean;
  /** A general rule hidden by a project rule with the same name. */
  overridden: boolean;
  body: string;
};

export type RulesList = { project: Rule[]; global: Rule[]; foreign: Rule[] };

export type RuleInput = {
  name: string;
  always: boolean;
  description: string;
  globs: string[];
  enabled: boolean;
  body: string;
};

export const RULE_NAME_MAX = 64;
const RULE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Message key (for t()) describing why the name is invalid, or null when it is valid.
 * The name is used as the file name, so only lowercase Latin letters, digits, "-" and "_".
 */
export function ruleNameError(name: string): string | null {
  if (name === "") return "Введите название";
  if (name.length > RULE_NAME_MAX) return "Не длиннее 64 символов";
  if (!RULE_NAME_RE.test(name)) return "Начинается с буквы или цифры; дальше — строчные латинские буквы, цифры, «-» и «_»";
  return null;
}

/** A valid rule name from free text: Latin letters and digits, spaces become "-", the rest is dropped. */
export function slugifyRuleName(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (/\s/.test(ch)) out += "-";
  }
  return out
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, RULE_NAME_MAX)
    .replace(/-+$/, "");
}

/** Glob patterns typed by the user: separated by commas or new lines. */
export function parseGlobs(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// ---------- commands ----------

/** All rules: the project's (only when `cwd` is given), the general ones and the foreign ones. */
export async function listRules(cwd: string | null | undefined): Promise<RulesList> {
  if (isTauri()) return invoke<RulesList>("rules_list", { cwd: cwd ?? null });
  return demoList(cwd ?? null);
}

/** Creates or replaces a rule. `original` is the name the rule had before (null for a new rule). */
export async function saveRule(
  scope: RuleScope,
  cwd: string | null | undefined,
  original: string | null,
  rule: RuleInput,
): Promise<void> {
  if (isTauri()) {
    await invoke<void>("rule_save", { scope, cwd: cwd ?? null, original, rule });
    return;
  }
  demoSave(scope, cwd ?? null, original, rule);
}

export async function deleteRule(scope: RuleScope, cwd: string | null | undefined, name: string): Promise<void> {
  if (isTauri()) {
    await invoke<void>("rule_delete", { scope, cwd: cwd ?? null, name });
    return;
  }
  demoDelete(scope, cwd ?? null, name);
}

// ---------- demo data (browser preview) ----------

type DemoStore = { project: Rule[]; global: Rule[]; foreign: Rule[] };

function demoRule(p: Partial<Rule> & Pick<Rule, "name" | "scope">): Rule {
  return {
    rel: `rules/${p.name}.md`,
    always: false,
    description: null,
    globs: [],
    enabled: true,
    special: false,
    ignored: false,
    overridden: false,
    body: "",
    ...p,
  };
}

const demo: DemoStore = {
  project: [
    demoRule({ name: "style", scope: "project", always: true, body: "Пиши функциональные компоненты React." }),
    demoRule({
      name: "db",
      scope: "project",
      description: "Работа с базой данных",
      globs: ["src/db/**"],
      body: "Миграции пиши только через скрипты в src/db/migrations. Схему вручную не меняй.",
    }),
    demoRule({ name: "draft", scope: "project", body: "Черновик: пока не используется." }),
  ],
  global: [
    demoRule({
      name: "commits",
      scope: "global",
      always: true,
      body: "Перед коммитом запускай тесты. Сообщения коммитов пиши по-русски.",
    }),
    demoRule({ name: "style", scope: "global", always: true, body: "Отступы — два пробела." }),
  ],
  foreign: [
    {
      ...demoRule({ name: "legacy", scope: "foreign", always: true, body: "Старые правила из другого инструмента." }),
      rel: ".cursor/rules/legacy.mdc",
    },
  ],
};

/** The flags the backend computes: ignored and overridden depend on the other rules. */
function demoRecompute(): void {
  const projectNames = new Set(demo.project.map((r) => r.name));
  for (const r of [...demo.project, ...demo.global]) {
    r.ignored = !r.always && !r.description;
  }
  for (const r of demo.global) r.overridden = projectNames.has(r.name);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function demoList(cwd: string | null): RulesList {
  demoRecompute();
  return {
    project: cwd ? clone(demo.project) : [],
    global: clone(demo.global),
    foreign: clone(demo.foreign),
  };
}

function demoSave(scope: RuleScope, cwd: string | null, original: string | null, input: RuleInput): void {
  if (scope === "project" && !cwd) throw new Error("Правила: проект не открыт");
  if (ruleNameError(input.name) !== null) throw new Error("Правила: неверное название");
  const list = scope === "project" ? demo.project : demo.global;
  if (list.some((r) => r.name === input.name && r.name !== original)) {
    throw new Error("Правила: такое название уже занято");
  }
  const idx = original ? list.findIndex((r) => r.name === original) : -1;
  const prev = idx >= 0 ? list[idx] : undefined;
  const next: Rule = {
    ...(prev ?? demoRule({ name: input.name, scope })),
    name: input.name,
    rel: prev?.rel ?? `rules/${input.name}.md`,
    always: input.always,
    description: input.description || null,
    globs: input.always ? [] : input.globs,
    enabled: input.enabled,
    body: input.body,
  };
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  list.sort((a, b) => a.name.localeCompare(b.name));
  demoRecompute();
}

function demoDelete(scope: RuleScope, cwd: string | null, name: string): void {
  if (scope === "project" && !cwd) throw new Error("Правила: проект не открыт");
  const list = scope === "project" ? demo.project : demo.global;
  const idx = list.findIndex((r) => r.name === name);
  if (idx >= 0) list.splice(idx, 1);
  demoRecompute();
}
