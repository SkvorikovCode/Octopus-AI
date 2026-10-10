// System notifications for moments that need the user while the window is in
// the background: the agent finished, or it is waiting for a decision.

import { isTauri } from "@tauri-apps/api/core";
import { getSettings } from "./settings";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

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

export async function notifyIfAway(title: string, body: string) {
  if (document.hasFocus() || !getSettings().notifications) return;
  if (!(await canNotify())) return;
  try {
    sendNotification({ title, body: body.length > 140 ? body.slice(0, 140) + "…" : body });
  } catch {
    /* notifications are best-effort */
  }
}
