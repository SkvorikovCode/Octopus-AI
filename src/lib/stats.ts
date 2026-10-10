// Usage statistics for the Stats screen. Real data comes from the Rust `usage_stats`
// command; outside Tauri (browser preview) a deterministic demo dataset is returned.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { t } from "./i18n";

export type DayStat = {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  tokens: number;
  cost: number;
  requests: number;
};

export type ModelStat = {
  /** provider/model */
  model: string;
  tokens: number;
  input: number;
  output: number;
  cost: number;
  requests: number;
};

export type SessionStat = {
  path: string;
  title: string;
  cwd: string;
  tokens: number;
  cost: number;
  requests: number;
  /** Last activity, ms since epoch. */
  lastAt: number;
};

export type UsageStats = {
  days: DayStat[];
  models: ModelStat[];
  sessions: SessionStat[];
  totalTokens: number;
  totalCost: number;
  totalRequests: number;
  sessionCount: number;
};

/** Usage for the last `days` days, optionally limited to one project folder. */
export function loadUsage(days: number, cwd?: string): Promise<UsageStats> {
  if (!isTauri()) return Promise.resolve(demoUsage(days, cwd));
  return invoke<UsageStats>("usage_stats", { days, cwd: cwd ?? null });
}

const DAY_MS = 86_400_000;
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** Local calendar day as YYYY-MM-DD. */
export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Short token count: 842, 1.2K, 3.4M, 1.1B. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  const k = n / 1e3;
  if (k < 999.95) return `${trim(k)}K`;
  const m = n / 1e6;
  if (m < 999.95) return `${trim(m)}M`;
  return `${trim(n / 1e9)}B`;
}

/** Dollar amount with two decimals; tiny non-zero amounts shown as a floor. */
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** "10 окт" (ru) or "Oct 10" (en) for a YYYY-MM-DD string. */
export function dayLabel(date: string): string {
  const parts = date.split("-");
  const day = Number(parts[2]);
  const month = t(MONTHS[Number(parts[1]) - 1] ?? "");
  return t("{day} {month}", { day, month }).trim();
}

/** "сегодня", "вчера", "3 дн. назад", or a short date for older activity. */
export function relativeDay(ms: number, now: number = Date.now()): string {
  const a = new Date(ms);
  a.setHours(0, 0, 0, 0);
  const b = new Date(now);
  b.setHours(0, 0, 0, 0);
  const diff = Math.round((b.getTime() - a.getTime()) / DAY_MS);
  if (diff <= 0) return t("сегодня");
  if (diff === 1) return t("вчера");
  if (diff < 7) return t("{n} дн. назад", { n: diff });
  return dayLabel(ymd(a));
}

// ---------- demo data ----------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

const DEMO_PROJECTS = {
  ui: "/Users/dev/code/octopus-ui",
  api: "/Users/dev/code/billing-api",
  site: "/Users/dev/code/landing",
};

// share = fraction of total tokens; price = relative price per token
const DEMO_MODELS = [
  { model: "anthropic/claude-sonnet-4.5", share: 0.44, price: 1.0 },
  { model: "openai/gpt-5", share: 0.26, price: 0.8 },
  { model: "google/gemini-2.5-pro", share: 0.18, price: 0.55 },
  { model: "deepseek/deepseek-v3.1", share: 0.12, price: 0.15 },
];

// w = fraction of total tokens/requests, k = cost multiplier, off = days ago
const DEMO_SESSIONS = [
  { title: "Переписать парсер конфигов", cwd: DEMO_PROJECTS.ui, w: 0.19, k: 1.3, off: 0 },
  { title: "Миграция на новый роутер", cwd: DEMO_PROJECTS.api, w: 0.15, k: 1.1, off: 1 },
  { title: "Тесты для биллинга", cwd: DEMO_PROJECTS.api, w: 0.12, k: 0.9, off: 3 },
  { title: "Адаптивная вёрстка лендинга", cwd: DEMO_PROJECTS.site, w: 0.1, k: 0.7, off: 5 },
  { title: "Исправить утечку в стриме", cwd: DEMO_PROJECTS.ui, w: 0.08, k: 1.2, off: 9 },
  { title: "Обзор зависимостей", cwd: DEMO_PROJECTS.site, w: 0.06, k: 0.6, off: 14 },
];

function demoUsage(days: number, cwd?: string): UsageStats {
  const n = Math.max(1, Math.floor(days));
  const scale = cwd ? 0.42 : 1; // a single project carries a smaller share
  const rand = rng(7919 + n);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayStats: DayStat[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const r1 = rand();
    const r2 = rand();
    const r3 = rand();
    const r4 = rand();
    const growth = 0.7 + (0.6 * (n - 1 - i)) / Math.max(1, n - 1);
    const weekend = d.getDay() === 0 || d.getDay() === 6 ? 0.35 : 1;
    const idle = r1 < 0.12;
    const tokens = idle ? 0 : Math.round((55_000 * growth * weekend * (0.35 + r2 * 1.3) * scale) / 10) * 10;
    const cost = tokens ? round4((tokens / 1e6) * (6 + r3 * 4)) : 0;
    const requests = tokens ? Math.max(1, Math.round(tokens / (1500 + r4 * 2000))) : 0;
    dayStats.push({ date: ymd(d), tokens, cost, requests });
  }

  const totalTokens = dayStats.reduce((s, d) => s + d.tokens, 0);
  const totalCost = round4(dayStats.reduce((s, d) => s + d.cost, 0));
  const totalRequests = dayStats.reduce((s, d) => s + d.requests, 0);

  const weightSum = DEMO_MODELS.reduce((s, m) => s + m.share * m.price, 0);
  let tokensLeft = totalTokens;
  let requestsLeft = totalRequests;
  const models: ModelStat[] = DEMO_MODELS.map((spec, idx) => {
    const last = idx === DEMO_MODELS.length - 1;
    const tokens = last ? tokensLeft : Math.round(totalTokens * spec.share);
    const requests = last ? requestsLeft : Math.round(totalRequests * spec.share);
    tokensLeft -= tokens;
    requestsLeft -= requests;
    const input = Math.round(tokens * 0.84);
    return {
      model: spec.model,
      tokens,
      input,
      output: tokens - input,
      cost: round4((totalCost * spec.share * spec.price) / weightSum),
      requests,
    };
  }).sort((a, b) => b.cost - a.cost);

  const pool = cwd ? DEMO_SESSIONS.slice(0, 4).map((s) => ({ ...s, cwd })) : DEMO_SESSIONS;
  const now = Date.now();
  const sessions: SessionStat[] = pool.map((s, i) => ({
    path: `/demo/sessions/${i + 1}.jsonl`,
    title: s.title,
    cwd: s.cwd,
    tokens: Math.round(totalTokens * s.w),
    cost: round4(totalCost * s.w * s.k),
    requests: Math.round(totalRequests * s.w),
    lastAt: now - Math.min(s.off, n - 1) * DAY_MS - (i * 53 + 12) * 60_000,
  }));

  return {
    days: dayStats,
    models,
    sessions,
    totalTokens,
    totalCost,
    totalRequests,
    sessionCount: Math.max(sessions.length, Math.round(n * 0.45 * (cwd ? 0.4 : 1)) + 3),
  };
}
