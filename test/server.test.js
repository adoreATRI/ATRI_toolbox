import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  augmentOperationPlanWithExplicitRelations,
  buildMindMapOperationMessages,
  createLocalOperationPlan,
  normalizeGeneratedNodeContent,
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

  const vendorResponse = await fetch(`${baseUrl}/vendor/dagre.esm.js`);
  const vendorSource = await vendorResponse.text();
  assert.equal(vendorResponse.status, 200);
  assert.match(vendorResponse.headers.get("content-type"), /^text\/javascript/);
  assert.match(vendorSource, /dagre/);
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

test("separates generated node names from explicit notes", () => {
  const cases = [
    ["创建一个名为兰斯的节点，备注为近卫骑士", "兰斯", "近卫骑士"],
    ["生成节点，名字是兰斯，备注是近卫骑士", "兰斯", "近卫骑士"],
    ["新增角色兰斯，身份是近卫骑士", "兰斯", "近卫骑士"],
    ["创建兰斯，他是近卫骑士", "兰斯", "近卫骑士"],
    ["创建一个节点兰斯，他的职业是近卫骑士", "兰斯", "近卫骑士"],
    ["创建兰斯（近卫骑士）节点", "兰斯", "近卫骑士"],
  ];

  for (const [description, title, noteText] of cases) {
    const plan = createLocalOperationPlan(diagram(), description);
    assert.deepEqual(plan.operations, [{
      type: "add_node",
      nodeId: "new-1",
      title,
      note: noteText,
    }]);
  }
});

test("keeps per-node notes and rejects ambiguous shared notes", () => {
  const explicit = createLocalOperationPlan(
    diagram(),
    "生成两个节点：兰斯（近卫骑士）、希露（女仆）",
  );
  const shared = createLocalOperationPlan(diagram(), "创建兰斯和希露，备注均为主要角色");

  assert.deepEqual(explicit.operations.map(({ title, note: noteText }) => ({ title, note: noteText })), [
    { title: "兰斯", note: "近卫骑士" },
    { title: "希露", note: "女仆" },
  ]);
  assert.deepEqual(shared.operations.map(({ title, note: noteText }) => ({ title, note: noteText })), [
    { title: "兰斯", note: "主要角色" },
    { title: "希露", note: "主要角色" },
  ]);
  assert.equal(createLocalOperationPlan(diagram(), "创建兰斯和希露，备注为主要角色"), null);
  assert.equal(createLocalOperationPlan(diagram(), "创建兰斯，他与希露是朋友"), null);
  assert.equal(createLocalOperationPlan(diagram(), "创建兰斯，他是希露的朋友"), null);
});

