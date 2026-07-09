import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const defaultPort = Number.parseInt(process.env.PORT || "5174", 10);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
};

export function createToolboxServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (request.method === "POST" && url.pathname === "/api/mindmap/generate") {
        await handleMindMapGeneration(request, response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/llm/test") {
        await handleConnectionTest(request, response);
        return;
      }

      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      sendJson(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown server error",
      });
    }
  });
}

async function handleMindMapGeneration(request, response) {
  const body = await readJson(request);
  const description = String(body.description || "").trim();
  const currentMindMap = normalizeMindMap(body.currentMindMap || createEmptyMindMap(), "ATRI思维导图");
  const selectedNodeTitle = String(body.selectedNodeTitle || "").trim();
  const settings = normalizeSettings(body.settings || {});

  if (!description) {
    sendJson(response, 400, {
      error: "missing_description",
      message: "请输入修改描述。",
    });
    return;
  }

  const fastMindMap = applyFastLocalChange(currentMindMap, description);

  if (fastMindMap) {
    sendJson(response, 200, {
      source: "fast-local",
      warning: "已快速识别节点关系并更新导图。",
      mindmap: fastMindMap,
    });
    return;
  }

  if (!settings.endpoint || !settings.model || !settings.apiKey) {
    sendJson(response, 200, {
      source: "fallback",
      warning: "大模型 API 设置不完整，已将修改描述作为节点加入当前导图。",
      mindmap: applyLocalChange(currentMindMap, description, selectedNodeTitle),
    });
    return;
  }

  try {
    const mindmap = await applyMindMapChangeWithLlm(currentMindMap, description, settings);
    sendJson(response, 200, {
      source: "llm",
      mindmap,
    });
  } catch (error) {
    sendJson(response, 200, {
      source: "fallback",
      warning: error instanceof Error ? error.message : "The model request failed.",
      mindmap: applyLocalChange(currentMindMap, description, selectedNodeTitle),
    });
  }
}

async function handleConnectionTest(request, response) {
  const body = await readJson(request);
  const settings = normalizeSettings(body.settings || {});

  if (!settings.endpoint || !settings.model || !settings.apiKey) {
    sendJson(response, 400, {
      ok: false,
      message: "Endpoint, model, and API key are required.",
    });
    return;
  }

  try {
    await callChatCompletions(settings, [
      {
        role: "system",
        content: "Return a compact JSON object only.",
      },
      {
        role: "user",
        content: '{"status":"ok"}',
      },
    ], { timeoutMs: 15000 });

    sendJson(response, 200, {
      ok: true,
      message: "Connection succeeded.",
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      message: error instanceof Error ? error.message : "Connection failed.",
    });
  }
}

async function applyMindMapChangeWithLlm(currentMindMap, description, settings) {
  const systemPrompt = [
    "你是 ATRI Toolbox 的思维导图编辑器。",
    "请只输出 JSON，不要输出 Markdown、解释或代码块。",
    "用户输入的是一次修改描述，不是整张导图的主题描述。",
    "你必须在当前导图基础上应用这一次修改，并返回完整的新导图 JSON。",
    "JSON 根对象和每个节点只使用 title、note、children，必要时必须给子节点增加 relation、relationArrow、relationLine。",
    "relation 是连线上的短标签；relationArrow 只能是 none、forward、backward、both；relationLine 只能是 solid、dashed、dotted。",
    "普通关系、契约关系、朋友、同伴、伙伴、合作、关联、绑定等对等关系使用 relationArrow: none。",
    "指向、依赖、调用、控制、负责、包含、拥有、继承、影响、流向等方向明确的关系使用 relationArrow: forward；描述为双向或互相时使用 both。",
    "描述提到虚线、弱关系、可选关系时使用 relationLine: dashed；提到点线时使用 dotted；否则使用 solid。",
    "根对象只是画布容器，不代表所有节点都必须连接到它；不要为了归纳强行把无关节点挂成根节点的关系。",
    "当新节点和其他节点没有明确联系时，把它作为根对象 children 里的顶层节点，relation 留空，前端会将它作为独立节点生成。",
    "当修改描述表达两个节点之间的关系时，把其中一个节点放到另一个节点 children 下，并在该子节点写 relation、relationArrow、relationLine；如果是对等关系，不要把 relationArrow 写成 forward。",
    "relation 会显示在 draw.io 连接线段上；如果描述给出了关系词，比如同伴、主人、依赖、负责、连接、包含，必须保留为 relation。",
    "节点标题要短，适合显示在思维导图里；备注也要短，只保留对节点有帮助的信息。",
    "只允许修改描述直接涉及的节点、备注和关系；没有被修改描述涉及的节点、层级、标题、备注和 relation 必须保持不变。",
    "除非修改描述明确要求更改导图标题，否则根对象 title 必须沿用当前导图 title。",
    "不要生成修改描述之外的额外内容，不要为了完整性补充没有被要求的节点。",
    "如果修改描述不够明确，只新增或修改一个直接表达该描述的节点。",
  ].join("\n");

  const userPrompt = [
    "当前导图 JSON：",
    JSON.stringify(currentMindMap),
    "",
    "修改描述：",
    description,
    "",
    "请返回应用这次修改后的完整导图 JSON。",
  ].join("\n");

  const content = await callChatCompletions(settings, [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ], { maxTokens: 3000 });

  return normalizeMindMap(parseJsonFromModel(content), "ATRI思维导图");
}

