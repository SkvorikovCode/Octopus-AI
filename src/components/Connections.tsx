import { useEffect, useId, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import {
  joinArgs,
  listMcp,
  removeMcp,
  saveMcp,
  setMcpEnabled,
  splitArgs,
  type McpKind,
  type McpScope,
  type McpServer,
  type McpServerInput,
} from "../lib/mcp";
import { t, tErr } from "../lib/i18n";
import { DotSpinner, Icon } from "./Glyphs";
import "./settings.css";
import "./connections.css";

export type ConnectionsScreenProps = {
  project?: string;
  skills: { name: string; description?: string }[];
  onBack: () => void;
  /** Shown as a settings tab: no own header. */
  embedded?: boolean;
  onRestartAgent: () => void;
};

const CONFIRM_TIMEOUT_MS = 3000;
/** Same rule as the backend: `^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$`, up to 100 characters. */
const SERVER_NAME_RE = /^[a-zA-Z0-9_.:-]+( [a-zA-Z0-9_.:-]+)*$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Printable ASCII without spaces and colons. */
const HEADER_NAME_RE = /^[\x21-\x39\x3b-\x7e]+$/;

type Editor = { mode: "new" } | { mode: "edit"; server: McpServer };

export function ConnectionsScreen({ project, skills, onBack, onRestartAgent, embedded = false }: ConnectionsScreenProps): ReactElement {
  const uid = useId();
  const [servers, setServers] = useState<McpServer[]>();
  const [loadError, setLoadError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  /** A change was saved; the running agent still uses the old config. */
  const [pendingRestart, setPendingRestart] = useState(false);
  const [rowError, setRowError] = useState<string>();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** "scope:name" of the row whose remove waits for a second click. */
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMcp(project).then(
      (list) => {
        if (!cancelled) {
          setServers(list);
          setLoadError(undefined);
        }
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(tErr(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project, reloadKey]);

  // The remove confirmation disarms itself after a few seconds.
  useEffect(() => {
    if (!confirmKey) return;
    const timer = window.setTimeout(() => setConfirmKey(null), CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [confirmKey]);

  async function change(key: string, op: () => Promise<void>) {
    setBusyKey(key);
    setRowError(undefined);
    try {
      await op();
      setPendingRestart(true);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setRowError(tErr(err));
    } finally {
      setBusyKey(null);
    }
  }

  const skillList = skills.map((s) => ({ name: s.name.replace(/^skill:/, ""), description: s.description }));

  return (
    <div className="cn-root">
      {!embedded && (
        <header className="cn-top">
          <button type="button" className="btn cn-back" onClick={onBack}>
            ← {t("Назад")}
          </button>
          <h1 className="cn-title">{t("Подключения")}</h1>
        </header>
      )}

      <div className="scroll cn-scroll">
        <div className="cn-body">
          {pendingRestart && (
            <div className="cn-banner" role="status">
              <span>{t("Изменения применятся после перезапуска агента")}</span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPendingRestart(false);
                  onRestartAgent();
                }}
              >
                <Icon name="refresh" size={14} /> {t("Перезапустить агента")}
              </button>
            </div>
          )}

          <section className="card cn-card" aria-labelledby={`${uid}-mcp`}>
            <header className="cn-head">
              <h2 id={`${uid}-mcp`} className="label cn-h">
                {t("MCP-СЕРВЕРЫ")}
              </h2>
              <button type="button" className="btn cn-add" onClick={() => setEditor({ mode: "new" })}>
                <Icon name="plus" size={14} /> {t("Добавить сервер")}
              </button>
            </header>

            {loadError && (
              <div className="err-card" role="alert">
                {loadError}
              </div>
            )}
            {rowError && (
              <div className="err-card cn-err" role="alert">
                {rowError}
              </div>
            )}

            {servers === undefined && !loadError && (
              <div className="cn-state" role="status">
                <DotSpinner size={14} />
                <span>{t("Загрузка…")}</span>
              </div>
            )}

            {servers?.length === 0 && (
              <p className="cn-empty">
                {t("MCP-серверы дают агенту доступ к внешним инструментам: базам данных, GitHub, браузеру…")}
              </p>
            )}

            {servers && servers.length > 0 && (
              <ul className="cn-list">
                {servers.map((s) => {
                  const key = `${s.scope}:${s.name}`;
                  return (
                    <ServerRow
                      key={key}
                      server={s}
                      busy={busyKey === key}
                      confirming={confirmKey === key}
                      onToggle={() => change(key, () => setMcpEnabled(project, s.scope, s.name, !s.enabled))}
                      onEdit={() => setEditor({ mode: "edit", server: s })}
                      onRemove={() => {
                        if (confirmKey !== key) {
                          setConfirmKey(key);
                          return;
                        }
                        setConfirmKey(null);
                        void change(key, () => removeMcp(project, s.scope, s.name));
                      }}
                    />
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card cn-card" aria-labelledby={`${uid}-skills`}>
            <header className="cn-head">
              <h2 id={`${uid}-skills`} className="label cn-h">
                {t("НАВЫКИ")}
              </h2>
            </header>
            <p className="cn-note">{t("Навыки агент находит сам в папках навыков проекта и пользователя")}</p>
            {skillList.length === 0 ? (
              <p className="cn-empty">{t("Навыков пока нет")}</p>
            ) : (
              <ul className="cn-list">
                {skillList.map((s) => (
                  <li key={s.name} className="cn-row cn-skill">
                    <span className="cn-name">{s.name}</span>
                    {s.description && <span className="cn-desc" title={s.description}>{s.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {editor && (
        <ServerModal
          project={project}
          editing={editor.mode === "edit" ? editor.server : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setPendingRestart(true);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function commandText(s: McpServer): string {
  if (s.kind === "stdio") return [s.command ?? "", ...s.args].filter(Boolean).join(" ");
  return s.url ?? "";
}

function ServerRow({
  server: s,
  busy,
  confirming,
  onToggle,
  onEdit,
  onRemove,
}: {
  server: McpServer;
  busy: boolean;
  confirming: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): ReactElement {
  const cmd = commandText(s);
  return (
    <li className={"cn-row" + (s.enabled ? "" : " is-off")}>
      <div className="cn-main">
        <div className="cn-title-line">
          <span className="cn-name">{s.name}</span>
          <span className="chip">{s.kind}</span>
          <span className="chip">{s.scope === "project" ? t("Проект") : t("Все проекты")}</span>
        </div>
        <div className="cn-cmd mono" title={cmd}>
          {cmd}
        </div>
      </div>
      <div className="cn-actions">
        <Toggle
          label={t("Включить сервер {name}", { name: s.name })}
          checked={s.enabled}
          disabled={busy}
          onChange={onToggle}
        />
        <button type="button" className="btn cn-btn" onClick={onEdit} disabled={busy}>
          {t("Изменить")}
        </button>
        <button
          type="button"
          className={"btn cn-btn cn-danger" + (confirming ? " armed" : "")}
          onClick={onRemove}
          disabled={busy}
        >
          {confirming ? t("Удалить?") : t("Удалить")}
        </button>
      </div>
    </li>
  );
}

// ---------- add / edit dialog ----------

type KvRow = { id: number; key: string; value: string; original: boolean };

let rowSeq = 1;

function rowsFrom(keys: string[] | undefined): KvRow[] {
  return (keys ?? []).map((key) => ({ id: rowSeq++, key, value: "", original: true }));
}

type Built = { input: McpServerInput } | { error: string };

/**
 * Values for one section (env or headers). Nothing typed and no rows added or removed
 * means "unchanged" (undefined); otherwise every row is sent, and an empty value on a
 * stored key keeps the saved value.
 */
function sectionValues(
  rows: KvRow[],
  section: "env" | "headers",
): { map?: Record<string, string> } | { error: string } {
  const filled = rows.filter((r) => r.key.trim() !== "" || r.value.trim() !== "");
  const original = rows.filter((r) => r.original).map((r) => r.key.trim());
  const seen = new Set<string>();
  for (const r of filled) {
    const key = r.key.trim();
    if (!key) return { error: section === "env" ? t("Укажите имя переменной") : t("Укажите имя заголовка") };
    const valid = section === "env" ? ENV_NAME_RE.test(key) : HEADER_NAME_RE.test(key);
    if (!valid) {
      return {
        error: section === "env"
          ? t("Имя переменной: только латиница, цифры и _")
          : t("Имя заголовка: без пробелов и двоеточий"),
      };
    }
    if (seen.has(key)) return { error: t("Имя повторяется: {key}", { key }) };
    seen.add(key);
    if (!original.includes(key) && !r.value.trim()) return { error: t("Укажите значение: {key}", { key }) };
  }
  const changed =
    filled.some((r) => r.value.trim() !== "") ||
    seen.size !== original.length ||
    original.some((k) => !seen.has(k));
  if (!changed) return {};
  const map: Record<string, string> = {};
  for (const r of filled) map[r.key.trim()] = r.value;
  return { map };
}

function ServerModal({
  project,
  editing,
  onClose,
  onSaved,
}: {
  project?: string;
  editing?: McpServer;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const uid = useId();
  const titleId = `${uid}-title`;
  const [name, setName] = useState(editing?.name ?? "");
  const [scope, setScope] = useState<McpScope>(editing?.scope ?? "user");
  const [kind, setKind] = useState<McpKind>(editing?.kind ?? "stdio");
  const [command, setCommand] = useState(editing?.command ?? "");
  const [argsText, setArgsText] = useState(joinArgs(editing?.args ?? []));
  const [url, setUrl] = useState(editing?.url ?? "");
  const [envRows, setEnvRows] = useState<KvRow[]>(() => rowsFrom(editing?.envKeys));
  const [headerRows, setHeaderRows] = useState<KvRow[]>(() => rowsFrom(editing?.headerKeys));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const scopeOptions: { value: McpScope; label: string }[] = [{ value: "user", label: t("Все проекты") }];
  if (project) scopeOptions.push({ value: "project", label: t("Этот проект") });

  function build(): Built {
    const n = name.trim();
    if (!SERVER_NAME_RE.test(n) || n.length > 100) {
      return { error: t("Имя: латиница, цифры, . _ : - и пробелы, до 100 знаков") };
    }
    if (kind === "stdio") {
      const cmd = command.trim();
      if (!cmd) return { error: t("Укажите команду запуска") };
      const env = sectionValues(envRows, "env");
      if ("error" in env) return env;
      return {
        input: { name: n, kind, command: cmd, args: splitArgs(argsText), env: env.map },
      };
    }
    const u = url.trim();
    if (!u) return { error: t("Укажите адрес сервера") };
    if (!(u.startsWith("http://") || u.startsWith("https://"))) {
      return { error: t("Адрес должен начинаться с http:// или https://") };
    }
    const headers = sectionValues(headerRows, "headers");
    if ("error" in headers) return headers;
    return { input: { name: n, kind, url: u, headers: headers.map } };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const built = build();
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await saveMcp(project, scope, built.input, editing?.name);
      onSaved();
    } catch (err) {
      setError(tErr(err));
      setSaving(false);
    }
  }

  const isStdio = kind === "stdio";

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="card modal cn-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cn-modal-head">
          <h2 id={titleId}>{editing ? t("Изменить сервер") : t("Добавить сервер")}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("Закрыть")}>
            <Icon name="close" />
          </button>
        </div>

        <form className="cn-form" noValidate onSubmit={submit}>
          <Field label={t("Имя")} htmlFor={`${uid}-name`} hint={t("Латиница, цифры, . _ : - и пробелы")}>
            <input
              id={`${uid}-name`}
              className="set-input set-input-mono"
              value={name}
              placeholder="postgres"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field label={t("Область")}>
            <Segmented<McpScope>
              label={t("Область")}
              value={scope}
              options={scopeOptions}
              disabled={!!editing}
              onChange={setScope}
            />
          </Field>

          <Field label={t("Тип")}>
            <Segmented<McpKind>
              label={t("Тип")}
              value={kind}
              options={[
                { value: "stdio", label: t("Команда") },
                { value: "http", label: "HTTP" },
                { value: "sse", label: "SSE" },
              ]}
              onChange={setKind}
            />
          </Field>

          {isStdio ? (
            <>
              <Field label={t("Команда запуска")} htmlFor={`${uid}-cmd`}>
                <input
                  id={`${uid}-cmd`}
                  className="set-input set-input-mono"
                  value={command}
                  placeholder="npx"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </Field>
              <Field
                label={t("Аргументы")}
                htmlFor={`${uid}-args`}
                hint={t("Аргументы через пробел; в кавычках — значения с пробелами")}
              >
                <input
                  id={`${uid}-args`}
                  className="set-input set-input-mono"
                  value={argsText}
                  placeholder="-y @modelcontextprotocol/server-postgres"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => setArgsText(e.target.value)}
                />
              </Field>
              <Field label={t("Переменные окружения")} hint={hintFor(editing)}>
                <KvEditor
                  rows={envRows}
                  onChange={setEnvRows}
                  addLabel={t("+ Добавить переменную")}
                  keyLabel={t("Имя переменной")}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label={t("Адрес")} htmlFor={`${uid}-url`}>
                <input
                  id={`${uid}-url`}
                  className="set-input set-input-mono"
                  value={url}
                  placeholder="https://"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  inputMode="url"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <Field label={t("Заголовки")} hint={hintFor(editing)}>
                <KvEditor
                  rows={headerRows}
                  onChange={setHeaderRows}
                  addLabel={t("+ Добавить заголовок")}
                  keyLabel={t("Имя заголовка")}
                />
              </Field>
            </>
          )}

          {error && (
            <p className="set-error" role="alert">
              {error}
            </p>
          )}

          <div className="cn-form-actions">
            <button type="submit" className="btn primary" disabled={saving}>
              {t("Сохранить")}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              {t("Отмена")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function hintFor(editing: McpServer | undefined): string | undefined {
  return editing ? t("Значения скрыты. Пустое поле у сохранённой переменной оставляет старое значение.") : t("Значения скрыты.");
}

function KvEditor({
  rows,
  onChange,
  addLabel,
  keyLabel,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  addLabel: string;
  keyLabel: string;
}): ReactElement {
  const update = (id: number, patch: Partial<KvRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="cn-kv">
      {rows.map((r) => (
        <div className="cn-kv-row" key={r.id}>
          <input
            className="set-input set-input-mono cn-kv-key"
            value={r.key}
            placeholder={keyLabel}
            aria-label={keyLabel}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => update(r.id, { key: e.target.value })}
          />
          <input
            type="password"
            className="set-input set-input-mono cn-kv-val"
            value={r.value}
            placeholder={r.original && !r.value ? t("не изменено") : t("Значение")}
            aria-label={`${r.key || keyLabel}: ${t("Значение")}`}
            autoComplete="new-password"
            onChange={(e) => update(r.id, { value: e.target.value })}
          />
          <button
            type="button"
            className="icon-btn cn-kv-del"
            aria-label={t("Убрать")}
            title={t("Убрать")}
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn cn-kv-add"
        onClick={() => onChange([...rows, { id: rowSeq++, key: "", value: "", original: false }])}
      >
        {addLabel}
      </button>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="set-field cn-field">
      {htmlFor ? (
        <label className="set-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="set-field-label">{label}</span>
      )}
      {children}
      {hint && <p className="cn-hint">{hint}</p>}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (next: T) => void;
}): ReactElement {
  return (
    <div className="set-seg cn-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={"set-switch" + (checked ? " on" : "")}
      onClick={onChange}
    >
      <span className="set-knob" />
    </button>
  );
}
