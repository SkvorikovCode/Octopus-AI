// One running agent = one runtime: its engine process, the session it shows,
// the swarm of its subagents and its own failure state. Several runtimes run
// side by side (parallel tasks); the app renders whichever one is active.

import type { DemoClient } from "./demo";
import type { Frame, OmpClient } from "./omp";
import { initialSession, reduce, type Action, type SessionState } from "./session";
import { initialSwarm, reduceSwarm, swarmFromSnapshot, type SwarmState } from "./swarm";

export type Engine = OmpClient | DemoClient;

export type SwarmAction = { type: "frame"; frame: Frame } | { type: "snapshot"; list: any[] } | { type: "reset" };

function swarmReducer(s: SwarmState, a: SwarmAction): SwarmState {
  if (a.type === "reset") return initialSwarm;
  if (a.type === "snapshot") return swarmFromSnapshot(s, a.list);
  return reduceSwarm(s, a.frame);
}

export type Failure = { code: number | null; text: string };

/** What a component renders for one runtime; replaced (never mutated) on change. */
export type RuntimeSnapshot = {
  state: SessionState;
  swarm: SwarmState;
  failure?: Failure;
  /** Finished or asked something while in the background, not looked at yet. */
  unread: boolean;
  /** Plan-first flow: the agent is planning, or its plan waits for approval. */
  plan?: "planning" | "ready";
};

let nextId = 1;

export class Runtime {
  readonly id = nextId++;
  client!: Engine;
  cwd?: string;
  snap: RuntimeSnapshot = { state: initialSession, swarm: initialSwarm, unread: false };
  stderr: string[] = [];
  /** Set while we stop/restart the engine ourselves, so that exit is not an error. */
  stopping = false;
  /** Session to open once the engine is ready. */
  pendingSession: string | null = null;
  /** Model to select once the engine is ready. */
  pendingModel: { provider: string; id: string } | null = null;
  /** First task to send once the engine is ready (task started in a fresh copy). */
  pendingPrompt: Record<string, unknown> | null = null;
  /** Set when this agent works in a separate git worktree of the project. */
  worktree?: { path: string; root: string; branch: string };
  disposed = false;
  /** Side questions (`btw`) waiting for their answer, by record id. */
  private sideWaiters = new Map<string, { resolve: (text: string) => void; reject: (e: Error) => void }>();
  private sideDone = new Map<string, string>();
  private listeners = new Set<() => void>();
  /** Called when status or unread changes — the app's sidebar listens. */
  onStatus?: () => void;

  get state() {
    return this.snap.state;
  }

  get busy() {
    const st = this.snap.state.status;
    return st === "working" || st === "thinking" || st === "waiting";
  }

  dispatch = (a: Action) => {
    const before = this.snap.state;
    const state = reduce(before, a);
    if (state === before) return;
    this.set({ state });
    if (state.status !== before.status || state.sessionId !== before.sessionId || state.title !== before.title) this.onStatus?.();
  };

  swarmDispatch = (a: SwarmAction) => {
    const swarm = swarmReducer(this.snap.swarm, a);
    if (swarm !== this.snap.swarm) this.set({ swarm });
  };

  setFailure(failure: Failure | undefined) {
    this.set({ failure });
  }

  setPlan(plan: RuntimeSnapshot["plan"]) {
    if (this.snap.plan !== plan) this.set({ plan });
  }

  /** Feed `btw_record` frames here; resolves the matching side question. */
  onSideRecord(record: { id?: string; status?: string; answer?: string; error?: string } | undefined) {
    if (!record?.id || record.status === "running" || record.status === undefined) return;
    const waiter = this.sideWaiters.get(record.id);
    const failed = record.status !== "complete";
    if (!waiter) {
      if (!failed) this.sideDone.set(record.id, record.answer ?? "");
      return;
    }
    this.sideWaiters.delete(record.id);
    if (failed) waiter.reject(new Error(record.error || record.status || "side question failed"));
    else waiter.resolve(record.answer ?? "");
  }

  /**
   * Ask the agent a side question that stays out of the session history
   * (used for commit messages). Resolves with the answer text.
   */
  async askSide(question: string, timeoutMs = 120_000): Promise<string> {
    const data = await this.client.request<{ record?: { id?: string; status?: string; answer?: string } }>({ type: "btw", question });
    const record = data?.record;
    if (!record?.id) throw new Error("no record");
    if (record.status === "complete") return record.answer ?? "";
    const early = this.sideDone.get(record.id);
    if (early !== undefined) {
      this.sideDone.delete(record.id);
      return early;
    }
    return new Promise<string>((resolve, reject) => {
      this.sideWaiters.set(record.id!, { resolve, reject });
      setTimeout(() => {
        if (this.sideWaiters.delete(record.id!)) reject(new Error("timeout"));
      }, timeoutMs);
    });
  }

  setUnread(unread: boolean) {
    if (this.snap.unread === unread) return;
    this.set({ unread });
    this.onStatus?.();
  }

  private set(patch: Partial<RuntimeSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = () => this.snap;

  dispose() {
    this.disposed = true;
    this.stopping = true;
    this.client.detach();
    this.client.stop().catch(() => {});
    this.listeners.clear();
  }
}

// ---------- per-session file snapshots (checkpoints) ----------

const CHECKPOINTS_KEY = "octopus.checkpoints";
const MAX_SESSIONS = 200;

type CheckpointStore = Record<string, Record<number, string>>;

function loadStore(): CheckpointStore {
  try {
    const raw = localStorage.getItem(CHECKPOINTS_KEY);
    return raw ? (JSON.parse(raw) as CheckpointStore) : {};
  } catch {
    return {};
  }
}

/** Snapshot ids by user-message index for one session. */
export function sessionCheckpoints(sessionId: string | undefined): Record<number, string> {
  if (!sessionId) return {};
  return loadStore()[sessionId] ?? {};
}

export function rememberCheckpoint(sessionId: string, userIndex: number, id: string) {
  const store = loadStore();
  store[sessionId] = { ...(store[sessionId] ?? {}), [userIndex]: id };
  const ids = Object.keys(store);
  if (ids.length > MAX_SESSIONS) for (const old of ids.slice(0, ids.length - MAX_SESSIONS)) delete store[old];
  try {
    localStorage.setItem(CHECKPOINTS_KEY, JSON.stringify(store));
  } catch {
    /* kept for this run only */
  }
}
