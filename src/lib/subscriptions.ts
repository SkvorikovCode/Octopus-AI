// Subscriptions: model providers the user signs in to (OAuth or a device code)
// instead of pasting an API key. The engine runs the sign-in over RPC
// (`get_login_providers`, `login`, `get_logout_accounts`, `logout`) and keeps
// and refreshes the tokens itself. A separate short-lived engine process does
// the sign-in, so login prompts never land in a chat.

import { isTauri } from "@tauri-apps/api/core";
import { OmpClient, type Frame } from "./omp";

/**
 * How the sign-in goes: `browser` — OAuth page, the app gets the code back
 * (or the user pastes it); `device` — a code typed on the provider's page;
 * `terminal` — the provider asks questions before the browser step, which the
 * engine allows only in a terminal.
 */
export type LoginMethod = "browser" | "device" | "terminal";

export type SubscriptionDef = {
  id: string;
  name: string;
  method: LoginMethod;
  /** Short Russian note under the name (translated at render). */
  note?: string;
  /** The browser can't hand the code back: the user always pastes it. */
  pasteRequired?: boolean;
  /** Same account, signed in with a device code instead of the browser. */
  deviceAlt?: string;
  /** Billed per request even when signed in (the sign-in only fetches a key). */
  metered?: boolean;
  /** Provider id its models run under, when it differs from `id`. */
  billingId?: string;
};

/** Curated list in display order. Providers the engine doesn't report are hidden. */
export const SUBSCRIPTIONS: SubscriptionDef[] = [
  { id: "anthropic", name: "Claude Pro / Max", method: "browser" },
  {
    id: "openai-codex",
    name: "ChatGPT Plus / Pro",
    method: "browser",
    deviceAlt: "openai-codex-device",
  },
  { id: "github-copilot", name: "GitHub Copilot", method: "terminal" },
  {
    id: "google-gemini-cli",
    name: "Gemini CLI",
    method: "browser",
    note: "Google Cloud Code Assist",
  },
  {
    id: "google-antigravity",
    name: "Antigravity",
    method: "browser",
    note: "Gemini 3, Claude, GPT-OSS",
  },
  { id: "cursor", name: "Cursor", method: "browser" },
  { id: "xai-oauth", name: "Grok", method: "device", note: "SuperGrok или X Premium+" },
  { id: "kimi-code", name: "Kimi Code", method: "device" },
  {
    id: "zai-coding-plan",
    name: "Z.ai GLM Coding Plan",
    method: "browser",
    pasteRequired: true,
    billingId: "zai",
  },
  { id: "gitlab-duo", name: "GitLab Duo", method: "browser" },
  { id: "gitlab-duo-agent", name: "GitLab Duo Agent", method: "browser", pasteRequired: true },
  { id: "devin", name: "Devin", method: "browser" },
  { id: "factory-droid", name: "Factory Droid", method: "device" },
  { id: "muse-code", name: "Muse Code", method: "device" },
  { id: "kilo", name: "Kilo Gateway", method: "device", metered: true },
  {
    id: "openrouter",
    name: "OpenRouter",
    method: "browser",
    note: "Вход вместо API-ключа",
    metered: true,
  },
  { id: "perplexity", name: "Perplexity Pro / Max", method: "terminal" },
  { id: "alibaba-coding-plan", name: "Alibaba Coding Plan", method: "terminal" },
  { id: "alibaba-token-plan", name: "QwenCloud Token Plan", method: "terminal" },
  { id: "snowflake", name: "Snowflake Cortex", method: "terminal" },
];

/** Provider as the engine reports it in `get_login_providers`. */
export type EngineLoginProvider = {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
};

export type Subscription = SubscriptionDef & { authenticated: boolean };

/** Stored credential of a provider (`get_logout_accounts`). */
export type Account = {
  credentialId: number;
  label: string;
  detail?: string;
  type: string;
  active: boolean;
};

