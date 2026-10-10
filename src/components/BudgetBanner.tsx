import type { ReactElement } from "react";
import type { BudgetState } from "../lib/budget";
import { formatCost } from "../lib/stats";
import { t } from "../lib/i18n";
import "./budget.css";

const DOTS = 10;

/** Ten dots, filled in proportion to the share of the limit that is spent. */
function BudgetDots({ ratio }: { ratio: number }): ReactElement {
  const filled = Math.min(DOTS, Math.max(0, Math.floor(ratio * DOTS + 1e-9)));
  return (
    <span className="budget-dots" aria-hidden="true">
      {Array.from({ length: DOTS }, (_, i) => (
        <span key={i} className={i < filled ? "budget-dot on" : "budget-dot"} />
      ))}
    </span>
  );
}

export function BudgetBanner({
  state,
  onContinue,
  onOpenSettings,
}: {
  state: BudgetState;
  onContinue: () => void;
  onOpenSettings: () => void;
}): ReactElement | null {
  if (state.level === "ok") return null;

  const scopeLabel = state.scope === "session" ? t("на сессию") : t("за день");
  const spent = formatCost(state.spent);
  const limit = formatCost(state.limit);
  const ratio = state.limit > 0 ? state.spent / state.limit : 0;

  if (state.level === "warn") {
    return (
      <div className="budget-dock budget-warn" role="status">
        <div className="budget-bar">
          <BudgetDots ratio={ratio} />
          <span className="budget-pct">{Math.floor(ratio * 100)}%</span>
          <span className="budget-text">
            {t("Потрачено {spent} из {limit} {scopeLabel}", { spent, limit, scopeLabel })}
          </span>
          <button type="button" className="budget-link" onClick={onOpenSettings}>
            {t("Изменить лимит")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="budget-dock budget-over" role="alert">
      <div className="budget-bar">
        <span className="budget-text">
          {t("Лимит {scopeLabel} исчерпан: {spent} из {limit}", { scopeLabel, spent, limit })}
        </span>
        <div className="budget-actions">
          <button type="button" className="btn primary budget-btn" onClick={onContinue}>
            {t("Продолжить всё равно")}
          </button>
          <button type="button" className="btn budget-btn" onClick={onOpenSettings}>
            {t("Изменить лимит")}
          </button>
        </div>
      </div>
    </div>
  );
}
