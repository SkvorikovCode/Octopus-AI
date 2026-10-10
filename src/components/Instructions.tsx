import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  displayPath,
  getInstructions,
  readClaudeInstructions,
  saveInstructions,
  type Instructions,
  type InstructionsScope,
  type Scope,
} from "../lib/instructions";
import { t, tErr } from "../lib/i18n";
import "./settings.css";
import "./instructions.css";

export type InstructionsSectionProps = {
  /** Open project folder (absolute). Without it only the general instructions are shown. */
  project?: string;
  /** Home folder, used to show paths as "~/…". */
  home?: string;
  /** Absolute paths of the instruction files the running agent reads. */
  contextFiles?: string[];
  agentRunning: boolean;
  onNewSession?: () => void;
  /** Starts a new session in which the agent writes the project's instructions. */
  onGenerate?: (rel: string) => void;
};

type SaveError = { scope: InstructionsScope; text: string };

/** Settings → Инструкции: general instructions (all projects) and the current project's. */
export function InstructionsSection({
  project,
  home,
  contextFiles,
  agentRunning,
  onNewSession,
  onGenerate,
}: InstructionsSectionProps): ReactElement {
  const [data, setData] = useState<Instructions>();
  const [loadError, setLoadError] = useState<string>();
  const [globalDraft, setGlobalDraft] = useState("");
  const [projectDraft, setProjectDraft] = useState("");
  const [saving, setSaving] = useState<InstructionsScope | null>(null);
  const [saveError, setSaveError] = useState<SaveError>();
  const [saved, setSaved] = useState<InstructionsScope | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string>();
  // Latest request wins: an answer for an older project is dropped.
  const reqRef = useRef(0);

  const load = useCallback(async (cwd: string | undefined, resetDrafts: boolean) => {
    const id = ++reqRef.current;
    try {
      const next = await getInstructions(cwd ?? null);
      if (id !== reqRef.current) return;
      setData(next);
      setLoadError(undefined);
      if (resetDrafts) {
        setGlobalDraft(next.global.content);
        setProjectDraft(next.project?.content ?? "");
      }
    } catch (e) {
      if (id === reqRef.current) setLoadError(tErr(e));
    }
  }, []);

  // Mount and project change: fresh data and fresh editors.
  useEffect(() => {
    setData(undefined);
    setSaved(null);
    setSaveError(undefined);
    setImportError(undefined);
    void load(project, true);
  }, [project, load]);

  const projectScope: Scope | null = data?.project ?? null;
  const globalDirty = data !== undefined && globalDraft !== data.global.content;
  const projectDirty = projectScope !== null && projectDraft !== projectScope.content;
  const busy = saving !== null;

  const save = async (scope: InstructionsScope) => {
    const target = scope === "global" ? data?.global : projectScope;
    if (!target) return;
    const content = scope === "global" ? globalDraft : projectDraft;
    setSaving(scope);
    setSaveError(undefined);
    setSaved(null);
    try {
      await saveInstructions(scope, project ?? null, target.targetRel, content);
    } catch (e) {
      setSaveError({ scope, text: tErr(e) });
      setSaving(null);
      return;
    }
    setSaving(null);
    setSaved(scope);
    // Reload the state (exists, active file) but keep what the user has typed since.
    await load(project, false);
  };

  const importClaude = async () => {
    setImporting(true);
    setImportError(undefined);
    try {
      const text = (await readClaudeInstructions()).trim();
      if (text !== "") {
        setGlobalDraft((prev) => (prev.trim() === "" ? text : `${prev.replace(/\s+$/, "")}\n\n${text}`));
        setSaved(null);
      }
    } catch (e) {
      setImportError(tErr(e));
    } finally {
      setImporting(false);
    }
  };

  const generate = () => {
    if (!projectScope || !onGenerate) return;
    if (projectDirty && !window.confirm(t("Несохранённые изменения будут потеряны. Продолжить?"))) return;
    onGenerate(projectScope.targetRel);
  };

  const readingText = !agentRunning
    ? t("агент не запущен")
    : contextFiles && contextFiles.length > 0
      ? contextFiles.map((p) => displayPath(p, { project, home })).join(", ")
      : t("ничего — инструкций нет");

  const globalTitleId = useId();
  const projectTitleId = useId();

  return (
    <div className="ins">
      <p className="set-desc">
        {t("Инструкции агента — постоянные правила, которым он следует в каждой новой сессии.")}
      </p>
      <p className="ins-reading">
        <span className="ins-reading-label">{t("Агент сейчас читает:")}</span>{" "}
        <span className="ins-reading-files">{readingText}</span>
      </p>

      {loadError && <div className="err-card">{loadError}</div>}

      {!data && !loadError && <p className="set-desc">{t("Загружаем…")}</p>}

      {data && (
        <section className="card set-card" aria-labelledby={globalTitleId}>
          <header className="set-head">
            <h2 id={globalTitleId} className="label set-h">
              {t("Для всех проектов")}
            </h2>
            <p className="set-desc">{t("Действуют в любом проекте.")}</p>
          </header>

          {data.global.shadowed.length > 0 && <ShadowWarning scope={data.global} project={project} home={home} />}

          <textarea
            className="ins-text"
            aria-label={t("Инструкции для всех проектов")}
            rows={10}
            spellCheck={false}
            placeholder={t("Например: отвечай по-русски, без лишних пояснений")}
            value={globalDraft}
            disabled={busy}
            onChange={(e) => {
              setGlobalDraft(e.target.value);
              setSaved(null);
            }}
          />

          <div className="ins-actions">
            {globalDirty && <span className="ins-dirty">{t("не сохранено")}</span>}
            <span className="ins-spacer" />
            {data.claudeImport && (
              <button type="button" className="btn" disabled={importing || busy} onClick={() => void importClaude()}>
                {importing ? t("Загружаем…") : t("Взять из Claude Code")}
              </button>
            )}
            <button
              type="button"
              className="btn primary"
              disabled={!globalDirty || busy}
              onClick={() => void save("global")}
            >
              {saving === "global" ? t("Сохраняем…") : t("Сохранить")}
            </button>
          </div>

          {importError && <div className="err-card">{importError}</div>}
          {saveError?.scope === "global" && <div className="err-card">{saveError.text}</div>}
          {saved === "global" && <SavedBanner onNewSession={onNewSession} />}
        </section>
      )}

      {data &&
        (projectScope ? (
          <section className="card set-card" aria-labelledby={projectTitleId}>
            <header className="set-head">
              <h2 id={projectTitleId} className="label set-h">
                {t("Этот проект")}
              </h2>
              <p className="set-desc">{t("Действуют только в этом проекте.")}</p>
            </header>

            <div className="ins-file">
              <span className="ins-file-name">
                {t("Файл: {file}", { file: displayPath(projectScope.targetRel, { project, home }) })}
              </span>
              {!projectScope.exists && <span className="ins-new">{t("будет создан")}</span>}
            </div>

            {projectScope.shadowed.length > 0 && <ShadowWarning scope={projectScope} project={project} home={home} />}

            <textarea
              className="ins-text"
              aria-label={t("Инструкции этого проекта")}
              rows={10}
              spellCheck={false}
              placeholder={t("Например: отвечай по-русски, без лишних пояснений")}
              value={projectDraft}
              disabled={busy}
              onChange={(e) => {
                setProjectDraft(e.target.value);
                setSaved(null);
              }}
            />

            <div className="ins-actions">
              {projectDirty && <span className="ins-dirty">{t("не сохранено")}</span>}
              <span className="ins-spacer" />
              {onGenerate && (
                <button
                  type="button"
                  className="btn"
                  title={t("Агент изучит проект и сам напишет инструкции в новой сессии")}
                  disabled={busy}
                  onClick={generate}
                >
                  {t("Составить автоматически")}
                </button>
              )}
              <button
                type="button"
                className="btn primary"
                disabled={!projectDirty || busy}
                onClick={() => void save("project")}
              >
                {saving === "project" ? t("Сохраняем…") : t("Сохранить")}
              </button>
            </div>

            {saveError?.scope === "project" && <div className="err-card">{saveError.text}</div>}
            {saved === "project" && <SavedBanner onNewSession={onNewSession} />}
          </section>
        ) : (
          <p className="ins-hint">{t("Откройте проект, чтобы задать его инструкции.")}</p>
        ))}
    </div>
  );
}

/** Right under the saved editor, so it is seen where the button was pressed. */
function SavedBanner({ onNewSession }: { onNewSession?: () => void }): ReactElement {
  return (
    <div className="ins-banner" role="status">
      <span className="ins-banner-text">{t("Сохранено. Изменения действуют в новых сессиях.")}</span>
      {onNewSession && (
        <button type="button" className="btn ins-banner-btn" onClick={onNewSession}>
          {t("Новая сессия")}
        </button>
      )}
    </div>
  );
}

/** Shown when the agent ignores some instruction files because it reads only one per level. */
function ShadowWarning({
  scope,
  project,
  home,
}: {
  scope: Scope;
  project?: string;
  home?: string;
}): ReactElement | null {
  if (!scope.active || scope.shadowed.length === 0) return null;
  const opts = { project, home };
  return (
    <div className="ins-banner ins-warn" role="note">
      <span className="ins-banner-text">
        {t("Агент читает только один файл инструкций. Сейчас это {active}; эти файлы он не видит: {list}.", {
          active: displayPath(scope.active, opts),
          list: scope.shadowed.map((p) => displayPath(p, opts)).join(", "),
        })}
      </span>
    </div>
  );
}