/** The curated list, limited to what this engine version can sign in to. */
export function mergeCatalog(engine: EngineLoginProvider[]): Subscription[] {
  const byId = new Map(engine.map((p) => [p.id, p]));
  return SUBSCRIPTIONS.flatMap((def) => {
    const p = byId.get(def.id);
    if (!p || !p.available) return [];
    const deviceAlt =
      def.deviceAlt && byId.get(def.deviceAlt)?.available ? def.deviceAlt : undefined;
    return [{ ...def, deviceAlt, authenticated: p.authenticated }];
  });
}

type Request = <T>(command: Record<string, unknown>) => Promise<T>;

/**
 * Providers whose requests are covered by a flat-rate plan: signed in with an
 * OAuth account (not an API key) to a subscription that isn't billed per
 * request. Their costs come from catalog prices and must stay out of the budget.
 * `request` is any running agent's RPC; failures give an empty set.
 */
export async function flatRateProviders(request: Request): Promise<Set<string>> {
  try {
    const data = await request<{ providers?: EngineLoginProvider[] }>({
      type: "get_login_providers",
    });
    const signedIn = mergeCatalog(data?.providers ?? []).filter(
      (s) => s.authenticated && !s.metered,
    );
    const ids = await Promise.all(
      signedIn.map(async (s) => {
        const res = await request<{ accounts?: Account[] }>({
          type: "get_logout_accounts",
          providerId: s.id,
        }).catch(() => undefined);
        return res?.accounts?.some((a) => a.type === "oauth") ? (s.billingId ?? s.id) : undefined;
      }),
    );
    return new Set(ids.filter((id): id is string => !!id));
  } catch {
    return new Set();
  }
}

/** Code the user types on the provider's page ("Enter code: ABCD-1234"). */
export function deviceCode(instructions: unknown): string | undefined {
  if (typeof instructions !== "string") return undefined;
  return /code:\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(instructions)?.[1];
}

/** What a sign-in needs from the UI. */
export type LoginEvent =
  | { kind: "url"; url: string; code?: string }
  | { kind: "input"; requestId: string; title: string; placeholder?: string }
  | { kind: "cancel-input"; requestId: string };

/** Engine frame → sign-in event; frames unrelated to sign-in give null. */
export function loginEvent(f: Frame): LoginEvent | null {
  if (f.type !== "extension_ui_request") return null;
  switch (f.method) {
    case "open_url":
      return typeof f.url === "string"
        ? { kind: "url", url: f.url, code: deviceCode(f.instructions) }
        : null;
    case "input":
      return typeof f.id === "string"
        ? {
            kind: "input",
            requestId: f.id,
            title: String(f.title ?? ""),
            placeholder: f.placeholder,
          }
        : null;
    case "cancel":
      return typeof f.targetId === "string"
        ? { kind: "cancel-input", requestId: f.targetId }
        : null;
    default:
      return null;
  }
}

export interface LoginAgent {
  /** Starts the helper process; resolves once it accepts commands. */
  start(): Promise<void>;
  subscriptions(): Promise<Subscription[]>;
  /** Runs a sign-in; resolves when it succeeds. One at a time. */
  login(providerId: string, onEvent: (e: LoginEvent) => void): Promise<void>;
  /** Answers an `input` event (the pasted code). */
  answer(requestId: string, value: string): Promise<void>;
  accounts(providerId: string): Promise<Account[]>;
  logout(providerId: string, credentialId: number): Promise<void>;
  dispose(): void;
}

const READY_TIMEOUT_MS = 30_000;

class EngineLoginAgent implements LoginAgent {
  private client: OmpClient;
  private ready?: () => void;
  private listener?: (e: LoginEvent) => void;

  constructor(private cwd: string) {
    this.client = new OmpClient({
      onFrame: (f) => {
        if (f.type === "ready") this.ready?.();
        const e = loginEvent(f);
        if (e) this.listener?.(e);
      },
      onStderr: () => {},
      onExit: () => {},
    });
  }

