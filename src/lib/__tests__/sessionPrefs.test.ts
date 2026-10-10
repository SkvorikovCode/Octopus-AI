import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../sessions";

type Mod = typeof import("../sessionPrefs");

const KEY = "octopus.sessionPrefs";
const EMPTY = { pinned: [], archived: [], names: {} };

// The store keeps its state in module scope, so each test loads a fresh copy.
async function load(): Promise<Mod> {
  vi.resetModules();
  return import("../sessionPrefs");
}

function meta(id: string, title = "Original title"): SessionMeta {
  return { path: `/s/${id}.jsonl`, id, title, cwd: "/p", updatedAt: 0 };
}

let sp: Mod;

beforeEach(async () => {
  localStorage.clear();
  sp = await load();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pin and archive", () => {
  it("pins and unpins a session", () => {
    sp.togglePin("a");
    expect(sp.getSessionPrefs().pinned).toEqual(["a"]);
    sp.togglePin("a");
    expect(sp.getSessionPrefs().pinned).toEqual([]);
  });

  it("keeps pins in pin order and re-pins go to the end", () => {
    sp.togglePin("a");
    sp.togglePin("b");
    sp.togglePin("c");
    sp.togglePin("b");
    expect(sp.getSessionPrefs().pinned).toEqual(["a", "c"]);
    sp.togglePin("b");
    expect(sp.getSessionPrefs().pinned).toEqual(["a", "c", "b"]);
  });

  it("archives and restores a session without touching pins", () => {
    sp.togglePin("a");
    sp.toggleArchive("a");
    expect(sp.getSessionPrefs()).toMatchObject({ pinned: ["a"], archived: ["a"] });
    sp.toggleArchive("a");
    expect(sp.getSessionPrefs()).toMatchObject({ pinned: ["a"], archived: [] });
  });

  it("returns a new snapshot and leaves the old one unchanged", () => {
    const before = sp.getSessionPrefs();
    sp.togglePin("x");
    expect(before.pinned).toEqual([]);
    expect(sp.getSessionPrefs()).not.toBe(before);
  });

  it("caps pins at 500 and keeps the newest", () => {
    for (let i = 0; i <= 500; i++) sp.togglePin(`p${i}`);
    const { pinned } = sp.getSessionPrefs();
    expect(pinned).toHaveLength(sp.MAX_SESSION_PREFS);
    expect(pinned[0]).toBe("p1");
    expect(pinned[pinned.length - 1]).toBe("p500");
  });

  it("caps archived at 500 and keeps the newest", () => {
    for (let i = 0; i <= 500; i++) sp.toggleArchive(`a${i}`);
    const { archived } = sp.getSessionPrefs();
    expect(archived).toHaveLength(sp.MAX_SESSION_PREFS);
    expect(archived[0]).toBe("a1");
  });
});

describe("rename and displayTitle", () => {
  it("stores a trimmed name", () => {
    sp.rename("a", "  Work  ");
    expect(sp.getSessionPrefs().names).toEqual({ a: "Work" });
  });

  it("an empty or blank name removes the override", () => {
    sp.rename("a", "Work");
    sp.rename("a", "   ");
    expect(sp.getSessionPrefs().names).toEqual({});
    sp.rename("a", "Work");
    sp.rename("a", "");
    expect(sp.getSessionPrefs().names).toEqual({});
  });

  it("caps a name at 200 characters", () => {
    sp.rename("a", "x".repeat(250));
    expect(sp.getSessionPrefs().names.a).toHaveLength(200);
  });

  it("renaming one session does not affect others", () => {
    sp.rename("a", "A");
    sp.rename("b", "B");
    sp.rename("a", "A2");
    expect(sp.getSessionPrefs().names).toEqual({ a: "A2", b: "B" });
  });

  it("caps name overrides at 500 and drops the oldest", () => {
    for (let i = 0; i <= 500; i++) sp.rename(`n${i}`, `name ${i}`);
    const names = sp.getSessionPrefs().names;
    expect(Object.keys(names)).toHaveLength(sp.MAX_SESSION_PREFS);
    expect(names).not.toHaveProperty("n0");
    expect(names).toHaveProperty("n500");
  });

  it("shows the custom name when there is one, else the session title", () => {
    sp.rename("a", "Custom");
    const prefs = sp.getSessionPrefs();
    expect(sp.displayTitle(meta("a"), prefs)).toBe("Custom");
    expect(sp.displayTitle(meta("b"), prefs)).toBe("Original title");
  });

  it("does not treat inherited object properties as name overrides", () => {
    const prefs = sp.getSessionPrefs();
    expect(sp.displayTitle(meta("toString", "T"), prefs)).toBe("T");
    expect(sp.displayTitle(meta("constructor", "C"), prefs)).toBe("C");
  });
});

