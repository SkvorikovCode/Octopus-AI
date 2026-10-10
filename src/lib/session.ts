// Turns the omp event stream into what the chat and tiles render.

import type { Frame } from "./omp";
import { t } from "./i18n";

export type Status = "offline" | "starting" | "idle" | "thinking" | "working" | "waiting";

export type Step = {
  id: string;
  name: string;
  label: string;
  status: "run" | "ok" | "err";
  /** Raw tool arguments as omp sent them. */
  args?: Record<string, unknown>;
  /** Text output of the tool (streams in for bash), capped at OUTPUT_CAP chars. */
  output?: string;
  /** Line diff from the edit tool (`result.details.diff`, lines like "-3|old" / "+3|new"). */
  diff?: string;
  startedAt?: number;
  endedAt?: number;
};

const OUTPUT_CAP = 8000;

export type Ask = {
  id: string;
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  state: "open" | "answered" | "cancelled";
  answer?: string;
};

export type Item =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; thinking: string; streaming: boolean }
  | { kind: "steps"; key: string; steps: Step[] }
  | { kind: "ask"; key: string; ask: Ask }
  | { kind: "shell"; key: string; command: string; output?: string; exitCode?: number; running: boolean }
  | { kind: "error"; key: string; text: string }
  | { kind: "notice"; key: string; text: string };

export type TodoTask = { content: string; status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked" };
export type TodoPhase = { name: string; tasks: TodoTask[] };

export type LogLine = { dir: "in" | "out" | "err"; text: string; t: number };

export type SessionState = {
  status: Status;
  items: Item[];
  title?: string;
  sessionId?: string;
  /** Text of the latest user prompt — the swarm screen shows it as the goal. */
  goal?: string;
  model?: string;
  modelRef?: { provider: string; id: string; name?: string };
  /** omp's todo plan (phases of tasks), from get_state or the todo tool. */
  plan?: TodoPhase[];
  thinkingLevel?: string;
  /** Messages waiting for the agent: steering (mid-turn) and follow-ups. */
  queued: string[];
  /** Effort levels the current model supports (empty = no reasoning control). */
  thinkingLevels: string[];
  context?: { tokens: number; window: number; percent: number };
  stats?: { tokens: number; cost: number; tools: number };
  turnSteps: number;
  /** Current/last turn: from the user's prompt until the terminal agent_end. */
  turnStartedAt?: number;
  turnEndedAt?: number;
  log: LogLine[];
};

export type Action =
  | { type: "reset" }
  | { type: "status"; status: Status }
  | { type: "frame"; frame: Frame }
  | { type: "state"; data: any }
  | { type: "stats"; data: any }
  | { type: "answer"; id: string; answer: string }
  | { type: "load"; messages: any[]; title?: string }
  | { type: "shell_start"; key: string; command: string }
  | { type: "shell_end"; key: string; output?: string; exitCode?: number }
  | { type: "log"; line: Omit<LogLine, "t"> };

export const initialSession: SessionState = { status: "offline", items: [], turnSteps: 0, log: [], thinkingLevels: [], queued: [] };

let keySeq = 0;
const nextKey = (p: string) => `${p}${++keySeq}`;

// Frames that would flood the debug log without telling anything new.
const QUIET = new Set(["message_update", "tool_execution_update"]);

/** Tool steps since the last user message — the same count the chat shows. */
function stepsInTurn(items: Item[]): number {
  let n = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") break;
    if (it.kind === "steps") n += it.steps.length;
  }
  return n;
}

export function reduce(s: SessionState, a: Action): SessionState {
  const next = reduceInner(s, a);
  if (next === s || next.items === s.items) return next;
  const turnSteps = stepsInTurn(next.items);
  return turnSteps === next.turnSteps ? next : { ...next, turnSteps };
}

