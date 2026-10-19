import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "../omp";
import { contextFilesOf, describeApproval, initialSession, reduce } from "../session";
import type { Action, Item, SessionState, Step } from "../session";

// Identity translation with {var} interpolation, so assertions compare the Russian source strings.
vi.mock("../i18n", () => ({
  t: (ru: string, vars?: Record<string, string | number>) =>
    vars ? ru.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m)) : ru,
}));

const OPTS = ["Approve", "Deny"];

const fr = (frame: Frame): Action => ({ type: "frame", frame });
const run = (s: SessionState, ...actions: Action[]): SessionState =>
  actions.reduce<SessionState>((st, a) => reduce(st, a), s);

function itemsOf<K extends Item["kind"]>(s: SessionState, kind: K): Extract<Item, { kind: K }>[] {
  return s.items.filter((it): it is Extract<Item, { kind: K }> => it.kind === kind);
}
const stepsOf = (s: SessionState): Step[] => s.items.flatMap((it) => (it.kind === "steps" ? it.steps : []));

const textBlock = (text: string) => ({ type: "text", text });
const userMsg = (text: string): Action =>
  fr({ type: "message_start", message: { role: "user", content: [textBlock(text)] } });
const assistantStart = (): Action => fr({ type: "message_start", message: { role: "assistant", content: [] } });
const textDelta = (delta: string): Action =>
  fr({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
const thinkingDelta = (delta: string): Action =>
  fr({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
const toolStart = (id: string, toolName: string, args: Record<string, unknown> = {}): Action =>
  fr({ type: "tool_execution_start", toolCallId: id, toolName, args });

/** Freezes a value and everything under it. Reducer code that mutates its input will throw in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((v) => deepFreeze(v));
  }
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("initialSession", () => {
  it("starts offline with an empty thread and no turn", () => {
    expect(initialSession).toMatchObject({ status: "offline", items: [], turnSteps: 0, log: [], queued: [], thinkingLevels: [] });
    expect(initialSession.turnStartedAt).toBeUndefined();
    expect(initialSession.turnEndedAt).toBeUndefined();
  });
});

describe("status and reset", () => {
  it("walks through the status lifecycle of a turn", () => {
    let s = run(initialSession, { type: "status", status: "starting" });
    expect(s.status).toBe("starting");

    s = run(s, fr({ type: "agent_start" }));
    expect(s.status).toBe("working");

    s = run(s, assistantStart(), thinkingDelta("..."));
    expect(s.status).toBe("thinking");

    s = run(s, textDelta("Hi"));
    expect(s.status).toBe("working");

    s = run(s, fr({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Continue?" }));
    expect(s.status).toBe("waiting");

    s = run(s, { type: "answer", id: "q1", answer: "yes" });
    expect(s.status).toBe("working");

    s = run(s, fr({ type: "agent_end", isTerminal: true }));
    expect(s.status).toBe("idle");
  });

  it("reset clears the thread and session fields but keeps the debug log", () => {
    let s = run(
      initialSession,
      fr({ type: "session_info_update", title: "Old chat" }),
      { type: "state", data: { sessionId: "sess-1", todoPhases: [{ name: "P", tasks: [] }] } },
      userMsg("hi"),
      { type: "log", line: { dir: "out", text: "cmd" } },
    );
    const logBefore = s.log;
    expect(logBefore.length).toBeGreaterThan(0);

    s = run(s, { type: "reset" });
    expect(s).toMatchObject({ status: "offline", items: [], queued: [], turnSteps: 0 });
    expect(s.title).toBeUndefined();
    expect(s.sessionId).toBeUndefined();
    expect(s.plan).toBeUndefined();
    expect(s.log).toEqual(logBefore);
  });
});

describe("turn lifecycle", () => {
  it("agent_start opens a turn once; a terminal agent_end closes it", () => {
    let s = run(initialSession, fr({ type: "agent_start" }));
    expect(s).toMatchObject({ status: "working", turnStartedAt: 1_000 });
    expect(s.turnEndedAt).toBeUndefined();

    // omp may start another run for the same prompt: the turn keeps its start time.
    vi.setSystemTime(2_000);
    s = run(s, fr({ type: "agent_start" }));
    expect(s.turnStartedAt).toBe(1_000);

    // A non-terminal end does not finish the turn.
    s = run(s, fr({ type: "agent_end", isTerminal: false }));
    expect(s.status).toBe("working");
    expect(s.turnEndedAt).toBeUndefined();

    vi.setSystemTime(3_000);
    s = run(s, fr({ type: "agent_end", isTerminal: true }));
    expect(s).toMatchObject({ status: "idle", turnStartedAt: 1_000, turnEndedAt: 3_000 });
  });

  it("a new prompt after a finished turn starts a new turn; a steering message joins the running one", () => {
    vi.setSystemTime(1_000);
    let s = run(initialSession, fr({ type: "agent_start" }), fr({ type: "agent_end" }));

    vi.setSystemTime(5_000);
    s = run(s, userMsg("first"));
    expect(s.turnStartedAt).toBe(5_000);
    expect(s.turnEndedAt).toBeUndefined();
    expect(s.goal).toBe("first");

    vi.setSystemTime(6_000);
    s = run(s, userMsg("steer"));
    expect(s.turnStartedAt).toBe(5_000);
    expect(s.goal).toBe("steer");
    expect(itemsOf(s, "user").map((it) => it.text)).toEqual(["first", "steer"]);
  });
});

describe("assistant streaming", () => {
  it("streams thinking, then text, into one assistant item and closes it on message_end", () => {
    let s = run(
      initialSession,
      userMsg("Why?"),
      assistantStart(),
      thinkingDelta("Let me "),
      thinkingDelta("check."),
      textDelta("Because "),
      textDelta("X."),
    );
    expect(itemsOf(s, "assistant")).toEqual([
      { kind: "assistant", key: expect.any(String), text: "Because X.", thinking: "Let me check.", streaming: true },
    ]);
    expect(s.status).toBe("working");

    s = run(s, fr({ type: "message_end", message: { role: "assistant", content: [textBlock("Because X.")] } }));
    expect(itemsOf(s, "assistant")[0]).toMatchObject({ text: "Because X.", streaming: false });
    expect(s.items).toHaveLength(2);
  });

  it("message_end keeps streamed text, falls back to the final message, and removes an empty placeholder", () => {
    const end = (content: unknown[]) => fr({ type: "message_end", message: { role: "assistant", content } });

    const streamed = run(initialSession, assistantStart(), textDelta("streamed"), end([textBlock("final")]));
    expect(itemsOf(streamed, "assistant")[0]).toMatchObject({ text: "streamed", streaming: false });

    const unstreamed = run(initialSession, assistantStart(), end([textBlock("final only")]));
    expect(itemsOf(unstreamed, "assistant")[0].text).toBe("final only");

    const empty = run(initialSession, assistantStart(), end([]));
    expect(empty.items).toEqual([]);
  });

  it("keeps a thinking-only assistant message", () => {
    const s = run(
      initialSession,
      assistantStart(),
      thinkingDelta("hmm"),
      fr({ type: "message_end", message: { role: "assistant", content: [] } }),
    );
    expect(itemsOf(s, "assistant")).toEqual([
      { kind: "assistant", key: expect.any(String), text: "", thinking: "hmm", streaming: false },
    ]);
  });

  it("ignores assistant events it does not render and returns the same state object", () => {
    const s = run(initialSession, assistantStart());
    const next = reduce(s, fr({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{" } }));
    expect(next).toBe(s);
  });
});

describe("tool steps and full turn", () => {
  it("runs a full turn: prompt, text, tool call with diff, reply, turn end", () => {
    vi.setSystemTime(1_000);
    let s = run(initialSession, fr({ type: "agent_start" }), userMsg("Fix the session"));

    vi.setSystemTime(1_100);
    s = run(s, assistantStart(), textDelta("Looking."), fr({ type: "message_end", message: { role: "assistant", content: [textBlock("Looking.")] } }));

    vi.setSystemTime(1_200);
    s = run(
      s,
      fr({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "edit",
        args: { input: "[src/auth/session.ts#A1B2]\nPUT 12.=12:\n+const user = session?.user ?? null;" },
      }),
      fr({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [textBlock("applying")] } }),
    );

    vi.setSystemTime(1_500);
    s = run(
      s,
      fr({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "edit",
        result: {
          content: [textBlock("[src/auth/session.ts#C3D4]\n12:const user = session?.user ?? null;")],
          details: {
            diff: "-12|const user = session.user;\n+12|const user = session?.user ?? null;",
            path: "src/auth/session.ts",
          },
        },
      }),
    );

    s = run(s, assistantStart(), textDelta("Fixed."), fr({ type: "message_end", message: { role: "assistant", content: [textBlock("Fixed.")] } }));

    vi.setSystemTime(2_000);
    s = run(s, fr({ type: "agent_end", isTerminal: true }));

    expect(s).toMatchObject({ status: "idle", goal: "Fix the session", turnStartedAt: 1_000, turnEndedAt: 2_000, turnSteps: 1 });
    expect(s.items.map((it) => it.kind)).toEqual(["user", "assistant", "steps", "assistant"]);
    expect(s.items[1]).toMatchObject({ text: "Looking.", streaming: false });
    expect(s.items[3]).toMatchObject({ text: "Fixed.", streaming: false });
    expect(s.plan).toBeUndefined();

    expect(stepsOf(s)).toEqual([
      {
        id: "t1",
        name: "edit",
        label: "src/auth/session.ts",
        status: "ok",
        args: { input: "[src/auth/session.ts#A1B2]\nPUT 12.=12:\n+const user = session?.user ?? null;" },
        output: "[src/auth/session.ts#C3D4]\n12:const user = session?.user ?? null;",
        diff: "-12|const user = session.user;\n+12|const user = session?.user ?? null;",
        startedAt: 1_200,
        endedAt: 1_500,
      },
    ]);
  });

  it("consecutive tool calls share one steps group; text in between starts a new group; turnSteps resets on a prompt", () => {
    let s = run(
      initialSession,
      userMsg("go"),
      toolStart("a", "read", { path: "a.ts" }),
      toolStart("b", "grep", { pattern: "x" }),
      assistantStart(),
      fr({ type: "message_end", message: { role: "assistant", content: [textBlock("ok")] } }),
      toolStart("c", "bash", { command: "ls" }),
    );
    expect(s.items.map((it) => it.kind)).toEqual(["user", "steps", "assistant", "steps"]);
    expect(itemsOf(s, "steps").map((g) => g.steps.map((st) => st.id))).toEqual([["a", "b"], ["c"]]);
    expect(s.turnSteps).toBe(3);

    s = run(s, userMsg("again"));
    expect(s.turnSteps).toBe(0);
  });

  it("marks a step err when either the frame or the result reports an error", () => {
    const s = run(
      initialSession,
      toolStart("x", "bash", { command: "npm test" }),
      fr({ type: "tool_execution_end", toolCallId: "x", toolName: "bash", isError: true, result: { content: [textBlock("1 failing")] } }),
      toolStart("y", "bash", { command: "npx tsc" }),
      fr({
        type: "tool_execution_end",
        toolCallId: "y",
        toolName: "bash",
        result: { isError: true, content: [textBlock("boom")] },
      }),
    );
    expect(stepsOf(s).map((st) => [st.id, st.status, st.output])).toEqual([
      ["x", "err", "1 failing"],
      ["y", "err", "boom"],
    ]);
  });

  it("fills an empty step label from details.path when the call ends", () => {
    const s = run(
      initialSession,
      toolStart("w", "write", {}),
      fr({
        type: "tool_execution_end",
        toolCallId: "w",
        toolName: "write",
        result: { content: [], details: { path: "src/b.ts" } },
      }),
    );
    expect(stepsOf(s)[0]).toMatchObject({ label: "src/b.ts", status: "ok" });
  });

  it("picks the step label from intent, then path, hashline input, command, pattern", () => {
    const labelOf = (args: Record<string, unknown>, intent?: string) =>
      stepsOf(run(initialSession, fr({ type: "tool_execution_start", toolCallId: "l", toolName: "x", args, intent })))[0].label;

    expect(labelOf({ path: "a.ts", command: "ls" }, "Reading the session")).toBe("Reading the session");
    expect(labelOf({ path: "a.ts", command: "ls" })).toBe("a.ts");
    expect(labelOf({ file_path: "b.ts" })).toBe("b.ts");
    expect(labelOf({ input: "[c/d.ts#1F]\nPUT 3.=3:\n+x" })).toBe("c/d.ts");
    expect(labelOf({ command: "ls -la" })).toBe("ls -la");
    expect(labelOf({ pattern: "needle" })).toBe("needle");
    expect(labelOf({})).toBe("");
    expect(labelOf({ command: "x".repeat(100) })).toBe("x".repeat(90) + "…");
  });

  it("joins text blocks of a result, ignores non-text blocks, and caps long output", () => {
    const s = run(
      initialSession,
      toolStart("o", "bash", { command: "cat" }),
      fr({
        type: "tool_execution_end",
        toolCallId: "o",
        toolName: "bash",
        result: { content: [textBlock("one"), { type: "image", data: "AAAA" }, textBlock("two")] },
      }),
    );
    expect(stepsOf(s)[0].output).toBe("one\ntwo");

    const big = run(
      initialSession,
      toolStart("o", "bash", { command: "cat" }),
      fr({ type: "tool_execution_update", toolCallId: "o", partialResult: { content: [textBlock("x".repeat(9_000))] } }),
    );
    const out = stepsOf(big)[0].output!;
    expect(out).toHaveLength(8_002);
    expect(out.endsWith("\n…")).toBe(true);
  });

  it("takes the plan from tool results unless the tool was a view", () => {
    const phases = [{ name: "Оплата", tasks: [{ content: "Тесты", status: "pending" }] }];
    let s = run(
      initialSession,
      toolStart("p", "todo"),
      fr({ type: "tool_execution_end", toolCallId: "p", toolName: "todo", result: { details: { phases, op: "update" } } }),
    );
    expect(s.plan).toEqual(phases);

    const other = [{ name: "Other", tasks: [] }];
    s = run(
      s,
      toolStart("v", "todo"),
      fr({ type: "tool_execution_end", toolCallId: "v", toolName: "todo", result: { details: { phases: other, op: "view" } } }),
    );
    expect(s.plan).toEqual(phases);
  });
});

describe("errors and notices", () => {
  const assistantError = (extra: Record<string, unknown>) =>
    run(
      initialSession,
      assistantStart(),
      fr({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", ...extra } }),
    );

  it("turns a 401 into a friendly API key message with the provider detail", () => {
    const withDetail = assistantError({
      errorStatus: 401,
      errorMessage: '{"error":{"message":"invalid x-api-key"}}',
    });
    // The empty assistant placeholder is dropped and the error is appended.
    expect(withDetail.items).toEqual([
      { kind: "error", key: expect.any(String), text: "Ключ API не подошёл (401 · invalid x-api-key). Проверьте ключ в настройках." },
    ]);

    const noDetail = assistantError({ errorStatus: 401, errorMessage: "plain" });
    expect(itemsOf(noDetail, "error")[0].text).toBe("Ключ API не подошёл (401). Проверьте ключ в настройках.");
  });

  it("describes 429, other statuses, plain messages, and a missing message", () => {
    expect(itemsOf(assistantError({ errorStatus: 429, errorMessage: "slow down" }), "error")[0].text).toBe(
      "Провайдер ограничил запросы (429). Подождите немного и повторите.",
    );
    expect(itemsOf(assistantError({ errorStatus: 500, errorMessage: '{"message":"overloaded"}' }), "error")[0].text).toBe(
      "500 · overloaded",
    );
    expect(itemsOf(assistantError({ errorMessage: "network down" }), "error")[0].text).toBe("network down");
    expect(itemsOf(assistantError({}), "error")[0].text).toBe("неизвестная ошибка");
  });

  it("an error after streamed text keeps the assistant item and appends the error after it", () => {
    const s = run(
      initialSession,
      assistantStart(),
      textDelta("Part"),
      fr({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "net" } }),
    );
    expect(s.items.map((it) => it.kind)).toEqual(["assistant", "error"]);
    expect(itemsOf(s, "assistant")[0]).toMatchObject({ text: "Part", streaming: false });
    expect(itemsOf(s, "error")[0].text).toBe("net");
  });

  it("adds notices from notice and notify frames and ignores empty ones", () => {
    const s = run(
      initialSession,
      fr({ type: "notice", message: "Model switched" }),
      fr({ type: "extension_ui_request", method: "notify", message: "Saved" }),
      fr({ type: "notice", message: "" }),
      fr({ type: "extension_ui_request", method: "notify" }),
    );
    expect(itemsOf(s, "notice").map((n) => n.text)).toEqual(["Model switched", "Saved"]);
  });

  it("reports compaction and provider retries as notices", () => {
    const s = run(
      initialSession,
      fr({ type: "auto_compaction_start" }),
      fr({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "overloaded" }),
      fr({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 }),
    );
    expect(itemsOf(s, "notice").map((n) => n.text)).toEqual([
      "Сжимаю контекст…",
      "Повтор 2/3: overloaded",
      "Повтор 1/3: ошибка провайдера",
    ]);
  });

  it("session_info_update sets the title and keeps the old one when omitted", () => {
    let s = run(initialSession, fr({ type: "session_info_update", title: "Вход через Google" }));
    expect(s.title).toBe("Вход через Google");
    s = run(s, fr({ type: "session_info_update" }));
    expect(s.title).toBe("Вход через Google");
  });
});

describe("state, stats and queue", () => {
  it("state frames fill session id, model, thinking levels and context", () => {
    const s = run(initialSession, {
      type: "state",
      data: {
        sessionId: "sess-1",
        model: { provider: "anthropic", id: "claude-x", name: "Claude X", reasoning: true, thinking: { efforts: ["low", "high"] } },
        thinkingLevel: "low",
        contextUsage: { tokens: 1_000, contextWindow: 200_000, percent: 0.5 },
      },
    });
    expect(s).toMatchObject({
      sessionId: "sess-1",
      model: "Claude X",
      modelRef: { provider: "anthropic", id: "claude-x", name: "Claude X" },
      thinkingLevel: "low",
      thinkingLevels: ["off", "low", "high"],
      context: { tokens: 1_000, window: 200_000, percent: 0.5 },
    });
  });

  it("reasoning levels default to low/medium/high, non-reasoning models have none, name falls back to id", () => {
    let s = run(initialSession, { type: "state", data: { model: { provider: "p", id: "m-1", reasoning: true } } });
    expect(s.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
    expect(s.model).toBe("m-1");

    s = run(s, { type: "state", data: { model: { provider: "p", id: "plain" } } });
    expect(s.thinkingLevels).toEqual([]);
    expect(s.model).toBe("plain");

    // A state frame without a model keeps what was known.
    s = run(s, { type: "state", data: {} });
    expect(s).toMatchObject({ thinkingLevels: [], model: "plain" });
  });

  it("queue merges steering and follow-up messages as text; an empty queue clears it, a missing one keeps it", () => {
    let s = run(initialSession, {
      type: "state",
      data: {
        queuedMessages: {
          steering: ["stop, use vitest"],
          followUp: [{ text: "then commit" }, { content: [textBlock("and push")] }, {}],
        },
      },
    });
    expect(s.queued).toEqual(["stop, use vitest", "then commit", "and push"]);

    s = run(s, { type: "state", data: {} });
    expect(s.queued).toEqual(["stop, use vitest", "then commit", "and push"]);

    s = run(s, { type: "state", data: { queuedMessages: { steering: [], followUp: [] } } });
    expect(s.queued).toEqual([]);
  });

  it("stats accepts both the nested and the flat shapes", () => {
    let s = run(initialSession, { type: "stats", data: { tokens: { total: 1_234 }, cost: { total: 0.02 }, toolCalls: 3 } });
    expect(s.stats).toEqual({ tokens: 1_234, cost: 0.02, tools: 3 });

    s = run(s, { type: "stats", data: { tokens: { total: 5 }, cost: 0.5, toolCallCount: 2 } });
    expect(s.stats).toEqual({ tokens: 5, cost: 0.5, tools: 2 });
  });
});

describe("asks (approvals and questions)", () => {
  it("an extension select request opens an ask and waits; the ask is a tool approval", () => {
    const title = "Allow tool: bash\nCommand: ls";
    const s = run(
      initialSession,
      fr({ type: "extension_ui_request", id: "ask-1", method: "select", title, options: OPTS }),
    );
    expect(s.status).toBe("waiting");
    const asks = itemsOf(s, "ask");
    expect(asks).toHaveLength(1);
    expect(asks[0].ask).toEqual({ id: "ask-1", method: "select", title, options: OPTS, state: "open" });
    expect(describeApproval(asks[0].ask.title, asks[0].ask.options)).toEqual({
      tool: "bash",
      action: "Выполнить команду",
      details: ["Команда: ls"],
    });
  });

  it("answering marks the ask answered and resumes the turn; other statuses are left alone", () => {
    let s = run(initialSession, fr({ type: "extension_ui_request", id: "ask-1", method: "select", title: "Pick", options: OPTS }));
    s = run(s, { type: "answer", id: "ask-1", answer: "Approve" });
    expect(s.status).toBe("working");
    expect(itemsOf(s, "ask")[0].ask).toMatchObject({ state: "answered", answer: "Approve" });

    const thinking = run(initialSession, { type: "status", status: "thinking" }, { type: "answer", id: "nope", answer: "x" });
    expect(thinking.status).toBe("thinking");
  });

  it("cancel only affects the open ask with the matching id", () => {
    const s = run(
      initialSession,
      fr({ type: "extension_ui_request", id: "ask-1", method: "confirm", title: "Continue?" }),
      fr({ type: "extension_ui_request", id: "ask-2", method: "select", title: "Pick", options: OPTS }),
      { type: "answer", id: "ask-2", answer: "Approve" },
      fr({ type: "extension_ui_request", method: "cancel", targetId: "ask-1" }),
      fr({ type: "extension_ui_request", method: "cancel", targetId: "ask-2" }),
    );
    const byId = Object.fromEntries(itemsOf(s, "ask").map((it) => [it.ask.id, it.ask.state]));
    expect(byId).toEqual({ "ask-1": "cancelled", "ask-2": "answered" });
  });

  it("ignores unknown extension methods; a confirm without a title gets an empty one", () => {
    let s = run(initialSession, fr({ type: "extension_ui_request", id: "c", method: "setStatus", message: "x" }));
    expect(s.items).toEqual([]);
    expect(s.status).toBe("offline");

    s = run(s, fr({ type: "extension_ui_request", id: "c2", method: "confirm" }));
    expect(itemsOf(s, "ask")[0].ask.title).toBe("");
    expect(s.status).toBe("waiting");
  });
});

describe("shell items", () => {
  it("shell_start and shell_end track a running command; an unknown key changes nothing", () => {
    let s = run(initialSession, { type: "shell_start", key: "sh1", command: "ls" });
    expect(itemsOf(s, "shell")).toEqual([{ kind: "shell", key: "sh1", command: "ls", running: true }]);

    s = run(s, { type: "shell_end", key: "sh1", output: "a\nb", exitCode: 0 });
    expect(itemsOf(s, "shell")[0]).toMatchObject({ running: false, output: "a\nb", exitCode: 0 });

    const before = s;
    s = run(s, { type: "shell_end", key: "nope", output: "x" });
    expect(s.items).toEqual(before.items);
  });
});

describe("load (saved transcript)", () => {
  it("rebuilds the thread from user, assistant, tool, bash and error messages", () => {
    const s = run(initialSession, {
      type: "load",
      title: "Старый чат",
      messages: [
        { role: "user", content: "Почини вход" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Сначала посмотрю." },
            textBlock("Смотрю файл."),
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/auth.ts" } },
          ],
        },
        { role: "toolResult", toolCallId: "c1", content: [textBlock("export const x = 1;")] },
        { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }] },
        { role: "toolResult", toolCallId: "c2", isError: true, content: [textBlock("1 failed")] },
        { role: "bashExecution", command: "git status", output: "clean", exitCode: 0 },
        { role: "assistant", content: [], stopReason: "error", errorStatus: 429 },
      ],
    });

    expect(s.title).toBe("Старый чат");
    expect(s.goal).toBe("Почини вход");
    expect(s.items.map((it) => it.kind)).toEqual(["user", "assistant", "steps", "shell", "error"]);
    expect(itemsOf(s, "assistant")[0]).toMatchObject({ text: "Смотрю файл.", thinking: "Сначала посмотрю.", streaming: false });
    expect(stepsOf(s)).toEqual([
      { id: "c1", name: "read", label: "src/auth.ts", status: "ok", args: { path: "src/auth.ts" }, output: "export const x = 1;" },
      { id: "c2", name: "bash", label: "npm test", status: "err", args: { command: "npm test" }, output: "1 failed" },
    ]);
    expect(itemsOf(s, "shell")[0]).toMatchObject({ command: "git status", output: "clean", exitCode: 0, running: false });
    expect(itemsOf(s, "error")[0].text).toBe("Провайдер ограничил запросы (429). Подождите немного и повторите.");
    expect(s.turnSteps).toBe(2);
  });

  it("skips blank user messages, reads turn times from timestamps of any supported form", () => {
    const s = run(initialSession, {
      type: "load",
      messages: [
        { role: "user", content: "   " },
        { role: "user", content: "Первый", timestamp: "1700000000000" },
        { role: "assistant", content: [textBlock("Ответ")], timestamp: 1_700_000_010_000 },
        { role: "toolResult", toolCallId: "none", content: [], timestamp: "2023-11-14T22:13:40.000Z" },
      ],
    });
    expect(s.items.map((it) => it.kind)).toEqual(["user", "assistant"]);
    expect(s.goal).toBe("Первый");
    expect(s.turnStartedAt).toBe(1_700_000_000_000);
    expect(s.turnEndedAt).toBe(1_700_000_020_000);
  });

  it("a prompt without a reply ends where it starts, so the tile does not tick forever", () => {
    const s = run(initialSession, {
      type: "load",
      messages: [{ role: "user", content: "Ping", timestamp: "2023-11-14T22:13:20.000Z" }],
    });
    expect(s.turnStartedAt).toBe(1_700_000_000_000);
    expect(s.turnEndedAt).toBe(1_700_000_000_000);
  });
});

describe("debug log", () => {
  it("logs every frame except the streaming deltas", () => {
    const notice = { type: "notice", message: "hi" };
    const s = run(
      initialSession,
      fr(notice),
      fr({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }),
      fr({ type: "tool_execution_update", toolCallId: "none", partialResult: "y" }),
    );
    expect(s.log).toHaveLength(1);
    expect(s.log[0]).toMatchObject({ dir: "in" });
    expect(JSON.parse(s.log[0].text)).toEqual(notice);
  });

  it("release builds keep no log", () => {
    vi.stubEnv("DEV", false);
    try {
      const s = run(initialSession, fr({ type: "notice", message: "hi" }), { type: "log", line: { dir: "out", text: "cmd" } });
      expect(s.log).toEqual([]);
      expect(s.items).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the log action appends lines and keeps only the newest 500", () => {
    let s = initialSession;
    for (let i = 0; i < 501; i++) s = run(s, { type: "log", line: { dir: "out", text: `l${i}` } });
    expect(s.log).toHaveLength(500);
    expect(s.log[0].text).toBe("l1");
    expect(s.log[499].text).toBe("l500");
  });
});

describe("describeApproval", () => {
  it("describes an edit approval with the file", () => {
    expect(describeApproval("Allow tool: edit\nFile: src/a.ts", OPTS)).toEqual({
      tool: "edit",
      action: "Изменить файл",
      details: ["Файл: src/a.ts"],
    });
  });

  it("describes bash and shell approvals with the command, keeping colons inside it", () => {
    expect(describeApproval("Allow tool: bash\nCommand: echo a:b", OPTS)).toEqual({
      tool: "bash",
      action: "Выполнить команду",
      details: ["Команда: echo a:b"],
    });
    expect(describeApproval("Allow tool: shell\nCommand: ls", OPTS)?.action).toBe("Выполнить команду");
  });

  it("maps path, url and cwd fields and keeps unknown lines as they are", () => {
    const r = describeApproval("Allow tool: delete\nPath: old/\nURL: https://x.io\nCWD: /repo\nReason: cleanup\nstay careful", OPTS);
    expect(r?.action).toBe("Удалить файл");
    expect(r?.details).toEqual(["Путь: old/", "Адрес: https://x.io", "Папка: /repo", "Reason: cleanup", "stay careful"]);
  });

  it("matches tool names case-insensitively and labels unknown tools generically", () => {
    expect(describeApproval("Allow tool: EDIT\nFile: a", OPTS)?.action).toBe("Изменить файл");
    expect(describeApproval("Allow tool: WebFetch\nUrl: https://a", OPTS)).toEqual({
      tool: "WebFetch",
      action: "Инструмент «WebFetch»",
      details: ["Адрес: https://a"],
    });
  });

  it("trims whitespace and skips blank lines", () => {
    expect(describeApproval("\n  Allow tool:   edit  \n\n   File:   src/b.ts  \n", OPTS)).toEqual({
      tool: "edit",
      action: "Изменить файл",
      details: ["Файл: src/b.ts"],
    });
  });

  it("returns null unless the options include both Approve and Deny", () => {
    expect(describeApproval("Allow tool: edit\nFile: a", undefined)).toBeNull();
    expect(describeApproval("Allow tool: edit\nFile: a", ["Approve"])).toBeNull();
    expect(describeApproval("Allow tool: edit\nFile: a", ["Yes", "No"])).toBeNull();
    expect(describeApproval("Allow tool: edit\nFile: a", ["Approve", "Deny", "Always"])).not.toBeNull();
  });

  it("returns null for titles that are not a tool approval", () => {
    expect(describeApproval("Delete the database?", OPTS)).toBeNull();
    expect(describeApproval("Header\nAllow tool: edit", OPTS)).toBeNull();
    expect(describeApproval("Allow tool:\nFile: a", OPTS)).toBeNull();
    expect(describeApproval(undefined, OPTS)).toBeNull();
  });

  it("does not treat inherited Object.prototype keys as known tools or fields", () => {
    expect(describeApproval("Allow tool: constructor\nConstructor: x", OPTS)).toEqual({
      tool: "constructor",
      action: "Инструмент «constructor»",
      details: ["Constructor: x"],
    });
  });
});

describe("immutability", () => {
  it("reduce never mutates a frozen previous state or frozen actions", () => {
    const start = deepFreeze(JSON.parse(JSON.stringify(initialSession)) as SessionState);
    const script: Action[] = deepFreeze([
      { type: "status", status: "starting" },
      fr({ type: "agent_start" }),
      userMsg("Go"),
      assistantStart(),
      textDelta("Hi"),
      fr({ type: "message_end", message: { role: "assistant", content: [textBlock("Hi")] } }),
      toolStart("t", "bash", { command: "ls" }),
      fr({ type: "tool_execution_update", toolCallId: "t", partialResult: { content: [textBlock("partial")] } }),
      fr({
        type: "tool_execution_end",
        toolCallId: "t",
        toolName: "bash",
        result: { content: [textBlock("done")], details: { phases: [{ name: "P", tasks: [] }], op: "run" } },
      }),
      { type: "shell_start", key: "b", command: "pwd" },
      { type: "shell_end", key: "b", output: "/", exitCode: 0 },
      { type: "log", line: { dir: "out", text: "x" } },
      { type: "state", data: { queuedMessages: { steering: ["s"] }, model: { id: "m", reasoning: true } } },
      { type: "stats", data: { tokens: { total: 1 } } },
      fr({ type: "extension_ui_request", id: "q", method: "confirm", title: "ok?" }),
      { type: "answer", id: "q", answer: "yes" },
      {
        type: "load",
        messages: [
          { role: "user", content: "again", timestamp: 1 },
          { role: "assistant", content: [{ type: "toolCall", id: "z", name: "read", arguments: { path: "p" } }] },
          { role: "toolResult", toolCallId: "z", content: [textBlock("r")] },
        ],
      },
      fr({ type: "agent_end", isTerminal: true }),
    ]);

    let s = start;
    expect(() => {
      for (const a of script) s = deepFreeze(reduce(s, a));
    }).not.toThrow();
    // The final load replaces the thread: one user prompt and the tool step from its transcript.
    expect(s.status).toBe("idle");
    expect(s.items.map((it) => it.kind)).toEqual(["user", "steps"]);
    expect(s.goal).toBe("again");
  });
});

describe("contextFilesOf", () => {
  const prompt = [
    "You are a coding agent.\n<file path=\"/not/context.md\">x</file>",
    "<project-context>\n<repo-rules>\n<file path=\"/home/u/.agents/AGENTS.md\">\nA\n</file>\n<file path=\"/p/AGENTS.md\">\nB\n</file>\n</repo-rules>\n</project-context>",
  ];

  it("reads file paths from the project-context block only", () => {
    expect(contextFilesOf(prompt)).toEqual(["/home/u/.agents/AGENTS.md", "/p/AGENTS.md"]);
  });

  it("accepts a plain string and returns [] without a context block", () => {
    expect(contextFilesOf(prompt.join("\n"))).toEqual(["/home/u/.agents/AGENTS.md", "/p/AGENTS.md"]);
    expect(contextFilesOf("no context here")).toEqual([]);
    expect(contextFilesOf(undefined)).toEqual([]);
  });

  it("is stored on state and kept when get_state has no prompt", () => {
    const s1 = reduce(initialSession, { type: "state", data: { systemPrompt: prompt } });
    expect(s1.contextFiles).toEqual(["/home/u/.agents/AGENTS.md", "/p/AGENTS.md"]);
    const s2 = reduce(s1, { type: "state", data: {} });
    expect(s2.contextFiles).toBe(s1.contextFiles);
  });
});
