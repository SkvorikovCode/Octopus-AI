// Agent instruction files: the general ones (for all projects) and the current project's.
// Real data comes from the Rust `instructions_*` commands; outside Tauri (browser preview)
// an in-memory copy with demo texts is used instead, so saves persist for the page session.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { t } from "./i18n";

/** One instructions level. `targetRel` is the file the editor shows and saves. */
export type Scope = {
  targetRel: string;
  target: string;
  exists: boolean;
  content: string;
  /** Relative path of the file the agent reads now, or null if none. */
  active: string | null;
  /** Other existing files the agent ignores: only one file per level is read. */
  shadowed: string[];
};

export type Instructions = {
  global: Scope;
  project: Scope | null;
  /** Absolute path of the user's Claude Code general instructions, if present. */
  claudeImport: string | null;
};

export type InstructionsScope = "global" | "project";

const DEMO = !isTauri();

/** Default general file of the agent (relative to the home folder). */
const GLOBAL_DEFAULT_REL = ".omp/agent/AGENTS.md";

// ---------- demo data (browser preview) ----------

const DEMO_HOME = "/Users/demo";
const DEMO_PROJECT = `${DEMO_HOME}/Documents/GitHub/demo-project`;

let demoGlobal: Scope = {
  targetRel: GLOBAL_DEFAULT_REL,
  target: `${DEMO_HOME}/${GLOBAL_DEFAULT_REL}`,
  exists: true,
  content: "Отвечай по-русски.\nПиши коротко, без лишних пояснений.\nПеред правками в файлах коротко опиши план.",
  active: GLOBAL_DEFAULT_REL,
  shadowed: [],
};

let demoProject: Scope = {
  targetRel: ".claude/CLAUDE.md",
  target: `${DEMO_PROJECT}/.claude/CLAUDE.md`,
  exists: true,
  content: "# demo-project\n\nСтек: TypeScript, React.\nТесты запускаются командой npm test.",
  active: ".claude/CLAUDE.md",
  shadowed: ["AGENTS.md"],
};

const DEMO_CLAUDE_IMPORT = `${DEMO_HOME}/.claude/CLAUDE.md`;
const DEMO_CLAUDE_TEXT = "Всегда запускай тесты перед коммитом.\nНе трогай файлы в папке vendor/.";

function demoGet(cwd: string | null | undefined): Instructions {
  return {
    global: { ...demoGlobal, shadowed: [...demoGlobal.shadowed] },
    project: cwd ? { ...demoProject, shadowed: [...demoProject.shadowed] } : null,
    claudeImport: DEMO_CLAUDE_IMPORT,
  };
}

function demoSave(scope: InstructionsScope, rel: string, content: string): void {
  const home = scope === "global" ? DEMO_HOME : DEMO_PROJECT;
  const s = scope === "global" ? demoGlobal : demoProject;
  const prev = s.active;
  s.targetRel = rel;
  s.target = `${home}/${rel}`;
  s.exists = true;
  s.content = content;
  s.active = rel;
  // The file that was read before is now ignored, like the real backend does.
  s.shadowed = [...new Set([...s.shadowed.filter((x) => x !== rel), ...(prev && prev !== rel ? [prev] : [])])];
}

// ---------- commands ----------

/** Both levels: the project one only when `cwd` is given. */
export async function getInstructions(cwd?: string | null): Promise<Instructions> {
  if (DEMO) return demoGet(cwd);
  return invoke<Instructions>("instructions_get", { cwd: cwd ?? null });
}

/** Writes `content` to `rel` (the file named by `targetRel`) at the given level. */
export async function saveInstructions(
  scope: InstructionsScope,
  cwd: string | null | undefined,
  rel: string,
  content: string,
): Promise<void> {
  if (DEMO) {
    if (scope === "project" && !cwd) throw new Error("Инструкции: проект не открыт");
    demoSave(scope, rel, content);
    return;
  }
  await invoke<void>("instructions_save", { scope, cwd: cwd ?? null, rel, content });
}

/** Text of the user's Claude Code general instructions. */
export async function readClaudeInstructions(): Promise<string> {
  if (DEMO) return DEMO_CLAUDE_TEXT;
  return invoke<string>("instructions_read_claude");
}

// ---------- display ----------

/** ".omp/" folders and the engine's own file names (case-insensitive). */
const ENGINE_PATH = /(^|\/)\.omp\/|oh-my-pi|models\.yml/i;

const trimSlash = (p: string | undefined): string => (p ?? "").replace(/\/+$/, "");

/**
 * Path as shown in the UI. Engine-internal locations are never shown by name: anything
 * under ".omp/" becomes a neutral label. Paths inside `project` are relative to it,
 * paths inside `home` start with "~/". Other paths are returned as they are.
 */
export function displayPath(p: string, opts: { project?: string; home?: string } = {}): string {
  const path = p.replace(/\\/g, "/");
  if (path === GLOBAL_DEFAULT_REL || path.endsWith(`/${GLOBAL_DEFAULT_REL}`)) {
    return t("общие инструкции агента");
  }
  // Engine names never reach the UI: any path that mentions them is shown as a neutral label.
  if (ENGINE_PATH.test(path)) return t("служебный файл агента");

  const project = trimSlash(opts.project);
  if (project && path.startsWith(`${project}/`) && path.length > project.length + 1) {
    return path.slice(project.length + 1);
  }

  const home = trimSlash(opts.home);
  if (home && path.startsWith(`${home}/`) && path.length > home.length + 1) return `~${path.slice(home.length)}`;

  return p;
}
