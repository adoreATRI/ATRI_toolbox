import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createShutdownCoordinator } = require("../desktop/shutdown.cjs");
const { createUpdateController } = require("../desktop/updater.cjs");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
