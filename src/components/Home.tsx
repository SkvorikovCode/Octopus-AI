import type { ReactElement, ReactNode } from "react";
import type { SessionMeta } from "../lib/sessions";
import { relativeTime } from "../lib/sessions";
import { Emblem, Icon } from "./Glyphs";
import { APPROVAL_LEAD, type ApprovalMode } from "./Controls";
import { t } from "../lib/i18n";
import "./home.css";

const SUGGESTIONS = [
  "Объясни, как устроен проект",
  "Найди и почини падающие тесты",
  "Добавь тесты к последним изменениям",
  "Раздели задачу на подзадачи и выполни параллельно",
];

const MAX_RECENT = 6;

export function Home(props: {
  projectName?: string;
  approval: ApprovalMode;
  sessions: SessionMeta[];
  activeSubagents: number;
  composer: ReactNode;
  onOpenSession: (s: SessionMeta) => void;
  onSuggest: (text: string) => void;
  onOpenSwarm: () => void;
}): ReactElement {
  const { projectName, approval, sessions, activeSubagents, composer, onOpenSession, onSuggest, onOpenSwarm } = props;
  const recent = sessions.slice(0, MAX_RECENT);

  return (
    <div className="home-root">
      <div className="scroll home-scroll">
        <div className="home-content">
          <Emblem size={210} />

          <div className="home-head">
            <h1 className="home-title">{t("Чем займёмся?")}</h1>
            <p className="home-lead">
              {projectName
                ? t("Агент работает в папке «{name}»: {mode}.", { name: projectName, mode: t(APPROVAL_LEAD[approval]) })
                : t("Опишите задачу своими словами.")}
            </p>
          </div>

          <div className="home-composer">{composer}</div>

          <div className="home-chips">
            {SUGGESTIONS.map((text) => (
              <button key={text} type="button" className="home-chip" onClick={() => onSuggest(t(text))}>
                {t(text)}
              </button>
            ))}
          </div>

          {activeSubagents > 0 && (
            <button type="button" className="home-swarm" onClick={onOpenSwarm}>
              <span className="home-swarm-text">
                <span className="home-swarm-label">{t("РОЙ · В РАБОТЕ")}</span>
                <span className="home-swarm-count">{t("Работают агенты: {count}", { count: activeSubagents })}</span>
              </span>
              <span className="home-swarm-chevron">
                <Icon name="chevron-right" size={16} />
              </span>
            </button>
          )}

          {recent.length > 0 && (
            <section className="home-recent" aria-label={t("Продолжить")}>
              <div className="home-label">{t("ПРОДОЛЖИТЬ")}</div>
              <div className="home-grid">
                {recent.map((s, i) => {
                  const showPreview = !!s.preview && s.preview !== s.title;
                  return (
                    <button key={s.path} type="button" className="home-tile" onClick={() => onOpenSession(s)}>
                      <span className="home-tile-head">
                        <span>{String(i + 1).padStart(2, "0")}</span>
                        <span>{relativeTime(s.updatedAt)}</span>
                      </span>
                      <span className="home-tile-title">{s.title || s.preview || t("Без названия")}</span>
                      {showPreview && <span className="home-tile-preview">{s.preview}</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
