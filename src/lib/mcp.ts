// MCP servers for the Connections screen. Real data comes from the Rust `mcp_*`
// commands (src-tauri/src/mcp.rs); outside Tauri (browser preview) an in-memory list
// with two sample servers is used instead. Secret values never come back from Rust:
// only their names (envKeys / headerKeys).

import { invoke, isTauri } from "@tauri-apps/api/core";

export type McpKind = "stdio" | "http" | "sse";
export type McpScope = "user" | "project";

export type McpServer = {
  name: string;
  scope: McpScope;
  kind: McpKind;
  command?: string | null;
  args: string[];
  url?: string | null;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
};

/** Values are sent only when typed. Omitted `env`/`headers` keep the stored ones. */
export type McpServerInput = {
  name: string;
  kind: McpKind;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

const DEMO = !isTauri();

const DEMO_SERVERS: McpServer[] = [
  {
    name: "github",
    scope: "user",
    kind: "http",
    url: "https://example.com/mcp/github",
    args: [],
    envKeys: [],
    headerKeys: ["Authorization"],
    enabled: true,
  },
  {
    name: "postgres",
    scope: "project",
    kind: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    envKeys: ["DATABASE_URL"],
    headerKeys: [],
    enabled: true,
  },
];

let demoServers: McpServer[] = DEMO_SERVERS.map((s) => ({ ...s, args: [...s.args], envKeys: [...s.envKeys], headerKeys: [...s.headerKeys] }));

function demoList(cwd?: string): McpServer[] {
  return demoServers.filter((s) => s.scope === "user" || (cwd && s.scope === "project"));
}

function demoFind(scope: McpScope, name: string): McpServer {
  const found = demoServers.find((s) => s.scope === scope && s.name === name);
  if (!found) throw new Error("Сервер не найден");
  return found;
}

function demoSave(scope: McpScope, server: McpServerInput, original?: string): void {
  const source = original ? demoFind(scope, original) : undefined;
  const clash = demoServers.find((s) => s.scope === scope && s.name === server.name);
  if (clash && clash !== source) throw new Error("Сервер с таким именем уже есть");
  const next: McpServer = {
    name: server.name,
    scope,
    kind: server.kind,
    command: server.kind === "stdio" ? server.command ?? "" : null,
    args: server.kind === "stdio" ? server.args ?? [] : [],
    url: server.kind === "stdio" ? null : server.url ?? "",
    envKeys: server.kind === "stdio" ? (server.env ? Object.keys(server.env) : source?.envKeys ?? []) : [],
    headerKeys: server.kind === "stdio" ? [] : server.headers ? Object.keys(server.headers) : source?.headerKeys ?? [],
    enabled: source?.enabled ?? true,
  };
  demoServers = source ? demoServers.map((s) => (s === source ? next : s)) : [...demoServers, next];
}

// ---------- commands ----------

/** Servers of the user scope, plus the project's ones when `cwd` is given. */
export const listMcp = (cwd?: string) =>
  DEMO ? Promise.resolve(demoList(cwd)) : invoke<McpServer[]>("mcp_list", { cwd: cwd ?? null });

/** Adds a server, or edits `originalName` in `scope` (a changed name renames it). */
export const saveMcp = (cwd: string | undefined, scope: McpScope, server: McpServerInput, originalName?: string) => {
  if (DEMO) {
    try {
      demoSave(scope, server, originalName);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return invoke<void>("mcp_save", { cwd: cwd ?? null, scope, server, originalName: originalName ?? null });
};

export const removeMcp = (cwd: string | undefined, scope: McpScope, name: string) => {
  if (DEMO) {
    try {
      const s = demoFind(scope, name);
      demoServers = demoServers.filter((x) => x !== s);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return invoke<void>("mcp_remove", { cwd: cwd ?? null, scope, name });
};

export const setMcpEnabled = (cwd: string | undefined, scope: McpScope, name: string, enabled: boolean) => {
  if (DEMO) {
    try {
      demoFind(scope, name).enabled = enabled;
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return invoke<void>("mcp_set_enabled", { cwd: cwd ?? null, scope, name, enabled });
};

// ---------- command line helpers ----------

/** Splits "-y \"two words\" 'x y'" into arguments; plain spaces separate, quotes group. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Inverse of splitArgs, for showing stored arguments in the editor. */
export function joinArgs(args: string[]): string {
  return args
    .map((a) => (a === "" || /\s/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a))
    .join(" ");
}
