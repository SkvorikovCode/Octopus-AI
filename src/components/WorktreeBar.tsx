import { useEffect, useState, type ReactElement } from "react";
import { t, tErr } from "../lib/i18n";
import { DotSpinner } from "./Glyphs";
import "./worktree.css";

/** Dotted fork glyph: two nodes on the trunk, one branch node to the right. */
export function ForkGlyph({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="3.5" cy="2.5" r="1.6" strokeDasharray="0 2.6" />
      <circle cx="3.5" cy="11.5" r="1.6" strokeDasharray="0 2.6" />
      <circle cx="10.5" cy="4.5" r="1.6" strokeDasharray="0 2.6" />
      <path d="M3.5 4.1v5.8M10.5 6.1c0 2.4-7 1.6-7 3.8" />
    </svg>
  );
}

type Result = { files: string[]; conflicts: string[] };

export type WorktreeBarProps = {
  /** "octopus/fix-login-3fa1" */
  branch: string;
  changedFiles?: number;
  /** Agent running: actions are disabled. */
  busy?: boolean;
  onApply: () => Promise<{ files: string[]; conflicts: string[] }>;
  onRemove: () => Promise<void>;
  /** Opens the main project's changes panel after apply. */
  onOpenChanges?: () => void;
};

/** Bar above the composer for a session that runs in its own project copy. */
export function WorktreeBar({ branch, changedFiles, busy = false, onApply, onRemove, onOpenChanges }: WorktreeBarProps): ReactElement {
  const [pending, setPending] = useState<"apply" | "remove" | null>(null);
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Delete needs a second click; the armed state disarms after 3 s.
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [armed]);

  const locked = busy || pending !== null;
  const busyTitle = busy ? t("Дождитесь, пока агент закончит") : undefined;

  const apply = async () => {
    if (locked) return;
    setArmed(false);
    setError(null);
    setResult(null);
    setPending("apply");
    try {
      setResult(await onApply());
    } catch (e) {
      setError(tErr(e));
    } finally {
      setPending(null);
    }
  };

  const remove = async () => {
    if (locked) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setError(null);
    setPending("remove");
    try {
      await onRemove();
    } catch (e) {
      setError(tErr(e));
    } finally {
      setPending(null);
    }
  };

  const conflicts = result?.conflicts ?? [];

  return (
    <div className="worktree-dock">
      <div className="worktree-bar" role="region" aria-label={t("Отдельная копия")}>
        <span className="wt-label">
          <ForkGlyph size={13} />
          <span>{t("Отдельная копия")}</span>
        </span>
        <span className="wt-branch mono" title={branch}>
          {branch}
        </span>
        {changedFiles !== undefined && <span className="wt-count mono">{t("{n} изм.", { n: changedFiles })}</span>}
        <span className="wt-grow" />
        <div className="wt-actions">
          <button
            type="button"
            className="wt-btn wt-btn-primary"
            onClick={apply}
            disabled={locked}
            title={busyTitle ?? t("Перенести изменения из копии в папку проекта")}
          >
            {pending === "apply" && <DotSpinner size={12} />}
            <span>{t("Перенести в проект")}</span>
          </button>
          <button
            type="button"
            className={`wt-btn${armed ? " is-armed" : ""}`}
            onClick={remove}
            disabled={locked}
            title={busyTitle ?? t("Удалить папку копии и её ветку")}
          >
            {pending === "remove" && <DotSpinner size={12} />}
            <span>{armed ? t("Удалить копию и ветку?") : t("Удалить копию")}</span>
          </button>
        </div>
      </div>

      {(result || error) && (
        <div className="wt-result" role="status" aria-live="polite">
          {error && <div className="wt-error">{error}</div>}
          {result && (
            <div className="wt-result-row">
              <span className="mono">{t("Перенесено файлов: {n}", { n: result.files.length })}</span>
              {onOpenChanges && (
                <button type="button" className="wt-link" onClick={onOpenChanges}>
                  {t("Посмотреть изменения")}
                </button>
              )}
            </div>
          )}
          {conflicts.length > 0 && (
            <div className="wt-conflict">
              <span className="mono">{t("Конфликты: {list}", { list: conflicts.join(", ") })}</span>
              <span className="wt-conflict-hint">{t("Разрешите конфликты в файлах проекта")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
