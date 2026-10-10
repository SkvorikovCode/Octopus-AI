import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ isTauri: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: tauri.isTauri, invoke: tauri.invoke }));

import { updateSettings } from "../settings";
import { dayLabel, formatCost, formatTokens, loadUsage, relativeDay, ymd, type UsageStats } from "../stats";

const DAY_MS = 86_400_000;

function setLang(language: "en" | "ru") {
  updateSettings({ language });
}

beforeEach(() => {
  tauri.isTauri.mockReturnValue(false);
  tauri.invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatTokens", () => {
  it("shows zero for empty, negative, or non-finite input", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });

  it("shows counts below 1000 as whole numbers", () => {
    expect(formatTokens(842)).toBe("842");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(0.4)).toBe("0");
  });

  it("switches to K with at most one decimal and no trailing .0", () => {
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(2000)).toBe("2K");
    expect(formatTokens(999_949)).toBe("999.9K");
  });

  it("rolls over to M at the rounding boundary instead of printing 1000K", () => {
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  it("rolls over to B at the rounding boundary instead of printing 1000M", () => {
    expect(formatTokens(999_960_000)).toBe("1B");
    expect(formatTokens(1_100_000_000)).toBe("1.1B");
    expect(formatTokens(1e12)).toBe("1000B");
  });
});

describe("formatCost", () => {
  it("shows zero, NaN, and infinity as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(Number.NaN)).toBe("$0.00");
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });

  it("shows tiny non-zero amounts as a floor", () => {
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.0001)).toBe("<$0.01");
  });

  it("uses two decimals from one cent up", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(1234.5)).toBe("$1234.50");
  });
});

