import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  buildMindMapOperationMessages,
  createLocalOperationPlan,
  normalizeOperationPlan,
} from "../mindmap-ai.js";
import { generateMindMapOperations, startServer } from "../server.js";

let runtime;
let baseUrl;
let serverStartError;

before(async () => {
  try {
    runtime = await startServer(0, { silent: true });
    baseUrl = `http://127.0.0.1:${runtime.port}`;
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") {
      throw error;
    }

    serverStartError = error;
  }
});

after(async () => {
  await runtime?.close();
});

function diagram(overrides = {}) {
  return {
    title: "人物关系",
    nodes: [],
    edges: [],
    ...overrides,
  };
}

function node(id, title, overrides = {}) {
  return {
    id,
    title,
    note: "",
    x: 0,
    y: 0,
    width: 180,
    height: 72,
    ...overrides,
  };
}

function generate(description, currentDiagram = diagram(), settings = {}) {
  return fetch(`${baseUrl}/api/mindmap/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description,
      currentDiagram,
      settings,
    }),
  });
}

function requireHttpRuntime(context) {
  if (runtime) {
    return true;
  }

  context.skip(`Local HTTP listeners are unavailable: ${serverStartError?.code || "unknown error"}`);
  return false;
}

test("serves the application from the local service", async (context) => {
  if (!requireHttpRuntime(context)) {
    return;
  }

  const response = await fetch(baseUrl);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(html, /ATRI Toolbox/);
});

test("rejects browser requests from foreign origins", async (context) => {
  if (!requireHttpRuntime(context)) {
    return;
  }

  const response = await fetch(`${baseUrl}/api/mindmap/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://example.com",
    },
    body: JSON.stringify({ description: "创建节点" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.error, "forbidden_origin");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("creates every explicitly named node as independent operations", () => {
  const plan = createLocalOperationPlan(diagram(), "生成两个节点，一个名叫兰斯，一个叫希露");

  assert.deepEqual(plan.operations.map((operation) => operation.type), ["add_node", "add_node"]);
  assert.deepEqual(plan.operations.map((operation) => operation.title), ["兰斯", "希露"]);
  assert.equal(plan.operations.some((operation) => operation.type === "connect"), false);
});

test("connects existing nodes by stable id without mentioning unrelated nodes", () => {
  const currentDiagram = diagram({
    nodes: [
      node("node-lance", "兰斯", { x: 320, y: 120 }),
      node("node-ferris", "菲利斯", { x: 40, y: 360 }),
      node("node-unrelated", "无关节点", { note: "保持不变", x: 700, y: 40 }),
    ],
  });
  const plan = createLocalOperationPlan(currentDiagram, "菲利斯与兰斯是契约关系");

  assert.deepEqual(plan.operations, [{
    type: "connect",
    edgeId: "ai-edge",
    sourceId: "node-ferris",
    targetId: "node-lance",
    label: "契约",
    arrow: "none",
    line: "solid",
  }]);
  assert.equal(JSON.stringify(plan).includes("node-unrelated"), false);
});

test("adds a missing relation endpoint and connects it to the existing node", () => {
  const plan = createLocalOperationPlan(diagram({
    nodes: [node("node-lance", "兰斯")],
  }), "菲利斯与兰斯是契约关系");

  assert.deepEqual(plan.operations.map((operation) => operation.type), ["add_node", "connect"]);
  assert.equal(plan.operations[0].title, "菲利斯");
  assert.equal(plan.operations[1].sourceId, plan.operations[0].nodeId);
  assert.equal(plan.operations[1].targetId, "node-lance");
  assert.equal(plan.operations[1].label, "契约");
  assert.equal(plan.operations[1].arrow, "none");
});

test("explicit add creates a new id even when another node has the same title", () => {
  const plan = createLocalOperationPlan(diagram({
    nodes: [node("node-lance", "兰斯"), node("node-shilou", "希露")],
  }), "在兰斯下添加一个希露子节点，备注写明测试");

  assert.deepEqual(plan.operations.map((operation) => operation.type), ["add_node", "connect"]);
  assert.notEqual(plan.operations[0].nodeId, "node-shilou");
  assert.equal(plan.operations[0].title, "希露");
  assert.equal(plan.operations[0].note, "测试");
  assert.equal(plan.operations[0].nearNodeId, "node-lance");
  assert.equal(plan.operations[1].targetId, plan.operations[0].nodeId);
});

test("keeps line-style words out of relation endpoint names", () => {
  const plan = createLocalOperationPlan(diagram({
    nodes: [node("node-lance", "兰斯"), node("node-shilou", "希露")],
  }), "兰斯与希露使用虚线建立朋友关系");

  assert.deepEqual(plan.operations, [{
    type: "connect",
    edgeId: "ai-edge",
    sourceId: "node-lance",
    targetId: "node-shilou",
    label: "朋友",
    arrow: "none",
    line: "dashed",
  }]);
});

test("defers mixed intents instead of turning action text into a node name", () => {
  assert.equal(
    createLocalOperationPlan(diagram({ nodes: [node("node-lance", "兰斯")] }), "创建菲利斯并连接到兰斯"),
    null,
  );
});

test("updates an existing edge instead of creating a duplicate", () => {
  const currentDiagram = diagram({
    nodes: [node("node-lance", "兰斯"), node("node-shilou", "希露")],
    edges: [{
      id: "edge-relation",
      sourceId: "node-lance",
      targetId: "node-shilou",
      label: "认识",
      arrow: "none",
      line: "solid",
    }],
  });
  const plan = createLocalOperationPlan(currentDiagram, "兰斯与希露是同伴关系");

  assert.deepEqual(plan.operations, [{
    type: "update_edge",
    edgeId: "edge-relation",
    label: "同伴",
    arrow: "none",
    line: "solid",
  }]);
});

test("targets note, rename, and disconnect operations by exact id", () => {
  const currentDiagram = diagram({
    nodes: [node("node-lance", "兰斯"), node("node-shilou", "希露")],
    edges: [{
      id: "edge-contract",
      sourceId: "node-lance",
      targetId: "node-shilou",
      label: "契约",
      arrow: "none",
      line: "solid",
    }],
  });

  assert.deepEqual(
    createLocalOperationPlan(currentDiagram, "将兰斯的备注改为骑士").operations,
    [{ type: "update_node", nodeId: "node-lance", note: "骑士" }],
  );
  assert.deepEqual(
    createLocalOperationPlan(currentDiagram, "将兰斯重命名为莱因哈鲁特").operations,
    [{ type: "update_node", nodeId: "node-lance", title: "莱因哈鲁特" }],
  );
  assert.deepEqual(
    createLocalOperationPlan(currentDiagram, "断开兰斯与希露之间的关系").operations,
    [{ type: "disconnect", edgeId: "edge-contract" }],
  );
});

test("rejects ambiguous duplicate titles instead of guessing a node", () => {
  const currentDiagram = diagram({
    nodes: [
      node("lance-left", "兰斯", { x: 40 }),
      node("lance-right", "兰斯", { x: 640 }),
    ],
  });
  assert.equal(createLocalOperationPlan(currentDiagram, "将兰斯的备注改为骑士"), null);
});

test("does not manufacture fallback operations for an unrecognized description", () => {
  const plan = createLocalOperationPlan(diagram({
    nodes: [node("node-lance", "兰斯")],
  }), "让这个图更有感觉");

  assert.equal(plan, null);
});

test("returns local and model-required results without an HTTP listener", async () => {
  const local = await generateMindMapOperations({
    description: "菲利斯与兰斯是契约关系",
    currentDiagram: diagram({ nodes: [node("node-lance", "兰斯")] }),
    settings: {},
  });
  const unsafe = await generateMindMapOperations({
    description: "让这个图更有感觉",
    currentDiagram: diagram({ nodes: [node("node-lance", "兰斯")] }),
    settings: {},
  });

  assert.equal(local.status, 200);
  assert.equal(local.payload.source, "local");
  assert.deepEqual(local.payload.operations.map((operation) => operation.type), ["add_node", "connect"]);
  assert.equal(unsafe.status, 422);
  assert.equal(unsafe.payload.error, "model_settings_required");
  assert.equal(Object.hasOwn(unsafe.payload, "operations"), false);
});

test("validates an injected model response as an incremental plan", async () => {
  let receivedMessages;
  const result = await generateMindMapOperations({
    description: "让兰斯的说明更准确",
    currentDiagram: diagram({ nodes: [node("node-lance", "兰斯", { x: 320, y: 120 })] }),
    settings: {
      endpoint: "https://model.invalid/v1/chat/completions",
      model: "test-model",
      apiKey: "test-key",
    },
  }, {
    callChatCompletions: async (_settings, messages) => {
      receivedMessages = messages;
      return JSON.stringify({
        summary: "已更新兰斯的备注。",
        operations: [{
          type: "update_node",
          nodeId: "node-lance",
          note: "近卫骑士",
        }],
      });
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.source, "llm");
  assert.deepEqual(result.payload.operations, [{
    type: "update_node",
    nodeId: "node-lance",
    note: "近卫骑士",
  }]);
  assert.match(receivedMessages[1].content, /"x":320/);
  assert.match(receivedMessages[1].content, /"y":120/);
});

test("rejects a model plan that references an unknown node", async () => {
  const result = await generateMindMapOperations({
    description: "修改兰斯",
    currentDiagram: diagram({ nodes: [node("node-lance", "兰斯")] }),
    settings: {
      endpoint: "https://model.invalid/v1/chat/completions",
      model: "test-model",
      apiKey: "test-key",
    },
  }, {
    callChatCompletions: async () => JSON.stringify({
      operations: [{ type: "update_node", nodeId: "invented-node", note: "错误" }],
    }),
  });

  assert.equal(result.status, 502);
  assert.equal(result.payload.error, "model_plan_failed");
  assert.match(result.payload.message, /不存在的节点/);
});

test("returns the incremental operation contract through the HTTP API", async (context) => {
  if (!requireHttpRuntime(context)) {
    return;
  }

  const response = await generate("菲利斯与兰斯是契约关系", diagram({
    nodes: [node("node-lance", "兰斯")],
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.source, "local");
  assert.deepEqual(payload.operations.map((operation) => operation.type), ["add_node", "connect"]);
  assert.equal(Object.hasOwn(payload, "mindmap"), false);
});

test("rejects an unsafe API request instead of returning fallback content", async (context) => {
  if (!requireHttpRuntime(context)) {
    return;
  }

  const response = await generate("让这个图更有感觉", diagram({
    nodes: [node("node-lance", "兰斯")],
  }));
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.equal(payload.error, "model_settings_required");
  assert.equal(Object.hasOwn(payload, "operations"), false);
});

test("operation validation rejects unknown ids and preserves explicit duplicate-title ids", () => {
  const currentDiagram = diagram({
    nodes: [node("lance-left", "兰斯"), node("lance-right", "兰斯")],
  });

  assert.throws(
    () => normalizeOperationPlan({
      operations: [{ type: "update_node", nodeId: "missing", note: "错误目标" }],
    }, currentDiagram),
    /不存在的节点/,
  );

  assert.deepEqual(normalizeOperationPlan({
    operations: [{ type: "update_node", nodeId: "lance-right", note: "明确目标" }],
  }, currentDiagram).operations, [
    { type: "update_node", nodeId: "lance-right", note: "明确目标" },
  ]);
});

test("operation validation rejects unknown edge styles", () => {
  const currentDiagram = diagram({
    nodes: [node("node-lance", "兰斯"), node("node-shilou", "希露")],
  });

  assert.throws(() => normalizeOperationPlan({
    operations: [{
      type: "connect",
      sourceId: "node-lance",
      targetId: "node-shilou",
      label: "关系",
      arrow: "sideways",
      line: "solid",
    }],
  }, currentDiagram), /无效的连线箭头类型/);
  assert.throws(() => normalizeOperationPlan({
    operations: [{
      type: "connect",
      sourceId: "node-lance",
      targetId: "node-shilou",
      label: "关系",
      arrow: "none",
      line: "wavy",
    }],
  }, currentDiagram), /无效的连线样式/);
});

test("model prompt requests incremental operations rather than a complete map", () => {
  const messages = buildMindMapOperationMessages(diagram({
    nodes: [node("node-lance", "兰斯")],
  }), "修改兰斯");
  const prompt = messages.map((message) => message.content).join("\n");

  assert.match(prompt, /不要返回完整导图/);
  assert.match(prompt, /稳定 id/);
  assert.match(prompt, /没有被描述涉及.*不得出现在 operations/);
  assert.equal(prompt.includes('"children"'), false);
});
