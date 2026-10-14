import { useEffect, useRef, useState } from "react";
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

type TilesProps = { s: SessionState; onCompact: () => void };

/** Full mode: the column of tiles on the right. */
export function Tiles({ s, onCompact }: TilesProps) {
  return (
    <aside className="tiles" aria-label={t("Состояние сессии")}>
      <AgentTile s={s} />
      <ContextTile s={s} onCompact={onCompact} />
      {hasPlan(s) && <PlanTile phases={s.plan!} />}
    </aside>
  );
}

/** Window width (at 100% scale) below which the column squeezes the chat: tiles go compact. */
const FULL_MIN_WIDTH = 1320;

/** The mode actually shown: the setting, overridden to compact while the window is too narrow. */
export function useTilesMode(mode: "full" | "compact", scale: number): "full" | "compact" {
  const min = Math.round(FULL_MIN_WIDTH * scale);
  const [narrow, setNarrow] = useState(() => window.innerWidth < min);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${min - 1}px)`);
    setNarrow(mq.matches);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [min]);
  return mode === "compact" || narrow ? "compact" : "full";
}

type DotKey = "agent" | "context" | "plan";

/**
 * Compact mode: a ring per tile under the composer; a click opens that tile as a popover above.
 */
export function TileDots({ s, onCompact }: TilesProps) {
  const [open, setOpen] = useState<DotKey | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const plan = hasPlan(s);
  // The plan ring goes away with the plan: don't leave its popover hanging.
  useEffect(() => {
    if (open === "plan" && !plan) setOpen(null);
  }, [open, plan]);

  const tasks = plan ? s.plan!.flatMap((p) => p.tasks) : [];
  const done = tasks.filter((x) => x.status === "completed").length;
  const ctx = s.context?.percent ?? 0;
  const live = isBusy(s) || s.status === "waiting";

  const dots: { key: DotKey; label: string; ring: React.ReactNode }[] = [
    {
      key: "agent",
      label: `${t("Агент")}: ${t(STATUS_RU[s.status])}`,
      ring: <AgentRing status={s.status} />,
    },
    {
      key: "context",
      label: `${t("Контекст")}: ${Math.round(ctx)}%${s.stats?.cost ? ` · ${formatCost(s.stats.cost)}` : ""}`,
      ring: <MiniRing percent={ctx} />,
    },
    ...(plan
      ? [{ key: "plan" as const, label: `${t("План")}: ${done}/${tasks.length}`, ring: <MiniRing percent={(done / tasks.length) * 100} /> }]
      : []),
  ];

  return (
    <div className="tdots" ref={ref} role="group" aria-label={t("Состояние сессии")}>
      {dots.map((d) => (
        <button
          key={d.key}
          type="button"
          className={`tdot ${open === d.key ? "on" : ""} ${d.key === "agent" && live ? "live" : ""}`}
          aria-label={d.label}
          title={d.label}
          aria-expanded={open === d.key}
          onClick={() => setOpen((v) => (v === d.key ? null : d.key))}
        >
          {d.ring}
        </button>
      ))}
      {open && (
        <div className="tdot-pop" role="dialog" aria-label={dots.find((d) => d.key === open)?.label}>
          {open === "agent" && <AgentTile s={s} />}
          {open === "plan" && plan && <PlanTile phases={s.plan!} />}
          {open === "context" && <ContextTile s={s} onCompact={onCompact} />}
        </div>
      )}
    </div>
  );
}

function hasPlan(s: SessionState) {
  return !!s.plan && s.plan.some((p) => p.tasks.length > 0);
}

function isBusy(s: SessionState) {
  return s.status === "working" || s.status === "thinking";
}

function AgentTile({ s }: { s: SessionState }) {
  const busy = isBusy(s);
  const elapsed = useElapsed(s.turnStartedAt, s.turnEndedAt);
  const mood = s.status === "offline" || s.status === "starting" ? "off" : s.status === "waiting" ? "waiting" : busy ? "busy" : "idle";
  const live = busy || s.status === "waiting";
  return (
    <section className="card tile">
      <div className="tile-head">
        <span><span className="n">01</span>&nbsp; {t("АГЕНТ")}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, color: live ? "var(--accent-ink)" : "var(--ink-3)" }}>
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
  );
}

/** Context window use, with the session's total spend under it. */
function ContextTile({ s, onCompact }: TilesProps) {
  return (
    <section className="card tile" style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
      <div style={{ position: "relative", width: 104, height: 104, flexShrink: 0 }}>
        <DotRing percent={s.context?.percent ?? 0} />
        <div className="tile-big" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 24 }}>
          {Math.round(s.context?.percent ?? 0)}%
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <div className="tile-head"><span><span className="n">02</span>&nbsp; {t("КОНТЕКСТ")}</span></div>
        <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
          {s.context ? t("{used} из {total}", { used: compact(s.context.tokens), total: compact(s.context.window) }) : t("нет данных")}
        </div>
        <div className="tile-k" style={{ whiteSpace: "nowrap" }} title={t("Все токены за сессию: каждый запрос заново отправляет контекст")}>
          {t("СЕССИЯ")} {compact(s.stats?.tokens ?? 0)}
          {s.stats?.cost ? <span style={{ color: "var(--ink-2)" }}> · {formatCost(s.stats.cost)}</span> : null}
        </div>
        <button className="chip" style={{ alignSelf: "flex-start", height: 28, fontSize: 12 }} onClick={onCompact} disabled={s.status !== "idle"}>
          {t("Сжать")}
        </button>
      </div>
    </section>
  );
}

/** Small dotted ring, filled clockwise from the top with the accent. */
function MiniRing({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="var(--dim)" strokeWidth="2.2" strokeDasharray="0 3.53" />
      {p >= 99.5 ? (
        <circle cx="12" cy="12" r="9" stroke="var(--accent-ink)" strokeWidth="2.2" strokeDasharray="0 3.53" />
      ) : p > 0 ? (
        <path d={arc(Math.max(p, 4))} stroke="var(--accent-ink)" strokeWidth="2.2" strokeDasharray="0 3.53" />
      ) : null}
    </svg>
  );
}

/** Agent ring: still when ready, a spinning arc while working, solid accent while it waits for you. */
function AgentRing({ status }: { status: SessionState["status"] }) {
  const busy = status === "working" || status === "thinking";
  const ready = status === "idle";
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" strokeLinecap="round" aria-hidden="true">
      <circle
        cx="12" cy="12" r="9" strokeWidth="2.2" strokeDasharray="0 3.53"
        stroke={status === "waiting" ? "var(--accent-ink)" : ready ? "var(--ink-3)" : "var(--dim)"}
        className={status === "waiting" ? "pulse" : undefined}
      />
      {busy && (
        <g className="spin">
          <circle cx="12" cy="12" r="9" stroke="none" />
          <path d={arc(30)} stroke="var(--accent-ink)" strokeWidth="2.2" strokeDasharray="0 3.53" />
        </g>
      )}
      <circle cx="12" cy="12" r="2.4" fill={busy || status === "waiting" ? "var(--accent-ink)" : ready ? "var(--ink)" : "var(--dim)"} />
    </svg>
  );
}

function arc(percent: number) {
  const a = (percent / 100) * 2 * Math.PI;
  const x = 12 + 9 * Math.sin(a);
  const y = 12 - 9 * Math.cos(a);
  return `M12 3A9 9 0 ${percent > 50 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

const TASK_MARK: Record<TodoTask["status"], { stroke: string; check: boolean; dash: string }> = {
  completed: { stroke: "var(--ink)", check: true, dash: "0 3.2" },
  in_progress: { stroke: "var(--accent-ink)", check: false, dash: "0 3.2" },
  pending: { stroke: "var(--dim)", check: false, dash: "0 3.2" },
  blocked: { stroke: "var(--accent-ink)", check: false, dash: "1.5 2" },
  abandoned: { stroke: "var(--dim)", check: false, dash: "1.5 2" },
};

function PlanTile({ phases }: { phases: TodoPhase[] }) {
  const tasks = phases.flatMap((p) => p.tasks);
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <section className="card tile">
      <div className="tile-head">
        <span><span className="n">03</span>&nbsp; {t("ПЛАН")}</span>
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
                    {t.status === "in_progress" && <circle cx="7" cy="7" r="1.8" fill="var(--accent-ink)" />}
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
