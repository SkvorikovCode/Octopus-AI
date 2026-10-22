import { describe, expect, it } from "vitest";
import { statusSnapshot, type RuntimeView } from "../status";

const base: RuntimeView = { status: "idle", unread: false };

describe("statusSnapshot", () => {
  it("puts agents waiting for an answer first, then working ones, and counts them", () => {
    const snap = statusSnapshot([
      { ...base, sessionId: "a", status: "idle", unread: true },
      { ...base, sessionId: "b", status: "thinking", turnStartedAt: 100 },
      { ...base, sessionId: "c", status: "waiting", turnStartedAt: 200 },
      { ...base, sessionId: "d", status: "working", turnStartedAt: 300 },
    ]);
    expect(snap.agents.map((a) => [a.sessionId, a.status])).toEqual([
      ["c", "waiting"],
      ["b", "working"],
      ["d", "working"],
      ["a", "idle"],
    ]);
    expect(snap.counts).toEqual({ working: 2, waiting: 1, unread: 1 });
  });

  it("names the agent by its title or its task, and its project by the worktree's origin", () => {
    const [named, tasked] = statusSnapshot([
      { ...base, title: "Fix login", goal: "ignored", cwd: "/p" },
      { ...base, goal: "  Write   the docs\nfor X ", cwd: "/copies/x", worktree: { root: "/p", branch: "octopus/x" } },
    ]).agents;
    expect(named).toMatchObject({ title: "Fix login", project: "/p", branch: undefined });
    expect(tasked).toMatchObject({ title: "Write the docs for X", project: "/p", branch: "octopus/x" });
  });

  it("clips long titles and keeps the turn start only while the agent is busy", () => {
    const [busy, idle] = statusSnapshot([
      { ...base, status: "working", goal: "x".repeat(200), turnStartedAt: 5 },
      { ...base, status: "idle", turnStartedAt: 5 },
    ]).agents;
    expect(busy.title).toHaveLength(80);
    expect(busy.title?.endsWith("…")).toBe(true);
    expect(busy.since).toBe(5);
    expect(idle.since).toBeUndefined();
  });
});
