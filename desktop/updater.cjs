function createUpdateController(options) {
  const app = options.app;
  const updater = options.updater;
  const showDialog = options.showDialog;
  const getWindow = options.getWindow || (() => null);
  const logger = options.logger || console;
  const setTimer = options.setTimer || setTimeout;
  const setIntervalTimer = options.setIntervalTimer || setInterval;
  let initialized = false;
  let updateCheckPromise = null;
  let manualUpdateCheck = false;
  let downloadInProgress = false;
  let promptVisible = false;

  const setProgress = (value) => {
    const window = getWindow();

    if (window && !window.isDestroyed()) {
      window.setProgressBar(value);
    }
  };

  const notifyError = (error) => {
    const message = error instanceof Error ? error.message : String(error || "未知错误");
    showDialog({
      type: "error",
      title: "更新失败",
      message: "无法完成版本更新",
      detail: message.slice(0, 500),
      buttons: ["确定"],
      noLink: true,
    }).catch((dialogError) => logger.warn("Failed to show update error:", dialogError));
  };

  const handleUpdateAvailable = async (info) => {
    manualUpdateCheck = false;

    if (promptVisible || downloadInProgress) {
      return;
    }

    promptVisible = true;

    try {
      const result = await showDialog({
        type: "info",
        title: "发现新版本",
        message: `ATRI Toolbox ${info.version} 已发布`,
        detail: "是否现在下载更新？下载期间可以继续使用应用。",
        buttons: ["下载更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });

      if (result.response === 0) {
        downloadInProgress = true;
        setProgress(2);

        try {
          await updater.downloadUpdate();
        } catch (error) {
          if (downloadInProgress) {
            downloadInProgress = false;
            setProgress(-1);
            notifyError(error);
          }
        }
      }
    } catch (error) {
      logger.warn("Failed to show update prompt:", error);
    } finally {
      promptVisible = false;
    }
  };

  const handleUpdateDownloaded = async (info) => {
    downloadInProgress = false;
    setProgress(-1);

    try {
      const result = await showDialog({
        type: "info",
        title: "更新已下载",
        message: `ATRI Toolbox ${info.version} 已准备完成`,
        detail: "可以立即重启安装，也可以在本次退出时自动安装。",
        buttons: ["立即重启安装", "退出时安装"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });

      if (result.response === 0) {
        updater.quitAndInstall(false, true);
      }
    } catch (error) {
      logger.warn("Failed to show downloaded update prompt:", error);
    }
  };

  const check = (isManual = false) => {
    if (!app.isPackaged) {
      if (isManual) {
        showDialog({
          type: "info",
          title: "检查更新",
          message: "开发模式不检查更新",
          detail: `当前版本：${app.getVersion()}`,
          buttons: ["确定"],
          noLink: true,
        }).catch((error) => logger.warn("Failed to show update status:", error));
      }

      return Promise.resolve(null);
    }

    manualUpdateCheck ||= isManual;

    if (updateCheckPromise || downloadInProgress) {
      return updateCheckPromise || Promise.resolve(null);
    }

    updateCheckPromise = updater.checkForUpdates()
      .catch((error) => {
        if (manualUpdateCheck) {
          notifyError(error);
        }

        manualUpdateCheck = false;
        return null;
      })
      .finally(() => {
        updateCheckPromise = null;
      });

    return updateCheckPromise;
  };

  const setup = () => {
    if (initialized || !app.isPackaged) {
      return;
    }

    initialized = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.autoRunAppAfterInstall = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;

    updater.on("update-available", (info) => {
      void handleUpdateAvailable(info);
    });

    updater.on("update-not-available", () => {
      if (manualUpdateCheck) {
        showDialog({
          type: "info",
          title: "检查更新",
          message: "当前已是最新版本",
          detail: `当前版本：${app.getVersion()}`,
          buttons: ["确定"],
          noLink: true,
        }).catch((error) => logger.warn("Failed to show update status:", error));
      }

      manualUpdateCheck = false;
    });

    updater.on("download-progress", (progress) => {
      const value = Number(progress?.percent) / 100;
      setProgress(Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 2);
    });

    updater.on("update-downloaded", (info) => {
      void handleUpdateDownloaded(info);
    });

    updater.on("error", (error) => {
      const shouldNotify = manualUpdateCheck || downloadInProgress;
      manualUpdateCheck = false;
      downloadInProgress = false;
      setProgress(-1);

      if (shouldNotify) {
        notifyError(error);
      } else {
        logger.warn("Automatic update check failed:", error);
      }
    });

    const initialCheckTimer = setTimer(() => check(false), 4000);
    const periodicCheckTimer = setIntervalTimer(() => check(false), 6 * 60 * 60 * 1000);
    initialCheckTimer.unref?.();
    periodicCheckTimer.unref?.();
  };

  return {
    check,
    setup,
  };
}

module.exports = {
  createUpdateController,
};
