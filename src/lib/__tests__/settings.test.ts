import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Mod = typeof import("../settings");

const KEY = "octopus.settings";

// The store keeps its state in module scope, so each test loads a fresh copy.
async function load(): Promise<Mod> {
  vi.resetModules();
  return import("../settings");
}

const DEFAULTS = {
  accent: "#FF3D2E",
  uiScale: 1,
  notifications: true,
  sendWith: "enter",
  thinkingExpanded: false,
  showTiles: true,
  language: "auto",
  theme: "dark",
  budgetDaily: null,
  budgetSession: null,
};

function setNavigatorLanguages(langs: string[]) {
  Object.defineProperty(navigator, "languages", { configurable: true, value: langs });
}

let s: Mod;

beforeEach(async () => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  document.body.removeAttribute("style");
  s = await load();
});

afterEach(() => {
  delete (navigator as unknown as { languages?: string[] }).languages;
});

describe("defaults", () => {
  it("DEFAULT_SETTINGS has the documented values", () => {
    expect(s.DEFAULT_SETTINGS).toEqual(DEFAULTS);
  });

  it("the default accent is the first preset", () => {
    expect(s.ACCENTS[0]).toBe(s.DEFAULT_SETTINGS.accent);
    expect(s.ACCENTS).toHaveLength(5);
  });

  it("starts with the defaults when nothing is stored", () => {
    expect(s.getSettings()).toEqual(DEFAULTS);
  });

  it("budget limits are off by default", () => {
    expect(s.getSettings()).toMatchObject({ budgetDaily: null, budgetSession: null });
  });
});

describe("load from storage", () => {
  it("merges a partial stored object with the defaults", async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "light", budgetDaily: 5 }));
    const fresh = await load();
    expect(fresh.getSettings()).toEqual({ ...DEFAULTS, theme: "light", budgetDaily: 5 });
  });

  it.each(["{not json", "null", "42"])("falls back to defaults for stored %s", async (raw) => {
    localStorage.setItem(KEY, raw);
    const fresh = await load();
    expect(fresh.getSettings()).toEqual(DEFAULTS);
  });

  it("falls back to defaults when the stored JSON is a string", async () => {
    localStorage.setItem(KEY, '"text"');
    const fresh = await load();
    expect(fresh.getSettings()).toEqual(DEFAULTS);
  });

  it("falls back to defaults when localStorage reads throw", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const fresh = await load();
    expect(fresh.getSettings()).toEqual(DEFAULTS);
  });

  it("replaces stored values of the wrong type or outside the allowed set with defaults", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ theme: "purple", language: "fr", uiScale: "huge", budgetDaily: "10" }),
    );
    const fresh = await load();
    expect(fresh.getSettings()).toMatchObject({
      theme: "dark",
      language: "auto",
      uiScale: 1,
      budgetDaily: null,
    });
  });
});

describe("updateSettings", () => {
  it("patches only the given fields", () => {
    s.updateSettings({ uiScale: 1.25 });
    expect(s.getSettings()).toEqual({ ...DEFAULTS, uiScale: 1.25 });
  });

  it("persists the whole object to localStorage", () => {
    s.updateSettings({ sendWith: "mod-enter" });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({ ...DEFAULTS, sendWith: "mod-enter" });
  });

  it("the new values are read back after a reload", async () => {
    s.updateSettings({ language: "ru", theme: "light", budgetSession: 3.5 });
    const fresh = await load();
    expect(fresh.getSettings()).toMatchObject({ language: "ru", theme: "light", budgetSession: 3.5 });
  });

  it("sets and clears the budget limits (null means off)", () => {
    s.updateSettings({ budgetDaily: 25, budgetSession: 4 });
    expect(s.getSettings()).toMatchObject({ budgetDaily: 25, budgetSession: 4 });
    s.updateSettings({ budgetDaily: null });
    expect(s.getSettings()).toMatchObject({ budgetDaily: null, budgetSession: 4 });
  });

  it("keeps working in memory when localStorage writes throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => s.updateSettings({ notifications: false })).not.toThrow();
    expect(s.getSettings().notifications).toBe(false);
  });

  it("keeps the other fields when patching a single field", () => {
    const before = s.getSettings();
    s.updateSettings({ showTiles: false });
    expect(s.getSettings()).not.toBe(before);
    expect(before.showTiles).toBe(true);
  });
});

describe("resetSettings", () => {
  it("restores the defaults and writes them to storage", async () => {
    s.updateSettings({ uiScale: 1.2, theme: "light", budgetDaily: 9 });
    s.resetSettings();
    expect(s.getSettings()).toEqual(DEFAULTS);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(DEFAULTS);
  });
});

describe("applySettings (DOM)", () => {
  it("sets the accent and its soft tint on the root element", () => {
    s.updateSettings({ accent: "#3DE0FF" });
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--accent")).toBe("#3DE0FF");
    expect(root.style.getPropertyValue("--accent-soft")).toBe("rgba(61, 224, 255, 0.1)");
  });

  it("builds the soft accent from any 6-digit hex, either case", () => {
    s.updateSettings({ accent: "#ff8a1f" });
    expect(document.documentElement.style.getPropertyValue("--accent-soft")).toBe("rgba(255, 138, 31, 0.1)");
  });

  it("falls back to the default accent tint for a value that is not a 6-digit hex", () => {
    s.updateSettings({ accent: "#fff" });
    expect(document.documentElement.style.getPropertyValue("--accent-soft")).toBe("rgba(255, 61, 46, 0.1)");
  });

  it("sets the theme as data-theme", () => {
    s.updateSettings({ theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    s.updateSettings({ theme: "auto" });
    expect(document.documentElement.dataset.theme).toBe("auto");
  });

  it("applies the UI scale as body zoom", () => {
    s.updateSettings({ uiScale: 1.25 });
    expect(document.body.style.zoom).toBe("1.25");
  });

  it("uses the explicit language for the lang attribute", () => {
    s.updateSettings({ language: "ru" });
    expect(document.documentElement.lang).toBe("ru");
    s.updateSettings({ language: "en" });
    expect(document.documentElement.lang).toBe("en");
  });

  it("follows the system language when set to auto", () => {
    setNavigatorLanguages(["ru-RU", "en-US"]);
    s.updateSettings({ language: "auto" });
    expect(document.documentElement.lang).toBe("ru");
  });

  it("auto falls back to English for a non-Russian system language", () => {
    setNavigatorLanguages(["de-DE"]);
    s.updateSettings({ language: "auto" });
    expect(document.documentElement.lang).toBe("en");
  });

  it("applySettings() without an argument re-applies the current settings", () => {
    s.updateSettings({ theme: "light" });
    document.documentElement.dataset.theme = "tampered";
    s.applySettings();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