  async start() {
    await this.client.attach();
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = resolve;
      setTimeout(() => reject(new Error("Агент не запустился")), READY_TIMEOUT_MS);
    });
    // The helper never runs tools, so the approval mode doesn't matter.
    await this.client.start(this.cwd, "always-ask", true);
    await ready;
  }

  async subscriptions() {
    const data = await this.client.request<{ providers: EngineLoginProvider[] }>({
      type: "get_login_providers",
    });
    return mergeCatalog(data.providers ?? []);
  }

  async login(providerId: string, onEvent: (e: LoginEvent) => void) {
    this.listener = onEvent;
    try {
      await this.client.request({ type: "login", providerId });
    } finally {
      this.listener = undefined;
    }
  }

  answer(requestId: string, value: string) {
    return this.client.send({ type: "extension_ui_response", id: requestId, value });
  }

  async accounts(providerId: string) {
    const data = await this.client.request<{ accounts: Account[] }>({
      type: "get_logout_accounts",
      providerId,
    });
    return data.accounts ?? [];
  }

  async logout(providerId: string, credentialId: number) {
    await this.client.request({ type: "logout", providerId, credentialId });
  }

  dispose() {
    this.listener = undefined;
    this.client.stop().catch(() => {});
    this.client.detach();
  }
}

// ---------- browser preview ----------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Lives across helper restarts, like the engine's credential store.
const demoSignedIn = new Map<string, Account[]>([
  [
    "anthropic",
    [{ credentialId: 1, label: "you@example.com", detail: "Max", type: "oauth", active: true }],
  ],
]);

/** In-memory stand-in: Claude is signed in, sign-ins succeed after a pause. */
class DemoLoginAgent implements LoginAgent {
  private pendingInput?: (value: string) => void;

  async start() {
    await wait(400);
  }

  async subscriptions() {
    return mergeCatalog(
      [...SUBSCRIPTIONS.map((d) => d.id), "openai-codex-device"].map((id) => ({
        id,
        name: id,
        available: true,
        authenticated: (demoSignedIn.get(id)?.length ?? 0) > 0,
      })),
    );
  }

  async login(providerId: string, onEvent: (e: LoginEvent) => void) {
    const def = SUBSCRIPTIONS.find((d) => d.id === providerId || d.deviceAlt === providerId);
    const device = def?.method === "device" || def?.deviceAlt === providerId;
    await wait(500);
    onEvent({
      kind: "url",
      url: "https://example.com/oauth/authorize",
      code: device ? "WDJB-MJHT" : undefined,
    });
    // Armed before the input event: the answer may come back synchronously.
    const pasted = new Promise<string>((resolve) => (this.pendingInput = resolve));
    if (def?.pasteRequired) {
      onEvent({ kind: "input", requestId: "demo-input", title: "Paste the authorization code" });
      await pasted;
    } else {
      if (!device)
        onEvent({ kind: "input", requestId: "demo-input", title: "Paste the authorization code" });
      await Promise.race([wait(4000), pasted]);
      onEvent({ kind: "cancel-input", requestId: "demo-input" });
    }
    this.pendingInput = undefined;
    const id = def?.id ?? providerId;
    const list = demoSignedIn.get(id) ?? [];
    demoSignedIn.set(id, [
      ...list,
      {
        credentialId: list.length + 1,
        label: "you@example.com",
        type: "oauth",
        active: list.length === 0,
      },
    ]);
  }

  async answer(_requestId: string, value: string) {
    this.pendingInput?.(value);
  }

  async accounts(providerId: string) {
    return demoSignedIn.get(providerId) ?? [];
  }

  async logout(providerId: string, credentialId: number) {
    await wait(300);
    const rest = (demoSignedIn.get(providerId) ?? []).filter(
      (a) => a.credentialId !== credentialId,
    );
    if (rest.length) demoSignedIn.set(providerId, rest);
    else demoSignedIn.delete(providerId);
  }

  dispose() {
    this.pendingInput = undefined;
  }
}

/** Helper process for sign-ins; `cwd` is where it starts (the home folder). */
export function createLoginAgent(cwd: string): LoginAgent {
  return isTauri() ? new EngineLoginAgent(cwd) : new DemoLoginAgent();
}
