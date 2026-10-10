// File checkpoints of the project folder: a snapshot taken before each agent task,
// restored later to rewind files. Served by Rust commands. Outside Tauri (plain
// browser preview) every call returns scripted demo data.

import { invoke, isTauri } from "@tauri-apps/api/core";

export type CheckpointChange = { path: string; kind: "modified" | "added" | "deleted" };

/**
 * Snapshots the project folder. Resolves the checkpoint id, or null when `cwd`
 * is not inside a git repository.
 */
export function createCheckpoint(cwd: string): Promise<string | null> {
  if (!isTauri()) return Promise.resolve("demo-checkpoint");
  return invoke<string | null>("checkpoint_create", { cwd });
}

/** Files whose current state differs from the checkpoint. */
export function checkpointChanges(cwd: string, id: string): Promise<CheckpointChange[]> {
  if (!isTauri()) return Promise.resolve(demoChanges());
  return invoke<CheckpointChange[]>("checkpoint_changes", { cwd, id });
}

/** Restores every changed file to the checkpoint. Resolves the number of files restored. */
export function restoreCheckpoint(cwd: string, id: string): Promise<number> {
  if (!isTauri()) return Promise.resolve(2);
  return invoke<number>("checkpoint_restore", { cwd, id });
}

// ---------- demo data (browser preview) ----------

function demoChanges(): CheckpointChange[] {
  return [
    { path: "src/app.ts", kind: "modified" },
    { path: "notes.md", kind: "added" },
  ];
}
