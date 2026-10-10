import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));
vi.mock("../stats", () => ({
  loadUsage: vi.fn(),
}));

import { budgetState, MAX_LIMIT, paidSpend, parseLimit, setFlatRateProviders, spendToday, todaySpend } from "../budget";
import { loadUsage, type UsageStats } from "../stats";

const DAY_KEY = "octopus.budget.overDay";
const SESSION_KEY = "octopus.budget.overSessions";

describe("budgetState", () => {
  it("is ok with no scope and zero spend when no limit is set", () => {
    expect(budgetState({ daySpent: 50, sessionSpent: 50, daily: null, session: null })).toEqual({
      level: "ok",
      spent: 0,
      limit: 0,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("ignores a %s limit on both scopes", (_label, limit) => {
    const s = budgetState({ daySpent: 100, sessionSpent: 100, daily: limit, session: limit });
    expect(s.level).toBe("ok");
    expect(s.scope).toBeUndefined();
  });

  it("is ok below the 80% warning threshold", () => {
    expect(budgetState({ daySpent: 7.99, sessionSpent: 0, daily: 10, session: null })).toEqual({
      level: "ok",
      scope: "day",
      spent: 7.99,
      limit: 10,
    });
  });

  it("warns at exactly 80%", () => {
    expect(budgetState({ daySpent: 8, sessionSpent: 0, daily: 10, session: null })).toMatchObject({
      level: "warn",
      scope: "day",
    });
  });

  it("stays warn just under 100%", () => {
    expect(budgetState({ daySpent: 9.99, sessionSpent: 0, daily: 10, session: null }).level).toBe("warn");
  });

  it("is over at exactly 100%", () => {
    expect(budgetState({ daySpent: 10, sessionSpent: 0, daily: 10, session: null })).toMatchObject({
      level: "over",
      scope: "day",
      spent: 10,
      limit: 10,
    });
  });

  it("is over above the limit and reports the real spend", () => {
    expect(budgetState({ daySpent: 12.5, sessionSpent: 0, daily: 10, session: null })).toEqual({
      level: "over",
      scope: "day",
      spent: 12.5,
      limit: 10,
    });
  });

  it("uses the session scope when only the session limit is set", () => {
    expect(budgetState({ daySpent: 999, sessionSpent: 9, daily: null, session: 10 })).toEqual({
      level: "warn",
      scope: "session",
      spent: 9,
      limit: 10,
    });
  });

  it("takes the worse level across scopes", () => {
    const s = budgetState({ daySpent: 5, sessionSpent: 12, daily: 10, session: 10 });
    expect(s).toMatchObject({ level: "over", scope: "session", spent: 12 });
  });

  it("prefers the higher ratio when both scopes share a level", () => {
    // day 8/10 = 0.8 (warn), session 9/10 = 0.9 (warn)
    const s = budgetState({ daySpent: 8, sessionSpent: 9, daily: 10, session: 10 });
    expect(s).toMatchObject({ level: "warn", scope: "session", spent: 9 });
  });

  it("breaks a full tie in favour of the day scope", () => {
    // both at exactly 100%
    const s = budgetState({ daySpent: 10, sessionSpent: 20, daily: 10, session: 20 });
    expect(s).toMatchObject({ level: "over", scope: "day" });
  });

  it("treats negative and NaN spend as zero", () => {
    expect(budgetState({ daySpent: -5, sessionSpent: Number.NaN, daily: 10, session: 10 })).toEqual({
      level: "ok",
      scope: "day",
      spent: 0,
      limit: 10,
    });
  });
});

describe("parseLimit", () => {
  it.each(["", "   ", "\t"])("treats %j as off (null)", (raw) => {
    expect(parseLimit(raw)).toEqual({ ok: true, value: null });
  });

  it.each([
    ["10", 10],
    ["0.5", 0.5],
    [".5", 0.5],
    ["5.", 5],
    ["5.5", 5.5],
    ["5,5", 5.5],
    [" 1 000,50 ", 1000.5],
    ["1 000", 1000],
    ["00012", 12],
    [String(MAX_LIMIT), MAX_LIMIT],
  ])("parses %j as %d", (raw, value) => {
    expect(parseLimit(raw)).toEqual({ ok: true, value });
  });

  it.each([
    "0",
    "0.0",
    "0,0",
    "-1",
    "-0.5",
    "abc",
    "12abc",
    "$5",
    "1e3",
    "NaN",
    "Infinity",
    ".",
    "1.2.3",
    "1,2,3",
    "10,000.5",
    String(MAX_LIMIT + 1),
    "10000.01",
  ])("rejects %j", (raw) => {
    expect(parseLimit(raw)).toEqual({ ok: false });
  });
});

describe("todaySpend", () => {
  beforeEach(() => {
    vi.mocked(loadUsage).mockReset();
  });

  it("returns the total cost of the last day", async () => {
    vi.mocked(loadUsage).mockResolvedValueOnce({ totalCost: 4.2 } as never);
    await expect(todaySpend()).resolves.toBe(4.2);
    expect(loadUsage).toHaveBeenCalledWith(1);
  });

  it("counts a failed usage load as zero", async () => {
    vi.mocked(loadUsage).mockRejectedValueOnce(new Error("boom"));
    await expect(todaySpend()).resolves.toBe(0);
  });
});

describe("continue-anyway overrides", () => {
  type BudgetModule = typeof import("../budget");
  let b: BudgetModule;

  // The overrides live in module state, so each test gets a fresh module instance.
  async function reload(): Promise<BudgetModule> {
    vi.resetModules();
    return import("../budget");
  }

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 11, 10, 0, 0));
    b = await reload();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has no override by default", () => {
    expect(b.isOverAllowed("day")).toBe(false);
    expect(b.isOverAllowed("session", "s1")).toBe(false);
  });

  it("day override lasts until the local day changes", () => {
    b.allowOverToday();
    expect(b.isOverAllowed("day")).toBe(true);

    vi.setSystemTime(new Date(2026, 9, 11, 23, 59, 59));
    expect(b.isOverAllowed("day")).toBe(true);

    vi.setSystemTime(new Date(2026, 9, 12, 0, 0, 1));
    expect(b.isOverAllowed("day")).toBe(false);
  });

  it("ignores the key argument for the day scope", () => {
    b.allowOverToday();
    expect(b.isOverAllowed("day", "anything")).toBe(true);
  });

  it("session override is per session id", () => {
    b.allowOverSession("s1");
    expect(b.isOverAllowed("session", "s1")).toBe(true);
    expect(b.isOverAllowed("session", "s2")).toBe(false);
    expect(b.isOverAllowed("session")).toBe(false);
  });

  it("session override is not limited to the day it was granted", () => {
    b.allowOverSession("s1");
    vi.setSystemTime(new Date(2026, 9, 14, 9, 0, 0));
    expect(b.isOverAllowed("session", "s1")).toBe(true);
  });

  it("day override does not leak into the session scope", () => {
    b.allowOverToday();
    expect(b.isOverAllowed("session", "x")).toBe(false);
  });

  it("stores overrides in sessionStorage, not localStorage", () => {
    b.allowOverToday();
    b.allowOverSession("s1");
    expect(sessionStorage.getItem(DAY_KEY)).toBe("2026-10-11");
    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null")).toEqual(["s1"]);
    expect(localStorage.length).toBe(0);
  });

  it("overrides survive a reload in the same tab", async () => {
    b.allowOverToday();
    b.allowOverSession("s1");

    const fresh = await reload();
    expect(fresh.isOverAllowed("day")).toBe(true);
    expect(fresh.isOverAllowed("session", "s1")).toBe(true);
    expect(fresh.isOverAllowed("session", "s2")).toBe(false);
  });

  it("a stored day override from a previous day is not restored", async () => {
    b.allowOverToday();
    vi.setSystemTime(new Date(2026, 9, 12, 8, 0, 0));

    const fresh = await reload();
    expect(fresh.isOverAllowed("day")).toBe(false);
  });

  it("corrupted session list is ignored but the day override is still read", async () => {
    sessionStorage.setItem(DAY_KEY, "2026-10-11");
    sessionStorage.setItem(SESSION_KEY, "{bad json");

    const fresh = await reload();
    expect(fresh.isOverAllowed("day")).toBe(true);
    expect(fresh.isOverAllowed("session", "s1")).toBe(false);
  });

  it("keeps overrides in memory when sessionStorage writes throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => b.allowOverToday()).not.toThrow();
    expect(() => b.allowOverSession("s1")).not.toThrow();
    expect(b.isOverAllowed("day")).toBe(true);
    expect(b.isOverAllowed("session", "s1")).toBe(true);
  });

  it("works without stored overrides when sessionStorage reads throw", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const fresh = await reload();
    expect(fresh.isOverAllowed("day")).toBe(false);
    expect(fresh.isOverAllowed("session", "s1")).toBe(false);
  });
});

