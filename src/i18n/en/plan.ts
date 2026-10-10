// English for Russian source strings (see src/lib/i18n.ts). Key: exact Russian text.
const en: Record<string, string> = {
  // lib/plan.ts: prompts sent to the agent in English
  "{task}\n\n—\nСначала только составь план, ничего не меняй: не правь файлы и не запускай команды, которые что-то изменяют. Изучи проект, запиши план списком задач (todo) и закончи коротким описанием плана и вопросами, если они есть. Дальше жди одобрения.":
    "{task}\n\n—\nFirst, only make a plan and change nothing: do not edit files or run commands that modify anything. Explore the project, record the plan as a todo list, and finish with a short description of the plan and any open questions. Then wait for approval.",
  "План одобрен. Выполняй его по шагам и отмечай задачи в списке.":
    "The plan is approved. Carry it out step by step and mark the tasks off in the list.",
  "Поправь план, по-прежнему ничего не меняя: {feedback}": "Revise the plan, still changing nothing: {feedback}",

  // Composer.tsx: plan toggle chip and placeholder
  "План": "Plan",
  "Сначала план: агент изучит проект и предложит план, ничего не меняя":
    "Plan first: the agent explores the project and proposes a plan without changing anything",
  "Опишите задачу — агент сначала предложит план": "Describe the task. The agent will propose a plan first",

  // PlanCard.tsx
  "ПЛАН ГОТОВ": "PLAN READY",
  "Выполнить план": "Run the plan",
  "Поправить": "Revise",
  "Скрыть": "Hide",
  "Что изменить в плане?": "What should change in the plan?",
  "Отмена": "Cancel",
  "Агент не записал план списком — посмотрите его ответ выше.":
    "The agent did not write the plan as a list. See its reply above.",
  "Сначала план": "Plan first",
};

export default en;
