import dagre from "@dagrejs/dagre";

const DEFAULT_OPTIONS = {
  topX: 80,
  topY: 80,
  canvasPadding: 40,
  gridSize: 1,
  nodeGap: 34,
  rankGap: 120,
  rowGap: 80,
  componentGap: 100,
  edgeClearance: 18,
};

export function planIncrementalNodeLayout(input = {}, optionOverrides = {}) {
  const options = { ...DEFAULT_OPTIONS, ...optionOverrides };
  const nodes = normalizeNodes(input.nodes);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = normalizeEdges(input.edges, nodesById);
  let movableIds = new Set(
    Array.from(input.movableNodeIds || []).filter((id) => nodesById.has(id)),
  );

  if (input.reflowConnectedComponents) {
    movableIds = expandConnectedNodeIds(movableIds, edges, nodesById);
  }

  if (!movableIds.size) {
    return { positions: [], profile: inferCanvasLayout(nodes, input.edges, movableIds, options) };
  }

  const originIds = new Set(
    Array.from(input.originNodeIds || []).filter((id) => movableIds.has(id)),
  );
  const hints = normalizeHints(input.hints, nodesById, movableIds);
  const profile = inferCanvasLayout(nodes, edges, movableIds, options);
  const components = collectMovableComponents(movableIds, edges, hints);
  const fixedRects = nodes
    .filter((node) => !movableIds.has(node.id))
    .map(toRect);
  const occupied = [...fixedRects];
  const positions = [];

  for (const componentIds of components) {
    const component = layoutComponent({
      componentIds,
      nodes,
      nodesById,
      edges,
      hints,
      originIds,
      occupied,
      profile,
      options,
    });

    for (const position of component) {
      positions.push(position);
      occupied.push({ ...toRect(nodesById.get(position.id)), x: position.x, y: position.y });
    }
  }

  return { positions, profile };
}

export function resizeRectAroundCenter(rectInput = {}, sizeInput = {}) {
  const rect = {
    x: finiteNumber(rectInput.x),
    y: finiteNumber(rectInput.y),
    width: Math.max(0, finiteNumber(rectInput.width)),
    height: Math.max(0, finiteNumber(rectInput.height)),
  };
  const width = Math.max(0, finiteNumber(sizeInput.width, rect.width));
  const height = Math.max(0, finiteNumber(sizeInput.height, rect.height));

  return {
    x: rect.x + ((rect.width - width) / 2),
    y: rect.y + ((rect.height - height) / 2),
    width,
    height,
  };
}

export function inferCanvasLayout(nodesInput = [], edgesInput = [], excludedIds = new Set(), optionOverrides = {}) {
  const options = { ...DEFAULT_OPTIONS, ...optionOverrides };
  const nodes = normalizeNodes(nodesInput);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const excluded = new Set(excludedIds || []);
  const edges = normalizeEdges(edgesInput, nodesById).filter((edge) => (
    !excluded.has(edge.sourceId)
    && !excluded.has(edge.targetId)
    && !nodesById.get(edge.sourceId)?.obstacleOnly
    && !nodesById.get(edge.targetId)?.obstacleOnly
  ));
  const vectors = edges.map((edge) => edgeVector(edge, nodesById)).filter(Boolean);
  let horizontal = true;

  if (vectors.length) {
    const horizontalScore = vectors.reduce((total, vector) => total + Math.abs(vector.dx), 0);
    const verticalScore = vectors.reduce((total, vector) => total + Math.abs(vector.dy), 0);
    horizontal = horizontalScore >= verticalScore;
  } else {
    const fixed = nodes.filter((node) => !excluded.has(node.id) && !node.obstacleOnly);
    const bounds = getBounds(fixed.map(toRect));
    horizontal = !bounds || bounds.width >= bounds.height;
  }

  const primaryDeltas = vectors.map((vector) => horizontal ? vector.dx : vector.dy);
  const direction = primaryDeltas.reduce((total, delta) => total + Math.sign(delta), 0) < 0 ? -1 : 1;
  const rankGaps = vectors.map((vector) => {
    const source = nodesById.get(vector.sourceId);
    const target = nodesById.get(vector.targetId);

    if (horizontal) {
      return Math.abs(vector.dx) - ((source.width + target.width) / 2);
    }

    return Math.abs(vector.dy) - ((source.height + target.height) / 2);
  }).filter((gap) => gap > 20);
  const rankGap = clamp(median(rankGaps) || options.rankGap, 90, 360);
  const rowGaps = inferRowGaps(nodes, excluded, horizontal, edges);
  const rowGap = clamp(median(rowGaps) || options.rowGap, 50, 180);

  return {
    axis: horizontal ? "horizontal" : "vertical",
    direction,
    rankdir: horizontal
      ? (direction > 0 ? "LR" : "RL")
      : (direction > 0 ? "TB" : "BT"),
    rankGap,
    rowGap,
  };
}

