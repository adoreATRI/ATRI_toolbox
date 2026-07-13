const MAX_NODES = 240;
const MAX_EDGES = 480;
const MAX_CELL_IDS = 960;
const MAX_OPERATIONS = 32;

export function normalizeDiagramSnapshot(input = {}, fallbackTitle = "ATRI思维导图") {
  const nodes = [];
  const nodeIds = new Set();

  for (const item of Array.isArray(input.nodes) ? input.nodes.slice(0, MAX_NODES) : []) {
    const id = normalizeId(item?.id);

    if (!id || nodeIds.has(id)) {
      continue;
    }

    nodeIds.add(id);
    nodes.push({
      id,
      title: normalizeText(item?.title || item?.name || "节点", 80) || "节点",
      note: normalizeText(item?.note || item?.description || "", 240),
      x: normalizeNumber(item?.x),
      y: normalizeNumber(item?.y),
      width: normalizeNumber(item?.width),
      height: normalizeNumber(item?.height),
    });
  }

  const edges = [];
  const edgeIds = new Set();

  for (const item of Array.isArray(input.edges) ? input.edges.slice(0, MAX_EDGES) : []) {
    const id = normalizeId(item?.id);
    const sourceId = normalizeId(item?.sourceId || item?.source);
    const targetId = normalizeId(item?.targetId || item?.target);

    if (!id || nodeIds.has(id) || edgeIds.has(id) || !nodeIds.has(sourceId) || !nodeIds.has(targetId) || sourceId === targetId) {
      continue;
    }

    edgeIds.add(id);
    edges.push({
      id,
      sourceId,
      targetId,
      label: normalizeText(item?.label || item?.relation || "", 40),
      arrow: normalizeRelationArrow(item?.arrow || item?.relationArrow),
      line: normalizeRelationLine(item?.line || item?.relationLine),
    });
  }

  const cellIds = new Set([
    ...nodeIds,
    ...edgeIds,
    ...(Array.isArray(input.cellIds) ? input.cellIds.slice(0, MAX_CELL_IDS).map(normalizeId) : []),
  ]);
  cellIds.delete("");

  return {
    title: normalizeText(input.title || fallbackTitle, 80) || fallbackTitle,
    nodes,
    edges,
    cellIds: [...cellIds].slice(0, MAX_CELL_IDS),
  };
}

export function createLocalOperationPlan(diagramInput, description) {
  const diagram = normalizeDiagramSnapshot(diagramInput);
  const text = normalizeText(description, 2000);

  if (!text) {
    return null;
  }

  if (hasMixedAddRelationIntent(text)) {
    return null;
  }

  const rawOperations = [];
  const aliasesByTitle = new Map();
  const reservedClientIds = new Set([
    ...diagram.nodes.map((node) => node.id),
    ...diagram.cellIds,
  ]);
  let aliasIndex = 0;
  let hasAmbiguousNodeReference = false;

  const allocateClientId = () => {
    let clientId = "";

    do {
      aliasIndex += 1;
      clientId = `new-${aliasIndex}`;
    } while (reservedClientIds.has(clientId));

    reservedClientIds.add(clientId);
    return clientId;
  };

  const findExistingNodes = (title) => {
    const key = titleKey(title);
    return diagram.nodes.filter((node) => titleKey(node.title) === key);
  };

  const findExistingNode = (title) => {
    const matches = findExistingNodes(title);

    if (matches.length > 1) {
      hasAmbiguousNodeReference = true;
      return null;
    }

    return matches[0] || null;
  };

  const ensureNodeRef = (title, nearNodeId = "") => {
    const normalizedTitle = compactEntityTitle(title);

    if (!normalizedTitle) {
      return "";
    }

    const matches = findExistingNodes(normalizedTitle);

    if (matches.length > 1) {
      hasAmbiguousNodeReference = true;
      return "";
    }

    const existing = matches[0];

    if (existing) {
      return existing.id;
    }

    const key = titleKey(normalizedTitle);

    if (aliasesByTitle.has(key)) {
      const alias = aliasesByTitle.get(key);

      if (!alias) {
        hasAmbiguousNodeReference = true;
      }

      return alias;
    }

    const clientId = allocateClientId();
    aliasesByTitle.set(key, clientId);
    rawOperations.push({
      type: "add_node",
      clientId,
      title: normalizedTitle,
      note: "",
      nearNodeId,
    });
    return clientId;
  };

  const createNodeRef = (title, nearNodeId = "", note = "") => {
    const content = normalizeGeneratedNodeContent(title, note);
    const normalizedTitle = content.title;

    if (!normalizedTitle || hasUnsafeEmbeddedIntent(normalizedTitle)) {
      hasAmbiguousNodeReference = true;
      return "";
    }

    const clientId = allocateClientId();
    const key = titleKey(normalizedTitle);
    aliasesByTitle.set(key, aliasesByTitle.has(key) ? "" : clientId);
    rawOperations.push({
      type: "add_node",
      clientId,
      title: normalizedTitle,
      note: content.note,
      nearNodeId,
    });
    return clientId;
  };

  const relationAnalysis = analyzeExplicitRelations(text);
  const additions = parseAddNodeDescriptions(relationAnalysis.additionText);

  for (const addition of additions) {
    const parentRef = addition.parentTitle ? ensureNodeRef(addition.parentTitle) : "";
    const childRef = createNodeRef(addition.title, parentRef, addition.note);

    if (parentRef && childRef && parentRef !== childRef) {
      rawOperations.push({
        type: "connect",
        sourceId: parentRef,
        targetId: childRef,
        label: "",
        arrow: "forward",
        line: "solid",
      });
    }
  }

  const { clauses, relations, relationClauses } = relationAnalysis;

  for (const relation of relations) {
    const sourceId = ensureNodeRef(relation.sourceTitle);
    const targetId = ensureNodeRef(relation.targetTitle, sourceId);

    if (sourceId && targetId && sourceId !== targetId) {
      rawOperations.push({
        type: "connect",
        sourceId,
        targetId,
        label: relation.label,
        arrow: relation.arrow,
        line: relation.line,
      });
    }
  }

  for (const clause of clauses) {
    if (relationClauses.has(clause)) {
      continue;
    }

    if (/(添加|新增|创建|加入|生成)/.test(clause) && parseAddNodeDescriptions(clause).length) {
      continue;
    }

    if (
      additions.length
      && /^(?:他|她|它|该节点|这个节点)(?:的)?(?:备注|说明|注释|描述|简介|身份|职业|定位|类型|职责|作用|内容)/.test(clause)
    ) {
      continue;
    }

    const rename = parseRenameDescription(clause);

    if (rename) {
      const node = findExistingNode(rename.currentTitle);

      if (!node) {
        return null;
      }

      rawOperations.push({
        type: "update_node",
        nodeId: node.id,
        title: rename.nextTitle,
      });
      continue;
    }

    const note = parseExplicitNoteDescription(clause);

    if (note) {
      const node = findExistingNode(note.title);

      if (!node) {
        return null;
      }

      rawOperations.push({
        type: "update_node",
        nodeId: node.id,
        note: note.note,
      });
      continue;
    }

    const disconnect = parseDisconnectDescription(clause);

    if (disconnect) {
      const first = findExistingNode(disconnect.firstTitle);
      const second = findExistingNode(disconnect.secondTitle);

      if (!first || !second) {
        return null;
      }

      const matchingEdges = diagram.edges.filter((edge) => (
        (edge.sourceId === first.id && edge.targetId === second.id)
        || (edge.sourceId === second.id && edge.targetId === first.id)
      ));

      for (const edge of matchingEdges) {
        rawOperations.push({ type: "disconnect", edgeId: edge.id });
      }
      continue;
    }

    const removal = parseRemoveNodeDescription(clause);

    if (removal) {
      const node = findExistingNode(removal.title);

      if (!node) {
        return null;
      }

      rawOperations.push({ type: "remove_node", nodeId: node.id });
      continue;
    }

    const titleChange = parseDiagramTitleDescription(clause);

    if (titleChange) {
      rawOperations.push({ type: "set_title", title: titleChange });
    }
  }

  if (hasAmbiguousNodeReference) {
    return null;
  }

  if (!rawOperations.length) {
    return null;
  }

  const plan = normalizeOperationPlan({
    summary: "已生成局部修改计划。",
    operations: rawOperations,
  }, diagram);

  plan.summary = `已识别 ${plan.operations.length} 项局部修改。`;

  return plan.operations.length ? plan : null;
}

