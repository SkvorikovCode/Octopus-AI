// Commit, push and pull-request steps for the project folder, served by Rust commands.
// Outside Tauri (plain browser preview) every call resolves with scripted demo data.

import { invoke, isTauri } from "@tauri-apps/api/core";

export type RepoInfo = {
  /** Null when HEAD is detached. */
  branch: string | null;
  /** Upstream of the current branch, e.g. "origin/main". */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** URL of `origin`, without credentials. */
  remoteUrl: string | null;
  /** `gh` is installed and authenticated. */
  hasGh: boolean;
  defaultBranch: string | null;
};

const DEMO_DELAY_MS = 400;

function demoDelay<T>(value: T): Promise<T> {
  return new Promise((resolve) => window.setTimeout(() => resolve(value), DEMO_DELAY_MS));
}

/** Branch, upstream, ahead/behind and remote facts of the repository at `cwd`. */
export function repoInfo(cwd: string): Promise<RepoInfo> {
  if (!isTauri()) {
    return Promise.resolve({
      branch: "feat/pricing",
      upstream: null,
      ahead: 0,
      behind: 0,
      remoteUrl: "git@github.com:demo/my-app.git",
      hasGh: true,
      defaultBranch: "main",
    });
  }
  return invoke<RepoInfo>("git_repo_info", { cwd });
}

/**
 * Stages `paths` (or every change under `cwd` when omitted) and commits with `message`.
 * Resolves with the short hash of the new commit.
 */
export function commit(cwd: string, message: string, paths?: string[]): Promise<string> {
  if (!isTauri()) return demoDelay("a1b2c3d");
  return invoke<string>("git_commit", { cwd, message, paths: paths ?? null });
}

/** Pushes the current branch; sets the upstream on the first push. */
export function push(cwd: string): Promise<void> {
  if (!isTauri()) return demoDelay(undefined);
  return invoke<void>("git_push", { cwd });
}

/** Opens a pull request with the GitHub CLI and resolves with its URL. */
export function createPr(cwd: string, title: string, body: string, base?: string | null): Promise<string> {
  if (!isTauri()) return demoDelay("https://github.com/demo/my-app/pull/42");
  return invoke<string>("gh_pr_create", { cwd, title, body, base: base ?? null });
}
