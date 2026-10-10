import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from "react";
import { listProviders, setModelCost, type ModelCost } from "../lib/providers";
import { locale, t, tErr } from "../lib/i18n";
import "./settings.css";
import "./prices.css";

/** A model as the running agent lists it; `cost` is the effective price (own or catalog). */
export type PriceModel = { provider: string; id: string; name?: string; cost?: ModelCost };

type Props = {
  models: PriceModel[];
  /** Providers on a flat-rate subscription: their prices are only an estimate. */
  subscriptions?: ReadonlySet<string>;
  onRestartAgent?: () => void;
};

type Quad = { input: number; output: number; cacheRead: number; cacheWrite: number };
type PriceField = keyof Quad;
type Prices = Record<PriceField, string>;
type Source = "own" | "free" | "catalog" | "none" | "plan";

const FIELDS: PriceField[] = ["input", "output", "cacheRead", "cacheWrite"];
const EMPTY_PRICES: Prices = { input: "", output: "", cacheRead: "", cacheWrite: "" };
const PRICE_MAX = 10000;
const THRESHOLD_MAX = 100_000_000;
const LONG_THRESHOLD_DEFAULT = 272000;
const KEY_SEP = "\u0001";

const keyOf = (provider: string, id: string): string => provider + KEY_SEP + id;

/** Free means every price is zero, including the long tier if there is one. */
function isZeroCost(c: ModelCost): boolean {
  const base = FIELDS.every((f) => c[f] === 0);
  if (!c.longContext) return base;
  return base && FIELDS.every((f) => c.longContext?.[f] === 0);
}

function sourceOf(own: ModelCost | undefined, effective: ModelCost | undefined): Source {
  if (own) return isZeroCost(own) ? "free" : "own";
  if (effective && !isZeroCost(effective)) return "catalog";
  return "none";
}

const SOURCE_LABEL: Record<Source, () => string> = {
  own: () => t("своя"),
  free: () => t("бесплатно"),
  catalog: () => t("из каталога"),
  none: () => t("нет цены"),
  plan: () => t("по подписке"),
};

/** Up to three decimals, trailing zeros trimmed; "—" when unknown. */
function formatPrice(n: number | undefined): string {
  if (n === undefined) return "—";
  return n.toLocaleString(locale(), { maximumFractionDigits: 3 });
}

/** A price in USD per 1M tokens: a finite number from 0 to PRICE_MAX, comma or dot allowed. */
function parseNumber(raw: string, max: number, integer = false): number | undefined {
  const s = raw.trim().replace(",", ".");
  if (s === "") return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > max) return undefined;
  if (integer && (!Number.isInteger(n) || n < 1)) return undefined;
  return n;
}

function parsePrices(p: Prices): Quad | undefined {
  const out = {} as Quad;
  for (const f of FIELDS) {
    const v = parseNumber(p[f], PRICE_MAX);
    if (v === undefined) return undefined;
    out[f] = v;
  }
  return out;
}

function toPrices(q: Quad | undefined): Prices {
  if (!q) return EMPTY_PRICES;
  return { input: String(q.input), output: String(q.output), cacheRead: String(q.cacheRead), cacheWrite: String(q.cacheWrite) };
}

const NO_SUBSCRIPTIONS: ReadonlySet<string> = new Set();

