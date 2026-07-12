import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  bindHistoryShortcuts,
  createHistoryController,
  isUndoInput,
} = require("../desktop/history.cjs");
const { createShutdownCoordinator } = require("../desktop/shutdown.cjs");
const { createDiagramFileController } = require("../desktop/diagram-file.cjs");
const { createLineFilter } = require("../desktop/log-filter.cjs");
const { createSettingsStore } = require("../desktop/settings-store.cjs");
const { createUpdateController } = require("../desktop/updater.cjs");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createTemporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atri-toolbox-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function createUpdaterHarness(overrides = {}) {
  class FakeUpdater extends EventEmitter {
    constructor() {
      super();
      this.checkCount = 0;
      this.downloadCount = 0;
      this.quitArgs = null;
    }

    checkForUpdates() {
      this.checkCount += 1;
      return overrides.checkForUpdates?.() || Promise.resolve({});
    }

    downloadUpdate() {
      this.downloadCount += 1;
      return overrides.downloadUpdate?.() || Promise.resolve([]);
    }

    quitAndInstall(...args) {
      this.quitArgs = args;
    }
  }

  const updater = new FakeUpdater();
  const dialogs = [];
  const dialogResponses = [...(overrides.dialogResponses || [])];
  const progress = [];
  const window = {
    isDestroyed: () => false,
    setProgressBar: (value) => progress.push(value),
  };
  const controller = createUpdateController({
    app: {
      isPackaged: overrides.isPackaged ?? true,
      getVersion: () => "0.2.0",
    },
    updater,
    getWindow: () => window,
    showDialog: async (options) => {
      dialogs.push(options);
      return dialogResponses.shift() || { response: 1 };
    },
    logger: { warn() {} },
    setTimer: () => ({ unref() {} }),
    setIntervalTimer: () => ({ unref() {} }),
  });

  return { controller, dialogs, progress, updater };
}

function createHistoryHarness(rendererHandled, overrides = {}) {
  const calls = { execute: [], nativeUndo: 0, warnings: [] };
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: async (expression, userGesture) => {
      calls.execute.push({ expression, userGesture });

      if (overrides.error) {
        throw overrides.error;
      }

      return rendererHandled;
    },
    undo: () => {
      calls.nativeUndo += 1;
    },
  };
  const controller = createHistoryController({
    getWindow: () => ({
      isDestroyed: () => false,
      webContents,
    }),
    logger: { warn: (...args) => calls.warnings.push(args) },
  });

  return { calls, controller };
}

test("desktop undo lets the renderer restore an AI snapshot", async () => {
  const harness = createHistoryHarness(true);

  assert.equal(await harness.controller.undo(), "renderer");
  assert.equal(harness.calls.execute.length, 1);
  assert.equal(harness.calls.execute[0].userGesture, true);
  assert.equal(harness.calls.nativeUndo, 0);
});

test("desktop undo falls back to the focused native editor", async () => {
  const harness = createHistoryHarness(false);

  assert.equal(await harness.controller.undo(), "native");
  assert.equal(harness.calls.nativeUndo, 1);
});

test("desktop undo still falls back when the renderer bridge fails", async () => {
  const harness = createHistoryHarness(false, { error: new Error("renderer unavailable") });

  assert.equal(await harness.controller.undo(), "native");
  assert.equal(harness.calls.nativeUndo, 1);
  assert.equal(harness.calls.warnings.length, 1);
});

test("desktop shortcut bridge captures Ctrl+Z from child frames", () => {
  const webContents = new EventEmitter();
  let undoCount = 0;
  let preventedCount = 0;
  const unbind = bindHistoryShortcuts(webContents, {
    undo: () => {
      undoCount += 1;
    },
  });

  webContents.emit("before-input-event", {
    preventDefault: () => {
      preventedCount += 1;
    },
  }, {
    type: "keyDown",
    key: "z",
    control: true,
    meta: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
  });

  assert.equal(undoCount, 1);
  assert.equal(preventedCount, 1);
  unbind();
  assert.equal(webContents.listenerCount("before-input-event"), 0);
});

