// What every agent is doing, for the status file the native side writes for
// desktop widgets outside the window ($XDG_RUNTIME_DIR/octopus/status.json).

import type { Status } from "./session";

export type AgentStatus = {
  sessionId?: string;
  /** Session title, else the task as typed (clipped). */
  title?: string;
  /** The project folder; for a worktree copy, the project it was made from. */
  project?: string;
  /** Branch of the worktree copy the agent works in, if any. */
  branch?: string;
  /** "working" includes thinking; "waiting" means a question for the user. */
  status: "starting" | "working" | "waiting" | "idle" | "offline";
  /** Finished or asked something while in the background, not looked at yet. */
  unread: boolean;
  /** Start of the current turn (epoch ms) while working or waiting. */
  since?: number;
};

export type StatusSnapshot = {
  agents: AgentStatus[];
  counts: { working: number; waiting: number; unread: number };
};

/** The fields of a runtime the snapshot reads. */
export type RuntimeView = {
  sessionId?: string;
  title?: string;
  goal?: string;
  cwd?: string;
  worktree?: { root: string; branch: string };
  status: Status;
  unread: boolean;
  turnStartedAt?: number;
};

const TITLE_CHARS = 80;
const ORDER: Record<AgentStatus["status"], number> = { waiting: 0, working: 1, starting: 2, idle: 3, offline: 4 };

function agentStatus(status: Status): AgentStatus["status"] {
  return status === "thinking" ? "working" : status;
}

function clip(text: string | undefined): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > TITLE_CHARS ? t.slice(0, TITLE_CHARS - 1) + "…" : t;
}

/** Agents waiting for an answer first, then working ones; the order is otherwise kept. */
export function statusSnapshot(runtimes: RuntimeView[]): StatusSnapshot {
  const agents = runtimes
    .map((r): AgentStatus => {
      const status = agentStatus(r.status);
      const live = status === "working" || status === "waiting";
      return {
        sessionId: r.sessionId,
        title: clip(r.title) ?? clip(r.goal),
        project: r.worktree?.root ?? r.cwd,
        branch: r.worktree?.branch,
        status,
        unread: r.unread,
        since: live ? r.turnStartedAt : undefined,
      };
    })
    .map((a, i) => ({ a, i }))
    .sort((x, y) => ORDER[x.a.status] - ORDER[y.a.status] || x.i - y.i)
    .map(({ a }) => a);
  return {
    agents,
    counts: {
      working: agents.filter((a) => a.status === "working").length,
      waiting: agents.filter((a) => a.status === "waiting").length,
      unread: agents.filter((a) => a.unread).length,
    },
  };
}
