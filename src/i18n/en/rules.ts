// English for Russian source strings of the Rules section (see src/lib/i18n.ts).
// Keys shared with other screens (Отмена, Сохранить, Удалить, Название, …) live in their own files.
const en: Record<string, string> = {
  "Правила": "Rules",
  "Короткие правила для агента. «Всегда» — в каждом ответе, «По теме» — агент читает правило, когда тема подходит.":
    "Short rules for the agent. «Always» — in every reply; «By topic» — the agent reads the rule when the topic fits.",
  "Правил пока нет.": "No rules yet.",
  "Новое правило": "New rule",
  "Из других инструментов": "From other tools",
  "Эти правила агент тоже читает. Править их лучше в том инструменте.":
    "The agent reads these rules too. It is better to edit them in that tool.",
  "Изменения действуют в новых сессиях.": "Changes apply in new sessions.",
  "для: {globs}": "for: {globs}",
  "Нет описания — агент не знает, когда его читать": "No description — the agent does not know when to read it",
  "Выключено": "Off",
  "Перекрыто правилом проекта": "Overridden by a project rule",
  "Не работает": "Not working",
  "Особое": "Special",
  "Всегда": "Always",
  "По теме": "By topic",
  "Режим": "Mode",
  "латиница, цифры, - и _": "Latin letters, digits, - and _",
  "Такое название уже занято": "This name is already taken",
  "Взять «{name}»": "Use «{name}»",
  "Описание": "Description",
  "Когда агенту читать это правило": "When the agent should read this rule",
  "Необязательно": "Optional",
  "Без описания агент не знает, когда читать правило.": "Without a description the agent does not know when to read the rule.",
  "Правило попадает в каждый ответ агента.": "The rule goes into every agent reply.",
  "Агент видит описание и читает правило, когда тема подходит.":
    "The agent sees the description and reads the rule when the topic fits.",
  "Для файлов": "For files",
  "Необязательно. Через запятую или с новой строки.": "Optional. Separate with commas or new lines.",
  "Включено": "Enabled",
  "Текст правила": "Rule text",
  "У правила есть условия срабатывания — они сохранятся.": "This rule has trigger conditions — they will be kept.",
  "Удаляем…": "Deleting…",
  // Messages returned by src/lib/rules.ts
  "Введите название": "Enter a name",
  "Не длиннее 64 символов": "Up to 64 characters",
  "Начинается с буквы или цифры; дальше — строчные латинские буквы, цифры, «-» и «_»":
    "Must start with a letter or digit; then lowercase Latin letters, digits, «-» and «_»",
  "Правила: проект не открыт": "Rules: no project is open",
  "Правила: неверное название": "Rules: invalid name",
  "Правила: такое название уже занято": "Rules: this name is already taken",
  "Правила: имя может содержать латинские строчные буквы, цифры, «-» и «_» (до 64 символов)": "Rules: a name may contain lowercase latin letters, digits, “-” and “_” (up to 64 characters)",
  "Правила: не найден $HOME": "Rules: home folder not found",
  "Правила: неизвестная область": "Rules: unknown scope",
  "Правила: папка проекта не найдена": "Rules: project folder not found",
  "Правила: правило не найдено": "Rules: rule not found",
  "Правила: правило с таким именем уже есть": "Rules: a rule with this name already exists",
  "Правила: правилу «по теме» нужно описание": "Rules: a topic rule needs a description",
  "Правила: файл слишком большой": "Rules: the file is too large",
};

export default en;