test("cleans malformed model node fields before applying them", () => {
  assert.deepEqual(
    normalizeGeneratedNodeContent("创建一个名为兰斯的节点，备注为近卫骑士", ""),
    { title: "兰斯", note: "近卫骑士" },
  );
  assert.deepEqual(normalizeGeneratedNodeContent("角色管理", ""), { title: "角色管理", note: "" });
  assert.deepEqual(normalizeGeneratedNodeContent("创建者", ""), { title: "创建者", note: "" });
  assert.deepEqual(normalizeOperationPlan({
    operations: [{
      type: "add_node",
      clientId: "lance",
      title: "名为兰斯的节点",
      note: "备注：近卫骑士",
    }],
  }, diagram()).operations, [{
    type: "add_node",
    nodeId: "lance",
    title: "兰斯",
    note: "近卫骑士",
  }]);
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

test("parses a progressive relationship chain without model assistance", () => {
  const plan = createLocalOperationPlan(diagram(), "莉亚爱慕兰斯，加奈多服侍莉亚");
  const styledPlan = createLocalOperationPlan(diagram(), "莉亚爱慕兰斯，使用虚线");
  const additions = plan.operations.filter((operation) => operation.type === "add_node");
  const connections = plan.operations.filter((operation) => operation.type === "connect");
  const idsByTitle = new Map(additions.map((operation) => [operation.title, operation.nodeId]));

  assert.deepEqual([...idsByTitle.keys()], ["莉亚", "兰斯", "加奈多"]);
  assert.deepEqual(connections.map((operation) => ({
    sourceId: operation.sourceId,
    targetId: operation.targetId,
    label: operation.label,
    arrow: operation.arrow,
  })), [
    {
      sourceId: idsByTitle.get("莉亚"),
      targetId: idsByTitle.get("兰斯"),
      label: "爱慕",
      arrow: "forward",
    },
    {
      sourceId: idsByTitle.get("加奈多"),
      targetId: idsByTitle.get("莉亚"),
      label: "服侍",
      arrow: "forward",
    },
  ]);
  assert.equal(styledPlan.operations.find((operation) => operation.type === "connect").line, "dashed");
});

test("allocates fresh local references across consecutive descriptions", () => {
  const currentDiagram = diagram({
    nodes: [
      node("new-1", "莉亚"),
      node("new-2", "兰斯"),
    ],
    edges: [{
      id: "ai-edge",
      sourceId: "new-1",
      targetId: "new-2",
      label: "爱慕",
      arrow: "forward",
      line: "solid",
    }],
    cellIds: ["new-1", "new-2", "ai-edge"],
  });
  const plan = createLocalOperationPlan(currentDiagram, "加奈多服侍莉亚");
  const addition = plan.operations.find((operation) => operation.type === "add_node");
  const connection = plan.operations.find((operation) => operation.type === "connect");

  assert.equal(addition.nodeId, "new-3");
  assert.equal(addition.title, "加奈多");
  assert.equal(connection.sourceId, "new-3");
  assert.equal(connection.targetId, "new-1");
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

test("parses explicit connection commands without creating bogus nodes", () => {
  const currentDiagram = diagram({
    nodes: [node("node-lance", "兰斯"), node("node-shilou", "希露")],
  });
  const cases = [
    ["连接兰斯和希露，关系是朋友", "朋友", "none"],
    ["将兰斯与希露连接，连线描述为同伴", "同伴", "none"],
    ["给兰斯和希露添加一条关系为契约的连线", "契约", "none"],
    ["兰斯连接到希露，连线描述为依赖", "依赖", "forward"],
    ["连接兰斯和希露", "", "none"],
  ];

  for (const [description, label, arrow] of cases) {
    const plan = createLocalOperationPlan(currentDiagram, description);

    assert.deepEqual(plan.operations, [{
      type: "connect",
      edgeId: "ai-edge",
      sourceId: "node-lance",
      targetId: "node-shilou",
      label,
      arrow,
      line: "solid",
    }]);
  }
});

test("understands relationship wording that includes between", () => {
  const currentDiagram = diagram({
    nodes: [node("node-lance", "兰斯"), node("node-shilou", "希露")],
  });
  const plan = createLocalOperationPlan(currentDiagram, "兰斯和希露之间是朋友关系");

  assert.deepEqual(plan.operations, [{
    type: "connect",
    edgeId: "ai-edge",
    sourceId: "node-lance",
    targetId: "node-shilou",
    label: "朋友",
    arrow: "none",
    line: "solid",
  }]);
});

test("creates both missing endpoints before connecting them", () => {
  const plan = createLocalOperationPlan(diagram(), "连接兰斯和希露，关系是同伴");
  const additions = plan.operations.filter((operation) => operation.type === "add_node");
  const connection = plan.operations.find((operation) => operation.type === "connect");

  assert.deepEqual(additions.map((operation) => operation.title), ["兰斯", "希露"]);
  assert.equal(connection.sourceId, additions[0].nodeId);
  assert.equal(connection.targetId, additions[1].nodeId);
  assert.equal(connection.label, "同伴");
  assert.equal(connection.arrow, "none");
});

test("creates and connects a node from an inline mixed intent", () => {
  const plan = createLocalOperationPlan(
    diagram({ nodes: [node("node-lance", "兰斯")] }),
    "创建菲利斯并连接到兰斯",
  );

  assert.deepEqual(plan.operations.map((operation) => operation.type), ["add_node", "connect"]);
  assert.equal(plan.operations[0].title, "菲利斯");
  assert.equal(plan.operations[1].sourceId, plan.operations[0].nodeId);
  assert.equal(plan.operations[1].targetId, "node-lance");
});

test("keeps relationship clauses out of generated node names", () => {
  const plan = createLocalOperationPlan(diagram(), "新增莉亚和加奈多，加奈多服侍莉亚");

  assert.deepEqual(
    plan.operations.filter((operation) => operation.type === "add_node").map((operation) => operation.title),
    ["莉亚", "加奈多"],
  );
  assert.deepEqual(plan.operations.find((operation) => operation.type === "connect"), {
    type: "connect",
    edgeId: "ai-edge",
    sourceId: plan.operations[1].nodeId,
    targetId: plan.operations[0].nodeId,
    label: "服侍",
    arrow: "forward",
    line: "solid",
  });
});

test("adds explicit relationships omitted by a model plan", () => {
  const currentDiagram = diagram();
  const modelPlan = normalizeOperationPlan({
    summary: "已生成节点。",
    operations: [
      { type: "add_node", clientId: "lance", title: "兰斯" },
      { type: "add_node", clientId: "shilou", title: "希露" },
    ],
  }, currentDiagram);
  const plan = augmentOperationPlanWithExplicitRelations(
    modelPlan,
    currentDiagram,
    "生成兰斯和希露，兰斯与希露是同伴关系",
  );

  assert.deepEqual(plan.operations.map((operation) => operation.type), ["add_node", "add_node", "connect"]);
  assert.equal(plan.operations[2].sourceId, plan.operations[0].nodeId);
  assert.equal(plan.operations[2].targetId, plan.operations[1].nodeId);
  assert.equal(plan.operations[2].label, "同伴");
});

test("does not manufacture nodes from ambiguous relationship pronouns", () => {
  const currentDiagram = diagram();
  const modelPlan = normalizeOperationPlan({
    operations: [
      { type: "add_node", clientId: "lance", title: "兰斯" },
      { type: "add_node", clientId: "shilou", title: "希露" },
      { type: "connect", sourceId: "lance", targetId: "shilou", label: "朋友", arrow: "none" },
    ],
  }, currentDiagram);
  const plan = augmentOperationPlanWithExplicitRelations(
    modelPlan,
    currentDiagram,
    "创建兰斯，他与希露是朋友",
  );

  assert.deepEqual(plan.operations, modelPlan.operations);
  assert.equal(plan.operations.some((operation) => operation.title === "他"), false);
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
    createLocalOperationPlan(
      currentDiagram,
      "将兰斯的备注改为近卫骑士负责协调跨区域事务并记录重要结论",
    ).operations,
    [{
      type: "update_node",
      nodeId: "node-lance",
      note: "近卫骑士负责协调跨区域事务并记录重要结论",
    }],
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
  assert.match(prompt, /节点字段必须按语义严格划分/);
  assert.match(prompt, /关系必须使用 connect/);
  assert.match(prompt, /客户端会依据现有拓扑/);
  assert.equal(prompt.includes('"children"'), false);
});