describe("ymd", () => {
  it("formats the local calendar day with zero padding", () => {
    expect(ymd(new Date(2026, 0, 5, 9, 30))).toBe("2026-01-05");
    expect(ymd(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });
});

describe("dayLabel", () => {
  it("formats day and month in English", () => {
    setLang("en");
    expect(dayLabel("2026-10-10")).toBe("Oct 10");
    expect(dayLabel("2026-01-05")).toBe("Jan 5");
  });

  it("formats day and month in Russian", () => {
    setLang("ru");
    expect(dayLabel("2026-10-10")).toBe("10 окт");
    expect(dayLabel("2026-05-01")).toBe("1 мая");
  });

  it("drops the month when the month number is out of range", () => {
    setLang("en");
    expect(dayLabel("2026-13-10")).toBe("10");
  });
});

describe("relativeDay", () => {
  // Monday, 11 October 2026, 15:00 local time.
  const now = new Date(2026, 9, 11, 15, 0).getTime();

  it("says today for any time on the same local day, including later times", () => {
    setLang("en");
    expect(relativeDay(new Date(2026, 9, 11, 0, 5).getTime(), now)).toBe("today");
    expect(relativeDay(new Date(2026, 9, 11, 23, 59).getTime(), now)).toBe("today");
  });

  it("treats a timestamp in the future as today", () => {
    setLang("en");
    expect(relativeDay(new Date(2026, 9, 12, 8).getTime(), now)).toBe("today");
  });

  it("says yesterday for the previous calendar day", () => {
    setLang("en");
    expect(relativeDay(new Date(2026, 9, 10, 22).getTime(), now)).toBe("yesterday");
  });

  it("counts days for the last six days", () => {
    setLang("en");
    expect(relativeDay(new Date(2026, 9, 8, 12).getTime(), now)).toBe("3 days ago");
    expect(relativeDay(new Date(2026, 9, 5).getTime(), now)).toBe("6 days ago");
  });

  it("switches to a short date from seven days ago", () => {
    setLang("en");
    expect(relativeDay(new Date(2026, 9, 4, 9).getTime(), now)).toBe("Oct 4");
  });

  it("uses Russian wording", () => {
    setLang("ru");
    expect(relativeDay(new Date(2026, 9, 11, 1).getTime(), now)).toBe("сегодня");
    expect(relativeDay(new Date(2026, 9, 10, 1).getTime(), now)).toBe("вчера");
    expect(relativeDay(new Date(2026, 9, 8, 1).getTime(), now)).toBe("3 дн. назад");
    expect(relativeDay(new Date(2026, 9, 4, 1).getTime(), now)).toBe("4 окт");
  });

  it("uses the wall clock when `now` is omitted", () => {
    setLang("en");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    expect(relativeDay(new Date(2026, 9, 10, 12).getTime())).toBe("yesterday");
  });
});

describe("loadUsage outside Tauri (demo data)", () => {
  beforeEach(() => {
    setLang("en");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 11, 12, 0));
  });

  it("does not call invoke", async () => {
    await loadUsage(7);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("returns one entry per day, oldest first, ending today", async () => {
    const u = await loadUsage(7);
    expect(u.days.map((d) => d.date)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
  });

  it("clamps the day count to at least one and floors fractions", async () => {
    expect((await loadUsage(0)).days).toHaveLength(1);
    expect((await loadUsage(-3)).days).toHaveLength(1);
    expect((await loadUsage(2.9)).days).toHaveLength(2);
  });

  it("is deterministic for the same input", async () => {
    expect(await loadUsage(30)).toEqual(await loadUsage(30));
  });

  it("keeps day totals consistent with the top-level totals", async () => {
    const u = await loadUsage(30);
    expect(u.totalTokens).toBe(u.days.reduce((s, d) => s + d.tokens, 0));
    expect(u.totalRequests).toBe(u.days.reduce((s, d) => s + d.requests, 0));
    expect(u.totalCost).toBeCloseTo(u.days.reduce((s, d) => s + d.cost, 0), 3);
  });

  it("has no usage on idle days, and cost and requests follow tokens", async () => {
    const u = await loadUsage(30);
    for (const d of u.days) {
      if (d.tokens === 0) {
        expect(d.cost).toBe(0);
        expect(d.requests).toBe(0);
      } else {
        expect(d.requests).toBeGreaterThanOrEqual(1);
        expect(d.cost).toBeGreaterThan(0);
      }
    }
  });

  it("splits model tokens and requests exactly across the total", async () => {
    const u = await loadUsage(30);
    expect(u.models.reduce((s, m) => s + m.tokens, 0)).toBe(u.totalTokens);
    expect(u.models.reduce((s, m) => s + m.requests, 0)).toBe(u.totalRequests);
    for (const m of u.models) {
      expect(m.input).toBeLessThanOrEqual(m.tokens);
    }
  });

  it("lists the four demo models sorted by cost, descending", async () => {
    const u = await loadUsage(30);
    expect(u.models.map((m) => m.model).sort()).toEqual([
      "anthropic/claude-sonnet-4.5",
      "deepseek/deepseek-v3.1",
      "google/gemini-2.5-pro",
      "openai/gpt-5",
    ]);
    const costs = u.models.map((m) => m.cost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });

  it("allocates model costs that add up to the total within rounding", async () => {
    const u = await loadUsage(30);
    expect(Math.abs(u.models.reduce((s, m) => s + m.cost, 0) - u.totalCost)).toBeLessThan(0.001);
  });

  it("returns six demo sessions across the whole account, each with a recent timestamp", async () => {
    const u = await loadUsage(30);
    expect(u.sessions).toHaveLength(6);
    const now = Date.now();
    for (const s of u.sessions) {
      expect(s.lastAt).toBeLessThanOrEqual(now);
      expect(s.lastAt).toBeGreaterThan(now - 31 * DAY_MS);
    }
  });

  it("computes the session count from the period length", async () => {
    // round(30 * 0.45) = 14, plus 3 = 17, which is above the six demo sessions.
    expect((await loadUsage(30)).sessionCount).toBe(17);
  });

  it("limits to one project: four sessions in that folder and a smaller total", async () => {
    const all = await loadUsage(30);
    const one = await loadUsage(30, "/Users/dev/code/landing");
    expect(one.sessions).toHaveLength(4);
    expect(one.sessions.every((s) => s.cwd === "/Users/dev/code/landing")).toBe(true);
    expect(one.totalTokens).toBeLessThan(all.totalTokens);
    expect(one.totalTokens / all.totalTokens).toBeGreaterThan(0.38);
    expect(one.totalTokens / all.totalTokens).toBeLessThan(0.46);
    expect(one.sessionCount).toBe(8);
  });

  it("treats an omitted project as no filter", async () => {
    expect(await loadUsage(30, undefined)).toEqual(await loadUsage(30));
  });
});

describe("loadUsage inside Tauri", () => {
  it("invokes usage_stats with days and a null cwd when none is given", async () => {
    tauri.isTauri.mockReturnValue(true);
    const fake: UsageStats = {
      days: [],
      models: [],
      sessions: [],
      totalTokens: 0,
      totalCost: 0,
      totalRequests: 0,
      sessionCount: 0,
    };
    tauri.invoke.mockResolvedValue(fake);

    const result = await loadUsage(14);

    expect(tauri.invoke).toHaveBeenCalledWith("usage_stats", { days: 14, cwd: null });
    expect(result).toBe(fake);
  });

  it("passes the project folder through unchanged", async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockResolvedValue({ days: [], models: [], sessions: [], totalTokens: 0, totalCost: 0, totalRequests: 0, sessionCount: 0 });

    await loadUsage(7, "/work/app");

    expect(tauri.invoke).toHaveBeenCalledWith("usage_stats", { days: 7, cwd: "/work/app" });
  });

  it("returns the backend data without transforming it", async () => {
    tauri.isTauri.mockReturnValue(true);
    const payload: UsageStats = {
      days: [{ date: "2026-10-11", tokens: 1234, cost: 0.5, requests: 2 }],
      models: [{ model: "openai/gpt-5", tokens: 1234, input: 1000, output: 234, cost: 0.5, requests: 2 }],
      sessions: [{ path: "/s.jsonl", title: "T", cwd: "/c", tokens: 1234, cost: 0.5, requests: 2, lastAt: 42 }],
      totalTokens: 1234,
      totalCost: 0.5,
      totalRequests: 2,
      sessionCount: 1,
    };
    tauri.invoke.mockResolvedValue(payload);

    expect(await loadUsage(1)).toEqual(payload);
  });

  it("propagates backend errors", async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockRejectedValue(new Error("db locked"));
    await expect(loadUsage(7)).rejects.toThrow("db locked");
  });
});
