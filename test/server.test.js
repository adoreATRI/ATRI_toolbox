import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startServer } from "../server.js";

let runtime;
let baseUrl;

before(async () => {
  runtime = await startServer(0, { silent: true });
  baseUrl = `http://127.0.0.1:${runtime.port}`;
});

after(async () => {
  await runtime?.close();
});

function generate(description, currentMindMap) {
  return fetch(`${baseUrl}/api/mindmap/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description,
      currentMindMap,
      selectedNodeTitle: currentMindMap.title,
      settings: {},
    }),
  });
}

test("serves the application from the local service", async () => {
  const response = await fetch(baseUrl);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(html, /ATRI Toolbox/);
});

test("rejects browser requests from foreign origins", async () => {
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

test("creates every explicitly named node", async () => {
  const response = await generate("生成两个节点，一个名叫兰斯，一个叫希露", {
    title: "ATRI思维导图",
    note: "",
    children: [],
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.source, "fast-local");
  assert.deepEqual(payload.mindmap.children.map((node) => node.title), ["兰斯", "希露"]);
});

test("adds a symmetric relation without changing unrelated nodes", async () => {
  const response = await generate("菲利斯与兰斯是契约关系", {
    title: "人物关系",
    note: "",
    children: [
      {
        title: "兰斯",
        note: "",
        children: [
          {
            title: "希露",
            note: "原备注",
            relation: "主人/奴隶",
            relationArrow: "forward",
            relationLine: "solid",
            children: [],
          },
        ],
      },
      {
        title: "菲利斯",
        note: "",
        children: [],
      },
      {
        title: "无关节点",
        note: "保持不变",
        children: [],
      },
    ],
  });
  const payload = await response.json();
  const lance = payload.mindmap.children.find((node) => node.title === "兰斯");
  const ferris = lance.children.find((node) => node.title === "菲利斯");
  const unrelated = payload.mindmap.children.find((node) => node.title === "无关节点");

  assert.equal(response.status, 200);
  assert.deepEqual(payload.mindmap.children.map((node) => node.title), ["兰斯", "无关节点"]);
  assert.equal(lance.children.find((node) => node.title === "希露").note, "原备注");
  assert.equal(ferris.relation, "契约");
  assert.equal(ferris.relationArrow, "none");
  assert.equal(unrelated.note, "保持不变");
});
