import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import { displayPath } from "../instructions";

const PROJECT = "/Users/me/Projects/octo";
const HOME = "/Users/me";

describe("displayPath", () => {
  it("shows the agent's general default file as a neutral label", () => {
    const label = t("общие инструкции агента");
    expect(displayPath(".omp/agent/AGENTS.md", { project: PROJECT, home: HOME })).toBe(label);
    expect(displayPath("/Users/me/.omp/agent/AGENTS.md", { project: PROJECT, home: HOME })).toBe(label);
  });

  it("hides any other engine-internal path behind a neutral label", () => {
    const label = t("служебный файл агента");
    expect(displayPath(".omp/agent/CLAUDE.md")).toBe(label);
    expect(displayPath("/Users/me/.omp/agent/rules.md", { home: HOME })).toBe(label);
    expect(displayPath(`${PROJECT}/.omp/models.yml`, { project: PROJECT })).toBe(label);
  });

  it("never returns the engine names", () => {
    const inputs = [
      ".omp/agent/AGENTS.md",
      "/Users/me/.omp/agent/models.yml",
      "oh-my-pi/config.yml",
      `${PROJECT}/models.yml`,
    ];
    for (const p of inputs) {
      const shown = displayPath(p, { project: PROJECT, home: HOME });
      expect(shown).not.toMatch(/\bomp\b|oh-my-pi|models\.yml/i);
    }
  });

  it("shows absolute paths inside the project relative to it", () => {
    expect(displayPath(`${PROJECT}/.claude/CLAUDE.md`, { project: PROJECT, home: HOME })).toBe(".claude/CLAUDE.md");
    expect(displayPath(`${PROJECT}/`, { project: `${PROJECT}/` })).toBe(`${PROJECT}/`);
  });

  it("shows paths inside the home folder as ~/…", () => {
    expect(displayPath("/Users/me/.claude/CLAUDE.md", { project: PROJECT, home: HOME })).toBe("~/.claude/CLAUDE.md");
  });

  it("returns other paths unchanged", () => {
    expect(displayPath("/opt/shared/rules.md", { project: PROJECT, home: HOME })).toBe("/opt/shared/rules.md");
    expect(displayPath("AGENTS.md")).toBe("AGENTS.md");
    expect(displayPath("/Users/meow/notes.md", { home: HOME })).toBe("/Users/meow/notes.md");
  });

  it("does not match a project prefix that is only a part of a folder name", () => {
    expect(displayPath("/Users/me/Projects/octo-2/AGENTS.md", { project: PROJECT })).toBe(
      "/Users/me/Projects/octo-2/AGENTS.md",
    );
  });
});
