import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "../omp";
import { initialSwarm, reduceSwarm, swarmCounts, swarmFromSnapshot, type SwarmState } from "../swarm";

const T0 = 1_000_000;

const life = (payload: Record<string, unknown>): Frame => ({ type: "subagent_lifecycle", payload });
const prog = (payload: Record<string, unknown>): Frame => ({ type: "subagent_progress", payload });

function run(steps: Array<[Frame, number]>, start: SwarmState = initialSwarm): SwarmState {
  return steps.reduce((acc, [frame, now]) => reduceSwarm(acc, frame, now), start);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("reduceSwarm: frame routing", () => {
  it("returns the same state object for unrelated frame types", () => {
    const s = run([[life({ id: "a", status: "started" }), T0]]);
    expect(reduceSwarm(s, { type: "message_update", payload: { id: "a" } }, T0 + 1)).toBe(s);
  });

  it("ignores lifecycle and progress frames without an object payload", () => {
    expect(reduceSwarm(initialSwarm, { type: "subagent_lifecycle" }, T0)).toBe(initialSwarm);
    expect(reduceSwarm(initialSwarm, { type: "subagent_progress", payload: "x" }, T0)).toBe(initialSwarm);
    expect(reduceSwarm(initialSwarm, { type: "subagent_progress", payload: null }, T0)).toBe(initialSwarm);
  });

  it("does not mutate the input state", () => {
    const before = run([[life({ id: "a", index: 0, status: "started" }), T0]]);
    const snapshot = JSON.stringify(before);
    reduceSwarm(before, prog({ id: "a", progress: { currentTool: "bash", toolCount: 4 } }), T0 + 5);
    reduceSwarm(before, life({ id: "a", status: "completed" }), T0 + 9);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("uses the wall clock when `now` is omitted", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const s = reduceSwarm(initialSwarm, life({ id: "a", status: "started" }));
    expect(s.agents.a.startedAt).toBe(T0);
    expect(s.agents.a.updatedAt).toBe(T0);
  });
});

describe("reduceSwarm: lifecycle", () => {
  it("creates a running agent from a started event with defaults", () => {
    const s = reduceSwarm(
      initialSwarm,
      life({ id: "a1", index: 0, agent: "explore", description: "find files", status: "started", sessionFile: "/s/1.jsonl" }),
      T0,
    );
    expect(s.order).toEqual(["a1"]);
    expect(s.agents.a1).toEqual({
      id: "a1",
      index: 0,
      agent: "explore",
      task: "find files",
      status: "running",
      toolCount: 0,
      tokens: 0,
      cost: 0,
      durationMs: 0,
      recentTools: [],
      recentOutput: [],
      sessionFile: "/s/1.jsonl",
      startedAt: T0,
      updatedAt: T0,
    });
    expect(s.log).toEqual([{ t: T0, index: 0, agent: "explore", text: "запущен" }]);
  });

  it("falls back to idx-<index> as the id and 'agent' as the name", () => {
    const s = reduceSwarm(initialSwarm, life({ index: 4, status: "started" }), T0);
    expect(s.order).toEqual(["idx-4"]);
    expect(s.agents["idx-4"].agent).toBe("agent");
    expect(s.agents["idx-4"].index).toBe(4);
  });

  it("treats a numeric id and its string form as the same agent", () => {
    const s = run([
      [life({ id: 7, index: 1, status: "started" }), T0],
      [prog({ id: "7", progress: { toolCount: 2 } }), T0 + 1],
    ]);
    expect(s.order).toEqual(["7"]);
    expect(s.agents["7"].toolCount).toBe(2);
  });

  it("treats a missing or unknown status as running without a log line", () => {
    const missing = reduceSwarm(initialSwarm, life({ id: "a" }), T0);
    expect(missing.agents.a.status).toBe("running");
    expect(missing.log).toEqual([]);

    const unknown = reduceSwarm(initialSwarm, life({ id: "a", status: "weird" }), T0);
    expect(unknown.agents.a.status).toBe("running");
    expect(unknown.log).toEqual([]);
  });

  it("stores a pending status without a log line", () => {
    const s = reduceSwarm(initialSwarm, life({ id: "a", status: "pending" }), T0);
    expect(s.agents.a.status).toBe("pending");
    expect(s.log).toEqual([]);
  });

  it("returns the same state for a duplicate event with identical content", () => {
    const s1 = reduceSwarm(initialSwarm, life({ id: "a", status: "started" }), T0);
    const s2 = reduceSwarm(s1, life({ id: "a", status: "started" }), T0 + 10);
    expect(s2).toBe(s1);
  });

  it("does not log a repeated terminal status", () => {
    const s1 = run([
      [life({ id: "a", status: "started" }), T0],
      [life({ id: "a", status: "completed" }), T0 + 100],
    ]);
    const s2 = reduceSwarm(s1, life({ id: "a", status: "completed" }), T0 + 200);
    expect(s2.log.map((l) => l.text)).toEqual(["запущен", "готово"]);
  });

  it("computes duration on a terminal event and clears the current tool", () => {
    const s = run([
      [life({ id: "a", status: "started" }), T0],
      [prog({ id: "a", progress: { currentTool: "bash" } }), T0 + 500],
      [life({ id: "a", status: "completed" }), T0 + 5000],
    ]);
    expect(s.agents.a.status).toBe("completed");
    expect(s.agents.a.durationMs).toBe(5000);
    expect(s.agents.a.currentTool).toBeUndefined();
    expect(s.log[s.log.length - 1]?.text).toBe("готово");
  });

  it("keeps a larger previously reported duration on a terminal event", () => {
    const s = run([
      [life({ id: "a", status: "started" }), T0],
      [prog({ id: "a", progress: { durationMs: 9000 } }), T0 + 1000],
      [life({ id: "a", status: "completed" }), T0 + 5000],
    ]);
    expect(s.agents.a.durationMs).toBe(9000);
  });

  it("logs failed and aborted with their Russian labels", () => {
    const failed = run([
      [life({ id: "a", status: "started" }), T0],
      [life({ id: "a", status: "failed" }), T0 + 1],
    ]);
    expect(failed.agents.a.status).toBe("failed");
    expect(failed.log[failed.log.length - 1]?.text).toBe("ошибка");

    const aborted = run([
      [life({ id: "b", status: "started" }), T0],
      [life({ id: "b", status: "aborted" }), T0 + 1],
    ]);
    expect(aborted.agents.b.status).toBe("aborted");
    expect(aborted.log[aborted.log.length - 1]?.text).toBe("остановлен");
  });

  it("keeps earlier progress fields and session file when a lifecycle event omits them", () => {
    const s = run([
      [life({ id: "a", status: "started", sessionFile: "/s/a.jsonl", agent: "reviewer", description: "review" }), T0],
      [prog({ id: "a", progress: { toolCount: 3, tokens: 400, cost: 0.2, recentTools: ["read"] } }), T0 + 1],
      [life({ id: "a", status: "completed" }), T0 + 2],
    ]);
    const a = s.agents.a;
    expect(a.toolCount).toBe(3);
    expect(a.tokens).toBe(400);
    expect(a.cost).toBe(0.2);
    expect(a.recentTools).toEqual(["read"]);
    expect(a.sessionFile).toBe("/s/a.jsonl");
    expect(a.agent).toBe("reviewer");
    expect(a.task).toBe("review");
  });

  it("ignores empty strings and falls back to previous values", () => {
    const s = run([
      [life({ id: "a", status: "started", agent: "explore", description: "first" }), T0],
      [life({ id: "a", status: "running", agent: "", description: "" }), T0 + 1],
    ]);
    expect(s.agents.a.agent).toBe("explore");
    expect(s.agents.a.task).toBe("first");
  });

  it("keeps startedAt from the first event", () => {
    const s = run([
      [life({ id: "a", status: "started" }), T0],
      [life({ id: "a", status: "started", description: "x" }), T0 + 999],
    ]);
    expect(s.agents.a.startedAt).toBe(T0);
    expect(s.agents.a.updatedAt).toBe(T0 + 999);
  });

  it("a late started event does not revert a finished agent to running", () => {
    const s = run([
      [life({ id: "a", status: "started" }), T0],
      [life({ id: "a", status: "completed" }), T0 + 10],
      [life({ id: "a", status: "started" }), T0 + 20],
    ]);
    expect(s.agents.a.status).toBe("completed");
  });

  it("inherited Object.prototype keys are not treated as lifecycle labels", () => {
    const s = reduceSwarm(initialSwarm, life({ id: "a", status: "constructor" }), T0);
    expect(s.log).toEqual([]);
  });
});

describe("reduceSwarm: progress", () => {
  it("applies progress fields to an agent created from a lifecycle event", () => {
    const s = run([
      [life({ id: "a1", index: 0, agent: "task", description: "d", status: "started" }), T0],
      [
        prog({
          id: "a1",
          index: 0,
          progress: {
            status: "running",
            currentTool: "read",
            toolCount: 2,
            tokens: { input: 100, output: 50 },
            cost: 0.01,
            durationMs: 1200,
            recentTools: ["read"],
            recentOutput: ["ok"],
          },
        }),
        T0 + 1000,
      ],
    ]);
    expect(s.agents.a1).toMatchObject({
      status: "running",
      toolCount: 2,
      tokens: 150,
      cost: 0.01,
      durationMs: 1200,
      currentTool: "read",
      recentTools: ["read"],
      recentOutput: ["ok"],
      startedAt: T0,
      updatedAt: T0 + 1000,
    });
    expect(s.log.map((l) => l.text)).toEqual(["запущен", "→ read"]);
  });

  it("creates an agent from a progress frame alone", () => {
    const s = reduceSwarm(initialSwarm, prog({ id: "p", index: 2, agent: "explore", task: "scan", progress: { status: "running" } }), T0);
    expect(s.order).toEqual(["p"]);
    expect(s.agents.p).toMatchObject({ index: 2, agent: "explore", task: "scan", status: "running", startedAt: T0 });
  });

  it("reads id, index, and status from the top level when the nested progress omits them", () => {
    const s = reduceSwarm(initialSwarm, prog({ id: "x", index: 3, progress: { status: "pending" } }), T0);
    expect(s.agents.x.index).toBe(3);
    expect(s.agents.x.status).toBe("pending");
  });

  it("reads id and index from the nested progress when the top level omits them", () => {
    const s = reduceSwarm(initialSwarm, prog({ progress: { id: "y", index: 5, status: "running" } }), T0);
    expect(s.order).toEqual(["y"]);
    expect(s.agents.y.index).toBe(5);
  });

  it("does not move a finished agent back to running on a late progress frame", () => {
    const s = run([
      [life({ id: "a", status: "started" }), T0],
      [life({ id: "a", status: "completed" }), T0 + 10],
      [prog({ id: "a", progress: { status: "running", toolCount: 5 } }), T0 + 20],
    ]);
    expect(s.agents.a.status).toBe("completed");
    expect(s.agents.a.toolCount).toBe(5);
  });

  it("does not guard a late progress frame that is also terminal", () => {
    const s = run([
      [life({ id: "a", status: "started" }), T0],
      [life({ id: "a", status: "completed" }), T0 + 10],
      [prog({ id: "a", progress: { status: "failed" } }), T0 + 20],
    ]);
    expect(s.agents.a.status).toBe("failed");
  });

  it("logs a tool line only when the current tool changes", () => {
    const s = run([
      [prog({ id: "a", progress: { currentTool: "bash" } }), T0],
      [prog({ id: "a", progress: { currentTool: "bash", toolCount: 2 } }), T0 + 1],
      [prog({ id: "a", progress: { currentTool: "edit" } }), T0 + 2],
    ]);
    expect(s.log.map((l) => l.text)).toEqual(["→ bash", "→ edit"]);
    expect(s.agents.a.toolCount).toBe(2);
  });

  it("returns the same state for an identical progress frame", () => {
    const s1 = run([[prog({ id: "a", progress: { currentTool: "bash", toolCount: 1 } }), T0]]);
    const s2 = reduceSwarm(s1, prog({ id: "a", progress: { currentTool: "bash", toolCount: 1 } }), T0 + 50);
    expect(s2).toBe(s1);
  });

  it("clears the current tool on an empty string", () => {
    const s = run([
      [prog({ id: "a", progress: { currentTool: "bash" } }), T0],
      [prog({ id: "a", progress: { currentTool: "" } }), T0 + 1],
    ]);
    expect(s.agents.a.currentTool).toBeUndefined();
    expect(s.log.map((l) => l.text)).toEqual(["→ bash"]);
  });

  it("reads token counts from a number, from total, or from the sum of numeric fields", () => {
    const base = (tokens: unknown) =>
      reduceSwarm(initialSwarm, prog({ id: "a", progress: { tokens } }), T0).agents.a.tokens;
    expect(base(321)).toBe(321);
    expect(base({ total: 999, input: 1 })).toBe(999);
    expect(base({ input: 100, output: 50, label: "x" })).toBe(150);
    expect(base("many")).toBe(0);
    expect(base(Number.NaN)).toBe(0);
  });

  it("keeps the previous numeric value when a field is not a finite number", () => {
    const s = run([
      [prog({ id: "a", progress: { toolCount: 4, cost: 1.5, durationMs: 800 } }), T0],
      [prog({ id: "a", progress: { toolCount: "x", cost: Number.POSITIVE_INFINITY, durationMs: null } }), T0 + 1],
    ]);
    expect(s.agents.a).toMatchObject({ toolCount: 4, cost: 1.5, durationMs: 800 });
  });

  it("converts recent tools and output into labels", () => {
    const s = reduceSwarm(
      initialSwarm,
      prog({
        id: "a",
        progress: {
          recentTools: [{ name: "read", tool: "x" }, { tool: "bash" }, { text: "hi" }, { label: "", summary: "sum" }, { zzz: 1 }, 42, null, "plain"],
        },
      }),
      T0,
    );
    expect(s.agents.a.recentTools).toEqual(["read", "bash", "hi", "sum", '{"zzz":1}', "42", "null", "plain"]);
  });

  it("caps a JSON fallback label at 80 characters", () => {
    const s = reduceSwarm(initialSwarm, prog({ id: "a", progress: { recentOutput: [{ data: "x".repeat(200) }] } }), T0);
    const line = s.agents.a.recentOutput[0];
    expect(line.length).toBe(80);
    expect(line.startsWith('{"data":"')).toBe(true);
  });

  it("keeps only the last 12 recent entries", () => {
    const items = Array.from({ length: 15 }, (_, i) => `t${i}`);
    const s = reduceSwarm(initialSwarm, prog({ id: "a", progress: { recentTools: items } }), T0);
    expect(s.agents.a.recentTools).toEqual(items.slice(3));
    expect(s.agents.a.recentTools).toHaveLength(12);
  });

  it("keeps previous recent lists when the new value is not an array", () => {
    const s = run([
      [prog({ id: "a", progress: { recentOutput: ["one"] } }), T0],
      [prog({ id: "a", progress: { recentOutput: "not-an-array" } }), T0 + 1],
    ]);
    expect(s.agents.a.recentOutput).toEqual(["one"]);
  });

  it("takes the assignment from the frame, falling back to the previous one", () => {
    const s = run([
      [prog({ id: "a", progress: { assignment: "part 1" } }), T0],
      [prog({ id: "a", progress: {} }), T0 + 1],
    ]);
    expect(s.agents.a.assignment).toBe("part 1");
  });

  it("limits the log to the last 200 entries", () => {
    const frames: Array<[Frame, number]> = Array.from({ length: 250 }, (_, i) => [
      prog({ id: "a", progress: { currentTool: `tool-${i}` } }),
      T0 + i,
    ]);
    const s = run(frames);
    expect(s.log).toHaveLength(200);
    expect(s.log[0].text).toBe("→ tool-50");
    expect(s.log[s.log.length - 1]?.text).toBe("→ tool-249");
  });

  it("stamps log entries with the event time, index, and agent name", () => {
    const s = run([[prog({ id: "a", index: 6, agent: "writer", progress: { currentTool: "write" } }), T0 + 42]]);
    expect(s.log).toEqual([{ t: T0 + 42, index: 6, agent: "writer", text: "→ write" }]);
  });

  it("a late progress frame does not re-attach a tool to a finished agent", () => {
    const s = run([
      [life({ id: "a", status: "started" }), T0],
      [life({ id: "a", status: "completed" }), T0 + 10],
      [prog({ id: "a", progress: { currentTool: "bash" } }), T0 + 20],
    ]);
    expect(s.agents.a.currentTool).toBeUndefined();
  });
});

describe("reduceSwarm: ordering", () => {
  it("orders agents by index regardless of arrival order", () => {
    const s = run([
      [life({ id: "c", index: 2, status: "started" }), T0],
      [life({ id: "a", index: 0, status: "started" }), T0],
      [life({ id: "b", index: 1, status: "started" }), T0],
    ]);
    expect(s.order).toEqual(["a", "b", "c"]);
  });

  it("keeps insertion order for agents with the same index", () => {
    const s = run([
      [life({ id: "x", index: 5, status: "started" }), T0],
      [life({ id: "y", index: 5, status: "started" }), T0],
    ]);
    expect(s.order).toEqual(["x", "y"]);
  });

  it("does not reorder on updates", () => {
    const s = run([
      [life({ id: "b", index: 1, status: "started" }), T0],
      [life({ id: "a", index: 0, status: "started" }), T0],
      [prog({ id: "b", progress: { toolCount: 9 } }), T0 + 1],
    ]);
    expect(s.order).toEqual(["a", "b"]);
  });

  it("shares unchanged agent objects between states", () => {
    const s1 = run([
      [life({ id: "a", index: 0, status: "started" }), T0],
      [life({ id: "b", index: 1, status: "started" }), T0],
    ]);
    const s2 = reduceSwarm(s1, prog({ id: "b", progress: { toolCount: 1 } }), T0 + 1);
    expect(s2.agents.a).toBe(s1.agents.a);
    expect(s2.agents.b).not.toBe(s1.agents.b);
  });
});

describe("swarmFromSnapshot", () => {
  it("returns the same state for a non-array input", () => {
    const s = run([[life({ id: "a", status: "started" }), T0]]);
    expect(swarmFromSnapshot(s, undefined as unknown as any[])).toBe(s);
    expect(swarmFromSnapshot(s, null as unknown as any[])).toBe(s);
  });

  it("skips entries that are not objects", () => {
    const s = swarmFromSnapshot(initialSwarm, [null, 5, "x", { id: "ok", index: 0 }] as any[], T0);
    expect(s.order).toEqual(["ok"]);
  });

  it("creates agents with no log lines", () => {
    const s = swarmFromSnapshot(initialSwarm, [{ id: "s1", index: 0, agent: "explore", status: "running" }], T0);
    expect(s.agents.s1).toMatchObject({ agent: "explore", status: "running", startedAt: T0, updatedAt: T0 });
    expect(s.log).toEqual([]);
  });

  it("parses ISO timestamps for startedAt and lastUpdate", () => {
    const s = swarmFromSnapshot(
      initialSwarm,
      [{ id: "s1", index: 0, status: "running", startedAt: "2026-10-11T10:00:00Z", lastUpdate: "2026-10-11T10:00:04Z" }],
      T0,
    );
    expect(s.agents.s1.startedAt).toBe(Date.parse("2026-10-11T10:00:00Z"));
    expect(s.agents.s1.updatedAt).toBe(Date.parse("2026-10-11T10:00:04Z"));
  });

  it("falls back to now for an unparsable timestamp", () => {
    const s = swarmFromSnapshot(initialSwarm, [{ id: "s1", index: 0, startedAt: "not a date", lastUpdate: "nope" }], T0);
    expect(s.agents.s1.startedAt).toBe(T0);
    expect(s.agents.s1.updatedAt).toBe(T0);
  });

  it("lets nested progress fields override top-level ones", () => {
    const s = swarmFromSnapshot(
      initialSwarm,
      [{ id: "s2", index: 1, status: "running", description: "build", progress: { status: "completed", toolCount: 9 } }],
      T0,
    );
    expect(s.agents.s2).toMatchObject({ status: "completed", toolCount: 9, task: "build" });
  });

  it("prefers task over description", () => {
    const s = swarmFromSnapshot(initialSwarm, [{ id: "s", index: 0, task: "T", description: "D" }], T0);
    expect(s.agents.s.task).toBe("T");
  });

  it("does not revert a finished agent to running", () => {
    const s1 = swarmFromSnapshot(initialSwarm, [{ id: "a", index: 0, status: "failed" }], T0);
    const s2 = swarmFromSnapshot(s1, [{ id: "a", index: 0, status: "running" }], T0 + 10);
    expect(s2.agents.a.status).toBe("failed");
  });

  it("treats a missing currentTool as cleared, since the snapshot is authoritative", () => {
    const s1 = swarmFromSnapshot(initialSwarm, [{ id: "a", index: 0, currentTool: "grep" }], T0);
    expect(s1.agents.a.currentTool).toBe("grep");
    const s2 = swarmFromSnapshot(s1, [{ id: "a", index: 0, status: "running" }], T0 + 1);
    expect(s2.agents.a.currentTool).toBeUndefined();
  });

  it("keeps previous numeric fields when the snapshot omits them", () => {
    const s1 = swarmFromSnapshot(initialSwarm, [{ id: "a", index: 0, toolCount: 3, tokens: 500, cost: 0.02 }], T0);
    const s2 = swarmFromSnapshot(s1, [{ id: "a", index: 0, status: "running" }], T0 + 1);
    expect(s2.agents.a).toMatchObject({ toolCount: 3, tokens: 500, cost: 0.02 });
  });

  it("reads token totals from an object", () => {
    const s = swarmFromSnapshot(initialSwarm, [{ id: "a", index: 0, tokens: { input: 10, output: 5 } }], T0);
    expect(s.agents.a.tokens).toBe(15);
  });

  it("returns the same state when the snapshot repeats existing content", () => {
    const snap = [{ id: "a", index: 0, status: "running", toolCount: 1 }];
    const s1 = swarmFromSnapshot(initialSwarm, snap, T0);
    const s2 = swarmFromSnapshot(s1, snap, T0 + 500);
    expect(s2).toBe(s1);
  });

  it("orders agents by index", () => {
    const s = swarmFromSnapshot(
      initialSwarm,
      [
        { id: "c", index: 2 },
        { id: "a", index: 0 },
        { id: "b", index: 1 },
      ],
      T0,
    );
    expect(s.order).toEqual(["a", "b", "c"]);
  });

  it("uses the same id fallback as lifecycle events", () => {
    const s = swarmFromSnapshot(initialSwarm, [{ index: 3, status: "running" }], T0);
    expect(s.order).toEqual(["idx-3"]);
  });
});

describe("swarmCounts", () => {
  it("returns zeros for the initial state", () => {
    expect(swarmCounts(initialSwarm)).toEqual({ total: 0, done: 0, running: 0, failed: 0, pending: 0 });
  });

  it("counts agents by status, and counts aborted agents only in the total", () => {
    const s = swarmFromSnapshot(
      initialSwarm,
      [
        { id: "1", index: 0, status: "completed" },
        { id: "2", index: 1, status: "completed" },
        { id: "3", index: 2, status: "running" },
        { id: "4", index: 3, status: "failed" },
        { id: "5", index: 4, status: "pending" },
        { id: "6", index: 5, status: "aborted" },
      ],
      T0,
    );
    expect(swarmCounts(s)).toEqual({ total: 6, done: 2, running: 1, failed: 1, pending: 1 });
  });
});
