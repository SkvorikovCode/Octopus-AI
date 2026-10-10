import { useState, type KeyboardEvent } from "react";
import type { TodoPhase, TodoTask } from "../lib/session";
import { t } from "../lib/i18n";
import "./plan.css";

type Props = {
  phases: TodoPhase[];
  /** The agent's closing text; shown when it did not write the plan as a todo list. */
  summary?: string;
  onApprove: () => void;
  onRevise: (feedback: string) => void;
  onDismiss: () => void;
  busy?: boolean;
};

// Same dotted checkbox as PlanTile in Tiles.tsx.
const TASK_MARK: Record<TodoTask["status"], { stroke: string; check: boolean; dash: string }> = {
  completed: { stroke: "var(--ink)", check: true, dash: "0 3.2" },
  in_progress: { stroke: "var(--accent)", check: false, dash: "0 3.2" },
  pending: { stroke: "var(--dim)", check: false, dash: "0 3.2" },
  blocked: { stroke: "var(--accent)", check: false, dash: "1.5 2" },
  abandoned: { stroke: "var(--dim)", check: false, dash: "1.5 2" },
};

function TaskRow({ task }: { task: TodoTask }) {
  const mark = TASK_MARK[task.status] ?? TASK_MARK.pending;
  const muted = task.status === "completed" || task.status === "abandoned";
  return (
    <div className={`plan-task${muted ? " is-muted" : ""}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" strokeLinecap="round" aria-hidden="true">
        <rect x="1.5" y="1.5" width="11" height="11" rx="3" stroke={mark.stroke} strokeWidth="1.8" strokeDasharray={mark.dash} />
        {mark.check && <path d="M4.2 7.2l2 2 3.8-4.2" stroke="var(--ink)" strokeWidth="1.6" />}
        {task.status === "in_progress" && <circle cx="7" cy="7" r="1.8" fill="var(--accent)" />}
      </svg>
      <span className={task.status === "abandoned" ? "plan-task-struck" : undefined}>{task.content}</span>
    </div>
  );
}

/** Shown under the thread when a plan-first turn ends: the plan, then approve, revise or hide. */
export function PlanCard({ phases, summary, onApprove, onRevise, onDismiss, busy = false }: Props) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  const tasks = phases.flatMap((p) => p.tasks);
  const total = tasks.length;
  const done = tasks.filter((x) => x.status === "completed").length;
  const groups = phases.filter((p) => p.tasks.length > 0);
  const canSend = !busy && feedback.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    onRevise(feedback.trim());
    setFeedback("");
    setRevising(false);
  };

  const cancelRevise = () => {
    setFeedback("");
    setRevising(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRevise();
    }
  };

  return (
    <div className="plan-dock">
      <section className="card plan-card" aria-label={t("План")}>
        <div className="plan-head">
          <span className="plan-label">{t("ПЛАН ГОТОВ")}</span>
          {total > 0 && (
            <span className="plan-count">
              {done}
              <span>/{total}</span>
            </span>
          )}
        </div>

        {total > 0 ? (
          <div className="plan-tasks">
            {groups.map((p, i) => (
              <div key={`${p.name}-${i}`} className="plan-phase">
                {groups.length > 1 && <div className="plan-phase-name">{p.name}</div>}
                {p.tasks.map((task, j) => (
                  <TaskRow key={j} task={task} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="plan-summary">
            {summary?.trim() || t("Агент не записал план списком — посмотрите его ответ выше.")}
          </div>
        )}

        {revising && (
          <textarea
            className="plan-revise-input"
            autoFocus
            rows={3}
            value={feedback}
            placeholder={t("Что изменить в плане?")}
            aria-label={t("Что изменить в плане?")}
            spellCheck={false}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}

        <div className="plan-actions">
          {revising ? (
            <>
              <button type="button" className="plan-primary" onClick={send} disabled={!canSend} aria-label={t("Отправить")}>
                {t("Отправить")}
              </button>
              <button type="button" className="plan-secondary" onClick={cancelRevise}>
                {t("Отмена")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="plan-primary" onClick={onApprove} disabled={busy}>
                {t("Выполнить план")}
              </button>
              <button type="button" className="plan-secondary" onClick={() => setRevising(true)} disabled={busy}>
                {t("Поправить")}
              </button>
            </>
          )}
          <button type="button" className="plan-text" onClick={onDismiss}>
            {t("Скрыть")}
          </button>
        </div>
      </section>
    </div>
  );
}