export function augmentOperationPlanWithExplicitRelations(planInput, diagramInput, description) {
  const diagram = normalizeDiagramSnapshot(diagramInput);
  const plan = normalizeOperationPlan(planInput, diagram);
  const relations = analyzeExplicitRelations(description).relations;

  if (!relations.length) {
    return plan;
  }

  const operations = plan.operations.map((operation) => ({ ...operation }));
  const projectedNodes = new Map(diagram.nodes.map((node) => [node.id, { ...node }]));

  for (const operation of operations) {
    if (operation.type === "add_node") {
      projectedNodes.set(operation.nodeId, {
        id: operation.nodeId,
        title: operation.title,
        note: operation.note || "",
      });
    } else if (operation.type === "update_node" && projectedNodes.has(operation.nodeId)) {
      Object.assign(projectedNodes.get(operation.nodeId), operation);
    } else if (operation.type === "remove_node") {
      projectedNodes.delete(operation.nodeId);
    }
  }

  const usedRefs = new Set([
    ...diagram.cellIds,
    ...projectedNodes.keys(),
    ...operations.flatMap((operation) => [operation.nodeId, operation.edgeId]).filter(Boolean),
  ]);
  let explicitNodeIndex = 0;
  const resolveTitle = (title) => {
    const matches = Array.from(projectedNodes.values()).filter((node) => titleKey(node.title) === titleKey(title));

    if (matches.length > 1) {
      return "";
    }

    if (matches.length === 1) {
      return matches[0].id;
    }

    let clientId = "";

    do {
      explicitNodeIndex += 1;
      clientId = `explicit-node-${explicitNodeIndex}`;
    } while (usedRefs.has(clientId));

    usedRefs.add(clientId);
    operations.push({
      type: "add_node",
      nodeId: clientId,
      title,
      note: "",
    });
    projectedNodes.set(clientId, { id: clientId, title, note: "" });
    return clientId;
  };

  for (const relation of relations) {
    const sourceId = resolveTitle(relation.sourceTitle);
    const targetId = resolveTitle(relation.targetTitle);

    if (!sourceId || !targetId || sourceId === targetId) {
      continue;
    }

    operations.push({
      type: "connect",
      sourceId,
      targetId,
      label: relation.label,
      arrow: relation.arrow,
      line: relation.line,
    });
  }

  return normalizeOperationPlan({
    summary: plan.summary,
    operations,
  }, diagram);
}