export function planEdgePresentation(input = {}, optionOverrides = {}) {
  const options = {
    canvasPadding: DEFAULT_OPTIONS.canvasPadding,
    labelGap: 10,
    labelOffset: 24,
    ...optionOverrides,
  };
  const nodes = normalizeNodes(input.nodes);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = normalizeEdges(input.edges, nodesById);
  const obstacles = nodes.filter((node) => !node.obstacleOnly).map(toRect);
  const placedLabels = [];

  return edges.map((edge) => {
    const source = nodesById.get(edge.sourceId);
    const target = nodesById.get(edge.targetId);
    const ports = edgePorts(source, target);
    const segments = orthogonalEdgeSegments(source, target);
    const size = measureEdgeLabel(edge.label);
    const candidates = edgeLabelCandidates(options.labelOffset);
    let best = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const anchor = pointAlongSegments(segments, (candidate.x + 1) / 2);
      const rect = {
        id: `label-${edge.id}`,
        x: anchor.point.x + (anchor.normal.x * candidate.y) - (size.width / 2),
        y: anchor.point.y + (anchor.normal.y * candidate.y) - (size.height / 2),
        width: size.width,
        height: size.height,
      };
      let score = index * 0.05;

      if (rect.x < options.canvasPadding || rect.y < options.canvasPadding) {
        score += 8;
      }

      for (const obstacle of obstacles) {
        if (rectanglesOverlap(rect, obstacle, options.labelGap)) {
          score += obstacle.id === edge.sourceId || obstacle.id === edge.targetId ? 12 : 30;
        }
      }

      for (const placed of placedLabels) {
        if (rectanglesOverlap(rect, placed, options.labelGap)) {
          score += 40;
        }
      }

      if (!best || score < best.score) {
        best = { ...candidate, rect, score };
      }
    }

    placedLabels.push(best.rect);
    return {
      id: edge.id,
      ...ports,
      labelX: best.x,
      labelY: best.y,
      labelBounds: best.rect,
    };
  });
}

function edgePorts(source, target) {
  const sourceCenter = centerOf(source);
  const targetCenter = centerOf(target);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const forward = dx >= 0;
    return {
      axis: "horizontal",
      exitX: forward ? 1 : 0,
      exitY: 0.5,
      entryX: forward ? 0 : 1,
      entryY: 0.5,
    };
  }

  const forward = dy >= 0;
  return {
    axis: "vertical",
    exitX: 0.5,
    exitY: forward ? 1 : 0,
    entryX: 0.5,
    entryY: forward ? 0 : 1,
  };
}

function edgeLabelCandidates(offset) {
  const distance = Math.max(18, finiteNumber(offset, 24));
  const result = [];

  for (const x of [0, -0.25, 0.25, -0.5, 0.5]) {
    result.push(
      { x, y: -distance },
      { x, y: distance },
      { x, y: -Math.round(distance * 1.5) },
      { x, y: Math.round(distance * 1.5) },
    );
  }

  return result;
}

