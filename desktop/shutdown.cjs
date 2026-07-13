function createShutdownCoordinator(options) {
  const close = options.close;
  const beforeClose = options.beforeClose || (() => {});
  const quit = options.quit;
  const forceExit = options.forceExit;
  const onError = options.onError || (() => {});
  const cleanupTimeoutMs = options.cleanupTimeoutMs || 1800;
  const forceExitTimeoutMs = options.forceExitTimeoutMs || 1500;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let phase = "idle";
  let cleanupTask = null;
  let forceExitTimer = null;

  const settleCleanup = (task) => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimer(timeout);
      resolve();
    };
    const timeout = setTimer(() => {
      onError(new Error(`Shutdown cleanup timed out after ${cleanupTimeoutMs}ms.`));
      finish();
    }, cleanupTimeoutMs);

    Promise.resolve(task).catch(onError).finally(finish);
  });

  const handleBeforeQuit = (event) => {
    if (phase === "ready") {
      return false;
    }

    event.preventDefault();

    if (phase === "closing") {
      return true;
    }

    phase = "closing";

    try {
      beforeClose();
    } catch (error) {
      onError(error);
    }

    let closeTask;

    try {
      closeTask = close();
    } catch (error) {
      onError(error);
      closeTask = Promise.resolve();
    }

    cleanupTask = settleCleanup(closeTask).finally(() => {
      phase = "ready";
      forceExitTimer = setTimer(forceExit, forceExitTimeoutMs);
      quit();
    });

    return true;
  };

  const handleWindowClose = (event) => {
    if (phase === "ready") {
      return false;
    }

    event.preventDefault();

    if (phase === "idle") {
      quit();
    }

    return true;
  };

  const handleQuit = () => {
    if (forceExitTimer) {
      clearTimer(forceExitTimer);
      forceExitTimer = null;
    }
  };

  return {
    handleBeforeQuit,
    handleWindowClose,
    handleQuit,
    get cleanupTask() {
      return cleanupTask;
    },
    get phase() {
      return phase;
    },
  };
}

module.exports = {
  createShutdownCoordinator,
};
