// Full-text search through the saved sessions of one project (Rust: sessions_search).

import { invoke, isTauri } from "@tauri-apps/api/core";

export type SearchHit = {
  /** Absolute path to the session .jsonl file; pass to omp `switch_session`. */
  path: string;
  sessionId: string;
  title: string;
  role: "user" | "assistant";
  /** Text around the match, with "…" where it was cut. */
  snippet: string;
  /** Char offset of the match inside `snippet`. */
  matchStart: number;
  /** Length of the match in chars. */
  matchLen: number;
  /** Message time, ms since epoch. */
  at: number;
};

const SEARCH_LIMIT = 30;

/** Outside Tauri (plain browser preview): one fake hit per demo session. */
const DEMO_KEYS = ["тест", "оплат", "stripe"];
const DEMO_CORPUS: { path: string; sessionId: string; title: string; role: SearchHit["role"]; text: string; ago: number }[] = [
  {
    path: "/demo/1.jsonl",
    sessionId: "demo-1",
    title: "Починить вход через Google",
    role: "assistant",
    text: "Вход через Google снова работает; оплата в этом проекте не затронута, но тесты стоит прогнать.",
    ago: 2 * 3600e3,
  },
  {
    path: "/demo/2.jsonl",
    sessionId: "demo-2",
    title: "Почему падает сборка",
    role: "user",
    text: "CI падает на шаге build, локально всё собирается. Тесты на CI тоже красные?",
    ago: 26 * 3600e3,
  },
  {
    path: "/demo/3.jsonl",
    sessionId: "demo-3",
    title: "Тёмная тема для лендинга",
    role: "assistant",
    text: "Подключу Stripe и страницу оплаты к лендингу, когда тема будет готова.",
    ago: 6 * 86400e3,
  },
];

/**
 * Searches the conversations of the project `cwd` for `query`, case-insensitively.
 * Resolves newest session first, at most a few hits per session.
 */
export function searchSessions(cwd: string, query: string): Promise<SearchHit[]> {
  if (!isTauri()) return Promise.resolve(demoSearch(query));
  return invoke<SearchHit[]>("sessions_search", { cwd, query, limit: SEARCH_LIMIT });
}

function demoSearch(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  const key = DEMO_KEYS.find((k) => q.includes(k));
  if (!key) return [];
  const now = Date.now();
  const hits: SearchHit[] = [];
  for (const doc of DEMO_CORPUS) {
    const at = doc.text.toLowerCase().indexOf(key);
    if (at < 0) continue;
    hits.push({
      path: doc.path,
      sessionId: doc.sessionId,
      title: doc.title,
      role: doc.role,
      snippet: doc.text,
      matchStart: at,
      matchLen: key.length,
      at: now - doc.ago,
    });
  }
  return hits;
}
