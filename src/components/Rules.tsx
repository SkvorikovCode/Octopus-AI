import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  deleteRule,
  listRules,
  parseGlobs,
  ruleNameError,
  saveRule,
  slugifyRuleName,
  type Rule,
  type RuleInput,
  type RuleScope,
  type RulesList,
} from "../lib/rules";
import { displayPath } from "../lib/instructions";
import { t, tErr } from "../lib/i18n";
import "./settings.css";
import "./rules.css";

type Editing = { scope: RuleScope; rule: Rule | null };

/** Rules section of the Instructions tab: the project's and the general rules, plus foreign ones read-only. */
export function RulesSection({ project }: { project?: string }): ReactElement {
  const titleId = useId();
  const [data, setData] = useState<RulesList>();
  const [loadError, setLoadError] = useState<string>();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [changed, setChanged] = useState(false);
  // Latest request wins: an answer for an older project is dropped.
  const reqRef = useRef(0);

  const load = useCallback(async (cwd: string | undefined) => {
    const id = ++reqRef.current;
    try {
      const next = await listRules(cwd ?? null);
      if (id !== reqRef.current) return;
      setData(next);
      setLoadError(undefined);
    } catch (e) {
      if (id === reqRef.current) setLoadError(tErr(e));
    }
  }, []);

  // Mount and project change: fresh list, no open editor.
  useEffect(() => {
    setData(undefined);
    setChanged(false);
    setEditing(null);
    void load(project);
  }, [project, load]);

  const afterChange = () => {
    setEditing(null);
    setChanged(true);
    void load(project);
  };

  const closeEditor = useCallback(() => setEditing(null), []);
  const ownRules = data && editing ? (editing.scope === "project" ? data.project : data.global) : [];

  return (
    <section className="card set-card rl" aria-labelledby={titleId}>
      <header className="set-head">
        <h2 id={titleId} className="label set-h">
          {t("Правила")}
        </h2>
        <p className="set-desc">
          {t("Короткие правила для агента. «Всегда» — в каждом ответе, «По теме» — агент читает правило, когда тема подходит.")}
        </p>
      </header>

      {loadError && <div className="err-card">{loadError}</div>}
      {!data && !loadError && <p className="set-desc">{t("Загружаем…")}</p>}

      {data && (
        <>
          {project && (
            <RuleGroup
              title={t("Этот проект")}
              rules={data.project}
              onAdd={() => setEditing({ scope: "project", rule: null })}
              onOpen={(rule) => setEditing({ scope: "project", rule })}
            />
          )}
          <RuleGroup
            title={t("Для всех проектов")}
            rules={data.global}
            onAdd={() => setEditing({ scope: "global", rule: null })}
            onOpen={(rule) => setEditing({ scope: "global", rule })}
          />
          {data.foreign.length > 0 && <ForeignGroup rules={data.foreign} />}
        </>
      )}

      {changed && <p className="rl-note">{t("Изменения действуют в новых сессиях.")}</p>}

      {data && editing && (
        <RuleModal
          scope={editing.scope}
          rule={editing.rule}
          cwd={project}
          taken={ownRules.map((r) => r.name)}
          onClose={closeEditor}
          onChanged={afterChange}
        />
      )}
    </section>
  );
}

