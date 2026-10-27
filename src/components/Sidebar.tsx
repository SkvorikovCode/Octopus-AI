import { Fragment, useEffect, useRef, useState } from "react";
import type { Status } from "../lib/session";
import { relativeTime, type SessionMeta } from "../lib/sessions";
import type { RecentProject } from "../lib/projects";
import { displayTitle, rename, toggleArchive, togglePin, useSessionPrefs } from "../lib/sessionPrefs";
import { DotSpinner, Icon, Logo } from "./Glyphs";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { modKey } from "../lib/platform";
import { t } from "../lib/i18n";
import { ForkGlyph } from "./WorktreeBar";
import "./sidebar.css";

export type View = "session" | "swarm" | "settings" | "stats" | "connections";

type Props = {
  project?: string;
  status: Status;
  view: View;
  sessions: SessionMeta[];
  activeSessionId?: string;
  /** Sessions whose agent runs (maybe in the background), waits for you, or finished unseen. */
  activity?: ReadonlyMap<string, "running" | "waiting" | "unread">;
  /** Sessions that run in a separate project copy: session id → branch. */
  worktreeOf?: ReadonlyMap<string, string>;
  swarmActive: number;
  swarmTotal: number;
  onNewSession: () => void;
  onOpenSession: (s: SessionMeta) => void;
  onDeleteSession: (s: SessionMeta) => void;
  /** Called after a rename of the open session with the new (trimmed, non-empty, changed) name, so the agent can be renamed too. */
  onRenameActive?: (name: string) => void;
  onOpenSwarm: () => void;
  onPickProject: () => void;
  recentProjects: RecentProject[];
  onSwitchProject: (path: string) => void;
  onForgetProject: (path: string) => void;
  onOpenSettings: () => void;
  onOpenStats?: () => void;
  /** Shows the nav item only when the app wires the Connections screen. */
  onOpenConnections?: () => void;
  onRestart: () => void;
  /** Shown above the settings button, e.g. a new release. */
  updateSlot?: React.ReactNode;
};

const ENGINE: Record<Status, string> = {
  offline: "Агент не запущен",
  starting: "Агент запускается…",
  idle: "Агент готов",
  thinking: "Агент думает",
  working: "Агент работает",
  waiting: "Агент ждёт ответа",
};

type Group = "today" | "yesterday" | "week" | "earlier";

/** Local-time bucket of an update time: today, yesterday, the 5 days before that, or earlier. */
function dateGroup(ms: number, now: number): Group {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return "today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (ms >= yesterday.getTime()) return "yesterday";
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  if (ms >= week.getTime()) return "week";
  return "earlier";
}

function groupTitle(g: Group): string {
  switch (g) {
    case "today":
      return t("Сегодня");
    case "yesterday":
      return t("Вчера");
    case "week":
      return t("На этой неделе");
    default:
      return t("Раньше");
  }
}

function PinGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="0 3" aria-hidden="true">
      {/* Pushpin: a dotted head and a short needle, readable at 13px. */}
      <circle cx="8" cy="6" r="4" />
      <path d="M8 10.5V15" />
    </svg>
  );
}

function BoxGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="0 3" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="3" rx="1" />
      <path d="M3 5.5v8h10v-8M6.5 9h3" />
    </svg>
  );
}

function PencilGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="0 3" aria-hidden="true">
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    </svg>
  );
}

