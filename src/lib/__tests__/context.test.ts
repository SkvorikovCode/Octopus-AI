import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Mod = typeof import("../context");

const KEY = "octopus.pinned";

// The store keeps its state in module scope, so each test loads a fresh copy.
async function load(): Promise<Mod> {
  vi.resetModules();
  return import("../context");
}

let ctx: Mod;

beforeEach(async () => {
  localStorage.clear();
  ctx = await load();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getPinned", () => {
  it("returns nothing for a missing or empty session key", () => {
    expect(ctx.getPinned(undefined)).toEqual([]);
    expect(ctx.getPinned("")).toEqual([]);
  });

  it("returns an empty list for a session with no pins, the same array each time", () => {
    const a = ctx.getPinned("s1");
    expect(a).toEqual([]);
    expect(ctx.getPinned("s1")).toBe(a);
  });

  it("returns an empty list for keys that match Object.prototype members", () => {
    expect(ctx.getPinned("toString")).toEqual([]);
    expect(ctx.getPinned("constructor")).toEqual([]);
  });
});

describe("setPinned", () => {
  it("stores paths for one session", () => {
    ctx.setPinned("s1", ["src/a.ts", "src/b.ts"]);
    expect(ctx.getPinned("s1")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("trims paths and drops blank ones", () => {
    ctx.setPinned("s1", ["  src/a.ts ", "", "   ", "src/b.ts"]);
    expect(ctx.getPinned("s1")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("removes duplicates and keeps the first occurrence order", () => {
    ctx.setPinned("s1", ["a", "b", "a", "c", "b"]);
    expect(ctx.getPinned("s1")).toEqual(["a", "b", "c"]);
  });

  it("treats paths that differ only by surrounding spaces as duplicates", () => {
    ctx.setPinned("s1", [" a", "a "]);
    expect(ctx.getPinned("s1")).toEqual(["a"]);
  });

  it("caps a session at 20 paths and keeps the first 20", () => {
    const paths = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    ctx.setPinned("s1", paths);
    const got = ctx.getPinned("s1");
    expect(got).toHaveLength(ctx.MAX_PINNED);
    expect(got[0]).toBe("f0.ts");
    expect(got[got.length - 1]).toBe("f19.ts");
  });

  it("replaces the list instead of merging", () => {
    ctx.setPinned("s1", ["a"]);
    ctx.setPinned("s1", ["b"]);
    expect(ctx.getPinned("s1")).toEqual(["b"]);
  });

  it("an empty list removes the session from storage", () => {
    ctx.setPinned("s1", ["a"]);
    ctx.setPinned("s1", []);
    expect(ctx.getPinned("s1")).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({});
  });

  it("a list of only blanks also removes the session", () => {
    ctx.setPinned("s1", ["a"]);
    ctx.setPinned("s1", ["  ", ""]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({});
  });

  it("keeps sessions isolated from each other", () => {
    ctx.setPinned("s1", ["a"]);
    expect(ctx.getPinned("s2")).toEqual([]);
  });

  it("does not change the array returned earlier for another session", () => {
    ctx.setPinned("s1", ["a"]);
    const s1 = ctx.getPinned("s1");
    ctx.setPinned("s2", ["x"]);
    expect(ctx.getPinned("s1")).toBe(s1);
    expect(s1).toEqual(["a"]);
  });

  it("does not mutate the caller's input array", () => {
    const input = ["  a ", "a"];
    ctx.setPinned("s1", input);
    expect(input).toEqual(["  a ", "a"]);
  });

  it("keeps at most 300 sessions and drops the least recently changed", () => {
    for (let i = 0; i < 300; i++) ctx.setPinned(`s${i}`, ["f"]);
    // Touching s0 moves it to the most recent position.
    ctx.setPinned("s0", ["g"]);
    ctx.setPinned("s300", ["f"]);

    expect(ctx.getPinned("s1")).toEqual([]);
    expect(ctx.getPinned("s0")).toEqual(["g"]);
    expect(ctx.getPinned("s300")).toEqual(["f"]);
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY) ?? "{}"))).toHaveLength(300);
  });
});

describe("usePinned", () => {
  it("re-renders the component when the session's pins change", async () => {
    vi.resetModules();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const mod = await import("../context");

    const seen: string[][] = [];
    function Probe() {
      seen.push(mod.usePinned("s1"));
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => mod.setPinned("s1", ["a.ts"]));
    await act(async () => mod.setPinned("s2", ["other.ts"]));

    expect(seen[seen.length - 1]).toEqual(["a.ts"]);

    await act(async () => root.unmount());
    container.remove();
  });
});

describe("persistence", () => {
  it("writes the store to localStorage under octopus.pinned", () => {
    ctx.setPinned("s1", ["a", "b"]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ s1: ["a", "b"] });
  });

  it("restores pins after a reload", async () => {
    ctx.setPinned("s1", ["a", "b"]);
    ctx.setPinned("s2", ["c"]);
    const fresh = await load();
    expect(fresh.getPinned("s1")).toEqual(["a", "b"]);
    expect(fresh.getPinned("s2")).toEqual(["c"]);
  });

  it.each(["{not json", "null", "42", '"text"', '["a.ts"]'])(
    "starts with nothing pinned when storage holds %s",
    async (raw) => {
      localStorage.setItem(KEY, raw);
      const fresh = await load();
      expect(fresh.getPinned("s1")).toEqual([]);
    },
  );

  it("skips entries that are not arrays and filters bad items inside arrays", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ s1: "a.ts", s2: ["ok.ts", 3, "", null], s3: [] }),
    );
    const fresh = await load();
    expect(fresh.getPinned("s1")).toEqual([]);
    expect(fresh.getPinned("s2")).toEqual(["ok.ts"]);
    expect(fresh.getPinned("s3")).toEqual([]);
  });

  it("caps stored pins per session at 20 when loading", async () => {
    const paths = Array.from({ length: 50 }, (_, i) => `f${i}`);
    localStorage.setItem(KEY, JSON.stringify({ s1: paths }));
    const fresh = await load();
    expect(fresh.getPinned("s1")).toHaveLength(fresh.MAX_PINNED);
  });

  it("keeps working in memory when localStorage writes throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => ctx.setPinned("s1", ["a"])).not.toThrow();
    expect(ctx.getPinned("s1")).toEqual(["a"]);
  });

  it("starts empty when localStorage reads throw", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const fresh = await load();
    expect(fresh.getPinned("s1")).toEqual([]);
  });
});
