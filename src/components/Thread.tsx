import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Ask, Item, Status, Step } from "../lib/session";
import { describeApproval } from "../lib/session";
import { useSettings } from "../lib/settings";
import { DotSpinner, Emblem, Icon, Logo } from "./Glyphs";
import { Markdown } from "./Markdown";
import { t, tn } from "../lib/i18n";
import "./thread.css";

/** Separates the user task from the plan-first instruction (see src/lib/plan.ts). */
const PLAN_SEPARATOR = "\n\n—\n";

type Props = {
  items: Item[];
  status: Status;
  onAnswer: (ask: Ask, reply: { confirmed?: boolean; value?: string; cancelled?: boolean }, label: string) => void;
  onSuggest: (text: string) => void;
  /** Re-sends a user message as a new prompt. The retry action is hidden when absent. */
  onRetry?: (text: string) => void;
  /** Branch the conversation before the n-th user message and edit its text. */
  onEdit?: (userIndex: number, text: string) => void;
  /** Opens a project file in the viewer. */
  onOpenFile?: (path: string) => void;
  /** Indices (among user messages) that have a file snapshot from before they were sent. */
  restorable?: ReadonlySet<number>;
  /** Restore project files to how they were before the user message with this index. */
  onRestore?: (userIndex: number) => void;
  /** When true, retry is disabled: the agent is still working. */
  busy?: boolean;
};

/** Callbacks handed to every item. Their identity never changes, so memoized items don't re-render. */
type Callbacks = {
  onAnswer: Props["onAnswer"];
  onSuggest: (text: string) => void;
  onRetry: (text: string) => void;
  onEdit: (userIndex: number, text: string) => void;
  onRestore: (userIndex: number) => void;
};

/** Opens a project file; undefined when the app gave no handler (paths render as plain text). */
const OpenFileContext = createContext<((path: string) => void) | undefined>(undefined);

/** Newest messages rendered at first; earlier ones load in steps of WINDOW. */
const WINDOW = 80;

const SUGGESTIONS = ["Объясни, как устроен этот проект", "Найди и почини падающие тесты", "Что можно улучшить в README?"];

