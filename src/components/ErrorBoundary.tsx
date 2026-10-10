import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../lib/i18n";

/** Keeps a render crash from leaving a blank window: shows what broke and a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void; inline?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[octopus] render crash", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`crash ${this.props.inline ? "crash-inline" : ""}`} role="alert">
        <div className="crash-card card">
          <div className="label">{t("СБОЙ ИНТЕРФЕЙСА")}</div>
          <p>{t("Этот экран не смог отрисоваться. Сессия и агент не пострадали.")}</p>
          <pre className="crash-detail mono">{String(error.message || error)}</pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={this.reset}>{t("Вернуться")}</button>
            <button type="button" className="btn" onClick={() => location.reload()}>{t("Перезагрузить окно")}</button>
          </div>
        </div>
      </div>
    );
  }
}
