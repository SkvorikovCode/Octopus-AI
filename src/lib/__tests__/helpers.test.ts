// Small pure helpers and the localStorage-backed stores that only transform data.
// Tauri-only wrappers (plain invoke calls) are not covered here.

import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slugify } from "../providers";
import { projectName, forgetProject, getRecentProjects, touchProject } from "../projects";
import { searchSessions } from "../search";
import { gitDiff, projectFiles } from "../workspace";
import { DEFAULT_TEMPLATES, TEMPLATE_NAME_RE, expandTemplate, newTemplateId } from "../templates";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("slugify", () => {
  it.each([
    ["My Proxy!", "my-proxy"],
    ["  Hello   World  ", "hello-world"],
    ["Café Ñandú", "cafe-nandu"],
    ["v2.0 (beta)", "v2-0-beta"],
    ["local_vllm", "local-vllm"],
    ["---", ""],
    ["", ""],
  ])("slugify(%j) → %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("drops non-latin letters, so a Russian-only name gives an empty id (the modal guards this)", () => {
    expect(slugify("Прокси")).toBe("");
  });
});

describe("projectName", () => {
  it.each([
    ["/Users/me/Octopus-AI", "Octopus-AI"],
    ["/Users/me/Octopus-AI/", "Octopus-AI"],
    ["/Users/me/Octopus-AI///", "Octopus-AI"],
    ["C:\\Users\\me\\proj", "proj"],
    ["C:\\Users\\me\\proj\\", "proj"],
    ["relative-name", "relative-name"],
  ])("projectName(%j) → %j", (path, expected) => {
    expect(projectName(path)).toBe(expected);
  });

  it("falls back to the full path when there is no last segment", () => {
    expect(projectName("/")).toBe("/");
    expect(projectName("")).toBe("");
  });
});

describe("recent projects store", () => {
  it("puts a newly touched project first and records its name", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    touchProject("/a/alpha");
    const list = touchProject("/b/beta");
    expect(list.map((p) => p.path)).toEqual(["/b/beta", "/a/alpha"]);
    expect(list[0]).toEqual({ path: "/b/beta", name: "beta", openedAt: 1000 });
    expect(getRecentProjects()).toEqual(list);
  });

  it("moves an already listed project to the top without duplicating it", () => {
    touchProject("/a/alpha");
    touchProject("/b/beta");
    const list = touchProject("/a/alpha");
    expect(list.map((p) => p.path)).toEqual(["/a/alpha", "/b/beta"]);
  });

  it("keeps at most 12 projects, dropping the least recent", () => {
    for (let i = 0; i < 13; i++) touchProject(`/p/project-${i}`);
    const list = getRecentProjects();
    expect(list).toHaveLength(12);
    expect(list[0].path).toBe("/p/project-12");
    expect(list.at(-1)?.path).toBe("/p/project-1");
    expect(list.some((p) => p.path === "/p/project-0")).toBe(false);
  });

  it("skips malformed stored entries", () => {
    localStorage.setItem(
      "octopus.recentProjects",
      JSON.stringify([
        { path: "/ok", name: "ok", openedAt: 1 },
        { path: "", name: "empty", openedAt: 2 },
        { path: "/bad-time", name: "x", openedAt: "yesterday" },
        { name: "no-path", openedAt: 3 },
        null,
      ]),
    );
    expect(getRecentProjects()).toEqual([{ path: "/ok", name: "ok", openedAt: 1 }]);
  });

  it("treats broken JSON and non-array values as an empty list", () => {
    localStorage.setItem("octopus.recentProjects", "{not json");
    expect(getRecentProjects()).toEqual([]);
    localStorage.setItem("octopus.recentProjects", JSON.stringify({ path: "/x" }));
    expect(getRecentProjects()).toEqual([]);
    expect(touchProject("/fresh").map((p) => p.path)).toEqual(["/fresh"]);
  });

  it("forgets one project and ignores unknown paths", () => {
    touchProject("/a/alpha");
    touchProject("/b/beta");
    expect(forgetProject("/a/alpha").map((p) => p.path)).toEqual(["/b/beta"]);
    expect(forgetProject("/nope").map((p) => p.path)).toEqual(["/b/beta"]);
  });

  it("still returns the list when storage refuses writes", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(touchProject("/a/alpha").map((p) => p.path)).toEqual(["/a/alpha"]);
  });

  it("reads an empty list when storage throws on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(getRecentProjects()).toEqual([]);
  });
});