function pointAlongSegments(segments, fraction) {
  const fallback = segments[0] || [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  const lengths = segments.map(([start, end]) => Math.hypot(end.x - start.x, end.y - start.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = clamp(fraction, 0, 1) * total;

  for (let index = 0; index < segments.length; index += 1) {
    const [start, end] = segments[index];
    const length = lengths[index];

    if (remaining <= length || index === segments.length - 1) {
      const ratio = length ? clamp(remaining / length, 0, 1) : 0;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      return {
        point: {
          x: start.x + (dx * ratio),
          y: start.y + (dy * ratio),
        },
        normal: length ? { x: -dy / length, y: dx / length } : { x: 0, y: 1 },
      };
    }

    remaining -= length;
  }

  return {
    point: { ...fallback[0] },
    normal: { x: 0, y: 1 },
  };
}

function layoutComponent(context) {
  const {
    componentIds,
    nodes,
    nodesById,
    edges,
    hints,
    originIds,
    occupied,
    profile,
    options,
  } = context;
  const componentSet = new Set(componentIds);
  const anchorIds = collectAnchorIds(componentSet, edges, hints, nodesById);
  const relevantIds = new Set([...componentIds, ...anchorIds]);
  const componentEdges = edges.filter((edge) => (
    relevantIds.has(edge.sourceId)
    && relevantIds.has(edge.targetId)
    && (componentSet.has(edge.sourceId) || componentSet.has(edge.targetId))
  ));
  const componentHints = hints.filter((hint) => (
    componentSet.has(hint.nodeId) && relevantIds.has(hint.anchorId)
  ));
  const rankdir = chooseComponentRankdir({
    componentSet,
    anchorIds,
    nodesById,
    edges,
    componentEdges,
    profile,
    options,
  });
  const longestLabelWidth = Math.max(
    0,
    ...componentEdges.map((edge) => measureEdgeLabel(edge.label).width),
  );
  const dagreRankGap = Math.max(48, profile.rankGap - longestLabelWidth);
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir,
    ranksep: dagreRankGap,
    nodesep: profile.rowGap,
    edgesep: Math.max(30, Math.round(profile.rowGap / 2)),
    marginx: 0,
    marginy: 0,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const id of relevantIds) {
    const node = nodesById.get(id);
    graph.setNode(id, { width: node.width, height: node.height });
  }

  let edgeIndex = 0;

  for (const edge of componentEdges) {
    const [sourceId, targetId] = orientLayoutEdge(edge, componentSet, anchorIds);
    const labelSize = measureEdgeLabel(edge.label);
    graph.setEdge(sourceId, targetId, {
      width: labelSize.width,
      height: labelSize.height,
      labelpos: "c",
      weight: edge.arrow === "none" ? 1 : 2,
    }, `edge-${edgeIndex}`);
    edgeIndex += 1;
  }

  for (const hint of componentHints) {
    const hasRealEdge = componentEdges.some((edge) => (
      (edge.sourceId === hint.nodeId && edge.targetId === hint.anchorId)
      || (edge.sourceId === hint.anchorId && edge.targetId === hint.nodeId)
    ));

    if (!hasRealEdge) {
      graph.setEdge(hint.anchorId, hint.nodeId, { weight: 1 }, `hint-${edgeIndex}`);
      edgeIndex += 1;
    }
  }

  dagre.layout(graph);

  const rawRects = componentIds.map((id) => {
    const node = nodesById.get(id);
    const result = graph.node(id);
    return {
      id,
      x: result.x - (node.width / 2),
      y: result.y - (node.height / 2),
      width: node.width,
      height: node.height,
    };
  });
  const baseOffset = anchorIds.length
    ? getAnchorOffset(anchorIds, graph, nodesById, edges)
    : componentIds.some((id) => originIds.has(id))
      ? getOriginOffset(componentIds.filter((id) => originIds.has(id)), graph, nodesById)
      : getIndependentOffset(rawRects, occupied, options);
  const offset = findCollisionFreeOffset({
    rawRects,
    baseOffset,
    occupied,
    nodesById,
    edges,
    profile: { ...profile, rankdir },
    options,
  });

  return rawRects.map((rect) => ({
    id: rect.id,
    x: Math.max(options.canvasPadding, snapToGrid(rect.x + offset.x, options.gridSize)),
    y: Math.max(options.canvasPadding, snapToGrid(rect.y + offset.y, options.gridSize)),
  }));
}

function normalizeNodes(input) {
  const seen = new Set();
  const nodes = [];

  for (const item of Array.isArray(input) ? input : []) {
    const id = String(item?.id || "").trim();

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    nodes.push({
      id,
      x: finiteNumber(item.x),
      y: finiteNumber(item.y),
      width: Math.max(40, finiteNumber(item.width, 180)),
      height: Math.max(30, finiteNumber(item.height, 56)),
      obstacleOnly: Boolean(item.obstacleOnly),
    });
  }

  return nodes;
}

function normalizeEdges(input, nodesById) {
  return (Array.isArray(input) ? input : []).flatMap((item, index) => {
    const sourceId = String(item?.sourceId || item?.source || "").trim();
    const targetId = String(item?.targetId || item?.target || "").trim();

    if (!sourceId || !targetId || sourceId === targetId || !nodesById.has(sourceId) || !nodesById.has(targetId)) {
      return [];
    }

    return [{
      id: String(item?.id || `edge-${index}`),
      sourceId,
      targetId,
      label: String(item?.label || item?.relation || "").trim().slice(0, 40),
      arrow: normalizeArrow(item?.arrow || item?.relationArrow),
    }];
  });
}

function expandConnectedNodeIds(seedIds, edges, nodesById) {
  const expanded = new Set(Array.from(seedIds).filter((id) => !nodesById.get(id)?.obstacleOnly));
  const adjacency = new Map(Array.from(nodesById, ([id, node]) => (
    node.obstacleOnly ? null : [id, new Set()]
  )).filter(Boolean));

  for (const edge of edges) {
    if (!adjacency.has(edge.sourceId) || !adjacency.has(edge.targetId)) {
      continue;
    }

    adjacency.get(edge.sourceId).add(edge.targetId);
    adjacency.get(edge.targetId).add(edge.sourceId);
  }

  const pending = [...expanded];

  while (pending.length) {
    const id = pending.pop();

    for (const neighbor of adjacency.get(id) || []) {
      if (!expanded.has(neighbor)) {
        expanded.add(neighbor);
        pending.push(neighbor);
      }
    }
  }

  return expanded;
}

function normalizeHints(input, nodesById, movableIds) {
  return (Array.isArray(input) ? input : []).flatMap((item) => {
    const nodeId = String(item?.nodeId || "").trim();
    const anchorId = String(item?.anchorId || item?.nearNodeId || "").trim();

    if (!movableIds.has(nodeId) || !nodesById.has(anchorId) || nodeId === anchorId) {
      return [];
    }

    return [{ nodeId, anchorId }];
  });
}

function collectMovableComponents(movableIds, edges, hints) {
  const adjacency = new Map(Array.from(movableIds, (id) => [id, new Set()]));

  for (const edge of edges) {
    if (movableIds.has(edge.sourceId) && movableIds.has(edge.targetId)) {
      adjacency.get(edge.sourceId).add(edge.targetId);
      adjacency.get(edge.targetId).add(edge.sourceId);
    }
  }

  for (const hint of hints) {
    if (movableIds.has(hint.anchorId)) {
      adjacency.get(hint.nodeId).add(hint.anchorId);
      adjacency.get(hint.anchorId).add(hint.nodeId);
    }
  }

  const components = [];
  const visited = new Set();

  for (const start of movableIds) {
    if (visited.has(start)) {
      continue;
    }

    const component = [];
    const stack = [start];
    visited.add(start);

    while (stack.length) {
      const current = stack.pop();
      component.push(current);

      for (const neighbor of adjacency.get(current) || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }

    components.push(component);
  }

  const anchored = [];
  const independent = [];

  for (const component of components) {
    const set = new Set(component);
    const hasAnchor = edges.some((edge) => (
      (set.has(edge.sourceId) && !movableIds.has(edge.targetId))
      || (set.has(edge.targetId) && !movableIds.has(edge.sourceId))
    )) || hints.some((hint) => set.has(hint.nodeId) && !movableIds.has(hint.anchorId));

    if (hasAnchor || component.length > 1) {
      anchored.push(component);
    } else {
      independent.push(...component);
    }
  }

  if (independent.length) {
    anchored.push(independent);
  }

  return anchored;
}

function collectAnchorIds(componentSet, edges, hints, nodesById) {
  const anchors = new Set();

  for (const edge of edges) {
    if (componentSet.has(edge.sourceId) && !componentSet.has(edge.targetId)) {
      anchors.add(edge.targetId);
    }

    if (componentSet.has(edge.targetId) && !componentSet.has(edge.sourceId)) {
      anchors.add(edge.sourceId);
    }
  }

  for (const hint of hints) {
    if (componentSet.has(hint.nodeId) && !componentSet.has(hint.anchorId)) {
      anchors.add(hint.anchorId);
    }
  }

  return [...anchors].filter((id) => !nodesById.get(id)?.obstacleOnly);
}

function chooseComponentRankdir({ componentSet, anchorIds, nodesById, edges, componentEdges, profile, options }) {
  if (anchorIds.length !== 1) {
    return profile.rankdir;
  }

  const anchorId = anchorIds[0];
  const anchor = nodesById.get(anchorId);
  let rankdir = profile.rankdir;

  if (componentEdges.every((edge) => edge.arrow === "none")) {
    const anchorCenter = centerOf(anchor);
    let positive = 0;
    let negative = 0;

    for (const edge of edges) {
      const otherId = edge.sourceId === anchorId
        ? edge.targetId
        : edge.targetId === anchorId ? edge.sourceId : "";

      if (!otherId || componentSet.has(otherId)) {
        continue;
      }

      const other = nodesById.get(otherId);

      if (!other || other.obstacleOnly) {
        continue;
      }

      const otherCenter = centerOf(other);
      const delta = profile.axis === "horizontal"
        ? otherCenter.x - anchorCenter.x
        : otherCenter.y - anchorCenter.y;

      if (delta >= 0) {
        positive += 1;
      } else {
        negative += 1;
      }
    }

    if (positive !== negative) {
      const usePositiveSide = positive < negative;
      rankdir = profile.axis === "horizontal"
        ? (usePositiveSide ? "LR" : "RL")
        : (usePositiveSide ? "TB" : "BT");
    }
  }

  const anchorEdge = componentEdges.find((edge) => (
    (edge.sourceId === anchorId && componentSet.has(edge.targetId))
    || (edge.targetId === anchorId && componentSet.has(edge.sourceId))
  ));

  if (!anchorEdge) {
    return rankdir;
  }

  const [layoutSource, layoutTarget] = orientLayoutEdge(anchorEdge, componentSet, anchorIds);
  const positiveRankdir = rankdir === "LR" || rankdir === "TB";
  const movableUsesNegativeSide = layoutSource === anchorId
    ? !positiveRankdir
    : layoutTarget === anchorId && positiveRankdir;

  if (!movableUsesNegativeSide) {
    return rankdir;
  }

  const longestLabel = Math.max(0, ...componentEdges.map((edge) => measureEdgeLabel(edge.label).width));
  const largestNode = Math.max(0, ...Array.from(componentSet, (id) => {
    const node = nodesById.get(id);
    return profile.axis === "horizontal" ? node.width : node.height;
  }));
  const availableNegativeSpace = profile.axis === "horizontal"
    ? anchor.x - options.canvasPadding
    : anchor.y - options.canvasPadding;
  const requiredNegativeSpace = largestNode + Math.max(profile.rankGap, longestLabel + 48);

  return availableNegativeSpace < requiredNegativeSpace
    ? reverseRankdir(rankdir)
    : rankdir;
}

function reverseRankdir(rankdir) {
  return { LR: "RL", RL: "LR", TB: "BT", BT: "TB" }[rankdir] || rankdir;
}

function orientLayoutEdge(edge, componentSet, anchorIds) {
  let sourceId = edge.sourceId;
  let targetId = edge.targetId;

  if (edge.arrow === "backward") {
    [sourceId, targetId] = [targetId, sourceId];
  }

  if (edge.arrow === "none" && anchorIds.length === 1) {
    const anchorId = anchorIds[0];
    const otherId = sourceId === anchorId ? targetId : targetId === anchorId ? sourceId : "";

    if (otherId && componentSet.has(otherId)) {
      return [anchorId, otherId];
    }
  }

  return [sourceId, targetId];
}

function getAnchorOffset(anchorIds, graph, nodesById, edges) {
  const ordered = [...anchorIds].sort((first, second) => (
    connectionCount(second, edges) - connectionCount(first, edges)
  ));
  const offsets = ordered.map((id) => {
    const actual = centerOf(nodesById.get(id));
    const layoutNode = graph.node(id);
    return {
      x: actual.x - layoutNode.x,
      y: actual.y - layoutNode.y,
    };
  });

  return {
    x: median(offsets.map((offset) => offset.x)),
    y: median(offsets.map((offset) => offset.y)),
  };
}

function getOriginOffset(originIds, graph, nodesById) {
  const offsets = originIds.map((id) => {
    const actual = centerOf(nodesById.get(id));
    const layoutNode = graph.node(id);
    return {
      x: actual.x - layoutNode.x,
      y: actual.y - layoutNode.y,
    };
  });

  return {
    x: median(offsets.map((offset) => offset.x)),
    y: median(offsets.map((offset) => offset.y)),
  };
}

function getIndependentOffset(rawRects, occupied, options) {
  const componentBounds = getBounds(rawRects);
  const occupiedBounds = getBounds(occupied);
  const preferredX = occupiedBounds
    ? Math.max(options.canvasPadding, occupiedBounds.x)
    : options.topX;
  const preferredY = occupiedBounds
    ? occupiedBounds.y + occupiedBounds.height + options.componentGap
    : options.topY;

  return {
    x: preferredX - componentBounds.x,
    y: preferredY - componentBounds.y,
  };
}

function findCollisionFreeOffset(context) {
  const {
    rawRects,
    baseOffset,
    occupied,
    nodesById,
    edges,
    profile,
    options,
  } = context;
  const crossStep = Math.max(100, profile.rowGap + averageSize(rawRects, profile.axis === "horizontal" ? "height" : "width"));
  const rankStep = Math.max(180, profile.rankGap + averageSize(rawRects, profile.axis === "horizontal" ? "width" : "height"));
  const candidates = [{ x: 0, y: 0 }];

  for (let index = 1; index <= 10; index += 1) {
    if (profile.axis === "horizontal") {
      candidates.push({ x: 0, y: index * crossStep }, { x: 0, y: -index * crossStep });
    } else {
      candidates.push({ x: index * crossStep, y: 0 }, { x: -index * crossStep, y: 0 });
    }
  }

  for (let index = 1; index <= 6; index += 1) {
    if (profile.axis === "horizontal") {
      candidates.push({ x: index * rankStep, y: 0 }, { x: -index * rankStep, y: 0 });
    } else {
      candidates.push({ x: 0, y: index * rankStep }, { x: 0, y: -index * rankStep });
    }
  }

  let best = { ...baseOffset };
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const offset = constrainOffsetToCanvas(rawRects, {
      x: baseOffset.x + candidate.x,
      y: baseOffset.y + candidate.y,
    }, options.canvasPadding);
    const positioned = rawRects.map((rect) => ({
      ...rect,
      x: snapToGrid(rect.x + offset.x, options.gridSize),
      y: snapToGrid(rect.y + offset.y, options.gridSize),
    }));
    const score = collisionScore({
      positioned,
      occupied,
      nodesById,
      edges,
      options,
    });

    if (score === 0) {
      return offset;
    }

    if (score < bestScore) {
      best = offset;
      bestScore = score;
    }
  }

  return best;
}

function constrainOffsetToCanvas(rawRects, offset, canvasPadding) {
  const minimumX = Math.min(...rawRects.map((rect) => rect.x + offset.x));
  const minimumY = Math.min(...rawRects.map((rect) => rect.y + offset.y));
  return {
    x: offset.x + Math.max(0, canvasPadding - minimumX),
    y: offset.y + Math.max(0, canvasPadding - minimumY),
  };
}

function collisionScore({ positioned, occupied, nodesById, edges, options }) {
  let score = 0;

  for (let index = 0; index < positioned.length; index += 1) {
    const rect = positioned[index];

    if (rect.x < options.canvasPadding || rect.y < options.canvasPadding) {
      score += 20;
    }

    for (const obstacle of occupied) {
      if (rectanglesOverlap(rect, obstacle, options.nodeGap)) {
        score += 10;
      }
    }

    for (let otherIndex = index + 1; otherIndex < positioned.length; otherIndex += 1) {
      if (rectanglesOverlap(rect, positioned[otherIndex], options.nodeGap)) {
        score += 10;
      }
    }
  }

  const positionedById = new Map(positioned.map((rect) => [rect.id, rect]));
  const resolvedRectsById = new Map(Array.from(nodesById, ([id, node]) => [
    id,
    positionedById.get(id) || toRect(node),
  ]));

  for (const rect of positioned) {
    for (const edge of edges) {
      if (edge.sourceId === rect.id || edge.targetId === rect.id) {
        continue;
      }

      const source = resolvedRectsById.get(edge.sourceId);
      const target = resolvedRectsById.get(edge.targetId);

      if (!source || !target) {
        continue;
      }

      const crossesEdge = orthogonalEdgeSegments(source, target).some((segment) => (
        rectIntersectsSegmentCorridor(rect, segment, options.edgeClearance)
      ));

      if (crossesEdge) {
        score += 8;
      }
    }
  }

  const labels = [];

  for (const edge of edges.filter((item) => item.label)) {
    const source = resolvedRectsById.get(edge.sourceId);
    const target = resolvedRectsById.get(edge.targetId);

    if (!source || !target) {
      continue;
    }

    const label = edgeLabelRect(source, target, edge.label, edge.id);
    const moving = positionedById.has(edge.sourceId) || positionedById.has(edge.targetId);
    labels.push({ rect: label, moving });

    if (moving && (label.x < options.canvasPadding || label.y < options.canvasPadding)) {
      score += 4;
    }

    for (const obstacle of positioned) {
      if (obstacle.id === edge.sourceId || obstacle.id === edge.targetId) {
        continue;
      }

      if (rectanglesOverlap(label, obstacle, 8)) {
        score += 4;
      }
    }

    if (moving) {
      for (const obstacle of occupied) {
        if (obstacle.id === edge.sourceId || obstacle.id === edge.targetId) {
          continue;
        }

        if (rectanglesOverlap(label, obstacle, 8)) {
          score += 3;
        }
      }
    }
  }

  for (let index = 0; index < labels.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < labels.length; otherIndex += 1) {
      const first = labels[index];
      const second = labels[otherIndex];

      if ((first.moving || second.moving) && rectanglesOverlap(first.rect, second.rect, 8)) {
        score += 2;
      }
    }
  }

  return score;
}

function orthogonalEdgeSegments(source, target) {
  const sourceCenter = centerOf(source);
  const targetCenter = centerOf(target);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const direction = Math.sign(dx) || 1;
    const start = {
      x: sourceCenter.x + (direction * source.width / 2),
      y: sourceCenter.y,
    };
    const end = {
      x: targetCenter.x - (direction * target.width / 2),
      y: targetCenter.y,
    };
    const middleX = (start.x + end.x) / 2;
    return compactSegments([
      [start, { x: middleX, y: start.y }],
      [{ x: middleX, y: start.y }, { x: middleX, y: end.y }],
      [{ x: middleX, y: end.y }, end],
    ]);
  }

  const direction = Math.sign(dy) || 1;
  const start = {
    x: sourceCenter.x,
    y: sourceCenter.y + (direction * source.height / 2),
  };
  const end = {
    x: targetCenter.x,
    y: targetCenter.y - (direction * target.height / 2),
  };
  const middleY = (start.y + end.y) / 2;
  return compactSegments([
    [start, { x: start.x, y: middleY }],
    [{ x: start.x, y: middleY }, { x: end.x, y: middleY }],
    [{ x: end.x, y: middleY }, end],
  ]);
}

