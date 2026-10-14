// Minimum window size: the layout (sidebar, chat, composer controls) holds down to it.

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

/** At 100% scale; keep in sync with minWidth / minHeight in src-tauri/tauri.conf.json. */
export const MIN_WIDTH = 980;
export const MIN_HEIGHT = 640;

/**
 * The interface scale zooms the whole page, so the minimum grows with it. A window smaller than
 * the new minimum is enlarged to it.
 */
export async function applyMinWindowSize(scale: number) {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  const min = new LogicalSize(Math.round(MIN_WIDTH * scale), Math.round(MIN_HEIGHT * scale));
  await win.setMinSize(min);
  const cur = (await win.innerSize()).toLogical(await win.scaleFactor());
  if (cur.width < min.width || cur.height < min.height) {
    await win.setSize(new LogicalSize(Math.max(cur.width, min.width), Math.max(cur.height, min.height)));
  }
}
