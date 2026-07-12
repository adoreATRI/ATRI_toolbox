import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inferCanvasLayout,
  planIncrementalNodeLayout,
  resizeRectAroundCenter,
} from "../public/graph-layout.js";

function node(id, x, y, overrides = {}) {
  return {
    id,
    x,
    y,
    width: 180,
    height: 56,
    ...overrides,
  };
}

function edge(id, sourceId, targetId, overrides = {}) {
  return {
    id,
    sourceId,
    targetId,
    label: "",
    arrow: "forward",
    ...overrides,
  };
}

test("learns the existing horizontal direction and center-aligns a related node", () => {
  const nodes = [
    node("anchor", 320, 120),
    node("guide-source", 40, 500),
    node("guide-target", 320, 500),
    node("generated", 80, 760),
  ];
  const edges = [
    edge("guide", "guide-source", "guide-target"),
    edge("relation", "anchor", "generated", { label: "需要完整显示的长期契约关系" }),
  ];
  const result = planIncrementalNodeLayout({
    nodes,
    edges,
    movableNodeIds: ["generated"],
  });
  const generated = result.positions[0];

  assert.equal(result.profile.rankdir, "LR");
  assert.equal(generated.y, 120);
  assert.ok(generated.x >= 680, `expected label-aware spacing, received x=${generated.x}`);
  assert.deepEqual(result.positions.map((position) => position.id), ["generated"]);
});

test("uses the open side of an established relation cluster", () => {
  const nodes = [
    node("lance", 500, 120),
    node("shilou", 780, 120),
    node("ferris", 80, 600),
  ];
  const edges = [
    edge("existing", "lance", "shilou", { label: "主从" }),
    edge("new", "ferris", "lance", { label: "契约", arrow: "none" }),
  ];
  const result = planIncrementalNodeLayout({
    nodes,
    edges,
    movableNodeIds: ["ferris"],
  });
  const ferris = result.positions[0];

  assert.ok(ferris.x < nodes[0].x);
  assert.equal(ferris.y, nodes[0].y);
  assert.ok(ferris.x + nodes[2].width + 34 <= nodes[0].x);
});

test("keeps generated siblings aligned without overlap", () => {
  const nodes = [
    node("anchor", 200, 200),
    node("first", 40, 700),
    node("second", 40, 820),
  ];
  const edges = [
    edge("first-edge", "anchor", "first", { label: "成员" }),
    edge("second-edge", "anchor", "second", { label: "成员" }),
  ];
  const result = planIncrementalNodeLayout({
    nodes,
    edges,
    movableNodeIds: ["first", "second"],
  });
  const [first, second] = result.positions;

  assert.equal(first.x, second.x);
  assert.ok(Math.abs(first.y - second.y) >= 100);
});

test("learns vertical canvases and aligns on the node center", () => {
  const nodes = [
    node("top", 160, 80),
    node("anchor", 160, 360),
    node("generated", 700, 80),
  ];
  const edges = [
    edge("existing", "top", "anchor"),
    edge("new", "anchor", "generated", { label: "下一阶段" }),
  ];
  const profile = inferCanvasLayout(nodes, edges.slice(0, 1), new Set(["generated"]));
  const result = planIncrementalNodeLayout({
    nodes,
    edges,
    movableNodeIds: ["generated"],
  });
  const generated = result.positions[0];

  assert.equal(profile.rankdir, "TB");
  assert.equal(generated.x, 160);
  assert.ok(generated.y > nodes[1].y + nodes[1].height);
});

test("reverses a directed rank when its semantic source would cross the canvas edge", () => {
  const nodes = [
    node("anchor", 100, 120),
    node("guide-source", 100, 420),
    node("guide-target", 380, 420),
    node("generated", 40, 700),
  ];
  const edges = [
    edge("guide", "guide-source", "guide-target"),
    edge("new", "generated", "anchor", { label: "负责", arrow: "forward" }),
  ];
  const result = planIncrementalNodeLayout({
    nodes,
    edges,
    movableNodeIds: ["generated"],
  });
  const generated = result.positions[0];

  assert.ok(generated.x > nodes[0].x);
  assert.ok(generated.x < 600);
  assert.equal(generated.y, nodes[0].y);
});

test("places independent generated nodes together outside occupied content", () => {
  const nodes = [
    node("existing", 80, 80),
    node("first", 80, 80),
    node("second", 80, 80),
  ];
  const result = planIncrementalNodeLayout({
    nodes,
    edges: [],
    movableNodeIds: ["first", "second"],
  });
  const [first, second] = result.positions;

  assert.ok(first.y >= nodes[0].y + nodes[0].height + 90);
  assert.equal(first.x, second.x);
  assert.ok(Math.abs(first.y - second.y) >= 100);
});

test("moves a generated node away from an unrelated connection line", () => {
  const nodes = [
    node("line-start", 80, 200),
    node("line-end", 880, 200),
    node("anchor", 1200, 200),
    node("generated", 40, 700),
  ];
  const edges = [
    edge("existing-line", "line-start", "line-end"),
    edge("new-relation", "generated", "anchor", { label: "新增关系" }),
  ];
  const result = planIncrementalNodeLayout({
    nodes,
    edges,
    movableNodeIds: ["generated"],
  });
  const generated = result.positions[0];
  const edgeCenterY = nodes[0].y + (nodes[0].height / 2);
  const edgeClearance = 18;

  assert.ok(generated.x < nodes[2].x);
  assert.ok(
    generated.y >= edgeCenterY + edgeClearance
      || generated.y + nodes[3].height <= edgeCenterY - edgeClearance,
    `generated node at y=${generated.y} covers the existing edge at y=${edgeCenterY}`,
  );
});

test("resizes a node around its center so alignment does not drift", () => {
  const original = { x: 700, y: 120, width: 180, height: 56 };
  const resized = resizeRectAroundCenter(original, { width: 280, height: 120 });

  assert.deepEqual(resized, {
    x: 650,
    y: 88,
    width: 280,
    height: 120,
  });
  assert.equal(original.x + (original.width / 2), resized.x + (resized.width / 2));
  assert.equal(original.y + (original.height / 2), resized.y + (resized.height / 2));
});
