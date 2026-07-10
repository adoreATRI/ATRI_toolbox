const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const path = require("node:path");

const { createShutdownCoordinator } = require("./shutdown.cjs");
const { createUpdateController } = require("./updater.cjs");

let mainWindow = null;
let serverRuntime = null;
let startServer = null;
let cleanupPromise = null;
const updateController = createUpdateController({
  app,
  updater: autoUpdater,
  showDialog: showAppDialog,
  getWindow: () => mainWindow,
});

const defaultWindowState = {
  width: 1320,
  height: 860,
  minWidth: 1080,
  minHeight: 720,
};

async function ensureLocalService() {
  if (!startServer) {
    ({ startServer } = await import("../server.js"));
  }

  if (!serverRuntime) {
    const port = Number.parseInt(process.env.PORT || "5174", 10);
    serverRuntime = await startServer(port, { silent: true });
  }

  return serverRuntime;
}

async function createMainWindow() {
  const runtime = await ensureLocalService();
  const windowState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    minWidth: defaultWindowState.minWidth,
    minHeight: defaultWindowState.minHeight,
    title: "ATRI Toolbox",
    backgroundColor: "#f5f3ef",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.on("close", () => {
    saveWindowState(mainWindow);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const localOrigin = new URL(`http://127.0.0.1:${runtime.port}`).origin;
    const targetOrigin = getUrlOrigin(url);

    if (targetOrigin !== localOrigin) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });

  await mainWindow.loadURL(`http://127.0.0.1:${runtime.port}`);
}

function getWindowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(getWindowStatePath(), "utf8"));
    const width = sanitizeDimension(state.width, defaultWindowState.width, defaultWindowState.minWidth);
    const height = sanitizeDimension(state.height, defaultWindowState.height, defaultWindowState.minHeight);

    return {
      width,
      height,
      isMaximized: Boolean(state.isMaximized),
    };
  } catch {
    return {
      width: defaultWindowState.width,
      height: defaultWindowState.height,
      isMaximized: false,
    };
  }
}

function saveWindowState(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  const state = {
    width: sanitizeDimension(bounds.width, defaultWindowState.width, defaultWindowState.minWidth),
    height: sanitizeDimension(bounds.height, defaultWindowState.height, defaultWindowState.minHeight),
    isMaximized: window.isMaximized(),
  };

  try {
    fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn("Failed to save window state:", error);
  }
}

function sanitizeDimension(value, fallback, minimum) {
  const number = Number.parseInt(value, 10);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(Math.max(number, minimum), 3200);
}

function getUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function openExternalUrl(url) {
  try {
    const target = new URL(url);

    if (target.protocol === "http:" || target.protocol === "https:") {
      shell.openExternal(target.href).catch((error) => {
        console.warn("Failed to open external URL:", error);
      });
    }
  } catch {
    // Ignore malformed or unsafe external URLs.
  }
}

function createApplicationMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { role: "reload", label: "重新载入" },
        { type: "separator" },
        { role: "quit", label: process.platform === "win32" ? "退出" : "退出 ATRI Toolbox" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "检查更新",
          click: () => updateController.check(true),
        },
        {
          label: `当前版本 ${app.getVersion()}`,
          enabled: false,
        },
        { type: "separator" },
        {
          label: "项目主页",
          click: () => openExternalUrl("https://github.com/adoreATRI/ATRI_toolbox"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAppDialog(options) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options);
  }

  return dialog.showMessageBox(options);
}

app.whenReady().then(async () => {
  createApplicationMenu();
  await createMainWindow();
  updateController.setup();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

const shutdownCoordinator = createShutdownCoordinator({
  beforeClose: () => {
    saveWindowState(mainWindow);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  },
  close: closeLocalService,
  quit: () => app.quit(),
  forceExit: () => app.exit(0),
  onError: (error) => console.warn("Application shutdown cleanup failed:", error),
});

app.on("before-quit", (event) => shutdownCoordinator.handleBeforeQuit(event));
app.on("quit", () => shutdownCoordinator.handleQuit());

function closeLocalService() {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  const runtime = serverRuntime;
  serverRuntime = null;

  cleanupPromise = runtime
    ? runtime.close().catch((error) => {
      console.warn("Failed to close local service:", error);
    })
    : Promise.resolve();

  return cleanupPromise;
}
