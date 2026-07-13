import {
  planEdgePresentation,
  planIncrementalNodeLayout,
  resizeRectAroundCenter,
} from "./graph-layout.js";
import { createUndoTimeline } from "./drawio-history.js";

const STORAGE_KEYS = {
  drawioXml: "atri.toolbox.drawio.xml",
  drawioTitle: "atri.toolbox.drawio.title",
  legacyMap: "atri.toolbox.mindmap",
  settings: "atri.toolbox.llm.settings",
  promptCollapsed: "atri.toolbox.prompt.collapsed",
};

const DEFAULT_MAP_TITLE = "ATRI思维导图";
const DRAWIO_ORIGIN = "https://embed.diagrams.net";
const DRAWIO_URL = [
  `${DRAWIO_ORIGIN}/`,
  "?embed=1",
  "&proto=json",
  "&spin=1",
  "&ui=atlas",
  "&libraries=1",
  "&lang=zh",
  "&noExitBtn=1",
  "&saveAndExit=0",
  "&modified=0",
].join("");
const desktopApi = getDesktopApi();

const LAYOUT = {
  topX: 80,
  topY: 80,
  nodeWidth: 180,
  nodeHeight: 56,
  nodeMaxWidth: 280,
  nodeLineHeight: 20,
  nodeNoteLineHeight: 16,
  nodePaddingX: 18,
  nodePaddingY: 14,
  nodeResizeChars: 13,
  treeGapX: 280,
  treeRowGap: 120,
  relationGapX: 280,
  relationRowGap: 120,
  minCanvasPadding: 40,
  overlapGap: 34,
  labelOffsetX: 0,
  labelOffsetY: -24,
};

const dom = {
  settingsButton: document.querySelector("#settingsButton"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  closeSettingsButton: document.querySelector("#closeSettingsButton"),
  settingsTabs: document.querySelector("#settingsTabs"),
  modelSettingsTab: document.querySelector("#modelSettingsTab"),
  updateSettingsTab: document.querySelector("#updateSettingsTab"),
  modelSettingsPanel: document.querySelector("#modelSettingsPanel"),
  updateSettingsPanel: document.querySelector("#updateSettingsPanel"),
  endpointInput: document.querySelector("#endpointInput"),
  modelInput: document.querySelector("#modelInput"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  temperatureInput: document.querySelector("#temperatureInput"),
  testConnectionButton: document.querySelector("#testConnectionButton"),
  settingsStatusText: document.querySelector("#settingsStatusText"),
  currentVersionText: document.querySelector("#currentVersionText"),
  updateStatusText: document.querySelector("#updateStatusText"),
  checkUpdateButton: document.querySelector("#checkUpdateButton"),
  updateProgressGroup: document.querySelector("#updateProgressGroup"),
  updateProgress: document.querySelector("#updateProgress"),
  updateProgressText: document.querySelector("#updateProgressText"),
  descriptionInput: document.querySelector("#descriptionInput"),
  statusText: document.querySelector("#statusText"),
  generationBadge: document.querySelector("#generationBadge"),
  workspace: document.querySelector(".workspace"),
  promptPanel: document.querySelector("#promptPanel"),
  promptPanelBody: document.querySelector("#promptPanelBody"),
  promptToggleButton: document.querySelector("#promptToggleButton"),
  newMapButton: document.querySelector("#newMapButton"),
  importButton: document.querySelector("#importButton"),
  exportButton: document.querySelector("#exportButton"),
  importFileInput: document.querySelector("#importFileInput"),
  mapTitleInput: document.querySelector("#mapTitleInput"),
  drawioFrame: document.querySelector("#drawioFrame"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  zoomInButton: document.querySelector("#zoomInButton"),
  fitButton: document.querySelector("#fitButton"),
};

const initialDiagram = loadInitialDiagram();
const initialModelSettings = loadBrowserSettings();
const state = {
  diagramXml: initialDiagram.xml,
  diagramTitle: initialDiagram.title,
  drawioReady: false,
  pendingLoad: true,
  pendingStatus: "",
  pendingEditorXml: "",
  xmlExportRequest: null,
  saveTimer: 0,
  isGenerating: false,
  undoTimeline: createUndoTimeline(),
  drawioMergeRequest: null,
  externalMutationInFlight: false,
  undoInProgress: false,
  pendingNativeUndoEvents: 0,
  nativeUndoResetTimer: 0,
  mapTitleBeforeEdit: "",
  isPromptCollapsed: loadPromptCollapsed(),
  pageScrollPosition: { x: 0, y: 0 },
  scrollRestoreTimer: 0,
  lastUndoShortcutAt: 0,
  desktopDiagramReady: !desktopApi,
  diagramRestorePromise: Promise.resolve(),
  modelSettings: initialModelSettings,
  modelSettingsRevision: 0,
  settingsReady: Promise.resolve(),
  lastFileSaveError: "",
};

loadSettingsIntoForm();
syncMapTitleInput();
syncPromptPanelState();
bindEvents();
initializeApplicationUpdates();
saveDiagramState();
loadDrawioEditor();
setStatus("正在载入 draw.io 编辑器...");
state.settingsReady = hydrateDesktopModelSettings();
state.diagramRestorePromise = restoreDesktopDiagram();

function bindEvents() {
  dom.settingsButton.addEventListener("click", () => {
    loadSettingsIntoForm();
    setSettingsStatus("");
    selectSettingsTab("model");
    dom.settingsDialog.showModal();
  });

  dom.closeSettingsButton.addEventListener("click", () => dom.settingsDialog.close());
  dom.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettingsFromForm();
    setStatus("设置已保存。");
    dom.settingsDialog.close();
  });

  dom.testConnectionButton.addEventListener("click", testConnection);
  dom.modelSettingsTab.addEventListener("click", () => selectSettingsTab("model"));
  dom.updateSettingsTab.addEventListener("click", () => selectSettingsTab("update"));
  dom.checkUpdateButton.addEventListener("click", checkForApplicationUpdate);
  dom.descriptionInput.addEventListener("keydown", handleDescriptionKeydown);
  dom.promptToggleButton.addEventListener("click", togglePromptPanel);

  dom.newMapButton.addEventListener("click", () => void createNewMindMap());

  dom.mapTitleInput.addEventListener("focus", () => {
    state.mapTitleBeforeEdit = state.diagramTitle;
  });
  dom.mapTitleInput.addEventListener("input", updateDiagramTitle);
  dom.mapTitleInput.addEventListener("keydown", handleMapTitleKeydown);
  dom.mapTitleInput.addEventListener("blur", commitDiagramTitleEdit);
  dom.exportButton.addEventListener("click", exportDiagram);
  dom.importButton.addEventListener("click", () => void chooseDiagramToImport());
  dom.importFileInput.addEventListener("change", importDiagram);

  dom.zoomInButton.addEventListener("click", () => invokeDrawioAction("zoomIn"));
  dom.zoomOutButton.addEventListener("click", () => invokeDrawioAction("zoomOut"));
  dom.fitButton.addEventListener("click", fitDrawio);

  window.addEventListener("message", handleDrawioMessage);
  window.addEventListener("keydown", handleGlobalKeydown, true);
  window.__atriHandleUndoShortcut = handleExternalUndoShortcut;
}

function initializeApplicationUpdates() {
  if (!desktopApi) {
    dom.settingsTabs.hidden = true;
    dom.updateSettingsTab.hidden = true;
    return;
  }

  dom.updateSettingsTab.hidden = false;
  desktopApi.onUpdateState(syncApplicationUpdateState);
  desktopApi.getUpdateState()
    .then(syncApplicationUpdateState)
    .catch((error) => {
      syncApplicationUpdateState({
        status: "error",
        currentVersion: "",
        message: error instanceof Error ? error.message : "无法读取更新状态。",
        canCheck: true,
      });
    });
}

function selectSettingsTab(tab) {
  const showUpdate = tab === "update" && Boolean(desktopApi);
  dom.modelSettingsTab.classList.toggle("is-active", !showUpdate);
  dom.modelSettingsTab.setAttribute("aria-selected", String(!showUpdate));
  dom.updateSettingsTab.classList.toggle("is-active", showUpdate);
  dom.updateSettingsTab.setAttribute("aria-selected", String(showUpdate));
  dom.modelSettingsPanel.hidden = showUpdate;
  dom.updateSettingsPanel.hidden = !showUpdate;
}

async function checkForApplicationUpdate() {
  if (!desktopApi) {
    return;
  }

  if (dom.checkUpdateButton.dataset.action === "downloads") {
    dom.checkUpdateButton.disabled = true;

    try {
      await desktopApi.openUpdateDownloads();
    } catch (error) {
      dom.updateStatusText.textContent = error instanceof Error ? error.message : "无法打开下载页。";
      dom.updateStatusText.style.color = "var(--coral)";
    } finally {
      dom.checkUpdateButton.disabled = false;
    }

    return;
  }

  dom.checkUpdateButton.disabled = true;
  dom.updateStatusText.textContent = "正在检查更新...";
  dom.updateStatusText.style.color = "var(--muted)";

  try {
    syncApplicationUpdateState(await desktopApi.checkForUpdates());
  } catch (error) {
    syncApplicationUpdateState({
      status: "error",
      currentVersion: dom.currentVersionText.textContent.replace(/^当前版本\s*/, ""),
      message: error instanceof Error ? error.message : "检查更新失败。",
      canCheck: true,
    });
  }
}

function syncApplicationUpdateState(input = {}) {
  const status = String(input.status || "idle");
  const currentVersion = String(input.currentVersion || "").trim();
  const percent = clamp(Number(input.percent) || 0, 0, 100);
  const showProgress = ["downloading", "downloaded", "installing"].includes(status);
  const canOpenDownloads = Boolean(input.canOpenDownloads);

  dom.currentVersionText.textContent = currentVersion
    ? `当前版本 ${currentVersion}`
    : "当前版本未知";
  dom.updateStatusText.textContent = String(input.message || "尚未检查更新。");
  dom.updateStatusText.style.color = status === "error" ? "var(--coral)" : "var(--muted)";
  dom.checkUpdateButton.textContent = canOpenDownloads ? "打开下载页" : "检查更新";
  dom.checkUpdateButton.dataset.action = canOpenDownloads ? "downloads" : "check";
  dom.checkUpdateButton.disabled = canOpenDownloads ? false : !input.canCheck;
  dom.updateProgressGroup.hidden = !showProgress;
  dom.updateProgress.value = percent;
  dom.updateProgressText.textContent = `${Math.round(percent)}%`;
}

function togglePromptPanel() {
  const scrollPosition = {
    x: window.scrollX,
    y: window.scrollY,
  };
  state.isPromptCollapsed = !state.isPromptCollapsed;

  try {
    localStorage.setItem(STORAGE_KEYS.promptCollapsed, String(state.isPromptCollapsed));
  } catch {
    // The current session can still use the panel when storage is unavailable.
  }

  syncPromptPanelState();
  window.requestAnimationFrame(() => {
    window.scrollTo(scrollPosition.x, scrollPosition.y);
  });

  if (!state.isPromptCollapsed) {
    dom.descriptionInput.focus();
  }
}

function syncPromptPanelState() {
  const collapsed = state.isPromptCollapsed;
  dom.workspace.classList.toggle("is-prompt-collapsed", collapsed);
  dom.promptPanel.classList.toggle("is-collapsed", collapsed);
  dom.promptPanelBody.hidden = collapsed;
  dom.promptToggleButton.setAttribute("aria-expanded", String(!collapsed));
  dom.promptToggleButton.title = collapsed ? "展开修改描述" : "收合修改描述";
}

function loadPromptCollapsed() {
  try {
    return localStorage.getItem(STORAGE_KEYS.promptCollapsed) === "true";
  } catch {
    return false;
  }
}

function handleDescriptionKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }

  event.preventDefault();
  generateMindMap();
}

