// State for omp subagents ("рой"). Pure reducers over omp RPC frames and
// get_subagents snapshots. Unknown or malformed fields are tolerated.

import type { Frame } from "./omp";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export type Subagent = {
  id: string;
  index: number;
  agent: string;
  task: string;
  assignment?: string;
  status: SubagentStatus;
  toolCount: number;
  tokens: number;
  cost: number;
  durationMs: number;
  currentTool?: string;
  recentTools: string[];
  recentOutput: string[];
  sessionFile?: string;
  startedAt: number;
  updatedAt: number;
};

export type SwarmLogEntry = { t: number; index: number; agent: string; text: string };

export type SwarmState = { agents: Record<string, Subagent>; order: string[]; log: SwarmLogEntry[] };

export const initialSwarm: SwarmState = { agents: {}, order: [], log: [] };

type Raw = Record<string, any>;

const LOG_LIMIT = 200;
const RECENT_LIMIT = 12;
const STATUSES: SubagentStatus[] = ["pending", "running", "completed", "failed", "aborted"];
const TERMINAL: SubagentStatus[] = ["completed", "failed", "aborted"];
const LIFECYCLE_LOG: Record<string, string> = {
  started: "запущен",
  completed: "готово",
  failed: "ошибка",
  aborted: "остановлен",
};
const LABEL_KEYS = ["name", "tool", "label", "text", "summary"] as const;

function isObj(v: unknown): v is Raw {
  return typeof v === "object" && v !== null;
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function tokensOf(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (isObj(v)) {
    if (typeof v.total === "number") return v.total;
    let sum = 0;
    for (const x of Object.values(v)) if (typeof x === "number" && Number.isFinite(x)) sum += x;
    return sum;
  }
  return fallback;
}

function timeOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function statusOf(v: unknown): SubagentStatus {
  if (v === "started") return "running";
  return STATUSES.includes(v as SubagentStatus) ? (v as SubagentStatus) : "running";
}

function toLine(item: unknown): string {
  if (typeof item === "string") return item;
  if (isObj(item)) {
    for (const k of LABEL_KEYS) {
      const v = item[k];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(item);
  } catch {
    json = undefined;
  }
  return (json ?? "").slice(0, 80);
}

function linesOf(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) ? v.map((x) => toLine(x)).slice(-RECENT_LIMIT) : fallback;
}

function toolOf(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return toLine(v);
}

function keyOf(id: unknown, index: number): string {
  const s = text(id);
  return s !== "" ? s : `idx-${index}`;
}

// Fixed key order, so two equal agents always serialize identically.
function makeAgent(f: Subagent): Subagent {
  return {
    id: f.id,
    index: f.index,
    agent: f.agent,
    task: f.task,
    assignment: f.assignment,
    status: f.status,
    toolCount: f.toolCount,
    tokens: f.tokens,
    cost: f.cost,
    durationMs: f.durationMs,
    currentTool: f.currentTool,
    recentTools: f.recentTools,
    recentOutput: f.recentOutput,
    sessionFile: f.sessionFile,
    startedAt: f.startedAt,
    updatedAt: f.updatedAt,
  };
}

function sameContent(a: Subagent, b: Subagent): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}

// Stores an agent and appends log lines. Returns the same state when nothing changed.
function commit(s: SwarmState, next: Subagent, lines: string[]): SwarmState {
  const prev = s.agents[next.id];
  if (prev && lines.length === 0 && sameContent(prev, next)) return s;
  const agent = makeAgent(next);
  const agents = { ...s.agents, [agent.id]: agent };
  const order = prev ? s.order : [...s.order, agent.id].sort((a, b) => agents[a].index - agents[b].index);
  const log =
    lines.length === 0
      ? s.log
      : [
          ...s.log,
          ...lines.map((line) => ({ t: agent.updatedAt, index: agent.index, agent: agent.agent, text: line })),
        ].slice(-LOG_LIMIT);
  return { agents, order, log };
}

function onLifecycle(s: SwarmState, p: Raw, now: number): SwarmState {
  const index = num(p.index, 0);
  const id = keyOf(p.id, index);
  const prev = s.agents[id];
  const raw = text(p.status);
  let status = statusOf(raw);
  // A late "started" must not move a finished agent back to running.
  if (prev && TERMINAL.includes(prev.status) && !TERMINAL.includes(status)) status = prev.status;
  const terminal = TERMINAL.includes(status);

  const lines: string[] = [];
  const label: string | undefined = Object.hasOwn(LIFECYCLE_LOG, raw) ? LIFECYCLE_LOG[raw] : undefined;
  if (label && (!prev || prev.status !== status)) lines.push(label);

  const startedAt = prev?.startedAt ?? now;
  const next: Subagent = {
    id,
    index,
    agent: text(p.agent) || prev?.agent || "agent",
    task: text(p.description) || prev?.task || "",
    assignment: prev?.assignment,
    status,
    toolCount: prev?.toolCount ?? 0,
    tokens: prev?.tokens ?? 0,
    cost: prev?.cost ?? 0,
    durationMs: terminal ? Math.max(prev?.durationMs ?? 0, now - startedAt) : prev?.durationMs ?? 0,
    currentTool: terminal ? undefined : prev?.currentTool,
    recentTools: prev?.recentTools ?? [],
    recentOutput: prev?.recentOutput ?? [],
    sessionFile: text(p.sessionFile) || prev?.sessionFile,
    startedAt,
    updatedAt: now,
  };
  return commit(s, next, lines);
}

