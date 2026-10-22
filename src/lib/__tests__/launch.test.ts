import { describe, expect, it } from "vitest";
import { askedSessionStep } from "../launch";

const running = [{ sessionId: "live", runtime: "rt-live" }, { sessionId: undefined, runtime: "rt-new" }];
const sessions = [{ id: "old", title: "Old" }];

describe("askedSessionStep", () => {
  it("shows a running agent first, in any project and before the list arrives", () => {
    expect(askedSessionStep("live", running, [], "loading")).toEqual({ kind: "runtime", runtime: "rt-live" });
    expect(askedSessionStep("live", running, [], "none")).toEqual({ kind: "runtime", runtime: "rt-live" });
  });

  it("opens a session from this project's list", () => {
    expect(askedSessionStep("old", running, sessions, "loaded")).toEqual({ kind: "open", meta: sessions[0] });
  });

  it("waits while the current project's list is on its way", () => {
    // The list on hand belongs to the previous project: it must not answer for this one.
    expect(askedSessionStep("old", running, sessions, "loading")).toEqual({ kind: "wait" });
  });

  it("gives up when nothing has it", () => {
    expect(askedSessionStep("gone", running, sessions, "loaded")).toEqual({ kind: "missing" });
    expect(askedSessionStep("gone", running, [], "none")).toEqual({ kind: "missing" });
  });
});
