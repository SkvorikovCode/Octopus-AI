import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { DotSpinner, Icon } from "./Glyphs";
import { t } from "../lib/i18n";
import "./controls.css";

type Props = {
  title: string;
  load: () => Promise<{ messages: any[] }>;
  onClose: () => void;
};

/** Loose view of an omp AgentMessage. Only the fields the drawer reads are typed. */
type Msg = { role?: string; content?: unknown; toolName?: string; isError?: boolean };
type Part = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

const POLL_MS = 3000;
/** Within this many pixels of the bottom, new messages keep the view pinned to the bottom. */
const STICK_PX = 40;
const SUMMARY_MAX = 120;

function partsOf(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((p): p is Part => typeof p === "object" && p !== null);
}

function textOf(content: unknown): string {
  return partsOf(content)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n");
}

function clip(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat;
}

/** One-line hint for a tool call: path, command or pattern if present, otherwise the JSON. */
function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return clip(args);
  if (typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const key of ["path", "command", "pattern"]) {
      const v = a[key];
      if (typeof v === "string" && v) return clip(v);
    }
  }
  try {
    return clip(JSON.stringify(args) ?? "");
  } catch {
    return "";
  }
}

function ToolCall({ name, args }: { name: string; args: unknown }): ReactElement {
  const summary = summarizeArgs(args);
  return (
    <div className="trn-tool">
      <span className="trn-arrow" aria-hidden="true">
        →
      </span>
      <span className="trn-tool-name">{name}</span>
      {summary && <span className="trn-tool-args">{summary}</span>}
    </div>
  );
}

function Message({
  msg,
  index,
  expanded,
  onToggleThink,
}: {
  msg: Msg;
  index: number;
  expanded: Set<string>;
  onToggleThink: (key: string) => void;
}): ReactElement | null {
  const role = msg.role ?? "";

  if (role === "user") {
    return (
      <div className="trn-task">
        <div className="label">{t("ЗАДАЧА")}</div>
        <div className="trn-task-body">{textOf(msg.content)}</div>
      </div>
    );
  }

  if (role === "assistant") {
    return (
      <div className="trn-assistant">
        {partsOf(msg.content).map((p, j) => {
          const key = `${index}:${j}`;
          if (p.type === "text") {
            return p.text?.trim() ? (
              <div key={key} className="trn-text">
                {p.text}
              </div>
            ) : null;
          }
          if (p.type === "thinking") {
            const open = expanded.has(key);
            return (
              <div key={key} className="trn-think">
                <button type="button" className="trn-think-toggle" aria-expanded={open} onClick={() => onToggleThink(key)}>
                  <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
                  <span>{t("ход мысли")}</span>
                </button>
                {open && <div className="trn-think-body">{p.thinking ?? ""}</div>}
              </div>
            );
          }
          if (p.type === "toolCall") {
            return <ToolCall key={key} name={p.name ?? "?"} args={p.arguments} />;
          }
          return null;
        })}
      </div>
    );
  }

  if (role === "toolResult") {
    const out = textOf(msg.content);
    return (
      <div className="trn-result-wrap">
        {msg.toolName && <div className="trn-result-name">← {msg.toolName}</div>}
        <pre className={msg.isError ? "trn-result is-error" : "trn-result"}>{out || t("(пустой результат)")}</pre>
      </div>
    );
  }

  const text = textOf(msg.content);
  if (!text) return null;
  return (
    <div className="trn-other">
      <div className="label">{role}</div>
      <div className="trn-text">{text}</div>
    </div>
  );
}

export function SwarmTranscript({ title, load, onClose }: Props): ReactElement {
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const loadRef = useRef(load);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastSigRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const aliveRef = useRef(false);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const refresh = useCallback(async () => {
    // Skip if a request is already running, so slow responses do not pile up.
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const res = await loadRef.current();
      if (!aliveRef.current) return;
      const next = res.messages ?? [];
      // Compare serialized content so an unchanged transcript does not re-render or re-scroll.
      const sig = JSON.stringify(next);
      if (sig !== lastSigRef.current) {
        lastSigRef.current = sig;
        setMessages(next);
      }
      setError(null);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, [refresh]);

  // Runs before paint, so a pinned view jumps to the new bottom without flashing.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  const toggleThink = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <aside className="card trn" aria-label={title}>
      <header className="trn-head">
        <h2 className="trn-title" title={title}>
          {title}
        </h2>
        <button type="button" className="icon-btn" aria-label={t("Обновить")} title={t("Обновить")} onClick={() => void refresh()}>
          <Icon name="refresh" size={16} />
        </button>
        <button type="button" className="icon-btn" aria-label={t("Закрыть")} title={t("Закрыть")} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="trn-body" ref={bodyRef} onScroll={onScroll}>
        {error && <div className="err-card">{t("Не удалось загрузить транскрипт: {error}", { error })}</div>}

        {messages === null && !error && (
          <div className="trn-state">
            <DotSpinner size={14} />
            <span>{t("Загрузка…")}</span>
          </div>
        )}

        {messages !== null && messages.length === 0 && <div className="trn-empty">{t("Сообщений пока нет")}</div>}

        {messages?.map((msg, i) => (
          <Message key={i} msg={msg} index={i} expanded={expanded} onToggleThink={toggleThink} />
        ))}
      </div>
    </aside>
  );
}
