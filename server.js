import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMindMapOperationMessages,
  createLocalOperationPlan,
  normalizeDiagramSnapshot,
  normalizeOperationPlan,
} from "./mindmap-ai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const vendorFiles = new Map([
  ["/vendor/dagre.esm.js", path.join(__dirname, "node_modules", "@dagrejs", "dagre", "dist", "dagre.esm.js")],
]);
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

      if (!isAllowedRequestOrigin(request)) {
        sendJson(response, 403, {
          error: "forbidden_origin",
          message: "Requests are only accepted from the local ATRI Toolbox window.",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/mindmap/generate") {
        await handleMindMapGeneration(request, response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/llm/test") {
        await handleConnectionTest(request, response);
        return;
      }

      if (request.method === "OPTIONS") {
        response.writeHead(204);
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
  const result = await generateMindMapOperations(body);
  sendJson(response, result.status, result.payload);
}

export async function generateMindMapOperations(body = {}, options = {}) {
  const description = String(body.description || "").trim();
  const currentDiagram = normalizeDiagramSnapshot(body.currentDiagram || {}, "ATRI思维导图");
  const settings = normalizeSettings(body.settings || {});

  if (!description) {
    return {
      status: 400,
      payload: {
        error: "missing_description",
        message: "请输入修改描述。",
      },
    };
  }

  const localPlan = createLocalOperationPlan(currentDiagram, description);

  if (localPlan) {
    return {
      status: 200,
      payload: {
        source: "local",
        summary: localPlan.summary,
        operations: localPlan.operations,
      },
    };
  }

  if (!settings.endpoint || !settings.model || !settings.apiKey) {
    return {
      status: 422,
      payload: {
        error: "model_settings_required",
        message: "未能在本地安全解析这条描述，请先配置大模型 API，或写明具体节点名称和关系。",
      },
    };
  }

  try {
    const messages = buildMindMapOperationMessages(currentDiagram, description);
    const requestModel = options.callChatCompletions || callChatCompletions;
    const content = await requestModel(settings, messages, { maxTokens: 2400 });
    const plan = normalizeOperationPlan(parseJsonFromModel(content), currentDiagram);

    if (!plan.operations.length) {
      return {
        status: 422,
        payload: {
          error: "no_safe_operations",
          message: plan.summary || "模型没有返回可安全应用的修改，请补充具体节点或关系。",
        },
      };
    }

    return {
      status: 200,
      payload: {
        source: "llm",
        summary: plan.summary,
        operations: plan.operations,
      },
    };
  } catch (error) {
    return {
      status: 502,
      payload: {
        error: "model_plan_failed",
        message: error instanceof Error ? error.message : "大模型未能生成安全的修改计划。",
      },
    };
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
  const vendorFile = vendorFiles.get(requestPath);
  const resolved = vendorFile || path.resolve(publicDir, `.${requestPath}`);

  if (!vendorFile && !isPathInside(resolved, publicDir)) {
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
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function isAllowedRequestOrigin(request) {
  const origin = request.headers.origin;

  if (!origin) {
    return true;
  }

  const localPort = request.socket.localPort;
  return origin === `http://127.0.0.1:${localPort}` || origin === `http://localhost:${localPort}`;
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
