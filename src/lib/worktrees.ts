// Git worktrees for parallel agent tasks, served by Rust commands. A task can run in its
// own worktree; when it is done, its changes are applied to the project folder as
// uncommitted changes. Outside Tauri (plain browser preview) every call resolves with
// in-memory demo data.

import { invoke, isTauri } from "@tauri-apps/api/core";

export type WorktreeInfo = {
  /** Folder to work in: the worktree root, or the matching subfolder right after creation. */
  path: string;
  /** Top folder of the worktree. */
  root: string;
  /** Branch `octopus/<slug>`. */
  branch: string;
  /** Commit the worktree started from. */
  base: string;
  head: string;
  /** Files that differ from `base`: committed, uncommitted and untracked. */
  changedFiles: number;
  /** Creation time, ms since the epoch. */
  createdAt: number;
};

export type ApplyResult = {
  /** Every path the worktree changed. */
  files: string[];
  /** Paths that did not merge cleanly. Text conflicts keep markers in the project file. */
  conflicts: string[];
};

const DEMO_DELAY_MS = 400;

function demoDelay<T>(value: T): Promise<T> {
  return new Promise((resolve) => window.setTimeout(() => resolve(value), DEMO_DELAY_MS));
}

/** Creates a worktree of the repository at `cwd`, optionally named after `name`. */
export function createWorktree(cwd: string, name?: string): Promise<WorktreeInfo> {
  if (!isTauri()) return demoDelay(demoCreate(name));
  return invoke<WorktreeInfo>("worktree_create", { cwd, name: name ?? null });
}

/** Octopus worktrees of the repository at `cwd`. */
export function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  if (!isTauri()) return demoDelay([...demoWorktrees]);
  return invoke<WorktreeInfo[]>("worktree_list", { cwd });
}

/** Brings the changes of the worktree at `path` into the project folder as uncommitted changes. */
export function applyWorktree(cwd: string, path: string): Promise<ApplyResult> {
  if (!isTauri()) return demoDelay({ files: ["src/pages/pricing.tsx"], conflicts: [] });
  return invoke<ApplyResult>("worktree_apply", { cwd, path });
}

/** Removes the worktree at `path`, and its branch unless `deleteBranch` is false. */
export function removeWorktree(cwd: string, path: string, deleteBranch = true): Promise<void> {
  if (!isTauri()) {
    demoWorktrees = demoWorktrees.filter((w) => w.path !== path && w.root !== path);
    return demoDelay(undefined);
  }
  return invoke<void>("worktree_remove", { cwd, path, deleteBranch });
}

// ---------- demo data (browser preview) ----------

let demoWorktrees: WorktreeInfo[] = [];

function demoCreate(name?: string): WorktreeInfo {
  const stem = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const hex = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  const slug = stem ? `${stem}-${hex}` : `task-${hex}`;
  const root = `/demo/worktrees/${slug}`;
  const info: WorktreeInfo = {
    path: root,
    root,
    branch: `octopus/${slug}`,
    base: "abc1234",
    head: "abc1234",
    changedFiles: 0,
    createdAt: Date.now(),
  };
  demoWorktrees = [...demoWorktrees, info];
  return info;
}
