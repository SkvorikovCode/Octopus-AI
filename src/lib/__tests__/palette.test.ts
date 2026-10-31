import { describe, expect, it } from "vitest";
import { parsePalette } from "../palette";

const file = (o: unknown) => JSON.stringify(o);

describe("parsePalette", () => {
  it("keeps known keys with #rrggbb values, lowercased, and the name", () => {
    const p = parsePalette(
      file({ format: 1, name: " tokyo-night ", scheme: "dark", colors: { bg: "#1A1B26", ink: "#c0caf5", accent: "#7aa2f7", "panel-2": "#202230" } }),
    );
    expect(p).toEqual({ name: "tokyo-night", scheme: "dark", colors: { bg: "#1a1b26", ink: "#c0caf5", accent: "#7aa2f7", "panel-2": "#202230" } });
  });

  it("drops unknown keys and values that are not #rrggbb", () => {
    const p = parsePalette(
      file({
        format: 1,
        scheme: "light",
        colors: { bg: "#ffffff", ink: "#000000", font: "#123456", panel: "red", line: "rgba(0,0,0,0.1)", dot: "#fff", mute: "#12345678", dim: "#abc;}" },
      }),
    );
    expect(p?.colors).toEqual({ bg: "#ffffff", ink: "#000000" });
  });

  it("needs a background and a text color", () => {
    expect(parsePalette(file({ format: 1, scheme: "dark", colors: { bg: "#000000" } }))).toBeNull();
    expect(parsePalette(file({ format: 1, scheme: "dark", colors: { ink: "#ffffff" } }))).toBeNull();
  });

  it.each([
    ["no file", null],
    ["empty", ""],
    ["not JSON", "{oops"],
    ["an array", "[]"],
    ["another format", file({ format: 2, scheme: "dark", colors: { bg: "#000000", ink: "#ffffff" } })],
    ["no scheme", file({ format: 1, colors: { bg: "#000000", ink: "#ffffff" } })],
    ["colors not an object", file({ format: 1, scheme: "dark", colors: ["#000000"] })],
  ])("is null for %s", (_, text) => {
    expect(parsePalette(text)).toBeNull();
  });

  it("clips a long name and leaves out an empty one", () => {
    const base = { format: 1, scheme: "dark", colors: { bg: "#000000", ink: "#ffffff" } };
    expect(parsePalette(file({ ...base, name: "x".repeat(100) }))?.name).toHaveLength(60);
    expect(parsePalette(file({ ...base, name: "  " }))?.name).toBeUndefined();
  });
});
