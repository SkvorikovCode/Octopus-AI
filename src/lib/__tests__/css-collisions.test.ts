// Regression guard: a class name must be styled by one stylesheet only.
//
// Every stylesheet is global, so two files that both define `.mp-row` silently
// restyle each other's components (the model picker once broke because the
// prices table used the same `mp-` prefix). Only bare rules count: `.a`,
// `.a:hover`, `.a[open]`. Modifiers (`.a.is-on`) and rules scoped under a
// parent (`.parent .a`) are meant to extend or override and are ignored.

import { describe, expect, it } from "vitest";

const SHEETS = import.meta.glob("../../**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * Classes that are layered on purpose: a base rule in styles.css and a
 * refinement in the component's own stylesheet, with different properties.
 * Do not add to this list to silence a new clash; rename the class instead.
 */
const LAYERED = new Set(["composer", "composer-bar", "md", "side-project"]);

/** Class names a stylesheet defines with a bare, unscoped rule. */
function bareClasses(css: string): Set<string> {
  const out = new Set<string>();
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector] of body.matchAll(/([^{}]+)\{/g)) {
    for (const part of selector.split(",")) {
      const m = part.trim().match(/^\.([A-Za-z0-9_-]+)((?::[a-z-]+(?:\([^)]*\))?|\[[^\]]*\])*)$/);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

describe("stylesheet class names", () => {
  it("finds the stylesheets", () => {
    expect(Object.keys(SHEETS).length).toBeGreaterThan(10);
  });

  it("are defined by a single stylesheet", () => {
    const owners = new Map<string, string[]>();
    for (const [path, css] of Object.entries(SHEETS)) {
      const file = path.split("/").pop() as string;
      for (const cls of bareClasses(css)) owners.set(cls, [...(owners.get(cls) ?? []), file]);
    }
    const clashes = [...owners].filter(([cls, files]) => files.length > 1 && !LAYERED.has(cls)).map(([cls, files]) => `.${cls}: ${files.join(", ")}`);
    expect(clashes).toEqual([]);
  });

  it("detects a clash (sanity check of the matcher)", () => {
    expect([...bareClasses(".a { x: 1 } .a:hover { y: 2 } .p .b { z: 3 } .c.is-on, .d { w: 4 }")].sort()).toEqual(["a", "d"]);
  });
});
