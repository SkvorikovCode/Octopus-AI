// A session asked for from outside the window (`octopus-ai --session <id>`): what to do now.

export type AskedSessionStep<R, M> =
  /** A running agent has it, in any project: show that agent. */
  | { kind: "runtime"; runtime: R }
  /** This project's list has it: open it. */
  | { kind: "open"; meta: M }
  /** Neither: say so. */
  | { kind: "missing" }
  /** The project's list is not here yet (just started, or the project just changed). */
  | { kind: "wait" };

/**
 * `list` is the state of the project's session list: "none" without a project,
 * "loading" until the list for the current project arrives, then "loaded".
 */
export function askedSessionStep<R, M extends { id: string }>(
  id: string,
  running: { sessionId?: string; runtime: R }[],
  sessions: M[],
  list: "none" | "loading" | "loaded",
): AskedSessionStep<R, M> {
  const owner = running.find((r) => r.sessionId === id);
  if (owner) return { kind: "runtime", runtime: owner.runtime };
  const meta = list === "loaded" ? sessions.find((m) => m.id === id) : undefined;
  if (meta) return { kind: "open", meta };
  return list === "loading" ? { kind: "wait" } : { kind: "missing" };
}
