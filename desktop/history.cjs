const RENDERER_UNDO_EXPRESSION = "Boolean(window.__atriHandleUndoShortcut && window.__atriHandleUndoShortcut())";

function createHistoryController(options = {}) {
  const getWindow = options.getWindow || (() => null);
  const logger = options.logger || console;

  async function undo() {
    const window = getWindow();

    if (!window || window.isDestroyed?.()) {
      return "unavailable";
    }

    const webContents = window.webContents;

    if (!webContents || webContents.isDestroyed?.()) {
      return "unavailable";
    }

    try {
      const handled = await webContents.executeJavaScript(RENDERER_UNDO_EXPRESSION, true);

      if (handled) {
        return "renderer";
      }
    } catch (error) {
      logger.warn("Failed to request renderer undo:", error);
    }

    if (!webContents.isDestroyed?.()) {
      webContents.undo();
      return "native";
    }

    return "unavailable";
  }

  return { undo };
}

function bindHistoryShortcuts(webContents, controller) {
  if (!webContents?.on || !controller?.undo) {
    return () => {};
  }

  const handleInput = (event, input) => {
    if (!isUndoInput(input)) {
      return;
    }

    event.preventDefault();
    controller.undo();
  };

  webContents.on("before-input-event", handleInput);
  return () => webContents.removeListener?.("before-input-event", handleInput);
}

function isUndoInput(input = {}) {
  return input.type === "keyDown"
    && !input.isAutoRepeat
    && (input.control || input.meta)
    && !input.alt
    && !input.shift
    && String(input.key || "").toLowerCase() === "z";
}

module.exports = {
  RENDERER_UNDO_EXPRESSION,
  bindHistoryShortcuts,
  createHistoryController,
  isUndoInput,
};
