// English for Russian source strings (see src/lib/i18n.ts). Key: exact Russian text.
// Strings shared with workspace.rs (git, path checks) are already in backend.ts.
const en: Record<string, string> = {
  // checkpoints.rs
  "Папка проекта не находится в git-репозитории": "Project folder is not inside a git repository",
  "Некорректный идентификатор точки сохранения": "Invalid checkpoint ID",
  "Точка сохранения не найдена": "Checkpoint not found",
  "Не удалось найти корень репозитория": "Could not find the repository root",
  "Не удалось прочитать файл из точки сохранения": "Could not read the file from the checkpoint",
};

export default en;
