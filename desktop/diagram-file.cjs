const fs = require("node:fs");
const path = require("node:path");

const { atomicWriteFile } = require("./atomic-file.cjs");

const MAX_DIAGRAM_BYTES = 25 * 1024 * 1024;
const WRITABLE_EXTENSIONS = new Set([".drawio", ".xml"]);

function createDiagramFileController(options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const writeFile = options.atomicWriteFile || ((filePath, content, writeOptions = {}) => (
    atomicWriteFile(filePath, content, { ...writeOptions, fsPromises })
  ));
  const showOpenDialog = options.showOpenDialog;
  const statePath = options.statePath;
  let activePath = "";
  let activePathLoaded = false;
  let saveQueue = Promise.resolve();

  if (typeof showOpenDialog !== "function") {
    throw new TypeError("showOpenDialog is required");
  }

  if (!statePath) {
    throw new TypeError("statePath is required");
  }

  async function openDiagram() {
    const result = await showOpenDialog({
      title: "导入思维导图",
      properties: ["openFile"],
      filters: [
        { name: "思维导图", extensions: ["drawio", "xml", "json"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePaths?.[0]) {
      return { canceled: true };
    }

    const filePath = path.resolve(result.filePaths[0]);
    const content = await readTextFile(filePath, fsPromises);
    const extension = path.extname(filePath).toLowerCase();
    let kind = "";

    if (WRITABLE_EXTENSIONS.has(extension) && looksLikeDrawioXml(content)) {
      kind = "drawio";
    } else if (extension === ".json" && looksLikeJson(content)) {
      kind = "json";
    } else {
      throw new Error("文件不是有效的 DRAWIO、XML 或 JSON 思维导图。");
    }

    await waitForPendingSaves();

    if (kind === "drawio") {
      await setActivePath(filePath);
    } else {
      await clearActivePath();
    }

    return {
      canceled: false,
      content,
      fileName: path.basename(filePath),
      kind,
      writable: kind === "drawio",
    };
  }

  async function restoreActiveDiagram() {
    await ensureActivePathLoaded();

    if (!activePath) {
      return null;
    }

    try {
      const content = await readTextFile(activePath, fsPromises);

      if (!looksLikeDrawioXml(content) || !WRITABLE_EXTENSIONS.has(path.extname(activePath).toLowerCase())) {
        await clearActivePath();
        return null;
      }

      return {
        content,
        fileName: path.basename(activePath),
        kind: "drawio",
        writable: true,
      };
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EISDIR") {
        await clearActivePath();
        return null;
      }

      throw error;
    }
  }

  async function saveActiveDiagram(input = {}) {
    const xml = String(input.xml || "").trim();

    if (!looksLikeDrawioXml(xml)) {
      throw new Error("拒绝写入无效的 draw.io XML。");
    }

    if (Buffer.byteLength(xml, "utf8") > MAX_DIAGRAM_BYTES) {
      throw new Error("思维导图超过 25 MB，未写入原文件。");
    }

    await ensureActivePathLoaded();

    if (!activePath) {
      return { saved: false, reason: "no_active_file" };
    }

    const targetPath = activePath;
    const pendingSave = saveQueue
      .catch(() => {})
      .then(() => writeFile(targetPath, xml));
    saveQueue = pendingSave;
    await pendingSave;

    return {
      saved: true,
      fileName: path.basename(targetPath),
    };
  }

  async function clearActiveDiagram() {
    await waitForPendingSaves();
    await clearActivePath();
    return { cleared: true };
  }

  async function waitForPendingSaves() {
    await saveQueue.catch(() => {});
  }

  async function ensureActivePathLoaded() {
    if (activePathLoaded) {
      return;
    }

    activePathLoaded = true;

    try {
      const stored = JSON.parse(await fsPromises.readFile(statePath, "utf8"));
      const candidate = typeof stored.activePath === "string" ? path.resolve(stored.activePath) : "";

      if (candidate && WRITABLE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
        activePath = candidate;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await clearActivePath();
      }
    }
  }

  async function setActivePath(filePath) {
    await writeFile(statePath, JSON.stringify({ activePath: filePath }, null, 2), { mode: 0o600 });
    activePath = filePath;
    activePathLoaded = true;
  }

  async function clearActivePath() {
    try {
      await fsPromises.unlink(statePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    activePath = "";
    activePathLoaded = true;
  }

  return {
    clearActiveDiagram,
    openDiagram,
    restoreActiveDiagram,
    saveActiveDiagram,
  };
}

async function readTextFile(filePath, fsPromises) {
  const stats = await fsPromises.stat(filePath);

  if (!stats.isFile()) {
    const error = new Error("请选择一个思维导图文件。");
    error.code = "EISDIR";
    throw error;
  }

  if (stats.size > MAX_DIAGRAM_BYTES) {
    throw new Error("思维导图超过 25 MB，无法导入。");
  }

  return fsPromises.readFile(filePath, "utf8");
}

function looksLikeDrawioXml(content) {
  const text = String(content || "");
  return /<mxfile[\s>]/i.test(text) || /<mxGraphModel[\s>]/i.test(text);
}

function looksLikeJson(content) {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  createDiagramFileController,
  looksLikeDrawioXml,
};