export function Thread(props: Props) {
  const { items, status, busy = false, restorable, onOpenFile, onRetry, onEdit, onRestore } = props;
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Always-current props behind stable callbacks: App may pass new functions every render.
  const cbs = useRef(props);
  cbs.current = props;
  const cb = useMemo<Callbacks>(
    () => ({
      onAnswer: (ask, reply, label) => cbs.current.onAnswer(ask, reply, label),
      onSuggest: (text) => cbs.current.onSuggest(text),
      onRetry: (text) => cbs.current.onRetry?.(text),
      onEdit: (userIndex, text) => cbs.current.onEdit?.(userIndex, text),
      onRestore: (userIndex) => cbs.current.onRestore?.(userIndex),
    }),
    [],
  );
  const openFile = useMemo(() => (path: string) => cbs.current.onOpenFile?.(path), []);

  // Render window: only the newest `size` items are mounted. The window resets when the
  // session changes (first item differs) or when the list shrinks by half (e.g. a branch).
  const sessionKey = items[0]?.key ?? "";
  const [win, setWin] = useState({ key: "", len: 0, size: WINDOW });
  const reset = win.key !== sessionKey || items.length < win.len / 2;
  const size = reset ? WINDOW : win.size;
  const total = items.length;
  const hidden = Math.max(0, total - size);
  useEffect(() => {
    if (reset) setWin({ key: sessionKey, len: total, size: WINDOW });
  }, [reset, sessionKey, total]);

  // Scroll compensation when earlier items are prepended: remember the height before the
  // window grows and shift scrollTop by the difference once the new rows are laid out.
  const anchorH = useRef<number | null>(null);
  const info = useRef({ total, size, key: sessionKey });
  info.current = { total, size, key: sessionKey };
  const loadMore = useCallback(() => {
    const el = ref.current;
    const cur = info.current;
    if (!el || anchorH.current !== null || cur.total <= cur.size) return;
    anchorH.current = el.scrollHeight;
    setWin({ key: cur.key, len: cur.total, size: cur.size + WINDOW });
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && anchorH.current !== null) el.scrollTop += el.scrollHeight - anchorH.current;
    anchorH.current = null;
  }, [size]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, status]);

  // Panels appearing under the thread (changes, queue, swarm strip) shrink it;
  // keep the newest message in view when we were following the bottom.
  const hasItems = items.length > 0;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [hasItems]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 200) loadMore();
  };

  if (items.length === 0) {
    return (
      <div className="scroll" ref={ref}>
        <div className="empty">
          <Emblem size={200} />
          <h1>{t("Чем займёмся?")}</h1>
          <p>{t("Опишите задачу своими словами. Агент работает в выбранной папке.")}</p>
          <div className="suggests">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggest" onClick={() => cb.onSuggest(t(s))}>{t(s)}</button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const live = status === "working" || status === "thinking" || status === "waiting";
  // Position of each user message among user messages — what the agent's branch list is indexed by.
  // Computed over the full list so windowed items still get the right index.
  const userPos = new Array<number>(total);
  let users = 0;
  for (let i = 0; i < total; i++) userPos[i] = items[i].kind === "user" ? users++ : -1;
  const canRetry = !!onRetry;
  const canEdit = !!onEdit;
  const hasOpenFile = !!onOpenFile;
  const rows = groupRows(items, hidden);
  // The agent took the turn but has nothing to show yet: an empty live turn holds the spinner.
  if (live && rows[rows.length - 1]?.kind !== "turn") rows.push({ kind: "turn", key: "live", items: [] });

  return (
    <OpenFileContext.Provider value={hasOpenFile ? openFile : undefined}>
      <div className="scroll th-scroll" ref={ref} onScroll={onScroll}>
        <div className="thread">
          {hidden > 0 && (
            <button type="button" className="th-act th-more" onClick={loadMore}>
              {t("Показать ранние сообщения ({count})", { count: hidden })}
            </button>
          )}
          {rows.map((r, j) =>
            r.kind === "turn" ? (
              <Turn key={r.key} items={r.items} live={live && j === rows.length - 1} status={status} onAnswer={cb.onAnswer} />
            ) : (
              <ItemView
                key={r.item.key}
                it={r.item}
                userIndex={userPos[r.index]}
                busy={userPos[r.index] >= 0 && busy}
                canRetry={canRetry}
                canEdit={canEdit}
                canRestore={userPos[r.index] >= 0 && !!onRestore && !!restorable?.has(userPos[r.index])}
                cb={cb}
              />
            ),
          )}
        </div>
      </div>
    </OpenFileContext.Provider>
  );
}

type Row = { kind: "item"; item: Item; index: number } | { kind: "turn"; key: string; items: Item[] };

/** Agent output between two user-side items (message, shell command, notice) forms one turn. */
const TURN_KINDS = new Set<Item["kind"]>(["assistant", "steps", "ask", "error"]);

function groupRows(items: Item[], from: number): Row[] {
  const rows: Row[] = [];
  for (let i = from; i < items.length; i++) {
    const it = items[i];
    const prev = rows[rows.length - 1];
    if (!TURN_KINDS.has(it.kind)) rows.push({ kind: "item", item: it, index: i });
    else if (prev?.kind === "turn") prev.items.push(it);
    else rows.push({ kind: "turn", key: it.key, items: [it] });
  }
  return rows;
}

type ItemProps = {
  it: Item;
  /** Position among user messages; -1 for other items. */
  userIndex: number;
  /** Disables the user message actions while the agent works. */
  busy: boolean;
  canRetry: boolean;
  canEdit: boolean;
  canRestore: boolean;
  cb: Callbacks;
};

/** One thread item. Memoized: an item re-renders only when its own object changes. */
const ItemView = memo(function ItemView({ it, userIndex, busy, canRetry, canEdit, canRestore, cb }: ItemProps) {
  switch (it.kind) {
    case "user": {
      // Plan-first prompts carry the app's instruction after a separator: show the task only.
      const cut = it.text.indexOf(PLAN_SEPARATOR);
      const shown = cut >= 0 ? it.text.slice(0, cut) : it.text;
      return (
        <div className="th-msg th-msg-user">
          <div className="msg-user">
            {cut >= 0 && <span className="th-plan-badge">{t("Сначала план")}</span>}
            {shown}
          </div>
          <MsgActions>
            <CopyButton text={shown} />
            {/* Retry, edit and restore can't run while the agent works: hidden until it's done. */}
            {canRetry && !busy && (
              <button type="button" className="th-act" aria-label={t("Повторить сообщение")} onClick={() => cb.onRetry(it.text)}>
                {t("Повторить")}
              </button>
            )}
            {canEdit && !busy && (
              <button
                type="button"
                className="th-act"
                title={t("Начать заново с этого сообщения")}
                aria-label={t("Изменить сообщение")}
                onClick={() => cb.onEdit(userIndex, it.text)}
              >
                {t("Изменить")}
              </button>
            )}
            {canRestore && !busy && (
              <button
                type="button"
                className="th-act"
                title={t("Вернуть файлы проекта к состоянию до этого сообщения")}
                onClick={() => cb.onRestore(userIndex)}
              >
                {t("Вернуть файлы")}
              </button>
            )}
          </MsgActions>
        </div>
      );
    }
    case "shell":
      return (
        <div className="th-shell">
          <div className="th-shell-head">
            <span className="th-shell-cmd">$ {it.command}</span>
            {it.running ? (
              <DotSpinner size={12} />
            ) : (
              <span className={`th-shell-code ${it.exitCode === 0 ? "" : "bad"}`}>
                {it.exitCode === 0 ? "OK" : t("код {code}", { code: it.exitCode ?? "—" })}
              </span>
            )}
          </div>
          {!it.running && <pre className="th-shell-out">{it.output?.trimEnd() || t("нет вывода")}</pre>}
        </div>
      );
    case "notice":
      return <div className="notice">{it.text}</div>;
    default:
      return null;
  }
});

type TimelineEntry =
  | { kind: "think"; key: string; text: string; waiting: boolean }
  | { kind: "say"; key: string; text: string; streaming: boolean }
  | { kind: "step"; key: string; step: Step; index: number }
  | { kind: "asked"; key: string; ask: Ask };

/** While the agent works, the timeline shows only its newest entries. */
const LIVE_TAIL = 6;

/**
 * One agent turn: thinking, steps and in-between remarks fold into one "work" block (open while
 * the agent works, a single line after); the final answer, open questions and errors sit below it.
 */
const Turn = memo(
  function Turn({ items, live, status, onAnswer }: { items: Item[]; live: boolean; status: Status; onAnswer: Props["onAnswer"] }) {
    const [manual, setManual] = useState<boolean | null>(null);

    // The final answer: the newest text, unless the agent went on working after it.
    let finalIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "ask" || it.kind === "error") continue;
      if (it.kind === "assistant" && it.text.trim()) finalIdx = i;
      break;
    }

    const entries: TimelineEntry[] = [];
    const openAsks: Ask[] = [];
    const errors: { key: string; text: string }[] = [];
    const steps: Step[] = [];
    items.forEach((it, i) => {
      if (it.kind === "assistant") {
        if (it.thinking.trim()) entries.push({ kind: "think", key: `${it.key}-t`, text: it.thinking, waiting: it.streaming && !it.text });
        if (it.text.trim() && i !== finalIdx) entries.push({ kind: "say", key: it.key, text: it.text, streaming: it.streaming });
      } else if (it.kind === "steps") {
        for (const st of it.steps) entries.push({ kind: "step", key: st.id, step: st, index: steps.push(st) - 1 });
      } else if (it.kind === "ask") {
        if (it.ask.state === "open") openAsks.push(it.ask);
        else entries.push({ kind: "asked", key: it.key, ask: it.ask });
      } else if (it.kind === "error") {
        errors.push({ key: it.key, text: it.text });
      }
    });
    const final = finalIdx >= 0 ? (items[finalIdx] as Extract<Item, { kind: "assistant" }>) : null;

    const open = manual ?? live;
    const shown = open && manual !== true && entries.length > LIVE_TAIL ? entries.slice(-LIVE_TAIL) : entries;
    const earlier = open ? entries.length - shown.length : 0;
    const showWork = live || entries.length > 0;

    return (
      <AgentRow>
        {showWork && (
          <div className="th-work">
            <button
              type="button"
              className={`steps-pill th-work-head ${live ? "live" : ""}`}
              aria-expanded={open}
              disabled={entries.length === 0}
              onClick={() => setManual(!open)}
            >
              {live ? <DotSpinner /> : <DoneMark failed={steps.some((x) => x.status === "err")} />}
              <span>{workSummary(live, status, steps)}</span>
              {entries.length > 0 && <Icon name={open ? "chevron-down" : "chevron-right"} size={11} />}
            </button>
            {open && entries.length > 0 && (
              <div className="th-tl">
                {earlier > 0 && (
                  <button type="button" className="th-act th-tl-more" onClick={() => setManual(true)}>
                    {t("Ещё раньше: {n}", { n: earlier })}
                  </button>
                )}
                {shown.map((e) => <TimelineRow key={e.key} e={e} />)}
              </div>
            )}
          </div>
        )}
        {final && (
          <div className="th-msg th-final">
            <Markdown text={final.text} />
            {final.streaming && <span className="cursor" />}
            {!final.streaming && (
              <MsgActions>
                <CopyButton text={final.text} />
              </MsgActions>
            )}
          </div>
        )}
        {openAsks.map((a) => <AskCard key={a.id} ask={a} onAnswer={onAnswer} />)}
        {errors.map((e) => (
          <div key={e.key} className="err-card"><span style={{ color: "var(--accent-ink)" }}>●</span>{e.text}</div>
        ))}
      </AgentRow>
    );
  },
  (a, b) =>
    a.live === b.live &&
    (!a.live || a.status === b.status) &&
    a.onAnswer === b.onAnswer &&
    a.items.length === b.items.length &&
    a.items.every((it, i) => it === b.items[i]),
);

