import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, net, shell } from "electron";
import { startRecordShelfServer } from "./server.mjs";

let mainWindow = null;
let localServer = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const BRAND_ICON_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "assets",
  "RecordShelf.png",
);

function createWindow(origin) {
  mainWindow = new BrowserWindow({
    title: "RecordShelf",
    icon: BRAND_ICON_PATH,
    width: 1360,
    height: 900,
    minWidth: 390,
    minHeight: 700,
    backgroundColor: "#fbfaf7",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`${origin}/?desktop=1&view=grid`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function launch() {
  try {
    const requestedPort = Number.parseInt(
      process.env.RECORDSHELF_PORT ?? "4173",
      10,
    );
    const port =
      Number.isInteger(requestedPort) && requestedPort > 0
        ? requestedPort
        : 4173;
    localServer = await startRecordShelfServer(port, {
      // Chromium's network stack follows the same proxy/TUN route as the UI.
      // Plain Node/FFmpeg downloads do not, which made Apple HLS fail on Macs
      // using a virtual-IP proxy even though the artwork was visible in-browser.
      fetchImpl: (input, init) => net.fetch(input, init),
    });
    createWindow(localServer.origin);
  } catch (error) {
    dialog.showErrorBox(
      "RecordShelf 无法启动",
      `${error?.message ?? error}\n\n请确认本地服务端口未被其他应用占用。`,
    );
    app.quit();
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);

  app.whenReady().then(launch);

  app.on("activate", () => {
    if (!mainWindow && localServer) {
      createWindow(localServer.origin);
      return;
    }
    focusMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    localServer?.close();
  });
}
