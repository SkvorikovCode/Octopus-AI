import { invoke, isTauri } from "@tauri-apps/api/core";

export type ApiKind = "openai-completions" | "openai-responses" | "anthropic-messages";

/** USD per 1M tokens. Without a cost the engine uses its catalog price for the model. */
export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  longContext?: { inputThreshold: number; input: number; output: number; cacheRead: number; cacheWrite: number };
};

export type ProviderModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
};

export type ProviderInfo = {
  id: string;
  baseUrl: string;
  api: string;
  models: ProviderModel[];
  keySource: "octopus" | "env" | "command" | "literal" | "none";
  managed: boolean;
};

export type ProviderInput = {
  id: string;
  baseUrl: string;
  api: ApiKind;
  apiKey?: string;
  models: ProviderModel[];
};

// Browser preview has no Rust backend: answer with sample data instead.
const DEMO = !isTauri();
const DEMO_PROVIDERS: ProviderInfo[] = [
  { id: "wikivibe", baseUrl: "https://api.wikivibe.ru/v1", api: "openai-completions", models: [{ id: "gpt-6-luna", name: "6 Luna" }], keySource: "literal", managed: false },
  { id: "local-vllm", baseUrl: "http://localhost:8000/v1", api: "openai-completions", models: [{ id: "qwen3-coder" }], keySource: "octopus", managed: true },
];

// Browser preview: prices set in the demo live only in memory, keyed by "provider/model".
const demoCosts = new Map<string, ModelCost>();

export const listProviders = () =>
  DEMO
    ? Promise.resolve(
        DEMO_PROVIDERS.map((p) => ({
          ...p,
          models: p.models.map((m) => {
            const cost = demoCosts.get(`${p.id}/${m.id}`);
            return cost ? { ...m, cost } : m;
          }),
        })),
      )
    : invoke<ProviderInfo[]>("providers_list");

/** Sets a model's price, or with null returns it to the engine's catalog price. */
export const setModelCost = (provider: string, model: string, cost: ModelCost | null) => {
  if (DEMO) {
    const key = `${provider}/${model}`;
    if (cost) demoCosts.set(key, cost);
    else demoCosts.delete(key);
    return Promise.resolve();
  }
  return invoke<void>("model_cost_set", { provider, model, cost });
};

export const discoverModels = (baseUrl: string, api: ApiKind, apiKey: string) =>
  DEMO
    ? Promise.resolve(["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"])
    : invoke<string[]>("provider_discover", { baseUrl, api, apiKey });

export const saveProvider = (input: ProviderInput) =>
  DEMO ? Promise.resolve() : invoke<void>("provider_save", { input });

export const removeProvider = (id: string) =>
  DEMO ? Promise.resolve() : invoke<void>("provider_remove", { id });

export const API_KINDS: { value: ApiKind; label: string; hint: string }[] = [
  {
    value: "openai-completions",
    label: "OpenAI-совместимый",
    hint: "chat/completions: большинство прокси, OpenRouter, vLLM, LM Studio",
  },
  {
    value: "openai-responses",
    label: "OpenAI Responses",
    hint: "эндпоинт /v1/responses от OpenAI",
  },
  {
    value: "anthropic-messages",
    label: "Anthropic-совместимый",
    hint: "эндпоинт /v1/messages, как у Anthropic",
  },
];

/** "My Proxy!" -> "my-proxy" */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