function RuleGroup({
  title,
  rules,
  onAdd,
  onOpen,
}: {
  title: string;
  rules: Rule[];
  onAdd: () => void;
  onOpen: (rule: Rule) => void;
}): ReactElement {
  return (
    <div className="rl-group">
      <div className="rl-group-head">
        <h3 className="label rl-group-title">{title}</h3>
        <button type="button" className="btn rl-add" onClick={onAdd}>
          + {t("Новое правило")}
        </button>
      </div>
      {rules.length === 0 ? (
        <p className="rl-empty">{t("Правил пока нет.")}</p>
      ) : (
        <ul className="rl-list">
          {rules.map((rule) => (
            <li key={rule.name}>
              <RuleRow rule={rule} onOpen={() => onOpen(rule)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ForeignGroup({ rules }: { rules: Rule[] }): ReactElement {
  return (
    <div className="rl-group">
      <div className="rl-group-head">
        <h3 className="label rl-group-title">{t("Из других инструментов")}</h3>
      </div>
      <p className="rl-hint">{t("Эти правила агент тоже читает. Править их лучше в том инструменте.")}</p>
      <ul className="rl-list">
        {rules.map((rule) => (
          <li key={rule.rel}>
            <RuleRow rule={rule} location={displayPath(rule.rel)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RuleRow({ rule, location, onOpen }: { rule: Rule; location?: string; onOpen?: () => void }): ReactElement {
  const body = (
    <>
      <span className="rl-row-top">
        <span className="rl-name">{rule.name}</span>
        <RuleBadge rule={rule} />
      </span>
      {rule.description && <span className="rl-desc">{rule.description}</span>}
      {rule.globs.length > 0 && <span className="rl-globs">{t("для: {globs}", { globs: rule.globs.join(", ") })}</span>}
      {location && <span className="rl-loc">{location}</span>}
    </>
  );
  return onOpen ? (
    <button type="button" className="rl-row" onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="rl-row rl-row-ro">{body}</div>
  );
}

type Mode = "off" | "overridden" | "ignored" | "special" | "always" | "topic";

/** The one state a rule shows; the first matching condition wins. */
function modeOf(rule: Rule): Mode {
  if (!rule.enabled) return "off";
  if (rule.overridden) return "overridden";
  if (rule.ignored) return "ignored";
  if (rule.special) return "special";
  return rule.always ? "always" : "topic";
}

function modeLabel(mode: Mode): string {
  switch (mode) {
    case "off":
      return t("Выключено");
    case "overridden":
      return t("Перекрыто правилом проекта");
    case "ignored":
      return t("Не работает");
    case "special":
      return t("Особое");
    case "always":
      return t("Всегда");
    case "topic":
      return t("По теме");
  }
}

function RuleBadge({ rule }: { rule: Rule }): ReactElement {
  const mode = modeOf(rule);
  return (
    <span
      className={"rl-badge " + mode}
      title={mode === "ignored" ? t("Нет описания — агент не знает, когда его читать") : undefined}
    >
      {modeLabel(mode)}
    </span>
  );
}

function RuleModal({
  scope,
  rule,
  cwd,
  taken,
  onClose,
  onChanged,
}: {
  scope: RuleScope;
  /** null for a new rule. */
  rule: Rule | null;
  cwd: string | undefined;
  /** Names already used in this scope (the rule's own name excluded by the caller's list). */
  taken: string[];
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  const uid = useId();
  const titleId = `${uid}-title`;
  const [name, setName] = useState(rule?.name ?? "");
  const [always, setAlways] = useState(rule?.always ?? true);
  const [description, setDescription] = useState(rule?.description ?? "");
  const [globs, setGlobs] = useState(rule?.globs.join(", ") ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [body, setBody] = useState(rule?.body ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string>();
  const [armed, setArmed] = useState(false);

  // The delete confirmation disarms itself after 3 seconds.
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const trimmed = name.trim();
  const nameErr = ruleNameError(trimmed);
  const nameTaken = nameErr === null && trimmed !== rule?.name && taken.includes(trimmed);
  const nameMsg = name === "" ? null : nameErr ? t(nameErr) : nameTaken ? t("Такое название уже занято") : null;
  const suggestion = nameMsg ? slugifyRuleName(name) : "";
  const suggestionOk = suggestion !== "" && suggestion !== trimmed && ruleNameError(suggestion) === null;
  const topicNoDescription = !always && description.trim() === "";
  const valid = nameErr === null && !nameTaken && !topicNoDescription && body.trim() !== "";
  const locked = busy !== null;

  const save = async () => {
    if (!valid || locked) return;
    const input: RuleInput = {
      name: trimmed,
      always,
      description: description.trim(),
      globs: always ? [] : parseGlobs(globs),
      enabled,
      body: body.trim(),
    };
    setBusy("save");
    setError(undefined);
    try {
      await saveRule(scope, cwd ?? null, rule?.name ?? null, input);
      onChanged();
    } catch (e) {
      setError(tErr(e));
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!rule || locked) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy("delete");
    setError(undefined);
    try {
      await deleteRule(scope, cwd ?? null, rule.name);
      onChanged();
    } catch (e) {
      setError(tErr(e));
      setBusy(null);
      setArmed(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="card modal rl-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 id={titleId} className="rl-modal-title">
            {rule ? rule.name : t("Новое правило")}
          </h2>
          <div className="rl-modal-sub">{scope === "project" ? t("Этот проект") : t("Для всех проектов")}</div>
        </div>

        {rule?.special && <p className="rl-note">{t("У правила есть условия срабатывания — они сохранятся.")}</p>}

        <label className="rl-field">
          <span className="rl-field-label">{t("Название")}</span>
          <input
            className="set-input set-input-mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            autoFocus={rule === null}
            value={name}
            disabled={locked}
            aria-invalid={nameMsg ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {nameMsg ? (
            <span className="rl-error">{nameMsg}</span>
          ) : (
            <span className="rl-hint">{t("латиница, цифры, - и _")}</span>
          )}
        </label>
        {nameMsg && suggestionOk && (
          <button type="button" className="btn rl-suggest" disabled={locked} onClick={() => setName(suggestion)}>
            {t("Взять «{name}»", { name: suggestion })}
          </button>
        )}

        <div className="rl-field">
          <span className="rl-field-label">{t("Режим")}</span>
          <div className="set-seg rl-seg" role="group" aria-label={t("Режим")}>
            <button type="button" aria-pressed={always} disabled={locked} onClick={() => setAlways(true)}>
              {t("Всегда")}
            </button>
            <button type="button" aria-pressed={!always} disabled={locked} onClick={() => setAlways(false)}>
              {t("По теме")}
            </button>
          </div>
          <span className="rl-hint">
            {always
              ? t("Правило попадает в каждый ответ агента.")
              : t("Агент видит описание и читает правило, когда тема подходит.")}
          </span>
        </div>

        <label className="rl-field">
          <span className="rl-field-label">{t("Описание")}</span>
          <textarea
            className="set-textarea"
            rows={2}
            spellCheck={false}
            placeholder={always ? t("Необязательно") : t("Когда агенту читать это правило")}
            value={description}
            disabled={locked}
            onChange={(e) => setDescription(e.target.value)}
          />
          {topicNoDescription && (
            <span className="rl-hint">{t("Без описания агент не знает, когда читать правило.")}</span>
          )}
        </label>

        {!always && (
          <label className="rl-field">
            <span className="rl-field-label">{t("Для файлов")}</span>
            <input
              className="set-input set-input-mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="src/db/**, *.sql"
              value={globs}
              disabled={locked}
              onChange={(e) => setGlobs(e.target.value)}
            />
            <span className="rl-hint">{t("Необязательно. Через запятую или с новой строки.")}</span>
          </label>
        )}

        <div className="rl-switch-row">
          <span className="rl-field-label">{t("Включено")}</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t("Включено")}
            className={"set-switch" + (enabled ? " on" : "")}
            disabled={locked}
            onClick={() => setEnabled(!enabled)}
          >
            <span className="set-knob" />
          </button>
        </div>

        <label className="rl-field">
          <span className="rl-field-label">{t("Текст правила")}</span>
          <textarea
            className="set-textarea rl-body"
            rows={10}
            spellCheck={false}
            value={body}
            disabled={locked}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        {error && <div className="err-card">{error}</div>}

        <div className="rl-actions">
          {rule && (
            <button
              type="button"
              className={"btn set-danger" + (armed ? " armed" : "")}
              disabled={locked}
              onClick={() => void remove()}
            >
              {busy === "delete" ? t("Удаляем…") : armed ? t("Точно удалить?") : t("Удалить")}
            </button>
          )}
          <span className="rl-spacer" />
          <button type="button" className="btn" disabled={locked} onClick={onClose}>
            {t("Отмена")}
          </button>
          <button type="button" className="btn primary" disabled={!valid || locked} onClick={() => void save()}>
            {busy === "save" ? t("Сохраняем…") : t("Сохранить")}
          </button>
        </div>
      </div>
    </div>
  );
}