/** Inline title editor: Enter saves, Esc cancels, blur saves. Settles only once. */
function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const settled = useRef(false);
  const finish = (v: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(v);
  };
  return (
    <input
      className="session-rename"
      value={value}
      autoFocus
      aria-label={t("Переименовать")}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

export function Sidebar(p: Props) {
  // Two-step delete: first click arms the row for 3 s, second click deletes.
  const [armed, setArmed] = useState<string>();
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(undefined), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  // Session id being renamed inline, and whether the archive list is expanded.
  const [editing, setEditing] = useState<string>();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const prefs = useSessionPrefs();

  const live = p.status === "working" || p.status === "thinking" || p.status === "waiting";
  const ready = p.status !== "offline" && p.status !== "starting";

  const pinnedIds = new Set(prefs.pinned);
  const archivedIds = new Set(prefs.archived);
  const isLive = (id: string) => {
    const a = p.activity?.get(id);
    return a === "running" || a === "waiting";
  };
  // Archived sessions are hidden, except the ones that still run (active work stays visible).
  // The open session and running ones stay visible even when archived.
  const isHidden = (s: SessionMeta) => archivedIds.has(s.id) && !isLive(s.id) && s.id !== p.activeSessionId;

  const sorted = [...p.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const hidden = sorted.filter(isHidden);
  const visible = sorted.filter((s) => !isHidden(s));
  const pinnedRows = visible.filter((s) => pinnedIds.has(s.id));
  const now = Date.now();
  const groups: { key: Group; rows: SessionMeta[] }[] = [];
  for (const s of visible) {
    if (pinnedIds.has(s.id)) continue;
    const key = dateGroup(s.updatedAt, now);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, rows: [] };
      groups.push(g);
    }
    g.rows.push(s);
  }

  const finishRename = (s: SessionMeta, before: string, value: string | null) => {
    setEditing(undefined);
    if (value === null) return;
    rename(s.id, value);
    const next = value.trim();
    if (next && next !== before && s.id === p.activeSessionId && p.onRenameActive) p.onRenameActive(next);
  };

  const renderRow = (s: SessionMeta) => {
    const active = s.id === p.activeSessionId && p.view === "session";
    const act = p.activity?.get(s.id);
    const running = act === "running" || act === "waiting";
    const isArmed = armed === s.path;
    const branch = p.worktreeOf?.get(s.id);
    const title = displayTitle(s, prefs);
    const pinned = pinnedIds.has(s.id);
    const archived = archivedIds.has(s.id);
    const isEditing = editing === s.id;
    const meta = (
      <>
        {branch !== undefined && (
          <span className="session-fork" title={branch}>
            <ForkGlyph size={12} />
          </span>
        )}
        {isEditing ? (
          <RenameInput initial={title} onDone={(v) => finishRename(s, title, v)} />
        ) : (
          <span className="session-title" onDoubleClick={() => setEditing(s.id)}>
            {title}
          </span>
        )}
        {act === "waiting" ? (
          <span className="dot on pulse" title={t("Ждёт вашего ответа")} />
        ) : running ? (
          <DotSpinner size={12} />
        ) : act === "unread" ? (
          <span className="dot on" title={t("Готово — ещё не просмотрено")} />
        ) : (
          <span className="session-time">{relativeTime(s.updatedAt)}</span>
        )}
      </>
    );
    return (
      <div
        key={s.path}
        className={`session-row ${active ? "current" : ""} ${archived ? "archived" : ""} ${isEditing ? "editing" : ""}`}
      >
        {isEditing ? (
          <div className="session-item session-item-edit">{meta}</div>
        ) : (
          <button className="session-item" onClick={() => p.onOpenSession(s)} title={title}>
            {meta}
          </button>
        )}
        {!isEditing && (
          <div className={`session-acts ${isArmed ? "armed" : ""}`}>
            <button
              type="button"
              className={`session-act ${pinned ? "on" : ""}`}
              aria-pressed={pinned}
              aria-label={pinned ? t("Открепить") : t("Закрепить")}
              title={pinned ? t("Открепить") : t("Закрепить")}
              onClick={() => togglePin(s.id)}
            >
              <PinGlyph />
            </button>
            <button
              type="button"
              className={`session-act ${archived ? "on" : ""}`}
              aria-label={archived ? t("Из архива") : t("В архив")}
              title={archived ? t("Из архива") : t("В архив")}
              onClick={() => toggleArchive(s.id)}
            >
              <BoxGlyph />
            </button>
            <button
              type="button"
              className="session-act"
              aria-label={t("Переименовать")}
              title={t("Переименовать")}
              onClick={() => setEditing(s.id)}
            >
              <PencilGlyph />
            </button>
            {s.id !== p.activeSessionId && !running && (
              <button
                type="button"
                className={`session-del ${isArmed ? "armed" : ""}`}
                aria-label={isArmed ? t("Точно удалить «{title}»?", { title }) : t("Удалить «{title}»", { title })}
                title={isArmed ? t("Нажмите ещё раз, чтобы удалить") : t("Удалить сессию")}
                onClick={() => {
                  if (isArmed) {
                    setArmed(undefined);
                    p.onDeleteSession(s);
                  } else setArmed(s.path);
                }}
              >
                {isArmed ? <span className="mono" style={{ fontSize: 10 }}>{t("удалить?")}</span> : <Icon name="close" size={11} />}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="card sidebar">
      <div className="sidebar-top drag" data-tauri-drag-region />

      <div className="brand drag" data-tauri-drag-region>
        <Logo size={30} />
        <span className="brand-word">OCTOPUS</span>
      </div>

      <button className="btn-new" onClick={p.onNewSession} disabled={!ready}>
        <Icon name="plus" size={14} />
        <span>{t("Новая сессия")}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--mute)" }}>{modKey("N")}</span>
      </button>

      <nav className="side-nav" aria-label={t("Разделы")}>
        <button className={`side-btn ${p.view === "swarm" ? "current" : ""}`} onClick={p.onOpenSwarm} disabled={!p.project}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="0 3" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>
          <span style={{ flex: 1 }}>{t("Рой агентов")}</span>
          {p.swarmActive > 0 ? (
            <span className="mono" style={{ fontSize: 11, color: "var(--accent-ink)" }}>{p.swarmActive} ●</span>
          ) : p.swarmTotal > 0 ? (
            <span className="mono" style={{ fontSize: 11, color: "var(--mute)" }}>{p.swarmTotal}</span>
          ) : null}
        </button>
      </nav>

      <div className="side-section side-sessions">
        <div className="side-project">
          <span className="label">{t("Проект")}</span>
          <ProjectSwitcher
            current={p.project}
            recent={p.recentProjects}
            onSwitch={p.onSwitchProject}
            onBrowse={p.onPickProject}
            onForget={p.onForgetProject}
            disabled={false}
          />
        </div>
        {p.project && p.sessions.length === 0 && (
          <div className="side-empty">{t("Сессий пока нет — начните с задачи.")}</div>
        )}
        <div className="session-list">
          {pinnedRows.length > 0 && (
            <>
              <div className="label group-label">{t("Закреплённые")}</div>
              {pinnedRows.map((s) => renderRow(s))}
            </>
          )}
          {groups.map((g) => (
            <Fragment key={g.key}>
              <div className="label group-label">{groupTitle(g.key)}</div>
              {g.rows.map((s) => renderRow(s))}
            </Fragment>
          ))}
          {hidden.length > 0 && (
            <>
              <button
                type="button"
                className="side-archive-toggle"
                aria-expanded={archiveOpen}
                onClick={() => setArchiveOpen((o) => !o)}
              >
                <Icon name={archiveOpen ? "chevron-down" : "chevron-right"} size={11} />
                <span>{t("Архив · {n}", { n: hidden.length })}</span>
              </button>
              {archiveOpen && (
                <>
                  <div className="label group-label">{t("Архив")}</div>
                  {hidden.map((s) => renderRow(s))}
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="side-foot">
        {p.onOpenConnections && (
          <button
            className={`side-btn ${p.view === "connections" ? "current" : ""}`}
            onClick={p.onOpenConnections}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="0 3" aria-hidden="true"><path d="M5.5 1.5v3.5M10.5 1.5v3.5M3.5 5h9v3a4.5 4.5 0 01-9 0V5zM8 12.5v2" /></svg>
            {t("Подключения")}
          </button>
        )}
        {p.onOpenStats && (
          <button className={`side-btn ${p.view === "stats" ? "current" : ""}`} onClick={p.onOpenStats}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="0 3" aria-hidden="true"><path d="M3 14V9M8 14V3M13 14V6" /></svg>
            {t("Статистика")}
          </button>
        )}
        {p.updateSlot}
        <button className={`side-btn ${p.view === "settings" || p.view === "stats" || p.view === "connections" ? "current" : ""}`} onClick={p.onOpenSettings}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.4" /><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15M3 3l1.6 1.6M11.4 11.4L13 13M3 13l1.6-1.6M11.4 4.6L13 3" /></svg>
          {t("Настройки")}
        </button>
        <div className="engine-row">
          <span className={`dot ${live ? "on pulse" : p.status === "idle" ? "ok" : ""}`} />
          <span style={{ flex: 1 }}>{t(ENGINE[p.status])}</span>
          {p.project && (
            <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={p.onRestart} aria-label={t("Перезапустить агента")} title={t("Перезапустить агента")}>
              <Icon name="refresh" size={13} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