function reduceInner(s: SessionState, a: Action): SessionState {
  switch (a.type) {
    case "reset":
      return { ...initialSession, log: s.log };
    case "status":
      return { ...s, status: a.status };
    case "log":
      return { ...s, log: pushLog(s.log, a.line) };
    case "state": {
      const d = a.data ?? {};
      const cu = d.contextUsage;
      return {
        ...s,
        sessionId: d.sessionId ?? s.sessionId,
        plan: Array.isArray(d.todoPhases) ? d.todoPhases : s.plan,
        thinkingLevel: d.thinkingLevel ?? s.thinkingLevel,
        queued: d.queuedMessages
          ? [...(d.queuedMessages.steering ?? []), ...(d.queuedMessages.followUp ?? [])].map(queuedText).filter(Boolean)
          : s.queued,
        thinkingLevels: d.model
          ? (d.model.reasoning ? ["off", ...(d.model.thinking?.efforts ?? ["low", "medium", "high"])] : [])
          : s.thinkingLevels,
        model: d.model?.name ?? d.model?.id ?? s.model,
        modelRef: d.model?.id ? { provider: d.model.provider, id: d.model.id, name: d.model.name } : s.modelRef,
        context: cu ? { tokens: cu.tokens ?? 0, window: cu.contextWindow ?? 0, percent: cu.percent ?? 0 } : s.context,
      };
    }
    case "stats": {
      const d = a.data ?? {};
      return {
        ...s,
        stats: { tokens: d.tokens?.total ?? 0, cost: d.cost?.total ?? d.cost ?? 0, tools: d.toolCalls ?? d.toolCallCount ?? 0 },
      };
    }
    case "answer":
      return {
        ...s,
        status: s.status === "waiting" ? "working" : s.status,
        items: s.items.map((it) =>
          it.kind === "ask" && it.ask.id === a.id ? { ...it, ask: { ...it.ask, state: "answered", answer: a.answer } } : it,
        ),
      };
    case "shell_start":
      return { ...s, items: [...s.items, { kind: "shell", key: a.key, command: a.command, running: true }] };
    case "shell_end":
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === "shell" && it.key === a.key ? { ...it, running: false, output: a.output, exitCode: a.exitCode } : it,
        ),
      };
    case "load": {
      const items = messagesToItems(a.messages);
      const lastUser = [...items].reverse().find((it) => it.kind === "user");
      const turn = lastTurnTimes(a.messages);
      return {
        ...s,
        items,
        title: a.title ?? s.title,
        goal: lastUser?.kind === "user" ? lastUser.text : s.goal,
        turnStartedAt: turn.startedAt,
        turnEndedAt: turn.endedAt,
      };
    }
    case "frame": {
      const next = onFrame(s, a.frame);
      if (QUIET.has(a.frame.type)) return next;
      return { ...next, log: pushLog(next.log, { dir: "in", text: JSON.stringify(a.frame) }) };
    }
  }
}

function pushLog(log: LogLine[], line: Omit<LogLine, "t">): LogLine[] {
  const next = [...log, { ...line, t: Date.now() }];
  return next.length > 500 ? next.slice(-500) : next;
}

function onFrame(s: SessionState, f: Frame): SessionState {
  switch (f.type) {
    case "agent_start":
      // omp may start several agent runs per prompt; only open a turn if none is running.
      return s.turnStartedAt && !s.turnEndedAt
        ? { ...s, status: "working" }
        : { ...s, status: "working", turnStartedAt: Date.now(), turnEndedAt: undefined };

    case "agent_end":
      return f.isTerminal === false ? s : { ...s, status: "idle", turnEndedAt: Date.now() };

    case "message_start": {
      const m = f.message;
      if (m?.role === "user") {
        const text = textOf(m);
        const running = s.turnStartedAt && !s.turnEndedAt;
        return {
          ...s,
          goal: text,
          items: [...s.items, { kind: "user", key: nextKey("u"), text }],
          // A steering message joins the running turn; a new prompt starts one.
          ...(running ? {} : { turnStartedAt: Date.now(), turnEndedAt: undefined }),
        };
      }
      if (m?.role === "assistant")
        return { ...s, items: [...s.items, { kind: "assistant", key: nextKey("a"), text: "", thinking: "", streaming: true }] };
      return s;
    }

    case "message_update": {
      const e = f.assistantMessageEvent;
      if (!e || (e.type !== "text_delta" && e.type !== "thinking_delta")) return s;
      const items = updateLast(s.items, "assistant", (it) =>
        e.type === "text_delta" ? { ...it, text: it.text + e.delta } : { ...it, thinking: it.thinking + e.delta },
      );
      return { ...s, items, status: e.type === "thinking_delta" ? "thinking" : "working" };
    }

    case "message_end": {
      const m = f.message;
      if (m?.role !== "assistant") return s;
      let items = updateLast(s.items, "assistant", (it) => ({ ...it, text: it.text || textOf(m), streaming: false }));
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && !last.text.trim() && !last.thinking.trim()) items = items.slice(0, -1);
      if (m.stopReason === "error") items = [...items, { kind: "error", key: nextKey("e"), text: friendlyError(m) }];
      return { ...s, items };
    }

    case "tool_execution_start": {
      const step: Step = { id: f.toolCallId, name: f.toolName, label: stepLabel(f), status: "run", args: f.args, startedAt: Date.now() };
      const last = s.items[s.items.length - 1];
      const items: Item[] =
        last?.kind === "steps"
          ? [...s.items.slice(0, -1), { ...last, steps: [...last.steps, step] }]
          : [...s.items, { kind: "steps", key: nextKey("s"), steps: [step] }];
      return { ...s, items, status: "working" };
    }

    case "tool_execution_update":
      return patchStep(s, f.toolCallId, (st) => ({ ...st, output: resultText(f.partialResult) ?? st.output }));

    case "tool_execution_end": {
      const phases = f.result?.details?.phases;
      const next = Array.isArray(phases) && f.result?.details?.op !== "view" ? { ...s, plan: phases } : s;
      return patchStep(next, f.toolCallId, (st) => ({
        ...st,
        status: f.isError || f.result?.isError ? "err" : "ok",
        output: resultText(f.result) ?? st.output,
        diff: typeof f.result?.details?.diff === "string" ? f.result.details.diff : st.diff,
        label: st.label || (typeof f.result?.details?.path === "string" ? f.result.details.path : ""),
        endedAt: Date.now(),
      }));
    }

    case "extension_ui_request":
      return onUiRequest(s, f);

    case "notice":
      return f.message ? withNotice(s, f.message) : s;

    case "auto_compaction_start":
      return withNotice(s, t("Сжимаю контекст…"));

    case "auto_retry_start":
      return withNotice(
        s,
        t("Повтор {attempt}/{max}: {error}", { attempt: f.attempt, max: f.maxAttempts, error: f.errorMessage ?? t("ошибка провайдера") }),
      );

    case "session_info_update":
      return { ...s, title: f.title ?? s.title };

    default:
      return s;
  }
}

