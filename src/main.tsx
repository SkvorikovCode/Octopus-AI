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

markPlatform();
applySettings();

// An outside palette, where there is one, paints before the first frame.
followPalette(setPalette).finally(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  ),
);
