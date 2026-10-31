import { useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import {
  ACCENTS,
  DEFAULT_SETTINGS,
  resetSettings,
  updateSettings,
  useSettings,
  type Settings,
} from "../lib/settings";
import {
  TEMPLATE_NAME_RE,
  deleteTemplate,
  newTemplateId,
  saveTemplate,
  useTemplates,
  type Template,
} from "../lib/templates";
import { parseLimit, todaySpend } from "../lib/budget";
import { formatCost } from "../lib/stats";
import { t } from "../lib/i18n";
import { modKey } from "../lib/platform";
import { ModelPrices, type PriceModel } from "./ModelPrices";
import { InstructionsSection } from "./Instructions";
import "./settings.css";
import "./budget.css";

const SCALES = [0.85, 1, 1.1, 1.25] as const;

const HOTKEYS: { keys: string[]; text: string }[] = [
  { keys: [modKey("K")], text: "Палитра команд" },
  { keys: [modKey("N")], text: "Новая сессия" },
  { keys: ["Enter", modKey("Enter")], text: "Отправить" },
  { keys: ["Shift+Enter"], text: "Новая строка" },
  { keys: ["Esc"], text: "Закрыть окно" },
  { keys: ["/"], text: "Команды агента" },
  { keys: ["@"], text: "Файл проекта" },
  { keys: ["!"], text: "Команда в терминале" },
];

/** Settings are split into tabs; usage and connections are full screens embedded here. */
export type SettingsTab = "general" | "chat" | "instructions" | "models" | "budget" | "usage" | "connections" | "commands" | "hotkeys" | "about";

export type SettingsScreenProps = {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  renderUsage?: () => ReactNode;
  renderConnections?: () => ReactNode;
  onBack: () => void;
  onOpenProviders: () => void;
  engineInfo?: { model?: string; project?: string; status: string };
  /** Effective model prices from the running agent. */
  models?: PriceModel[];
  /** Providers on a flat-rate subscription. */
  subscriptions?: ReadonlySet<string>;
  onRestartAgent?: () => void;
  /** Open project folder and the user's home folder, for the Инструкции tab. */
  project?: string;
  home?: string;
  /** Instruction files the running agent reads (absolute paths). */
  contextFiles?: string[];
  agentRunning?: boolean;
  onNewSession?: () => void;
  onGenerateInstructions?: (rel: string) => void;
};

export function SettingsScreen({
  tab: requestedTab,
  onTabChange,
  renderUsage,
  renderConnections,
  onBack,
  onOpenProviders,
  engineInfo,
  models,
  subscriptions,
  onRestartAgent,
  project,
  home,
  contextFiles,
  agentRunning,
  onNewSession,
  onGenerateInstructions,
}: SettingsScreenProps): ReactElement {
  // The budget section lives in the models tab now; a "budget" request opens models.
  const tab: SettingsTab = requestedTab === "budget" ? "models" : requestedTab;
  const s = useSettings();
  const [armed, setArmed] = useState(false);

  // The reset confirmation disarms itself after 3 seconds.
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const customAccent = !(ACCENTS as readonly string[]).includes(s.accent);
  const pickerValue = /^#[0-9a-f]{6}$/i.test(s.accent) ? s.accent : DEFAULT_SETTINGS.accent;

  const items: { id: SettingsTab; label: string }[] = [
    { id: "general", label: t("Общие") },
    { id: "chat", label: t("Чат") },
    { id: "instructions", label: t("Инструкции") },
    { id: "models", label: t("Модели") },
    { id: "usage", label: t("Статистика") },
    { id: "connections", label: t("Подключения") },
    { id: "commands", label: t("Мои команды") },
    { id: "hotkeys", label: t("Горячие клавиши") },
    { id: "about", label: t("О программе") },
  ];
  // Tabs that bring their own full-height layout (header, scrolling).
  const full = tab === "usage" || tab === "connections";

  return (
    <div className="set-root">
      <header className="set-top">
        <button type="button" className="btn set-back" onClick={onBack}>
          ← {t("Назад")}
        </button>
        <h1 className="set-title">{t("Настройки")}</h1>
      </header>

      <div className="set-layout">
        <nav className="set-nav" aria-label={t("Разделы настроек")}>
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              className={`set-nav-item ${tab === it.id ? "current" : ""}`}
              aria-current={tab === it.id ? "page" : undefined}
              onClick={() => onTabChange(it.id)}
            >
              <span className="set-nav-n">{String(i + 1).padStart(2, "0")}</span>
              <span>{it.label}</span>
            </button>
          ))}
        </nav>

        {full ? (
          <div className="set-pane">{tab === "usage" ? renderUsage?.() : renderConnections?.()}</div>
        ) : (
          <div className="scroll set-scroll">
            <div className="set-body">
              {tab === "general" && (
                <>
          <Section title={t("Внешний вид")}>
            <Row label={t("Язык")}>
              <Segmented<Settings["language"]>
                label={t("Язык")}
                options={[
                  { value: "auto", text: t("Как в системе") },
                  { value: "en", text: "English" },
                  { value: "ru", text: "Русский" },
                ]}
                value={s.language}
                onChange={(v) => updateSettings({ language: v })}
              />
            </Row>

            <Row label={t("Тема")}>
              <Segmented<Settings["theme"]>
                label={t("Тема")}
                options={[
                  { value: "dark", text: t("Тёмная") },
                  { value: "light", text: t("Светлая") },
                  { value: "auto", text: t("Как в системе") },
                ]}
                value={s.theme}
                onChange={(v) => updateSettings({ theme: v })}
              />
            </Row>

            <Row label={t("Акцент")} hint={t("Кнопки и активные состояния")}>
              <div className="set-swatches">
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="set-swatch"
                    style={{ background: c }}
                    aria-pressed={s.accent === c}
                    aria-label={t("Акцент {color}", { color: c })}
                    title={c}
                    onClick={() => updateSettings({ accent: c })}
                  />
                ))}
                <label
                  className={"set-swatch set-custom" + (customAccent ? " on" : "")}
                  title={t("Свой цвет")}
                >
                  <input
                    type="color"
                    aria-label={t("Свой цвет акцента")}
                    value={pickerValue}
                    onChange={(e) => updateSettings({ accent: e.target.value })}
                  />
                </label>
              </div>
            </Row>

            <Row label={t("Масштаб интерфейса")} hint={t("Размер всего окна")}>
              <Segmented
                label={t("Масштаб интерфейса")}
                options={SCALES.map((v) => ({ value: v, text: `${Math.round(v * 100)}%` }))}
                value={s.uiScale}
                onChange={(v) => updateSettings({ uiScale: v })}
              />
            </Row>

            <Row
              label={t("Плитки сессии")}
              hint={t("Агент, токены, план и контекст. В узком окне всегда компактные")}
            >
              <Segmented<Settings["tilesMode"]>
                label={t("Плитки сессии")}
                options={[
                  { value: "full", text: t("Обычные") },
                  { value: "compact", text: t("Компактные") },
                ]}
                value={s.tilesMode}
                onChange={(v) => updateSettings({ tilesMode: v })}
              />
            </Row>
          </Section>

          <Section title={t("Уведомления")}>
            <Row
              label={t("Системные уведомления")}
              hint={t("Когда агент закончил или ждёт ответа в другой сессии")}
            >
              <Toggle
                label={t("Системные уведомления")}
                checked={s.notifications}
                onChange={(v) => updateSettings({ notifications: v })}
              />
            </Row>
          </Section>

                </>
              )}
              {tab === "chat" && (
                <>
          <Section title={t("Чат")}>
            <Row label={t("Отправка сообщения")}>
              <Segmented<Settings["sendWith"]>
                label={t("Отправка сообщения")}
                options={[
                  { value: "enter", text: "Enter" },
                  { value: "mod-enter", text: modKey("Enter") },
                ]}
                value={s.sendWith}
                onChange={(v) => updateSettings({ sendWith: v })}
              />
              <span className="set-note">
                {s.sendWith === "enter" ? t("Shift+Enter — новая строка") : t("Enter — новая строка")}
              </span>
            </Row>

            <Row
              label={t("Ход мысли открыт по умолчанию")}
              hint={t("Блок рассуждений модели разворачивается сразу")}
            >
              <Toggle
                label={t("Ход мысли открыт по умолчанию")}
                checked={s.thinkingExpanded}
                onChange={(v) => updateSettings({ thinkingExpanded: v })}
              />
            </Row>
          </Section>

                </>
              )}
              {tab === "instructions" && (
                <InstructionsSection
                  project={project}
                  home={home}
                  contextFiles={contextFiles}
                  agentRunning={agentRunning ?? false}
                  onNewSession={onNewSession}
                  onGenerate={onGenerateInstructions}
                />
              )}
              {tab === "models" && (
                <>
          <Section
            title={t("Модели и провайдеры")}
            desc={t("Подключайте свои OpenAI- и Anthropic-совместимые серверы.")}
          >
            <Row label={t("Провайдеры моделей")}>
              <button type="button" className="btn" onClick={onOpenProviders}>
                {t("Провайдеры моделей")}
              </button>
            </Row>
            {engineInfo?.model && (
              <p className="set-desc">{t("Текущая модель: {model}", { model: engineInfo.model })}</p>
            )}
          </Section>

          <ModelPrices models={models ?? []} subscriptions={subscriptions} onRestartAgent={onRestartAgent} />
          <BudgetSection />

                </>
              )}
              {tab === "commands" && <TemplatesSection />}
              {tab === "hotkeys" && (
                <>
          <Section title={t("Горячие клавиши")}>
            <ul className="set-keys">
              {HOTKEYS.map((h) => (
                <li key={h.text}>
                  <span className="set-kbd">
                    {h.keys.map((k, i) => (
                      <span key={k} className="set-kbd-group">
                        {i > 0 && <span className="set-kbd-sep">/</span>}
                        <kbd className="set-key">{k}</kbd>
                      </span>
                    ))}
                  </span>
                  <span className="set-kbd-text">{t(h.text)}</span>
                </li>
              ))}
            </ul>
          </Section>

                </>
              )}
              {tab === "about" && (
                <>
          <Section title={t("О программе")}>
            <div className="set-about">
              <div className="set-brand">Octopus</div>
              <div className="set-desc">{t("Версия 0.1.0")}</div>
              {engineInfo && (
                <div className="set-engine">
                  <div>{t("Движок: {status}", { status: engineInfo.status })}</div>
                  {engineInfo.project && <span className="set-path">{engineInfo.project}</span>}
                </div>
              )}
            </div>
            <div className="set-reset">
              <button
                type="button"
                className={"btn set-danger" + (armed ? " armed" : "")}
                onClick={() => {
                  if (!armed) {
                    setArmed(true);
                    return;
                  }
                  setArmed(false);
                  resetSettings();
                }}
              >
                {armed ? t("Точно сбросить?") : t("Сбросить настройки")}
              </button>
            </div>
          </Section>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function firstLine(body: string): string {
  return body.trim().split("\n")[0] ?? "";
}

function TemplatesSection(): ReactElement {
  const templates = useTemplates();
  // Template id being edited, "new" for the create form, or null.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Template id whose delete is waiting for a second click.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // The delete confirmation disarms itself after 3 seconds.
  useEffect(() => {
    if (!confirmId) return;
    const timer = window.setTimeout(() => setConfirmId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmId]);

  return (
    <Section
      title={t("Мои команды")}
      desc={t("Шаблоны задач. Набирайте /имя в поле ввода или ищите в палитре {key}.", { key: modKey("K") })}
    >
      {templates.length === 0 && editingId !== "new" && (
        <p className="set-desc">{t("Команд пока нет.")}</p>
      )}

      {templates.length > 0 && (
        <ul className="set-tpl-list">
          {templates.map((tpl) =>
            editingId === tpl.id ? (
              <li key={tpl.id} className="set-tpl-item set-tpl-editing">
                <TemplateEditor
                  initial={tpl}
                  templates={templates}
                  onDone={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li key={tpl.id} className="set-tpl-item">
                <div className="set-tpl-info">
                  <div className="set-tpl-head">
                    <span className="set-tpl-name">/{tpl.name}</span>
                    <span className="set-tpl-title">{t(tpl.title)}</span>
                  </div>
                  <div className="set-tpl-preview">{firstLine(tpl.body)}</div>
                </div>
                <div className="set-tpl-actions">
                  <button
                    type="button"
                    className="btn set-tpl-btn"
                    onClick={() => {
                      setConfirmId(null);
                      setEditingId(tpl.id);
                    }}
                  >
                    {t("Изменить")}
                  </button>
                  <button
                    type="button"
                    className={"btn set-tpl-btn set-danger" + (confirmId === tpl.id ? " armed" : "")}
                    onClick={() => {
                      if (confirmId !== tpl.id) {
                        setConfirmId(tpl.id);
                        return;
                      }
                      setConfirmId(null);
                      deleteTemplate(tpl.id);
                    }}
                  >
                    {confirmId === tpl.id ? t("Точно удалить?") : t("Удалить")}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {editingId === "new" && (
        <TemplateEditor templates={templates} onDone={() => setEditingId(null)} />
      )}

      {editingId !== "new" && (
        <div className="set-tpl-add">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setConfirmId(null);
              setEditingId("new");
            }}
          >
            {t("+ Новая команда")}
          </button>
        </div>
      )}
    </Section>
  );
}

type TemplateErrors = { name?: string; title?: string; body?: string };

function validateTemplate(
  name: string,
  title: string,
  body: string,
  templates: Template[],
  selfId: string | undefined,
): TemplateErrors {
  const e: TemplateErrors = {};
  const n = name.trim();
  if (!TEMPLATE_NAME_RE.test(n)) {
    e.name = "Только латинские буквы в нижнем регистре, цифры и дефис, до 32 символов";
  } else if (templates.some((x) => x.name === n && x.id !== selfId)) {
    e.name = "Такое имя уже есть";
  }
  if (!title.trim()) e.title = "Введите название";
  if (!body.trim()) e.body = "Введите текст задачи";
  return e;
}

function TemplateEditor({
  initial,
  templates,
  onDone,
}: {
  initial?: Template;
  templates: Template[];
  onDone: () => void;
}): ReactElement {
  const uid = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  // Errors show only after the first save attempt.
  const [tried, setTried] = useState(false);

  const errors = validateTemplate(name, title, body, templates, initial?.id);
  const shown: TemplateErrors = tried ? errors : {};

  return (
    <form
      className="set-tpl-editor"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (Object.keys(errors).length > 0) return;
        saveTemplate({
          id: initial?.id ?? newTemplateId(),
          name: name.trim(),
          title: title.trim(),
          body: body.trim(),
        });
        onDone();
      }}
    >
      <div className="set-field">
        <label className="set-field-label" htmlFor={`${uid}-name`}>
          {t("Имя")}
        </label>
        <input
          id={`${uid}-name`}
          className="set-input set-input-mono"
          value={name}
          placeholder="review"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={shown.name ? true : undefined}
          aria-describedby={shown.name ? `${uid}-name-err` : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {shown.name && (
          <p id={`${uid}-name-err`} className="set-error">
            {t(shown.name)}
          </p>
        )}
      </div>

      <div className="set-field">
        <label className="set-field-label" htmlFor={`${uid}-title`}>
          {t("Название")}
        </label>
        <input
          id={`${uid}-title`}
          className="set-input"
          value={title}
          aria-invalid={shown.title ? true : undefined}
          aria-describedby={shown.title ? `${uid}-title-err` : undefined}
          onChange={(e) => setTitle(e.target.value)}
        />
        {shown.title && (
          <p id={`${uid}-title-err`} className="set-error">
            {t(shown.title)}
          </p>
        )}
      </div>

      <div className="set-field">
        <label className="set-field-label" htmlFor={`${uid}-body`}>
          {t("Текст задачи")}
        </label>
        <textarea
          id={`${uid}-body`}
          className="set-textarea"
          rows={5}
          value={body}
          aria-invalid={shown.body ? true : undefined}
          aria-describedby={shown.body ? `${uid}-body-err` : undefined}
          onChange={(e) => setBody(e.target.value)}
        />
        {shown.body && (
          <p id={`${uid}-body-err`} className="set-error">
            {t(shown.body)}
          </p>
        )}
      </div>

      <div className="set-tpl-form-actions">
        <button type="submit" className="btn primary">
          {t("Сохранить")}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          {t("Отмена")}
        </button>
      </div>
    </form>
  );
}

function BudgetSection(): ReactElement {
  const s = useSettings();
  // Today's spend across all projects, shown under the daily limit.
  const [today, setToday] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void todaySpend().then((v) => {
      if (alive) setToday(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const hint = t("Предупредим на 80%, на 100% новые задачи остановятся до подтверждения");

  return (
    <Section title={t("БЮДЖЕТ")} desc={t("Запросы по подпискам в лимиты не входят: они уже оплачены тарифом.")}>
      <Row label={t("В день")} hint={hint}>
        <LimitInput
          label={t("Лимит в день, USD")}
          value={s.budgetDaily}
          onChange={(v) => updateSettings({ budgetDaily: v })}
        />
        {today !== null && (
          <span className="set-note">{t("Сегодня потрачено: {cost}", { cost: formatCost(today) })}</span>
        )}
      </Row>

      <Row label={t("На сессию")} hint={hint}>
        <LimitInput
          label={t("Лимит на сессию, USD")}
          value={s.budgetSession}
          onChange={(v) => updateSettings({ budgetSession: v })}
        />
      </Row>
    </Section>
  );
}

/**
 * A "$" amount input. Empty means off (null). Invalid text is not saved; it reverts
 * on blur. A value set elsewhere (reset) replaces the draft unless the draft already
 * parses to it, so a half-typed "2." is kept.
 */
function LimitInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
}): ReactElement {
  const uid = useId();
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft((prev) => {
      const parsed = parseLimit(prev);
      if (parsed.ok && parsed.value === value) return prev;
      return value === null ? "" : String(value);
    });
    setInvalid(false);
  }, [value]);

  return (
    <div className="budget-field">
      <div className={"budget-money" + (invalid ? " invalid" : "")}>
        <span className="budget-money-prefix" aria-hidden="true">
          $
        </span>
        <input
          id={uid}
          className="budget-money-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          placeholder={t("выкл.")}
          value={draft}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? `${uid}-err` : undefined}
          onChange={(e) => {
            const text = e.target.value;
            setDraft(text);
            const parsed = parseLimit(text);
            if (!parsed.ok) {
              setInvalid(true);
              return;
            }
            setInvalid(false);
            if (parsed.value !== value) onChange(parsed.value);
          }}
          onBlur={() => {
            if (!invalid) return;
            setInvalid(false);
            setDraft(value === null ? "" : String(value));
          }}
        />
      </div>
      {invalid && (
        <p id={`${uid}-err`} className="set-error" role="alert">
          {t("Введите сумму больше 0 и не больше 10 000")}
        </p>
      )}
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }): ReactElement {
  const id = useId();
  return (
    <section className="card set-card" aria-labelledby={id}>
      <header className="set-head">
        <h2 id={id} className="label set-h">
          {title}
        </h2>
        {desc && <p className="set-desc">{desc}</p>}
      </header>
      <div className="set-rows">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-label">{label}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={"set-switch" + (checked ? " on" : "")}
      onClick={() => onChange(!checked)}
    >
      <span className="set-knob" />
    </button>
  );
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; text: string }[];
  value: T;
  onChange: (next: T) => void;
}): ReactElement {
  return (
    <div className="set-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}