function TimelineRow({ e }: { e: TimelineEntry }) {
  switch (e.kind) {
    case "think":
      return <Thinking text={e.text} waiting={e.waiting} />;
    case "say":
      return (
        <div className="th-say">
          <Markdown text={e.text} />
          {e.streaming && <span className="cursor" />}
        </div>
      );
    case "step":
      return <StepRow step={e.step} index={e.index} />;
    case "asked": {
      const tool = e.ask.method === "select" ? describeApproval(e.ask.title, e.ask.options) : null;
      const what = tool ? [t(tool.action).toLowerCase(), ...tool.details].join(" · ") : e.ask.title || e.ask.message || t("Вопрос агента");
      return (
        <div className="th-tl-asked">
          <span className="th-tl-asked-a">{e.ask.state === "cancelled" ? t("Запрос отменён") : e.ask.answer}</span>
          <span className="th-tl-asked-q">{what}</span>
        </div>
      );
    }
  }
}

function DoneMark({ failed }: { failed: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke={failed ? "var(--accent-ink)" : "var(--ink-3)"} strokeWidth="2" strokeDasharray="0 3.6" />
      {!failed && <path d="M4.6 7.2l1.7 1.7 3.2-3.6" stroke="var(--ink)" strokeWidth="1.5" />}
    </svg>
  );
}

