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
        out.push(`## ${t("Вы")}`, "", trimLines(it.text), "");
        break;
      case "assistant":
        if (it.text.trim()) out.push(`## ${t("Агент")}`, "", trimLines(it.text), "");
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
      case "shell": {
        const body = [`$ ${it.command}`, (it.output ?? "").trimEnd()].join("\n");
        const fence = fenceFor(body);
        out.push(`${fence}console`, body, fence, "");
        break;
      }
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
  return out.join("\n");
}

/** Drops blank lines around a message so blocks stay one empty line apart. */
function trimLines(s: string): string {
  return s.replace(/^\s*\n/, "").trimEnd();
}

/** A backtick fence longer than any backtick run inside the body. */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** File-name friendly version of a session title. */
export function fileStem(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim() || "session";
}
