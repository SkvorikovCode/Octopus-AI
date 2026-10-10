import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Icon } from "./Glyphs";
import { t } from "../lib/i18n";
import "./providers.css";

export type AvailableModel = { provider: string; id: string; name?: string };

type Props = {
  models: AvailableModel[];
  current?: AvailableModel;
  disabled: boolean;
  onSelect: (provider: string, id: string) => void;
  onAddProvider: () => void;
};

/** Show the search field only when the list is long enough to need it. */
const SEARCH_THRESHOLD = 8;

export function ModelPicker({ models, current, disabled, onSelect, onAddProvider }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  const showing = open && !disabled;

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  // Outside-click and Escape listeners exist only while the popover is open.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
        chipRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byProvider = new Map<string, AvailableModel[]>();
    for (const m of models) {
      if (q && !`${m.name ?? ""} ${m.id} ${m.provider}`.toLowerCase().includes(q)) continue;
      const list = byProvider.get(m.provider);
      if (list) list.push(m);
      else byProvider.set(m.provider, [m]);
    }
    return [...byProvider.entries()];
  }, [models, query]);

  const choose = (m: AvailableModel) => {
    onSelect(m.provider, m.id);
    close();
  };

  const chipLabel = current ? current.name || current.id : t("модель…");
  const searchable = models.length > SEARCH_THRESHOLD;

  return (
    <div className="mp-wrap" ref={wrapRef}>
      <button
        ref={chipRef}
        type="button"
        className="mp-chip"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={showing}
        onClick={() => (showing ? close() : setOpen(true))}
      >
        <span className="mp-chip-text">{chipLabel}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      {showing && (
        <div className="mp-pop">
          {searchable && (
            <input
              className="mp-search"
              type="search"
              placeholder={t("Поиск моделей")}
              aria-label={t("Поиск моделей")}
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
          )}

          {models.length === 0 ? (
            <div className="mp-empty">{t("Моделей нет — добавьте провайдера")}</div>
          ) : groups.length === 0 ? (
            <div className="mp-empty">{t("Ничего не найдено")}</div>
          ) : (
            <div className="mp-list" role="listbox" aria-label={t("Модели")}>
              {groups.map(([provider, list]) => (
                <div className="mp-group" key={provider} role="presentation">
                  <div className="label mp-group-head">{provider}</div>
                  {list.map((m) => {
                    const isCurrent = !!current && current.provider === m.provider && current.id === m.id;
                    const showId = !!m.name && m.name !== m.id;
                    return (
                      <button
                        key={`${m.provider}/${m.id}`}
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        className={`mp-row${isCurrent ? " is-current" : ""}`}
                        onClick={() => choose(m)}
                      >
                        {isCurrent && <span className="mp-dot" aria-hidden="true" />}
                        <span className="mp-row-text">
                          <span className="mp-row-name">{m.name || m.id}</span>
                          {showId && <span className="mp-row-id">{m.id}</span>}
                        </span>
                        {isCurrent && (
                          <span className="mp-check">
                            <Icon name="check" size={14} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          <div className="mp-foot">
            <button
              type="button"
              className="mp-add"
              onClick={() => {
                close();
                onAddProvider();
              }}
            >
              {t("+ Добавить провайдера")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
