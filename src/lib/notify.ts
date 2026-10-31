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

/** Cards being shown right now. A settle that lands mid-show closes once the card is up. */
const showing = new Map<string, { closed: boolean }>();

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
  if (sessionId && (await showCard(sessionId, kind, title, text))) return;
  try {
    sendNotification({ title, body: text });
  } catch {
    /* notifications are best-effort */
  }
}

/**
 * Shows the session's native card. The card counts as open before the round trip,
 * so a settle running meanwhile still sees it, and its close waits for the card to
 * exist. False where this platform has no such card.
 */
async function showCard(sessionId: string, kind: NoticeKind, title: string, body: string): Promise<boolean> {
  const card = { closed: false };
  open.set(sessionId, kind);
  showing.set(sessionId, card);
  try {
    await invoke("app_notify", { sessionId, title, body, openLabel: t("Открыть сессию") });
  } catch {
    open.delete(sessionId);
    showing.delete(sessionId);
    return false;
  }
  showing.delete(sessionId);
  if (card.closed) closeCard(sessionId);
  return true;
}

/** Takes the session's card off the screen, waiting for a show still in flight. */
function closeCard(sessionId: string) {
  open.delete(sessionId);
  const pending = showing.get(sessionId);
  if (pending) {
    pending.closed = true;
    return;
  }
  invoke("app_notify_close", { sessionId }).catch(() => {});
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
  for (const id of staleNotices(open, statuses, viewingId, document.hasFocus())) closeCard(id);
}
