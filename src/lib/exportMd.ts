// Session → Markdown, built from what the chat shows.

import type { Item } from "./session";
import { locale, t } from "./i18n";

export function sessionToMarkdown(title: string, items: Item[], meta: { project?: string; model?: string }): string {
  const out: string[] = [`# ${title}`, ""];
  const info = [
    meta.project && `${t("Проект")}: \`${meta.project}\``,
    meta.model && `${t("Модель")}: ${meta.model}`,
    `${t("Экспорт")}: ${new Date().toLocaleString(locale())}`,
  ]
    .filter(Boolean)
    .join(" · ");
  out.push(`_${info}_`, "");

  for (const it of items) {
    switch (it.kind) {
      case "user":
        out.push(`## ${t("Вы")}`, "", it.text, "");
        break;
      case "assistant":
        if (it.text.trim()) out.push(`## ${t("Агент")}`, "", it.text, "");
        break;
      case "steps":
        out.push(
          `<details><summary>${t("Шаги: {count}", { count: it.steps.length })}</summary>`,
          "",
          ...it.steps.map((st) => `- \`${st.name}\` ${st.label}${st.status === "err" ? ` — ${t("ошибка")}` : ""}`),
          "",
          "</details>",
          "",
        );
        break;
      case "shell":
        out.push("```console", `$ ${it.command}`, (it.output ?? "").trimEnd(), "```", "");
        break;
      case "ask":
        out.push(
          `> **${it.ask.title || t("Запрос агента")}** — ${it.ask.state === "answered" ? t("ответ: {answer}", { answer: String(it.ask.answer) }) : t("без ответа")}`,
          "",
        );
        break;
      case "error":
        out.push(`> ⚠ ${it.text}`, "");
        break;
      case "notice":
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** File-name friendly version of a session title. */
export function fileStem(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "session";
}
