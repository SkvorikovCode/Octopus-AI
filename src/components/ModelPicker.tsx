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
    <div className="mpk-wrap" ref={wrapRef}>
      <button
        ref={chipRef}
        type="button"
        className="mpk-chip"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={showing}
        onClick={() => (showing ? close() : setOpen(true))}
      >
        <span className="mpk-chip-text">{chipLabel}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      {showing && (
        <div className="mpk-pop">
          {searchable && (
            <input
              className="mpk-search"
              type="search"
              placeholder={t("Поиск моделей")}
              aria-label={t("Поиск моделей")}
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
          )}

          {models.length === 0 ? (
            <div className="mpk-empty">{t("Моделей нет — добавьте провайдера")}</div>
          ) : groups.length === 0 ? (
            <div className="mpk-empty">{t("Ничего не найдено")}</div>
          ) : (
            <div className="mpk-list" role="listbox" aria-label={t("Модели")}>
              {groups.map(([provider, list]) => (
                <div className="mpk-group" key={provider} role="presentation">
                  <div className="label mpk-group-head">{provider}</div>
                  {list.map((m) => {
                    const isCurrent = !!current && current.provider === m.provider && current.id === m.id;
                    const showId = !!m.name && m.name !== m.id;
                    return (
                      <button
                        key={`${m.provider}/${m.id}`}
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        className={`mpk-row${isCurrent ? " is-current" : ""}`}
                        onClick={() => choose(m)}
                      >
                        {isCurrent && <span className="mpk-dot" aria-hidden="true" />}
                        <span className="mpk-row-text">
                          <span className="mpk-row-name">{m.name || m.id}</span>
                          {showId && <span className="mpk-row-id">{m.id}</span>}
                        </span>
                        {isCurrent && (
                          <span className="mpk-check">
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

          <div className="mpk-foot">
            <button
              type="button"
              className="mpk-add"
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
