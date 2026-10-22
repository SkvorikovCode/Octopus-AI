// The few places the interface differs between macOS and other desktops
// (Linux, Windows): the menu bar, room for the traffic lights, shortcut labels.

/** macOS, where the webview reports a Mac platform. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** A shortcut with the primary modifier as people read it here: "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function modKey(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
}

/** Marks <html> with the platform, so styles can keep macOS-only room (traffic lights) to macOS. */
export function markPlatform(): void {
  if (typeof document !== "undefined") document.documentElement.dataset.platform = IS_MAC ? "mac" : "other";
}
