// English for Russian source strings (see src/lib/i18n.ts). Key: exact Russian text.
// Strings already translated in other dictionaries (Назад, Сохранить, Отмена, Изменить,
// Удалить, Имя, Проект, Все проекты, Этот проект, Команда, Аргументы, Адрес, …) are not repeated.
const en: Record<string, string> = {
  // Sidebar and screen
  "Подключения": "Connections",
  "MCP-СЕРВЕРЫ": "MCP SERVERS",
  "НАВЫКИ": "SKILLS",
  "Добавить сервер": "Add server",
  "Изменить сервер": "Edit server",
  "MCP-серверы дают агенту доступ к внешним инструментам: базам данных, GitHub, браузеру…":
    "MCP servers give the agent access to external tools: databases, GitHub, a browser…",
  "Навыки агент находит сам в папках навыков проекта и пользователя":
    "The agent finds skills itself in the skill folders of the project and the user",
  "Навыков пока нет": "No skills yet",
  "Изменения применятся после перезапуска агента": "Changes apply after the agent restarts",
  "Включить сервер {name}": "Turn on server {name}",
  "Удалить?": "Delete?",

  // Server dialog
  "Латиница, цифры, . _ : - и пробелы": "Latin letters, digits, . _ : - and spaces",
  "Область": "Scope",
  "Тип": "Type",
  "Команда запуска": "Launch command",
  "Аргументы через пробел; в кавычках — значения с пробелами":
    "Arguments separated by spaces; quote values that contain spaces",
  "Переменные окружения": "Environment variables",
  "Заголовки": "Headers",
  "Значения скрыты.": "Values are hidden.",
  "Значения скрыты. Пустое поле у сохранённой переменной оставляет старое значение.":
    "Values are hidden. An empty field keeps the saved value of that variable.",
  "+ Добавить переменную": "+ Add variable",
  "+ Добавить заголовок": "+ Add header",
  "Имя переменной": "Variable name",
  "Имя заголовка": "Header name",
  "Значение": "Value",
  "не изменено": "unchanged",
  "Убрать": "Remove",

  // Client-side validation
  "Имя: латиница, цифры, . _ : - и пробелы, до 100 знаков":
    "Name: Latin letters, digits, . _ : - and spaces, up to 100 characters",
  "Укажите команду запуска": "Enter a launch command",
  "Укажите адрес сервера": "Enter a server URL",
  "Адрес должен начинаться с http:// или https://": "The URL must start with http:// or https://",
  "Укажите имя переменной": "Enter a variable name",
  "Укажите имя заголовка": "Enter a header name",
  "Имя переменной: только латиница, цифры и _": "Variable name: Latin letters, digits and _ only",
  "Имя заголовка: без пробелов и двоеточий": "Header name: no spaces or colons",
  "Имя повторяется: {key}": "Name repeats: {key}",
  "Укажите значение: {key}": "Enter a value: {key}",

  // Backend errors (src-tauri/src/mcp.rs)
  "Укажите команду или URL, не оба": "Enter a command or a URL, not both",
  "Сервер с таким именем уже есть": "A server with this name already exists",
  "Сервер не найден": "Server not found",
  "Не выбран проект": "No project selected",
  "Неизвестная область": "Unknown scope",
  "Неизвестный тип сервера": "Unknown server type",
  "Некорректное имя переменной": "Invalid variable name",
  "Некорректное имя заголовка": "Invalid header name",
  "Укажите значение переменной": "Enter a value for variable",
  "Укажите значение заголовка": "Enter a value for header",
  "mcp.json не разобран": "mcp.json is not valid JSON",
  "mcp.json: корень должен быть объектом": "mcp.json: the root must be an object",
  "mcp.json: mcpServers должен быть объектом": "mcp.json: mcpServers must be an object",
  "Не удалось записать mcp.json": "Could not write mcp.json",
  "Не удалось сделать резервную копию": "Could not make a backup copy",
  "Некорректный путь к mcp.json": "Invalid path to mcp.json",
  "Не найден $HOME": "$HOME is not set",
};

export default en;