test("desktop shortcut bridge ignores redo and repeated input", () => {
  assert.equal(isUndoInput({ type: "keyDown", key: "z", control: true, shift: true }), false);
  assert.equal(isUndoInput({ type: "keyDown", key: "z", control: true, isAutoRepeat: true }), false);
  assert.equal(isUndoInput({ type: "keyUp", key: "z", control: true }), false);
  assert.equal(isUndoInput({ type: "keyDown", key: "z", meta: true }), true);
});

test("development launcher hides only known Chromium startup diagnostics", () => {
  let output = "";
  const filter = createLineFilter((text) => {
    output += text;
  });

  filter.push("MESA-LOADER: failed to open dri: /usr/lib/x86_64-linux-gnu/gbm/dri_gbm.so:");
  filter.push(" Permission denied\nimportant Electron failure\n");
  filter.push("[10:ERROR:ui/gfx/x/atom_cache.cc:234] Add application/vnd.portal.files to kAtomsToCache\n");
  filter.flush();

  assert.equal(output, "important Electron failure\n");
});

test("an imported draw.io file remains active and receives later saves", async (context) => {
  const directory = await createTemporaryDirectory(context);
  const diagramPath = path.join(directory, "story.drawio");
  const statePath = path.join(directory, "active-diagram.json");
  const originalXml = '<mxfile><diagram><mxGraphModel><root /></mxGraphModel></diagram></mxfile>';
  const changedXml = '<mxfile><diagram><mxGraphModel><root><mxCell id="changed" /></root></mxGraphModel></diagram></mxfile>';
  await fs.writeFile(diagramPath, originalXml);

  const controller = createDiagramFileController({
    statePath,
    showOpenDialog: async () => ({ canceled: false, filePaths: [diagramPath] }),
  });
  const opened = await controller.openDiagram();
  assert.equal(opened.writable, true);
  assert.equal(opened.fileName, "story.drawio");

  await controller.saveActiveDiagram({ xml: changedXml });
  assert.equal(await fs.readFile(diagramPath, "utf8"), changedXml);

  const restartedController = createDiagramFileController({
    statePath,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  });
  const restored = await restartedController.restoreActiveDiagram();
  assert.equal(restored.content, changedXml);
  assert.equal(restored.fileName, "story.drawio");
});

test("importing JSON clears the previous direct-write file association", async (context) => {
  const directory = await createTemporaryDirectory(context);
  const diagramPath = path.join(directory, "story.drawio");
  const jsonPath = path.join(directory, "story.json");
  const statePath = path.join(directory, "active-diagram.json");
  const originalXml = '<mxfile><diagram><mxGraphModel><root /></mxGraphModel></diagram></mxfile>';
  await fs.writeFile(diagramPath, originalXml);
  await fs.writeFile(jsonPath, JSON.stringify({ title: "JSON 导图", children: [] }));

  const selections = [diagramPath, jsonPath];
  const controller = createDiagramFileController({
    statePath,
    showOpenDialog: async () => ({ canceled: false, filePaths: [selections.shift()] }),
  });
  await controller.openDiagram();
  const openedJson = await controller.openDiagram();
  assert.equal(openedJson.kind, "json");

  const saveResult = await controller.saveActiveDiagram({ xml: originalXml });
  assert.deepEqual(saveResult, { saved: false, reason: "no_active_file" });
});

test("model settings survive restarts with an encrypted API key", async (context) => {
  const directory = await createTemporaryDirectory(context);
  const filePath = path.join(directory, "model-settings.json");
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^protected:/, ""),
  };
  const settings = {
    endpoint: "https://model.example/v1/chat/completions",
    model: "example-model",
    apiKey: "secret-api-key",
    temperature: 0.4,
  };
  const store = createSettingsStore({ filePath, safeStorage });
  await store.save(settings);

  const storedText = await fs.readFile(filePath, "utf8");
  assert.equal(storedText.includes(settings.apiKey), false);
  assert.match(storedText, /electron-safe-storage/);

  const restartedStore = createSettingsStore({ filePath, safeStorage });
  assert.deepEqual(await restartedStore.load(), settings);
});