function compactSegments(segments) {
  return segments.filter(([start, end]) => start.x !== end.x || start.y !== end.y);
}

function rectIntersectsSegmentCorridor(rect, segment, clearance) {
  const [start, end] = segment;
  const padding = Math.max(0, finiteNumber(clearance));
  const corridor = {
    x: Math.min(start.x, end.x) - padding,
    y: Math.min(start.y, end.y) - padding,
    width: Math.abs(end.x - start.x) + (padding * 2),
    height: Math.abs(end.y - start.y) + (padding * 2),
  };
  return rectanglesOverlap(rect, corridor);
}

function edgeVector(edge, nodesById) {
  let source = nodesById.get(edge.sourceId);
  let target = nodesById.get(edge.targetId);

  if (!source || !target) {
    return null;
  }

  if (edge.arrow === "backward") {
    [source, target] = [target, source];
  }

  const sourceCenter = centerOf(source);
  const targetCenter = centerOf(target);
  return {
    sourceId: source.id,
    targetId: target.id,
    dx: targetCenter.x - sourceCenter.x,
    dy: targetCenter.y - sourceCenter.y,
  };
}

function inferRowGaps(nodes, excluded, horizontal, edges) {
  const fixed = nodes.filter((node) => !excluded.has(node.id) && !node.obstacleOnly);
  const neighbors = new Map(fixed.map((node) => [node.id, new Set()]));
  const gaps = [];

  for (const edge of edges) {
    neighbors.get(edge.sourceId)?.add(edge.targetId);
    neighbors.get(edge.targetId)?.add(edge.sourceId);
  }

  for (let firstIndex = 0; firstIndex < fixed.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < fixed.length; secondIndex += 1) {
      const first = fixed[firstIndex];
      const second = fixed[secondIndex];
      const sharesNeighbor = Array.from(neighbors.get(first.id) || []).some((id) => (
        neighbors.get(second.id)?.has(id)
      ));

      if (!sharesNeighbor) {
        continue;
      }

      const firstCenter = centerOf(first);
      const secondCenter = centerOf(second);
      const rankDelta = horizontal
        ? Math.abs(firstCenter.x - secondCenter.x)
        : Math.abs(firstCenter.y - secondCenter.y);
      const sameRankThreshold = horizontal
        ? Math.max(first.width, second.width) / 2
        : Math.max(first.height, second.height) / 2;

      if (rankDelta > sameRankThreshold) {
        continue;
      }

      const gap = horizontal
        ? Math.abs(firstCenter.y - secondCenter.y) - ((first.height + second.height) / 2)
        : Math.abs(firstCenter.x - secondCenter.x) - ((first.width + second.width) / 2);

      if (gap > 20) {
        gaps.push(gap);
      }
    }
  }

  return gaps;
}

