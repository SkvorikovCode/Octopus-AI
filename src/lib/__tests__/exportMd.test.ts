import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item } from "../session";
import { fileStem, sessionToMarkdown } from "../exportMd";
import { updateSettings } from "../settings";

const NOW = new Date(2026, 9, 11, 15, 30);
const WHEN_RU = NOW.toLocaleString("ru-RU");
const WHEN_EN = NOW.toLocaleString("en-US");

beforeEach(() => {
  updateSettings({ language: "ru" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const user = (key: string, text: string): Item => ({ kind: "user", key, text });
const assistant = (key: string, text: string, extra: Partial<Item> = {}): Item =>
  ({ kind: "assistant", key, text, thinking: "", streaming: false, ...extra }) as Item;

describe("sessionToMarkdown: header", () => {
  it("writes the title, then a meta line with project, model and export time", () => {
    const md = sessionToMarkdown("Мой чат", [], { project: "/repo", model: "gpt-5" });
    expect(md).toBe(`# Мой чат\n\n_Проект: \`/repo\` · Модель: gpt-5 · Экспорт: ${WHEN_RU}_\n`);
  });

  it("omits project and model when they are missing or empty", () => {
    expect(sessionToMarkdown("T", [], {})).toBe(`# T\n\n_Экспорт: ${WHEN_RU}_\n`);
    expect(sessionToMarkdown("T", [], { project: "", model: "" })).toBe(`# T\n\n_Экспорт: ${WHEN_RU}_\n`);
  });

  it("includes only the model when there is no project", () => {
    const md = sessionToMarkdown("T", [], { model: "claude" });
    expect(md.split("\n")[2]).toBe(`_Модель: claude · Экспорт: ${WHEN_RU}_`);
  });

  it("uses English labels in English", () => {
    updateSettings({ language: "en" });
    const md = sessionToMarkdown("T", [], { project: "/r", model: "m" });
    expect(md.split("\n")[2]).toBe(`_Project: \`/r\` · Model: m · Exported: ${WHEN_EN}_`);
  });
});

describe("sessionToMarkdown: messages", () => {
  it("writes user and agent messages as level-2 sections", () => {
    const md = sessionToMarkdown("T", [user("1", "Привет"), assistant("2", "Здравствуй")], {});
    expect(md).toContain("## Вы\n\nПривет\n\n## Агент\n\nЗдравствуй\n");
  });

  it("skips agent messages that are empty or only whitespace", () => {
    const md = sessionToMarkdown("T", [assistant("1", ""), assistant("2", "   \n  ")], {});
    expect(md).not.toContain("## Агент");
  });

  it("includes a streaming agent message that has text so far", () => {
    const md = sessionToMarkdown("T", [assistant("1", "пишу…", { streaming: true } as Partial<Item>)], {});
    expect(md).toContain("## Агент\n\nпишу…");
  });

  it("does not export the agent's thinking", () => {
    const md = sessionToMarkdown("T", [assistant("1", "ответ", { thinking: "секретные рассуждения" } as Partial<Item>)], {});
    expect(md).not.toContain("секретные рассуждения");
  });

  it("keeps message text verbatim, without escaping", () => {
    const md = sessionToMarkdown("T", [user("1", "**жирный** `код` <b>tag</b>")], {});
    expect(md).toContain("\n\n**жирный** `код` <b>tag</b>\n");
  });

  it("writes items in their original order and drops notices", () => {
    const md = sessionToMarkdown(
      "T",
      [user("1", "A"), { kind: "notice", key: "n", text: "скрыто" }, assistant("2", "B")],
      {},
    );
    expect(md).not.toContain("скрыто");
    expect(md.indexOf("A")).toBeLessThan(md.indexOf("B"));
  });
});

describe("sessionToMarkdown: tool steps", () => {
  it("renders steps as a collapsed details block with one bullet per step", () => {
    const md = sessionToMarkdown(
      "T",
      [
        {
          kind: "steps",
          key: "s",
          steps: [
            { id: "1", name: "read", label: "src/a.ts", status: "ok" },
            { id: "2", name: "bash", label: "npm test", status: "err" },
            { id: "3", name: "edit", label: "src/b.ts", status: "run" },
          ],
        },
      ],
      {},
    );
    expect(md).toContain(
      [
        "<details><summary>Шаги: 3</summary>",
        "",
        "- `read` src/a.ts",
        "- `bash` npm test — ошибка",
        "- `edit` src/b.ts",
        "",
        "</details>",
        "",
      ].join("\n"),
    );
  });

  it("writes the error suffix in English", () => {
    updateSettings({ language: "en" });
    const md = sessionToMarkdown(
      "T",
      [{ kind: "steps", key: "s", steps: [{ id: "1", name: "bash", label: "x", status: "err" }] }],
      {},
    );
    expect(md).toContain("<summary>Steps: 1</summary>");
    expect(md).toContain("- `bash` x — error");
  });

  it("writes a step with an empty label without losing the name", () => {
    const md = sessionToMarkdown("T", [{ kind: "steps", key: "s", steps: [{ id: "1", name: "todo", label: "", status: "ok" }] }], {});
    expect(md).toContain("- `todo` \n");
  });
});

describe("sessionToMarkdown: shell, ask, error", () => {
  it("writes a shell command and its output in a console fence", () => {
    const md = sessionToMarkdown(
      "T",
      [{ kind: "shell", key: "h", command: "ls -la", output: "a.txt\nb.txt\n\n", running: false, exitCode: 0 }],
      {},
    );
    expect(md).toContain("```console\n$ ls -la\na.txt\nb.txt\n```\n");
  });

  it("writes the command alone when there is no output yet", () => {
    const md = sessionToMarkdown("T", [{ kind: "shell", key: "h", command: "sleep 9", running: true }], {});
    expect(md).toContain("```console\n$ sleep 9\n\n```\n");
  });

  it("writes an answered question with its answer", () => {
    const md = sessionToMarkdown(
      "T",
      [{ kind: "ask", key: "a", ask: { id: "1", method: "confirm", title: "Удалить файл?", state: "answered", answer: "да" } }],
      {},
    );
    expect(md).toContain("> **Удалить файл?** — ответ: да\n");
  });

  it("writes a question with no answer, cancelled or open", () => {
    const open = sessionToMarkdown(
      "T",
      [{ kind: "ask", key: "a", ask: { id: "1", method: "input", title: "Имя", state: "open" } }],
      {},
    );
    const cancelled = sessionToMarkdown(
      "T",
      [{ kind: "ask", key: "a", ask: { id: "1", method: "input", title: "Имя", state: "cancelled" } }],
      {},
    );
    expect(open).toContain("> **Имя** — без ответа\n");
    expect(cancelled).toContain("> **Имя** — без ответа\n");
  });

  it("uses a default title when the question has none", () => {
    const md = sessionToMarkdown(
      "T",
      [{ kind: "ask", key: "a", ask: { id: "1", method: "select", title: "", state: "open" } }],
      {},
    );
    expect(md).toContain("> **Запрос агента** — без ответа");
  });

  it("writes an error as a warning quote", () => {
    const md = sessionToMarkdown("T", [{ kind: "error", key: "e", text: "Сеть недоступна" }], {});
    expect(md).toContain("> ⚠ Сеть недоступна\n");
  });
});

describe("sessionToMarkdown: whitespace", () => {
  it("keeps a message as written but trims blank lines around it", () => {
    const md = sessionToMarkdown("T", [user("1", "\n\na\n\n\nb\n\n")], {});
    expect(md).toContain("\n\na\n\n\nb\n");
    expect(md).not.toMatch(/\n{3,}a/);
    expect(md).not.toMatch(/b\n{3,}/);
  });

  it("returns a document whose only trailing newline is the final one", () => {
    const md = sessionToMarkdown("T", [user("1", "x"), assistant("2", "y")], {});
    expect(md.endsWith("y\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("blank lines inside shell output are preserved", () => {
    const md = sessionToMarkdown("T", [{ kind: "shell", key: "h", command: "x", output: "a\n\n\n\nb", running: false }], {});
    expect(md).toContain("a\n\n\n\nb");
  });

  it("a ``` line in shell output does not close the console fence", () => {
    const md = sessionToMarkdown(
      "T",
      [{ kind: "shell", key: "h", command: "cat README.md", output: "```\nnpm i\n```", running: false, exitCode: 0 }],
      {},
    );
    expect(md).toContain("````console\n$ cat README.md\n```\nnpm i\n```\n````");
  });
});

describe("sessionToMarkdown: full session", () => {
  it("produces the exact document for a mixed conversation", () => {
    const items: Item[] = [
      user("1", "Исправь баг"),
      { kind: "steps", key: "2", steps: [{ id: "s1", name: "read", label: "src/a.ts", status: "ok" }] },
      { kind: "notice", key: "3", text: "скрыто" },
      assistant("4", "Готово."),
    ];
    const md = sessionToMarkdown("Тест", items, { project: "/repo", model: "gpt-5" });
    expect(md).toBe(
      [
        "# Тест",
        "",
        `_Проект: \`/repo\` · Модель: gpt-5 · Экспорт: ${WHEN_RU}_`,
        "",
        "## Вы",
        "",
        "Исправь баг",
        "",
        "<details><summary>Шаги: 1</summary>",
        "",
        "- `read` src/a.ts",
        "",
        "</details>",
        "",
        "## Агент",
        "",
        "Готово.",
        "",
      ].join("\n"),
    );
  });
});

describe("fileStem", () => {
  it("keeps an ordinary title unchanged", () => {
    expect(fileStem("Переписать парсер конфигов")).toBe("Переписать парсер конфигов");
  });

  it("replaces characters that are not allowed in file names with a single space", () => {
    expect(fileStem('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(fileStem("a///b")).toBe("a b");
  });

  it("collapses whitespace runs and trims the ends", () => {
    expect(fileStem("  a    b\t\tc  ")).toBe("a b c");
  });

  it("falls back to 'session' when nothing is left", () => {
    expect(fileStem("")).toBe("session");
    expect(fileStem("   ")).toBe("session");
    expect(fileStem("***")).toBe("session");
  });

  it("caps the length at 60 characters", () => {
    expect(fileStem("x".repeat(100))).toHaveLength(60);
  });

  it("a title cut at 60 characters has no trailing space", () => {
    const stem = fileStem("a".repeat(59) + " b");
    expect(stem).toBe(stem.trim());
  });
});