test("shutdown cleanup runs once and the second quit is allowed", async () => {
  let closeCount = 0;
  let quitCount = 0;
  let preventedCount = 0;
  const coordinator = createShutdownCoordinator({
    close: async () => {
      closeCount += 1;
    },
    quit: () => {
      quitCount += 1;
    },
    forceExit: () => {},
    cleanupTimeoutMs: 50,
    forceExitTimeoutMs: 50,
  });
  const event = { preventDefault: () => { preventedCount += 1; } };

  assert.equal(coordinator.handleBeforeQuit(event), true);
  assert.equal(coordinator.handleBeforeQuit(event), true);
  assert.equal(coordinator.phase, "closing");
  await coordinator.cleanupTask;

  assert.equal(closeCount, 1);
  assert.equal(quitCount, 1);
  assert.equal(preventedCount, 2);
  assert.equal(coordinator.phase, "ready");
  assert.equal(coordinator.handleBeforeQuit(event), false);
  assert.equal(preventedCount, 2);
  coordinator.handleQuit();
});

test("shutdown continues after cleanup reaches its deadline", async () => {
  const errors = [];
  let quitCount = 0;
  const coordinator = createShutdownCoordinator({
    close: () => new Promise(() => {}),
    quit: () => {
      quitCount += 1;
    },
    forceExit: () => {},
    onError: (error) => errors.push(error),
    cleanupTimeoutMs: 10,
    forceExitTimeoutMs: 50,
  });

  coordinator.handleBeforeQuit({ preventDefault() {} });
  await coordinator.cleanupTask;

  assert.equal(quitCount, 1);
  assert.equal(coordinator.phase, "ready");
  assert.match(errors[0].message, /timed out/);
  coordinator.handleQuit();
});

test("shutdown force-exits when the final quit does not complete", async () => {
  let forceExitCount = 0;
  const coordinator = createShutdownCoordinator({
    close: () => Promise.resolve(),
    quit: () => {},
    forceExit: () => {
      forceExitCount += 1;
    },
    cleanupTimeoutMs: 20,
    forceExitTimeoutMs: 5,
  });

  coordinator.handleBeforeQuit({ preventDefault() {} });
  await coordinator.cleanupTask;
  await wait(10);

  assert.equal(forceExitCount, 1);
  coordinator.handleQuit();
});

test("updater downloads an available release and installs on confirmation", async () => {
  const harness = createUpdaterHarness({
    dialogResponses: [{ response: 0 }, { response: 0 }],
  });
  harness.controller.setup();

  assert.equal(harness.updater.autoDownload, false);
  assert.equal(harness.updater.autoInstallOnAppQuit, true);

  await harness.controller.check(true);
  harness.updater.emit("update-available", { version: "0.3.0" });
  await wait(0);

  assert.equal(harness.updater.downloadCount, 1);
  assert.equal(harness.dialogs[0].title, "发现新版本");
  assert.equal(harness.progress[0], 2);

  harness.updater.emit("download-progress", { percent: 42 });
  harness.updater.emit("update-downloaded", { version: "0.3.0" });
  await wait(0);

  assert.equal(harness.progress.includes(0.42), true);
  assert.equal(harness.progress.at(-1), -1);
  assert.deepEqual(harness.updater.quitArgs, [false, true]);
});

test("manual update check reports when the current version is latest", async () => {
  const harness = createUpdaterHarness();
  harness.controller.setup();

  const check = harness.controller.check(true);
  harness.updater.emit("update-not-available", { version: "0.2.0" });
  await check;
  await wait(0);

  assert.equal(harness.dialogs.length, 1);
  assert.equal(harness.dialogs[0].message, "当前已是最新版本");
});

test("development builds do not contact the update provider", async () => {
  const harness = createUpdaterHarness({ isPackaged: false });
  harness.controller.setup();
  await harness.controller.check(true);

  assert.equal(harness.updater.checkCount, 0);
  assert.equal(harness.dialogs[0].message, "开发模式不检查更新");
});
