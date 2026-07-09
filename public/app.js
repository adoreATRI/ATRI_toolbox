const STORAGE_KEYS = {
  drawioXml: "atri.toolbox.drawio.xml",
  drawioTitle: "atri.toolbox.drawio.title",
  legacyMap: "atri.toolbox.mindmap",
  settings: "atri.toolbox.llm.settings",
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
  labelOffsetX: -0.18,
  labelOffsetY: -18,
};

const dom = {
  settingsButton: document.querySelector("#settingsButton"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  closeSettingsButton: document.querySelector("#closeSettingsButton"),
  endpointInput: document.querySelector("#endpointInput"),
  modelInput: document.querySelector("#modelInput"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  temperatureInput: document.querySelector("#temperatureInput"),
  testConnectionButton: document.querySelector("#testConnectionButton"),
  settingsStatusText: document.querySelector("#settingsStatusText"),
  descriptionInput: document.querySelector("#descriptionInput"),
  statusText: document.querySelector("#statusText"),
  generationBadge: document.querySelector("#generationBadge"),
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
  aiUndoStack: [],
  mapTitleBeforeEdit: "",
};

loadSettingsIntoForm();
syncMapTitleInput();
bindEvents();
saveDiagramState();
loadDrawioEditor();
setStatus("正在载入 draw.io 编辑器...");

function bindEvents() {
  dom.settingsButton.addEventListener("click", () => {
    loadSettingsIntoForm();
    setSettingsStatus("");
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
  dom.descriptionInput.addEventListener("keydown", handleDescriptionKeydown);

  dom.newMapButton.addEventListener("click", () => {
    replaceMindMap(createDefaultMap(), "已新建 draw.io 思维导图。", "当前导图");
  });

  dom.mapTitleInput.addEventListener("focus", () => {
    state.mapTitleBeforeEdit = state.diagramTitle;
  });
  dom.mapTitleInput.addEventListener("input", updateDiagramTitle);
  dom.mapTitleInput.addEventListener("keydown", handleMapTitleKeydown);
  dom.mapTitleInput.addEventListener("blur", commitDiagramTitleEdit);
  dom.exportButton.addEventListener("click", exportDiagram);
  dom.importButton.addEventListener("click", () => dom.importFileInput.click());
  dom.importFileInput.addEventListener("change", importDiagram);

  dom.zoomInButton.addEventListener("click", () => invokeDrawioAction("zoomIn"));
  dom.zoomOutButton.addEventListener("click", () => invokeDrawioAction("zoomOut"));
  dom.fitButton.addEventListener("click", fitDrawio);

  window.addEventListener("message", handleDrawioMessage);
  window.addEventListener("keydown", handleGlobalKeydown, true);
}

function handleDescriptionKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }

  event.preventDefault();
  generateMindMap();
}

function handleGlobalKeydown(event) {
  if (!isUndoShortcut(event) || state.isGenerating || !state.aiUndoStack.length) {
    return;
  }

  if (event.target === dom.descriptionInput && dom.descriptionInput.value) {
    return;
  }

  event.preventDefault();
  undoLastDescriptionChange();
}

function isUndoShortcut(event) {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
}

function loadDrawioEditor() {
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
    sendDrawioLoad();
    return;
  }

  if (message.event === "load") {
    state.pendingLoad = false;
    setStatus(state.pendingStatus || "draw.io 编辑器已载入。");
    state.pendingStatus = "";
    return;
  }

  if (message.event === "autosave") {
    updateDiagramXmlFromEditor(message.xml);
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

function sendDrawioLoad() {
  postDrawio({
    action: "load",
    xml: state.diagramXml,
    autosave: 1,
    title: `${state.diagramTitle || DEFAULT_MAP_TITLE}.drawio`,
    fit: 1,
    noExitBtn: 1,
    saveAndExit: 0,
    exportProtocol: true,
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
    return;
  }

  try {
    state.pendingEditorXml = normalizeDrawioXml(xml, state.diagramTitle);
  } catch {
    return;
  }

  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(commitPendingEditorXml, 80);
}

function commitPendingEditorXml() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = 0;

  if (!state.pendingEditorXml) {
    return;
  }

  state.diagramXml = state.pendingEditorXml;
  state.pendingEditorXml = "";
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

function pushDescriptionUndoSnapshot(snapshot) {
  if (!snapshot?.xml) {
    return;
  }

  state.aiUndoStack.push(snapshot);

  if (state.aiUndoStack.length > 30) {
    state.aiUndoStack.shift();
  }
}

function undoLastDescriptionChange() {
  const snapshot = state.aiUndoStack.pop();

  if (!snapshot) {
    return;
  }

  state.diagramXml = snapshot.xml;
  state.diagramTitle = snapshot.title || DEFAULT_MAP_TITLE;
  state.pendingEditorXml = "";
  syncMapTitleInput();
  saveDiagramState();
  dom.generationBadge.textContent = "已撤回";
  state.pendingStatus = "已撤回上一次描述修改。";
  setStatus("已撤回上一次描述修改。");

  if (state.drawioReady) {
    sendDrawioLoad();
  } else {
    loadDrawioEditor();
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

  const description = dom.descriptionInput.value.trim();

  if (!description) {
    setStatus("请输入修改描述。", true);
    dom.descriptionInput.focus();
    return;
  }

  let undoPushed = false;
  const previousBadge = dom.generationBadge.textContent;
  dom.descriptionInput.value = "";
  setAiEditLock(true, "已发送修改描述，正在等待返回；期间画布已锁定。");

  try {
    const latestXml = await requestLatestDiagramXml();

    if (latestXml) {
      updateDiagramXmlFromEditor(latestXml);
      commitPendingEditorXml();
    }

    const currentMindMap = drawioXmlToMindMap(state.diagramXml, state.diagramTitle);
    const response = await fetch("/api/mindmap/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description,
        currentMindMap,
        selectedNodeTitle: currentMindMap.title,
        settings: loadSettings(),
      }),
    });

    const payload = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.message || "修改失败。");
    }

    pushDescriptionUndoSnapshot(captureDiagramSnapshot());
    undoPushed = true;
    replaceMindMap(payload.mindmap, payload.warning || "已更新 draw.io 思维导图。", payload.source === "llm" ? "模型生成" : "本地更新", {
      merge: true,
      keepUndoStack: true,
    });
  } catch (error) {
    if (undoPushed) {
      state.aiUndoStack.pop();
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

function replaceMindMap(input, message, badge, options = {}) {
  const map = normalizeAppMap(input);
  state.diagramTitle = map.title || DEFAULT_MAP_TITLE;
  state.diagramXml = options.merge
    ? mergeMindMapIntoDrawioXml(state.diagramXml, map)
    : mindMapToDrawioXml(map);

  if (!options.keepUndoStack) {
    state.aiUndoStack = [];
  }

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
  syncMapTitleInput();
  saveDiagramState();
}

function cancelDiagramTitleEdit() {
  state.diagramTitle = state.mapTitleBeforeEdit || state.diagramTitle || DEFAULT_MAP_TITLE;
  syncMapTitleInput();
  saveDiagramState();
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

async function importDiagram(event) {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  try {
    const text = await file.text();

    if (looksLikeDrawioXml(text)) {
      state.diagramXml = normalizeDrawioXml(text, state.diagramTitle);
      state.diagramTitle = stripExtension(file.name) || extractTitleFromDrawioXml(state.diagramXml) || DEFAULT_MAP_TITLE;
      state.aiUndoStack = [];
      syncMapTitleInput();
      saveDiagramState();
      state.pendingStatus = "已导入 DRAWIO 文件。";
      sendDrawioLoad();
      setStatus("已导入 DRAWIO 文件。");
      return;
    }

    const payload = JSON.parse(text);
    replaceMindMap(payload, "已导入 JSON 并转换为 draw.io 图。", "导入完成");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导入失败，请检查文件。", true);
  } finally {
    dom.importFileInput.value = "";
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

function saveDiagramState() {
  localStorage.setItem(STORAGE_KEYS.drawioXml, state.diagramXml);
  localStorage.setItem(STORAGE_KEYS.drawioTitle, state.diagramTitle || DEFAULT_MAP_TITLE);
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

function mergeMindMapIntoDrawioXml(xml, input) {
  const map = normalizeAppMap(input);
  let documentXml;

  try {
    documentXml = parseXml(normalizeDrawioXml(xml, map.title));
  } catch {
    return mindMapToDrawioXml(map);
  }

  if (!documentXml) {
    return mindMapToDrawioXml(map);
  }

  const graphRoot = documentXml.querySelector("root");

  if (!graphRoot) {
    return mindMapToDrawioXml(map);
  }

  removeArtificialRootCells(graphRoot);

  const usedIds = collectUsedCellIds(graphRoot);
  const vertexByTitle = collectVerticesByTitle(graphRoot);
  const edgeByPair = collectEdgesByPair(graphRoot);
  const items = flattenMapNodes(map.children);
  const createdCellIds = new Set();

  for (const item of items) {
    const key = titleKey(item.node.title);

    if (!key) {
      continue;
    }

    let cell = vertexByTitle.get(key);

    if (!cell) {
      cell = createManagedVertexCell(documentXml, graphRoot, item, vertexByTitle, usedIds);
      vertexByTitle.set(key, cell);
      createdCellIds.add(cell.getAttribute("id"));
    }

    updateVertexCell(cell, item.node);
  }

  for (const item of items) {
    if (!item.parentTitle) {
      continue;
    }

    const source = vertexByTitle.get(titleKey(item.parentTitle));
    const target = vertexByTitle.get(titleKey(item.node.title));

    if (!source || !target) {
      continue;
    }

    const pairKey = `${source.getAttribute("id")}->${target.getAttribute("id")}`;
    const reversePairKey = `${target.getAttribute("id")}->${source.getAttribute("id")}`;
    let edge = edgeByPair.get(pairKey);
    let edgeWasMissing = !edge;

    if (!edge && normalizeRelationArrow(item.node.relationArrow) === "none") {
      edge = edgeByPair.get(reversePairKey);
      edgeWasMissing = !edge;
    }

    if (!edge) {
      edge = createManagedEdgeCell(documentXml, graphRoot, source, target, usedIds);
      edgeByPair.set(pairKey, edge);
    }

    repositionRelatedNodeIfNeeded(graphRoot, item, source, target, edgeWasMissing, createdCellIds);
    updateEdgeRelation(edge, item.node);
  }

  updateDiagramMetadata(documentXml, map.title);
  return new XMLSerializer().serializeToString(documentXml);
}

function removeArtificialRootCells(graphRoot) {
  const rootCell = graphRoot.querySelector('mxCell[id="atri-root"]');

  if (!rootCell) {
    return;
  }

  const rootId = rootCell.getAttribute("id");
  const rootEdges = Array.from(graphRoot.querySelectorAll("mxCell")).filter((cell) => (
    cell.getAttribute("source") === rootId || cell.getAttribute("target") === rootId
  ));

  for (const edge of rootEdges) {
    edge.remove();
  }

  rootCell.remove();
}

function collectUsedCellIds(graphRoot) {
  return new Set(Array.from(graphRoot.querySelectorAll("mxCell"))
    .map((cell) => cell.getAttribute("id"))
    .filter(Boolean));
}

function collectVerticesByTitle(graphRoot) {
  const vertices = Array.from(graphRoot.querySelectorAll('mxCell[vertex="1"]'));
  const byTitle = new Map();

  for (const cell of vertices) {
    const key = titleKey(extractCellTitle(cell));

    if (key && !byTitle.has(key)) {
      byTitle.set(key, cell);
    }
  }

  return byTitle;
}

function collectEdgesByPair(graphRoot) {
  const edges = Array.from(graphRoot.querySelectorAll('mxCell[edge="1"]'));
  const byPair = new Map();

  for (const edge of edges) {
    const source = edge.getAttribute("source");
    const target = edge.getAttribute("target");

    if (source && target) {
      byPair.set(`${source}->${target}`, edge);
    }
  }

  return byPair;
}

function flattenMapNodes(nodes, parentTitle = "") {
  const items = [];

  for (const node of nodes || []) {
    items.push({
      node,
      parentTitle,
    });
    items.push(...flattenMapNodes(node.children, node.title));
  }

  return items;
}

function createManagedVertexCell(documentXml, graphRoot, item, vertexByTitle, usedIds) {
  const id = resolveCellId(item.node.id || createId(), usedIds);
  const cell = documentXml.createElement("mxCell");
  const geometry = documentXml.createElement("mxGeometry");
  const position = getNewNodePosition(item, vertexByTitle, graphRoot);
  const size = measureNodeSize(item.node);

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
  graphRoot.appendChild(cell);
  return cell;
}

function getNewNodePosition(item, vertexByTitle, graphRoot) {
  const parentCell = item.parentTitle ? vertexByTitle.get(titleKey(item.parentTitle)) : null;

  if (parentCell) {
    return getRelatedNodePosition(graphRoot, parentCell, item.node, null);
  }

  const existingGeometries = Array.from(vertexByTitle.values())
    .map((cell) => cell.querySelector("mxGeometry"))
    .filter(Boolean);
  const maxY = existingGeometries.reduce((value, geometry) => {
    const y = Number(geometry.getAttribute("y"));
    const height = Number(geometry.getAttribute("height")) || 52;
    return Number.isFinite(y) ? Math.max(value, y + height) : value;
  }, 28);

  return {
    x: LAYOUT.topX,
    y: alignToLayoutGrid(maxY + 72),
  };
}

function repositionRelatedNodeIfNeeded(graphRoot, item, source, target, edgeWasMissing, createdCellIds) {
  const targetId = target.getAttribute("id");

  if (!edgeWasMissing || createdCellIds.has(targetId)) {
    return;
  }

  const current = getCellGeometry(target);
  const next = getRelatedNodePosition(graphRoot, source, item.node, target);

  if (!current || !next) {
    return;
  }

  const dx = Math.round(next.x - current.x);
  const dy = Math.round(next.y - current.y);

  if (!dx && !dy) {
    return;
  }

  translateCellSubtree(graphRoot, target, dx, dy, new Set([source.getAttribute("id")]));
}

function getRelatedNodePosition(graphRoot, parentCell, node, targetCell) {
  const parentGeometry = getCellGeometry(parentCell);

  if (!parentGeometry) {
    return null;
  }

  const side = chooseRelationSide(graphRoot, parentCell, node);
  const targetGeometry = getCellGeometry(targetCell) || {
    width: LAYOUT.nodeWidth,
    height: measureNodeSize(node).height,
  };
  const x = Math.max(LAYOUT.minCanvasPadding, alignToLayoutGrid(parentGeometry.x + (side * LAYOUT.relationGapX)));
  const y = chooseAvailableRelationY(graphRoot, x, parentGeometry.y, targetGeometry, targetCell);

  return {
    x,
    y,
  };
}

function chooseRelationSide(graphRoot, parentCell, node) {
  const parentGeometry = getCellGeometry(parentCell);

  if (!parentGeometry || normalizeRelationArrow(node?.relationArrow) !== "none") {
    return 1;
  }

  if (parentGeometry.x < 260) {
    return 1;
  }

  const parentCenter = parentGeometry.x + (parentGeometry.width / 2);
  const connected = getConnectedVertexCells(graphRoot, parentCell);
  const rightCount = connected.filter((cell) => {
    const geometry = getCellGeometry(cell);
    return geometry && geometry.x > parentCenter;
  }).length;
  const leftCount = connected.filter((cell) => {
    const geometry = getCellGeometry(cell);
    return geometry && geometry.x < parentCenter;
  }).length;

  return rightCount > leftCount ? -1 : 1;
}

function chooseAvailableRelationY(graphRoot, x, preferredY, targetGeometry, targetCell) {
  const offsets = [0, LAYOUT.relationRowGap, -LAYOUT.relationRowGap, LAYOUT.relationRowGap * 2, -LAYOUT.relationRowGap * 2, LAYOUT.relationRowGap * 3, -LAYOUT.relationRowGap * 3, LAYOUT.relationRowGap * 4, -LAYOUT.relationRowGap * 4];
  const vertices = getVertexCells(graphRoot).filter((cell) => cell !== targetCell);
  const width = targetGeometry.width || LAYOUT.nodeWidth;
  const height = targetGeometry.height || LAYOUT.nodeHeight;

  for (const offset of offsets) {
    const candidate = {
      x,
      y: Math.max(LAYOUT.minCanvasPadding, alignToLayoutGrid(preferredY + offset)),
      width,
      height,
    };

    if (!vertices.some((cell) => rectanglesOverlap(candidate, getCellGeometry(cell), LAYOUT.overlapGap))) {
      return candidate.y;
    }
  }

  return Math.max(LAYOUT.minCanvasPadding, alignToLayoutGrid(preferredY + ((offsets.length + 1) * LAYOUT.relationRowGap)));
}

function getConnectedVertexCells(graphRoot, cell) {
  const id = cell.getAttribute("id");
  const byId = collectVertexCellsById(graphRoot);

  return Array.from(graphRoot.querySelectorAll('mxCell[edge="1"]'))
    .map((edge) => {
      if (edge.getAttribute("source") === id) {
        return byId.get(edge.getAttribute("target"));
      }

      if (edge.getAttribute("target") === id) {
        return byId.get(edge.getAttribute("source"));
      }

      return null;
    })
    .filter(Boolean);
}

function translateCellSubtree(graphRoot, cell, dx, dy, blockedIds = new Set(), visited = new Set()) {
  const id = cell.getAttribute("id");

  if (!id || visited.has(id) || blockedIds.has(id)) {
    return;
  }

  visited.add(id);
  translateCell(cell, dx, dy);

  const byId = collectVertexCellsById(graphRoot);
  const childEdges = Array.from(graphRoot.querySelectorAll('mxCell[edge="1"]'))
    .filter((edge) => edge.getAttribute("source") === id);

  for (const edge of childEdges) {
    const child = byId.get(edge.getAttribute("target"));

    if (child) {
      translateCellSubtree(graphRoot, child, dx, dy, blockedIds, visited);
    }
  }
}

function translateCell(cell, dx, dy) {
  const geometry = cell.querySelector("mxGeometry");

  if (!geometry) {
    return;
  }

  const current = getCellGeometry(cell);

  if (!current) {
    return;
  }

  geometry.setAttribute("x", String(Math.round(current.x + dx)));
  geometry.setAttribute("y", String(Math.round(current.y + dy)));
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

function rectanglesOverlap(first, second, gap = 0) {
  if (!first || !second) {
    return false;
  }

  return first.x < second.x + second.width + gap
    && first.x + first.width + gap > second.x
    && first.y < second.y + second.height + gap
    && first.y + first.height + gap > second.y;
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
    geometry.setAttribute("width", String(size.width));
    geometry.setAttribute("height", String(size.height));
  }
}

function createManagedEdgeCell(documentXml, graphRoot, source, target, usedIds) {
  const edge = documentXml.createElement("mxCell");
  const geometry = documentXml.createElement("mxGeometry");
  const sourceId = source.getAttribute("id");
  const targetId = target.getAttribute("id");

  edge.setAttribute("id", resolveCellId(`${sourceId}-${targetId}-edge`, usedIds));
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

function updateEdgeLabelGeometry(edge) {
  const geometry = edge.querySelector("mxGeometry");

  if (!geometry) {
    return;
  }

  geometry.setAttribute("x", String(LAYOUT.labelOffsetX));
  geometry.setAttribute("y", String(LAYOUT.labelOffsetY));
  geometry.setAttribute("relative", "1");
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

function titleKey(title) {
  return normalizeText(title || "", 80).toLocaleLowerCase();
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

function formatEdgeStyle(relationArrow = "forward", relationLine = "solid") {
  const arrow = normalizeRelationArrow(relationArrow);
  const line = normalizeRelationLine(relationLine);
  const parts = [
    "edgeStyle=orthogonalEdgeStyle",
    "rounded=1",
    "orthogonalLoop=1",
    "jettySize=auto",
    "html=1",
    "strokeColor=#2f6f6d",
    "fontColor=#235453",
    "fontSize=12",
    "labelBackgroundColor=#ffffff",
    "labelBorderColor=#ccd7d5",
    "spacing=8",
  ];

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

function drawioXmlToMindMap(xml, fallbackTitle = DEFAULT_MAP_TITLE) {
  const documentXml = parseXml(xml);

  if (!documentXml) {
    return createDefaultMap();
  }

  const cells = Array.from(documentXml.querySelectorAll("mxCell"));
  const vertices = cells.filter((cell) => cell.getAttribute("vertex") === "1");
  const edges = cells.filter((cell) => cell.getAttribute("edge") === "1");

  if (!vertices.length) {
    return {
      title: fallbackTitle || DEFAULT_MAP_TITLE,
      note: "",
      children: [],
    };
  }

  const incoming = new Map();
  const edgeRelationByTarget = new Map();
  const childrenBySource = new Map();

  for (const edge of edges) {
    const source = edge.getAttribute("source");
    const target = edge.getAttribute("target");

    if (!source || !target) {
      continue;
    }

    incoming.set(target, source);
    edgeRelationByTarget.set(target, extractEdgeRelationMeta(edge));

    if (!childrenBySource.has(source)) {
      childrenBySource.set(source, []);
    }

    childrenBySource.get(source).push(target);
  }

  const vertexById = new Map(vertices.map((cell) => [cell.getAttribute("id"), cell]));
  const rootCell = vertexById.get("atri-root") || null;
  const rootId = rootCell?.getAttribute("id") || "";
  const visited = new Set();

  function toNode(cell) {
    const id = cell.getAttribute("id") || createId();
    visited.add(id);
    const node = {
      id,
      title: extractCellTitle(cell),
      note: cell.getAttribute("atriNote") || "",
      relation: edgeRelationByTarget.get(id)?.label || "",
      relationArrow: edgeRelationByTarget.get(id)?.arrow || "forward",
      relationLine: edgeRelationByTarget.get(id)?.line || "solid",
      children: [],
    };

    const childIds = childrenBySource.get(id) || [];
    node.children = childIds
      .map((childId) => vertexById.get(childId))
      .filter(Boolean)
      .map(toNode);
    return node;
  }

  const rootNode = rootCell ? toNode(rootCell) : null;
  const topLevelNodes = rootNode
    ? rootNode.children
    : vertices
      .filter((cell) => !incoming.has(cell.getAttribute("id")))
      .map(toNode);
  const orphanNodes = vertices
    .filter((cell) => !visited.has(cell.getAttribute("id")) && cell.getAttribute("id") !== rootId)
    .map(toNode);

  return normalizeAppMap({
    title: rootNode?.title || fallbackTitle || DEFAULT_MAP_TITLE,
    note: rootNode?.note || "",
    children: [...topLevelNodes, ...orphanNodes],
  });
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

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    const settings = raw ? JSON.parse(raw) : {};

    return {
      endpoint: String(settings.endpoint || ""),
      model: String(settings.model || ""),
      apiKey: String(settings.apiKey || ""),
      temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.3,
    };
  } catch {
    return {
      endpoint: "",
      model: "",
      apiKey: "",
      temperature: 0.3,
    };
  }
}

function loadSettingsIntoForm() {
  const settings = loadSettings();
  dom.endpointInput.value = settings.endpoint;
  dom.modelInput.value = settings.model;
  dom.apiKeyInput.value = settings.apiKey;
  dom.temperatureInput.value = String(settings.temperature);
}

function saveSettingsFromForm() {
  const settings = {
    endpoint: dom.endpointInput.value.trim(),
    model: dom.modelInput.value.trim(),
    apiKey: dom.apiKeyInput.value.trim(),
    temperature: clamp(Number(dom.temperatureInput.value), 0, 2),
  };

  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
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
