function createUpdateController(options) {
  const app = options.app;
  const updater = options.updater;
  const showDialog = options.showDialog;
  const getWindow = options.getWindow || (() => null);
  const logger = options.logger || console;
  const setTimer = options.setTimer || setTimeout;
  const setIntervalTimer = options.setIntervalTimer || setInterval;
  const onStateChange = options.onStateChange || (() => {});
  const isUpdateSupported = options.isUpdateSupported ?? true;
  const openDownloadsPage = options.openDownloadsPage || (() => Promise.resolve());
  const isDevelopment = !app.isPackaged;
  const isUnsupported = app.isPackaged && !isUpdateSupported;
  let initialized = false;
  let updateCheckPromise = null;
  let manualUpdateCheck = false;
  let downloadInProgress = false;
  let promptVisible = false;
  let currentState = {
    status: isDevelopment ? "development" : isUnsupported ? "unsupported" : "idle",
    currentVersion: app.getVersion(),
    availableVersion: "",
    percent: 0,
    message: isDevelopment
      ? "开发模式不检查更新。"
      : isUnsupported
        ? "当前安装格式请从发布页下载更新。"
        : "尚未检查更新。",
    canCheck: Boolean(app.isPackaged && isUpdateSupported),
    canOpenDownloads: isUnsupported,
  };

  const publishState = (patch = {}) => {
    currentState = { ...currentState, ...patch };

    try {
      onStateChange({ ...currentState });
    } catch (error) {
      logger.warn("Failed to publish update state:", error);
    }
  };

  const getState = () => ({ ...currentState });

  const setProgress = (value) => {
    const window = getWindow();

    if (window && !window.isDestroyed()) {
      window.setProgressBar(value);
    }
  };

  const notifyError = (error) => {
    const message = error instanceof Error ? error.message : String(error || "未知错误");
    publishState({
      status: "error",
      percent: 0,
      message: `更新失败：${message.slice(0, 160)}`,
      canCheck: true,
    });
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
    publishState({
      status: "available",
      availableVersion: String(info.version || ""),
      percent: 0,
      message: `发现新版本 ${info.version}。`,
      canCheck: false,
    });

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
        publishState({
          status: "downloading",
          percent: 0,
          message: `正在下载 ATRI Toolbox ${info.version}：0%`,
          canCheck: false,
        });

        try {
          await updater.downloadUpdate();
        } catch (error) {
          if (downloadInProgress) {
            downloadInProgress = false;
            setProgress(-1);
            notifyError(error);
          }
        }
      } else {
        publishState({
          status: "available",
          message: `ATRI Toolbox ${info.version} 可下载。`,
          canCheck: true,
        });
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
    publishState({
      status: "downloaded",
      availableVersion: String(info.version || currentState.availableVersion || ""),
      percent: 100,
      message: `ATRI Toolbox ${info.version} 已下载，等待安装。`,
      canCheck: false,
    });

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
        publishState({
          status: "installing",
          message: "正在重启并安装更新。",
          canCheck: false,
        });
        updater.quitAndInstall(false, true);
      }
    } catch (error) {
      logger.warn("Failed to show downloaded update prompt:", error);
    }
  };

  const check = (isManual = false) => {
    if (!app.isPackaged) {
      publishState({
        status: "development",
        message: "开发模式不检查更新。",
        canCheck: false,
      });

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

    if (!isUpdateSupported) {
      publishState({
        status: "unsupported",
        message: "当前安装格式请从发布页下载更新。",
        canCheck: false,
        canOpenDownloads: true,
      });

      if (!isManual) {
        return Promise.resolve(null);
      }

      return showDialog({
        type: "info",
        title: "应用更新",
        message: "当前安装格式不支持应用内安装",
        detail: `当前版本：${app.getVersion()}\n请从发布页下载适合当前系统的安装包。`,
        buttons: ["打开下载页", "取消"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }).then((result) => (
        result.response === 0 ? openDownloadsPage() : null
      )).catch((error) => {
        logger.warn("Failed to open update downloads:", error);
        return null;
      });
    }

    manualUpdateCheck ||= isManual;

    if (updateCheckPromise || downloadInProgress) {
      return updateCheckPromise || Promise.resolve(null);
    }

    publishState({
      status: "checking",
      percent: 0,
      message: "正在检查更新...",
      canCheck: false,
    });

    updateCheckPromise = updater.checkForUpdates()
      .catch((error) => {
        if (manualUpdateCheck) {
          notifyError(error);
        } else {
          const message = error instanceof Error ? error.message : String(error || "未知错误");
          publishState({
            status: "error",
            message: `检查更新失败：${message.slice(0, 160)}`,
            canCheck: true,
          });
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
    if (initialized || !app.isPackaged || !isUpdateSupported) {
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
      publishState({
        status: "up-to-date",
        availableVersion: "",
        percent: 0,
        message: `当前已是最新版本 ${app.getVersion()}。`,
        canCheck: true,
      });

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
      const percent = Number.isFinite(Number(progress?.percent))
        ? Math.min(Math.max(Number(progress.percent), 0), 100)
        : 0;
      publishState({
        status: "downloading",
        percent,
        message: `正在下载 ATRI Toolbox ${currentState.availableVersion || "更新"}：${Math.round(percent)}%`,
        canCheck: false,
      });
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
        const message = error instanceof Error ? error.message : String(error || "未知错误");
        publishState({
          status: "error",
          percent: 0,
          message: `自动检查更新失败：${message.slice(0, 160)}`,
          canCheck: true,
        });
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
    getState,
    setup,
  };
}

module.exports = {
  createUpdateController,
};