export function buildMindMapOperationMessages(diagramInput, description) {
  const diagram = normalizeDiagramSnapshot(diagramInput);
  const compactDiagram = {
    title: diagram.title,
    nodes: diagram.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      note: node.note,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    })),
    edges: diagram.edges.map((edge) => ({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      label: edge.label,
      arrow: edge.arrow,
      line: edge.line,
    })),
  };
  const systemPrompt = [
    "你是 ATRI Toolbox 的 draw.io 思维导图增量编辑器。",
    "只输出一个 JSON 对象，不要输出 Markdown、代码块或解释。",
    "不要返回完整导图。只返回用户描述明确要求的增量 operations。",
    "现有节点和连线必须通过给定的稳定 id 引用；禁止根据标题猜造不存在的 id。",
    "没有被描述涉及的节点、连线、标题、备注、位置和样式不得出现在 operations 中。",
    "允许的操作：",
    "1. add_node: {type, clientId, title, note?, nearNodeId?}。clientId 是本次计划内唯一临时引用，先添加再引用；nearNodeId 只填写与新节点直接相关的现有节点。",
    "2. update_node: {type, nodeId, title?, note?}。只提供确实要修改的字段。",
    "3. remove_node: {type, nodeId}。只有用户明确要求删除节点时使用。",
    "4. connect: {type, sourceId, targetId, label, arrow, line}。sourceId/targetId 可引用现有 id 或先前 add_node 的 clientId。",
    "5. update_edge: {type, edgeId, label?, arrow?, line?}。",
    "6. disconnect: {type, edgeId}。只有用户明确要求断开时使用。",
    "7. set_title: {type, title}。只有用户明确要求更改画布标题时使用。",
    "arrow 只能是 none、forward、backward、both；line 只能是 solid、dashed、dotted。",
    "契约、朋友、同伴、合作、关联等对等关系使用 arrow:none；指向、依赖、调用、控制、包含等有向关系使用 forward；互相或双向使用 both。",
    "有向关系中 sourceId 必须是行为或依赖的发起者，targetId 是承受者；例如‘加奈多服侍莉亚’应为加奈多指向莉亚，以便客户端按关系链递进布局。",
    "虚线、弱关系、可选关系使用 dashed；点线使用 dotted；其余使用 solid。",
    "独立节点只使用 add_node，不要为了形成树而强行 connect。",
    "连接两个已存在节点时使用它们的真实 id，不要复制节点。",
    "节点字段必须按语义严格划分：title 只能是简短名称或主题，不得包含“名为/名字是/节点/备注/说明”等命令词，也不得是完整句子。",
    "note 只放身份、职责、补充说明等描述，不重复 title；节点之间的关系必须使用 connect，绝不能塞进 note。",
    "从描述提炼新节点时，核心实体或概念作为 title，身份、职责、属性和限制作为 note；参考相邻节点的命名粒度与备注风格，但不得编造用户未提及的事实。",
    "例：‘创建一个名为兰斯的节点，备注为近卫骑士’应生成 title:‘兰斯’、note:‘近卫骑士’。",
    "例：‘菲利斯与兰斯是契约关系’应生成或引用两个节点，并 connect，label:‘契约’，不能把整句作为节点标题或备注。",
    "不要输出 x、y 或尺寸；客户端会依据现有拓扑、节点位置和连线标签自动布局。若描述有歧义，返回空 operations，并在 summary 中说明需要用户澄清。",
    "输出格式：{\"summary\":\"简短结果\",\"operations\":[...]}。",
  ].join("\n");
  const userPrompt = [
    "当前 draw.io 图快照：",
    JSON.stringify(compactDiagram),
    "",
    "本次修改描述：",
    normalizeText(description, 2000),
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

export function normalizeOperationPlan(input, diagramInput) {
  const diagram = normalizeDiagramSnapshot(diagramInput);
  const rawOperations = Array.isArray(input?.operations) ? input.operations : [];

  if (rawOperations.length > MAX_OPERATIONS) {
    throw new Error(`模型返回的操作过多，最多允许 ${MAX_OPERATIONS} 项。`);
  }

  const knownNodeIds = new Set(diagram.nodes.map((node) => node.id));
  const aliases = new Map();
  const edgeState = new Map(diagram.edges.map((edge) => [edge.id, { ...edge }]));
  const usedCellIds = new Set(["0", "1", ...diagram.cellIds]);
  const operations = [];

  const resolveNodeRef = (value, fieldName) => {
    const ref = normalizeId(value);
    const resolved = aliases.get(ref) || ref;

    if (!resolved || !knownNodeIds.has(resolved)) {
      throw new Error(`操作引用了不存在的节点 ${fieldName}: ${ref || "(empty)"}`);
    }

    return resolved;
  };

  for (const rawOperation of rawOperations) {
    const type = normalizeOperationType(rawOperation?.type);

    if (type === "add_node") {
      const content = normalizeGeneratedNodeContent(rawOperation.title, rawOperation.note);
      const title = content.title;

      if (!title || hasUnsafeEmbeddedIntent(title)) {
        throw new Error("add_node 缺少有效标题。");
      }

      const clientId = normalizeId(rawOperation.clientId || rawOperation.nodeId || rawOperation.id);
      const nodeId = allocateId(clientId || "ai-node", usedCellIds);

      if (clientId) {
        if (aliases.has(clientId) || knownNodeIds.has(clientId)) {
          throw new Error(`add_node 的 clientId 重复: ${clientId}`);
        }

        aliases.set(clientId, nodeId);
      }

      knownNodeIds.add(nodeId);
      const operation = {
        type,
        nodeId,
        title,
        note: content.note,
      };

      if (rawOperation.nearNodeId) {
        operation.nearNodeId = resolveNodeRef(rawOperation.nearNodeId, "nearNodeId");
      }

      operations.push(operation);
      continue;
    }

    if (type === "update_node") {
      const nodeId = resolveNodeRef(rawOperation.nodeId || rawOperation.id, "nodeId");
      const operation = { type, nodeId };

      if (Object.hasOwn(rawOperation, "title")) {
        operation.title = normalizeText(rawOperation.title, 80);

        if (!operation.title) {
          throw new Error("update_node 的标题不能为空。");
        }
      }

      if (Object.hasOwn(rawOperation, "note")) {
        operation.note = normalizeText(rawOperation.note, 240);
      }

      if (!Object.hasOwn(operation, "title") && !Object.hasOwn(operation, "note")) {
        throw new Error("update_node 没有可应用的字段。");
      }

      operations.push(operation);
      continue;
    }

    if (type === "remove_node") {
      const nodeId = resolveNodeRef(rawOperation.nodeId || rawOperation.id, "nodeId");
      operations.push({ type, nodeId });
      knownNodeIds.delete(nodeId);

      for (const [edgeId, edge] of edgeState) {
        if (edge.sourceId === nodeId || edge.targetId === nodeId) {
          edgeState.delete(edgeId);
        }
      }
      continue;
    }

    if (type === "connect") {
      const sourceId = resolveNodeRef(rawOperation.sourceId || rawOperation.source, "sourceId");
      const targetId = resolveNodeRef(rawOperation.targetId || rawOperation.target, "targetId");

      if (sourceId === targetId) {
        throw new Error("connect 不能连接节点自身。");
      }

      const label = normalizeText(rawOperation.label || rawOperation.relation, 40);
      const arrow = normalizeOperationArrow(rawOperation.arrow || rawOperation.relationArrow, label);
      const line = normalizeOperationLine(rawOperation.line || rawOperation.relationLine);
      const existing = findEquivalentEdge(edgeState.values(), sourceId, targetId, arrow);

      if (existing) {
        if (existing.label !== label || existing.arrow !== arrow || existing.line !== line) {
          operations.push({
            type: "update_edge",
            edgeId: existing.id,
            label,
            arrow,
            line,
          });
          Object.assign(existing, { label, arrow, line });
        }
        continue;
      }

      const edgeId = allocateId(rawOperation.edgeId || "ai-edge", usedCellIds);
      const operation = { type, edgeId, sourceId, targetId, label, arrow, line };
      operations.push(operation);
      edgeState.set(edgeId, { id: edgeId, sourceId, targetId, label, arrow, line });
      continue;
    }

    if (type === "update_edge") {
      const edgeId = normalizeId(rawOperation.edgeId || rawOperation.id);
      const edge = edgeState.get(edgeId);

      if (!edge) {
        throw new Error(`update_edge 引用了不存在的连线: ${edgeId || "(empty)"}`);
      }

      const operation = { type, edgeId };

      if (Object.hasOwn(rawOperation, "label") || Object.hasOwn(rawOperation, "relation")) {
        operation.label = normalizeText(rawOperation.label || rawOperation.relation, 40);
      }

      if (Object.hasOwn(rawOperation, "arrow") || Object.hasOwn(rawOperation, "relationArrow")) {
        operation.arrow = normalizeOperationArrow(rawOperation.arrow || rawOperation.relationArrow, operation.label || edge.label);
      }

      if (Object.hasOwn(rawOperation, "line") || Object.hasOwn(rawOperation, "relationLine")) {
        operation.line = normalizeOperationLine(rawOperation.line || rawOperation.relationLine);
      }

      if (Object.keys(operation).length === 2) {
        throw new Error("update_edge 没有可应用的字段。");
      }

      operations.push(operation);
      Object.assign(edge, operation);
      continue;
    }

    if (type === "disconnect") {
      let edgeId = normalizeId(rawOperation.edgeId || rawOperation.id);

      if (!edgeId && rawOperation.sourceId && rawOperation.targetId) {
        const sourceId = resolveNodeRef(rawOperation.sourceId, "sourceId");
        const targetId = resolveNodeRef(rawOperation.targetId, "targetId");
        edgeId = findEquivalentEdge(edgeState.values(), sourceId, targetId, "none")?.id || "";
      }

      if (!edgeState.has(edgeId)) {
        throw new Error(`disconnect 引用了不存在的连线: ${edgeId || "(empty)"}`);
      }

      operations.push({ type, edgeId });
      edgeState.delete(edgeId);
      continue;
    }

    if (type === "set_title") {
      const title = normalizeText(rawOperation.title, 80);

      if (!title) {
        throw new Error("set_title 缺少有效标题。");
      }

      operations.push({ type, title });
      continue;
    }

    throw new Error(`不支持的思维导图操作: ${rawOperation?.type || "(empty)"}`);
  }

  return {
    summary: normalizeText(input?.summary || "已生成局部修改计划。", 160),
    operations,
  };
}

function splitDescriptionClauses(description) {
  return String(description || "")
    .split(/[，,。；;！!?？\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasMixedAddRelationIntent(description) {
  const text = String(description || "");
  return /(添加|新增|创建|加入|生成)/.test(text) && (
    /[，,。；;](?:他|她|它|该节点|这个节点).*(?:和|与|跟).*(?:是|为|关系)/.test(text)
    || /[，,。；;](?:他|她|它|该节点|这个节点).*(?:是|为).+的(?:朋友|同伴|伙伴|主人|奴隶|上级|下属|成员)/.test(text)
  );
}

function parseAddNodeDescriptions(description) {
  const normalized = normalizeCommand(description);

  if (!/(添加|新增|创建|加入|生成)/.test(normalized)) {
    return [];
  }

  if (hasMixedAddRelationIntent(normalized)) {
    return [];
  }

  const inlineNote = extractInlineNote(normalized);
  const command = inlineNote.index >= 0
    ? normalized.slice(0, inlineNote.index).replace(/[，,。；;]+$/g, "").trim()
    : normalized;
  const parentTitle = extractAddParentTitle(command);
  const titles = extractAddChildTitles(command);

  if (titles.length > 1 && inlineNote.note && !inlineNote.shared) {
    return [];
  }

  return titles.flatMap((title) => {
    const content = normalizeGeneratedNodeContent(title, inlineNote.note);
    return content.title ? [{ parentTitle, ...content }] : [];
  });
}

function extractInlineNote(description) {
  const match = description.match(/(?:[，,。；;]\s*)?(?:(?:他|她|它|该节点|这个节点)(?:的)?)?(?:备注|说明|注释|描述|简介|身份|职业|定位|类型|职责|作用|内容)(?:均|都|统一|共同)?(?:写明|写为|改为|设置为|填写为|是|为|:|：)(.+)$/);

  if (match) {
    return {
      index: match.index,
      note: compactNote(match[1]).replace(/的(?:子?节点|主题|分支)$/g, ""),
      shared: /(?:备注|说明|注释|描述|简介|身份|职业|定位|类型|职责|作用|内容)(?:均|都|统一|共同)/.test(match[0]),
    };
  }

  const inferred = description.match(/[，,。；;]\s*(?:(?:他|她|它|该节点|这个节点)(?:的)?)?(?:是一名|是一个|是|为|担任)(.+)$/);
  return inferred ? {
    index: inferred.index,
    note: compactNote(inferred[1]),
    shared: false,
  } : { index: -1, note: "", shared: false };
}

function extractAddParentTitle(description) {
  const quoted = description.match(/(?:在|到|向)[“"']([^”"']+)[”"'](?:节点|分支|主题)?(?:下|中|里|内)/);

  if (quoted) {
    return compactEntityTitle(quoted[1]);
  }

  const natural = description.match(/(?:在|到|向)(.+?)(?:节点|分支|主题)?(?:下|中|里|内)/);

  if (natural) {
    return compactEntityTitle(natural[1].replace(/(?:节点|分支|主题)$/g, ""));
  }

  const prefix = description.match(/(?:给|为)(.+?)(?:节点|分支|主题)?(?:添加|新增|创建|加入)/);
  return prefix ? compactEntityTitle(prefix[1].replace(/(?:节点|分支|主题)$/g, "")) : "";
}

function extractAddChildTitles(description) {
  const namedTitles = extractNamedTitles(description);

  if (namedTitles.length) {
    return namedTitles;
  }

  const quoted = description.match(/(?:添加|新增|创建|加入|生成)(?:一个|一条|1个)?[“"']([^”"']+)[”"']/);

  if (quoted) {
    return [compactEntityTitle(quoted[1])].filter(Boolean);
  }

  const containerIndex = Math.max(
    description.lastIndexOf("下"),
    description.lastIndexOf("中"),
    description.lastIndexOf("里"),
    description.lastIndexOf("内"),
  );
  const scopedCommand = containerIndex >= 0
    ? description.slice(containerIndex + 1).match(/(?:添加|新增|创建|加入|生成)(?:一个|一条|1个)?(.+)$/)
    : null;
  const natural = scopedCommand
    || description.match(/(?:给|为).+?(?:添加|新增|创建|加入)(?:一个|一条|1个)?(.+)$/)
    || description.match(/(?:添加|新增|创建|加入|生成)(?:一个|一条|1个)?(.+)$/);

  if (!natural) {
    return [];
  }

  const cleaned = String(natural[1] || "")
    .replace(/(?:一个|一条|1个|两个|2个|多个|若干|一些|几个)?(?:子?节点|分支|主题)$/g, "")
    .replace(/^(?:一个|一条|1个|两个|2个|多个|若干|一些|几个|一组)?(?:子?节点|分支|主题)[，,：:]?/g, "")
    .replace(/^(?:一个|一条|1个)?(?:角色|人物|实体|事项|条目)[，,：:\s]*/g, "")
    .replace(/^(?:一个|一条|1个)?(?:名称|名字|标题|节点名)(?:叫做|叫作|叫|是|为|:|：)/g, "")
    .replace(/^(?:一个|一条|1个)?(?:名为|名叫|叫做|叫作|叫)/g, "")
    .replace(/^分别(?:为|叫|是)/g, "")
    .trim();

  return uniqueTitles(cleaned.split(/[、,，/]|和|与/).map(compactEntityTitle).filter(Boolean));
}

function extractNamedTitles(description) {
  const titles = [];
  const pattern = /(?:名为|名叫|叫做|叫作|叫|名称(?:叫做|叫作|叫|是|为)|名字(?:叫做|叫作|叫|是|为)|标题(?:是|为)|节点名(?:是|为)|命名为)[“"']?([^“”"',，。；;、和与]+?)[”"']?(?=(?:的)?(?:子?节点|分支|主题)|(?:备注|说明|注释|描述|简介|身份|职责|作用|内容)|[，,。；;、和与]|$)/g;
  let match = pattern.exec(description);

  while (match) {
    const title = compactEntityTitle(match[1]);

    if (title) {
      titles.push(title);
    }

    match = pattern.exec(description);
  }

  return uniqueTitles(titles);
}

function parseRelationDescription(description) {
  const normalized = normalizeCommand(description)
    .replace(/^(?:然后|接着|随后|再)(?=(?:将|把|连接|连结|关联|创建|新增|添加|生成))/, "");
  const command = normalized.replace(/[，,](?:使用|采用)?(?:虚线|点线|点状线|点划线|普通线|普通连线|实线)(?:连接|连线)?$/g, "");

  const inlineAddConnection = parseInlineAddConnectionCommand(command, normalized);

  if (inlineAddConnection) {
    return inlineAddConnection;
  }

  const explicitConnection = parseExplicitConnectionCommand(command, normalized);

  if (explicitConnection) {
    return explicitConnection;
  }

  if (
    /(添加|新增|创建|加入|生成)/.test(normalized)
    || looksLikeTitleNamingText(normalized)
    || parseRenameDescription(normalized)
    || parseExplicitNoteDescription(normalized)
    || parseDiagramTitleDescription(normalized)
    || /(删除|移除|断开).*(?:连线|连接|关系)/.test(normalized)
  ) {
    return null;
  }

  const pairMatch = command.match(/^(.+?)(?:和|与)(.+?)(?:的)?关系(?:是|为|:|：)(.+)$/);

  if (pairMatch) {
    return createRelation(pairMatch[1], pairMatch[2], pairMatch[3], normalized, "none");
  }

  const mutualMatch = command.match(/^(.+?)(?:和|与|跟|同)(.+?)(?:之间)?(?:是|为|存在|形成|建立)(.+?)(?:关系)?$/);

  if (mutualMatch) {
    return createRelation(mutualMatch[1], mutualMatch[2], mutualMatch[3], normalized, "none");
  }

  const linkMatch = command.match(/^(?:将|把)?(.+?)(?:连接到|连到|关联到|指向)(.+?)(?:，|,)?(?:关系|标签|连线(?:文字|描述)?)?(?:是|为|:|：)(.+)$/);

  if (linkMatch) {
    return createRelation(linkMatch[1], linkMatch[2], linkMatch[3], normalized, "forward");
  }

  const directMatch = command.match(/^(.+?)(指向|依赖|调用|控制|管理|负责|包含|拥有|继承|影响|流向|爱慕|喜欢|服侍|侍奉|守护|追随|协助|帮助|支持|效忠|崇拜|敬仰)(.+)$/);

  if (directMatch) {
    return createRelation(directMatch[1], directMatch[3], directMatch[2], normalized, "forward");
  }

  const roleMatch = command.match(/^(.+?)是(.+?)的(.+)$/);

  if (!roleMatch) {
    return null;
  }

  const childRole = compactRelationLabel(roleMatch[3]);
  const parentRole = inverseRelationRole(childRole);
  const label = parentRole && parentRole !== childRole ? `${parentRole}/${childRole}` : childRole;
  return createRelation(
    roleMatch[2],
    roleMatch[1],
    label,
    normalized,
    isSymmetricRelation(childRole) ? "none" : "forward",
  );
}

function parseInlineAddConnectionCommand(command, originalDescription) {
  const match = command.match(/^(?:请)?(?:创建|新增|添加|生成|加入)(?:一个|一条|1个)?(.+?)(?:节点)?并(?:将|把)?(?:它|其|该节点|这个节点)?(?:连接到|连到|关联到|指向)(.+?)(?:，|,)?(?:(?:关系|标签|连线(?:文字|描述)?)(?:设置|设定|标注|写)?(?:是|为|成|:|：)(.+))?$/);

  return match
    ? createRelation(match[1], match[2], match[3] || "", originalDescription, "forward", true)
    : null;
}

function analyzeExplicitRelations(description) {
  const text = normalizeText(description, 2000);
  const clauses = splitDescriptionClauses(text);
  const relations = [];
  const relationClauses = new Set();
  const addRelation = (relation) => {
    if (
      relation
      && !relations.some((item) => (
        relationKey(item) === relationKey(relation)
        || sameRelationEndpoints(item, relation)
      ))
    ) {
      relations.push(relation);
    }
  };

  addRelation(parseRelationDescription(text));

  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index];
    const nextClause = clauses[index + 1] || "";
    const combined = nextClause && isRelationContinuationClause(nextClause)
      ? `${clause}，${nextClause}`
      : "";
    const relation = combined
      ? parseRelationDescription(combined)
      : parseRelationDescription(clause);

    if (!relation) {
      continue;
    }

    addRelation(relation);
    relationClauses.add(clause);

    if (combined) {
      relationClauses.add(nextClause);
      index += 1;
    }
  }

  return {
    clauses,
    relations,
    relationClauses,
    additionText: clauses.filter((clause) => !relationClauses.has(clause)).join("，"),
  };
}

function parseExplicitConnectionCommand(command, originalDescription) {
  const pairedPatterns = [
    /^(?:请)?(?:连接|连结|关联)[“"']?(.+?)[”"']?(?:和|与|跟)[“"']?(.+?)[”"']?(?:，|,)?(?:(?:关系|标签|连线(?:文字|描述)?)(?:设置|设定|标注|写)?(?:是|为|成|:|：)(.+))?$/,
    /^(?:请)?(?:将|把)(.+?)(?:和|与|跟)(.+?)(?:连接|连结|关联|相连|连起来)(?:，|,)?(?:(?:关系|标签|连线(?:文字|描述)?)(?:设置|设定|标注|写)?(?:是|为|成|:|：)(.+))?$/,
    /^(?:请)?(?:给|在)(.+?)(?:和|与|跟)(.+?)(?:之间)?(?:添加|新增|建立|生成|画)(?:一条|一个)?(?:关系|连线|连接)(?:设置|设定|标注|写)?(?:是|为|成|:|：)(.+?)(?:的)?(?:连线)?$/,
    /^(?:请)?(?:在)?(.+?)(?:和|与|跟)(.+?)(?:之间)(?:添加|新增|建立|生成|画)(?:一条|一个)?(?:连线|连接)(?:，|,)(?:关系|标签|连线(?:文字|描述)?)(?:设置|设定|标注|写)?(?:是|为|成|:|：)(.+)$/,
  ];

  for (const pattern of pairedPatterns) {
    const match = command.match(pattern);

    if (match) {
      return createRelation(match[1], match[2], match[3] || "", originalDescription, "none", true);
    }
  }

  const directedMatch = command.match(/^(?:请)?(?:将|把)?(.+?)(?:连接到|连到|关联到|指向)(.+?)(?:，|,)?(?:(?:关系|标签|连线(?:文字|描述)?)(?:设置|设定|标注|写)?(?:是|为|成|:|：)(.+))?$/);

  if (directedMatch) {
    return createRelation(
      directedMatch[1],
      directedMatch[2],
      directedMatch[3] || "",
      originalDescription,
      "forward",
      true,
    );
  }

  return null;
}

function createRelation(sourceTitle, targetTitle, label, description, defaultArrow, allowEmptyLabel = false) {
  if (/[，,。；;]/.test(String(sourceTitle || "")) || /[，,。；;]/.test(String(targetTitle || ""))) {
    return null;
  }

  const source = compactRelationEndpoint(sourceTitle);
  const target = compactRelationEndpoint(targetTitle);
  const compactLabel = compactRelationLabel(label);

  if (
    !source
    || !target
    || (!compactLabel && !allowEmptyLabel)
    || /(添加|新增|创建|加入|生成)/.test(`${source} ${target}`)
    || /^(?:他|她|它|其|该节点|这个节点)$/.test(source)
    || /^(?:他|她|它|其|该节点|这个节点)$/.test(target)
  ) {
    return null;
  }

  return {
    sourceTitle: source,
    targetTitle: target,
    label: compactLabel,
    arrow: inferRelationArrow(description, compactLabel, defaultArrow),
    line: inferRelationLine(description),
  };
}

function parseRenameDescription(description) {
  const match = normalizeCommand(description).match(/^(?:将|把)?[“"']?(.+?)[”"']?(?:节点)?(?:重命名为|改名为|名称改为|名字改为)[“"']?(.+?)[”"']?$/);
  return match ? {
    currentTitle: compactEntityTitle(match[1]),
    nextTitle: compactEntityTitle(match[2]),
  } : null;
}

function parseExplicitNoteDescription(description) {
  const match = normalizeCommand(description).match(/^(?:将|把)?[“"']?(.+?)[”"']?(?:节点)?(?:的)?(?:备注|说明|注释|描述|简介|身份|职业|定位|类型|职责)(?:改为|设置为|写为|是|为|:|：)(.*)$/);
  return match ? {
    title: compactEntityTitle(match[1]),
    note: compactNote(match[2]),
  } : null;
}

function parseDisconnectDescription(description) {
  const match = normalizeCommand(description).match(/^(?:删除|移除|断开)(?:节点)?[“"']?(.+?)[”"']?(?:和|与|到|之间)[“"']?(.+?)[”"']?(?:之间)?(?:的)?(?:连线|连接|关系)$/);
  return match ? {
    firstTitle: compactEntityTitle(match[1]),
    secondTitle: compactEntityTitle(match[2]),
  } : null;
}

function parseRemoveNodeDescription(description) {
  const match = normalizeCommand(description).match(/^(?:删除|移除)[“"']?(.+?)[”"']?(?:节点|主题|分支)$/);
  return match ? { title: compactEntityTitle(match[1]) } : null;
}

function parseDiagramTitleDescription(description) {
  const match = normalizeCommand(description).match(/^(?:将|把)?(?:导图|画布|思维导图)(?:标题|名称)?(?:改为|重命名为|设置为)[“"']?(.+?)[”"']?$/);
  return match ? normalizeText(match[1], 80) : "";
}

function findEquivalentEdge(edges, sourceId, targetId, arrow) {
  for (const edge of edges) {
    if (edge.sourceId === sourceId && edge.targetId === targetId) {
      return edge;
    }

    if (arrow === "none" && edge.arrow === "none" && edge.sourceId === targetId && edge.targetId === sourceId) {
      return edge;
    }
  }

  return null;
}

function normalizeOperationType(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function allocateId(preferred, usedIds) {
  const base = normalizeId(preferred).replace(/[^a-zA-Z0-9_-]/g, "-") || "ai-item";
  let id = base;
  let index = 1;

  while (usedIds.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }

  usedIds.add(id);
  return id;
}

function normalizeId(value) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function normalizeText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeCommand(value) {
  return String(value || "")
    .replace(/[。.!！?？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactEntityTitle(value) {
  return normalizeText(value, 80)
    .replace(/^[“"'`*_#>-]+|[”"'`*_#>-]+$/g, "")
    .replace(/(?:节点|主题|分支)$/g, "")
    .trim()
    .slice(0, 80);
}

export function normalizeGeneratedNodeContent(titleInput, noteInput = "") {
  let rawTitle = normalizeText(titleInput, 160);
  let note = compactNote(noteInput);
  const embeddedNote = extractInlineNote(rawTitle);

  if (embeddedNote.index > 0) {
    rawTitle = rawTitle.slice(0, embeddedNote.index).replace(/[，,。；;：:\s]+$/g, "");
    note ||= embeddedNote.note;
  }

  rawTitle = rawTitle.replace(/(?:的)?(?:子?节点|主题|分支)$/g, "").trim();
  const parenthetical = !note
    ? rawTitle.match(/^(.{1,80})[（(]([^（）()]{1,240})[）)]$/)
    : null;

  if (parenthetical) {
    rawTitle = parenthetical[1];
    note = compactNote(parenthetical[2]);
  }

  const title = compactGeneratedTitle(rawTitle);

  for (const separator of ["是", "为", ":", "："]) {
    const prefix = `${title}${separator}`;

    if (title && note.startsWith(prefix)) {
      note = compactNote(note.slice(prefix.length));
      break;
    }
  }

  if (titleKey(note) === titleKey(title) || /^(?:无|无备注|暂无|暂无备注|没有)$/.test(note)) {
    note = "";
  }

  return {
    title: normalizeText(title, 80),
    note: normalizeText(note, 240),
  };
}

function compactGeneratedTitle(value) {
  return compactEntityTitle(value)
    .replace(/^(?:请)?(?:添加|新增|创建|加入)(?:(?:一个|一条|1个)(?:子?节点|分支|主题)?|(?:子?节点|分支|主题)[，,：:\s]*)/g, "")
    .replace(/^(?:请)?生成(?:一个|一条|1个|两个|2个|多个|若干|一些|几个)(?:子?节点|分支|主题)?/g, "")
    .replace(/^(?:一个|一条|1个)?(?:名称|名字|标题|节点名)(?:叫做|叫作|叫|是|为|:|：)/g, "")
    .replace(/^(?:一个|一条|1个)?(?:名为|名叫|叫做|叫作|叫)/g, "")
    .replace(/^(?:一个|一条|1个)?(?:角色|人物|实体|事项|条目)[，,：:\s]+/g, "")
    .replace(/[，,。；;：:\s]+$/g, "")
    .trim();
}

function compactRelationEndpoint(value) {
  return compactEntityTitle(value)
    .replace(/(?:使用|采用|通过)(?:虚线|点线|点状线|点划线|普通线|普通连线|实线|双向线|单向线)?$/g, "")
    .replace(/之间$/g, "")
    .trim();
}

function hasUnsafeEmbeddedIntent(value) {
  return /(?:然后|同时|并且|并(?:将|把|连接|关联|添加|新增|创建|删除|移除|修改|重命名)|再(?:将|把|连接|添加)|连接到|关联到|指向|重命名为|备注改为)/.test(String(value || ""));
}

function compactRelationLabel(value) {
  return compactEntityTitle(value)
    .replace(/(?:的)?(?:连线|连接)$/g, "")
    .replace(/(?:之间)?(?:的)?关系$/g, "")
    .replace(/^(?:关系|标签|连线文字)(?:是|为|:|：)?/g, "")
    .replace(/^(?:虚线|点线|点状|点划线|普通线|普通连线|无箭头|无向)/g, "")
    .trim()
    .slice(0, 40);
}

function compactNote(value) {
  return normalizeText(value, 240)
    .replace(/^(?:备注|说明|注释|描述|简介|身份|职业|定位|类型|职责|作用|内容)(?:写明|写为|改为|设置为|填写为|是|为|:|：)/g, "")
    .replace(/^[“"']+|[”"']+$/g, "")
    .trim();
}

function uniqueTitles(titles) {
  return [...new Set(titles)];
}

function titleKey(value) {
  return normalizeText(value, 80).toLocaleLowerCase();
}

function relationKey(relation) {
  return `${titleKey(relation.sourceTitle)}|${titleKey(relation.targetTitle)}|${titleKey(relation.label)}`;
}

function sameRelationEndpoints(first, second) {
  const firstSource = titleKey(first.sourceTitle);
  const firstTarget = titleKey(first.targetTitle);
  const secondSource = titleKey(second.sourceTitle);
  const secondTarget = titleKey(second.targetTitle);

  return (firstSource === secondSource && firstTarget === secondTarget)
    || (first.arrow === "none"
      && second.arrow === "none"
      && firstSource === secondTarget
      && firstTarget === secondSource);
}

function isRelationContinuationClause(clause) {
  return /^(?:关系|标签|连线(?:文字|描述)?)(?:设置|设定|标注|写)?(?:是|为|成|:|：)/.test(clause)
    || /^(?:使用|采用)?(?:虚线|点线|点状线|点划线|普通线|普通连线|实线)(?:连接|连线)?$/.test(clause);
}

function looksLikeTitleNamingText(text) {
  return /(?:名叫|叫做|叫作|名称为|名字为|命名为|(?:^|[，,。；;\s])(?:一个|一条|1个|两个|2个)?叫)/.test(String(text || ""));
}

function inferRelationArrow(description, label, defaultArrow = "forward") {
  const text = `${description || ""} ${label || ""}`;

  if (/(双向|互相|相互|彼此)/.test(text)) {
    return "both";
  }

  if (/(无箭头|普通线|普通连线|无向)/.test(text) || isSymmetricRelation(label)) {
    return "none";
  }

  if (/(反向|被.+(?:指向|依赖|控制|管理|负责|包含|拥有|影响))/.test(text)) {
    return "backward";
  }

  if (/(指向|流向|发送给|传递给|调用|依赖|控制|管理|负责|包含|拥有|继承|影响|输出到|输入到)/.test(text)) {
    return "forward";
  }

  return normalizeRelationArrow(defaultArrow, label);
}

function inferRelationLine(description) {
  if (/(点线|点状|点划线)/.test(description)) {
    return "dotted";
  }

  return /(虚线|弱关系|可选关系|临时关系)/.test(description) ? "dashed" : "solid";
}

function normalizeRelationArrow(value, label = "") {
  const arrow = String(value || "").trim().toLowerCase();

  if (["none", "forward", "backward", "both"].includes(arrow)) {
    return arrow;
  }

  return isSymmetricRelation(label) ? "none" : "forward";
}

function normalizeRelationLine(value) {
  const line = String(value || "solid").trim().toLowerCase();
  return ["solid", "dashed", "dotted"].includes(line) ? line : "solid";
}

function normalizeOperationArrow(value, label = "") {
  const arrow = String(value || "").trim().toLowerCase();

  if (arrow && !["none", "forward", "backward", "both"].includes(arrow)) {
    throw new Error(`无效的连线箭头类型: ${arrow}`);
  }

  return normalizeRelationArrow(arrow, label);
}

function normalizeOperationLine(value) {
  const line = String(value || "").trim().toLowerCase();

  if (line && !["solid", "dashed", "dotted"].includes(line)) {
    throw new Error(`无效的连线样式: ${line}`);
  }

  return normalizeRelationLine(line);
}

function isSymmetricRelation(label) {
  return /(契约|同伴|伙伴|朋友|配偶|夫妻|盟友|合作|关联|绑定|搭档|同事|兄弟|姐妹|亲属)/.test(String(label || ""));
}

function inverseRelationRole(role) {
  const mappings = [
    ["奴隶", "主人"],
    ["仆人", "主人"],
    ["学生", "老师"],
    ["徒弟", "师父"],
    ["孩子", "父母"],
    ["子女", "父母"],
    ["下属", "上级"],
    ["员工", "雇主"],
    ["成员", "组织"],
    ["妻子", "丈夫"],
    ["丈夫", "妻子"],
    ["朋友", "朋友"],
  ];
  return mappings.find(([childRole]) => role.includes(childRole))?.[1] || "";
}
