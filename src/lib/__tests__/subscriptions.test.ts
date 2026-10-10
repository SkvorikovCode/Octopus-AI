import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  createLoginAgent,
  deviceCode,
  flatRateProviders,
  loginEvent,
  mergeCatalog,
  SUBSCRIPTIONS,
} from "../subscriptions";

const engine = (id: string, authenticated = false, available = true) => ({
  id,
  name: id,
  available,
  authenticated,
});

describe("mergeCatalog", () => {
  it("keeps the curated order and only providers the engine reports", () => {
    const list = mergeCatalog([engine("cursor"), engine("deepseek"), engine("anthropic", true)]);
    expect(list.map((s) => s.id)).toEqual(["anthropic", "cursor"]);
    expect(list[0].authenticated).toBe(true);
    expect(list[0].name).toBe("Claude Pro / Max");
  });

  it("drops unavailable providers and a device variant the engine lacks", () => {
    expect(mergeCatalog([engine("anthropic", false, false)])).toEqual([]);
    expect(mergeCatalog([engine("openai-codex")])[0].deviceAlt).toBeUndefined();
    expect(mergeCatalog([engine("openai-codex"), engine("openai-codex-device")])[0].deviceAlt).toBe(
      "openai-codex-device",
    );
  });

  it("has unique ids", () => {
    const ids = SUBSCRIPTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("deviceCode", () => {
  it("reads the code from the engine's instructions", () => {
    expect(deviceCode("Enter code: MB9P-Z3R5")).toBe("MB9P-Z3R5");
    expect(deviceCode("Copy your API key from the dashboard")).toBeUndefined();
    expect(deviceCode(undefined)).toBeUndefined();
  });
});

describe("loginEvent", () => {
  it("maps the sign-in frames", () => {
    expect(
      loginEvent({
        type: "extension_ui_request",
        id: "1",
        method: "open_url",
        url: "https://x",
        instructions: "Enter code: AB12-CD34",
      }),
    ).toEqual({ kind: "url", url: "https://x", code: "AB12-CD34" });
    expect(
      loginEvent({
        type: "extension_ui_request",
        id: "2",
        method: "input",
        title: "Paste the authorization code",
      }),
    ).toEqual({
      kind: "input",
      requestId: "2",
      title: "Paste the authorization code",
      placeholder: undefined,
    });
    expect(
      loginEvent({ type: "extension_ui_request", id: "3", method: "cancel", targetId: "2" }),
    ).toEqual({
      kind: "cancel-input",
      requestId: "2",
    });
  });

  it("ignores everything else", () => {
    expect(
      loginEvent({ type: "extension_ui_request", id: "4", method: "notify", message: "Waiting…" }),
    ).toBeNull();
    expect(loginEvent({ type: "extension_ui_request", id: "5", method: "setWidget" })).toBeNull();
    expect(loginEvent({ type: "response", id: "c1" })).toBeNull();
  });
});

describe("demo login agent", () => {
  it("signs in with a pasted code and signs out", async () => {
    const agent = createLoginAgent("");
    await agent.start();
    const events: string[] = [];
    const login = agent.login("zai-coding-plan", (e) => {
      events.push(e.kind);
      if (e.kind === "input") agent.answer(e.requestId, "code-123");
    });
    await login;
    expect(events).toEqual(["url", "input"]);
    const sub = (await agent.subscriptions()).find((s) => s.id === "zai-coding-plan");
    expect(sub?.authenticated).toBe(true);
    const [account] = await agent.accounts("zai-coding-plan");
    await agent.logout("zai-coding-plan", account.credentialId);
    expect(await agent.accounts("zai-coding-plan")).toEqual([]);
  });
});

describe("flatRateProviders", () => {
  const rpc =
    (providers: unknown[], accounts: Record<string, { type: string }[]>) =>
    async <T>(cmd: Record<string, unknown>): Promise<T> => {
      if (cmd.type === "get_login_providers") return { providers } as T;
      if (cmd.type === "get_logout_accounts")
        return { accounts: accounts[cmd.providerId as string] ?? [] } as T;
      throw new Error("unexpected");
    };

  it("keeps OAuth sign-ins to flat-rate plans, under their billing id", async () => {
    const ids = await flatRateProviders(
      rpc(
        [
          engine("openai-codex", true),
          engine("anthropic", true),
          engine("openrouter", true),
          engine("zai-coding-plan", true),
          engine("cursor", false),
        ],
        {
          "openai-codex": [{ type: "oauth" }],
          anthropic: [{ type: "api_key" }],
          openrouter: [{ type: "oauth" }],
          "zai-coding-plan": [{ type: "oauth" }],
        },
      ),
    );
    expect([...ids].sort()).toEqual(["openai-codex", "zai"]);
  });

  it("gives an empty set when the agent can't answer", async () => {
    const failing = async <T>(): Promise<T> => {
      throw new Error("offline");
    };
    expect((await flatRateProviders(failing)).size).toBe(0);
    expect((await flatRateProviders(async <T>() => undefined as T)).size).toBe(0);
  });
});
