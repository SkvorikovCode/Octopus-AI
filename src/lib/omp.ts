// Thin client for the omp RPC protocol (https://omp.sh/docs/rpc).
// Rust forwards raw frames; this file correlates command responses by id.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { currentLang, t } from "./i18n";

export type Frame = { type: string; [key: string]: any };

type Handlers = {
  onFrame: (frame: Frame) => void;
  onStderr: (line: string) => void;
  onExit: (code: number | null) => void;
};

type Pending = { resolve: (data: any) => void; reject: (err: Error) => void };

// Generations must be unique across client instances: StrictMode and hot
// reload create new clients, and a reused number would let an old process's
// exit event pass for the new one's.
let lastGeneration = Date.now();

// Identifies this webview page: after a reload the backend stops the agents
// the previous page left running.
const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class OmpClient {
  private generation = 0;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private unlisten: UnlistenFn[] = [];

  constructor(private handlers: Handlers) {}

  async attach() {
    this.unlisten = await Promise.all([
      listen<{ generation: number; frame: Frame }>("omp-frame", (e) => {
        if (e.payload.generation === this.generation) this.dispatch(e.payload.frame);
      }),
      listen<{ generation: number; line: string }>("omp-stderr", (e) => {
        if (e.payload.generation === this.generation) this.handlers.onStderr(e.payload.line);
      }),
      listen<{ generation: number; code: number | null }>("omp-exit", (e) => {
        if (e.payload.generation !== this.generation) return;
        this.rejectAll(t("агент завершился"));
        this.handlers.onExit(e.payload.code);
      }),
    ]);
  }

  detach() {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
  }

  /** `ephemeral`: a helper process that writes no session file. */
  async start(cwd: string, approvalMode = "write", ephemeral = false) {
    this.rejectAll(t("агент перезапущен"));
    const previous = this.generation;
    this.generation = ++lastGeneration;
    if (previous) await invoke("omp_stop", { generation: previous }).catch(() => {});
    await invoke("omp_start", { cwd, generation: this.generation, approvalMode, lang: currentLang(), page: PAGE_ID, ephemeral });
  }

  async stop() {
    this.rejectAll(t("агент остановлен"));
    await invoke("omp_stop", { generation: this.generation });
  }

  /** Command that expects a `response` frame with the same id. */
  request<T = any>(command: Record<string, unknown>): Promise<T> {
    const id = `c${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      invoke("omp_send", { generation: this.generation, frame: { ...command, id } }).catch((err) => {
        this.pending.delete(id);
        reject(new Error(String(err)));
      });
    });
  }

  /** Fire-and-forget frame, e.g. `extension_ui_response`. */
  async send(frame: Record<string, unknown>) {
    await invoke("omp_send", { generation: this.generation, frame });
  }

  private dispatch(frame: Frame) {
    if (frame.type === "response" && frame.id && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      if (frame.success) p.resolve(frame.data);
      else p.reject(new Error(frame.error ?? t("ошибка команды")));
    }
    this.handlers.onFrame(frame);
  }

  private rejectAll(reason: string) {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}
