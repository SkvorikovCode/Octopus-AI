// "Plan first" mode. The engine has no plan switch over our protocol, so the app
// wraps the prompts itself. Russian source strings go through t(); English is in
// src/i18n/en/plan.ts, keyed by these exact strings.
import { t } from "./i18n";

const PLAN_TEMPLATE =
  "{task}\n\n—\nСначала только составь план, ничего не меняй: не правь файлы и не запускай команды, которые что-то изменяют. Изучи проект, запиши план списком задач (todo) и закончи коротким описанием плана и вопросами, если они есть. Дальше жди одобрения.";
const APPROVE_TEXT = "План одобрен. Выполняй его по шагам и отмечай задачи в списке.";
const REVISE_TEMPLATE = "Поправь план, по-прежнему ничего не меняя: {feedback}";

/** Wraps the user's task so the agent only investigates and plans. */
export function planPrompt(task: string): string {
  return t(PLAN_TEMPLATE, { task });
}

/** Sent when the user approves the plan: the agent starts executing it. */
export function approvePrompt(): string {
  return t(APPROVE_TEXT);
}

/** Sent when the user asks for changes to the plan; the agent still changes nothing. */
export function revisePrompt(feedback: string): string {
  return t(REVISE_TEMPLATE, { feedback });
}