/** "Работаю · 5 шагов" while live; "Работал 1:12 · 5 шагов · read, grep, edit" after. */
function workSummary(live: boolean, status: Status, steps: Step[]): string {
  const parts: string[] = [];
  if (live) {
    parts.push(status === "waiting" ? t("Ждёт вашего ответа") : status === "thinking" ? t("Думаю") : t("Работаю"));
  } else {
    const starts = steps.map((x) => x.startedAt).filter((x): x is number => x != null);
    const ends = steps.map((x) => x.endedAt).filter((x): x is number => x != null);
    const ms = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0;
    parts.push(ms >= 1000 ? t("Работал {time}", { time: clock(ms) }) : steps.length ? t("Готово") : t("Ход мысли"));
  }
  if (steps.length) parts.push(tn(steps.length, "шаг|шага|шагов"));
  if (!live && steps.length) parts.push([...new Set(steps.map((x) => x.name))].slice(0, 3).join(", "));
  const failed = steps.filter((x) => x.status === "err").length;
  if (failed) parts.push(t("ошибок: {n}", { n: failed }));
  return parts.join(" · ");
}

function clock(ms: number) {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function AgentRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={className ? `msg-agent ${className}` : "msg-agent"}>
      <div style={{ flexShrink: 0, marginTop: 2 }}><Logo size={24} /></div>
      <div className="msg-agent-body">{children}</div>
    </div>
  );
}

/** Row of small text actions under a message. Hidden until hover or focus inside the message. */
function MsgActions({ alwaysVisible = false, children }: { alwaysVisible?: boolean; children: React.ReactNode }) {
  return <div className={alwaysVisible ? "th-actions th-actions-always" : "th-actions"}>{children}</div>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // clipboard unavailable (permissions or insecure context)
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button type="button" className="th-act" onClick={copy} aria-label={copied ? t("Скопировано") : t("Копировать сообщение")}>
      {copied ? t("Скопировано") : t("Копировать")}
    </button>
  );
}