describe("paidSpend", () => {
  const usage: UsageStats = {
    days: [],
    models: [
      { model: "openai-codex/gpt-5.6-terra", tokens: 1, input: 1, output: 0, cost: 3, requests: 1 },
      { model: "wikivibe/gpt-6-luna", tokens: 1, input: 1, output: 0, cost: 1.5, requests: 1 },
      { model: "gpt-6-luna", tokens: 1, input: 1, output: 0, cost: 0.5, requests: 1 },
    ],
    sessions: [
      {
        path: "/s1.jsonl",
        title: "",
        cwd: "",
        tokens: 1,
        cost: 4,
        requests: 2,
        lastAt: 0,
        costByProvider: { "openai-codex": 3, wikivibe: 1 },
      },
      {
        path: "/s2.jsonl",
        title: "",
        cwd: "",
        tokens: 1,
        cost: 1,
        requests: 1,
        lastAt: 0,
        costByProvider: { wikivibe: 1 },
      },
      { path: "/s3.jsonl", title: "", cwd: "", tokens: 1, cost: 0.5, requests: 1, lastAt: 0 },
    ],
    totalTokens: 3,
    totalCost: 5,
    totalRequests: 3,
    sessionCount: 3,
  };

  it("leaves flat-rate subscription requests out of the day spend", () => {
    const spend = paidSpend(usage, new Set(["openai-codex"]));
    expect(spend.day).toBeCloseTo(2);
    expect(spend.subscriptionBySession).toEqual({ "/s1.jsonl": 3 });
  });

  it("counts everything without subscriptions", () => {
    expect(paidSpend(usage, new Set())).toEqual({ day: 5, subscriptionBySession: {} });
  });

  it("uses the remembered providers by default", async () => {
    vi.mocked(loadUsage).mockResolvedValue(usage);
    setFlatRateProviders(new Set(["openai-codex"]));
    try {
      expect((await spendToday()).day).toBeCloseTo(2);
      expect(await todaySpend()).toBeCloseTo(2);
    } finally {
      setFlatRateProviders(new Set());
    }
  });
});
