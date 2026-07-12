const fs = require("node:fs");

const { atomicWriteFile } = require("./atomic-file.cjs");

function createSettingsStore(options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const filePath = options.filePath;
  const safeStorage = options.safeStorage;
  const logger = options.logger || console;
  const writeFile = options.atomicWriteFile || ((targetPath, content, writeOptions = {}) => (
    atomicWriteFile(targetPath, content, { ...writeOptions, fsPromises })
  ));
  let saveQueue = Promise.resolve();

  if (!filePath) {
    throw new TypeError("filePath is required");
  }

  async function load() {
    await saveQueue.catch(() => {});

    try {
      const stored = JSON.parse(await fsPromises.readFile(filePath, "utf8"));
      return normalizeSettings({
        endpoint: stored.endpoint,
        model: stored.model,
        apiKey: decodeApiKey(stored.apiKey, safeStorage, logger),
        temperature: stored.temperature,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger.warn("Failed to load model settings:", error);
      }

      return null;
    }
  }

  async function save(input = {}) {
    const settings = normalizeSettings(input);
    const payload = {
      version: 1,
      endpoint: settings.endpoint,
      model: settings.model,
      apiKey: encodeApiKey(settings.apiKey, safeStorage, logger),
      temperature: settings.temperature,
    };
    const pendingSave = saveQueue
      .catch(() => {})
      .then(() => writeFile(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 }));
    saveQueue = pendingSave;
    await pendingSave;
    return settings;
  }

  return { load, save };
}

function encodeApiKey(apiKey, safeStorage, logger) {
  const value = String(apiKey || "");

  if (!value) {
    return { scheme: "none", value: "" };
  }

  try {
    if (safeStorage?.isEncryptionAvailable?.()) {
      return {
        scheme: "electron-safe-storage",
        value: safeStorage.encryptString(value).toString("base64"),
      };
    }
  } catch (error) {
    logger.warn("Failed to encrypt model API key:", error);
  }

  return { scheme: "plain", value };
}

function decodeApiKey(stored, safeStorage, logger) {
  if (typeof stored === "string") {
    return stored;
  }

  const scheme = String(stored?.scheme || "none");
  const value = String(stored?.value || "");

  if (scheme === "electron-safe-storage" && value) {
    try {
      return safeStorage?.decryptString?.(Buffer.from(value, "base64")) || "";
    } catch (error) {
      logger.warn("Failed to decrypt model API key:", error);
      return "";
    }
  }

  return scheme === "plain" ? value : "";
}

function normalizeSettings(input = {}) {
  const temperature = Number(input.temperature);

  return {
    endpoint: String(input.endpoint || "").trim().slice(0, 2048),
    model: String(input.model || "").trim().slice(0, 240),
    apiKey: String(input.apiKey || "").trim().slice(0, 8192),
    temperature: Number.isFinite(temperature)
      ? Math.min(2, Math.max(0, temperature))
      : 0.3,
  };
}

module.exports = {
  createSettingsStore,
  normalizeSettings,
};
