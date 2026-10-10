// Frontend side of the terminal panel: the PTY commands and events of the Rust
// side (src-tauri/src/pty.rs). Outside Tauri (browser preview) a fake shell
// answers instead, so the panel still looks alive.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type PtyData = { id: number; data: string };
export type PtyExit = { id: number; code: number | null };

type Event = { kind: "data"; id: number; data: string } | { kind: "exit"; id: number; code: number | null };

// One bus for both events. Output of a terminal can arrive before its open
// call resolves (the shell prints its prompt at once), and the id is unknown
// until then, so events are held per id until the id is claimed.
const claimed = new Set<number>();
const backlog = new Map<number, Event[]>();
const dataSubs = new Set<(ev: PtyData) => void>();
const exitSubs = new Set<(ev: PtyExit) => void>();

function deliver(ev: Event) {
  if (ev.kind === "data") {
    for (const cb of dataSubs) cb({ id: ev.id, data: ev.data });
  } else {
    for (const cb of exitSubs) cb({ id: ev.id, code: ev.code });
  }
}

function scheduleFlush(id: number) {
  // A macrotask, so the caller's continuation (which records the id) runs first.
  setTimeout(() => {
    const queue = backlog.get(id);
    if (!queue) return;
    backlog.delete(id);
    queue.forEach(deliver);
  }, 0);
}

function dispatch(ev: Event) {
  if (!claimed.has(ev.id) || backlog.has(ev.id)) {
    const queue = backlog.get(ev.id);
    if (queue) queue.push(ev);
    else backlog.set(ev.id, [ev]);
    if (claimed.has(ev.id)) scheduleFlush(ev.id);
    return;
  }
  deliver(ev);
}

function claim(id: number) {
  claimed.add(id);
  if (backlog.has(id)) scheduleFlush(id);
}

let bus: Promise<void> | null = null;

function ensureBus(): Promise<void> {
  bus ??= Promise.all([
    listen<{ id: number; data: string }>("pty-data", (e) =>
      dispatch({ kind: "data", id: e.payload.id, data: e.payload.data }),
    ),
    listen<{ id: number; code: number | null }>("pty-exit", (e) =>
      dispatch({ kind: "exit", id: e.payload.id, code: e.payload.code }),
    ),
  ]).then(() => undefined);
  return bus;
}

// ---------- demo shell (browser preview) ----------

const DEMO_PROMPT = "my-app % ";
let demoSeq = 0;
const demoLines = new Map<number, string>();

function demoPrompt(id: number) {
  dispatch({ kind: "data", id, data: DEMO_PROMPT });
}

function demoWrite(id: number, data: string) {
  if (data.startsWith("\x1b")) return; // arrows and other escape sequences: ignored
  let line = demoLines.get(id) ?? "";
  for (const ch of data) {
    if (ch === "\r") {
      const cmd = line.trim();
      let out = "\r\n";
      if (cmd === "clear") out += "\x1b[2J\x1b[3J\x1b[H";
      else if (cmd) out += `zsh: command not found: ${cmd.split(/\s+/)[0]}\r\n`;
      dispatch({ kind: "data", id, data: out + DEMO_PROMPT });
      line = "";
    } else if (ch === "\x7f") {
      if (line) {
        line = line.slice(0, -1);
        dispatch({ kind: "data", id, data: "\b \b" });
      }
    } else if (ch === "\x03") {
      line = "";
      dispatch({ kind: "data", id, data: "^C\r\n" + DEMO_PROMPT });
    } else if (ch >= " ") {
      line += ch;
      dispatch({ kind: "data", id, data: ch });
    }
  }
  demoLines.set(id, line);
}

// ---------- public API ----------

/** Starts a shell in `cwd`; resolves with the terminal id. */
export async function openPty(cwd: string, cols: number, rows: number): Promise<number> {
  if (!isTauri()) {
    const id = ++demoSeq;
    claim(id);
    setTimeout(() => demoPrompt(id), 40);
    return id;
  }
  await ensureBus();
  const id = await invoke<number>("pty_open", { cwd, cols, rows });
  claim(id);
  return id;
}

/** Runs the agent's sign-in for `provider` in a terminal; resolves with the terminal id. */
export async function openLoginPty(provider: string, cols: number, rows: number): Promise<number> {
  if (!isTauri()) {
    const id = ++demoSeq;
    claim(id);
    setTimeout(() => dispatch({ kind: "data", id, data: "GitHub Enterprise URL/domain (blank for github.com): " }), 40);
    return id;
  }
  await ensureBus();
  const id = await invoke<number>("pty_open_login", { provider, cols, rows });
  claim(id);
  return id;
}

export async function writePty(id: number, data: string): Promise<void> {
  if (!isTauri()) {
    demoWrite(id, data);
    return;
  }
  await invoke("pty_write", { id, data });
}

export async function resizePty(id: number, cols: number, rows: number): Promise<void> {
  if (!isTauri()) return;
  await invoke("pty_resize", { id, cols, rows });
}

export async function closePty(id: number): Promise<void> {
  backlog.delete(id);
  demoLines.delete(id);
  if (!isTauri()) return;
  await invoke("pty_close", { id });
}

/** Output of every terminal (filter by id). Returns the unsubscribe function. */
export function onPtyData(cb: (ev: PtyData) => void): () => void {
  if (isTauri()) void ensureBus();
  dataSubs.add(cb);
  return () => {
    dataSubs.delete(cb);
  };
}

/** End of a terminal's process (filter by id). Returns the unsubscribe function. */
export function onPtyExit(cb: (ev: PtyExit) => void): () => void {
  if (isTauri()) void ensureBus();
  exitSubs.add(cb);
  return () => {
    exitSubs.delete(cb);
  };
}
