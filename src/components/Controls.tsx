import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Icon } from "./Glyphs";
import { t } from "../lib/i18n";
import "./controls.css";

export type ApprovalMode = "always-ask" | "write" | "yolo";

/** One line for the home screen: what the agent may do on its own in this mode. */
export const APPROVAL_LEAD: Record<ApprovalMode, string> = {
  "always-ask": "спрашивает, прежде чем менять файлы или запускать команды",
  write: "правит файлы сам, спрашивает перед запуском команд",
  yolo: "действует без вопросов",
};
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const APPROVAL_DOTS: Record<ApprovalMode, number> = { "always-ask": 1, write: 2, yolo: 3 };

const APPROVAL_OPTIONS: { value: ApprovalMode; title: string; desc: string; badge?: string; warn?: boolean }[] = [
  { value: "always-ask", title: "Спрашивать перед изменениями", desc: "Читает сам; правки файлов и команды — с вашего разрешения" },
  { value: "write", title: "Спрашивать перед командами", desc: "Читает и правит файлы сам; команды в терминале — с разрешения", badge: "по умолчанию" },
  { value: "yolo", title: "Без вопросов", desc: "Агент делает всё сам. Только для доверенных папок", warn: true },
];

const THINKING_LABELS: Record<string, string | undefined> = {
  off: "выкл",
  minimal: "минимум",
  low: "низкое",
  medium: "среднее",
  high: "высокое",
  xhigh: "очень высокое",
  max: "максимум",
};

const thinkingLabel = (level: string): string => t(THINKING_LABELS[level] ?? level);

/** Three-dot meter: the first `level` dots are accent, the rest are dim. */
function DotMeter({ level }: { level: number }): ReactElement {
  return (
    <span className="ctl-dots" aria-hidden="true">
      {[1, 2, 3].map((i) => (
        <span key={i} className={i <= level ? "ctl-dot on" : "ctl-dot"} />
      ))}
    </span>
  );
}

/** Closes a popover on outside mousedown or Escape. Listeners exist only while `active`. */
function useDismiss(active: boolean, wrapRef: { current: HTMLElement | null }, onDismiss: (viaKeyboard: boolean) => void): void {
  const handler = useRef(onDismiss);
  useEffect(() => {
    handler.current = onDismiss;
  });
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) handler.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handler.current(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, wrapRef]);
}

export function AutonomyPicker({
  value,
  disabled,
  onChange,
}: {
  value: ApprovalMode;
  disabled: boolean;
  onChange: (m: ApprovalMode) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const showing = open && !disabled;

  const dismiss = useCallback((viaKeyboard: boolean) => {
    setOpen(false);
    if (viaKeyboard) btnRef.current?.focus();
  }, []);
  useDismiss(showing, wrapRef, dismiss);

  const current = APPROVAL_OPTIONS.find((o) => o.value === value);

  return (
    <div className="ctl-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="ctl-pill"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={showing}
        title={current ? t("Автономия: {name}", { name: t(current.title) }) : t("Автономия")}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ctl-label">{t("Автономия")}</span>
        <DotMeter level={APPROVAL_DOTS[value]} />
      </button>
      {showing && (
        <div className="ctl-pop" role="menu" aria-label={t("Автономия")}>
          {APPROVAL_OPTIONS.map((o) => {
            const checked = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className="ctl-opt"
                autoFocus={checked}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <DotMeter level={APPROVAL_DOTS[o.value]} />
                <span className="ctl-opt-text">
                  <span className="ctl-opt-title">
                    <span className="ctl-opt-name">{t(o.title)}</span>
                    {o.badge && <span className="ctl-badge">{t(o.badge)}</span>}
                  </span>
                  <span className={o.warn ? "ctl-opt-desc warn" : "ctl-opt-desc"}>{t(o.desc)}</span>
                </span>
                {checked && (
                  <span className="ctl-check">
                    <Icon name="check" size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ThinkingPicker({
  value,
  levels,
  disabled,
  onChange,
}: {
  value?: string;
  levels: string[];
  disabled: boolean;
  onChange: (l: string) => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const showing = open && !disabled && levels.length > 0;

  const dismiss = useCallback((viaKeyboard: boolean) => {
    setOpen(false);
    if (viaKeyboard) btnRef.current?.focus();
  }, []);
  useDismiss(showing, wrapRef, dismiss);

  if (levels.length === 0) return null;

  return (
    <div className="ctl-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="ctl-pill"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={showing}
        // In a narrow composer the word is hidden: the tooltip and name still say what this is.
        title={`${t("Мышление")}: ${value === undefined ? "—" : thinkingLabel(value)}`}
        aria-label={`${t("Мышление")}: ${value === undefined ? "—" : thinkingLabel(value)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ctl-label">{t("Мышление")}</span>
        <span className="ctl-pill-value">{value === undefined ? "—" : thinkingLabel(value)}</span>
      </button>
      {showing && (
        <div className="ctl-pop" role="menu" aria-label={t("Мышление")}>
          {levels.map((level) => {
            const checked = level === value;
            return (
              <button
                key={level}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className="ctl-opt"
                autoFocus={checked}
                onClick={() => {
                  onChange(level);
                  setOpen(false);
                }}
              >
                <span className="ctl-opt-text">
                  <span className="ctl-opt-title">{thinkingLabel(level)}</span>
                </span>
                {checked && (
                  <span className="ctl-check">
                    <Icon name="check" size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
