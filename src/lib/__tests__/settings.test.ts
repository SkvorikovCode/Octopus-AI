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
  tilesMode: "full",
  language: "auto",
  theme: "dark",
  themeChosen: false,
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
    expect(fresh.getSettings()).toEqual({ ...DEFAULTS, theme: "light", themeChosen: true, budgetDaily: 5 });
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
    s.updateSettings({ tilesMode: "compact" });
    expect(s.getSettings()).not.toBe(before);
    expect(before.tilesMode).toBe("full");
  });

  it("maps the old tiles switch turned off to the compact mode", async () => {
    localStorage.setItem(KEY, JSON.stringify({ showTiles: false }));
    s = await load();
    expect(s.getSettings().tilesMode).toBe("compact");
    expect(s.getSettings()).not.toHaveProperty("showTiles");
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

  it("resolves the painted scheme from the theme", () => {
    s.updateSettings({ theme: "light" });
    expect(document.documentElement.dataset.scheme).toBe("light");
    s.updateSettings({ theme: "dark" });
    expect(document.documentElement.dataset.scheme).toBe("dark");
  });

  it("darkens every preset accent until it reads on light tiles", () => {
    for (const hex of s.ACCENTS) {
      const deep = s.readableOnPaper(hex);
      const n = parseInt(deep.slice(1), 16);
      expect(s.contrast([(n >> 16) & 255, (n >> 8) & 255, n & 255], [255, 253, 249])).toBeGreaterThanOrEqual(4.5);
    }
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

describe("outside palette", () => {
  const palette = { name: "tokyo-night", scheme: "light" as const, colors: { bg: "#1a1b26", ink: "#c0caf5", accent: "#7aa2f7", composer: "#202230" } };
  const root = () => document.documentElement;

  it("takes over until the user picks a theme, and gives way once they do", () => {
    s.setPalette(palette);
    expect(s.effectiveTheme(s.getSettings())).toBe("system");
    s.updateSettings({ theme: "dark", themeChosen: true });
    expect(s.effectiveTheme(s.getSettings())).toBe("dark");
    s.updateSettings({ theme: "system", themeChosen: true });
    expect(s.effectiveTheme(s.getSettings())).toBe("system");
  });

  it("falls back to dark when \"system\" is chosen but the palette is gone", () => {
    s.updateSettings({ theme: "system", themeChosen: true });
    s.setPalette(null);
    expect(s.effectiveTheme(s.getSettings())).toBe("dark");
    expect(root().dataset.scheme).toBe("dark");
  });

  it("a theme stored before the flag counts as chosen unless it was the default", async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "light" }));
    expect((await load()).getSettings().themeChosen).toBe(true);
    localStorage.setItem(KEY, JSON.stringify({ theme: "dark" }));
    expect((await load()).getSettings().themeChosen).toBe(false);
  });

  it("paints the palette's colors, scheme and accent, and removes them when another theme is picked", () => {
    s.updateSettings({ accent: "#FF8A1F" });
    s.setPalette(palette);
    expect(root().dataset.theme).toBe("system");
    expect(root().dataset.scheme).toBe("light");
    expect(root().style.getPropertyValue("--bg")).toBe("#1a1b26");
    expect(root().style.getPropertyValue("--accent")).toBe("#7aa2f7");
    expect(root().style.getPropertyValue("--composer-glass")).toBe("rgba(32, 34, 48, 0.92)");
    expect(root().style.getPropertyValue("--panel")).toBe("");
    expect(root().style.getPropertyValue("--glow-2")).toBe("rgba(122, 162, 247, 0.08)");
    expect(root().style.getPropertyValue("--glow-1")).toBe("");

    s.updateSettings({ theme: "dark", themeChosen: true });
    expect(root().style.getPropertyValue("--bg")).toBe("");
    expect(root().style.getPropertyValue("--composer-glass")).toBe("");
    expect(root().style.getPropertyValue("--glow-2")).toBe("");
    expect(root().style.getPropertyValue("--accent")).toBe("#FF8A1F");
    expect(root().dataset.scheme).toBe("dark");
  });
});
