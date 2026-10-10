// English for Russian source strings of the Instructions settings tab (see src/lib/i18n.ts).
const en: Record<string, string> = {
  "Инструкции": "Instructions",
  "Инструкции: проект не открыт": "Instructions: no project is open",
  "служебный файл агента": "agent service file",
  "общие инструкции агента": "agent general instructions",
  "Инструкции агента — постоянные правила, которым он следует в каждой новой сессии.":
    "Agent instructions are standing rules the agent follows in every new session.",
  "Агент сейчас читает:": "The agent is reading now:",
  "агент не запущен": "agent not running",
  "ничего — инструкций нет": "nothing — no instructions",
  "Для всех проектов": "For all projects",
  "Действуют в любом проекте.": "Apply in any project.",
  "Инструкции для всех проектов": "Instructions for all projects",
  "Например: отвечай по-русски, без лишних пояснений": "For example: answer in Russian, without extra explanations",
  "не сохранено": "unsaved",
  "Взять из Claude Code": "Import from Claude Code",
  "Загружаем…": "Loading…",
  "Этот проект": "This project",
  "Действуют только в этом проекте.": "Apply only in this project.",
  "Инструкции этого проекта": "Instructions for this project",
  "Откройте проект, чтобы задать его инструкции.": "Open a project to set its instructions.",
  "Файл: {file}": "File: {file}",
  "будет создан": "will be created",
  "Составить автоматически": "Generate automatically",
  "Агент изучит проект и сам напишет инструкции в новой сессии":
    "The agent will study the project and write the instructions itself in a new session",
  "Несохранённые изменения будут потеряны. Продолжить?": "Unsaved changes will be lost. Continue?",
  "Агент читает только один файл инструкций. Сейчас это {active}; эти файлы он не видит: {list}.":
    "The agent reads only one instructions file. Right now it is {active}; it does not see these files: {list}.",
  "Сохранено. Изменения действуют в новых сессиях.": "Saved. Changes apply in new sessions.",
  "файл инструкций проекта, который ты уже читаешь": "the project instructions file you already read",
  "Изучи этот проект и напиши инструкции для агента в {file}: как устроен проект, как его запускать и проверять, соглашения по коду. Пиши кратко и только то, что не видно из кода сразу. Если в файле уже есть правила, сохрани их и дополни.":
    "Study this project and write agent instructions into {file}: how the project is structured, how to run and verify it, code conventions. Be brief and include only what isn't obvious from the code. If the file already has rules, keep them and extend.",
};

export default en;
