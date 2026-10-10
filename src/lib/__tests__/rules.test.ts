import { describe, expect, it } from "vitest";
import { EN } from "../../i18n/en";
import {
  deleteRule,
  listRules,
  parseGlobs,
  ruleNameError,
  saveRule,
  slugifyRuleName,
  type RuleInput,
} from "../rules";

const CWD = "/Users/demo/project";

const input = (over: Partial<RuleInput> = {}): RuleInput => ({
  name: "tests",
  always: true,
  description: "",
  globs: [],
  enabled: true,
  body: "Запускай тесты.",
  ...over,
});

describe("ruleNameError", () => {
  it("accepts lowercase Latin names with digits, '-' and '_'", () => {
    for (const name of ["style", "db-2", "a_b", "x", "9lives", "a".repeat(64)]) {
      expect(ruleNameError(name), name).toBeNull();
    }
  });

  it("rejects empty, too long, uppercase, leading symbols and non-Latin names", () => {
    for (const name of ["", "Style", "-x", "_x", "привет", "a b", "a".repeat(65)]) {
      expect(ruleNameError(name), name).not.toBeNull();
    }
  });

  it("returns message keys that have English entries", () => {
    for (const name of ["", "Style", "a".repeat(65)]) {
      const key = ruleNameError(name);
      expect(key).not.toBeNull();
      expect(Object.hasOwn(EN, key!), key!).toBe(true);
    }
  });
});

describe("slugifyRuleName", () => {
  it("makes a name from free text", () => {
    expect(slugifyRuleName("Hello World")).toBe("hello-world");
    expect(slugifyRuleName("Пиши react")).toBe("react");
    expect(slugifyRuleName("  a -  b!! ")).toBe("a-b");
    expect(slugifyRuleName("Привет")).toBe("");
  });

  it("always returns a valid name no longer than 64 characters", () => {
    const slug = slugifyRuleName("word ".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug === "" || ruleNameError(slug) === null).toBe(true);
  });
});

describe("parseGlobs", () => {
  it("splits by commas and new lines and trims the parts", () => {
    expect(parseGlobs(" src/db/**, *.sql\n\n lib/x ,")).toEqual(["src/db/**", "*.sql", "lib/x"]);
    expect(parseGlobs("  ")).toEqual([]);
  });
});

describe("demo rules (browser preview)", () => {
  it("lists project, general and foreign rules with the computed flags", async () => {
    const list = await listRules(CWD);
    expect(list.project.map((r) => r.name).sort()).toEqual(["db", "draft", "style"]);
    expect(list.project.find((r) => r.name === "draft")?.ignored).toBe(true);
    expect(list.global.find((r) => r.name === "style")?.overridden).toBe(true);
    expect(list.global.find((r) => r.name === "commits")?.overridden).toBe(false);
    expect(list.foreign.map((r) => r.rel)).toEqual([".cursor/rules/legacy.mdc"]);
  });

  it("has no project rules without a project", async () => {
    expect((await listRules(null)).project).toEqual([]);
  });

  it("creates, renames and deletes a project rule", async () => {
    await saveRule("project", CWD, null, input({ name: "api" }));
    expect((await listRules(CWD)).project.map((r) => r.name)).toContain("api");

    await saveRule("project", CWD, "api", input({ name: "api-v2", always: false, description: "API", globs: ["src/api/**"] }));
    const rules = (await listRules(CWD)).project;
    expect(rules.some((r) => r.name === "api")).toBe(false);
    expect(rules.find((r) => r.name === "api-v2")).toMatchObject({
      always: false,
      description: "API",
      globs: ["src/api/**"],
    });

    await deleteRule("project", CWD, "api-v2");
    expect((await listRules(CWD)).project.some((r) => r.name === "api-v2")).toBe(false);
  });

  it("refuses a name that is already taken in the same scope", async () => {
    await expect(saveRule("global", null, null, input({ name: "commits" }))).rejects.toThrow(
      "Правила: такое название уже занято",
    );
  });

  it("refuses a project save when no project is open", async () => {
    await expect(saveRule("project", null, null, input({ name: "x1" }))).rejects.toThrow(
      "Правила: проект не открыт",
    );
  });
});