function onProgress(s: SwarmState, p: Raw, now: number): SwarmState {
  const pr: Raw = isObj(p.progress) ? p.progress : {};
  const index = num(p.index ?? pr.index, 0);
  const id = keyOf(p.id ?? pr.id, index);
  const prev = s.agents[id];

  let status = statusOf(pr.status);
  // A late progress frame must not move a finished agent back to running.
  if (prev && TERMINAL.includes(prev.status) && !TERMINAL.includes(status)) status = prev.status;

  const currentTool = TERMINAL.includes(status) ? undefined : toolOf(pr.currentTool);
  const lines: string[] = [];
  if (currentTool && currentTool !== prev?.currentTool) lines.push(`→ ${currentTool}`);

  const next: Subagent = {
    id,
    index,
    agent: text(p.agent ?? pr.agent) || prev?.agent || "agent",
    task: text(p.task ?? pr.task) || prev?.task || "",
    assignment: text(p.assignment ?? pr.assignment) || prev?.assignment,
    status,
    toolCount: num(pr.toolCount, prev?.toolCount ?? 0),
    tokens: tokensOf(pr.tokens, prev?.tokens ?? 0),
    cost: num(pr.cost, prev?.cost ?? 0),
    durationMs: num(pr.durationMs, prev?.durationMs ?? 0),
    currentTool,
    recentTools: linesOf(pr.recentTools, prev?.recentTools ?? []),
    recentOutput: linesOf(pr.recentOutput, prev?.recentOutput ?? []),
    sessionFile: text(p.sessionFile ?? pr.sessionFile) || prev?.sessionFile,
    startedAt: prev?.startedAt ?? now,
    updatedAt: now,
  };
  return commit(s, next, lines);
}

// Pure: the optional `now` defaults to the wall clock. Pass it for deterministic results.
export function reduceSwarm(s: SwarmState, frame: Frame, now: number = Date.now()): SwarmState {
  const p = isObj(frame.payload) ? frame.payload : undefined;
  if (!p) return s;
  if (frame.type === "subagent_lifecycle") return onLifecycle(s, p, now);
  if (frame.type === "subagent_progress") return onProgress(s, p, now);
  return s;
}

// Merges a get_subagents result. Snapshots do not write log lines.
export function swarmFromSnapshot(s: SwarmState, subagents: any[], now: number = Date.now()): SwarmState {
  if (!Array.isArray(subagents)) return s;
  let out = s;
  for (const raw of subagents) {
    if (!isObj(raw)) continue;
    const src: Raw = { ...raw, ...(isObj(raw.progress) ? raw.progress : {}) };
    const index = num(src.index, 0);
    const id = keyOf(src.id, index);
    const prev = out.agents[id];

    let status = statusOf(src.status);
    if (prev && TERMINAL.includes(prev.status) && !TERMINAL.includes(status)) status = prev.status;

    const next: Subagent = {
      id,
      index,
      agent: text(src.agent) || prev?.agent || "agent",
      task: text(src.task ?? src.description) || prev?.task || "",
      assignment: text(src.assignment) || prev?.assignment,
      status,
      toolCount: num(src.toolCount, prev?.toolCount ?? 0),
      tokens: tokensOf(src.tokens, prev?.tokens ?? 0),
      cost: num(src.cost, prev?.cost ?? 0),
      durationMs: num(src.durationMs, prev?.durationMs ?? 0),
      currentTool: toolOf(src.currentTool),
      recentTools: linesOf(src.recentTools, prev?.recentTools ?? []),
      recentOutput: linesOf(src.recentOutput, prev?.recentOutput ?? []),
      sessionFile: text(src.sessionFile) || prev?.sessionFile,
      startedAt: timeOf(src.startedAt) ?? prev?.startedAt ?? now,
      updatedAt: timeOf(src.lastUpdate) ?? now,
    };
    out = commit(out, next, []);
  }
  return out;
}

export function swarmCounts(s: SwarmState): { total: number; done: number; running: number; failed: number; pending: number } {
  const c = { total: s.order.length, done: 0, running: 0, failed: 0, pending: 0 };
  for (const id of s.order) {
    const status = s.agents[id]?.status;
    if (status === "completed") c.done++;
    else if (status === "running") c.running++;
    else if (status === "failed") c.failed++;
    else if (status === "pending") c.pending++;
  }
  return c;
}
