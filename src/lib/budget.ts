// Spending limits: pure state logic, today's spend, and "continue anyway" overrides.

import { loadUsage, type UsageStats } from "./stats";

export type BudgetState = {
  level: "ok" | "warn" | "over";
  /** Scope that drives the state; undefined when no limit is set. */
  scope?: "day" | "session";
  spent: number;
  limit: number;
};

/** Share of the limit at which the warning shows. */
export const WARN_RATIO = 0.8;
/** Share of the limit at which spending is over budget. */
export const OVER_RATIO = 1;
/** Largest limit the settings accept, USD. */
export const MAX_LIMIT = 10_000;

const LEVEL_RANK = { ok: 0, warn: 1, over: 2 } as const;

function usable(limit: number | null): limit is number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

/**
 * Worst of the day and session scopes. A scope without a limit (null, or not
 * a positive number) is ignored. On equal level the scope with the higher
 * share of its limit wins; on a full tie the day scope wins.
 */
export function budgetState(opts: {
  daySpent: number;
  sessionSpent: number;
  daily: number | null;
  session: number | null;
}): BudgetState {
  const candidates: { scope: "day" | "session"; spent: number; limit: number; level: BudgetState["level"]; ratio: number }[] = [];

  const add = (scope: "day" | "session", spent: number, limit: number | null) => {
    if (!usable(limit)) return;
    const s = Number.isFinite(spent) && spent > 0 ? spent : 0;
    const ratio = s / limit;
    const level: BudgetState["level"] = ratio >= OVER_RATIO ? "over" : ratio >= WARN_RATIO ? "warn" : "ok";
    candidates.push({ scope, spent: s, limit, level, ratio });
  };

  add("day", opts.daySpent, opts.daily);
  add("session", opts.sessionSpent, opts.session);

  if (candidates.length === 0) return { level: "ok", spent: 0, limit: 0 };

  let worst = candidates[0];
  for (const c of candidates.slice(1)) {
    const rank = LEVEL_RANK[c.level] - LEVEL_RANK[worst.level];
    if (rank > 0 || (rank === 0 && c.ratio > worst.ratio)) worst = c;
  }
  return { level: worst.level, scope: worst.scope, spent: worst.spent, limit: worst.limit };
}

export type Spend = {
  /** Last day's spend across all projects, without flat-rate subscription requests. */
  day: number;
  /** Per session file path: the part of its last day's cost covered by subscriptions. */
  subscriptionBySession: Record<string, number>;
};

const providerOf = (model: string) =>
  model.includes("/") ? model.slice(0, model.indexOf("/")) : "";

/** Splits usage into what the budget counts. `flat`: provider ids on a flat-rate plan. */
export function paidSpend(usage: UsageStats, flat: ReadonlySet<string>): Spend {
  const covered = (usage.models ?? []).filter((m) => flat.has(providerOf(m.model))).reduce((sum, m) => sum + m.cost, 0);
  const subscriptionBySession: Record<string, number> = {};
  for (const s of usage.sessions ?? []) {
    const part = Object.entries(s.costByProvider ?? {})
      .filter(([provider]) => flat.has(provider))
      .reduce((sum, [, cost]) => sum + cost, 0);
    if (part > 0) subscriptionBySession[s.path] = part;
  }
  return { day: Math.max(0, usage.totalCost - covered), subscriptionBySession };
}

// Providers on a flat-rate subscription, reported by the running agent.
let flatRate: ReadonlySet<string> = new Set();

/** Remembers which providers' requests a subscription covers (they stay out of the budget). */
export function setFlatRateProviders(ids: ReadonlySet<string>): void {
  flatRate = ids;
}

/** Budget spend for the last day. Errors count as nothing spent. */
export async function spendToday(flat: ReadonlySet<string> = flatRate): Promise<Spend> {
  try {
    return paidSpend(await loadUsage(1), flat);
  } catch {
    return { day: 0, subscriptionBySession: {} };
  }
}

/** Total spend for the last day across all projects. Errors count as 0. */
export async function todaySpend(): Promise<number> {
  return (await spendToday()).day;
}

/**
 * Parses a limit typed in settings. Empty means off (value null). Accepts a comma
 * or a dot as the decimal separator and spaces as group separators. Anything
 * that is not a number in (0, MAX_LIMIT] is invalid.
 */
export function parseLimit(raw: string): { ok: true; value: number | null } | { ok: false } {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return { ok: true, value: null };
  if (!/^\d*\.?\d+$|^\d+\.$/.test(cleaned)) return { ok: false };
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_LIMIT) return { ok: false };
  return { ok: true, value: n };
}

// ---------- "continue anyway" overrides ----------
// Kept in memory and mirrored to sessionStorage so a reload in the same tab keeps them.
// Day override: stores the local date it was granted on. Session override: stores session ids.

const DAY_KEY = "octopus.budget.overDay";
const SESSION_KEY = "octopus.budget.overSessions";

let overDay: string | null = null;
const overSessions = new Set<string>();
let hydrated = false;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    overDay = sessionStorage.getItem(DAY_KEY);
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) for (const id of JSON.parse(raw) as string[]) overSessions.add(id);
  } catch {
    /* storage unavailable: memory only */
  }
}

function persist() {
  try {
    if (overDay) sessionStorage.setItem(DAY_KEY, overDay);
    else sessionStorage.removeItem(DAY_KEY);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify([...overSessions]));
  } catch {
    /* kept in memory for this run */
  }
}

/** Local calendar day as YYYY-MM-DD. */
function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The user chose "continue anyway" on the day limit: allowed until the local day changes. */
export function allowOverToday(): void {
  hydrate();
  overDay = todayKey();
  persist();
}

/** The user chose "continue anyway" on the session limit for this session id. */
export function allowOverSession(sessionId: string): void {
  hydrate();
  overSessions.add(sessionId);
  persist();
}

/**
 * Whether the user already overrode this limit. Day scope: the key is ignored,
 * the override is checked against today. Session scope: the key is the session id.
 */
export function isOverAllowed(scope: "day" | "session", key?: string): boolean {
  hydrate();
  if (scope === "day") return overDay === todayKey();
  return key !== undefined && overSessions.has(key);
}