function onUiRequest(s: SessionState, f: Frame): SessionState {
  switch (f.method) {
    case "confirm":
    case "select":
    case "input":
    case "editor": {
      const ask: Ask = {
        id: f.id,
        method: f.method,
        title: f.title ?? "",
        message: f.message,
        options: f.options,
        placeholder: f.placeholder,
        prefill: f.prefill,
        state: "open",
      };
      return { ...s, status: "waiting", items: [...s.items, { kind: "ask", key: nextKey("q"), ask }] };
    }
    case "cancel":
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === "ask" && it.ask.id === f.targetId && it.ask.state === "open"
            ? { ...it, ask: { ...it.ask, state: "cancelled" } }
            : it,
        ),
      };
    case "notify":
      return f.message ? withNotice(s, f.message) : s;
    default:
      return s;
  }
}

function patchStep(s: SessionState, id: string, fn: (st: Step) => Step): SessionState {
  return {
    ...s,
    items: s.items.map((it) =>
      it.kind === "steps" && it.steps.some((st) => st.id === id)
        ? { ...it, steps: it.steps.map((st) => (st.id === id ? fn(st) : st)) }
        : it,
    ),
  };
}

/** Text blocks of a tool result (`{ content: [{ type: "text", text }] }`), capped. */
function resultText(r: any): string | undefined {
  if (!r) return undefined;
  const text = typeof r === "string"
    ? r
    : (r.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
  if (!text) return undefined;
  return text.length > OUTPUT_CAP ? text.slice(0, OUTPUT_CAP) + "\n…" : text;
}

function withNotice(s: SessionState, text: string): SessionState {
  return { ...s, items: [...s.items, { kind: "notice", key: nextKey("n"), text }] };
}

function updateLast<K extends Item["kind"]>(
  items: Item[],
  kind: K,
  fn: (it: Extract<Item, { kind: K }>) => Extract<Item, { kind: K }>,
): Item[] {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === kind) {
      const copy = items.slice();
      copy[i] = fn(items[i] as Extract<Item, { kind: K }>);
      return copy;
    }
  }
  return items;
}

/** Rebuilds the thread from a saved transcript (`get_messages`). */
function messagesToItems(messages: any[]): Item[] {
  const items: Item[] = [];
  const steps = new Map<string, Step>();
  const pushStep = (step: Step) => {
    steps.set(step.id, step);
    const last = items[items.length - 1];
    if (last?.kind === "steps") last.steps.push(step);
    else items.push({ kind: "steps", key: nextKey("s"), steps: [step] });
  };

  for (const m of messages ?? []) {
    if (m?.role === "user") {
      const text = textOf(m);
      if (text.trim()) items.push({ kind: "user", key: nextKey("u"), text });
    } else if (m?.role === "assistant") {
      // Same shape as the live path: message_start opens an assistant item (text + thinking)
      // and the message's tool steps follow it.
      const text = textOf(m);
      const thinking = thinkingOf(m);
      if (text.trim() || thinking.trim()) items.push({ kind: "assistant", key: nextKey("a"), text, thinking, streaming: false });
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type !== "toolCall") continue;
        pushStep({ id: c.id ?? nextKey("t"), name: c.name ?? "tool", label: stepLabel({ type: "", args: c.arguments }), status: "ok", args: c.arguments });
      }
      if (m.stopReason === "error") items.push({ kind: "error", key: nextKey("e"), text: friendlyError(m) });
    } else if (m?.role === "bashExecution") {
      items.push({ kind: "shell", key: nextKey("b"), command: m.command ?? "", output: m.output, exitCode: m.exitCode, running: false });
    } else if (m?.role === "toolResult") {
      const step = steps.get(m.toolCallId);
      if (step) {
        if (m.isError) step.status = "err";
        step.output = resultText(m);
      }
    }
  }
  return items;
}

