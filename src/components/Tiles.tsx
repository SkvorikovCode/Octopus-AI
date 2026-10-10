import { useEffect, useState } from "react";
import type { SessionState, TodoPhase, TodoTask } from "../lib/session";
import { DotRing, Face } from "./Glyphs";
import { formatCost } from "../lib/stats";
import { t } from "../lib/i18n";

const WORD: Record<SessionState["status"], string> = {
  offline: "OFFLINE",
  starting: "BOOTING",
  idle: "READY",
  thinking: "THINKING",
  working: "WORKING",
  waiting: "WAITING",
};

const STATUS_RU: Record<SessionState["status"], string> = {
  offline: "не запущен",
  starting: "запуск",
  idle: "готов",
  thinking: "думает",
  working: "работает",
  waiting: "ждёт вас",
};

export function Tiles({ s, onCompact }: { s: SessionState; onCompact: () => void }) {
  const busy = s.status === "working" || s.status === "thinking";
  const elapsed = useElapsed(s.turnStartedAt, s.turnEndedAt);
  const mood = s.status === "offline" || s.status === "starting" ? "off" : s.status === "waiting" ? "waiting" : busy ? "busy" : "idle";
  const live = busy || s.status === "waiting";

  return (
    <aside className="tiles" aria-label={t("Состояние сессии")}>
      <section className="card tile">
        <div className="tile-head">
          <span><span className="n">01</span>&nbsp; {t("АГЕНТ")}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, color: live ? "var(--accent)" : "var(--ink-3)" }}>
            <span className={`dot ${live ? "on pulse" : s.status === "idle" ? "ok" : ""}`} />
            {t(STATUS_RU[s.status]).toUpperCase()}
          </span>
        </div>
        <div className="tile-big" style={{ fontSize: 30 }}>
          {WORD[s.status]}{live && <span className="pulse">_</span>}
        </div>
        <Face mood={mood} />
        <div className="tile-grid">
          <div><div className="tile-k">{t("ШАГИ")}</div><div className="tile-v">{s.turnSteps}</div></div>
          <div><div className="tile-k">{t("ИНСТР.")}</div><div className="tile-v">{s.stats?.tools ?? 0}</div></div>
          <div><div className="tile-k">{t("ВРЕМЯ")}</div><div className="tile-v">{elapsed}</div></div>
        </div>
      </section>

      <section className="card tile">
        <div className="tile-head"><span><span className="n">02</span>&nbsp; {t("ТОКЕНЫ")}</span><span style={{ color: "var(--ink-3)" }}>{t("сессия")}</span></div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span className="tile-big" style={{ fontSize: 40 }}>{compact(s.stats?.tokens ?? 0)}</span>
          {s.stats?.cost ? <span style={{ fontSize: 13, color: "var(--ink-3)" }}>{formatCost(s.stats.cost)}</span> : null}
        </div>
      </section>

      {s.plan && s.plan.some((p) => p.tasks.length > 0) && <PlanTile phases={s.plan} />}

      <section className="card tile" style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <div style={{ position: "relative", width: 104, height: 104, flexShrink: 0 }}>
          <DotRing percent={s.context?.percent ?? 0} />
          <div className="tile-big" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 24 }}>
            {Math.round(s.context?.percent ?? 0)}%
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div className="tile-head"><span><span className="n">03</span>&nbsp; {t("КОНТЕКСТ")}</span></div>
          <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
            {s.context ? t("{used} из {total}", { used: compact(s.context.tokens), total: compact(s.context.window) }) : t("нет данных")}
          </div>
          <button className="chip" style={{ alignSelf: "flex-start", height: 28, fontSize: 12 }} onClick={onCompact} disabled={s.status !== "idle"}>
            {t("Сжать")}
          </button>
        </div>
      </section>
    </aside>
  );
}

const TASK_MARK: Record<TodoTask["status"], { stroke: string; check: boolean; dash: string }> = {
  completed: { stroke: "var(--ink)", check: true, dash: "0 3.2" },
  in_progress: { stroke: "var(--accent)", check: false, dash: "0 3.2" },
  pending: { stroke: "var(--dim)", check: false, dash: "0 3.2" },
  blocked: { stroke: "var(--accent)", check: false, dash: "1.5 2" },
  abandoned: { stroke: "var(--dim)", check: false, dash: "1.5 2" },
};

function PlanTile({ phases }: { phases: TodoPhase[] }) {
  const tasks = phases.flatMap((p) => p.tasks);
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <section className="card tile">
      <div className="tile-head">
        <span><span className="n">04</span>&nbsp; {t("ПЛАН")}</span>
        <span className="tile-big" style={{ fontSize: 18 }}>{done}<span style={{ color: "var(--dim)" }}>/{tasks.length}</span></span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 260, overflowY: "auto" }}>
        {phases.filter((p) => p.tasks.length > 0).map((p, i) => (
          <div key={`${p.name}-${i}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {phases.length > 1 && <div className="tile-k">{p.name}</div>}
            {p.tasks.map((t, j) => {
              const mark = TASK_MARK[t.status] ?? TASK_MARK.pending;
              const muted = t.status === "completed" || t.status === "abandoned";
              return (
                <div key={j} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: muted ? "var(--mute)" : "var(--ink-2)" }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" strokeLinecap="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 3 }}>
                    <rect x="1.5" y="1.5" width="11" height="11" rx="3" stroke={mark.stroke} strokeWidth="1.8" strokeDasharray={mark.dash} />
                    {mark.check && <path d="M4.2 7.2l2 2 3.8-4.2" stroke="var(--ink)" strokeWidth="1.6" />}
                    {t.status === "in_progress" && <circle cx="7" cy="7" r="1.8" fill="var(--accent)" />}
                  </svg>
                  <span style={{ textDecoration: t.status === "abandoned" ? "line-through" : undefined }}>{t.content}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

function compact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** Turn duration: ticks while running, then freezes at the end time. */
function useElapsed(since?: number, until?: number) {
  const [now, setNow] = useState(Date.now());
  const running = !!since && !until;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, since]);
  if (!since) return "0:00";
  const sec = Math.max(0, Math.floor(((until ?? now) - since) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
