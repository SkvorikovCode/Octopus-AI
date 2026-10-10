// Saved omp sessions (JSONL files under ~/.omp/agent/sessions), listed by Rust.

import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export type SessionMeta = {
  /** Absolute path to the session .jsonl file; pass to omp `switch_session`. */
  path: string;
  id: string;
  title: string;
  cwd: string;
  /** File modification time, ms since epoch. */
  updatedAt: number;
  /** First user message, trimmed — fallback when there is no title. */
  preview?: string;
};

export function listSessions(cwd?: string): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("sessions_list", { cwd: cwd ?? null });
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("сейчас");
  if (min < 60) return t("{n}м", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("{n}ч", { n: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t("{n}д", { n: d });
  return t("{n}н", { n: Math.floor(d / 7) });
}
