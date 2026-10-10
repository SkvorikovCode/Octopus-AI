import { useEffect, useId, useState } from "react";
import { swarmCounts, type Subagent, type SubagentStatus, type SwarmLogEntry, type SwarmState } from "../lib/swarm";
import { DotSpinner, Emblem, Face, Icon } from "./Glyphs";
import { t } from "../lib/i18n";
import "./swarm.css";

type Props = {
  swarm: SwarmState;
  goal?: string;
  busy: boolean;
  onBack: () => void;
  onAbort: () => void;
  /** Opens the live transcript of one subagent. */
  onOpenAgent?: (agent: Subagent) => void;
};

type Counts = ReturnType<typeof swarmCounts>;

const STATUS_LABEL: Record<SubagentStatus, string> = {
  pending: "В ОЧЕРЕДИ",
  running: "В РАБОТЕ",
  completed: "ГОТОВО",
  failed: "ОШИБКА",
  aborted: "ОСТАНОВЛЕН",
};

const pad2 = (n: number) => String(n).padStart(2, "0");

function trimDecimal(x: number): string {
  return x.toFixed(1).replace(/\.0$/, "");
}

function fmtTokens(n: number): string {
  if (n >= 1000000) return `${trimDecimal(n / 1000000)}M`;
  if (n >= 1000) return `${trimDecimal(n / 1000)}K`;
  return String(Math.round(n));
}

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${pad2(sec % 60)}`;
}

function fmtClock(time: number): string {
  const d = new Date(time);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Ticks once a second while something runs, so elapsed times move between progress frames.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function Swarm({ swarm, goal, busy, onBack, onAbort, onOpenAgent }: Props) {
  const counts = swarmCounts(swarm);
  const running = counts.running > 0;
  const now = useNow(running);
  const agents = swarm.order.map((id) => swarm.agents[id]);

  const statusText = busy
    ? running
      ? t("агент работает · в работе: {count}", { count: counts.running })
      : t("агент работает")
    : t("агент ждёт");

  return (
    <section className="swarm" aria-label={t("Рой агентов")}>
      <header className="swarm-top">
        <button type="button" className="btn swarm-back" onClick={onBack}>
          {t("← К чату")}
        </button>
        <h1 className="swarm-title">{t("Рой агентов")}</h1>
        <span className="swarm-live-text mono">{statusText}</span>
      </header>

      <div className="scroll swarm-scroll">
        {agents.length === 0 ? (
          <div className="swarm-empty">
            <Emblem size={170} />
            <h2>{t("Рой пока пуст")}</h2>
            <p>
              {t(
                "Рой появится, когда агент разделит задачу на части. Попросите в чате, например: «Раздели задачу на подзадачи и выполни их параллельно».",
              )}
            </p>
            <button type="button" className="btn" onClick={onBack}>
              {t("Вернуться в чат")}
            </button>
          </div>
        ) : (
          <div className="swarm-grid">
            <GoalTile goal={goal} counts={counts} busy={busy} onAbort={onAbort} />
            {agents.map((a) => (
              <AgentTile key={a.id} agent={a} now={now} onOpen={onOpenAgent ? () => onOpenAgent(a) : undefined} />
            ))}
            <TokensTile agents={agents} />
            <LogTile log={swarm.log} live={running} />
          </div>
        )}
      </div>
    </section>
  );
}

function GoalTile({ goal, counts, busy, onAbort }: { goal?: string; counts: Counts; busy: boolean; onAbort: () => void }) {
  const { total, done, running, pending, failed } = counts;
  const summary = [
    t("{count} готово", { count: done }),
    t("{count} в работе", { count: running }),
    t("{count} в очереди", { count: pending }),
  ];
  if (failed > 0) summary.push(t("{count} с ошибкой", { count: failed }));
  const text = goal?.trim() || t("Задача агента");

  return (
    <section className="card swarm-tile swarm-span2" aria-label={t("Цель")}>
      <header className="swarm-head">
        <span className="label">{t("00 ЦЕЛЬ")}</span>
      </header>
      <p className="swarm-goal-text" title={text}>
        {text}
      </p>
      <div className="swarm-goal-row">
        <div className="swarm-big dots">
          {done}
          <span className="swarm-big-dim">/{total}</span>
        </div>
        <button type="button" className="btn swarm-stop" onClick={onAbort} disabled={!busy}>
          <Icon name="stop" size={12} />
          {t("Стоп")}
        </button>
      </div>
      <DotBar done={done} running={running} total={total} />
      <p className="swarm-summary mono">{summary.join(" · ")}</p>
    </section>
  );
}

// Dotted progress line drawn with SVG patterns: grey base, finished part in ink, running part in accent.
function DotBar({ done, running, total }: { done: number; running: number; total: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const base = `${uid}-base`;
  const ok = `${uid}-ok`;
  const run = `${uid}-run`;
  const span = Math.max(1, total);
  const donePct = (Math.min(done, span) / span) * 100;
  const runPct = (Math.min(running, Math.max(0, span - done)) / span) * 100;

  return (
    <svg className="swarm-bar" width="100%" height="12" aria-hidden="true">
      <defs>
        <pattern id={base} width="9" height="12" patternUnits="userSpaceOnUse">
          <circle cx="4.5" cy="6" r="1.8" fill="var(--dot)" />
        </pattern>
        <pattern id={ok} width="9" height="12" patternUnits="userSpaceOnUse">
          <circle cx="4.5" cy="6" r="1.8" fill="var(--ink)" />
        </pattern>
        <pattern id={run} width="9" height="12" patternUnits="userSpaceOnUse">
          <circle cx="4.5" cy="6" r="1.8" fill="var(--accent-ink)" />
        </pattern>
      </defs>
      <rect width="100%" height="12" fill={`url(#${base})`} />
      <rect width={`${donePct}%`} height="12" fill={`url(#${ok})`} />
      <rect x={`${donePct}%`} width={`${runPct}%`} height="12" fill={`url(#${run})`} />
    </svg>
  );
}

