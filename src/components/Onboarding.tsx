import type { CSSProperties, ReactElement, ReactNode } from "react";
import { DotSpinner, Emblem, Icon } from "./Glyphs";
import { t, tn } from "../lib/i18n";
import "./onboarding.css";

const SUGGESTIONS = [
  "Объясни, как устроен проект",
  "Найди и почини падающие тесты",
  "Добавь README с описанием проекта",
];

type StepState = "pending" | "progress" | "done";

export function Onboarding(props: {
  engine: "checking" | "found" | "missing";
  models: number;
  modelsLoading: boolean;
  project?: string;
  onPickProject: () => void;
  onOpenProviders: () => void;
  onRetryEngine: () => void;
  onFinish: (exampleTask?: string) => void;
}): ReactElement {
  const { engine, models, modelsLoading, project, onPickProject, onOpenProviders, onRetryEngine, onFinish } = props;

  const engineDone = engine === "found";
  const modelsDone = engineDone && models > 0;
  const projectDone = !!project;
  const allDone = engineDone && modelsDone && projectDone;
  const readyFirstTwo = engineDone && modelsDone;

  const engineState: StepState = engineDone ? "done" : engine === "checking" ? "progress" : "pending";
  const modelsState: StepState = modelsDone ? "done" : engineDone && modelsLoading ? "progress" : "pending";
  const projectState: StepState = projectDone ? "done" : "pending";

  const projectName = project ? project.split(/[\\/]/).filter(Boolean).pop() ?? project : "";

  return (
    <div className="onb-root">
      <div className="onb-content">
        <div className="onb-head">
          <Emblem size={160} />
          <h1 className="onb-title">{t("Добро пожаловать в Octopus")}</h1>
          <p className="onb-lead">{t("Три шага — и агент начнёт работать в вашем проекте.")}</p>
        </div>

        <ol className="onb-steps">
          <Step index={0} label={t("Агент")} state={engineState} warn={engine === "missing"}>
            {engine === "checking" && (
              <div className="onb-status">
                <DotSpinner />
                <span>{t("Проверяем…")}</span>
              </div>
            )}
            {engine === "found" && <div className="onb-status">{t("Агент установлен")}</div>}
            {engine === "missing" && (
              <>
                <div className="onb-status">{t("Агент не найден")}</div>
                <p className="onb-detail">{t("Установите движок агента и нажмите «Проверить снова».")}</p>
                <div className="onb-actions">
                  <button type="button" className="btn" onClick={onRetryEngine}>
                    <Icon name="refresh" size={14} />
                    {t("Проверить снова")}
                  </button>
                </div>
              </>
            )}
          </Step>

          <Step index={1} label={t("Модель")} state={modelsState} locked={!engineDone}>
            {!engineDone ? (
              <div className="onb-status">{t("Сначала проверим агента")}</div>
            ) : modelsDone ? (
              <div className="onb-status">{t("Доступно: {models}", { models: tn(models, "модель|модели|моделей") })}</div>
            ) : modelsLoading ? (
              <div className="onb-status">
                <DotSpinner />
                <span>{t("Загружаем список моделей…")}</span>
              </div>
            ) : (
              <>
                <div className="onb-status">{t("Нет доступных моделей")}</div>
                <div className="onb-actions">
                  <button type="button" className="btn" onClick={onOpenProviders}>
                    {t("Подключить провайдера")}
                  </button>
                </div>
              </>
            )}
          </Step>

          <Step index={2} label={t("Папка проекта")} state={projectState}>
            {project ? (
              <>
                <div className="onb-status">{projectName}</div>
                <div className="onb-path">{project}</div>
                <div className="onb-actions">
                  <button type="button" className="link-btn onb-link" onClick={onPickProject}>
                    {t("Другая папка")}
                  </button>
                </div>
              </>
            ) : (
              <div className="onb-actions">
                <button type="button" className={readyFirstTwo ? "btn primary" : "btn"} onClick={onPickProject}>
                  <Icon name="folder" size={14} />
                  {t("Выбрать папку")}
                </button>
              </div>
            )}
            <p className="onb-detail">{t("Агент читает и меняет файлы только в этой папке.")}</p>
          </Step>
        </ol>

        <div className="onb-foot">
          {allDone ? (
            <>
              <div className="onb-label">{t("Попробуйте для начала:")}</div>
              <div className="onb-chips">
                {SUGGESTIONS.map((text) => (
                  <button key={text} type="button" className="onb-chip" onClick={() => onFinish(t(text))}>
                    {t(text)}
                  </button>
                ))}
              </div>
              <button type="button" className="btn primary onb-start" onClick={() => onFinish()}>
                {t("Начать")}
              </button>
            </>
          ) : (
            <button type="button" className="onb-skip" onClick={() => onFinish()}>
              {t("Пропустить")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Step(props: { index: number; label: string; state: StepState; locked?: boolean; warn?: boolean; children: ReactNode }) {
  const { index, label, state, locked, warn, children } = props;
  return (
    <li className="onb-li">
      <section
        className="card onb-step"
        aria-label={label}
        data-state={state}
        data-locked={locked ? "true" : undefined}
        data-warn={warn ? "true" : undefined}
        aria-disabled={locked || undefined}
        style={{ "--i": index } as CSSProperties}
      >
        <header className="onb-step-head">
          <span className="onb-n">{String(index + 1).padStart(2, "0")}</span>
          <span className="onb-label">{label}</span>
          <StepMark state={state} />
        </header>
        <div className="onb-step-body">{children}</div>
      </section>
    </li>
  );
}

/** Dotted ring: pending; accent ring with a pulsing dot: in progress; ring with a check: done. */
function StepMark({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <svg className="onb-mark onb-mark-done" width="22" height="22" viewBox="0 0 22 22" fill="none" strokeLinecap="round" aria-hidden="true">
        <circle className="onb-ring" cx="11" cy="11" r="9" stroke="var(--accent)" strokeWidth="2" strokeDasharray="0 3.4" />
        <path className="onb-check" d="M7.4 11.4l2.4 2.4 4.8-5.2" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" pathLength="1" />
      </svg>
    );
  }
  if (state === "progress") {
    return (
      <svg className="onb-mark" width="22" height="22" viewBox="0 0 22 22" fill="none" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="9" stroke="var(--accent)" strokeWidth="2" strokeDasharray="0 3.4" />
        <circle className="pulse" cx="11" cy="11" r="3.4" fill="var(--accent)" />
      </svg>
    );
  }
  return (
    <svg className="onb-mark" width="22" height="22" viewBox="0 0 22 22" fill="none" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="9" stroke="var(--dim)" strokeWidth="2" strokeDasharray="0 3.4" />
    </svg>
  );
}