function handleGlobalKeydown(event) {
  if (!isUndoShortcut(event) || event.repeat || shouldUseNativeTextUndo(event.target)) {
    return;
  }

  if (handleApplicationUndo()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function handleExternalUndoShortcut() {
  if (shouldUseNativeTextUndo(document.activeElement)) {
    return false;
  }

  return handleApplicationUndo();
}

function handleApplicationUndo() {
  if (state.isGenerating || state.undoInProgress) {
    return true;
  }

  const now = Date.now();

  if (now - state.lastUndoShortcutAt < 120) {
    return true;
  }

  state.lastUndoShortcutAt = now;

  const entry = state.undoTimeline.pop();

  if (entry?.type === "drawio") {
    requestNativeDrawioUndo();
    dom.generationBadge.textContent = "已撤回";
    setStatus("已撤回上一次手动修改。");
    return true;
  }

  if (entry?.type === "snapshot") {
    void undoSnapshotChange(entry);
    return true;
  }

  if (state.drawioReady) {
    requestNativeDrawioUndo();
    return true;
  }

  return false;
}

function requestNativeDrawioUndo() {
  state.pendingNativeUndoEvents += 1;
  window.clearTimeout(state.nativeUndoResetTimer);
  state.nativeUndoResetTimer = window.setTimeout(() => {
    state.pendingNativeUndoEvents = 0;
  }, 1200);
  invokeDrawioAction("undo");
}

function recordEditorChangeForUndo() {
  if (state.externalMutationInFlight) {
    return;
  }

  if (state.pendingNativeUndoEvents > 0) {
    state.pendingNativeUndoEvents -= 1;

    if (state.pendingNativeUndoEvents === 0) {
      window.clearTimeout(state.nativeUndoResetTimer);
    }

    return;
  }

  state.undoTimeline.pushEditorChange();
}

function shouldUseNativeTextUndo(target) {
  if (!target) {
    return false;
  }

  if (target === dom.descriptionInput) {
    return Boolean(dom.descriptionInput.value);
  }

  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || Boolean(target.isContentEditable);
}

function isUndoShortcut(event) {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
}

function loadDrawioEditor() {
  rememberPageScrollPosition();
  state.drawioReady = false;
  state.pendingLoad = true;
  dom.drawioFrame.src = `${DRAWIO_URL}&cacheBust=${Date.now()}`;
}

function handleDrawioMessage(event) {
  if (event.source !== dom.drawioFrame.contentWindow || event.origin !== DRAWIO_ORIGIN) {
    return;
  }

  const message = parseDrawioMessage(event.data);

  if (!message) {
    return;
  }

  if (message.event === "init") {
    state.drawioReady = true;
    sendDrawioLoad({ rememberScroll: false });
    return;
  }

  if (message.event === "load") {
    state.pendingLoad = false;
    setStatus(state.pendingStatus || "draw.io 编辑器已载入。");
    state.pendingStatus = "";
    restorePageScrollPosition();
    return;
  }

  if (message.event === "merge") {
    completeDrawioMerge(message);
    return;
  }

  if (message.event === "autosave") {
    if (!state.pendingLoad && updateDiagramXmlFromEditor(message.xml)) {
      recordEditorChangeForUndo();
    }

    return;
  }

  if (message.event === "save") {
    updateDiagramXmlFromEditor(message.xml);
    setStatus("已保存到本机。");
    return;
  }

  if (message.event === "export" && (message.format === "xml" || state.xmlExportRequest || message.xml)) {
    const exportedXml = message.xml || (looksLikeDrawioXml(message.data || "") ? message.data : "");

    if (exportedXml) {
      updateDiagramXmlFromEditor(exportedXml);
      commitPendingEditorXml();
    }

    completeXmlExport(exportedXml);
    return;
  }

  if (message.event === "exit") {
    setStatus("draw.io 编辑器已关闭当前编辑会话。");
    return;
  }

  if (message.error) {
    setStatus(`draw.io 返回错误：${message.error}`, true);
  }
}

function sendDrawioLoad(options = {}) {
  const rememberScroll = options.rememberScroll !== false;
  const fit = options.fit !== false;

  if (rememberScroll) {
    rememberPageScrollPosition();
  }

  state.pendingLoad = true;
  const message = {
    action: "load",
    xml: state.diagramXml,
    autosave: 1,
    title: `${state.diagramTitle || DEFAULT_MAP_TITLE}.drawio`,
    noExitBtn: 1,
    saveAndExit: 0,
    exportProtocol: true,
  };

  if (fit) {
    message.fit = 1;
  }

  postDrawio(message);
}

function rememberPageScrollPosition() {
  state.pageScrollPosition = {
    x: Number(window.scrollX) || 0,
    y: Number(window.scrollY) || 0,
  };
}

function restorePageScrollPosition() {
  const position = state.pageScrollPosition;
  window.clearTimeout(state.scrollRestoreTimer);
  window.requestAnimationFrame(() => {
    window.scrollTo(position.x, position.y);
    state.scrollRestoreTimer = window.setTimeout(() => {
      window.scrollTo(position.x, position.y);
    }, 120);
  });
}

function postDrawio(message) {
  if (!state.drawioReady && message.action !== "load") {
    return;
  }

  dom.drawioFrame.contentWindow?.postMessage(JSON.stringify(message), DRAWIO_ORIGIN);
}

function parseDrawioMessage(data) {
  if (typeof data === "object" && data) {
    return data;
  }

  if (typeof data !== "string") {
    return null;
  }

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function updateDiagramXmlFromEditor(xml) {
  if (!xml) {
    return false;
  }

  let normalized;

  try {
    normalized = normalizeDrawioXml(xml, state.diagramTitle);
  } catch {
    return false;
  }

  if (normalized === (state.pendingEditorXml || state.diagramXml)) {
    return false;
  }

  state.pendingEditorXml = normalized;

  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(commitPendingEditorXml, 80);
  return true;
}

function commitPendingEditorXml() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = 0;

  if (!state.pendingEditorXml) {
    return;
  }

  state.diagramXml = state.pendingEditorXml;
  state.pendingEditorXml = "";
  syncDiagramTitleMetadata();
  saveDiagramState();
}

function completeXmlExport(xml) {
  if (!state.xmlExportRequest) {
    return;
  }

  window.clearTimeout(state.xmlExportRequest.timer);
  const request = state.xmlExportRequest;
  state.xmlExportRequest = null;
  request.resolve(xml || "");
}

function completeDrawioMerge(message) {
  const request = state.drawioMergeRequest;

  if (!request || message.message?.requestId !== request.id) {
    return;
  }

  window.clearTimeout(request.timer);
  state.drawioMergeRequest = null;

  if (message.error) {
    request.reject(new Error(String(message.error.message || message.error)));
  } else {
    request.resolve();
  }
}

function requestDrawioMerge(xml) {
  if (!state.drawioReady || state.pendingLoad) {
    return Promise.reject(new Error("draw.io 编辑器尚未准备完成。"));
  }

  if (state.drawioMergeRequest) {
    return state.drawioMergeRequest.promise;
  }

  const id = `atri-merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const request = {
    id,
    promise: null,
    resolve: null,
    reject: null,
    timer: 0,
  };

  request.promise = new Promise((resolve, reject) => {
    request.resolve = resolve;
    request.reject = reject;
    request.timer = window.setTimeout(() => {
      if (state.drawioMergeRequest === request) {
        state.drawioMergeRequest = null;
      }

      reject(new Error("draw.io 增量修改响应超时。"));
    }, 5000);
  });

  state.drawioMergeRequest = request;
  postDrawio({
    action: "merge",
    xml,
    requestId: id,
  });
  return request.promise;
}

async function mergeDiagramXmlIntoEditor(xml) {
  state.externalMutationInFlight = true;

  try {
    await requestDrawioMerge(xml);
  } finally {
    state.externalMutationInFlight = false;
  }
}

function requestLatestDiagramXml() {
  commitPendingEditorXml();

  if (!state.drawioReady || state.pendingLoad) {
    return Promise.resolve("");
  }

  if (state.xmlExportRequest) {
    return state.xmlExportRequest.promise;
  }

  const request = {
    promise: null,
    resolve: null,
    timer: 0,
  };

  request.promise = new Promise((resolve) => {
    request.resolve = resolve;
    request.timer = window.setTimeout(() => completeXmlExport(""), 1200);
  });

  state.xmlExportRequest = request;
  postDrawio({
    action: "export",
    format: "xml",
  });

  return request.promise;
}

function captureDiagramSnapshot() {
  return {
    xml: state.diagramXml,
    title: state.diagramTitle,
  };
}

async function undoSnapshotChange(entry) {
  const snapshot = entry?.snapshot;

  if (!snapshot?.xml) {
    return;
  }

  const current = captureDiagramSnapshot();
  state.undoInProgress = true;
  state.diagramXml = snapshot.xml;
  state.diagramTitle = snapshot.title || DEFAULT_MAP_TITLE;
  state.pendingEditorXml = "";
  syncMapTitleInput();

  try {
    saveDiagramState();

    if (state.drawioReady && !state.pendingLoad) {
      await mergeDiagramXmlIntoEditor(state.diagramXml);
    } else if (state.drawioReady) {
      sendDrawioLoad({ fit: false });
    } else {
      loadDrawioEditor();
    }

    dom.generationBadge.textContent = "已撤回";
    setStatus("已撤回上一次描述修改。");
  } catch (error) {
    state.diagramXml = current.xml;
    state.diagramTitle = current.title;
    state.pendingEditorXml = "";
    state.undoTimeline.restore(entry);
    syncMapTitleInput();
    saveDiagramState();
    setStatus(error instanceof Error ? error.message : "无法撤回上一次修改。", true);
  } finally {
    state.undoInProgress = false;
  }
}

function setAiEditLock(locked, message = "") {
  state.isGenerating = locked;
  dom.descriptionInput.disabled = locked;
  dom.mapTitleInput.disabled = locked;
  dom.newMapButton.disabled = locked;
  dom.importButton.disabled = locked;
  dom.exportButton.disabled = locked;
  dom.zoomInButton.disabled = locked;
  dom.zoomOutButton.disabled = locked;
  dom.fitButton.disabled = locked;
  dom.drawioFrame.style.pointerEvents = locked ? "none" : "";
  dom.drawioFrame.setAttribute("aria-busy", String(locked));
  dom.drawioFrame.blur?.();
  document.body.classList.toggle("ai-edit-locked", locked);
  document.querySelector("#mapViewport")?.classList.toggle("ai-locked", locked);

  if (message) {
    dom.generationBadge.textContent = locked ? "等待返回" : dom.generationBadge.textContent;
    setStatus(message);
  }
}

async function generateMindMap() {
  if (state.isGenerating) {
    return;
  }

  await state.settingsReady;

  const description = dom.descriptionInput.value.trim();

  if (!description) {
    setStatus("请输入修改描述。", true);
    dom.descriptionInput.focus();
    return;
  }

  let undoEntry = null;
  let rollbackSnapshot = null;
  const previousBadge = dom.generationBadge.textContent;
  dom.descriptionInput.value = "";
  setAiEditLock(true, "已发送修改描述，正在等待返回；期间画布已锁定。");

  try {
    const latestXml = await requestLatestDiagramXml();

    if (latestXml) {
      updateDiagramXmlFromEditor(latestXml);
      commitPendingEditorXml();
    }

    const currentDiagram = drawioXmlToDiagramSnapshot(state.diagramXml, state.diagramTitle);
    const response = await fetch("/api/mindmap/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description,
        currentDiagram,
        settings: loadSettings(),
      }),
    });

    const payload = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.message || "修改失败。");
    }

    if (!Array.isArray(payload.operations) || !payload.operations.length) {
      throw new Error(payload.summary || "没有可应用的修改。");
    }

    const result = applyMindMapOperationsToDrawioXml(
      state.diagramXml,
      payload.operations,
      state.diagramTitle,
    );

    rollbackSnapshot = captureDiagramSnapshot();
    undoEntry = state.undoTimeline.pushSnapshot(rollbackSnapshot);
    state.diagramXml = result.xml;
    state.diagramTitle = result.title;
    state.pendingEditorXml = "";
    syncMapTitleInput();
    saveDiagramState();
    dom.generationBadge.textContent = payload.source === "llm" ? "模型修改" : "本地解析";
    state.pendingStatus = payload.summary || `已应用 ${result.appliedCount} 项局部修改。`;
    setStatus(state.pendingStatus);

    if (state.drawioReady && !state.pendingLoad) {
      await mergeDiagramXmlIntoEditor(state.diagramXml);
      state.pendingStatus = "";
    } else if (state.drawioReady) {
      sendDrawioLoad({ fit: false });
    } else {
      loadDrawioEditor();
    }

    rollbackSnapshot = null;
  } catch (error) {
    if (undoEntry) {
      state.undoTimeline.remove(undoEntry);
    }

    if (rollbackSnapshot) {
      state.diagramXml = rollbackSnapshot.xml;
      state.diagramTitle = rollbackSnapshot.title || DEFAULT_MAP_TITLE;
      state.pendingEditorXml = "";
      syncMapTitleInput();

      try {
        saveDiagramState();
      } catch {
        // The in-memory snapshot is still restored when local storage is unavailable.
      }

      if (state.drawioReady) {
        try {
          sendDrawioLoad({ fit: false });
        } catch {
          // Keep the original error as the user-facing failure reason.
        }
      }
    }

    setStatus(error instanceof Error ? error.message : "修改失败。", true);
    dom.generationBadge.textContent = previousBadge;
    if (!dom.descriptionInput.value.trim()) {
      dom.descriptionInput.value = description;
    }
  } finally {
    setAiEditLock(false);
    dom.descriptionInput.focus();
  }
}

async function testConnection() {
  saveSettingsFromForm();
  dom.testConnectionButton.disabled = true;
  dom.testConnectionButton.textContent = "测试中";
  setSettingsStatus("正在测试大模型 API 连接...");
  setStatus("正在测试大模型 API 连接...");

  try {
    const response = await fetchWithTimeout("/api/llm/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        settings: loadSettings(),
      }),
    }, 22000);

    const payload = await readJsonResponse(response);

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "连接测试失败。");
    }

    setSettingsStatus(payload.message || "连接成功。");
    setStatus("大模型 API 连接成功。");
  } catch (error) {
    const message = error instanceof Error ? error.message : "连接测试失败。";
    setSettingsStatus(message, true);
    setStatus(message, true);
  } finally {
    dom.testConnectionButton.disabled = false;
    dom.testConnectionButton.textContent = "测试连接";
  }
}

function replaceMindMap(input, message, badge) {
  const map = normalizeAppMap(input);
  state.diagramTitle = map.title || DEFAULT_MAP_TITLE;
  state.diagramXml = mindMapToDrawioXml(map);
  state.undoTimeline.clear();

  syncMapTitleInput();
  saveDiagramState();
  dom.generationBadge.textContent = badge;
  state.pendingStatus = message;
  setStatus(message);

  if (state.drawioReady) {
    sendDrawioLoad();
  } else {
    loadDrawioEditor();
  }
}

function updateDiagramTitle() {
  state.diagramTitle = dom.mapTitleInput.value.trim() || DEFAULT_MAP_TITLE;
  localStorage.setItem(STORAGE_KEYS.drawioTitle, state.diagramTitle);
}

function commitDiagramTitleEdit() {
  state.diagramTitle = dom.mapTitleInput.value.trim() || DEFAULT_MAP_TITLE;
  syncDiagramTitleMetadata();
  syncMapTitleInput();
  saveDiagramState();
}

function cancelDiagramTitleEdit() {
  state.diagramTitle = state.mapTitleBeforeEdit || state.diagramTitle || DEFAULT_MAP_TITLE;
  syncDiagramTitleMetadata();
  syncMapTitleInput();
  saveDiagramState();
}

function syncDiagramTitleMetadata() {
  const documentXml = parseXml(state.diagramXml);

  if (!documentXml) {
    return;
  }

  updateDiagramMetadata(documentXml, state.diagramTitle);
  state.diagramXml = new XMLSerializer().serializeToString(documentXml);
}

function handleMapTitleKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    dom.mapTitleInput.blur();
  }

  if (event.key === "Escape") {
    event.preventDefault();
    cancelDiagramTitleEdit();
    dom.mapTitleInput.blur();
  }
}

function invokeDrawioAction(actionName) {
  postDrawio({
    action: "invokeAction",
    actionName,
  });
}

function fitDrawio() {
  postDrawio({
    action: "fit",
    border: 24,
    maxScale: 1,
  });
}

function exportDiagram() {
  const blob = new Blob([state.diagramXml], {
    type: "application/vnd.jgraph.mxfile",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.diagramTitle || "atri-mindmap"}.drawio`.replace(/[\\/:*?"<>|]+/g, "-");
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus("已导出 DRAWIO 文件。");
}

async function createNewMindMap() {
  try {
    await state.diagramRestorePromise;

    if (desktopApi) {
      await desktopApi.clearActiveDiagram();
    }

    replaceMindMap(createDefaultMap(), "已新建 draw.io 思维导图。", "当前导图");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "无法新建思维导图。", true);
  }
}

async function chooseDiagramToImport() {
  if (!desktopApi) {
    dom.importFileInput.click();
    return;
  }

  try {
    await state.diagramRestorePromise;
    const result = await desktopApi.openDiagram();

    if (!result || result.canceled) {
      return;
    }

    applyImportedDiagram(result.content, result.fileName, {
      writable: result.writable,
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导入失败，请检查文件。", true);
  }
}

async function importDiagram(event) {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    applyImportedDiagram(text, file.name);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导入失败，请检查文件。", true);
  } finally {
    dom.importFileInput.value = "";
  }
}

function applyImportedDiagram(text, fileName, options = {}) {
  if (looksLikeDrawioXml(text)) {
    state.diagramXml = normalizeDrawioXml(text, state.diagramTitle);
    state.diagramTitle = stripExtension(fileName)
      || extractTitleFromDrawioXml(state.diagramXml)
      || DEFAULT_MAP_TITLE;
    state.undoTimeline.clear();
    state.pendingEditorXml = "";
    syncMapTitleInput();
    saveDiagramState({ writeThrough: options.writeThrough !== false });

    const message = options.restored
      ? `已恢复 ${fileName}，后续改动将直接写回该文件。`
      : options.writable
        ? `已导入 ${fileName}，后续改动将直接写回该文件。`
        : "已导入 DRAWIO 文件。";
    state.pendingStatus = message;
    sendDrawioLoad();
    setStatus(message);
    return;
  }

  const payload = JSON.parse(text);
  replaceMindMap(payload, "已导入 JSON 并转换为 draw.io 图。", "导入完成");
}

async function restoreDesktopDiagram() {
  if (!desktopApi) {
    return;
  }

  try {
    const restored = await desktopApi.restoreActiveDiagram();

    if (restored?.content) {
      applyImportedDiagram(restored.content, restored.fileName, {
        restored: true,
        writable: true,
        writeThrough: false,
      });
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "无法恢复上次导入的思维导图。", true);
  } finally {
    state.desktopDiagramReady = true;
  }
}

function loadInitialDiagram() {
  const storedXml = localStorage.getItem(STORAGE_KEYS.drawioXml);
  const storedTitle = localStorage.getItem(STORAGE_KEYS.drawioTitle) || DEFAULT_MAP_TITLE;

  if (storedXml) {
    return {
      title: storedTitle,
      xml: normalizeDrawioXml(storedXml, storedTitle),
    };
  }

  try {
    const legacyRaw = localStorage.getItem(STORAGE_KEYS.legacyMap);
    const legacyMap = legacyRaw ? normalizeAppMap(JSON.parse(legacyRaw)) : createDefaultMap();

    return {
      title: legacyMap.title || DEFAULT_MAP_TITLE,
      xml: mindMapToDrawioXml(legacyMap),
    };
  } catch {
    const fallback = createDefaultMap();

    return {
      title: fallback.title,
      xml: mindMapToDrawioXml(fallback),
    };
  }
}

function saveDiagramState(options = {}) {
  localStorage.setItem(STORAGE_KEYS.drawioXml, state.diagramXml);
  localStorage.setItem(STORAGE_KEYS.drawioTitle, state.diagramTitle || DEFAULT_MAP_TITLE);

  if (options.writeThrough !== false) {
    persistActiveDiagram();
  }
}

function persistActiveDiagram() {
  if (!desktopApi || !state.desktopDiagramReady) {
    return;
  }

  desktopApi.saveActiveDiagram({ xml: state.diagramXml })
    .then((result) => {
      if (result?.saved) {
        state.lastFileSaveError = "";
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "无法写回导入的思维导图。";

      if (message !== state.lastFileSaveError) {
        state.lastFileSaveError = message;
        setStatus(`原文件保存失败：${message}`, true);
      }
    });
}

function syncMapTitleInput() {
  if (document.activeElement !== dom.mapTitleInput) {
    dom.mapTitleInput.value = state.diagramTitle || DEFAULT_MAP_TITLE;
  }
}

function mindMapToDrawioXml(input) {
  const map = normalizeAppMap(input);
  const cells = [];
  const edges = [];
  const idMap = new Map();
  const usedIds = new Set(["0", "1"]);

  cells.push(
    '<mxCell id="0"/>',
    '<mxCell id="1" parent="0"/>',
  );

  layoutTopLevelNodes(map.children, cells, edges, idMap, usedIds);

  return [
    '<mxfile host="ATRI Toolbox" modified="',
    escapeXmlAttribute(new Date().toISOString()),
    '" agent="ATRI Toolbox" version="drawio" type="device">',
    '<diagram id="atri-mindmap" name="',
    escapeXmlAttribute(map.title || DEFAULT_MAP_TITLE),
    '">',
    '<mxGraphModel dx="1200" dy="780" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">',
    '<root>',
    cells.join(""),
    edges.join(""),
    '</root>',
    '</mxGraphModel>',
    '</diagram>',
    '</mxfile>',
  ].join("");
}

function applyMindMapOperationsToDrawioXml(xml, operations, diagramTitle = DEFAULT_MAP_TITLE) {
  const documentXml = parseXml(normalizeDrawioXml(xml, diagramTitle));

  if (!documentXml) {
    throw new Error("当前 draw.io XML 无法解析，未应用任何修改。");
  }

  const graphRoot = documentXml.querySelector("root");

  if (!graphRoot) {
    throw new Error("当前 draw.io 文件缺少图层根节点，未应用任何修改。");
  }

  const usedIds = collectUsedCellIds(graphRoot);
  const verticesById = collectVertexCellsById(graphRoot);
  const edgesById = collectEdgeCellsById(graphRoot);
  const layoutState = {
    movableNodeIds: new Set(),
    touchedEdgeIds: new Set(),
    hints: [],
    initialConnectionCounts: countConnectionsByNode(edgesById.values()),
    originNodeIds: new Set(verticesById.keys()),
  };
  let nextTitle = diagramTitle || DEFAULT_MAP_TITLE;
  let appliedCount = 0;

  for (const operation of operations) {
    if (operation.type === "add_node") {
      if (verticesById.has(operation.nodeId)) {
        throw new Error(`节点 ID 已存在：${operation.nodeId}`);
      }

      const cell = createOperationVertexCell(
        documentXml,
        graphRoot,
        operation,
        verticesById,
        usedIds,
      );
      verticesById.set(operation.nodeId, cell);
      layoutState.movableNodeIds.add(operation.nodeId);

      if (operation.nearNodeId) {
        layoutState.hints.push({ nodeId: operation.nodeId, anchorId: operation.nearNodeId });
      }

      appliedCount += 1;
      continue;
    }

    if (operation.type === "update_node") {
      const cell = requireCell(verticesById, operation.nodeId, "节点");
      const previousGeometry = getCellGeometry(cell);
      const node = {
        title: Object.hasOwn(operation, "title") ? operation.title : extractCellTitle(cell),
        note: Object.hasOwn(operation, "note") ? operation.note : cell.getAttribute("atriNote") || "",
      };
      updateVertexCell(cell, node);

      const nextGeometry = getCellGeometry(cell);

      if (
        previousGeometry
        && nextGeometry
        && (previousGeometry.width !== nextGeometry.width || previousGeometry.height !== nextGeometry.height)
        && (layoutState.initialConnectionCounts.get(operation.nodeId) || 0) > 0
      ) {
        layoutState.movableNodeIds.add(operation.nodeId);
      }

      appliedCount += 1;
      continue;
    }

    if (operation.type === "remove_node") {
      const cell = requireCell(verticesById, operation.nodeId, "节点");

      for (const edge of Array.from(edgesById.values())) {
        if (edge.getAttribute("source") === operation.nodeId || edge.getAttribute("target") === operation.nodeId) {
          edgesById.delete(edge.getAttribute("id"));
          edge.remove();
        }
      }

      cell.remove();
      verticesById.delete(operation.nodeId);
      appliedCount += 1;
      continue;
    }

    if (operation.type === "connect") {
      const source = requireCell(verticesById, operation.sourceId, "起点节点");
      const target = requireCell(verticesById, operation.targetId, "终点节点");
      const arrow = normalizeRelationArrow(operation.arrow);
      let edge = findEquivalentEdgeCell(
        edgesById.values(),
        operation.sourceId,
        operation.targetId,
        arrow,
      );

      if (!edge) {
        markConnectionLayoutNodes(layoutState, operation.sourceId, operation.targetId);
        edge = createManagedEdgeCell(
          documentXml,
          graphRoot,
          source,
          target,
          usedIds,
          operation.edgeId,
        );

        if (edge.getAttribute("id") !== operation.edgeId) {
          throw new Error(`连线 ID 冲突：${operation.edgeId}`);
        }

        edgesById.set(edge.getAttribute("id"), edge);
      }

      updateEdgeRelation(edge, {
        relation: operation.label,
        relationArrow: arrow,
        relationLine: operation.line,
      });
      layoutState.touchedEdgeIds.add(edge.getAttribute("id"));
      appliedCount += 1;
      continue;
    }

    if (operation.type === "update_edge") {
      const edge = requireCell(edgesById, operation.edgeId, "连线");
      const current = extractEdgeRelationMeta(edge);
      updateEdgeRelation(edge, {
        relation: Object.hasOwn(operation, "label") ? operation.label : current.label,
        relationArrow: Object.hasOwn(operation, "arrow") ? operation.arrow : current.arrow,
        relationLine: Object.hasOwn(operation, "line") ? operation.line : current.line,
      });
      layoutState.touchedEdgeIds.add(operation.edgeId);
      appliedCount += 1;
      continue;
    }

    if (operation.type === "disconnect") {
      const edge = requireCell(edgesById, operation.edgeId, "连线");
      edge.remove();
      edgesById.delete(operation.edgeId);
      appliedCount += 1;
      continue;
    }

    if (operation.type === "set_title") {
      nextTitle = normalizeText(operation.title, 80) || nextTitle;
      appliedCount += 1;
      continue;
    }

    throw new Error(`不支持的思维导图操作：${operation.type || "(empty)"}`);
  }

  const movedNodeIds = applyIncrementalNodeLayout(graphRoot, layoutState);
  const relatedEdgeIds = new Set(layoutState.touchedEdgeIds);

  for (const edge of graphRoot.querySelectorAll('mxCell[edge="1"]')) {
    if (
      movedNodeIds.has(edge.getAttribute("source"))
      || movedNodeIds.has(edge.getAttribute("target"))
    ) {
      relatedEdgeIds.add(edge.getAttribute("id"));
    }
  }

  applyManagedEdgePresentation(graphRoot, relatedEdgeIds);
  updateDiagramMetadata(documentXml, nextTitle);

  return {
    xml: new XMLSerializer().serializeToString(documentXml),
    title: nextTitle,
    appliedCount,
  };
}

function drawioXmlToDiagramSnapshot(xml, fallbackTitle = DEFAULT_MAP_TITLE) {
  const documentXml = parseXml(xml);

  if (!documentXml) {
    return {
      title: fallbackTitle,
      nodes: [],
      edges: [],
    };
  }

  const graphRoot = documentXml.querySelector("root");

  if (!graphRoot) {
    return {
      title: fallbackTitle,
      nodes: [],
      edges: [],
    };
  }

  const vertices = getVertexCells(graphRoot)
    .filter((cell) => cell.getAttribute("id") !== "atri-root");
  const vertexIds = new Set(vertices.map((cell) => cell.getAttribute("id")).filter(Boolean));
  const nodes = vertices.map((cell) => {
    const geometry = getCellGeometry(cell);

    return {
      id: cell.getAttribute("id"),
      title: extractCellTitle(cell),
      note: cell.getAttribute("atriNote") || "",
      x: geometry?.x || 0,
      y: geometry?.y || 0,
      width: geometry?.width || LAYOUT.nodeWidth,
      height: geometry?.height || LAYOUT.nodeHeight,
    };
  });
  const edges = Array.from(graphRoot.querySelectorAll('mxCell[edge="1"]'))
    .filter((edge) => (
      vertexIds.has(edge.getAttribute("source"))
      && vertexIds.has(edge.getAttribute("target"))
    ))
    .map((edge) => {
      const relation = extractEdgeRelationMeta(edge);
      return {
        id: edge.getAttribute("id"),
        sourceId: edge.getAttribute("source"),
        targetId: edge.getAttribute("target"),
        label: relation.label,
        arrow: relation.arrow,
        line: relation.line,
      };
    });
  const title = documentXml.querySelector("diagram")?.getAttribute("name")
    || fallbackTitle
    || DEFAULT_MAP_TITLE;

  return {
    title,
    nodes,
    edges,
    cellIds: Array.from(graphRoot.querySelectorAll("mxCell"))
      .map((cell) => cell.getAttribute("id"))
      .filter(Boolean),
  };
}

function collectUsedCellIds(graphRoot) {
  return new Set(Array.from(graphRoot.querySelectorAll("mxCell"))
    .map((cell) => cell.getAttribute("id"))
    .filter(Boolean));
}

function collectEdgeCellsById(graphRoot) {
  return new Map(Array.from(graphRoot.querySelectorAll('mxCell[edge="1"]'))
    .map((cell) => [cell.getAttribute("id"), cell])
    .filter(([id]) => Boolean(id)));
}

function createOperationVertexCell(documentXml, graphRoot, operation, verticesById, usedIds) {
  const id = resolveCellId(operation.nodeId, usedIds);

  if (id !== operation.nodeId) {
    throw new Error(`节点 ID 冲突：${operation.nodeId}`);
  }

  const cell = documentXml.createElement("mxCell");
  const geometry = documentXml.createElement("mxGeometry");
  const node = {
    title: operation.title,
    note: operation.note || "",
  };
  const position = getIndependentNodePosition(graphRoot);
  const size = measureNodeSize(node);

  cell.setAttribute("id", id);
  cell.setAttribute("vertex", "1");
  cell.setAttribute("parent", "1");
  cell.setAttribute("style", "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#ffffff;strokeColor=#ccd7d5;fontColor=#202225;spacing=8;");
  geometry.setAttribute("x", String(position.x));
  geometry.setAttribute("y", String(position.y));
  geometry.setAttribute("width", String(size.width));
  geometry.setAttribute("height", String(size.height));
  geometry.setAttribute("as", "geometry");
  cell.appendChild(geometry);
  updateVertexCell(cell, node);
  graphRoot.appendChild(cell);
  return cell;
}

function getIndependentNodePosition(graphRoot) {
  const maxY = getVertexCells(graphRoot).reduce((value, cell) => {
    const geometry = getCellGeometry(cell);
    return geometry ? Math.max(value, geometry.y + geometry.height) : value;
  }, LAYOUT.topY - 72);

  return {
    x: LAYOUT.topX,
    y: alignToLayoutGrid(maxY + 72),
  };
}

function requireCell(cellsById, id, label) {
  const cell = cellsById.get(id);

  if (!cell) {
    throw new Error(`${label}不存在：${id || "(empty)"}`);
  }

  return cell;
}

function findEquivalentEdgeCell(edges, sourceId, targetId, arrow) {
  for (const edge of edges) {
    if (edge.getAttribute("source") === sourceId && edge.getAttribute("target") === targetId) {
      return edge;
    }

    if (
      arrow === "none"
      && extractEdgeRelationMeta(edge).arrow === "none"
      && edge.getAttribute("source") === targetId
      && edge.getAttribute("target") === sourceId
    ) {
      return edge;
    }
  }

  return null;
}

function countConnectionsByNode(edges) {
  const counts = new Map();

  for (const edge of edges) {
    const sourceId = edge.getAttribute("source");
    const targetId = edge.getAttribute("target");

    if (sourceId) {
      counts.set(sourceId, (counts.get(sourceId) || 0) + 1);
    }

    if (targetId) {
      counts.set(targetId, (counts.get(targetId) || 0) + 1);
    }
  }

  return counts;
}

function markConnectionLayoutNodes(layoutState, sourceId, targetId) {
  if (layoutState.movableNodeIds.has(sourceId) || layoutState.movableNodeIds.has(targetId)) {
    return;
  }

  const sourceConnections = layoutState.initialConnectionCounts.get(sourceId) || 0;
  const targetConnections = layoutState.initialConnectionCounts.get(targetId) || 0;

  if (sourceConnections === 0 && targetConnections > 0) {
    layoutState.movableNodeIds.add(sourceId);
  } else if (targetConnections === 0 && sourceConnections > 0) {
    layoutState.movableNodeIds.add(targetId);
  } else {
    layoutState.movableNodeIds.add(targetId);
  }
}

function applyIncrementalNodeLayout(graphRoot, layoutState) {
  if (!layoutState.movableNodeIds.size) {
    return new Set();
  }

  const vertices = getVertexCells(graphRoot);
  const verticesById = collectVertexCellsById(graphRoot);
  const nodes = vertices.flatMap((cell) => {
    const geometry = getCellGeometry(cell);
    const id = cell.getAttribute("id");

    if (!id || !geometry) {
      return [];
    }

    return [{
      id,
      ...geometry,
      obstacleOnly: id === "atri-root",
    }];
  });
  const edges = Array.from(graphRoot.querySelectorAll('mxCell[edge="1"]')).map((edge) => {
    const relation = extractEdgeRelationMeta(edge);
    return {
      id: edge.getAttribute("id"),
      sourceId: edge.getAttribute("source"),
      targetId: edge.getAttribute("target"),
      label: relation.label,
      arrow: relation.arrow,
    };
  });
  const layout = planIncrementalNodeLayout({
    nodes,
    edges,
    movableNodeIds: layoutState.movableNodeIds,
    originNodeIds: layoutState.originNodeIds,
    reflowConnectedComponents: true,
    hints: layoutState.hints,
  }, {
    topX: LAYOUT.topX,
    topY: LAYOUT.topY,
    canvasPadding: LAYOUT.minCanvasPadding,
    gridSize: 1,
    nodeGap: LAYOUT.overlapGap,
    rankGap: Math.max(100, LAYOUT.relationGapX - LAYOUT.nodeWidth),
    rowGap: Math.max(60, LAYOUT.relationRowGap - LAYOUT.nodeHeight),
    componentGap: LAYOUT.relationRowGap,
  });

  for (const position of layout.positions) {
    const geometry = verticesById.get(position.id)?.querySelector("mxGeometry");

    if (geometry) {
      geometry.setAttribute("x", String(position.x));
      geometry.setAttribute("y", String(position.y));
    }
  }

  return new Set(layout.positions.map((position) => position.id));
}

function applyManagedEdgePresentation(graphRoot, edgeIds) {
  if (!edgeIds.size) {
    return;
  }

  const nodes = getVertexCells(graphRoot).flatMap((cell) => {
    const geometry = getCellGeometry(cell);
    const id = cell.getAttribute("id");

    return id && geometry ? [{ id, ...geometry, obstacleOnly: id === "atri-root" }] : [];
  });
  const edgesById = collectEdgeCellsById(graphRoot);
  const connectedEdgeIds = expandConnectedEdgeIds(edgesById, edgeIds);
  const edges = Array.from(connectedEdgeIds).flatMap((id) => {
    const edge = edgesById.get(id);

    if (!edge) {
      return [];
    }

    const relation = extractEdgeRelationMeta(edge);
    return [{
      id,
      sourceId: edge.getAttribute("source"),
      targetId: edge.getAttribute("target"),
      label: relation.label,
      arrow: relation.arrow,
    }];
  });
  const presentations = planEdgePresentation({ nodes, edges }, {
    canvasPadding: LAYOUT.minCanvasPadding,
    labelOffset: Math.abs(LAYOUT.labelOffsetY),
  });

  for (const presentation of presentations) {
    const edge = edgesById.get(presentation.id);
    const relation = extractEdgeRelationMeta(edge);
    edge.setAttribute("style", formatEdgeStyle(relation.arrow, relation.line, presentation));
    updateEdgeLabelGeometry(edge, presentation);
  }
}

function expandConnectedEdgeIds(edgesById, seedIds) {
  const edgesByNodeId = new Map();

  for (const edge of edgesById.values()) {
    for (const nodeId of [edge.getAttribute("source"), edge.getAttribute("target")]) {
      if (!nodeId) {
        continue;
      }

      if (!edgesByNodeId.has(nodeId)) {
        edgesByNodeId.set(nodeId, []);
      }

      edgesByNodeId.get(nodeId).push(edge);
    }
  }

  const connected = new Set(Array.from(seedIds).filter((id) => edgesById.has(id)));
  const pending = Array.from(connected);

  while (pending.length) {
    const edge = edgesById.get(pending.pop());

    for (const nodeId of [edge.getAttribute("source"), edge.getAttribute("target")]) {
      for (const neighbor of edgesByNodeId.get(nodeId) || []) {
        const id = neighbor.getAttribute("id");

        if (id && !connected.has(id)) {
          connected.add(id);
          pending.push(id);
        }
      }
    }
  }

  return connected;
}

function getCellGeometry(cell) {
  const geometry = cell?.querySelector?.("mxGeometry");

  if (!geometry) {
    return null;
  }

  const x = Number(geometry.getAttribute("x"));
  const y = Number(geometry.getAttribute("y"));
  const width = Number(geometry.getAttribute("width")) || LAYOUT.nodeWidth;
  const height = Number(geometry.getAttribute("height")) || LAYOUT.nodeHeight;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return {
    x,
    y,
    width,
    height,
  };
}

function getVertexCells(graphRoot) {
  return Array.from(graphRoot.querySelectorAll('mxCell[vertex="1"]'));
}

function collectVertexCellsById(graphRoot) {
  return new Map(getVertexCells(graphRoot)
    .map((cell) => [cell.getAttribute("id"), cell])
    .filter(([id]) => Boolean(id)));
}

function measureNodeSize(node) {
  const title = normalizeText(node?.title || "节点", 120);
  const note = normalizeText(node?.note || "", 360);
  const titleChars = visualTextLength(title);
  const noteChars = visualTextLength(note);
  const titleLinesAtDefault = Math.max(1, Math.ceil(titleChars / LAYOUT.nodeResizeChars));
  const noteLinesAtDefault = note ? Math.ceil(noteChars / Math.max(10, LAYOUT.nodeResizeChars + 4)) : 0;
  const needsResize = titleLinesAtDefault > 1 || noteLinesAtDefault > 0;

  if (!needsResize) {
    return {
      width: LAYOUT.nodeWidth,
      height: LAYOUT.nodeHeight,
    };
  }

  const wantedWidth = LAYOUT.nodePaddingX * 2 + Math.min(
    Math.max(titleChars * 13, noteChars * 8, LAYOUT.nodeWidth - (LAYOUT.nodePaddingX * 2)),
    LAYOUT.nodeMaxWidth - (LAYOUT.nodePaddingX * 2),
  );
  const width = Math.ceil(Math.max(LAYOUT.nodeWidth, wantedWidth) / 20) * 20;
  const titleCharsPerLine = Math.max(8, Math.floor((width - (LAYOUT.nodePaddingX * 2)) / 13));
  const noteCharsPerLine = Math.max(10, Math.floor((width - (LAYOUT.nodePaddingX * 2)) / 8));
  const titleLines = Math.max(1, Math.ceil(titleChars / titleCharsPerLine));
  const noteLines = note ? Math.ceil(noteChars / noteCharsPerLine) : 0;
  const height = Math.max(
    LAYOUT.nodeHeight,
    LAYOUT.nodePaddingY * 2
      + (titleLines * LAYOUT.nodeLineHeight)
      + (noteLines ? 6 + (noteLines * LAYOUT.nodeNoteLineHeight) : 0),
  );

  return {
    width,
    height: Math.ceil(height / 20) * 20,
  };
}

function visualTextLength(text) {
  return Array.from(String(text || "")).reduce((total, char) => (
    total + (/[\u4e00-\u9fff\u3040-\u30ff\uff00-\uffef]/.test(char) ? 1.8 : 1)
  ), 0);
}

function alignToLayoutGrid(value) {
  return Math.round(Number(value || 0) / 20) * 20;
}

function isManagedNodeCell(cell) {
  return Boolean(cell?.getAttribute?.("atriTitle"));
}

function updateVertexCell(cell, node) {
  cell.setAttribute("value", formatNodeLabel(node));
  cell.setAttribute("atriTitle", node.title || "节点");
  cell.setAttribute("atriNote", node.note || "");

  const geometry = cell.querySelector("mxGeometry");

  if (geometry && isManagedNodeCell(cell)) {
    const size = measureNodeSize(node);
    const current = getCellGeometry(cell);

    if (current) {
      const resized = resizeRectAroundCenter(current, size);
      geometry.setAttribute("x", String(resized.x));
      geometry.setAttribute("y", String(resized.y));
      geometry.setAttribute("width", String(resized.width));
      geometry.setAttribute("height", String(resized.height));
    }
  }
}

function createManagedEdgeCell(documentXml, graphRoot, source, target, usedIds, preferredId = "") {
  const edge = documentXml.createElement("mxCell");
  const geometry = documentXml.createElement("mxGeometry");
  const sourceId = source.getAttribute("id");
  const targetId = target.getAttribute("id");

  edge.setAttribute("id", resolveCellId(preferredId || `${sourceId}-${targetId}-edge`, usedIds));
  edge.setAttribute("edge", "1");
  edge.setAttribute("parent", "1");
  edge.setAttribute("source", sourceId);
  edge.setAttribute("target", targetId);
  edge.setAttribute("style", formatEdgeStyle());
  geometry.setAttribute("x", String(LAYOUT.labelOffsetX));
  geometry.setAttribute("y", String(LAYOUT.labelOffsetY));
  geometry.setAttribute("relative", "1");
  geometry.setAttribute("as", "geometry");
  edge.appendChild(geometry);
  graphRoot.appendChild(edge);
  return edge;
}

function updateEdgeRelation(edge, node) {
  const relationLabel = formatRelationLabel(node?.relation);
  const relationArrow = normalizeRelationArrow(node?.relationArrow || edge.getAttribute("atriRelationArrow"));
  const relationLine = normalizeRelationLine(node?.relationLine || edge.getAttribute("atriRelationLine"));
  edge.setAttribute("value", relationLabel);
  edge.setAttribute("atriRelation", relationLabel);
  edge.setAttribute("atriRelationArrow", relationArrow);
  edge.setAttribute("atriRelationLine", relationLine);
  edge.setAttribute("style", formatEdgeStyle(relationArrow, relationLine));
  updateEdgeLabelGeometry(edge);
}

function updateEdgeLabelGeometry(edge, presentation = null) {
  const geometry = edge.querySelector("mxGeometry");

  if (!geometry) {
    return;
  }

  geometry.setAttribute("x", String(presentation?.labelX ?? LAYOUT.labelOffsetX));
  geometry.setAttribute("y", String(presentation?.labelY ?? LAYOUT.labelOffsetY));
  geometry.setAttribute("relative", "1");
  geometry.querySelector('mxPoint[as="offset"]')?.remove();
}

function updateDiagramMetadata(documentXml, title) {
  const diagram = documentXml.querySelector("diagram");
  const mxfile = documentXml.querySelector("mxfile");

  if (diagram) {
    diagram.setAttribute("name", title || DEFAULT_MAP_TITLE);
  }

  if (mxfile) {
    mxfile.setAttribute("modified", new Date().toISOString());
  }
}

function layoutTopLevelNodes(nodes, cells, edges, idMap, usedIds) {
  const rowHeight = LAYOUT.treeRowGap;
  let cursorY = LAYOUT.topY;

  for (const node of nodes || []) {
    const span = measureNode(node);
    const y = cursorY + ((span - 1) * rowHeight) / 2;
    layoutNode(node, null, LAYOUT.topX, y, 1, cells, edges, idMap, usedIds);
    cursorY += span * rowHeight;
  }
}

function layoutNode(node, parentId, x, y, depth, cells, edges, idMap, usedIds) {
  const id = resolveCellId(node.id || createId(), usedIds);
  idMap.set(node, id);
  const size = measureNodeSize(node);
  const width = size.width;
  const height = size.height;
  const style = depth === 0
    ? "rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#2f6f6d;fontColor=#ffffff;strokeColor=#235453;fontStyle=1;spacing=8;"
    : "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#ffffff;strokeColor=#ccd7d5;fontColor=#202225;spacing=8;";

  cells.push([
    '<mxCell id="',
    escapeXmlAttribute(id),
    '" value="',
    escapeXmlAttribute(formatNodeLabel(node)),
    '" atriTitle="',
    escapeXmlAttribute(node.title || "节点"),
    '" atriNote="',
    escapeXmlAttribute(node.note || ""),
    '" style="',
    style,
    '" vertex="1" parent="1">',
    '<mxGeometry x="',
    Math.round(x),
    '" y="',
    Math.round(y),
    '" width="',
    width,
    '" height="',
    height,
    '" as="geometry"/>',
    '</mxCell>',
  ].join(""));

  if (parentId && shouldConnectToParent(node, depth)) {
    const edgeId = resolveCellId(`${parentId}-${id}-edge`, usedIds);
    const relationLabel = formatRelationLabel(node.relation);
    const relationArrow = normalizeRelationArrow(node.relationArrow);
    const relationLine = normalizeRelationLine(node.relationLine);
    edges.push([
      '<mxCell id="',
      escapeXmlAttribute(edgeId),
      '" value="',
      escapeXmlAttribute(relationLabel),
      '" atriRelation="',
      escapeXmlAttribute(relationLabel),
      '" atriRelationArrow="',
      escapeXmlAttribute(relationArrow),
      '" atriRelationLine="',
      escapeXmlAttribute(relationLine),
      '" style="',
      escapeXmlAttribute(formatEdgeStyle(relationArrow, relationLine)),
      '" edge="1" parent="1" source="',
      escapeXmlAttribute(parentId),
      '" target="',
      escapeXmlAttribute(id),
      '"><mxGeometry x="',
      LAYOUT.labelOffsetX,
      '" y="',
      LAYOUT.labelOffsetY,
      '" relative="1" as="geometry"/></mxCell>',
    ].join(""));
  }

  const childGapX = LAYOUT.treeGapX;
  const rowHeight = LAYOUT.treeRowGap;
  let cursorY = y - ((measureNode(node) - 1) * rowHeight) / 2;

  for (const child of node.children || []) {
    const childSpan = measureNode(child);
    const childY = cursorY + ((childSpan - 1) * rowHeight) / 2;
    layoutNode(child, id, x + childGapX, childY, depth + 1, cells, edges, idMap, usedIds);
    cursorY += childSpan * rowHeight;
  }
}

function shouldConnectToParent(node, depth) {
  return depth > 1 || Boolean(formatRelationLabel(node?.relation));
}

function measureNode(node) {
  if (!node?.children?.length) {
    return 1;
  }

  return node.children.reduce((total, child) => total + measureNode(child), 0);
}

function formatNodeLabel(node) {
  const title = escapeHtml(node.title || "节点");

  if (!node.note) {
    return title;
  }

  return `${title}<br><font style="font-size: 11px; color: #6f7378">${escapeHtml(node.note)}</font>`;
}

function formatRelationLabel(relation) {
  return normalizeText(relation || "", 40);
}

function formatEdgeStyle(relationArrow = "forward", relationLine = "solid", presentation = null) {
  const arrow = normalizeRelationArrow(relationArrow);
  const line = normalizeRelationLine(relationLine);
  const parts = [
    "edgeStyle=orthogonalEdgeStyle",
    "orthogonal=1",
    "curved=0",
    "rounded=1",
    "orthogonalLoop=1",
    "jettySize=auto",
    "jumpStyle=arc",
    "jumpSize=8",
    "html=1",
    "strokeColor=#2f6f6d",
    "fontColor=#235453",
    "fontSize=12",
    "fontFamily=Helvetica",
    "fontStyle=0",
    "align=center",
    "verticalAlign=middle",
    "labelPosition=center",
    "verticalLabelPosition=middle",
    "labelBackgroundColor=#ffffff",
    "labelBorderColor=none",
    "spacing=6",
    "sourcePerimeterSpacing=6",
    "targetPerimeterSpacing=6",
  ];

  if (presentation) {
    parts.push(
      `exitX=${presentation.exitX}`,
      `exitY=${presentation.exitY}`,
      "exitDx=0",
      "exitDy=0",
      `entryX=${presentation.entryX}`,
      `entryY=${presentation.entryY}`,
      "entryDx=0",
      "entryDy=0",
    );
  }

  if (arrow === "none") {
    parts.push("startArrow=none", "endArrow=none");
  } else if (arrow === "backward") {
    parts.push("startArrow=block", "startFill=1", "endArrow=none");
  } else if (arrow === "both") {
    parts.push("startArrow=block", "startFill=1", "endArrow=block", "endFill=1");
  } else {
    parts.push("startArrow=none", "endArrow=block", "endFill=1");
  }

  if (line === "dashed") {
    parts.push("dashed=1", "dashPattern=8 4");
  } else if (line === "dotted") {
    parts.push("dashed=1", "dashPattern=1 4");
  }

  return `${parts.join(";")};`;
}

function normalizeRelationArrow(value) {
  const arrow = normalizeText(value || "forward", 16).toLowerCase();
  return ["none", "forward", "backward", "both"].includes(arrow) ? arrow : "forward";
}

function normalizeRelationLine(value) {
  const line = normalizeText(value || "solid", 16).toLowerCase();
  return ["solid", "dashed", "dotted"].includes(line) ? line : "solid";
}

function inferRelationArrowFromLabel(label) {
  const text = String(label || "");

  if (/(契约|同伴|伙伴|朋友|配偶|夫妻|盟友|合作|关联|绑定|搭档|同事|兄弟|姐妹|亲属)/.test(text)) {
    return "none";
  }

  if (/(双向|互相|相互|彼此)/.test(text)) {
    return "both";
  }

  return "forward";
}

function inferArrowFromEdgeStyle(style) {
  const text = String(style || "");
  const hasStart = /startArrow=(?!none)[^;]+/.test(text);
  const hasEnd = /endArrow=(?!none)[^;]+/.test(text);

  if (hasStart && hasEnd) {
    return "both";
  }

  if (hasStart) {
    return "backward";
  }

  if (hasEnd) {
    return "forward";
  }

  return "none";
}

function inferLineFromEdgeStyle(style) {
  const text = String(style || "");

  if (/dashPattern=1 4/.test(text)) {
    return "dotted";
  }

  if (/dashed=1/.test(text)) {
    return "dashed";
  }

  return "solid";
}

function extractEdgeRelationMeta(edge) {
  return {
    label: normalizeText(edge.getAttribute("atriRelation") || htmlToPlainText(edge.getAttribute("value") || ""), 40),
    arrow: normalizeRelationArrow(edge.getAttribute("atriRelationArrow") || inferArrowFromEdgeStyle(edge.getAttribute("style") || "")),
    line: normalizeRelationLine(edge.getAttribute("atriRelationLine") || inferLineFromEdgeStyle(edge.getAttribute("style") || "")),
  };
}

function extractCellTitle(cell) {
  const customTitle = cell.getAttribute("atriTitle");

  if (customTitle) {
    return customTitle;
  }

  const value = cell.getAttribute("value") || "";
  const plain = htmlToPlainText(value);
  return plain.split(/\n/)[0]?.trim() || "节点";
}

function normalizeDrawioXml(xml, diagramTitle = DEFAULT_MAP_TITLE) {
  const text = String(xml || "").trim();

  if (!text) {
    return mindMapToDrawioXml(createDefaultMap());
  }

  if (/<mxfile[\s>]/i.test(text)) {
    return text;
  }

  if (/<mxGraphModel[\s>]/i.test(text)) {
    return [
      '<mxfile host="ATRI Toolbox" modified="',
      escapeXmlAttribute(new Date().toISOString()),
      '" agent="ATRI Toolbox" version="drawio" type="device">',
      '<diagram id="atri-imported" name="',
      escapeXmlAttribute(diagramTitle || DEFAULT_MAP_TITLE),
      '">',
      text,
      '</diagram>',
      '</mxfile>',
    ].join("");
  }

  throw new Error("不是有效的 draw.io XML。");
}

function looksLikeDrawioXml(text) {
  return /<mxfile[\s>]/i.test(text) || /<mxGraphModel[\s>]/i.test(text);
}

function extractTitleFromDrawioXml(xml) {
  const documentXml = parseXml(xml);
  const rootCell = documentXml?.querySelector('mxCell[id="atri-root"]');
  return rootCell ? extractCellTitle(rootCell) : documentXml?.querySelector("diagram")?.getAttribute("name") || "";
}

function parseXml(xml) {
  try {
    const documentXml = new DOMParser().parseFromString(xml, "application/xml");

    if (documentXml.querySelector("parsererror")) {
      return null;
    }

    return documentXml;
  } catch {
    return null;
  }
}

function normalizeAppMap(input) {
  if (input?.mindmap || input?.map) {
    return normalizeAppMap(input.mindmap || input.map);
  }

  if (typeof input === "string") {
    return {
      title: input.slice(0, 80) || DEFAULT_MAP_TITLE,
      note: "",
      children: [],
    };
  }

  return {
    title: normalizeText(input?.title || input?.name || DEFAULT_MAP_TITLE, 80) || DEFAULT_MAP_TITLE,
    note: normalizeText(input?.note || input?.description || "", 240),
    children: Array.isArray(input?.children) ? input.children.map(normalizeNode) : [],
  };
}

function normalizeNode(input) {
  if (typeof input === "string") {
    return {
      id: createId(),
      title: normalizeText(input, 80) || "节点",
      note: "",
      relation: "",
      relationArrow: "forward",
      relationLine: "solid",
      children: [],
    };
  }

  const relation = normalizeText(input?.relation || "", 40);
  const relationArrowSource = input?.relationArrow || input?.relationDirection || input?.arrow;

  return {
    id: String(input?.id || createId()),
    title: normalizeText(input?.title || input?.name || input?.topic || "节点", 80) || "节点",
    note: normalizeText(input?.note || input?.description || "", 240),
    relation,
    relationArrow: relationArrowSource ? normalizeRelationArrow(relationArrowSource) : inferRelationArrowFromLabel(relation),
    relationLine: normalizeRelationLine(input?.relationLine || input?.lineShape),
    children: Array.isArray(input?.children) ? input.children.map(normalizeNode) : [],
  };
}

function createDefaultMap() {
  return {
    title: DEFAULT_MAP_TITLE,
    note: "",
    children: [
      {
        id: createId(),
        title: "开始",
        note: "",
        relation: "",
        relationArrow: "forward",
        relationLine: "solid",
        children: [],
      },
    ],
  };
}

function loadBrowserSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    return normalizeModelSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeModelSettings();
  }
}

function loadSettings() {
  return { ...state.modelSettings };
}

function loadSettingsIntoForm() {
  const settings = loadSettings();
  dom.endpointInput.value = settings.endpoint;
  dom.modelInput.value = settings.model;
  dom.apiKeyInput.value = settings.apiKey;
  dom.temperatureInput.value = String(settings.temperature);
}

function saveSettingsFromForm() {
  const settings = normalizeModelSettings({
    endpoint: dom.endpointInput.value.trim(),
    model: dom.modelInput.value.trim(),
    apiKey: dom.apiKeyInput.value.trim(),
    temperature: clamp(Number(dom.temperatureInput.value), 0, 2),
  });

  state.modelSettings = settings;
  state.modelSettingsRevision += 1;
  persistBrowserModelSettings(settings);

  if (desktopApi) {
    desktopApi.saveModelSettings(settings).catch((error) => {
      const message = error instanceof Error ? error.message : "大模型 API 设置保存失败。";
      setStatus(message, true);
    });
  }

  return settings;
}

async function hydrateDesktopModelSettings() {
  if (!desktopApi) {
    return;
  }

  const revision = state.modelSettingsRevision;

  try {
    const stored = await desktopApi.loadModelSettings();

    if (revision !== state.modelSettingsRevision) {
      await desktopApi.saveModelSettings(state.modelSettings);
      persistBrowserModelSettings(state.modelSettings);
      return;
    }

    if (stored) {
      state.modelSettings = normalizeModelSettings(stored);
      persistBrowserModelSettings(state.modelSettings);
      loadSettingsIntoForm();
      return;
    }

    if (hasModelSettings(state.modelSettings)) {
      await desktopApi.saveModelSettings(state.modelSettings);
      persistBrowserModelSettings(state.modelSettings);
    }
  } catch (error) {
    console.warn("Failed to restore desktop model settings:", error);
  }
}

function persistBrowserModelSettings(settings) {
  const browserSettings = desktopApi
    ? { ...settings, apiKey: "" }
    : settings;

  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(browserSettings));
  } catch {
    // Keep the current session usable when browser storage is unavailable.
  }
}

function normalizeModelSettings(input = {}) {
  const temperature = Number(input.temperature);

  return {
    endpoint: String(input.endpoint || "").trim(),
    model: String(input.model || "").trim(),
    apiKey: String(input.apiKey || "").trim(),
    temperature: Number.isFinite(temperature) ? clamp(temperature, 0, 2) : 0.3,
  };
}

function hasModelSettings(settings) {
  return Boolean(settings.endpoint || settings.model || settings.apiKey);
}

function getDesktopApi() {
  const api = window.atriDesktop;
  const methods = [
    "openDiagram",
    "restoreActiveDiagram",
    "saveActiveDiagram",
    "clearActiveDiagram",
    "loadModelSettings",
    "saveModelSettings",
    "getUpdateState",
    "checkForUpdates",
    "openUpdateDownloads",
    "onUpdateState",
  ];

  return api && methods.every((method) => typeof api[method] === "function") ? api : null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      message: text.slice(0, 240),
    };
  }
}

function setStatus(message, isError = false) {
  dom.statusText.textContent = message;
  dom.statusText.style.color = isError ? "var(--coral)" : "var(--muted)";
}

function setSettingsStatus(message, isError = false) {
  dom.settingsStatusText.textContent = message;
  dom.settingsStatusText.style.color = isError ? "var(--coral)" : "var(--muted)";
}

function normalizeText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function htmlToPlainText(value) {
  const element = document.createElement("div");
  element.innerHTML = value;
  return element.textContent || element.innerText || "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeXmlAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripExtension(fileName) {
  return String(fileName || "").replace(/\.(drawio|xml|json)$/i, "");
}

function resolveCellId(sourceId, usedIds) {
  const base = String(sourceId || createId()).replace(/[^a-zA-Z0-9_-]/g, "-") || createId();
  let id = base;
  let index = 1;

  while (usedIds.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }

  usedIds.add(id);
  return id;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function createId() {
  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export {
  applyMindMapOperationsToDrawioXml,
  drawioXmlToDiagramSnapshot,
  mindMapToDrawioXml,
};