async function callChatCompletions(settings, messages, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);

  try {
    const result = await fetch(settings.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: options.maxTokens || 1600,
        messages,
      }),
      signal: controller.signal,
    });

    const raw = await result.text();

    if (!result.ok) {
      throw new Error(`大模型接口返回 ${result.status}: ${raw.slice(0, 240)}`);
    }

    let payload;

    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(`大模型接口返回了非 JSON 响应：${raw.slice(0, 240)}`);
    }

    const content = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text;

    if (!content) {
      throw new Error("大模型接口响应中没有 choices[0].message.content。");
    }

    return content;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("大模型接口请求超时，请检查接口地址、网络或服务商状态。");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonFromModel(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : content;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object.");
  }

  return JSON.parse(source.slice(start, end + 1));
}

function normalizeMindMap(input, fallbackTitle) {
  const root = input?.mindmap || input?.map || input;
  return normalizeNode(root, fallbackTitle);
}

function normalizeNode(input, fallbackTitle) {
  if (typeof input === "string") {
    return {
      title: input.slice(0, 80) || fallbackTitle,
      note: "",
      relation: "",
      relationArrow: "forward",
      relationLine: "solid",
      children: [],
    };
  }

  const title = String(input?.title || input?.name || fallbackTitle || "未命名节点")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  const note = String(input?.note || input?.description || input?.detail || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const relation = String(input?.relation || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const relationArrowSource = input?.relationArrow || input?.relationDirection || input?.arrow;

  const children = Array.isArray(input?.children)
    ? input.children.slice(0, 8).map((child, index) => normalizeNode(child, `节点 ${index + 1}`))
    : [];

  const node = {
    title: title || fallbackTitle || "未命名节点",
    note,
    relation,
    relationArrow: relationArrowSource
      ? normalizeRelationArrow(relationArrowSource)
      : inferRelationArrow("", relation, isSymmetricRelation(relation) ? "none" : "forward"),
    relationLine: normalizeRelationLine(input?.relationLine || input?.lineShape),
    children,
  };

  return node;
}

function compactTitle(text) {
  const normalized = String(text || "")
    .replace(/["'`*_#>-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > 22 ? `${normalized.slice(0, 22)}...` : normalized || "新的主题";
}

function applyFastLocalChange(currentMindMap, description) {
  const parsed = parseLocalDescription(description);

  if (!parsed.additions.length && !parsed.relations.length && !parsed.notes.length) {
    return null;
  }

  const nextMindMap = cloneMindMap(currentMindMap);

  for (const addition of parsed.additions) {
    const parent = addition.parentTitle ? findOrCreateNodeByTitle(nextMindMap, addition.parentTitle) : nextMindMap;
    const child = appendNode(parent, addition.title, addition.note);
    child.note = mergeShortNote(child.note, addition.note);
  }

  for (const note of parsed.notes) {
    const node = findOrCreateNodeByTitle(nextMindMap, note.title);
    node.note = mergeShortNote(node.note, note.note);
  }

  for (const relation of parsed.relations) {
    const parent = findOrCreateNodeByTitle(nextMindMap, relation.parentTitle);
    const child = findOrCreateNodeByTitle(nextMindMap, relation.childTitle);

    if (parent === child) {
      continue;
    }

    detachNode(nextMindMap, child);
    parent.children.push(child);
    child.relation = relation.label;
    child.relationArrow = relation.arrow;
    child.relationLine = relation.line;
    child.note = mergeShortNote(child.note, relation.childNote);
    parent.note = parent.note || relation.parentNote;
  }

  return nextMindMap;
}

function parseLocalDescription(description) {
  const parts = String(description || "")
    .split(/[，,。；;！!?？\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const result = {
    additions: [],
    relations: [],
    notes: [],
  };
  result.additions.push(...parseAddNodeDescriptions(description));

  const fullRelation = parseRelationDescription(description);

  if (fullRelation) {
    result.relations.push(fullRelation);
  }

  for (const part of parts) {
    const relation = parseRelationDescription(part);

    if (relation) {
      pushUniqueRelation(result.relations, relation);
      continue;
    }

    const note = parseNodeNoteDescription(part);

    if (note) {
      result.notes.push(note);
    }
  }

  return result;
}

function pushUniqueRelation(relations, relation) {
  const duplicate = relations.some((item) => item.parentTitle === relation.parentTitle
    && item.childTitle === relation.childTitle
    && item.label === relation.label);

  if (!duplicate) {
    relations.push(relation);
  }
}

function parseAddNodeDescriptions(description) {
  const normalized = String(description || "")
    .replace(/[。.!！?？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!/(添加|新增|创建|加入|生成)/.test(normalized)) {
    return [];
  }

  const inlineNote = extractInlineNote(normalized);
  const command = inlineNote.index >= 0
    ? normalized.slice(0, inlineNote.index).replace(/[，,。；;]+$/g, "").trim()
    : normalized;
  const parentTitle = extractAddParentTitle(command);
  const titles = extractAddChildTitles(command);

  if (!titles.length) {
    return [];
  }

  return titles.map((title) => ({
    parentTitle,
    title,
    note: inlineNote.note,
  }));
}

function parseAddNodeDescription(description) {
  return parseAddNodeDescriptions(description)[0] || null;
}

function extractInlineNote(description) {
  const match = description.match(/(?:^|[，,。；;])(?:备注|说明|注释)(?:写明|改为|设置为|为|是|:|：)(.+)$/);

  if (!match) {
    return {
      index: -1,
      note: "",
    };
  }

  return {
    index: match.index + (match[0].startsWith("，") || match[0].startsWith(",") || match[0].startsWith("。") || match[0].startsWith("；") || match[0].startsWith(";") ? 1 : 0),
    note: compactNote(match[1]),
  };
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

function extractAddChildTitle(description) {
  return extractAddChildTitles(description)[0] || "";
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

  return splitTitleList(cleanAddedTitle(natural[1]));
}

function extractNamedTitles(description) {
  const titles = [];
  const pattern = /(?:名叫|叫做|叫作|叫|名称为|名字为|命名为)[“"']?([^“”"',，。；;、和与]+)[”"']?/g;
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

function splitTitleList(text) {
  const cleaned = String(text || "")
    .replace(/^(?:两个|2个|多个|若干|一些|几个|一组)?(?:子?节点|分支|主题)[，,：:]?/g, "")
    .replace(/^分别(?:为|叫|是)/g, "")
    .trim();

  if (!cleaned) {
    return [];
  }

  return uniqueTitles(cleaned
    .split(/[、,，/]|和|与/)
    .map(compactEntityTitle)
    .filter(Boolean));
}

function uniqueTitles(titles) {
  return [...new Set(titles)];
}

function cleanAddedTitle(title) {
  return String(title || "")
    .replace(/(?:一个|一条|1个|两个|2个|多个|若干|一些|几个)?(?:子?节点|分支|主题)$/g, "")
    .replace(/^(?:一个|一条|1个)/g, "")
    .trim();
}

function parseRelationDescription(description) {
  const normalized = String(description || "")
    .replace(/[。.!！?？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const pairMatch = normalized.match(/^(.+?)(?:和|与)(.+?)(?:的)?关系(?:是|为|:|：)(.+)$/);

  if (pairMatch) {
    const childTitle = compactEntityTitle(pairMatch[1]);
    const parentTitle = compactEntityTitle(pairMatch[2]);
    const label = compactRelationLabel(pairMatch[3]);

    if (parentTitle && childTitle && label) {
      return createRelationChange(parentTitle, childTitle, label, normalized, "none");
    }
  }

  const mutualMatch = normalized.match(/^(.+?)(?:和|与|跟|同)(.+?)(?:是|为|存在|形成|建立)(.+?)(?:关系)?$/);

  if (mutualMatch) {
    const childTitle = compactEntityTitle(mutualMatch[1]);
    const parentTitle = compactEntityTitle(mutualMatch[2]);
    const label = compactRelationLabel(mutualMatch[3]);

    if (parentTitle && childTitle && label) {
      return createRelationChange(parentTitle, childTitle, label, normalized, "none");
    }
  }

  const linkMatch = normalized.match(/^(?:将|把)?(.+?)(?:连接到|连到|关联到|指向)(.+?)(?:，|,)?(?:关系|标签|连线文字)?(?:是|为|:|：)(.+)$/);

  if (linkMatch) {
    const parentTitle = compactEntityTitle(linkMatch[1]);
    const childTitle = compactEntityTitle(linkMatch[2]);
    const label = compactRelationLabel(linkMatch[3]);

    if (parentTitle && childTitle && label) {
      return createRelationChange(parentTitle, childTitle, label, normalized, "forward");
    }
  }

  const directMatch = normalized.match(/^(.+?)(指向|依赖|调用|控制|管理|负责|包含|拥有|继承|影响|流向)(.+)$/);

  if (directMatch) {
    const parentTitle = compactEntityTitle(directMatch[1]);
    const childTitle = compactEntityTitle(directMatch[3]);
    const label = compactRelationLabel(directMatch[2]);

    if (parentTitle && childTitle && label) {
      return createRelationChange(parentTitle, childTitle, label, normalized, "forward");
    }
  }

  if (looksLikeTitleNamingText(normalized)) {
    return null;
  }

  const match = normalized.match(/^(.+?)是(.+?)的(.+)$/);

  if (!match) {
    return null;
  }

  const childTitle = compactEntityTitle(match[1]);
  const parentTitle = compactEntityTitle(match[2]);
  const childRole = compactEntityTitle(match[3]);
  const parentRole = inverseRelationRole(childRole);

  if (!childTitle || !parentTitle || !childRole) {
    return null;
  }

  return {
    childTitle,
    parentTitle,
    label: parentRole ? `${parentRole}/${childRole}` : childRole,
    arrow: inferRelationArrow(normalized, childRole, isSymmetricRelation(childRole) ? "none" : "forward"),
    line: inferRelationLine(normalized),
    childNote: childRole,
    parentNote: parentRole,
  };
}

function createRelationChange(parentTitle, childTitle, label, description, defaultArrow) {
  return {
    childTitle,
    parentTitle,
    label,
    arrow: inferRelationArrow(description, label, defaultArrow),
    line: inferRelationLine(description),
    childNote: "",
    parentNote: "",
  };
}

function looksLikeTitleNamingText(text) {
  return /(?:名叫|叫做|叫作|名称为|名字为|命名为|(?:^|[，,。；;\s])(?:一个|一条|1个|两个|2个)?叫)/.test(String(text || ""));
}

function parseNodeNoteDescription(description) {
  const normalized = String(description || "")
    .replace(/[。.!！?？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(/^(.+?)是(.+)$/);

  if (!match || match[2].includes("的")) {
    return null;
  }

  const title = compactEntityTitle(match[1]);
  const note = compactNote(match[2]);

  if (!title || !note) {
    return null;
  }

  return { title, note };
}

function mergeShortNote(current, addition) {
  const currentNote = String(current || "").trim();
  const next = String(addition || "").trim();

  if (!next) {
    return currentNote;
  }

  if (!currentNote) {
    return next;
  }

  if (currentNote.includes(next)) {
    return currentNote;
  }

  return `${currentNote}；${next}`.slice(0, 240);
}

function compactEntityTitle(text) {
  return String(text || "")
    .replace(/["'`*_#>-]/g, "")
    .trim()
    .slice(0, 24);
}

function compactRelationLabel(text) {
  return compactEntityTitle(text)
    .replace(/(?:之间)?(?:的)?关系$/g, "")
    .replace(/^(?:关系|标签|连线文字)(?:是|为|:|：)?/g, "")
    .replace(/^(?:虚线|点线|点状|点划线|普通线|普通连线|无箭头|无向)/g, "")
    .trim()
    .slice(0, 24);
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

  return normalizeRelationArrow(defaultArrow);
}

function inferRelationLine(description) {
  const text = String(description || "");

  if (/(点线|点状|点划线)/.test(text)) {
    return "dotted";
  }

  if (/(虚线|弱关系|可选关系|临时关系)/.test(text)) {
    return "dashed";
  }

  return "solid";
}

function isSymmetricRelation(label) {
  return /(契约|同伴|伙伴|朋友|配偶|夫妻|盟友|合作|关联|绑定|搭档|同事|兄弟|姐妹|亲属)/.test(String(label || ""));
}

function normalizeRelationArrow(value) {
  const arrow = String(value || "forward").trim().toLowerCase();
  return ["none", "forward", "backward", "both"].includes(arrow) ? arrow : "forward";
}

function normalizeRelationLine(value) {
  const line = String(value || "solid").trim().toLowerCase();
  return ["solid", "dashed", "dotted"].includes(line) ? line : "solid";
}

function compactNote(text) {
  return String(text || "")
    .replace(/["'`*_#>-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
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
  const found = mappings.find(([childRole]) => role.includes(childRole));
  return found?.[1] || "";
}

function findOrCreateNodeByTitle(root, title) {
  const found = findNodeByTitle(root, title);

  if (found) {
    return found;
  }

  const node = {
    title,
    note: "",
    relation: "",
    relationArrow: "forward",
    relationLine: "solid",
    children: [],
  };
  root.children.push(node);
  return node;
}

function appendNode(parent, title, note = "") {
  const existing = parent.children.find((child) => child.title === title);

  if (existing) {
    return existing;
  }

  const node = {
    title,
    note,
    relation: "",
    relationArrow: "forward",
    relationLine: "solid",
    children: [],
  };
  parent.children.push(node);
  return node;
}

function detachNode(parent, target) {
  parent.children = parent.children.filter((child) => child !== target);

  for (const child of parent.children) {
    detachNode(child, target);
  }
}

function applyLocalChange(currentMindMap, description, selectedNodeTitle) {
  const nextMindMap = cloneMindMap(currentMindMap);
  const additions = parseAddNodeDescriptions(description);

  if (additions.length) {
    for (const addition of additions) {
      const target = addition.parentTitle
        ? findOrCreateNodeByTitle(nextMindMap, addition.parentTitle)
        : findNodeByTitle(nextMindMap, selectedNodeTitle) || nextMindMap;
      appendNode(target, addition.title, addition.note || inferNoteFromDescription(description));
    }

    return nextMindMap;
  }

  const target = findNodeByTitle(nextMindMap, selectedNodeTitle) || nextMindMap;
  appendNode(target, compactTitle(description), inferNoteFromDescription(description));

  return nextMindMap;
}

function inferNoteFromDescription(description) {
  const note = parseNodeNoteDescription(description)?.note;

  if (note) {
    return note;
  }

  return compactTitle(description).replace(/\.\.\.$/, "");
}

function cloneMindMap(node) {
  return {
    title: node.title,
    note: node.note || "",
    relation: node.relation || "",
    relationArrow: normalizeRelationArrow(node.relationArrow),
    relationLine: normalizeRelationLine(node.relationLine),
    children: node.children.map(cloneMindMap),
  };
}

function findNodeByTitle(node, title) {
  if (title && node.title === title) {
    return node;
  }

  for (const child of node.children) {
    const found = findNodeByTitle(child, title);

    if (found) {
      return found;
    }
  }

  return null;
}

function createEmptyMindMap() {
  return {
    title: "ATRI思维导图",
    note: "",
    relation: "",
    relationArrow: "forward",
    relationLine: "solid",
    children: [],
  };
}

function normalizeLineColor(color) {
  const value = String(color || "").trim();
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) ? value : "";
}

function normalizeLineShape(shape) {
  const value = String(shape || "solid").trim();
  return ["solid", "dashed", "dotted"].includes(value) ? value : "solid";
}

function normalizeLineDirection(direction) {
  const value = String(direction || "forward").trim();
  return ["forward", "backward", "both", "none"].includes(value) ? value : "forward";
}

function normalizeLineGeometry(geometry) {
  const value = String(geometry || "straight").trim().toLowerCase();
  return ["elbow", "orthogonal", "fold", "折线"].includes(value) ? "elbow" : "straight";
}

function normalizeLinkSide(side) {
  const value = String(side || "").trim().toLowerCase();
  return ["top", "right", "bottom", "left"].includes(value) ? value : "";
}

function normalizeSettings(input) {
  const temperature = Number.parseFloat(input.temperature);

  return {
    endpoint: String(input.endpoint || "").trim(),
    model: String(input.model || "").trim(),
    apiKey: String(input.apiKey || "").trim(),
    temperature: Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 2) : 0.3,
  };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > 2 * 1024 * 1024) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(urlPath, response) {
  const requestPath = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const resolved = path.resolve(publicDir, `.${requestPath}`);

  if (!isPathInside(resolved, publicDir)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  let filePath = resolved;
  let fileStat;

  try {
    fileStat = await stat(filePath);

    if (fileStat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      fileStat = await stat(filePath);
    }
  } catch {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Content-Length": fileStat.size,
  });

  createReadStream(filePath).pipe(response);
}

function isPathInside(filePath, directory) {
  return filePath === directory || filePath.startsWith(`${directory}${path.sep}`);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export function startServer(port = defaultPort, options = {}) {
  const server = createToolboxServer();
  const maxPort = port === 0 ? 0 : port + 20;
  const sockets = new Set();
  let closing = false;

  server.keepAliveTimeout = 1000;
  server.headersTimeout = 5000;
  server.requestTimeout = 30000;

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  return new Promise((resolve, reject) => {
    const tryListen = (candidatePort) => {
      const onError = (error) => {
        server.removeListener("listening", onListening);

        if (error.code === "EADDRINUSE" && candidatePort !== 0 && candidatePort < maxPort) {
          tryListen(candidatePort + 1);
          return;
        }

        reject(error);
      };

      const onListening = () => {
        server.removeListener("error", onError);
        const address = server.address();
        const actualPort = typeof address === "object" && address ? address.port : candidatePort;

        if (!options.silent) {
          console.log(`ATRI Toolbox local service running at http://127.0.0.1:${actualPort}`);
        }

        resolve({
          port: actualPort,
          close: () => new Promise((closeResolve, closeReject) => {
            if (closing) {
              closeResolve();
              return;
            }

            closing = true;
            server.closeIdleConnections?.();

            const forceTimer = setTimeout(() => {
              server.closeAllConnections?.();

              for (const socket of sockets) {
                socket.destroy();
              }
            }, 700);
            forceTimer.unref?.();

            server.close((error) => {
              clearTimeout(forceTimer);

              if (error?.code === "ERR_SERVER_NOT_RUNNING") {
                closeResolve();
                return;
              }

              if (error) {
                closeReject(error);
                return;
              }

              closeResolve();
            });
          }),
        });
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidatePort, "127.0.0.1");
    };

    tryListen(port);
  });
}

if (process.argv[1] === __filename) {
  startServer(defaultPort).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
