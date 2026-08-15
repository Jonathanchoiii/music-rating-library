import React from "react";
import { createRoot } from "react-dom/client";
import {
  bootstrapSharedLocalState,
  canWriteSharedState,
  startSharedLocalStateSync,
} from "./lib/sharedLocalState.js";
import { isReadOnlyMode } from "./lib/readonlyMode.js";
import { bootstrapRemotePreview } from "./lib/remotePreview.js";
import "./styles.css";

const isDesktopShell =
  navigator.userAgent.includes("Electron/") ||
  new URLSearchParams(window.location.search).get("desktop") === "1";

if (isDesktopShell) {
  document.documentElement.classList.add("is-desktop-shell");
  const dragRegion = document.createElement("div");
  dragRegion.className = "desktop-window-drag-region";
  dragRegion.setAttribute("aria-hidden", "true");
  document.body.prepend(dragRegion);
}

const root = createRoot(document.getElementById("root"));

async function renderApp() {
  const { App } = await import("./App.jsx");
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  if (canWriteSharedState()) startSharedLocalStateSync();
}

async function startApplication() {
  if (isReadOnlyMode()) {
    document.documentElement.classList.add("is-readonly-preview");
  }
  if (canWriteSharedState()) {
    await bootstrapSharedLocalState();
    await renderApp();
    return;
  }
  const preview = await bootstrapRemotePreview();
  if (preview.status !== "ready") {
    const { PreviewGate } = await import("./components/PreviewGate.jsx");
    root.render(
      <React.StrictMode>
        <PreviewGate
          status={preview.status}
          onReady={() => {
            startApplication();
          }}
        />
      </React.StrictMode>,
    );
    return;
  }
  await renderApp();
}

startApplication();
