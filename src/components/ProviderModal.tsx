import { useEffect, useId, useMemo, useState, type ReactElement } from "react";
import {
  API_KINDS,
  discoverModels,
  listProviders,
  removeProvider,
  saveProvider,
  slugify,
  type ApiKind,
  type ProviderInfo,
} from "../lib/providers";
import { t, tn } from "../lib/i18n";
import { DotSpinner, Icon } from "./Glyphs";
import "./providers.css";

type Props = {
  onClose: () => void;
  onSaved: (result: { id: string; firstModel?: string }) => void;
};

const KEY_SOURCE: Record<ProviderInfo["keySource"], { label: string; warn: boolean }> = {
  octopus: { label: "ключ в Keychain", warn: false },
  env: { label: "env", warn: false },
  command: { label: "команда", warn: false },
  literal: { label: "ключ в файле", warn: true },
  none: { label: "без ключа", warn: false },
};

const toPositiveInt = (raw: string): number | undefined => {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

const dedupe = (items: string[]): string[] => [...new Set(items)];

const CHECKLIST_FILTER_THRESHOLD = 10;
const CONFIRM_TIMEOUT_MS = 3000;

export function ProviderModal({ onClose, onSaved }: Props): ReactElement {
  const uid = useId();
  const titleId = `${uid}-title`;

  // Connected providers
  const [installed, setInstalled] = useState<ProviderInfo[]>();
  const [listError, setListError] = useState<string>();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // New provider form
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState<ApiKind>("openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string>();
  const [discoverNote, setDiscoverNote] = useState<string>();
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [manual, setManual] = useState<string[]>([]);
  const [manualDraft, setManualDraft] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [contextDraft, setContextDraft] = useState("128000");
  const [maxDraft, setMaxDraft] = useState("16384");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const id = slugify(name);
  const candidates = useMemo(() => dedupe([...discovered, ...manual]), [discovered, manual]);
  // Selection in the order it was made; ids that dropped out of the candidate list are ignored.
  const chosen = selected.filter((m) => candidates.includes(m));
  const normalizedFilter = filter.trim().toLowerCase();
  const visible = normalizedFilter
    ? candidates.filter((m) => m.toLowerCase().includes(normalizedFilter))
    : candidates;
  const contextWindow = toPositiveInt(contextDraft);
  const maxTokens = toPositiveInt(maxDraft);
  const existing = installed?.find((p) => p.id === id);
  const apiHint = API_KINDS.find((k) => k.value === api)?.hint;

  const canDiscover = baseUrl.trim() !== "" && apiKey.trim() !== "" && !discovering;
  const canSave =
    id !== "" &&
    baseUrl.trim() !== "" &&
    apiKey.trim() !== "" &&
    chosen.length > 0 &&
    contextWindow !== undefined &&
    maxTokens !== undefined &&
    !saving;

  const loadList = async () => {
    try {
      setInstalled(await listProviders());
      setListError(undefined);
    } catch (e) {
      setListError(String(e));
    }
  };

  useEffect(() => {
    loadList();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The inline "delete" confirmation reverts after a few seconds.
  useEffect(() => {
    if (confirmId === null) return;
    const timer = window.setTimeout(() => setConfirmId(null), CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [confirmId]);

  const remove = async (providerId: string) => {
    setRemovingId(providerId);
    try {
      await removeProvider(providerId);
      await loadList();
    } catch (e) {
      setListError(String(e));
    } finally {
      setRemovingId(null);
      setConfirmId(null);
    }
  };

  const discover = async () => {
    setDiscovering(true);
    setDiscoverError(undefined);
    setDiscoverNote(undefined);
    try {
      const found = await discoverModels(baseUrl.trim(), api, apiKey.trim());
      setDiscovered(found);
      setFilter("");
      if (found.length === 0) setDiscoverNote("Сервер не вернул моделей. Добавьте ID вручную ниже.");
    } catch (e) {
      setDiscoverError(String(e));
    } finally {
      setDiscovering(false);
    }
  };

  const toggle = (model: string) =>
    setSelected((s) => (s.includes(model) ? s.filter((x) => x !== model) : [...s, model]));

  const selectVisible = () => setSelected((s) => dedupe([...s, ...visible]));

  const clearVisible = () => setSelected((s) => s.filter((x) => !visible.includes(x)));

  const addManual = () => {
    const model = manualDraft.trim();
    if (!model) return;
    if (!candidates.includes(model)) setManual((list) => [...list, model]);
    setSelected((s) => (s.includes(model) ? s : [...s, model]));
    setManualDraft("");
  };

  const save = async () => {
    if (!canSave || contextWindow === undefined || maxTokens === undefined) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await saveProvider({
        id,
        baseUrl: baseUrl.trim(),
        api,
        apiKey: apiKey.trim(),
        models: chosen.map((m) => ({ id: m, contextWindow, maxTokens })),
      });
      onSaved({ id, firstModel: chosen[0] });
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="card modal prov-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prov-head">
          <h2 id={titleId}>{t("Провайдеры моделей")}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("Закрыть")}>
            <Icon name="close" />
          </button>
        </div>

        <p>
          {t(
            "Подключите любой OpenAI- или Anthropic-совместимый сервер. Ключ хранится в связке ключей системы, в конфиг агента попадает только ссылка на него.",
          )}
        </p>

        {/* Connected providers */}
        <section className="prov-section" aria-label={t("Подключённые провайдеры")}>
          <div className="label">{t("Подключённые")}</div>

          {listError && <div className="err-card">{listError}</div>}

          {installed === undefined && !listError && <div className="prov-empty">{t("Загрузка…")}</div>}

          {installed?.length === 0 && <div className="prov-empty">{t("Провайдеров пока нет.")}</div>}

          {installed && installed.length > 0 && (
            <div className="prov-list">
              {installed.map((p) => {
                const ks = KEY_SOURCE[p.keySource] ?? { label: p.keySource, warn: false };
                const confirming = confirmId === p.id;
                return (
                  <div className="prov-row" key={p.id}>
                    <div className="prov-row-main">
                      <span className="prov-row-id">{p.id}</span>
                      <span className="prov-row-url" title={p.baseUrl}>
                        {p.baseUrl}
                      </span>
                    </div>
                    <div className="prov-row-meta">
                      <span className="prov-count">{tn(p.models.length, "модель|модели|моделей")}</span>
                      <span className={`prov-badge${ks.warn ? " warn" : ""}`}>{t(ks.label)}</span>
                      {p.managed ? (
                        <button
                          type="button"
                          className={`prov-del${confirming ? " confirm" : ""}`}
                          disabled={removingId === p.id}
                          onClick={() => (confirming ? remove(p.id) : setConfirmId(p.id))}
                        >
                          {confirming ? t("Точно удалить?") : t("Удалить")}
                        </button>
                      ) : (
                        <span className="prov-note">{t("настроен вручную")}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* New provider */}
        <section className="prov-section" aria-label={t("Новый провайдер")}>
          <div className="label">{t("Новый провайдер")}</div>

          <div className="prov-field">
            <label className="label prov-label" htmlFor={`${uid}-name`}>
              {t("Название")}
            </label>
            <input
              id={`${uid}-name`}
              className="prov-input"
              value={name}
              placeholder={t("Например, My Proxy")}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
            <span className="prov-id">ID: {id || "—"}</span>
            {name.trim() !== "" && id === "" && (
              <span className="prov-hint warn">
                {t("Нужны латинские буквы или цифры: из названия не получился ID.")}
              </span>
            )}
            {existing && (
              <span className="prov-hint warn">
                {t("Провайдер «{id}» уже подключён и будет перезаписан.", { id })}
              </span>
            )}
          </div>

          <div className="prov-field">
            <label className="label prov-label" htmlFor={`${uid}-url`}>
              Base URL
            </label>
            <input
              id={`${uid}-url`}
              className="prov-input"
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          <div className="prov-field">
            <span className="label prov-label" id={`${uid}-api-label`}>
              {t("Тип API")}
            </span>
            <div className="prov-seg" role="group" aria-labelledby={`${uid}-api-label`}>
              {API_KINDS.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  aria-pressed={api === k.value}
                  onClick={() => setApi(k.value)}
                >
                  {t(k.label)}
                </button>
              ))}
            </div>
            {apiHint && <span className="prov-hint">{t(apiHint)}</span>}
          </div>

          <div className="prov-field">
            <label className="label prov-label" htmlFor={`${uid}-key`}>
              {t("API-ключ")}
            </label>
            <input
              id={`${uid}-key`}
              className="prov-input"
              type="password"
              value={apiKey}
              autoComplete="off"
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn prov-inline-btn"
            disabled={!canDiscover}
            onClick={discover}
          >
            {discovering && <DotSpinner />}
            {t("Получить модели")}
          </button>

          {discoverError && <div className="err-card">{discoverError}</div>}
          {discoverNote && <span className="prov-hint">{t(discoverNote)}</span>}

          {candidates.length > 0 && (
            <div className="prov-field">
              {candidates.length > CHECKLIST_FILTER_THRESHOLD && (
                <>
                  <label className="prov-sr" htmlFor={`${uid}-filter`}>
                    {t("Фильтр моделей")}
                  </label>
                  <input
                    id={`${uid}-filter`}
                    className="prov-input"
                    value={filter}
                    placeholder={t("Фильтр моделей")}
                    autoComplete="off"
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </>
              )}

              <div className="prov-toolbar">
                <span className="prov-hint">
                  {t("Выбрано: {chosen} из {total}", { chosen: chosen.length, total: candidates.length })}
                </span>
                <button type="button" className="prov-link" disabled={visible.length === 0} onClick={selectVisible}>
                  {t("Выбрать все")}
                </button>
                <span className="prov-hint">/</span>
                <button type="button" className="prov-link" disabled={visible.length === 0} onClick={clearVisible}>
                  {t("Снять все")}
                </button>
              </div>

              <div className="prov-check-list" role="group" aria-label={t("Модели")}>
                {visible.map((m) => (
                  <label key={m} className="prov-check-item">
                    <input type="checkbox" checked={selected.includes(m)} onChange={() => toggle(m)} />
                    <span>{m}</span>
                  </label>
                ))}
                {visible.length === 0 && <span className="prov-hint">{t("Ничего не найдено")}</span>}
              </div>
            </div>
          )}

          <div className="prov-field">
            <label className="label prov-label" htmlFor={`${uid}-manual`}>
              {t("ID модели")}
            </label>
            <div className="prov-manual">
              <input
                id={`${uid}-manual`}
                className="prov-input"
                value={manualDraft}
                placeholder={t("например, gpt-4o-mini")}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setManualDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addManual();
                  }
                }}
              />
              <button type="button" className="btn" disabled={!manualDraft.trim()} onClick={addManual}>
                {t("Добавить")}
              </button>
            </div>
          </div>

          <div className="prov-row2">
            <div className="prov-field">
              <label className="label prov-label" htmlFor={`${uid}-ctx`}>
                {t("Контекст, токенов")}
              </label>
              <input
                id={`${uid}-ctx`}
                className="prov-input"
                type="number"
                min={1}
                inputMode="numeric"
                value={contextDraft}
                aria-invalid={contextWindow === undefined}
                onChange={(e) => setContextDraft(e.target.value)}
              />
            </div>
            <div className="prov-field">
              <label className="label prov-label" htmlFor={`${uid}-max`}>
                {t("Макс. ответ")}
              </label>
              <input
                id={`${uid}-max`}
                className="prov-input"
                type="number"
                min={1}
                inputMode="numeric"
                value={maxDraft}
                aria-invalid={maxTokens === undefined}
                onChange={(e) => setMaxDraft(e.target.value)}
              />
            </div>
          </div>
          <span className="prov-hint">{t("Значения применяются ко всем выбранным моделям.")}</span>
        </section>

        {saveError && <div className="err-card">{saveError}</div>}

        <div className="prov-actions">
          <button type="button" className="btn primary" disabled={!canSave} onClick={save}>
            {saving ? t("Подключаем…") : t("Подключить")}
          </button>
        </div>
      </div>
    </div>
  );
}