describe("persistence", () => {
  it("writes the whole prefs object to localStorage", () => {
    sp.togglePin("a");
    sp.rename("b", "Bee");
    sp.toggleArchive("c");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
      pinned: ["a"],
      archived: ["c"],
      names: { b: "Bee" },
    });
  });

  it("restores the same prefs after a reload", async () => {
    sp.togglePin("a");
    sp.rename("b", "Bee");
    sp.toggleArchive("c");
    const expected = sp.getSessionPrefs();

    const fresh = await load();
    expect(fresh.getSessionPrefs()).toEqual(expected);
  });

  it("starts empty when storage holds broken JSON, and then overwrites it", async () => {
    localStorage.setItem(KEY, "{not json");
    const fresh = await load();
    expect(fresh.getSessionPrefs()).toEqual(EMPTY);

    fresh.togglePin("a");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toMatchObject({ pinned: ["a"] });
  });

  it.each(["42", "null", '"text"', "true"])("starts empty when storage holds the non-object %s", async (raw) => {
    localStorage.setItem(KEY, raw);
    const fresh = await load();
    expect(fresh.getSessionPrefs()).toEqual(EMPTY);
  });

  it("ignores wrong field types and keeps the rest", async () => {
    localStorage.setItem(KEY, JSON.stringify({ pinned: "abc", archived: { x: 1 }, names: "nope" }));
    const fresh = await load();
    expect(fresh.getSessionPrefs()).toEqual(EMPTY);
  });

  it("sanitizes id lists: drops non-strings and blanks, removes duplicates", async () => {
    localStorage.setItem(KEY, JSON.stringify({ pinned: ["a", 1, null, "", "a", "b"], archived: ["x", {}] }));
    const fresh = await load();
    expect(fresh.getSessionPrefs()).toMatchObject({ pinned: ["a", "b"], archived: ["x"] });
  });

  it("sanitizes names: trims, drops blank and non-string values", async () => {
    localStorage.setItem(KEY, JSON.stringify({ names: { a: "  Work  ", b: "", c: 5, d: "   " } }));
    const fresh = await load();
    expect(fresh.getSessionPrefs().names).toEqual({ a: "Work" });
  });

  it("does not let a __proto__ key pollute the names map", async () => {
    localStorage.setItem(KEY, '{"names":{"__proto__":"x","a":"A"}}');
    const fresh = await load();
    expect(fresh.getSessionPrefs().names).toEqual({ a: "A" });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(fresh.getSessionPrefs().names)).toBe(Object.prototype);
  });

  it("keeps only the newest 500 ids from storage", async () => {
    const pinned = Array.from({ length: 600 }, (_, i) => `p${i}`);
    localStorage.setItem(KEY, JSON.stringify({ pinned }));
    const fresh = await load();
    const got = fresh.getSessionPrefs().pinned;
    expect(got).toHaveLength(500);
    expect(got[0]).toBe("p100");
    expect(got[got.length - 1]).toBe("p599");
  });

  it("keeps working in memory when localStorage writes throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => sp.togglePin("a")).not.toThrow();
    expect(sp.getSessionPrefs().pinned).toEqual(["a"]);
  });

  it("starts empty when localStorage reads throw", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const fresh = await load();
    expect(fresh.getSessionPrefs()).toEqual(EMPTY);
  });
});

describe("useSessionPrefs", () => {
  it("re-renders the component when prefs change", async () => {
    vi.resetModules();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const mod = await import("../sessionPrefs");

    const seen: string[][] = [];
    function Probe() {
      seen.push(mod.useSessionPrefs().pinned);
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => mod.togglePin("a"));

    expect(seen[seen.length - 1]).toEqual(["a"]);

    await act(async () => root.unmount());
    container.remove();
  });
});
