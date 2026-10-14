import { useState } from "react";
import { relaunch, type Update } from "../lib/appShell";
import { t } from "../lib/i18n";
import "./update.css";

type Phase = { kind: "ready" } | { kind: "loading"; percent: number | null } | { kind: "installed" } | { kind: "error"; text: string };

/**
 * A new release in the sidebar: download and install on request, then restart when the user is
 * ready (restarting stops the agents, so it is never automatic).
 */
export function UpdateCard({ update, busy }: { update: Update; busy: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });

  const install = async () => {
    let total = 0;
    let got = 0;
    setPhase({ kind: "loading", percent: null });
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") {
          got += e.data.chunkLength;
          setPhase({ kind: "loading", percent: total ? Math.min(100, Math.round((got / total) * 100)) : null });
        }
      });
      setPhase({ kind: "installed" });
    } catch (e) {
      setPhase({ kind: "error", text: String(e) });
    }
  };

  return (
    <div className="upd-card" role="status">
      <div className="upd-head">
        <span className="dot on" />
        <span className="upd-title">{t("Версия {version}", { version: update.version })}</span>
      </div>
      {phase.kind === "ready" && (
        <button type="button" className="upd-btn" onClick={install}>{t("Установить")}</button>
      )}
      {phase.kind === "loading" && (
        <div className="upd-note">{phase.percent === null ? t("Загрузка…") : t("Загрузка {n}%", { n: phase.percent })}</div>
      )}
      {phase.kind === "installed" && (
        <>
          {busy && <div className="upd-note">{t("Перезапуск прервёт работу агента")}</div>}
          <button type="button" className="upd-btn" onClick={() => relaunch()}>{t("Перезапустить")}</button>
        </>
      )}
      {phase.kind === "error" && (
        <>
          <div className="upd-note upd-err" title={phase.text}>{t("Не удалось обновить")}</div>
          <button type="button" className="upd-btn" onClick={install}>{t("Ещё раз")}</button>
        </>
      )}
    </div>
  );
}