function StepRow({ step: s, index }: { step: Step; index: number }) {
  const [open, setOpen] = useState(false);
  const dur = s.startedAt != null && s.endedAt != null ? fmtDuration(s.endedAt - s.startedAt) : "";
  return (
    <div className="th-step-wrap">
      <button type="button" className="step th-step-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="mono" style={{ color: "var(--mute)", fontSize: 11 }}>{String(index + 1).padStart(2, "0")}</span>
        <span className="step-name">{s.name}</span>
        <span className="step-label" title={s.label}>{s.label}</span>
        {dur && <span className="th-dur">{dur}</span>}
        <span className={`step-state ${s.status}`}>{s.status === "run" ? "…" : s.status === "err" ? "ERR" : "OK"}</span>
        <span className="th-chev"><Icon name={open ? "chevron-down" : "chevron-right"} size={11} /></span>
      </button>
      {open && <StepDetail step={s} />}
    </div>
  );
}

function StepDetail({ step: s }: { step: Step }) {
  const running = s.status === "run";
  const outRef = useRef<HTMLPreElement>(null);

  // While a tool runs, keep the live output pinned to its last line.
  useEffect(() => {
    const el = outRef.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [s.output, running]);

  return (
    <div className="th-step-detail">
      <section className="th-sec">
        <div className="th-sec-title">{t("Аргументы")}</div>
        <ArgsView name={s.name} args={s.args} label={s.label} diff={s.diff} />
      </section>
      <section className="th-sec">
        <div className="th-sec-title">{t("Вывод")}{running && <DotSpinner size={11} />}</div>
        {s.output ? (
          <pre ref={outRef} className="th-code">{s.output}</pre>
        ) : (
          <div className="th-empty">{running ? t("ждём вывод…") : t("нет вывода")}</div>
        )}
      </section>
    </div>
  );
}

function ArgsView({ name, args, label, diff }: { name: string; args?: Record<string, unknown>; label?: string; diff?: string }) {
  const tool = name.toLowerCase();
  const a: Record<string, unknown> = args ?? {};

  // The edit tool reports a ready line diff ("-3|old" / "+3|new") in its result.
  if (diff) {
    const lines = diff.split("\n").flatMap((l): DiffLine[] => {
      const m = /^([+-])\d*\|?(.*)$/.exec(l);
      return m ? [{ kind: m[1] === "+" ? "add" : "del", text: m[2] }] : [];
    });
    // Hashline patches name the file in their first line: "[path#hash]".
    const path = str(a.path) ?? str(a.file_path) ?? /^\[([^\]#\n]+)#/.exec(str(a.input) ?? "")?.[1];
    return (
      <>
        {path ? <PathLink path={path} /> : label && <div className="th-path">{label}</div>}
        {lines.length > 0 && <DiffView lines={lines} />}
      </>
    );
  }

  if (tool === "bash" || tool === "shell") {
    const cmd = str(a.command) ?? str(a.cmd);
    if (cmd !== undefined) return <pre className="th-code">{`$ ${cmd}`}</pre>;
  }

  if (tool === "read" || tool === "write" || tool === "edit") {
    const path = str(a.path) ?? str(a.file_path);
    if (path !== undefined) {
      const lines = tool === "edit" ? diffOf(a) : null;
      return (
        <>
          <PathLink path={path} />
          {lines && lines.length > 0 && <DiffView lines={lines} />}
        </>
      );
    }
  }

  if (Object.keys(a).length === 0) return <div className="th-empty">{t("нет аргументов")}</div>;
  return <pre className="th-code">{jsonPreview(a)}</pre>;
}

type DiffLine = { kind: "add" | "del"; text: string };

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="th-diff">
      {lines.map((l, i) => (
        <div key={i} className={`th-diff-line ${l.kind}`}>
          <span className="th-gutter">{l.kind === "add" ? "+" : "−"}</span>
          <span>{l.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

/** Mini diff from edit args: old/new strings, or a unified-style diff/patch field. */
function diffOf(a: Record<string, unknown>): DiffLine[] | null {
  const oldS = str(a.old_string) ?? str(a.oldText);
  const newS = str(a.new_string) ?? str(a.newText);
  if (oldS !== undefined || newS !== undefined) {
    return [
      ...(oldS ? oldS.split("\n") : []).map((text): DiffLine => ({ kind: "del", text })),
      ...(newS ? newS.split("\n") : []).map((text): DiffLine => ({ kind: "add", text })),
    ];
  }
  const patch = str(a.diff) ?? str(a.patch);
  if (patch !== undefined) {
    const out: DiffLine[] = [];
    for (const l of patch.split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) out.push({ kind: "add", text: l.slice(1) });
      else if (l.startsWith("-") && !l.startsWith("---")) out.push({ kind: "del", text: l.slice(1) });
    }
    return out;
  }
  return null;
}

function PathLink({ path }: { path: string }) {
  const open = useContext(OpenFileContext);
  if (!open) return <div className="th-path">{path}</div>;
  return (
    <button type="button" className="th-path th-path-link" onClick={() => open(path)} title={t("Открыть файл")}>
      {path}
    </button>
  );
}

function jsonPreview(a: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(a, null, 2) ?? "";
  } catch {
    text = String(a);
  }
  return text.length > 1500 ? text.slice(0, 1500) + "\n…" : text;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return t("{n}с", { n: Math.max(s, 0.1).toFixed(1) });
  return t("{n}с", { n: Math.round(s) });
}

function Thinking({ text, waiting }: { text: string; waiting: boolean }) {
  const { thinkingExpanded } = useSettings();
  const [open, setOpen] = useState(thinkingExpanded);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Follow the reasoning while it streams, if the panel is open.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && waiting) el.scrollTop = el.scrollHeight;
  }, [text, waiting, open]);

  return (
    <div className="th-think">
      <button type="button" className="th-think-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {waiting ? <DotSpinner size={12} /> : (
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--mute)" strokeWidth="2" strokeLinecap="round" strokeDasharray="0 3.6" aria-hidden="true"><circle cx="7" cy="7" r="5.5" /></svg>
        )}
        <span>{t("Ход мысли")}</span>
        {waiting && <span className="th-think-wait">{t("думаю…")}</span>}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={11} />
      </button>
      {open && <div ref={bodyRef} className="th-think-body">{text}</div>}
    </div>
  );
}

