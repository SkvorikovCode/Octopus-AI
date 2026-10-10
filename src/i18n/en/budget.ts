// English for Russian source strings (see src/lib/i18n.ts). Key: exact Russian text.
const en: Record<string, string> = {
  // Settings: spending limits
  "БЮДЖЕТ": "BUDGET",
  "В день": "Per day",
  "На сессию": "Per session",
  "Предупредим на 80%, на 100% новые задачи остановятся до подтверждения": "We warn at 80%; at 100% new tasks stop until you confirm",
  "Сегодня потрачено: {cost}": "Spent today: {cost}",
  "Введите сумму больше 0 и не больше 10 000": "Enter an amount above 0 and up to 10,000",
  "Лимит в день, USD": "Daily limit, USD",
  "Лимит на сессию, USD": "Session limit, USD",
  "выкл.": "off",

  // Budget banner
  "за день": "for the day",
  "на сессию": "for the session",
  "Потрачено {spent} из {limit} {scopeLabel}": "Spent {spent} of {limit} {scopeLabel}",
  "Лимит {scopeLabel} исчерпан: {spent} из {limit}": "Limit {scopeLabel} reached: {spent} of {limit}",
  "Изменить лимит": "Change limit",
  "Продолжить всё равно": "Continue anyway",
};

export default en;
