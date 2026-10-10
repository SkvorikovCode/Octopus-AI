// English for Russian source strings (see src/lib/i18n.ts). Key: exact Russian text.
const en: Record<string, string> = {
  // sessions.rs, stats.rs
  "Без названия": "Untitled",
  "не найден HOME": "HOME not found",
  "нет папки сессий агента": "Agent sessions folder not found",
  "сессия не найдена": "Session not found",
  "это не файл сессии агента": "Not an agent session file",

  // omp.rs
  "Движок агента не найден": "Agent engine not found",
  "нет stdin у движка": "Agent engine has no stdin",
  "нет stdout у движка": "Agent engine has no stdout",
  "нет stderr у движка": "Agent engine has no stderr",
  "агент не запущен": "Agent is not running",
  "агент останавливается": "Agent is stopping",

  // files.rs
  "Папка проекта не найдена": "Project folder not found",
  "Файл не найден": "File not found",
  "Файл находится за пределами папки проекта": "File is outside the project folder",
  "Это папка": "This is a folder",
  "Это не обычный файл": "Not a regular file",
  "Бинарный файл — просмотр недоступен": "Binary file, preview not available",
  "Нужен абсолютный путь к файлу": "An absolute file path is required",
  "Папка не найдена": "Folder not found",
  "Файл слишком большой (максимум 20 МБ)": "File is too large (20 MB max)",
  "Некорректный путь к файлу": "Invalid file path",

  // providers.rs
  "Не найден $HOME": "$HOME not found",
  "Настройки агента: корень должен быть словарём": "Agent settings: the top level must be a mapping",
  "Настройки агента: providers должен быть словарём": "Agent settings: providers must be a mapping",
  "Некорректный путь к настройкам агента": "Invalid agent settings path",
  "ID провайдера: только латиница, цифры, - и _": "Provider ID: Latin letters, digits, - and _ only",
  "Добавьте хотя бы одну модель": "Add at least one model",
  "У модели пустой id": "A model has an empty ID",
  "Адрес должен начинаться с http:// или https://": "The address must start with http:// or https://",
  "Сервер вернул не список моделей": "The server did not return a list of models",
  "Нужен API-ключ": "An API key is required",

  // workspace.rs
  "Не удалось запустить git": "Could not run git",
  "Ошибка git": "Git error",
  "Не указан путь к файлу": "No file path given",
  "Абсолютные пути запрещены": "Absolute paths are not allowed",
  "Путь выходит за папку проекта": "The path is outside the project folder",
  "Некорректный путь": "Invalid path",
  "Это папка, а не файл": "This is a folder, not a file",
  "Бинарный или слишком большой файл": "Binary or too large file",
  "Откатывать можно только файлы, не папки": "Only files can be reverted, not folders",
  "Нет коммитов — откатить нельзя": "No commits yet, so nothing can be reverted",
  "Не удалось прочитать папку проекта": "Could not read the project folder",
  // Prefixes of "Prefix: details" messages (see tErr in src/lib/i18n.ts).
  "не удалось удалить": "couldn't delete",
  "Не удалось запустить движок агента": "Couldn't start the agent engine",
  "Запись в движок": "Writing to the agent",
  "Внутренняя ошибка": "Internal error",
  "Не удалось прочитать файл": "Couldn't read the file",
  "Не удалось записать файл": "Couldn't write the file",
  "Настройки агента не разобраны": "Couldn't parse agent settings",
  "Не удалось сделать резервную копию": "Couldn't make a backup",
  "Не удалось записать настройки агента": "Couldn't write agent settings",
  "Не удалось сохранить ключ в Keychain": "Couldn't save the key to Keychain",
  "Не удалось удалить ключ из Keychain": "Couldn't remove the key from Keychain",
  "Неизвестный тип API": "Unknown API type",
  "Не удалось подключиться": "Couldn't connect",
  "Не удалось удалить файл": "Couldn't delete the file",
};

export default en;