function AskCard({ ask, onAnswer }: { ask: Ask; onAnswer: Props["onAnswer"] }) {
  const [value, setValue] = useState(ask.prefill ?? "");
  const done = ask.state !== "open";
  const isApproval = ask.method === "confirm";
  const tool = ask.method === "select" ? describeApproval(ask.title, ask.options) : null;

  if (tool) {
    return (
      <div className={`ask ${done ? "done" : ""}`}>
        <div className="ask-title">{t("Разрешить: {action}?", { action: t(tool.action).toLowerCase() })}</div>
        {tool.details.length > 0 && <pre className="ask-msg">{tool.details.join("\n")}</pre>}
        {done ? (
          <div className="ask-answer">{ask.state === "cancelled" ? t("Запрос отменён") : ask.answer}</div>
        ) : (
          <div className="ask-actions">
            <button className="btn" onClick={() => onAnswer(ask, { value: "Deny" }, t("Запрещено"))}>{t("Запретить")}</button>
            <button className="btn primary" onClick={() => onAnswer(ask, { value: "Approve" }, t("Разрешено"))}>{t("Разрешить")}</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`ask ${done ? "done" : ""}`}>
      <div className="ask-title">{ask.title || (isApproval ? t("Нужно ваше разрешение") : t("Агенту нужен ответ"))}</div>
      {ask.message && <pre className="ask-msg">{ask.message}</pre>}
      {done ? (
        <div className="ask-answer">{ask.state === "cancelled" ? t("Запрос отменён") : t("Ответ: {answer}", { answer: String(ask.answer) })}</div>
      ) : ask.method === "confirm" ? (
        <div className="ask-actions">
          <button className="btn" onClick={() => onAnswer(ask, { confirmed: false }, t("отклонено"))}>{t("Отклонить")}</button>
          <button className="btn primary" onClick={() => onAnswer(ask, { confirmed: true }, t("разрешено"))}>{t("Разрешить")}</button>
        </div>
      ) : ask.method === "select" ? (
        <div className="ask-actions">
          {(ask.options ?? []).map((o) => (
            <button key={o} className="btn" onClick={() => onAnswer(ask, { value: o }, o)}>{o}</button>
          ))}
          <button className="btn" style={{ color: "var(--ink-3)" }} onClick={() => onAnswer(ask, { cancelled: true }, t("отменено"))}>{t("Отмена")}</button>
        </div>
      ) : (
        <div className="ask-actions">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={ask.placeholder ?? t("Ответ")}
            aria-label={ask.title || t("Ответ агенту")}
            style={{ flex: 1, minWidth: 200, height: 38, padding: "0 12px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--line-2)" }}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && onAnswer(ask, { value }, value)}
          />
          <button className="btn primary" disabled={!value.trim()} onClick={() => onAnswer(ask, { value }, value)}>{t("Ответить")}</button>
          <button className="btn" onClick={() => onAnswer(ask, { cancelled: true }, t("отменено"))}>{t("Отмена")}</button>
        </div>
      )}
    </div>
  );
}