/** Start of the last turn (last user message) and its end (last assistant/toolResult after it). */
function lastTurnTimes(messages: any[]): { startedAt?: number; endedAt?: number } {
  const list = messages ?? [];
  let userIdx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user") {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return {};
  const startedAt = timeOf(list[userIdx]);
  if (startedAt === undefined) return {};
  let endedAt: number | undefined;
  for (let i = list.length - 1; i > userIdx && endedAt === undefined; i--) {
    const role = list[i]?.role;
    if (role === "assistant" || role === "toolResult") endedAt = timeOf(list[i]);
  }
  // A prompt with no reply yet has no end; use the start so the tile does not tick forever.
  return { startedAt, endedAt: endedAt ?? startedAt };
}

/** Message timestamp: epoch ms (number or digit string) or an ISO string. */
function timeOf(m: any): number | undefined {
  const ts = m?.timestamp;
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : undefined;
  if (typeof ts === "string" && ts.trim()) {
    const n = /^\d+$/.test(ts.trim()) ? Number(ts) : Date.parse(ts);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/** Thinking blocks of an assistant message, joined the way thinking_delta chunks are. */
function thinkingOf(m: any): string {
  return (Array.isArray(m?.content) ? m.content : [])
    .filter((c: any) => c?.type === "thinking" && typeof c.thinking === "string")
    .map((c: any) => c.thinking)
    .join("");
}

function queuedText(q: any): string {
  if (typeof q === "string") return q;
  if (typeof q?.text === "string") return q.text;
  return textOf(q);
}

function textOf(m: any): string {
  if (typeof m?.content === "string") return m.content;
  return (m?.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("");
}

function stepLabel(f: Frame): string {
  if (typeof f.intent === "string" && f.intent) return f.intent;
  const a = f.args ?? {};
  // The hashline edit tool puts "[path#hash]" on the first line of its input.
  const hashPath = typeof a.input === "string" ? /^\[([^\]#]+)#/.exec(a.input)?.[1] : undefined;
  const pick = a.path ?? a.file_path ?? hashPath ?? a.command ?? a.pattern ?? a.query ?? a.url ?? a.description;
  if (typeof pick === "string") return pick.length > 90 ? pick.slice(0, 90) + "…" : pick;
  return "";
}

function friendlyError(m: any): string {
  const raw: string = m.errorMessage ?? t("неизвестная ошибка");
  const inner = raw.match(/"message":"([^"]+)"/)?.[1];
  if (m.errorStatus === 401) return t("Ключ API не подошёл (401{detail}). Проверьте ключ в настройках.", { detail: inner ? ` · ${inner}` : "" });
  if (m.errorStatus === 429) return t("Провайдер ограничил запросы (429). Подождите немного и повторите.");
  return inner ? `${m.errorStatus ?? t("Ошибка")} · ${inner}` : raw;
}

// ---------- tool approvals ----------

const TOOL_ACTION: Record<string, string> = {
  edit: "Изменить файл",
  write: "Записать файл",
  bash: "Выполнить команду",
  shell: "Выполнить команду",
  eval: "Выполнить код",
  browser: "Открыть браузер",
  task: "Запустить подагента",
  delete: "Удалить файл",
  read: "Прочитать файл",
};

const FIELD_LABEL: Record<string, string> = { file: "Файл", command: "Команда", path: "Путь", url: "Адрес", cwd: "Папка" };

/**
 * The agent asks for tool approval as a `select` titled "Allow tool: edit\nFile: x"
 * with options ["Approve", "Deny"]. Returns a description, or null for
 * any other kind of question. `action` is a Russian key for t() (the component
 * translates it); `details` lines are already translated.
 */
export function describeApproval(title: string | undefined, options: string[] | undefined) {
  if (!options?.includes("Approve") || !options.includes("Deny")) return null;
  const lines = (title ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const tool = /^Allow tool:\s*(.+)$/i.exec(lines[0] ?? "")?.[1]?.trim();
  if (!tool) return null;
  const details = lines.slice(1).map((l) => {
    const m = /^([A-Za-z ]+):\s*(.*)$/.exec(l);
    const label = m ? FIELD_LABEL[m[1].trim().toLowerCase()] : undefined;
    return label ? `${t(label)}: ${m![2]}` : l;
  });
  const action = TOOL_ACTION[tool.toLowerCase()] ?? t("Инструмент «{tool}»", { tool });
  return { tool, action, details };
}