describe("templates", () => {
  it("accepts slash names of lowercase latin letters, digits and dashes, up to 32 chars", () => {
    expect(TEMPLATE_NAME_RE.test("review")).toBe(true);
    expect(TEMPLATE_NAME_RE.test("a-1")).toBe(true);
    expect(TEMPLATE_NAME_RE.test("x".repeat(32))).toBe(true);
  });

  it("rejects empty, long, uppercase, spaced, underscored and non-latin names", () => {
    expect(TEMPLATE_NAME_RE.test("")).toBe(false);
    expect(TEMPLATE_NAME_RE.test("x".repeat(33))).toBe(false);
    expect(TEMPLATE_NAME_RE.test("Review")).toBe(false);
    expect(TEMPLATE_NAME_RE.test("my cmd")).toBe(false);
    expect(TEMPLATE_NAME_RE.test("my_cmd")).toBe(false);
    expect(TEMPLATE_NAME_RE.test("тест")).toBe(false);
  });

  it("gives built-in templates valid, unique slash names and ids", () => {
    const names = DEFAULT_TEMPLATES.map((t) => t.name);
    const ids = DEFAULT_TEMPLATES.map((t) => t.id);
    for (const name of names) expect(TEMPLATE_NAME_RE.test(name)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("default-")).toBe(true);
  });

  it("expands a template to its body, with extra typed text appended after a blank line", () => {
    const tpl = { id: "u1", name: "x", title: "X", body: "Сделай это." };
    expect(expandTemplate(tpl, "")).toBe("Сделай это.");
    expect(expandTemplate(tpl, "для модуля auth")).toBe("Сделай это.\n\nдля модуля auth");
  });

  it("generates distinct non-empty ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTemplateId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});

describe("templates store", () => {
  // The store keeps its snapshot in module state, so every test loads a fresh copy.
  async function freshStore() {
    vi.resetModules();
    const settings = await import("../settings");
    const store = await import("../templates");
    return { ...store, settings };
  }

  it("starts with the built-in templates when nothing is stored", async () => {
    const { getTemplates } = await freshStore();
    expect(getTemplates()).toEqual(DEFAULT_TEMPLATES);
  });

  it("appends a saved template and persists it across a reload", async () => {
    const first = await freshStore();
    first.saveTemplate({ id: "mine", name: "deploy", title: "Деплой", body: "Задеплой staging." });
    expect(first.getTemplates().at(-1)).toEqual({ id: "mine", name: "deploy", title: "Деплой", body: "Задеплой staging." });

    const second = await freshStore();
    expect(second.getTemplates().some((t) => t.id === "mine")).toBe(true);
  });

  it("replaces a template with the same id in place", async () => {
    const { getTemplates, saveTemplate } = await freshStore();
    const before = getTemplates().map((t) => t.id);
    saveTemplate({ ...DEFAULT_TEMPLATES[0], title: "Новое название" });
    const after = getTemplates();
    expect(after.map((t) => t.id)).toEqual(before);
    expect(after[0].title).toBe("Новое название");
  });

  it("stores a copy, so later edits of the passed object do not leak into the store", async () => {
    const { getTemplates, saveTemplate } = await freshStore();
    const draft = { id: "copy", name: "copy", title: "A", body: "B" };
    saveTemplate(draft);
    draft.title = "changed";
    expect(getTemplates().find((t) => t.id === "copy")?.title).toBe("A");
  });

  it("deletes a template by id and leaves the rest", async () => {
    const { getTemplates, deleteTemplate } = await freshStore();
    deleteTemplate("default-tests");
    expect(getTemplates().map((t) => t.id)).toEqual(["default-review", "default-explain"]);
  });

  it("keeps an emptied list empty after a reload, instead of restoring the defaults", async () => {
    const first = await freshStore();
    for (const t of first.getTemplates()) first.deleteTemplate(t.id);
    expect(first.getTemplates()).toEqual([]);
    const second = await freshStore();
    expect(second.getTemplates()).toEqual([]);
  });

  it("drops stored entries that are not templates", async () => {
    localStorage.setItem(
      "octopus.templates",
      JSON.stringify([
        { id: "ok", name: "ok", title: "OK", body: "ok" },
        { id: 1, name: "bad-id", title: "x", body: "x" },
        { id: "no-body", name: "x", title: "x" },
        null,
      ]),
    );
    const { getTemplates } = await freshStore();
    expect(getTemplates().map((t) => t.id)).toEqual(["ok"]);
  });

  it("falls back to the defaults on broken JSON or a non-array value", async () => {
    localStorage.setItem("octopus.templates", "[oops");
    expect((await freshStore()).getTemplates()).toEqual(DEFAULT_TEMPLATES);
    localStorage.setItem("octopus.templates", JSON.stringify({ id: "x" }));
    expect((await freshStore()).getTemplates()).toEqual(DEFAULT_TEMPLATES);
  });

  it("shows built-in templates in the interface language, and keeps user text as typed", async () => {
    const { useTemplates, saveTemplate, settings } = await freshStore();
    settings.updateSettings({ language: "en" });
    saveTemplate({ id: "mine", name: "mine", title: "Моя команда", body: "Текст пользователя." });

    const list = renderHookValue(() => useTemplates());
    const review = list.find((t) => t.id === "default-review");
    expect(review?.title).toBe("Review changes");
    expect(review?.body).not.toBe(DEFAULT_TEMPLATES[0].body);
    expect(list.find((t) => t.id === "mine")).toEqual({ id: "mine", name: "mine", title: "Моя команда", body: "Текст пользователя." });
  });

  it("shows the Russian built-in text when the language is Russian", async () => {
    const { useTemplates, settings } = await freshStore();
    settings.updateSettings({ language: "ru" });
    const list = renderHookValue(() => useTemplates());
    expect(list).toEqual(DEFAULT_TEMPLATES);
  });
});

/** Renders a hook inside a throwaway React root and returns what it produced. */
function renderHookValue<T>(hook: () => T): T {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let value!: T;
  function Probe() {
    value = hook();
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });
  act(() => {
    root.unmount();
  });
  return value;
}

describe("searchSessions (browser preview data)", () => {
  it("returns no hits for an empty or unknown query", async () => {
    expect(await searchSessions("/proj", "")).toEqual([]);
    expect(await searchSessions("/proj", "zzz-nothing")).toEqual([]);
  });

  it("finds demo sessions case-insensitively, with the match located in the snippet", async () => {
    const hits = await searchSessions("/proj", "  STRIPE ");
    expect(hits.map((h) => h.sessionId)).toEqual(["demo-3"]);
    const [hit] = hits;
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLen).toLowerCase()).toBe("stripe");
  });

  it("returns every demo session that contains the keyword", async () => {
    const hits = await searchSessions("/proj", "оплат");
    expect(hits.map((h) => h.sessionId).sort()).toEqual(["demo-1", "demo-3"]);
    for (const h of hits) {
      expect(h.snippet.slice(h.matchStart, h.matchStart + h.matchLen).toLowerCase()).toBe("оплат");
      expect(h.at).toBeLessThanOrEqual(Date.now());
    }
  });
});

