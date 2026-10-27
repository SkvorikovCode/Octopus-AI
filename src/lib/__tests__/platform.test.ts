import { afterEach, describe, expect, it, vi } from "vitest";

async function load(platform: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform, userAgent: "" });
  return import("../platform");
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.platform;
});

describe("platform", () => {
  it("labels shortcuts with ⌘ on macOS", async () => {
    const p = await load("MacIntel");
    expect(p.IS_MAC).toBe(true);
    expect(p.modKey("K")).toBe("⌘K");
    p.markPlatform();
    expect(document.documentElement.dataset.platform).toBe("mac");
  });

  it("labels shortcuts with Ctrl+ on Linux", async () => {
    const p = await load("Linux x86_64");
    expect(p.IS_MAC).toBe(false);
    expect(p.modKey("Enter")).toBe("Ctrl+Enter");
    p.markPlatform();
    expect(document.documentElement.dataset.platform).toBe("other");
  });
});