function measureEdgeLabel(label) {
  if (!label) {
    return { width: 0, height: 0 };
  }

  return {
    width: clamp(Math.ceil(visualTextLength(label) * 7.2) + 32, 64, 560),
    height: 28,
  };
}

function edgeLabelRect(source, target, label, id) {
  const sourceCenter = centerOf(source);
  const targetCenter = centerOf(target);
  const size = measureEdgeLabel(label);
  return {
    id: `label-${id}`,
    x: ((sourceCenter.x + targetCenter.x) / 2) - (size.width / 2),
    y: ((sourceCenter.y + targetCenter.y) / 2) - (size.height / 2),
    width: size.width,
    height: size.height,
  };
}

function normalizeArrow(value) {
  const arrow = String(value || "forward").toLowerCase();
  return ["none", "forward", "backward", "both"].includes(arrow) ? arrow : "forward";
}

function connectionCount(id, edges) {
  return edges.reduce((total, edge) => (
    total + Number(edge.sourceId === id || edge.targetId === id)
  ), 0);
}

function centerOf(rect) {
  return {
    x: rect.x + (rect.width / 2),
    y: rect.y + (rect.height / 2),
  };
}

function toRect(node) {
  return {
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  };
}

function getBounds(rects) {
  if (!rects.length) {
    return null;
  }

  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function rectanglesOverlap(first, second, gap = 0) {
  return first.x < second.x + second.width + gap
    && first.x + first.width + gap > second.x
    && first.y < second.y + second.height + gap
    && first.y + first.height + gap > second.y;
}

function snapToGrid(value, gridSize) {
  return Math.round(value / gridSize) * gridSize;
}

function averageSize(rects, field) {
  if (!rects.length) {
    return 0;
  }

  return rects.reduce((total, rect) => total + rect[field], 0) / rects.length;
}

function visualTextLength(text) {
  return Array.from(String(text || "")).reduce((total, char) => (
    total + (/[^\u0000-\u00ff]/.test(char) ? 1.8 : 1)
  ), 0);
}

function median(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
