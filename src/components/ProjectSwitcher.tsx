import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { projectName } from "../lib/projects";
import type { RecentProject } from "../lib/projects";
import { t } from "../lib/i18n";
import "./projects.css";

const DISABLED_HINT = "Дождитесь, пока агент закончит";
const PATH_MAX = 42;

/** Shortens a path from the start, keeping its last segments: "…/Documents/GitHub/app". */
function tailPath(path: string, max = PATH_MAX): string {
  if (path.length <= max) return path;
  let cut = path.length;
  for (let i = path.length - 1; i >= 0; i--) {
    const ch = path[i];
    if (ch !== "/" && ch !== "\\") continue;
    if (path.length - i + 1 > max) break;
    cut = i;
  }
  return cut < path.length ? `…${path.slice(cut)}` : `…${path.slice(-(max - 1))}`;
}

type Props = {
  current?: string;
  recent: RecentProject[];
  onSwitch: (path: string) => void;
  onBrowse: () => void;
  onForget: (path: string) => void;
  disabled?: boolean;
};

export function ProjectSwitcher({
  current,
  recent,
  onSwitch,
  onBrowse,
  onForget,
  disabled = false,
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Close on outside mousedown and on Escape while the popover is open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Move focus into the menu when it opens (first enabled item).
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(
      popRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next =
      idx === -1 ? (step === 1 ? 0 : items.length - 1) : (idx + step + items.length) % items.length;
    items[next].focus();
  };

  const choose = (path: string) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (path !== current) onSwitch(path);
  };

  const forget = (e: ReactMouseEvent<HTMLButtonElement>, path: string) => {
    e.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
    onForget(path);
  };

  const browse = () => {
    setOpen(false);
    onBrowse();
  };

  const label = current ? projectName(current) : t("выбрать папку");

  return (
    <div ref={wrapRef} className="prj-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="prj-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={current ?? t("Выбрать папку")}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          className="prj-icon"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span className="prj-trigger-name">{label}</span>
        <svg
          className={open ? "prj-chev is-open" : "prj-chev"}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          id={menuId}
          ref={popRef}
          className="prj-pop"
          role="menu"
          aria-label={t("Недавние проекты")}
          onKeyDown={onMenuKey}
        >
          <div className="prj-head" role="presentation">
            {t("Недавние проекты")}
          </div>

          {disabled && <div className="prj-hint">{t(DISABLED_HINT)}</div>}

          {recent.length === 0 ? (
            <div className="prj-empty">{t("Пока пусто")}</div>
          ) : (
            <div className="prj-list" role="group" aria-label={t("Недавние проекты")}>
              {recent.map((p) => {
                const isCurrent = p.path === current;
                return (
                  <div key={p.path} className="prj-row">
                    <button
                      type="button"
                      role="menuitem"
                      className="prj-item"
                      aria-current={isCurrent ? "true" : undefined}
                      disabled={disabled}
                      title={disabled ? `${p.path} — ${t(DISABLED_HINT)}` : p.path}
                      onClick={() => choose(p.path)}
                    >
                      <span className={isCurrent ? "prj-dot is-current" : "prj-dot"} aria-hidden="true" />
                      <span className="prj-item-text">
                        <span className="prj-item-name">{p.name || projectName(p.path)}</span>
                        <span className="prj-item-path">{tailPath(p.path)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="prj-forget"
                      aria-label={t("Убрать из списка")}
                      title={t("Убрать из списка")}
                      onClick={(e) => forget(e, p.path)}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="prj-sep" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="prj-browse"
            disabled={disabled}
            title={disabled ? t(DISABLED_HINT) : undefined}
            onClick={browse}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>{t("Открыть папку…")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
