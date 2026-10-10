// Scripted stand-in for omp, used when the UI runs outside Tauri (plain
// browser preview). Emits frames in the real RPC shapes so every screen can be
// seen without an engine or API keys.

import type { Frame } from "./omp";
import type { SessionMeta } from "./sessions";

type Handlers = {
  onFrame: (frame: Frame) => void;
  onStderr: (line: string) => void;
  onExit: (code: number | null) => void;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DEMO_PROJECT = "/Users/demo/my-app";

export const DEMO_SESSIONS: SessionMeta[] = [
  { path: "/demo/1.jsonl", id: "demo-1", title: "Починить вход через Google", cwd: DEMO_PROJECT, updatedAt: Date.now() - 2 * 3600e3, preview: "После обновления кнопка входа ничего не делает" },
  { path: "/demo/2.jsonl", id: "demo-2", title: "Почему падает сборка", cwd: DEMO_PROJECT, updatedAt: Date.now() - 26 * 3600e3, preview: "CI падает на шаге build" },
  { path: "/demo/3.jsonl", id: "demo-3", title: "Тёмная тема для лендинга", cwd: DEMO_PROJECT, updatedAt: Date.now() - 6 * 86400e3 },
];

const AGENTS = [
  { agent: "explore", task: "Найти все места, где читается сессия" },
  { agent: "frontend", task: "Страница тарифов и кнопка оплаты" },
  { agent: "payments", task: "Подключить Stripe и вебхук подписки" },
  { agent: "tester", task: "Прогнать тесты оплаты" },
];

let demoSeq = 0;

export class DemoClient {
  private pendingAsk?: (confirmed: boolean) => void;
  private running = false;
  private tokens = 0;

  /** Each demo agent has its own session, like parallel real agents. */
  private sessionId = `demo-live-${++demoSeq}`;

  constructor(private h: Handlers) {}

  async attach() {}
  detach() {}

  async start(_cwd: string) {
    await wait(300);
    this.emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
  }

  async stop() {}

  async request<T = any>(command: Record<string, unknown>): Promise<T> {
    switch (command.type) {
      case "get_state":
        return {
          sessionId: this.sessionId,
          model: { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5 (демо)", reasoning: true, thinking: { efforts: ["low", "medium", "high", "xhigh", "max"] } },
          thinkingLevel: "medium",
          systemPrompt: ["Demo agent.", `<project-context>\n<file path="${DEMO_PROJECT}/.claude/CLAUDE.md">\n…\n</file>\n</project-context>`],
          todoPhases: this.tokens > 0 ? [{ name: "Оплата", tasks: [
            { content: "Разобраться в структуре проекта", status: "completed" },
            { content: "Страница тарифов", status: this.tokens > 60000 ? "completed" : "in_progress" },
            { content: "Stripe и вебхук", status: this.tokens > 90000 ? "completed" : "pending" },
            { content: "Тесты оплаты", status: "pending" },
          ] }] : [],
          contextUsage: { tokens: 18000 + this.tokens, contextWindow: 200000, percent: ((18000 + this.tokens) / 200000) * 100 },
        } as T;
      case "get_session_stats":
        return { tokens: { total: 18000 + this.tokens }, cost: (18000 + this.tokens) * 0.00001, toolCalls: Math.floor(this.tokens / 4000) } as T;
      case "get_available_models":
        return { models: [
          { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5 (демо)" },
          { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
          { provider: "wikivibe", id: "gpt-6-luna", name: "6 Luna" },
        ] } as T;
      case "get_available_commands":
        return { commands: [
          { name: "review", description: "Код-ревью текущих изменений" },
          { name: "commit", description: "Сделать коммит с понятным сообщением" },
          { name: "plan", description: "Составить план без изменений в коде" },
          { name: "compact", description: "Сжать контекст сессии" },
        ] } as T;
      case "get_branch_messages":
        return { messages: [{ entryId: "demo-entry", text: "Сделай страницу оплаты" }] } as T;
      case "branch":
        this.running = false;
        return { text: "Сделай страницу оплаты", cancelled: false } as T;
      case "bash":
        await wait(400);
        return { exitCode: 0, output: `$ ${command.command}\nsrc/  package.json  README.md  vite.config.ts\n`, cancelled: false } as T;
      case "set_thinking_level":
        return undefined as T;
      case "set_model":
        return undefined as T;
      case "get_subagents":
        return { subagents: [] } as T;
      case "get_messages":
        return { messages: [] } as T;
      case "prompt":
        if (!this.running) this.script(String(command.message ?? ""));
        return { agentInvoked: true } as T;
      case "abort":
        this.running = false;
        this.emit({ type: "agent_end", messages: [], isTerminal: true });
        return undefined as T;
      default:
        return undefined as T;
    }
  }

  async send(frame: Record<string, unknown>) {
    if (frame.type === "extension_ui_response" && this.pendingAsk) {
      this.pendingAsk(frame.confirmed === true || frame.value === "Approve");
      this.pendingAsk = undefined;
    }
  }

  private emit(frame: Frame) {
    this.h.onFrame(frame);
  }

  private async say(text: string) {
    this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    for (const word of text.split(/(?<= )/)) {
      if (!this.running) return;
      this.emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: word } });
      await wait(35);
    }
    this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    this.tokens += text.length * 3;
  }

  private async tool(id: string, toolName: string, args: Record<string, unknown>, ms = 450, result: Record<string, unknown> = { content: [] }) {
    this.emit({ type: "tool_execution_start", toolCallId: id, toolName, args });
    await wait(ms);
    this.emit({ type: "tool_execution_end", toolCallId: id, toolName, result });
    this.tokens += 1500;
  }

  private progress(i: number, status: string, extra: Record<string, unknown> = {}) {
    const a = AGENTS[i];
    this.emit({
      type: "subagent_progress",
      payload: {
        index: i, agent: a.agent, agentSource: "builtin", task: a.task,
        progress: { index: i, id: `sa-${i}`, agent: a.agent, task: a.task, status, recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, cost: 0, durationMs: 0, ...extra },
      },
    });
  }

  private async script(message: string) {
    this.running = true;
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: message }] } });
    this.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: message }] } });
    await wait(400);

    this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    for (const t of ["Сначала ", "разберусь, ", "как ", "устроен ", "проект."]) {
      this.emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: t } });
      await wait(120);
    }
    this.emit({ type: "message_end", message: { role: "assistant", content: [] } });

    await this.say("Посмотрю структуру проекта и найду, где это реализовано.");
    await this.tool("t1", "read", { path: "src/auth/session.ts" });
    await this.tool("t2", "grep", { pattern: "session.user" });
    await this.tool("t3", "read", { path: "package.json" }, 450, { content: [{ type: "text", text: '{\n  "name": "my-app",\n  "scripts": { "test": "vitest" }\n}' }] });
    await this.tool("t3b", "edit", { input: "[src/auth/session.ts#A1B2]\nPUT 12.=12:\n+const user = session?.user ?? null;" }, 500, {
      content: [{ type: "text", text: "[src/auth/session.ts#C3D4]\n12:const user = session?.user ?? null;" }],
      details: { diff: "-12|const user = session.user;\n+12|const user = session?.user ?? null;", path: "src/auth/session.ts" },
    });
    if (!this.running) return;

    await this.say("Задача большая — разделю её на четыре части и запущу агентов параллельно.");
    AGENTS.forEach((a, i) => {
      this.emit({ type: "subagent_lifecycle", payload: { id: `sa-${i}`, agent: a.agent, agentSource: "builtin", status: "started", index: i } });
      this.progress(i, i === 3 ? "pending" : "running", { currentTool: i === 3 ? undefined : "read" });
    });
    this.emit({ type: "tool_execution_start", toolCallId: "t4", toolName: "task", args: { description: "4 подзадачи параллельно" } });

    const tools = ["read", "grep", "edit", "bash", "lsp"];
    for (let tick = 1; tick <= 8 && this.running; tick++) {
      await wait(900);
      for (let i = 0; i < 3; i++) {
        const done = (i === 0 && tick >= 3) || (i === 1 && tick >= 7) || (i === 2 && tick >= 8);
        if (done) continue;
        this.progress(i, "running", { currentTool: tools[(tick + i) % tools.length], toolCount: tick * (i + 2), tokens: tick * 4200 * (i + 1), cost: tick * 0.03 * (i + 1), durationMs: tick * 900 });
      }
      if (tick === 3) this.finish(0, "completed", 6, 12600);
      if (tick === 7) this.finish(1, "completed", 21, 58800);
      if (tick === 8) this.finish(2, "completed", 32, 100800);
      this.tokens += 6000;
    }
    if (!this.running) return;
    this.emit({ type: "tool_execution_end", toolCallId: "t4", toolName: "task", result: { content: [] } });

    this.progress(3, "running", { currentTool: "bash" });
    this.emit({
      type: "extension_ui_request",
      id: "ask-1",
      // Same shape the real agent uses for tool approvals.
      method: "select",
      title: "Allow tool: bash\nCommand: npm test -- payments",
      options: ["Approve", "Deny"],
    });
    const ok = await new Promise<boolean>((resolve) => (this.pendingAsk = resolve));
    if (!this.running) return;

    if (ok) {
      await this.tool("t5", "bash", { command: "npm test -- payments" }, 1200);
      this.finish(3, "completed", 3, 9000);
      await this.say("Готово: страница тарифов, Stripe и вебхук на месте, тесты оплаты проходят. Изменено 6 файлов — посмотрите `git diff`, прежде чем коммитить.");
    } else {
      this.finish(3, "aborted", 0, 0);
      await this.say("Хорошо, тесты не запускаю. Код готов, но не проверен — запустите `npm test -- payments`, когда будет удобно.");
    }
    this.running = false;
    this.emit({ type: "agent_end", messages: [], isTerminal: true });
  }

  private finish(i: number, status: "completed" | "aborted", toolCount: number, tokens: number) {
    const a = AGENTS[i];
    this.progress(i, status, { toolCount, tokens, cost: tokens * 0.00001, durationMs: (i + 1) * 2700 });
    this.emit({ type: "subagent_lifecycle", payload: { id: `sa-${i}`, agent: a.agent, agentSource: "builtin", status, index: i } });
  }
}
