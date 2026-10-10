import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { DotSpinner, Icon } from "./Glyphs";
import {
  dayLabel,
  formatCost,
  formatTokens,
  loadUsage,
  relativeDay,
  ymd,
  type DayStat,
  type SessionStat,
  type UsageStats,
} from "../lib/stats";
import { t, tn } from "../lib/i18n";
import "./stats.css";

const PERIODS: number[] = [7, 30, 90];
const CHART_H = 140;
const CHART_ROWS = 14;

type Point = { date: string; tokens: number; cost: number; requests: number; isToday: boolean };
type LoadState = { status: "loading" } | { status: "ready"; data: UsageStats } | { status: "error"; message: string };

export function StatsScreen({
  project,
  onBack,
  embedded = false,
  onOpenSession,
}: {
  project?: string;
  onBack: () => void;
  /** Shown as a settings tab: no back button and title (the tab names it). */
  embedded?: boolean;
  onOpenSession?: (path: string) => void;
}): ReactElement {
  const uid = useId();
  const [period, setPeriod] = useState(30);
  const [scope, setScope] = useState<"project" | "all">("project");
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const cwd = project && scope === "project" ? project : undefined;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    loadUsage(period, cwd).then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorText(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [period, cwd, reloadKey]);

  const data = state.status === "ready" ? state.data : null;
  const series = useMemo(() => (data ? buildSeries(data.days, period) : []), [data, period]);
  const maxTokens = Math.max(1, ...series.map((p) => p.tokens));
  const sessions = useMemo(
    () => (data ? [...data.sessions].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens) : []),
    [data],
  );

  const models = data?.models ?? [];
  const useCost = models.some((m) => m.cost > 0);
  const modelTotal = models.reduce((s, m) => s + (useCost ? m.cost : m.tokens), 0);

  return (
    <div className="st-root">
      <header className={`st-bar ${embedded ? "st-bar-embedded" : ""}`}>
        {!embedded && (
          <>
            <button type="button" className="btn st-back" onClick={onBack}>
              ← {t("Назад")}
            </button>
            <h1 className="st-title">{t("Статистика")}</h1>
          </>
        )}
        <div className="st-controls">
          {project && (
            <Segmented<"project" | "all">
              label={t("Область данных")}
              value={scope}
              onChange={setScope}
              options={[
                { value: "project", label: t("Этот проект") },
                { value: "all", label: t("Все проекты") },
              ]}
            />
          )}
          <Segmented<number>
            label={t("Период")}
            value={period}
            onChange={setPeriod}
            options={PERIODS.map((p) => ({ value: p, label: tn(p, "день|дня|дней") }))}
          />
        </div>
      </header>

      <div className="scroll st-body">
        {state.status === "loading" && (
          <div className="st-state" role="status">
            <DotSpinner size={16} />
            <span>{t("Загружаем статистику…")}</span>
          </div>
        )}

        {state.status === "error" && (
          <div className="err-card st-error" role="alert">
            <span>
              {t("Не удалось загрузить статистику.")}
              <span className="st-error-detail"> {t(state.message)}</span>
            </span>
            <button type="button" className="btn" onClick={() => setReloadKey((k) => k + 1)}>
              <Icon name="refresh" size={14} /> {t("Повторить")}
            </button>
          </div>
        )}

        {data && data.totalRequests === 0 && (
          <div className="st-empty">
            <p>{t("За этот период запросов не было")}</p>
          </div>
        )}

        {data && data.totalRequests > 0 && (
          <div className="st-grid">
            <section className="card st-tile" aria-labelledby={`${uid}-tokens`}>
              <h2 id={`${uid}-tokens`} className="label st-label">{t("01 ТОКЕНЫ")}</h2>
              <div className="st-big dots">{formatTokens(data.totalTokens)}</div>
              <div className="st-sub">{tn(data.totalRequests, "запрос|запроса|запросов")}</div>
            </section>

            <section className="card st-tile" aria-labelledby={`${uid}-cost`}>
              <h2 id={`${uid}-cost`} className="label st-label">{t("02 СТОИМОСТЬ")}</h2>
              <div className="st-big dots">{formatCost(data.totalCost)}</div>
              <div className="st-sub">
                {t("в среднем {cost} в день", { cost: formatCost(data.totalCost / period) })}
              </div>
            </section>

            <section className="card st-tile" aria-labelledby={`${uid}-sessions`}>
              <h2 id={`${uid}-sessions`} className="label st-label">{t("03 СЕССИИ")}</h2>
              <div className="st-big dots">{data.sessionCount}</div>
              <div className="st-sub">{t("за последние {days} дн.", { days: period })}</div>
            </section>

            <section className="card st-tile st-wide" aria-labelledby={`${uid}-days`}>
              <h2 id={`${uid}-days`} className="label st-label">{t("04 ПО ДНЯМ")}</h2>
              <DayChart series={series} maxTokens={maxTokens} />
            </section>

            <section className="card st-tile" aria-labelledby={`${uid}-models`}>
              <h2 id={`${uid}-models`} className="label st-label">{t("05 МОДЕЛИ")}</h2>
              {models.length === 0 ? (
                <p className="st-muted">{t("Нет данных по моделям")}</p>
              ) : (
                <ul className="st-models">
                  {models.map((m) => {
                    const [provider, name] = splitModel(m.model);
                    const value = useCost ? m.cost : m.tokens;
                    const share = modelTotal > 0 ? value / modelTotal : 0;
                    const pct = Math.round(share * 100);
                    return (
                      <li key={m.model} className="st-model">
                        <span className="st-model-name" title={m.model}>
                          <span className="st-model-id">{name}</span>
                          {provider && <span className="st-provider mono">{provider}</span>}
                        </span>
                        <span className="st-model-cost mono">{formatCost(m.cost)}</span>
                        <span className="st-dotbar" role="img" aria-label={t("Доля {pct}%", { pct })}>
                          <span className="st-dotbar-fill" style={{ width: `${share * 100}%` }} />
                        </span>
                        <span className="st-model-tokens mono">
                          {t("{tokens} токенов", { tokens: formatTokens(m.tokens) })}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="card st-tile st-wide st-beside" aria-labelledby={`${uid}-top`}>
              <h2 id={`${uid}-top`} className="label st-label">{t("06 ДОРОГИЕ СЕССИИ")}</h2>
              {sessions.length === 0 ? (
                <p className="st-muted">{t("За период сессий не было")}</p>
              ) : (
                <ul className="st-sessions">
                  {sessions.map((s) => (
                    <SessionRow key={s.path} session={s} onOpen={onOpenSession} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): ReactElement {
  return (
    <div className="st-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function DayChart({ series, maxTokens }: { series: Point[]; maxTokens: number }): ReactElement {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>(640);
  const n = series.length;
  const slot = width / n;
  const dot = Math.min(9, Math.max(2.5, slot * 0.6));
  const step = (CHART_H - dot) / (CHART_ROWS - 1);
  const baseY = CHART_H - dot / 2;
  const trackLen = (CHART_ROWS - 1) * step + step / 2;
  const total = series.reduce((s, p) => s + p.tokens, 0);

  return (
    <div className="st-chart" ref={wrapRef}>
      <svg
        className="st-svg"
        viewBox={`0 0 ${width} ${CHART_H}`}
        width="100%"
        height={CHART_H}
        preserveAspectRatio="none"
        strokeLinecap="round"
        role="img"
        aria-label={t("Токены по дням за {days} дн., всего {total}", {
          days: n,
          total: formatTokens(total),
        })}
      >
        {series.map((p, i) => {
          const cx = slot * (i + 0.5);
          const lit = p.tokens > 0 ? Math.min(CHART_ROWS, Math.max(1, Math.round((p.tokens / maxTokens) * CHART_ROWS))) : 0;
          const litLen = (lit - 1) * step + step / 2;
          return (
            <g key={p.date} className="st-col">
              <line
                className="st-track"
                x1={cx}
                x2={cx}
                y1={baseY}
                y2={baseY - trackLen}
                strokeWidth={dot}
                strokeDasharray={`0 ${step}`}
              />
              {lit > 0 && (
                <line
                  className={p.isToday ? "st-lit st-lit-today" : "st-lit"}
                  x1={cx}
                  x2={cx}
                  y1={baseY}
                  y2={baseY - litLen}
                  strokeWidth={dot}
                  strokeDasharray={`0 ${step}`}
                />
              )}
              <rect x={slot * i} y={0} width={slot} height={CHART_H} fill="transparent">
                <title>{dayTooltip(p)}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="st-axis" aria-hidden="true">
        <span>{dayLabel(series[0].date)}</span>
        <span>{dayLabel(series[Math.floor(n / 2)].date)}</span>
        <span>{dayLabel(series[n - 1].date)}</span>
      </div>
    </div>
  );
}

function SessionRow({ session: s, onOpen }: { session: SessionStat; onOpen?: (path: string) => void }): ReactElement {
  const body = (
    <>
      <span className="st-session-main">
        <span className="st-session-title">{s.title || t("Без названия")}</span>
        <span className="st-session-proj mono">{folderName(s.cwd)}</span>
      </span>
      <span className="st-session-nums">
        <span className="st-session-tokens mono">{t("{tokens} токенов", { tokens: formatTokens(s.tokens) })}</span>
        <span className="st-session-cost mono">{formatCost(s.cost)}</span>
        <span className="st-session-date">{relativeDay(s.lastAt)}</span>
      </span>
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button type="button" className="st-session" onClick={() => onOpen?.(s.path)}>
          {body}
        </button>
      ) : (
        <div className="st-session">{body}</div>
      )}
    </li>
  );
}

/** Fills the period with one point per calendar day, ending today. */
function buildSeries(days: DayStat[], period: number): Point[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayKey = ymd(now);
  const out: Point[] = [];
  for (let i = period - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = ymd(d);
    const s = byDate.get(key);
    out.push({
      date: key,
      tokens: s?.tokens ?? 0,
      cost: s?.cost ?? 0,
      requests: s?.requests ?? 0,
      isToday: key === todayKey,
    });
  }
  return out;
}

function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(1, Math.round(el.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function dayTooltip(p: Point): string {
  if (p.tokens === 0 && p.requests === 0) return t("{day} · нет запросов", { day: dayLabel(p.date) });
  return t("{day} · {tokens} токенов · {cost}", {
    day: dayLabel(p.date),
    tokens: formatTokens(p.tokens),
    cost: formatCost(p.cost),
  });
}

function splitModel(model: string): [string, string] {
  const i = model.indexOf("/");
  return i < 0 ? ["", model] : [model.slice(0, i), model.slice(i + 1)];
}

function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "неизвестная ошибка";
}
