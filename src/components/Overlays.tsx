import { useEffect, useRef } from "react";
import type { LogLine } from "../lib/session";
import { Icon } from "./Glyphs";
import { t, tn } from "../lib/i18n";

export function DebugDrawer({ log, stderr, onClose }: { log: LogLine[]; stderr: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log, stderr]);

  return (
    <aside className="card drawer" aria-label={t("Журнал движка")}>
      <div className="drawer-head">
        <span className="label" style={{ flex: 1 }}>{t("Журнал движка")} · {tn(log.length, "событие|события|событий")}</span>
        <button className="icon-btn" onClick={onClose} aria-label={t("Закрыть")}><Icon name="close" /></button>
      </div>
      <div className="drawer-body" ref={ref}>
        {log.map((l, i) => (
          <div key={i} className={`log-line ${l.dir}`}>{l.dir === "out" ? "→ " : l.dir === "err" ? "! " : "← "}{l.text}</div>
        ))}
        {stderr.length > 0 && <div className="log-line err">stderr: {stderr.slice(-20).join("\n")}</div>}
      </div>
    </aside>
  );
}
