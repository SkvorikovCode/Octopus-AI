import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("../settings", () => ({
  getSettings: vi.fn(() => ({ notifications: true })),
}));

import { invoke } from "@tauri-apps/api/core";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { getSettings } from "../settings";
import { notifySession, settleNotices, shouldNotify, staleNotices, type NoticeKind } from "../notify";
import type { Status } from "../session";

const cards = (list: [string, NoticeKind][]) => new Map(list);
const statuses = (list: [string, Status][]) => new Map(list);

describe("shouldNotify", () => {
  it("stays quiet only while the user looks at this very session", () => {
    expect(shouldNotify(true, true)).toBe(false);
    expect(shouldNotify(true, false)).toBe(true);
    expect(shouldNotify(false, true)).toBe(true);
    expect(shouldNotify(false, false)).toBe(true);
  });
});

describe("staleNotices", () => {
  it("drops the card of the session on screen in a focused window", () => {
    const open = cards([["a", "finished"], ["b", "finished"]]);
    const now = statuses([["a", "idle"], ["b", "idle"]]);
    expect(staleNotices(open, now, "a", true)).toEqual(["a"]);
    expect(staleNotices(open, now, "a", false)).toEqual([]);
  });

  it("drops a waiting card once the question is answered, keeps it while it is open", () => {
    const open = cards([["a", "waiting"]]);
    expect(staleNotices(open, statuses([["a", "waiting"]]), "b", true)).toEqual([]);
    expect(staleNotices(open, statuses([["a", "working"]]), "b", true)).toEqual(["a"]);
    expect(staleNotices(open, statuses([["a", "idle"]]), undefined, false)).toEqual(["a"]);
  });

  it("keeps a finished card while its session idles elsewhere", () => {
    expect(staleNotices(cards([["a", "finished"]]), statuses([["a", "idle"]]), "b", true)).toEqual([]);
  });

  it("drops the card of a session no longer open in the app", () => {
    expect(staleNotices(cards([["a", "finished"]]), statuses([]), undefined, false)).toEqual(["a"]);
  });
});

describe("notifySession", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(sendNotification).mockReset();
    vi.mocked(getSettings).mockReturnValue({ notifications: true } as never);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("sends a native card for another session and closes it once that session is on screen", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await notifySession("a", "finished", "Done", "All good", false);
    expect(invoke).toHaveBeenCalledWith("app_notify", expect.objectContaining({ sessionId: "a", title: "Done", body: "All good" }));
    expect(sendNotification).not.toHaveBeenCalled();

    settleNotices(statuses([["a", "idle"]]), "b");
    expect(invoke).not.toHaveBeenCalledWith("app_notify_close", expect.anything());
    settleNotices(statuses([["a", "idle"]]), "a");
    expect(invoke).toHaveBeenCalledWith("app_notify_close", { sessionId: "a" });
  });

  it("stays quiet for the session on screen in a focused window, and with notifications off", async () => {
    await notifySession("a", "finished", "Done", "", true);
    vi.mocked(getSettings).mockReturnValue({ notifications: false } as never);
    await notifySession("a", "finished", "Done", "", false);
    expect(invoke).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("falls back to the plugin where the native side has no notifications (not Linux)", async () => {
    vi.mocked(invoke).mockRejectedValue("Linux-only");
    await notifySession("a", "waiting", "Needs you", "x".repeat(200), false);
    expect(sendNotification).toHaveBeenCalledWith({ title: "Needs you", body: "x".repeat(140) + "…" });
  });
});
