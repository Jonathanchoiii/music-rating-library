import { app, BrowserWindow, dialog, shell } from "electron";
import { startRecordShelfServer } from "./server.mjs";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow = null;
let localServer = null;

if (!hasSingleInstanceLock) {
  app.quit();
}

function createWindow(origin) {
  mainWindow = new BrowserWindow({
    title: "RecordShelf",
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
    localServer = await startRecordShelfServer(port);
    createWindow(localServer.origin);
  } catch (error) {
    dialog.showErrorBox(
      "RecordShelf 无法启动",
      `${error?.message ?? error}\n\n请确认本地服务端口未被其他应用占用。`,
    );
    app.quit();
  }
}

app.whenReady().then(launch);

app.on("second-instance", () => {
  if (!mainWindow) {
    if (localServer) createWindow(localServer.origin);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("activate", () => {
  if (!mainWindow && localServer) createWindow(localServer.origin);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  localServer?.close();
});