export function ModelPrices({ models, subscriptions = NO_SUBSCRIPTIONS, onRestartAgent }: Props): ReactElement {
  const titleId = useId();
  // Own providers from the settings file: which models are editable, and their own prices.
  const [own, setOwn] = useState<{ providers: Set<string>; costs: Map<string, ModelCost | undefined> }>();
  const [loadError, setLoadError] = useState<string>();
  const [editing, setEditing] = useState<PriceModel | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await listProviders();
      const costs = new Map<string, ModelCost | undefined>();
      for (const p of list) for (const m of p.models) costs.set(keyOf(p.id, m.id), m.cost);
      setOwn({ providers: new Set(list.map((p) => p.id)), costs });
      setLoadError(undefined);
    } catch (e) {
      setLoadError(tErr(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, PriceModel[]>();
    for (const m of models) {
      const list = map.get(m.provider);
      if (list) list.push(m);
      else map.set(m.provider, [m]);
    }
    return [...map.entries()];
  }, [models]);

  const ownCost = (m: PriceModel): ModelCost | undefined => own?.costs.get(keyOf(m.provider, m.id));
  const isEditable = (m: PriceModel): boolean => own?.providers.has(m.provider) ?? false;
  const hasUnpriced = models.some((m) => !subscriptions.has(m.provider) && sourceOf(ownCost(m), m.cost) === "none");

  return (
    <section className="card set-card" aria-labelledby={titleId}>
      <header className="set-head">
        <h2 id={titleId} className="label set-h">
          {t("ЦЕНЫ МОДЕЛЕЙ")}
        </h2>
        <p className="set-desc">{t("Цена за 1 млн токенов, USD. По ним считаются статистика и бюджет.")}</p>
      </header>

      <div className="set-rows">
        {changed && (
          <div className="mp-banner" role="status">
            <span className="mp-banner-text">
              {t("Новые цены применятся после перезапуска агента и только к новым запросам")}
            </span>
            {onRestartAgent && (
              <button
                type="button"
                className="btn mp-banner-btn"
                onClick={() => {
                  setChanged(false);
                  onRestartAgent();
                }}
              >
                {t("Перезапустить агента")}
              </button>
            )}
          </div>
        )}

        {loadError && <div className="err-card">{loadError}</div>}

        {models.length === 0 ? (
          <p className="set-desc mp-empty">{t("Список моделей появится, когда агент запустится.")}</p>
        ) : (
          <div className="mp-table">
            <div className="mp-head" aria-hidden="true">
              <span>{t("Модель")}</span>
              <div className="mp-nums">
                <span>{t("Вход")}</span>
                <span>{t("Выход")}</span>
                <span>{t("Кэш: чтение")}</span>
                <span>{t("Кэш: запись")}</span>
              </div>
              <span />
            </div>

            {groups.map(([provider, list]) => (
              <div className="mp-group" key={provider}>
                <div className="mp-group-label">{provider}</div>
                {subscriptions.has(provider) && (
                  <p className="mp-note mp-plan-note">
                    {t("Оплачено подпиской: цены — оценка по каталогу, в бюджет запросы не входят.")}
                  </p>
                )}
                {list.map((m) => (
                  <PriceRow
                    key={keyOf(m.provider, m.id)}
                    model={m}
                    own={ownCost(m)}
                    plan={subscriptions.has(m.provider)}
                    editable={isEditable(m)}
                    onEdit={() => setEditing(m)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        {hasUnpriced && (
          <p className="mp-note">{t("Траты моделей без цены не учитываются ни в статистике, ни в бюджете.")}</p>
        )}
      </div>

      {editing && (
        <PriceModal
          model={editing}
          own={ownCost(editing)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setChanged(true);
            void load();
          }}
        />
      )}
    </section>
  );
}

function PriceRow({
  model,
  own,
  plan,
  editable,
  onEdit,
}: {
  model: PriceModel;
  own: ModelCost | undefined;
  /** Covered by a flat-rate subscription. */
  plan: boolean;
  editable: boolean;
  onEdit: () => void;
}): ReactElement {
  const priced = sourceOf(own, model.cost);
  const src: Source = plan ? "plan" : priced;
  const shown = priced === "none" ? undefined : own ?? model.cost;
  const name = model.name || model.id;
  const tier = shown?.longContext;
  const cells: { label: string; value: number | undefined }[] = [
    { label: t("Вход"), value: shown?.input },
    { label: t("Выход"), value: shown?.output },
    { label: t("Кэш: чтение"), value: shown?.cacheRead },
    { label: t("Кэш: запись"), value: shown?.cacheWrite },
  ];

  return (
    <div
      className={"mp-row " + (editable ? "editable" : "readonly") + (plan ? " plan" : "")}
      title={
        plan
          ? t("Оплачено подпиской: цена — оценка по каталогу")
          : editable
            ? undefined
            : t("Цены встроенных провайдеров берутся из каталога")
      }
      onClick={editable ? onEdit : undefined}
    >
      <div className="mp-name">
        <span className="mp-model">{name}</span>
        {name !== model.id && <span className="mp-id">{model.id}</span>}
        {tier && (
          <span className="mp-tag" title={t("Дороже на длинном контексте")}>
            {t("дороже после {n}K", { n: Math.round(tier.inputThreshold / 1000) })}
          </span>
        )}
      </div>

      <div className="mp-nums">
        {cells.map((c) => (
          <span key={c.label} className={"mp-num" + (c.value === undefined ? " unknown" : "")} data-label={c.label}>
            {formatPrice(c.value)}
          </span>
        ))}
      </div>

      <div className="mp-actions">
        <span className={"mp-src " + src}>{SOURCE_LABEL[src]()}</span>
        {editable && (
          <button
            type="button"
            className="btn mp-edit"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            {t("Изменить")}
          </button>
        )}
      </div>
    </div>
  );
}

function PriceModal({
  model,
  own,
  onClose,
  onSaved,
}: {
  model: PriceModel;
  own: ModelCost | undefined;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const uid = useId();
  const titleId = `${uid}-title`;
  const effective = own ?? model.cost;
  const name = model.name || model.id;

  const [base, setBase] = useState<Prices>(() => toPrices(effective));
  const [tierOn, setTierOn] = useState(() => !!effective?.longContext);
  const [threshold, setThreshold] = useState(() =>
    String(effective?.longContext?.inputThreshold ?? LONG_THRESHOLD_DEFAULT),
  );
  const [tier, setTier] = useState<Prices>(() => toPrices(effective?.longContext));
  // Validation messages show only after the first save attempt.
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const parsedBase = parsePrices(base);
  const parsedTier = tierOn ? parsePrices(tier) : undefined;
  const thresholdN = parseNumber(threshold, THRESHOLD_MAX, true);
  const valid = parsedBase !== undefined && (!tierOn || (parsedTier !== undefined && thresholdN !== undefined));

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onSaved();
    } catch (e) {
      setError(tErr(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    setTried(true);
    if (!parsedBase || (tierOn && (!parsedTier || thresholdN === undefined))) return;
    const cost: ModelCost = tierOn && parsedTier && thresholdN !== undefined
      ? { ...parsedBase, longContext: { inputThreshold: thresholdN, ...parsedTier } }
      : { ...parsedBase };
    void run(() => setModelCost(model.provider, model.id, cost));
  };

  const makeFree = () =>
    void run(() => setModelCost(model.provider, model.id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));

  const useCatalog = () => void run(() => setModelCost(model.provider, model.id, null));

  const toggleTier = () => {
    // Turning the tier on starts from the base prices if the tier is still empty.
    if (!tierOn && FIELDS.every((f) => tier[f] === "")) setTier({ ...base });
    setTierOn(!tierOn);
  };

  const invalidPrice = (p: Prices, f: PriceField) => tried && parseNumber(p[f], PRICE_MAX) === undefined;

  const labels: Record<PriceField, string> = {
    input: t("Вход"),
    output: t("Выход"),
    cacheRead: t("Чтение кэша"),
    cacheWrite: t("Запись кэша"),
  };

  const priceFields = (p: Prices, set: (next: Prices) => void, prefix: string) =>
    FIELDS.map((f) => {
      const bad = invalidPrice(p, f);
      return (
        <label className="mp-field" key={prefix + f}>
          <span className="label">{labels[f]}</span>
          <span className={"mp-money" + (bad ? " invalid" : "")}>
            <input
              className="mp-money-input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={p[f]}
              aria-invalid={bad || undefined}
              autoFocus={prefix === "b-" && f === "input"}
              onChange={(e) => set({ ...p, [f]: e.target.value })}
            />
            <span className="mp-suffix">$ / 1M</span>
          </span>
        </label>
      );
    });

  const formError = !tried
    ? undefined
    : !parsedBase || (tierOn && !parsedTier)
      ? t("Введите число от 0 до 10 000")
      : tierOn && thresholdN === undefined
        ? t("Введите целое число токенов больше 0")
        : undefined;

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="card modal mp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 id={titleId} className="mp-modal-title">
            {name}
          </h2>
          <div className="mp-modal-sub">
            {model.provider} · {model.id}
          </div>
        </div>

        <div className="mp-grid">{priceFields(base, setBase, "b-")}</div>

        <div className="mp-tier">
          <div className="mp-long-head">
            <span>{t("Дороже на длинном контексте")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={tierOn}
              aria-label={t("Дороже на длинном контексте")}
              className={"set-switch" + (tierOn ? " on" : "")}
              onClick={toggleTier}
            >
              <span className="set-knob" />
            </button>
          </div>

          {tierOn && (
            <div className="mp-long-fields">
              <label className="mp-field mp-int-field">
                <span className="label">{t("После, токенов")}</span>
                <input
                  className="mp-int"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  value={threshold}
                  aria-invalid={tried && thresholdN === undefined ? true : undefined}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </label>
              <div className="mp-grid">{priceFields(tier, setTier, "t-")}</div>
            </div>
          )}
        </div>

        {formError && <p className="mp-modal-error" role="alert">{formError}</p>}
        {error && <div className="err-card">{error}</div>}

        <div className="mp-modal-actions">
          <div className="mp-side">
            {own && (
              <button type="button" className="btn" disabled={busy} onClick={useCatalog}>
                {t("Вернуть цену из каталога")}
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={makeFree}>
              {t("Бесплатно")}
            </button>
          </div>
          <div className="mp-main">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              {t("Отмена")}
            </button>
            <button type="button" className="btn primary" disabled={busy || (tried && !valid)} onClick={save}>
              {busy ? t("Сохраняем…") : t("Сохранить")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