describe("workspace demo data (browser preview)", () => {
  // Demo files live in module state; each test loads a fresh copy.
  async function freshWorkspace() {
    vi.resetModules();
    return await import("../workspace");
  }

  it("summarises the demo changes into totals", async () => {
    const { gitStatus: status } = await freshWorkspace();
    const s = await status("/proj");
    expect(s.isRepo).toBe(true);
    expect(s.branch).toBe("feat/pricing");
    expect(s.files.map((f) => f.path)).toEqual(["src/pages/pricing.tsx", "src/api/stripe.ts", "README.md"]);
    expect(s.additions).toBe(s.files.reduce((sum, f) => sum + f.additions, 0));
    expect(s.deletions).toBe(s.files.reduce((sum, f) => sum + f.deletions, 0));
    expect([s.additions, s.deletions]).toEqual([119, 7]);
  });

  it("returns a copy of the demo file list, so callers cannot change the demo state", async () => {
    const { gitStatus: status } = await freshWorkspace();
    const s = await status("/proj");
    s.files[0].additions = 9999;
    expect((await status("/proj")).files[0].additions).toBe(84);
  });

  it("drops a file from the demo status after a restore", async () => {
    const ws = await freshWorkspace();
    await ws.gitRestore("/proj", "README.md");
    const s = await ws.gitStatus("/proj");
    expect(s.files.map((f) => f.path)).not.toContain("README.md");
    expect(s.files).toHaveLength(2);
  });

  it("keeps the restore inside its own module copy", async () => {
    const a = await freshWorkspace();
    await a.gitRestore("/proj", "src/api/stripe.ts");
    const b = await freshWorkspace();
    expect((await a.gitStatus("/proj")).files).toHaveLength(2);
    expect((await b.gitStatus("/proj")).files).toHaveLength(3);
  });

  it("returns a unified diff for a known file and an empty string for an unknown one", async () => {
    const diff = await gitDiff("/proj", "src/api/stripe.ts");
    expect(diff.startsWith("diff --git a/src/api/stripe.ts b/src/api/stripe.ts")).toBe(true);
    expect(await gitDiff("/proj", "missing.ts")).toBe("");
  });

  it("finds project files by case-insensitive substring and honours the limit", async () => {
    expect(await projectFiles("/proj", "PRICING")).toEqual(["src/pages/pricing.tsx"]);
    expect(await projectFiles("/proj", "src/api", 1)).toEqual(["src/api/stripe.ts"]);
    expect(await projectFiles("/proj", "", 3)).toHaveLength(3);
    expect(await projectFiles("/proj", "no-such-file")).toEqual([]);
  });

});
