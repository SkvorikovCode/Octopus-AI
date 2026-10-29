// System notifications for moments that need the user: the agent finished, or
// it is waiting for a decision. They come while the window is in the background
// or shows another session. On Linux the native side shows them with a click
// that opens the session, one card per session (notify.rs); elsewhere the
// notification plugin does, without that click.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { getSettings } from "./settings";
import { t } from "./i18n";
import type { Status } from "./session";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

export type NoticeKind = "waiting" | "finished";

/** Native cards on screen, by session. The plugin's cannot be closed, so they are not here. */
const open = new Map<string, NoticeKind>();

let allowed: boolean | undefined;

async function canNotify(): Promise<boolean> {
  if (!isTauri()) return false;
  if (allowed !== undefined) return allowed;
  try {
    allowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch {
    allowed = false;
  }
  return allowed;
}

/** Quiet only while the user looks at this very session. */
export function shouldNotify(focused: boolean, viewing: boolean): boolean {
  return !(focused && viewing);
}

export async function notifySession(sessionId: string | undefined, kind: NoticeKind, title: string, body: string, viewing: boolean) {
  if (!getSettings().notifications || !shouldNotify(document.hasFocus(), viewing)) return;
  if (!(await canNotify())) return;
  const text = body.length > 140 ? body.slice(0, 140) + "…" : body;
  if (sessionId) {
    try {
      await invoke("app_notify", { sessionId, title, body: text, openLabel: t("Открыть сессию") });
      open.set(sessionId, kind);
      return;
    } catch {
      /* not Linux: the plugin below */
    }
  }
  try {
    sendNotification({ title, body: text });
  } catch {
    /* notifications are best-effort */
  }
}

/**
 * Sessions whose card no longer needs the user: on screen in a focused window,
 * no longer open in the app, or past the question the card asked.
 */
export function staleNotices(
  cards: ReadonlyMap<string, NoticeKind>,
  statuses: ReadonlyMap<string, Status>,
  viewingId: string | undefined,
  focused: boolean,
): string[] {
  return [...cards]
    .filter(([id, kind]) => (focused && id === viewingId) || !statuses.has(id) || (kind === "waiting" && statuses.get(id) !== "waiting"))
    .map(([id]) => id);
}

export function settleNotices(statuses: ReadonlyMap<string, Status>, viewingId: string | undefined) {
  for (const id of staleNotices(open, statuses, viewingId, document.hasFocus())) {
    open.delete(id);
    invoke("app_notify_close", { sessionId: id }).catch(() => {});
  }
}
