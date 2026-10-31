import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "@fontsource-variable/onest";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/doto";
import "./styles.css";
import { applySettings, setPalette } from "./lib/settings";
import { followPalette } from "./lib/palette";
import { markPlatform } from "./lib/platform";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

markPlatform();
applySettings();

// The window is created hidden, with the dark native background of
// tauri.conf.json. An outside palette is applied before the first render, and
// the native background follows it, so a light desktop palette never flashes
// dark. Without the palette file, the stored theme decides.
const win = getCurrentWebviewWindow();
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

/** The window behind the page matches the background the page is about to paint. */
function paintNativeBackground() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (bg) void win.setBackgroundColor(bg).catch(() => {});
}

paintNativeBackground();

// Reading the palette is a local file, but a read that never settles must not
// leave the window hidden: show it either way, a second from now at the latest.
const deadline = new Promise<void>((resolve) => setTimeout(resolve, 1000));
const palette = followPalette((p) => {
  setPalette(p);
  paintNativeBackground();
});

void Promise.race([palette, deadline]).finally(() => {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  win.show().catch(() => {});
});
