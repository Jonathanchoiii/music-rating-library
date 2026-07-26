import React from "react";
import { createRoot } from "react-dom/client";
import {
  bootstrapSharedLocalState,
  startSharedLocalStateSync,
} from "./lib/sharedLocalState.js";
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

async function startApplication() {
  await bootstrapSharedLocalState();
  const { App } = await import("./App.jsx");
  createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  startSharedLocalStateSync();
}

startApplication();