function AgentTile({ agent: a, now, onOpen }: { agent: Subagent; now: number; onOpen?: () => void }) {
  const elapsed = a.durationMs + (a.status === "running" ? Math.max(0, now - a.updatedAt) : 0);

  return (
    <article className={`card swarm-tile is-${a.status}`}>
      <header className="swarm-head">
        <span className="label swarm-idx">
          {pad2(a.index + 1)}  {a.agent}
        </span>
        <span className="label swarm-status">{t(STATUS_LABEL[a.status])}</span>
      </header>

      <StatusArt agent={a} />

      <p className="swarm-task" title={a.task || a.assignment}>
        {a.task || a.assignment || t("Без описания")}
      </p>

      {onOpen && (
        <button type="button" className="swarm-open" onClick={onOpen}>
          {t("Открыть лог агента")}
        </button>
      )}

      <dl className="swarm-stats">
        <div>
          <dt className="label">{t("ИНСТР.")}</dt>
          <dd className="dots">{a.toolCount}</dd>
        </div>
        <div>
          <dt className="label">{t("ТОКЕНЫ")}</dt>
          <dd className="dots">{fmtTokens(a.tokens)}</dd>
        </div>
        <div>
          <dt className="label">{t("ВРЕМЯ")}</dt>
          <dd className="dots">{fmtDuration(elapsed)}</dd>
        </div>
      </dl>
    </article>
  );
}

function StatusArt({ agent: a }: { agent: Subagent }) {
  switch (a.status) {
    case "running":
      return (
        <div className="swarm-running">
          <div className="swarm-doto dots">
            WORKING<span className="swarm-caret">_</span>
          </div>
          <Face mood="busy" />
          <div className="swarm-tool mono">
            <DotSpinner size={12} />
            <span>{a.currentTool || t("подготовка")}</span>
          </div>
        </div>
      );
    case "completed":
      return <CheckArt />;
    case "failed":
      return (
        <div className="swarm-art swarm-art-fail">
          <Icon name="close" size={28} />
        </div>
      );
    case "aborted":
      return (
        <div className="swarm-art swarm-art-stop">
          <Icon name="stop" size={24} />
        </div>
      );
    case "pending":
      return <HourglassArt />;
  }
}

function CheckArt() {
  return (
    <div className="swarm-art">
      <svg width="64" height="48" viewBox="0 0 64 48" fill="none" strokeLinecap="round" aria-hidden="true">
        <rect x="3" y="3" width="58" height="42" rx="12" stroke="var(--dim)" strokeWidth="3" strokeDasharray="0 6" />
        <path d="M20 25l8 8 16-17" stroke="var(--ink-2)" strokeWidth="4" strokeDasharray="0 6" />
      </svg>
    </div>
  );
}

function HourglassArt() {
  return (
    <div className="swarm-art">
      <svg width="48" height="56" viewBox="0 0 48 56" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 4H36L24 28L36 52H12L24 28Z" stroke="var(--mute)" strokeWidth="3" strokeDasharray="0 6" />
        <circle cx="24" cy="42" r="2.4" fill="var(--mute)" />
      </svg>
    </div>
  );
}

function TokensTile({ agents }: { agents: Subagent[] }) {
  const tokens = agents.reduce((n, a) => n + a.tokens, 0);
  const cost = agents.reduce((n, a) => n + a.cost, 0);

  return (
    <section className="card swarm-tile">
      <header className="swarm-head">
        <span className="label">{t("ТОКЕНЫ")}</span>
      </header>
      <div className="swarm-big-num dots">{fmtTokens(tokens)}</div>
      <div className="mono swarm-cost">{`$${cost.toFixed(2)}`}</div>
    </section>
  );
}

function LogTile({ log, live }: { log: SwarmLogEntry[]; live: boolean }) {
  const rows = log.slice(-12).reverse();

  return (
    <section className="card swarm-tile swarm-span2">
      <header className="swarm-head">
        <span className="label">{t("ЖУРНАЛ")}</span>
        {live && (
          <span className="label swarm-live">
            <span className="dot on pulse" aria-hidden="true" />
            LIVE
          </span>
        )}
      </header>
      {rows.length === 0 ? (
        <p className="swarm-muted">{t("Событий пока нет.")}</p>
      ) : (
        <ul className="swarm-log-list">
          {rows.map((e, i) => (
            <li key={`${e.t}-${e.index}-${i}`} className="swarm-log-row">
              <time className="swarm-log-time">{fmtClock(e.t)}</time>
              <span className="swarm-log-agent">
                {pad2(e.index + 1)} {e.agent}
              </span>
              <span className="swarm-log-text">{t(e.text)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
