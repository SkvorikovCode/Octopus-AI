import { beforeEach, describe, expect, it } from "vitest";
import { approvePrompt, planPrompt, revisePrompt } from "../plan";
import { resetSettings, updateSettings } from "../settings";

const RU_PLAN_TAIL =
  "Сначала только составь план, ничего не меняй: не правь файлы и не запускай команды, которые что-то изменяют. Изучи проект, запиши план списком задач (todo) и закончи коротким описанием плана и вопросами, если они есть. Дальше жди одобрения.";

beforeEach(() => {
  localStorage.clear();
  resetSettings();
});

describe("planPrompt", () => {
  describe("English UI", () => {
    beforeEach(() => updateSettings({ language: "en" }));

    it("wraps the task with the plan-only instruction", () => {
      expect(planPrompt("Add a button")).toBe(
        "Add a button\n\n—\nFirst, only make a plan and change nothing: do not edit files or run commands that modify anything. Explore the project, record the plan as a todo list, and finish with a short description of the plan and any open questions. Then wait for approval.",
      );
    });

    it("puts the task first, separated from the instruction by a dash line", () => {
      const out = planPrompt("Add a button");
      expect(out.startsWith("Add a button\n\n—\n")).toBe(true);
    });

    it("keeps the task literal: replacement patterns and placeholders are not expanded", () => {
      const task = "costs $& and $1 with {feedback} and {task}";
      const out = planPrompt(task);
      expect(out.startsWith(`${task}\n\n—\n`)).toBe(true);
      expect(out.endsWith("Then wait for approval.")).toBe(true);
    });

    it("keeps multi-line tasks intact", () => {
      expect(planPrompt("line one\nline two").startsWith("line one\nline two\n\n—\n")).toBe(true);
    });

    it("an empty task still gets the instruction", () => {
      expect(planPrompt("").startsWith("\n\n—\nFirst, only make a plan")).toBe(true);
    });
  });

  describe("Russian UI", () => {
    beforeEach(() => updateSettings({ language: "ru" }));

    it("uses the Russian template with the task first", () => {
      expect(planPrompt("сделай кнопку")).toBe(`сделай кнопку\n\n—\n${RU_PLAN_TAIL}`);
    });
  });
});

describe("approvePrompt", () => {
  it("is the English approval text in English UI", () => {
    updateSettings({ language: "en" });
    expect(approvePrompt()).toBe(
      "The plan is approved. Carry it out step by step and mark the tasks off in the list.",
    );
  });

  it("is the Russian approval text in Russian UI", () => {
    updateSettings({ language: "ru" });
    expect(approvePrompt()).toBe("План одобрен. Выполняй его по шагам и отмечай задачи в списке.");
  });
});

describe("revisePrompt", () => {
  it("embeds the feedback in English UI", () => {
    updateSettings({ language: "en" });
    expect(revisePrompt("add tests")).toBe("Revise the plan, still changing nothing: add tests");
  });

  it("embeds the feedback in Russian UI", () => {
    updateSettings({ language: "ru" });
    expect(revisePrompt("добавь тесты")).toBe("Поправь план, по-прежнему ничего не меняя: добавь тесты");
  });

  it("keeps feedback literal (no $-pattern or placeholder expansion)", () => {
    updateSettings({ language: "en" });
    expect(revisePrompt("use $& and {task}")).toBe(
      "Revise the plan, still changing nothing: use $& and {task}",
    );
  });
});
