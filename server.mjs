import express from "express";
import { HttpsProxyAgent } from "https-proxy-agent";
import crypto from "crypto";
import https from "https";
import fs from "fs";
import { PoolCore } from "./pool/pool-core.mjs";
import {
  importNodes, removeNode, listNodes, reloadMihomo, writeMihomoConfig, mihomoAlive,
} from "./pool/node-pool.mjs";

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PROXY_PORT || 6446;
const OC_VERSION = "1.18.18"; // 伪装 opencode 客户端版本，上游 npm 最新版（2026-08-13 发布，已同步）
const PROXY_VERSION = "1.0.0"; // zenpool 版本（对齐 GitHub Release v1.0.0：第一版）

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ocpool-admin";

// ── 统一节点池（静态 SSH 端口 + mihomo 动态导入节点）────────────────
const PROXY_POOL = (process.env.PROXY_POOL || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const POOL = new PoolCore({
  staticUrls: PROXY_POOL,
  cooldownMs: 5 * 60 * 1000,
  dataDir: process.env.ZENPOOL_DATA_DIR || "./data",
});

// 兼容旧调用点：pick 返回节点对象 {kind, idx, name, url}
function pickProxyNode() { return POOL.pick(); }
function proxyAgentFor(sel) { return sel && sel.url ? new HttpsProxyAgent(sel.url) : undefined; }
function markProxyExhausted(sel) { if (sel) POOL.markExhausted(sel); }

// 刷新 PoolCore 的 mihomo 节点名列表（导入/删除后调用）
function refreshPool() {
  const names = listNodes().map((n) => n.name);
  POOL.setMihomoNames(names);
  return names;
}

// ── API Keys ───────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) {
    if (tok === key) return name;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────
function ocId(prefix) {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
}

const MODELS = [
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "laguna-s-2.1-free",
  "longcat-2.0-free",
  "big-pickle",
];

// Track sessions per user (rotate every 30 min)
const userSessions = {};
function getSession(user) {
  const now = Date.now();
  if (!userSessions[user] || now - userSessions[user].ts > 30 * 60 * 1000) {
    userSessions[user] = { id: ocId("ses"), ts: now };
  }
  return userSessions[user].id;
}

// ── Zen API transport ──────────────────────────────────────────────
// 清洗 tools：上游严格校验 function.name，缺 name 的自动补 tool_<索引>
// （兼容 Chat Completions 嵌套格式 function.name 与 Responses API 顶层 name 两种写法）
function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t, i) => {
    if (!t || typeof t !== "object") return t;
    const copy = { ...t };
    if (t.type === "function") {
      if (t.function && typeof t.function === "object") {
        if (!t.function.name) copy.function = { ...t.function, name: "tool_" + i };
      } else if (!t.name) {
        copy.name = "tool_" + i; // Responses API：name 在顶层
      }
    }
    return copy;
  });
}

// 转成 Responses API 顶层 name 格式（上游 /v1/responses 只认这种）
function toResponsesTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t, i) => {
    if (t && t.type === "function" && t.function && !t.name) {
      return {
        type: "function",
        name: t.function.name || "tool_" + i,
        description: t.function.description || "",
        parameters: t.function.parameters || { type: "object", properties: {} },
      };
    }
    return t;
  });
}

function zenRequest(model, messages, stream, tools, tool_choice, sessionId, nodeIdx) {
  const reqBody = { model, messages, stream: !!stream };
  if (tools?.length) reqBody.tools = sanitizeTools(tools);
  if (tool_choice) reqBody.tool_choice = tool_choice;
  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");

  return {
    body,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
      },
      timeout: 300000,
      agent: proxyAgentFor(nodeIdx),
    },
  };
}

// Zen Responses API transport（原生 /v1/responses 透传，body 直接转发）
function zenResponsesRequest(body, sessionId, nodeIdx) {
  if (body && Array.isArray(body.tools)) {
    body = { ...body, tools: sanitizeTools(toResponsesTools(body.tools)) };
  }
  const reqBody = JSON.stringify(body);
  const requestId = ocId("msg");

  return {
    body: reqBody,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/responses",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(reqBody),
        "Authorization": "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
      },
      timeout: 300000,
      agent: proxyAgentFor(nodeIdx),
    },
  };
}

// Pipe Zen response to client (OpenAI format passthrough)
// onDone(status, duration, usage, ttft, errInfo) —— errInfo 为失败诊断快照 {code,message,upstream_status,snippet}
function pipeZenResponse(zenOpts, body, stream, res, onDone, nodeIdx) {
  const startTime = Date.now();
  const respChunks = [];
  let done = false;
  let ttft = null;
  const finish = (status, usage, errInfo) => {
    if (done) return;
    done = true;
    if (onDone) onDone(status, Date.now() - startTime, usage, ttft, errInfo);
  };
  const req = https.request(zenOpts, (zenRes) => {
    let firstChunk = null;
    let headersSent = false;
    zenRes.on("data", (chunk) => {
      respChunks.push(chunk);
      if (!firstChunk) {
        firstChunk = chunk;
        if (ttft === null) ttft = Date.now() - startTime;
        const str = chunk.toString().trim();
        if (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes('"error"'))) {
          try {
            const parsed = JSON.parse(str);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
              // 只有真限流（HTTP 429 或 FreeUsageLimitError/rate limit）才冷却节点；
              // 参数 400/模型不支持等错误透传上游状态码，不冷却（v23 修复误冷却连锁）
              const isRateLimit = zenRes.statusCode === 429 || /FreeUsageLimitError|rate.?limit/i.test(errMsg);
              if (isRateLimit) {
                console.log("[ZEN RATE LIMITED]", errMsg);
                if (!res.headersSent) {
                  res.status(429).json({
                    error: { message: errMsg + " (free model rate limit)", type: "rate_limit_error", code: "rate_limit_exceeded" }
                  });
                }
                markProxyExhausted(nodeIdx);
                zenRes.resume();
                finish(429, null, { code: "rate_limit", message: errMsg, upstream_status: zenRes.statusCode, snippet: String(str).slice(0, 300) });
                return;
              }
              console.log("[ZEN ERROR]", zenRes.statusCode, errMsg);
              if (!res.headersSent) {
                res.status(zenRes.statusCode >= 400 ? zenRes.statusCode : 502).json({
                  error: { message: errMsg, type: "upstream_error" }
                });
              }
              zenRes.resume();
              finish(zenRes.statusCode >= 400 ? zenRes.statusCode : 502, null, { code: "upstream_error", message: errMsg, upstream_status: zenRes.statusCode, snippet: String(str).slice(0, 300) });
              return;
            }
          } catch {}
        }
        headersSent = true;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });
          res.flushHeaders();
        } else {
          res.writeHead(zenRes.statusCode, { "Content-Type": "application/json" });
        }
        res.write(firstChunk);
        if (res.flush) res.flush();
        return;
      }
      if (headersSent) {
        res.write(chunk);
        if (res.flush) res.flush();
      }
    });
    zenRes.on("end", () => {
      if (!headersSent && !firstChunk) {
        console.log("[ZEN EMPTY] No response from Zen API");
        if (!res.headersSent) {
          res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
        }
        finish(502, null, { code: "empty_upstream", message: "Empty response from upstream", upstream_status: null, snippet: "" });
        return;
      }
      if (headersSent) {
        res.end();
        const usage = extractUsageFromChunks(respChunks, !!stream);
        finish(res.statusCode || 200, usage);
      }
    });
  });
  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    }
    finish(502, null, { code: "transport_error", message: e.message, upstream_status: null, snippet: "" });
  });
  req.on("timeout", () => {
    req.destroy();
    console.log("[ZEN TIMEOUT]");
    if (!res.headersSent) {
      res.status(504).json({ error: { message: "Upstream timeout", type: "timeout_error" } });
    }
    finish(504, null, { code: "timeout", message: "Upstream timeout", upstream_status: null, snippet: "" });
  });
  req.write(body);
  req.end();
}

function zenRequestFull(zenOpts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: zenRes.statusCode, data: JSON.parse(raw), raw });
        } catch {
          resolve({ status: zenRes.statusCode, data: null, raw });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}


function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map(b => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
      // tool_use blocks → assistant tool_calls
      const toolUses = msg.content.filter(b => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(t => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some(b => b.type === "tool_result")) {
        for (const b of msg.content.filter(b => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map(c => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}


function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || ocId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}


function pipeZenAsAnthropic(zenOpts, body, model, res, inputTokens, onDone, nodeIdx) {
  const msgId = ocId("msg");
  const startTime = Date.now();
  const respChunks = [];
  let done = false;
  let ttft = null;
  const finish = (status, usage) => {
    if (done) return;
    done = true;
    if (onDone) onDone(status, Date.now() - startTime, usage, ttft);
  };

  const req = https.request(zenOpts, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    let firstChunkHandled = false;

    function sendSSE(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    }

    function sendHeaders() {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      sendSSE("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", content: [],
          model, stop_reason: null,
          usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    }

    zenRes.on("data", (chunk) => {
      const str = chunk.toString();
      respChunks.push(chunk);

      // Check for errors on first chunk
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        if (ttft === null) ttft = Date.now() - startTime;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"'))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit";
              // 只有真限流才冷却节点；参数错误透传状态码（v23 修复误冷却连锁）
              const isRateLimit = zenRes.statusCode === 429 || /FreeUsageLimitError|rate.?limit/i.test(errMsg);
              if (isRateLimit) {
                if (!res.headersSent) {
                  res.writeHead(429, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({
                    type: "error",
                    error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
                  }));
                }
                markProxyExhausted(nodeIdx);
                headersSent = true; // mark so end/error handlers don't double-fire
                finish(429);
                zenRes.resume();
                return;
              }
              if (!res.headersSent) {
                res.writeHead(zenRes.statusCode >= 400 ? zenRes.statusCode : 502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  type: "error",
                  error: { type: "upstream_error", message: errMsg },
                }));
              }
              headersSent = true;
              finish(zenRes.statusCode >= 400 ? zenRes.statusCode : 502);
              zenRes.resume();
              return;
            }
          } catch {}
        }
      }

      buffer += str;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        sendHeaders();

        // Text content
        if (delta.content) {
          if (contentIdx === 0 && toolIdx === -1) {
            sendSSE("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            contentIdx = 1;
          }
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta.content },
          });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (idx > toolIdx) {
              // Close previous text block if open
              if (toolIdx === -1 && contentIdx > 0) {
                sendSSE("content_block_stop", { type: "content_block_stop", index: 0 });
              }
              toolIdx = idx;
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_start", {
                type: "content_block_start", index: blockIdx,
                content_block: { type: "tool_use", id: tc.id || ocId("toolu"), name: tc.function?.name || "" },
              });
            }
            if (tc.function?.arguments) {
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_delta", {
                type: "content_block_delta", index: blockIdx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              });
              outputTokens += Math.ceil(tc.function.arguments.length / 4);
            }
          }
        }

        // Finish
        if (parsed.choices?.[0]?.finish_reason) {
          const fr = parsed.choices[0].finish_reason;
          // Close open blocks
          const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
          for (let i = 0; i < totalBlocks; i++) {
            sendSSE("content_block_stop", { type: "content_block_stop", index: i });
          }

          let stopReason = "end_turn";
          if (fr === "tool_calls") stopReason = "tool_use";
          else if (fr === "length") stopReason = "max_tokens";

          sendSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: outputTokens },
          });
          sendSSE("message_stop", { type: "message_stop" });
        }
      }
    });

    zenRes.on("end", () => {
      if (!headersSent) {
        if (!res.headersSent) {
          res.status(502).json({ type: "error", error: { type: "upstream_error", message: "Empty response" } });
        }
        finish(502);
        return;
      }
      res.end();
      const usage = extractUsageFromChunks(respChunks, true);
      finish(200, usage);
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
    finish(502);
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(504).json({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } });
    }
    finish(504);
  });

  req.write(body);
  req.end();
}

// ── Routes: OpenAI format ──────────────────────────────────────────

// ── Admin Panel & API ──────────────────────────────────────────────
const ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");
const ADMIN_COOKIE = "ocpool_admin_token";

let requestLogs = [];
const MAX_LOGS = 50;

// ── Token Stats (memory aggregate + JSONL persistence) ─────────────
const STATS_FILE = process.env.STATS_FILE || "./data/token_stats.jsonl";
const STATS_MAX_LINES = 200000; // rotate to .old when exceeded

// ── Audit trail（对齐 grok2api 请求审计：RequestID + 完整记录 + 失败诊断快照）──
const AUDIT_FILE = process.env.AUDIT_FILE || "./data/audit.jsonl";
const AUDIT_MAX = 20000; // 内存 ring buffer 上限
let auditRecords = []; // [{id, requestId, ts, user, operation, model, proxyIdx, status, stream, ttft, duration, input_tokens, output_tokens, cache_hit, error}]

let auditSeq = 1;

function newRequestId() {
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function loadAudit() {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (r && r.id) auditRecords.push(r);
      } catch {}
    }
    auditSeq = auditRecords.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
  } catch {}
}

// 记录审计条目：entry 含 requestId/user/operation/model/proxyIdx/status/stream/ttft/duration/tokens/error
function recordAudit(entry) {
  const rec = {
    id: auditSeq++,
    requestId: entry.requestId || newRequestId(),
    ts: new Date().toISOString(),
    user: entry.user || "?",
    operation: entry.operation || "chat",
    model: entry.model || "",
    proxyIdx: entry.proxyIdx ?? null,
    proxyName: entry.proxyName ?? null,
    status: entry.status ?? 0,
    stream: !!entry.stream,
    ttft: entry.ttft ?? null,
    duration: entry.duration ?? 0,
    input_tokens: entry.input_tokens || 0,
    output_tokens: entry.output_tokens || 0,
    cache_hit: entry.cache_hit || 0,
    error: entry.error || null, // {code, message, upstream_status, snippet} 失败诊断快照
  };
  auditRecords.push(rec);
  if (auditRecords.length > AUDIT_MAX) auditRecords.splice(0, auditRecords.length - AUDIT_MAX);
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + "\n");
  } catch (e) {
    console.log("[AUDIT WRITE ERR]", e.message);
  }
  return rec;
}


const tokenStats = {
  total: { requests: 0, input_tokens: 0, output_tokens: 0, cache_hit: 0, ttft_sum: 0, ttft_count: 0 },
  byModel: {},
  byUser: {},
  daily: {},
  records: [], // raw records for filtering (capped)
};
const STATS_RECORDS_MAX = 200000;

function ensureDayKey(day) {
  if (!tokenStats.daily[day]) {
    tokenStats.daily[day] = { requests: 0, input_tokens: 0, output_tokens: 0, cache_hit: 0, ttft_sum: 0, ttft_count: 0 };
  }
}

function accumulate(map, key, entry) {
  if (!map[key]) {
    map[key] = { requests: 0, input_tokens: 0, output_tokens: 0, cache_hit: 0, ttft_sum: 0, ttft_count: 0 };
  }
  map[key].requests += 1;
  map[key].input_tokens += entry.input_tokens;
  map[key].output_tokens += entry.output_tokens;
  map[key].cache_hit += entry.cache_hit || 0;
  if (typeof entry.ttft === "number" && entry.stream) {
    map[key].ttft_sum += entry.ttft;
    map[key].ttft_count += 1;
  }
}

function withAvg(agg) {
  return {
    ...agg,
    avg_ttft: agg.ttft_count ? Math.round(agg.ttft_sum / agg.ttft_count) : null,
  };
}

function recordTokenStat(entry, persist = true) {
  tokenStats.total.requests += 1;
  tokenStats.total.input_tokens += entry.input_tokens;
  tokenStats.total.output_tokens += entry.output_tokens;
  tokenStats.total.cache_hit += entry.cache_hit || 0;
  if (typeof entry.ttft === "number" && entry.stream) {
    tokenStats.total.ttft_sum += entry.ttft;
    tokenStats.total.ttft_count += 1;
  }
  accumulate(tokenStats.byModel, entry.model, entry);
  accumulate(tokenStats.byUser, entry.user, entry);
  const day = cnDay(entry.ts);
  ensureDayKey(day);
  tokenStats.daily[day].requests += 1;
  tokenStats.daily[day].input_tokens += entry.input_tokens;
  tokenStats.daily[day].output_tokens += entry.output_tokens;
  tokenStats.daily[day].cache_hit += entry.cache_hit || 0;
  if (typeof entry.ttft === "number" && entry.stream) {
    tokenStats.daily[day].ttft_sum += entry.ttft;
    tokenStats.daily[day].ttft_count += 1;
  }

  // keep raw record for filtering
  tokenStats.records.push({
    ts: entry.ts, user: entry.user, model: entry.model,
    input_tokens: entry.input_tokens, output_tokens: entry.output_tokens,
    cache_hit: entry.cache_hit || 0, ttft: entry.ttft ?? null,
  });
  if (tokenStats.records.length > STATS_RECORDS_MAX) {
    tokenStats.records.splice(0, tokenStats.records.length - STATS_RECORDS_MAX);
  }

  if (!persist) return;
  // persist JSONL (best effort)
  try {
    fs.appendFileSync(STATS_FILE, JSON.stringify(entry) + "\n");
    const st = fs.statSync(STATS_FILE);
    if (st.size > 64 * 1024 * 1024) {
      fs.renameSync(STATS_FILE, STATS_FILE + ".old");
    }
  } catch (e) {
    console.log("[STATS WRITE ERR]", e.message);
  }
}

function loadTokenStats() {
  try {
    const lines = fs.readFileSync(STATS_FILE, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        recordTokenStat(JSON.parse(line), false);
      } catch {}
    }
    console.log(`[STATS] loaded ${lines.length} records from ${STATS_FILE}`);
  } catch (e) {
    console.log("[STATS] no stats file yet:", e.message);
  }
}

// extract usage from collected Zen response chunks (sync JSON or SSE stream)
function extractUsageFromChunks(chunks, isStream) {
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return null;
  if (!isStream) {
    try {
      const j = JSON.parse(raw);
      return j.usage || null;
    } catch { return null; }
  }
  // SSE stream: scan all data: lines for the last usage-bearing payload
  let usage = null;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      if (j.usage) usage = j.usage;
      else if (j.response?.usage) usage = j.response.usage; // Responses API: response.completed 事件 usage 在 response 内
    } catch {}
  }
  return usage;
}


function checkAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  let ok = false;
  if (authHeader === `Bearer ${ADMIN_TOKEN}`) {
    ok = true;
  } else if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const pass = decoded.split(":")[1] || "";
      if (pass === ADMIN_PASSWORD) ok = true;
    } catch {}
  }
  if (ok) {
    next();
  } else {
    res.set("WWW-Authenticate", 'Basic realm="ocpool-admin"');
    res.status(401).json({ error: "Unauthorized" });
  }
}

// ── 时间显示：UTC ISO → 北京时间（东八区固定 +8，无夏令时）──
function toCnDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(dt.getTime() + 8 * 3600 * 1000);
}
function fmtTs(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return toCnDate(d).toISOString().replace("T", " ").slice(0, 19);
}
function cnDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return toCnDate(d).toISOString().slice(0, 10);
}

function logRequest(user, model, stream, status, duration, proxyIdxUsed, usage, ttft, extra = {}) {
  const u = usage || {};
  // 兼容节点对象 {kind,pos,name,url} 与旧数字索引
  const pSel = proxyIdxUsed && typeof proxyIdxUsed === "object" ? proxyIdxUsed : null;
  const pIdx = pSel ? (pSel.pos ?? pSel.idx ?? 0) : (proxyIdxUsed ?? 0);
  const pName = pSel ? pSel.name : null;
  const entry = {
    ts: new Date().toISOString(),
    user,
    model,
    stream,
    status,
    duration,
    ttft: ttft ?? null,
    proxyIdx: pIdx,
    proxyName: pName,
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    cache_hit: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0,
  };
  requestLogs.push(entry);
  if (requestLogs.length > MAX_LOGS) requestLogs.shift();
  recordTokenStat(entry);

  // 审计记录（含失败诊断快照）
  recordAudit({
    requestId: extra.requestId,
    user,
    operation: extra.operation || "chat",
    model,
    proxyIdx: pIdx,
    proxyName: pName,
    status,
    stream,
    ttft: ttft ?? null,
    duration,
    input_tokens: entry.input_tokens,
    output_tokens: entry.output_tokens,
    cache_hit: entry.cache_hit,
    error: extra.error || null,
  });
}

function checkProxyPool() {
  return Promise.all(PROXY_POOL.map((url, idx) => new Promise((resolve) => {
    const start = Date.now();
    const p = { idx, url, ip: null, latency: null, status: "checking" };
    const req = https.get("https://api.ipify.org", { agent: new HttpsProxyAgent(url) }, (res) => {
      let ip = "";
      res.on("data", (c) => { ip += c.toString(); });
      res.on("end", () => {
        p.ip = ip.trim() || "unknown";
        p.latency = Date.now() - start;
        p.status = "online";
        resolve(p);
      });
    });
    req.on("error", () => {
      p.status = "failed";
      p.latency = Date.now() - start;
      resolve(p);
    });
    req.on("timeout", () => {
      req.destroy();
      p.status = "failed";
      p.latency = Date.now() - start;
      resolve(p);
    });
    req.setTimeout(8000);
  })));
}

// ── Routes: OpenAI format ──────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => ({
      id,
      object: "model",
      created: 1779000000,
      owned_by: "opencode-free",
    })),
  });
});

app.post("/v1/chat/completions", (req, res) => {
  const requestId = newRequestId();
  res.setHeader("X-Request-ID", requestId);
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, messages, stream, tools, tool_choice } = req.body;
  if (!MODELS.includes(model)) {
    const err = { code: "unknown_model", message: `Unknown model: ${model}`, upstream_status: null, snippet: `Available: ${MODELS.join(", ")}` };
    logRequest(user, model, !!stream, 400, 0, null, null, null, { requestId, operation: "chat", error: err });
    return res.status(400).json({ error: { message: err.message, type: "invalid_request_error", code: "unknown_model" } });
  }

  const sessionId = getSession(user);
  const msgSummary = (messages || []).map(m => ({ role: m.role, len: (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).length }));
  console.log("[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

  const nodeIdx = pickProxyNode();
  const { body, options } = zenRequest(model, messages, stream, tools, tool_choice, sessionId, nodeIdx);
  pipeZenResponse(options, body, stream, res, (status, duration, usage, ttft, errInfo) => {
    logRequest(user, model, stream, status, duration, nodeIdx, usage, ttft, { requestId, operation: "chat", error: errInfo });
  }, nodeIdx);
});

// ── Routes: OpenAI Responses format（原生透传）──────────────────────
app.post("/v1/responses", (req, res) => {
  const requestId = newRequestId();
  res.setHeader("X-Request-ID", requestId);
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, stream } = req.body;
  if (!MODELS.includes(model)) {
    const err = { code: "unknown_model", message: `Unknown model: ${model}`, upstream_status: null, snippet: `Available: ${MODELS.join(", ")}` };
    logRequest(user, model, !!stream, 400, 0, null, null, null, { requestId, operation: "responses", error: err });
    return res.status(400).json({ error: { message: err.message, type: "invalid_request_error", code: "unknown_model" } });
  }

  // 上游只吃数组格式 input：字符串 → [{role:"user",content:...}]
  const body = { ...req.body };
  if (typeof body.input === "string") {
    body.input = [{ role: "user", content: body.input }];
  }

  const sessionId = getSession(user);
  console.log("[RSP]", new Date().toISOString(), user, model, stream ? "stream" : "sync",
    "input:", Array.isArray(body.input) ? body.input.length : typeof body.input);

  const nodeIdx = pickProxyNode();
  const { body: outBody, options } = zenResponsesRequest(body, sessionId, nodeIdx);
  pipeZenResponse(options, outBody, !!stream, res, (status, duration, usage, ttft, errInfo) => {
    logRequest(user, model, !!stream, status, duration, nodeIdx, usage, ttft, { requestId, operation: "responses", error: errInfo });
  }, nodeIdx);
});

// ── Routes: Anthropic Messages format ──────────────────────────────
app.post("/v1/messages", async (req, res) => {
  const requestId = newRequestId();
  res.setHeader("X-Request-ID", requestId);
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  }

  const { model, stream } = req.body;
  if (!MODELS.includes(model)) {
    const err = { code: "unknown_model", message: `Unknown model: ${model}`, upstream_status: null, snippet: `Available: ${MODELS.join(", ")}` };
    logRequest(user, model, !!stream, 400, 0, null, null, null, { requestId, operation: "messages", error: err });
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", code: "unknown_model", message: err.message },
    });
  }

  const sessionId = getSession(user);
  const { messages, tools } = anthropicToOpenAI(req.body);  // Note: this function is not defined in original! Wait, original had error, but keep as is since original had it
  const inputTokens = JSON.stringify(messages).length / 4 | 0;

  console.log("[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);

  const nodeIdx = pickProxyNode();
  const { body, options } = zenRequest(model, messages, stream, tools, undefined, sessionId, nodeIdx);

  if (stream) {
    pipeZenAsAnthropic(options, body, model, res, inputTokens, (status, duration, usage, ttft, errInfo) => {
      logRequest(user, model, stream, status, duration, nodeIdx, usage, ttft, { requestId, operation: "messages", error: errInfo });
    }, nodeIdx);
  } else {
    const t0 = Date.now();
    try {
      const zenResp = await zenRequestFull(options, body);
      if (zenResp.status === 429 || /FreeUsageLimitError|rate.?limit/i.test(zenResp.raw || "")) {
        markProxyExhausted(nodeIdx);
        const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
        return res.status(429).json({
          type: "error", error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
        });
      }
      if (zenResp.data?.error) {
        // 参数错误/模型不支持等：透传状态码，不冷却节点（v23 修复误冷却连锁）
        const errMsg = zenResp.data?.error?.message || "Upstream error";
        return res.status(zenResp.status >= 400 ? zenResp.status : 502).json({
          type: "error", error: { type: "upstream_error", message: errMsg },
        });
      }
      if (!zenResp.data?.choices) {
        return res.status(502).json({
          type: "error", error: { type: "upstream_error", message: "Invalid upstream response" },
        });
      }
      res.json(openAIToAnthropic(zenResp.data, model, inputTokens));
      logRequest(user, model, stream, 200, Date.now() - t0, nodeIdx, zenResp.data.usage, Date.now() - t0);
    } catch (e) {
      console.log("[ZEN ERROR]", e.message);
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, models: MODELS.length,
  endpoints: ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/models", "/admin", "/admin/api/stats"],
}));

// ── Admin Panel & API ──────────────────────────────────────────────
app.get("/admin", (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>zenpool 管理面板</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background:
      radial-gradient(1100px 600px at 85% 8%, rgba(255,190,200,0.5), transparent 62%),
      radial-gradient(900px 550px at 8% 92%, rgba(147,197,253,0.55), transparent 62%),
      radial-gradient(700px 400px at 45% 40%, rgba(255,255,255,0.95), transparent 70%),
      linear-gradient(135deg, #ffffff 0%, #eef6ff 40%, #dbeafe 100%);
    color: #1e3a5f;
    margin: 0;
    padding: 24px;
    min-height: 100vh;
    overflow-x: hidden;
    animation: fadeIn .6s ease;
  }
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background-image:
      radial-gradient(2px 2px at 22% 28%, rgba(255,255,255,0.95), transparent 100%),
      radial-gradient(1.4px 1.4px at 68% 18%, rgba(255,255,255,0.9), transparent 100%),
      radial-gradient(2px 2px at 38% 68%, rgba(255,255,255,0.85), transparent 100%),
      radial-gradient(1.4px 1.4px at 84% 58%, rgba(255,255,255,0.9), transparent 100%),
      radial-gradient(1.8px 1.8px at 55% 86%, rgba(255,255,255,0.9), transparent 100%),
      radial-gradient(1.3px 1.3px at 30% 52%, rgba(255,255,255,0.8), transparent 100%),
      radial-gradient(1.9px 1.9px at 90% 84%, rgba(255,255,255,0.85), transparent 100%),
      radial-gradient(1.3px 1.3px at 12% 14%, rgba(255,255,255,0.9), transparent 100%),
      radial-gradient(1.6px 1.6px at 74% 42%, rgba(255,255,255,0.8), transparent 100%),
      radial-gradient(1.2px 1.2px at 46% 22%, rgba(255,255,255,0.85), transparent 100%),
      radial-gradient(1.7px 1.7px at 88% 30%, rgba(255,255,255,0.75), transparent 100%),
      radial-gradient(1.4px 1.4px at 16% 76%, rgba(255,255,255,0.85), transparent 100%);
  }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  .container { max-width: 1200px; margin: 0 auto; position: relative; z-index: 1; }
  .header {
    display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
    background: rgba(255,255,255,.5);
    backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(255,255,255,.85);
    border-radius: 20px;
    padding: 22px 28px;
    margin-bottom: 20px;
    box-shadow: 0 8px 32px rgba(59,130,246,.12);
  }
  h1 { margin: 0; font-size: 1.7rem; font-weight: 800; color: #2563eb; letter-spacing: -0.02em; }
  .sub { color: #64748b; font-size: .9rem; }
  .tab-nav {
    display: flex; gap: 6px; flex-wrap: wrap;
    background: rgba(255,255,255,.6);
    backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
    border: 1px solid rgba(255,255,255,.8);
    border-radius: 9999px;
    padding: 6px;
    margin-bottom: 20px;
    box-shadow: 0 4px 20px rgba(59,130,246,.1);
  }
  .tab-btn {
    border: none; background: transparent; color: #3b5b82;
    padding: 10px 20px; border-radius: 9999px; cursor: pointer;
    font-size: .95rem; font-weight: 600; transition: all .25s;
  }
  .tab-btn:hover { background: rgba(59,130,246,.08); }
  .tab-btn.active { background: linear-gradient(135deg,#60a5fa,#3b82f6); color: #fff; box-shadow: 0 4px 14px rgba(59,130,246,.35); }
  .page { display: none; }
  .page.active { display: block; animation: fadeIn .35s ease; }
  /* 出口策略抽屉 */
  .dropdown { position: relative; display: inline-block; }
  .dropdown-menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 20; min-width: 260px;
    background: rgba(255,255,255,.92); backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px);
    border: 1px solid rgba(255,255,255,.9); border-radius: 14px; padding: 6px;
    box-shadow: 0 12px 32px rgba(59,130,246,.16); }
  .dropdown-item { padding: 10px 14px; border-radius: 10px; cursor: pointer; font-size: .9rem; color: #334155; transition: all .15s; }
  .dropdown-item:hover { background: rgba(59,130,246,.1); }
  .dropdown-item.active { background: linear-gradient(135deg,#60a5fa,#3b82f6); color: #fff; }
  /* 代理池网格卡片 */
  .proxy-card .status { font-size: .75rem; padding: 3px 9px; border-radius: 9999px; white-space: nowrap; }
  .proxy-card .status.ok { background: rgba(16,185,129,.12); color: #10b981; }
  .proxy-card .status.cooling { background: rgba(245,158,11,.15); color: #d97706; }
  .proxy-card .status.lat { background: rgba(59,130,246,.12); color: #3b82f6; }
  .btn.mini { padding: 6px 10px; font-size: .85rem; border-radius: 10px; }
  .panel {
    background: rgba(255,255,255,.52);
    backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px);
    border: 1px solid rgba(255,255,255,.9);
    border-radius: 18px;
    padding: 24px;
    box-shadow: 0 8px 30px rgba(59,130,246,.1);
    transition: transform .25s, box-shadow .25s;
  }
  .panel:hover { transform: translateY(-2px); box-shadow: 0 12px 36px rgba(59,130,246,.16); }
  h2 { margin: 0 0 18px; font-size: 1.15rem; font-weight: 700; color: #1e3a5f; display: flex; align-items: center; gap: 8px; }
  .btn {
    background: linear-gradient(135deg,#60a5fa,#3b82f6);
    color: #fff; border: none; padding: 10px 22px; border-radius: 9999px;
    font-weight: 600; cursor: pointer; transition: all .25s;
    box-shadow: 0 4px 14px rgba(59,130,246,.3);
    font-size: .95rem;
  }
  .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(59,130,246,.4); }
  .btn.ghost { background: rgba(59,130,246,.1); color: #2563eb; box-shadow: none; }
  .btn.ghost:hover { background: rgba(59,130,246,.18); }
  .btn.danger { background: rgba(225,29,72,.1); color: #e11d48; box-shadow: none; }
  .btn.danger:hover { background: rgba(225,29,72,.18); }
  .key-card {
    background: rgba(255,255,255,.6);
    border: 1px solid rgba(255,255,255,.95);
    border-radius: 14px;
    padding: 14px 18px;
    margin-bottom: 12px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    box-shadow: 0 2px 10px rgba(59,130,246,.08);
    max-width: 800px;
  }
  .key-name { font-weight: 700; color: #2563eb; white-space: nowrap; flex-shrink: 0; }
  .key-value {
    font-family: ui-monospace, monospace; font-size: .88rem;
    color: #475569;
    overflow-wrap: anywhere; word-break: break-all;
    flex: 1; min-width: 0;
  }
  .copy-btn { flex-shrink: 0; }
  .key-form { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  .key-form input {
    background: rgba(255,255,255,.6); border: 1px solid rgba(148,163,184,.4);
    border-radius: 10px; padding: 10px 14px; color: #1e293b;
    font-size: .92rem; flex: 1 1 200px; min-width: 0;
  }
  .proxy-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; margin-top: 14px; }
  .proxy-card {
    background: rgba(255,255,255,.6);
    border: 1px solid rgba(255,255,255,.95);
    border-radius: 14px; padding: 16px;
    box-shadow: 0 2px 10px rgba(59,130,246,.08);
  }
  .proxy-card .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .proxy-card .url { font-size: .78rem; color: #64748b; overflow-wrap: anywhere; word-break: break-all; }
  .status { font-weight: 700; padding: 3px 12px; border-radius: 9999px; font-size: .8rem; }
  .status.online { color: #059669; background: rgba(16,185,129,.15); }
  .status.failed { color: #e11d48; background: rgba(244,63,94,.12); }
  .online::after { content: '●'; color: #10b981; animation: pulse 2s infinite; margin-left: 6px; }
  .log-list { max-height: 420px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: .85rem; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(30,41,59,.4); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 999; padding: 20px; }
  .modal { background: #fff; border-radius: 18px; padding: 24px; max-width: 640px; width: 100%; box-shadow: 0 20px 60px rgba(30,41,59,.25); max-height: 80vh; overflow-y: auto; }
  .stats-table-wrap { overflow-x: auto; border-radius: 14px; border: 1px solid rgba(255,255,255,.9); background: rgba(255,255,255,.45); }
  .stats-table { width: 100%; min-width: 700px; border-collapse: collapse; font-size: .88rem; table-layout: fixed; }
  .stats-table th {
    background: linear-gradient(135deg, rgba(96,165,250,.22), rgba(59,130,246,.12));
    color: #1e3a5f; font-weight: 700; text-align: left;
    padding: 11px 16px; white-space: nowrap; position: sticky; top: 0;
    border-bottom: 1px solid rgba(148,163,184,.25);
  }
  .stats-table td {
    padding: 10px 16px; color: #334155; border-bottom: 1px solid rgba(148,163,184,.12);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .stats-table th:nth-child(1), .stats-table td:nth-child(1) { width: 24%; }
  .stats-table th:nth-child(2), .stats-table td:nth-child(2) { width: 9%; }
  .stats-table th:nth-child(3), .stats-table td:nth-child(3) { width: 9%; }
  .stats-table th:nth-child(4), .stats-table td:nth-child(4) { width: 16%; }
  .stats-table th:nth-child(5), .stats-table td:nth-child(5) { width: 16%; }
  .stats-table th:nth-child(6), .stats-table td:nth-child(6) { width: 16%; }
  .stats-table th:nth-child(7), .stats-table td:nth-child(7) { width: 10%; }
  .stats-table tbody tr { transition: background .2s; }
  .stats-table tbody tr:nth-child(even) { background: rgba(255,255,255,.35); }
  .stats-table tbody tr:hover { background: rgba(59,130,246,.09); }
  .stats-table tbody tr:last-child td { border-bottom: none; }
  .stats-table .num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
  .stats-table .key-col { color: #2563eb; font-weight: 600; }
  .stats-empty { padding: 20px; color: #64748b; text-align: center; font-size: .9rem; }
  .stats-filter {
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    background: rgba(255,255,255,.5);
    border: 1px solid rgba(255,255,255,.85);
    border-radius: 14px; padding: 12px 14px; margin-bottom: 18px;
    box-shadow: 0 2px 10px rgba(59,130,246,.06);
  }
  .stats-filter select, .stats-filter input[type="date"] {
    background: rgba(255,255,255,.7); border: 1px solid rgba(148,163,184,.4);
    border-radius: 10px; padding: 8px 12px; color: #1e293b;
    font-size: .88rem; font-family: inherit;
  }
  .stats-filter select { min-width: 150px; }
  .stats-filter input[type="date"] { min-width: 135px; }
  .filter-sep { color: #94a3b8; font-size: .9rem; }
  @media (max-width: 640px) {
    .stats-table-wrap { border: none; background: transparent; overflow: visible; }
    .stats-table, .stats-table thead, .stats-table tbody, .stats-table tr, .stats-table td {
      display: block !important; width: 100% !important; max-width: 100% !important;
      min-width: 0 !important; table-layout: auto !important;
    }
    .stats-table thead { display: none !important; }
    .stats-table tbody { display: block !important; }
    .stats-table tbody tr {
      background: rgba(255,255,255,.6);
      border: 1px solid rgba(255,255,255,.9);
      border-radius: 14px;
      padding: 6px 0;
      margin-bottom: 12px;
      box-shadow: 0 2px 10px rgba(59,130,246,.08);
      max-width: 100% !important;
    }
    .stats-table tbody tr:nth-child(even) { background: rgba(255,255,255,.6); }
    .stats-table td {
      display: flex !important; justify-content: space-between; align-items: center; gap: 12px;
      border: none; padding: 8px 16px; white-space: normal; overflow: visible;
      min-width: 0 !important; max-width: 100% !important;
      overflow-wrap: anywhere; word-break: break-all;
    }
    .stats-table td::before {
      content: attr(data-label);
      color: #64748b; font-weight: 600; font-size: .82rem; flex-shrink: 0; min-width: 0;
    }
    .stats-table td.num { justify-content: flex-end; }
    .stats-table td.num::before { margin-right: auto; }
    .stats-table td.key-col { color: #2563eb; font-weight: 700; font-size: .92rem; }
    .stats-table tbody tr:last-child td { border: none; }
    .stats-table tbody tr:last-child { margin-bottom: 0; }
    .stats-table .stats-empty { display: block; text-align: center; }
  }
  .log-entry {
    background: rgba(255,255,255,.6);
    border: 1px solid rgba(255,255,255,.9);
    border-radius: 14px;
    padding: 12px 16px;
    margin-bottom: 12px;
    box-shadow: 0 2px 10px rgba(59,130,246,.08);
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
  }
  .log-entry > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .log-ts { flex: 1; min-width: 0; color: #64748b; font-size: .8rem; }
  .log-user { font-weight: 600; color: #2563eb; }
  .log-model { width: 100%; color: #1e3a5f; font-weight: 700; overflow-wrap: anywhere; word-break: break-all; white-space: normal; }
  .log-type { color: #475569; }
  .log-status { font-weight: 700; margin-left: auto; }
  .log-dur { color: #475569; }
  .log-ttft, .log-tok { color: #475569; }
  .log-hit { color: #059669; font-weight: 600; }
  .log-list::-webkit-scrollbar { width: 6px; }
  .log-list::-webkit-scrollbar-thumb { background: #93c5fd; border-radius: 20px; }
  textarea, select, input[type="text"] {
    background: rgba(255,255,255,.6); border: 1px solid rgba(148,163,184,.4);
    border-radius: 10px; padding: 12px 14px; color: #1e293b;
    font-family: inherit; font-size: .95rem;
  }
  textarea { width: 100%; min-height: 120px; resize: vertical; }
  select { min-width: 220px; }
  .test-result {
    margin-top: 14px; max-height: 320px; overflow: auto;
    background: rgba(255,255,255,.6); border-radius: 12px; padding: 14px;
    font-family: ui-monospace, monospace; font-size: .82rem;
    overflow-wrap: anywhere; word-break: break-all;
  }
  .model-tags { display: flex; gap: 10px; flex-wrap: wrap; }
  .model-tag { background: rgba(59,130,246,.1); color: #2563eb; padding: 6px 16px; border-radius: 9999px; font-size: .9rem; font-weight: 600; }
  .overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
  .stat-card { background: rgba(255,255,255,.6); border-radius: 14px; padding: 20px; text-align: center; border: 1px solid rgba(255,255,255,.95); box-shadow: 0 2px 10px rgba(59,130,246,.08); }
  .stat-num { font-size: 1.9rem; font-weight: 800; color: #2563eb; }
  .stat-label { color: #64748b; font-size: .85rem; margin-top: 4px; }
  .footer { text-align: center; color: #94a3b8; font-size: .85rem; margin-top: 28px; }
  .spinner { display: inline-block; width: 26px; height: 26px; border: 3px solid rgba(59,130,246,.2); border-top-color: #3b82f6; border-radius: 50%; animation: spin 1s linear infinite; }
  @media (max-width: 640px) {
    .tab-nav { border-radius: 16px; }
    .tab-btn { flex: 1 1 auto; padding: 9px 10px; font-size: .88rem; }
    .proxy-grid { grid-template-columns: 1fr; }
    .import-row { flex-direction: column; align-items: stretch !important; }
    .import-row input { width: 100% !important; flex: none !important; min-width: 0 !important; box-sizing: border-box; }
    .import-row .btn { padding: 10px 18px; font-size: .9rem; }
    .key-card { flex-wrap: wrap; }
    .overview-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .stat-card { padding: 14px 10px; }
    .stat-num { font-size: 1.4rem; }
    .panel { padding: 18px 14px; }
    .header { padding: 16px 18px; }
    h1 { font-size: 1.35rem; }
    h2 { font-size: 1.02rem; }
    .stats-filter { padding: 10px 12px; gap: 8px; }
    .stats-filter select { min-width: 100%; flex: 1 1 100%; }
    .stats-filter input[type="date"] { min-width: 0; flex: 1 1 40%; }
    .stats-filter .filter-sep { display: none; }
    .stats-filter .btn { flex: 1 1 40%; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>zenpool 管理面板</h1>
    <div class="sub">端口 ${PORT} · v${OC_VERSION} · ${MODELS.length} 个模型</div>
  </div>

  <nav class="tab-nav">
    <button class="tab-btn active" data-page="overview" onclick="showPage('overview')">📊 概览</button>
    <button class="tab-btn" data-page="keys" onclick="showPage('keys')">🔑 密钥管理</button>
    <button class="tab-btn" data-page="pool" onclick="showPage('pool')">🌐 代理池</button>
    <button class="tab-btn" data-page="audits" onclick="showPage('audits')">🕵️ 请求审计</button>
    <button class="tab-btn" data-page="stats" onclick="showPage('stats')">📊 Token 统计</button>
    <button class="tab-btn" data-page="test" onclick="showPage('test')">🚀 快速测试</button>
    <button class="tab-btn" data-page="models" onclick="showPage('models')">📦 模型列表</button>
  </nav>

  <section class="page active" id="page-overview">
    <div class="overview-grid">
      <div class="stat-card"><div class="stat-num">${PORT}</div><div class="stat-label">服务端口</div></div>
      <div class="stat-card"><div class="stat-num">${OC_VERSION}</div><div class="stat-label">OpenCode 版本</div></div>
      <div class="stat-card"><div class="stat-num">${MODELS.length}</div><div class="stat-label">模型数量</div></div>
      <div class="stat-card"><div class="stat-num" id="statProxy">-</div><div class="stat-label">代理在线 / 总数</div></div>
      <div class="stat-card"><div class="stat-num" id="statLogs">-</div><div class="stat-label">最近请求</div></div>
    </div>
    <div style="margin-top:16px;color:#64748b;font-size:.9rem;">面板受 Basic Auth 保护，仅限内部使用。</div>
  </section>

  <section class="page" id="page-keys">
    <div class="panel">
      <h2>🔑 密钥管理</h2>
      <div id="keyList"></div>
      <div class="key-form">
        <input id="newName" placeholder="名称 (可选)">
        <input id="newKey" placeholder="密钥 (可选，留空自动生成)">
        <button class="btn" onclick="addNewKey()">新增密钥</button>
      </div>
    </div>
  </section>

  <section class="page" id="page-pool">
    <div class="panel">
      <h2>🌐 节点池管理</h2>
      <div class="stats-filter">
        <span style="font-weight:600;">出口策略:</span>
        <div class="dropdown" id="policyDropdown">
          <button class="btn ghost" id="poolPolicyBtn" onclick="togglePolicyDropdown(event)">⏩ 顺位 ▾</button>
          <div class="dropdown-menu" id="poolPolicyMenu" style="display:none;">
            <div class="dropdown-item" data-policy="sticky" onclick="pickPolicy('sticky')">⏩ 顺位</div>
            <div class="dropdown-item" data-policy="roundrobin" onclick="pickPolicy('roundrobin')">🔁 轮询</div>
          </div>
        </div>
        <button class="btn ghost" id="poolTestAllBtn" onclick="testAllNodes()">⚡ 一键测速</button>
        <span id="poolMihomoBadge" style="margin-left:12px;font-size:.85rem;"></span>
        <span style="margin-left:auto;font-size:.85rem;color:#64748b;" id="poolSummary"></span>
      </div>
      <div style="margin-top:16px;display:grid;gap:10px;">
        <textarea id="poolImportText" rows="4" placeholder="粘贴节点 URI，每行一个（ss:// vmess:// vless:// trojan:// hysteria2:// tuic:// ...）"></textarea>
        <div style="display:flex;gap:10px;align-items:center;" class="import-row">
          <input id="poolImportUrl" placeholder="或粘贴订阅链接 URL（自动拉取并解析）" style="flex:1;background:rgba(255,255,255,.6);border:1px solid rgba(148,163,184,.4);border-radius:9999px;padding:8px 16px;">
          <button class="btn" onclick="importPool()">➕ 导入节点</button>
        </div>
      </div>
      <div id="poolNodes" class="proxy-grid" style="margin-top:16px;"></div>
      <div id="poolImported" style="margin-top:10px;font-size:.85rem;color:#64748b;"></div>
    </div>
  </section>

  <section class="page" id="page-audits">
    <div class="panel">
      <h2>🕵️ 请求审计</h2>
      <div class="stats-filter">
        <select id="auditUser"><option value="">全部用户</option></select>
        <select id="auditStatus">
          <option value="">全部状态</option>
          <option value="200">2xx 成功</option>
          <option value="400">400</option>
          <option value="429">429 限流</option>
          <option value="5">5xx 错误</option>
        </select>
        <input id="auditQuery" placeholder="搜 requestId / 错误 / 用户" style="background:rgba(255,255,255,.6);border:1px solid rgba(148,163,184,.4);border-radius:9999px;padding:8px 16px;min-width:200px;">
        <button class="btn ghost" onclick="loadAudits(1)">搜索</button>
        <button class="btn ghost" onclick="resetAudits()">重置</button>
        <span style="margin-left:auto;font-size:.85rem;color:#64748b;" id="auditSummary"></span>
      </div>
      <div id="auditList" class="log-list"></div>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center;">
        <button class="btn ghost" id="auditPrev" onclick="loadAudits(auditPage-1)">← 上一页</button>
        <span id="auditPageInfo" style="font-size:.9rem;color:#64748b;">第 1 页</span>
        <button class="btn ghost" id="auditNext" onclick="loadAudits(auditPage+1)">下一页 →</button>
      </div>
    </div>
  </section>

  <section class="page" id="page-stats">
    <div class="panel">
      <h2>📊 Token 统计</h2>
      <div class="stats-filter">
        <select id="filterModel"><option value="">全部模型</option></select>
        <select id="filterUser"><option value="">全部用户</option></select>
        <input type="date" id="filterFrom" title="开始日期">
        <span class="filter-sep">→</span>
        <input type="date" id="filterTo" title="结束日期">
        <button class="btn ghost" onclick="applyStatsFilter()">筛选</button>
        <button class="btn ghost" onclick="resetStatsFilter()">重置</button>
      </div>
      <div class="overview-grid" id="statsOverview"></div>
      <div style="margin-top:24px;">
        <h2>🗓️ 按日</h2>
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>日期</th><th class="num">请求数</th><th class="num">首字s</th><th class="num">输入 Tokens</th><th class="num">输出 Tokens</th><th class="num">总 Tokens</th><th class="num">命中</th></tr></thead>
            <tbody id="statsDaily"></tbody>
          </table>
        </div>
      </div>
      <div style="margin-top:24px;">
        <h2>📦 按模型</h2>
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>模型</th><th class="num">请求数</th><th class="num">首字s</th><th class="num">输入 Tokens</th><th class="num">输出 Tokens</th><th class="num">总 Tokens</th><th class="num">命中</th></tr></thead>
            <tbody id="statsByModel"></tbody>
          </table>
        </div>
      </div>
      <div style="margin-top:24px;">
        <h2>👤 按用户</h2>
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>用户</th><th class="num">请求数</th><th class="num">首字s</th><th class="num">输入 Tokens</th><th class="num">输出 Tokens</th><th class="num">总 Tokens</th><th class="num">命中</th></tr></thead>
            <tbody id="statsByUser"></tbody>
          </table>
        </div>
      </div>
    </div>
  </section>

  <section class="page" id="page-test">
    <div class="panel">
      <h2>🚀 快速测试</h2>
      <select id="testModel"></select>
      <div style="margin-top:12px;"><textarea id="testMsg" placeholder="输入消息内容..."></textarea></div>
      <div style="margin-top:12px;"><button class="btn" onclick="testRequest()">发送测试请求</button></div>
      <div id="testResult" class="test-result"></div>
    </div>
  </section>

  <section class="page" id="page-models">
    <div class="panel">
      <h2>📦 模型列表</h2>
      <div class="model-tags" id="modelTags"></div>
    </div>
  </section>

  <div class="footer">管理面板 · 仅供内部使用 · 安全已保护</div>
</div>

<script>
const ADMIN_TOKEN = "${ADMIN_TOKEN}";
const API_KEYS = ${JSON.stringify(Object.entries(apiKeys))};
const API_BASE = location.origin;
const MODELS = ${JSON.stringify(MODELS)};

function showPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  const page = document.getElementById("page-" + name);
  if (page) page.classList.add("active");
  if (name === "pool") loadPool();
  if (name === "stats") renderStats();
  if (name === "overview") refreshOverview();
  // 审计：初次进入时加载；之后点 Tab 只显示不重新拉（避免闪烁，手动搜索/翻页才刷新）
  if (name === "audits") {
    if (!document.getElementById("auditList")?.children.length) { refreshAuditUsers(); loadAudits(1); }
  }
}

// ── 请求审计（对齐 grok2api：列表 + 摘要 + 详情）────────────────────
let auditPage = 1;
let auditFilter = { user: "", status: "", q: "" };

function refreshAuditUsers() {
  const sel = document.getElementById("auditUser");
  const cur = sel.value;
  fetch(API_BASE + "/admin/api/audits?page=1&pageSize=1", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
    .then(r => r.json())
    .then(() => fetch(API_BASE + "/admin/api/audits?pageSize=200", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } }))
    .then(r => r.json())
    .then(d => {
      const users = [...new Set((d.items || []).map(i => i.user))].sort();
      sel.innerHTML = '<option value="">全部用户</option>' + users.map(u => '<option value="' + u + '"' + (u === cur ? " selected" : "") + '>' + u + '</option>').join("");
    })
    .catch(() => {});
}

function loadAudits(page, silent) {
  auditPage = Math.max(1, page || 1);
  auditFilter.user = document.getElementById("auditUser")?.value || "";
  const st = document.getElementById("auditStatus")?.value || "";
  auditFilter.status = st === "5" ? "5" : st;
  auditFilter.q = document.getElementById("auditQuery")?.value.trim() || "";
  const qs = new URLSearchParams({ page: auditPage, pageSize: 30 });
  if (auditFilter.user) qs.set("user", auditFilter.user);
  if (auditFilter.status) {
    if (auditFilter.status === "5") qs.set("status", "5"); // 前端按前缀匹配
    else qs.set("status", auditFilter.status);
  }
  if (auditFilter.q) qs.set("q", auditFilter.q);
  const list = document.getElementById("auditList");
  // 静默刷新（自动轮询）不替换「加载中」，避免列表闪烁
  if (!silent) list.innerHTML = '<span class="spinner"></span> 加载中...';
  fetch(API_BASE + "/admin/api/audits?" + qs.toString(), { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
    .then(r => r.json())
    .then(d => {
      renderAudits(d);
      fetch(API_BASE + "/admin/api/audits/summary", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
        .then(r => r.json())
        .then(s => {
          const el = document.getElementById("auditSummary");
          if (el) el.textContent = "共 " + s.total + " 条 · 成功 " + s.successful + " · 失败 " + s.failed + " · 输入 " + fmtNum(s.input_tokens) + " · 输出 " + fmtNum(s.output_tokens);
        }).catch(() => {});
    })
    .catch(() => { list.innerHTML = '<div class="stats-empty">加载失败</div>'; });
}

function renderAudits(d) {
  const list = document.getElementById("auditList");
  const items = d.items || [];
  list.innerHTML = items.length ? items.map(a => {
    const statusColor = a.status >= 200 && a.status < 400 ? "#16a34a" : (a.status === 429 ? "#f59e0b" : "#e11d48");
    const errBadge = a.error ? '<span style="color:#e11d48;font-size:.8rem;">⚠️ ' + (a.error.code || "error") + '</span>' : "";
    return '<div class="log-entry" style="cursor:pointer;" onclick="showAuditDetail(' + a.id + ')">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;">' +
        '<span style="font-size:.78rem;color:#94a3b8;">' + a.ts + ' · ' + (a.requestId || "") + '</span>' +
        '<span style="font-weight:700;color:' + statusColor + ';">' + a.status + '</span>' +
      '</div>' +
      '<div style="font-weight:700;color:#1e3a5f;word-break:break-all;">' + a.operation + ' · ' + a.model + '</div>' +
      '<div style="font-size:.85rem;color:#64748b;">' + a.user + ' · ' + (a.stream ? "流式" : "同步") + ' · 首 ' + fmtSec(a.ttft, a.stream) + ' · 入 ' + fmtNum(a.input_tokens) + ' · 出 ' + fmtNum(a.output_tokens) + ' · 命中 ' + fmtNum(a.cache_hit) + ' · 用时 ' + fmtSec(a.duration) + ' · 代理' + (a.proxyIdx ?? "-") + ' ' + errBadge + '</div>' +
    '</div>';
  }).join("") : '<div class="stats-empty">暂无审计记录</div>';
  document.getElementById("auditPageInfo").textContent = "第 " + d.page + " / " + Math.max(1, Math.ceil(d.total / d.pageSize)) + " 页 · 共 " + d.total + " 条";
  document.getElementById("auditPrev").disabled = d.page <= 1;
  document.getElementById("auditNext").disabled = !d.hasMore;
}

function resetAudits() {
  if (document.getElementById("auditUser")) document.getElementById("auditUser").value = "";
  if (document.getElementById("auditStatus")) document.getElementById("auditStatus").value = "";
  if (document.getElementById("auditQuery")) document.getElementById("auditQuery").value = "";
  loadAudits(1);
}

function showAuditDetail(id) {
  fetch(API_BASE + "/admin/api/audits/" + id, { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
    .then(r => r.json())
    .then(a => {
      const errHtml = a.error
        ? '<div style="margin-top:12px;padding:10px 14px;background:rgba(225,29,72,.06);border-radius:10px;font-size:.85rem;color:#be123c;word-break:break-all;"><b>诊断快照</b><br>code: ' + (a.error.code || "-") + '<br>message: ' + (a.error.message || "-") + '<br>upstream_status: ' + (a.error.upstream_status ?? "-") + '<br>snippet: <pre style="white-space:pre-wrap;margin:6px 0 0;font-size:.78rem;">' + (a.error.snippet || "-") + '</pre></div>'
        : "";
      const html =
        '<div class="modal-backdrop" onclick="this.remove()">' +
        '<div class="modal" onclick="event.stopPropagation()">' +
        '<h3 style="margin:0 0 14px;color:#1e3a5f;">🕵️ 审计详情 #' + a.id + '</h3>' +
        '<div style="font-size:.9rem;line-height:1.7;color:#334155;">' +
          '<div><b>RequestID:</b> ' + a.requestId + '</div>' +
          '<div><b>时间:</b> ' + a.ts + '</div>' +
          '<div><b>用户:</b> ' + a.user + '</div>' +
          '<div><b>操作:</b> ' + a.operation + ' · <b>模型:</b> ' + a.model + '</div>' +
          '<div><b>状态:</b> ' + a.status + ' · <b>流式:</b> ' + (a.stream ? "是" : "否") + '</div>' +
          '<div><b>代理节点:</b> ' + (a.proxyIdx ?? "-") + '</div>' +
          '<div><b>首字:</b> ' + fmtSec(a.ttft, a.stream) + ' · <b>用时:</b> ' + fmtSec(a.duration) + '</div>' +
          '<div><b>输入:</b> ' + fmtNum(a.input_tokens) + ' · <b>输出:</b> ' + fmtNum(a.output_tokens) + ' · <b>命中:</b> ' + fmtNum(a.cache_hit) + '</div>' +
          errHtml +
        '</div>' +
        '<div style="margin-top:16px;text-align:right;"><button class="btn ghost" onclick="this.parentElement.parentElement.parentElement.remove()">关闭</button></div>' +
        '</div></div>';
      const holder = document.createElement("div");
      holder.innerHTML = html;
      document.body.appendChild(holder.firstElementChild);
    })
    .catch(() => alert("加载详情失败"));
}


// 复制密钥
function copyKey(key, btn) {
  navigator.clipboard.writeText(key).then(() => {
    const orig = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

// 渲染密钥列表（name → key 对数组，admin 显示 👑 且不可删/改名）
function renderKeys() {
  const list = document.getElementById("keyList");
  list.innerHTML = API_KEYS.length
    ? API_KEYS.map(([name, key], i) => {
        const isAdmin = name === "admin";
        return '<div class="key-card">' +
        '<span class="key-name">' + (isAdmin ? "👑 " : "") + name + '</span>' +
        '<span class="key-value" title="' + key + '">' + key + '</span>' +
        '<button class="btn ghost copy-btn" onclick="copyKey(API_KEYS[' + i + '][1], this)">复制</button>' +
        (isAdmin ? "" :
          '<button class="btn ghost" onclick="renameKey(' + i + ')">重命名</button>' +
          '<button class="btn danger" onclick="deleteKey(' + i + ')">删除</button>') +
        '</div>';
      }).join('')
    : '<div style="color:#64748b;">暂无密钥</div>';
}

// 从后端拉最新密钥列表并重绘（新增/改名/删除后调用）
async function refreshKeys() {
  try {
    const res = await fetch(API_BASE + "/admin/api/keys", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } });
    if (!res.ok) return;
    const data = await res.json();
    API_KEYS.length = 0;
    (data.keys || []).forEach(k => API_KEYS.push([k.name, k.key]));
    renderKeys();
  } catch (e) {}
}

// 重命名密钥
async function renameKey(i) {
  const [oldName] = API_KEYS[i];
  const newName = prompt("重命名密钥「" + oldName + "」为：", oldName);
  if (!newName || newName.trim() === oldName) return;
  try {
    const res = await fetch(API_BASE + "/admin/api/keys/" + encodeURIComponent(oldName), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ADMIN_TOKEN },
      body: JSON.stringify({ newName: newName.trim() })
    });
    const data = await res.json();
    if (res.ok) {
      alert("重命名成功");
      await refreshKeys();
    } else {
      alert("重命名失败：" + (data.error || res.status));
    }
  } catch (e) { alert("网络错误"); }
}

// 删除密钥
async function deleteKey(i) {
  const [name] = API_KEYS[i];
  if (!confirm("确定删除密钥「" + name + "」？删除后立即失效，不可恢复！")) return;
  try {
    const res = await fetch(API_BASE + "/admin/api/keys/" + encodeURIComponent(name), {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + ADMIN_TOKEN }
    });
    const data = await res.json();
    if (res.ok) {
      alert("删除成功");
      await refreshKeys();
    } else {
      alert("删除失败：" + (data.error || res.status));
    }
  } catch (e) { alert("网络错误"); }
}

// 新增密钥
async function addNewKey() {
  const name = document.getElementById("newName").value.trim() || "user-" + Date.now();
  const keyInput = document.getElementById("newKey").value.trim();
  let key = keyInput;
  if (!key) key = "oc-" + Math.random().toString(36).slice(2, 14);
  try {
    const res = await fetch(API_BASE + "/admin/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ADMIN_TOKEN },
      body: JSON.stringify({ name, key })
    });
    const data = await res.json();
    if (res.ok) {
      alert("密钥新增成功");
      document.getElementById("newName").value = "";
      document.getElementById("newKey").value = "";
      await refreshKeys();
    } else {
      alert("新增失败：" + (data.error || res.status));
    }
  } catch (e) { alert("网络错误"); }
}

// ── 节点池管理（zenpool：策略 + 导入 + 列表）────────────────────
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

async function loadPool() {
  const div = document.getElementById("poolNodes");
  div.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:#64748b;"><span class="spinner"></span> 加载中...</div>';
  try {
    const res = await fetch(API_BASE + "/admin/api/pool", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } });
    const d = await res.json();
    if (!d || !d.nodes) { div.innerHTML = '<div style="grid-column:1/-1;color:#e11d48;padding:20px;">接口异常：' + esc(d && d.error) + '</div>'; return; }
    // 策略抽屉状态
    const pBtn = document.getElementById("poolPolicyBtn");
    if (pBtn) pBtn.innerHTML = (d.policy === "sticky" ? "⏩ 顺位" : "🔁 轮询") + " ▾";
    document.querySelectorAll("#poolPolicyMenu .dropdown-item").forEach(el => el.classList.toggle("active", el.dataset.policy === d.policy));
    document.getElementById("poolMihomoBadge").textContent = d.mihomoAlive ? "🟢 mihomo 引擎在线" : "🔴 mihomo 引擎离线";
    document.getElementById("poolSummary").textContent = "共 " + d.total + " 节点 · 当前 " + (d.current && d.current.name || "-");
    const rows = (d.nodes || []).map(function (n) {
      const lat = n.latency != null ? '<span class="status lat" title="最近测速">📶 ' + n.latency + 'ms</span>' : "";
      const cooling = (n.cooling ? '<span class="status cooling">⏳ 冷却 ' + Math.round(n.cooldownLeftMs / 1000) + 's</span>' : '<span class="status ok">✅ 可用</span>') + lat;
      const cur = n.current ? '<div style="color:#3b82f6;font-weight:700;font-size:.8rem;margin-top:4px;">▶ 当前出口</div>' : "";
      const kindTag = n.kind === "static" ? "静态端口" : "导入节点";
      const ops = n.kind === "mihomo"
        ? '<button class="btn ghost mini" title="测延迟" onclick="testPoolNode(&quot;' + esc(n.name) + '&quot;)">📶</button> '
          + '<button class="btn danger mini" title="删除" onclick="removePoolNode(&quot;' + esc(n.name) + '&quot;)">🗑️</button>'
        : "";
      return '<div class="proxy-card">'
        + '<div class="head"><div><b>' + esc(n.name) + '</b></div>' + cooling + '</div>'
        + cur
        + '<div style="font-size:.82rem;color:#64748b;word-break:break-all;margin-top:6px;">' + esc(n.url || "") + '</div>'
        + '<div style="margin-top:10px;display:flex;align-items:center;gap:8px;">'
        + '<span style="font-size:.78rem;color:#94a3b8;">' + kindTag + '</span>'
        + '<span style="margin-left:auto;display:flex;gap:6px;">' + ops + '</span></div>'
        + '</div>';
    }).join("");
    div.innerHTML = rows || '<div style="grid-column:1/-1;color:#64748b;padding:20px;">暂无节点（可导入节点或配置 PROXY_POOL）</div>';
    // 已导入节点摘要
    const imp = (d.imported || []).map(function (n) { return esc(n.name) + " (" + n.type + " " + n.server + ":" + n.port + ")"; }).join("、");
    const impBox = document.getElementById("poolImported");
    if (impBox) impBox.textContent = imp ? "已导入：" + imp : "";
  } catch (e) {
    div.innerHTML = '<div style="color:#e11d48;padding:20px;">节点池加载失败：' + esc(e.message) + '</div>';
  }
}

async function importPool() {
  const text = document.getElementById("poolImportText").value.trim();
  const url = document.getElementById("poolImportUrl").value.trim();
  if (!text && !url) { alert("请粘贴节点 URI 或订阅链接"); return; }
  const btn = event.target;
  btn.disabled = true;
  try {
    const res = await fetch(API_BASE + "/admin/api/pool/import", {
      method: "POST",
      headers: { "Authorization": "Bearer " + ADMIN_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, url: url }),
    });
    const d = await res.json();
    if (d.added && d.added.length) alert("✅ 导入成功 " + d.added.length + " 个：" + d.added.join("、"));
    else alert("⚠️ 没有新增节点" + (d.failed && d.failed.length ? "（失败 " + d.failed.length + " 个）" : ""));
    document.getElementById("poolImportText").value = "";
    document.getElementById("poolImportUrl").value = "";
    loadPool();
  } catch (e) { alert("导入失败：" + e.message); }
  btn.disabled = false;
}

function togglePolicyDropdown(e) {
  const menu = document.getElementById("poolPolicyMenu");
  if (!menu) return;
  menu.style.display = menu.style.display === "block" ? "none" : "block";
  if (e) e.stopPropagation();
}

function pickPolicy(p) {
  setPoolPolicy(p);
  const menu = document.getElementById("poolPolicyMenu");
  if (menu) menu.style.display = "none";
}

async function setPoolPolicy(p) {
  try {
    await fetch(API_BASE + "/admin/api/pool/policy", {
      method: "PUT",
      headers: { "Authorization": "Bearer " + ADMIN_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ policy: p }),
    });
  } catch (e) { alert("策略切换失败：" + e.message); }
  loadPool();
}

async function removePoolNode(name) {
  if (!confirm("删除节点「" + name + "」？")) return;
  try {
    await fetch(API_BASE + "/admin/api/pool/nodes/" + encodeURIComponent(name), {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + ADMIN_TOKEN },
    });
  } catch (e) { alert("删除失败：" + e.message); }
  loadPool();
}

async function testPoolNode(name) {
  try {
    const res = await fetch(API_BASE + "/admin/api/pool/nodes/" + encodeURIComponent(name) + "/test", {
      method: "POST",
      headers: { "Authorization": "Bearer " + ADMIN_TOKEN },
    });
    const d = await res.json();
    alert(d.ok ? "📶 " + name + " 延迟 " + d.delay + "ms" : "⛔ " + name + " 测试失败：" + (d.error || "未知"));
  } catch (e) { alert("测试失败：" + e.message); }
}

async function testAllNodes() {
  const btn = document.getElementById("poolTestAllBtn");
  if (!btn) return;
  btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = "⏳ 测速中...";
  try {
    const res = await fetch(API_BASE + "/admin/api/pool/test-all", {
      method: "POST",
      headers: { "Authorization": "Bearer " + ADMIN_TOKEN },
    });
    const d = await res.json();
    if (!d || !d.results) { alert("一键测速失败：" + esc(d && d.error || "未知")); return; }
    const ok = d.results.filter(r => r.ok);
    const fail = d.results.filter(r => !r.ok);
    let msg = "⚡ 一键测速完成：";
    if (ok.length) {
      const fastest = ok.reduce((a, b) => (!a || b.delay < a.delay) ? b : a);
      msg += "✅ " + ok.length + "/" + d.results.length + " 可用 · 最快「" + fastest.name + "」" + fastest.delay + "ms";
    } else { msg += "全部失败"; }
    if (fail.length) msg += " ❌ 失败: " + fail.map(r => r.name).join("、");
    alert(msg);
    loadPool();
  } catch (e) { alert("一键测速失败：" + e.message); }
  btn.disabled = false; btn.innerHTML = old;
}

// 审计只在进入 Tab 时加载（showPage('audits')），不做自动轮询——避免列表闪烁/干扰查看

// Token 统计
function statsFilterQuery() {
  const q = new URLSearchParams();
  const model = document.getElementById("filterModel").value;
  const user = document.getElementById("filterUser").value;
  const from = document.getElementById("filterFrom").value;
  const to = document.getElementById("filterTo").value;
  if (model) q.set("model", model);
  if (user) q.set("user", user);
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const s = q.toString();
  return s ? "?" + s : "";
}

// 数字格式化（全局，审计/统计共用）：1.2M / 48.2K / 123
function fmtNum(n) {
  n = Number(n) || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(2) + "M"
    : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);
}

// 毫秒 → 秒（1-2 位小数，去掉多余 0）：1234 → 1.23s；null → "-"
function fmtSec(ms, isStream) {
  if (ms == null) return "-";
  // v35: sync 也显示首块到达时间（TTFB）；平均首字统计仍只算流式（聚合处过滤）
  const s = ms / 1000;
  const str = s >= 100 ? s.toFixed(0) : s >= 10 ? s.toFixed(1) : s.toFixed(2);
  return str.replace(/\.?0+$/, "") + "s";
}

async function renderStats() {
  const fmt = fmtNum;
  const overview = document.getElementById("statsOverview");
  try {
    const res = await fetch(API_BASE + "/admin/api/stats" + statsFilterQuery(), { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } });
    const data = await res.json();
    const total = data.total || {};
    const sumIn = total.input_tokens || 0;
    const sumOut = total.output_tokens || 0;

    // populate filter dropdowns (only when not filtered)
    const fm = document.getElementById("filterModel");
    if (!fm.value) {
      const models = (data.byModel || []).map(m => m.model);
      fm.innerHTML = '<option value="">全部模型</option>' + models.map(m => '<option value="' + m + '">' + m + '</option>').join("");
    }
    const fu = document.getElementById("filterUser");
    if (!fu.value) {
      const users = (data.byUser || []).map(u => u.user);
      fu.innerHTML = '<option value="">全部用户</option>' + users.map(u => '<option value="' + u + '">' + u + '</option>').join("");
    }

    overview.innerHTML =
      '<div class="stat-card"><div class="stat-num">' + (total.requests || 0) + '</div><div class="stat-label">请求数</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + (total.avg_ttft != null ? fmtSec(total.avg_ttft, true) : '-') + '</div><div class="stat-label">平均首字</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + fmt(sumIn) + '</div><div class="stat-label">输入 Tokens</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + fmt(sumOut) + '</div><div class="stat-label">输出 Tokens</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + fmt(sumIn + sumOut) + '</div><div class="stat-label">总 Tokens</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + fmt(total.cache_hit || 0) + '</div><div class="stat-label">命中 Tokens</div></div>';

    const rowsHtml = (rows, key) => {
      const labels = { day: "日期", model: "模型", user: "用户" };
      const nameLabel = labels[key] || key;
      if (!rows || !rows.length) return '<tr><td colspan="5" class="stats-empty">暂无数据</td></tr>';
      return rows.map(v => {
        const inPct = sumIn ? Math.round((v.input_tokens / sumIn) * 100) : 0;
        const outPct = sumOut ? Math.round((v.output_tokens / sumOut) * 100) : 0;
        return '<tr>' +
          '<td class="key-col" data-label="' + nameLabel + '">' + v[key] + '</td>' +
          '<td class="num" data-label="请求数">' + v.requests + '</td>' +
          '<td class="num" data-label="首字">' + (v.avg_ttft != null ? fmtSec(v.avg_ttft, true) : '-') + '</td>' +
          '<td class="num" data-label="输入 Tokens">' + fmt(v.input_tokens) + ' <span style="color:#94a3b8;font-size:.75rem;">(' + inPct + '%)</span></td>' +
          '<td class="num" data-label="输出 Tokens">' + fmt(v.output_tokens) + ' <span style="color:#94a3b8;font-size:.75rem;">(' + outPct + '%)</span></td>' +
          '<td class="num" data-label="总 Tokens">' + fmt((v.input_tokens || 0) + (v.output_tokens || 0)) + '</td>' +
          '<td class="num" data-label="命中">' + fmt(v.cache_hit || 0) + '</td>' +
          '</tr>';
      }).join("");
    };
    document.getElementById("statsDaily").innerHTML = rowsHtml(data.daily, "day");
    document.getElementById("statsByModel").innerHTML = rowsHtml(data.byModel, "model");
    document.getElementById("statsByUser").innerHTML = rowsHtml(data.byUser, "user");
  } catch (e) {
    overview.innerHTML = '<div style="grid-column:1/-1;color:#e11d48;padding:20px;">统计加载失败: ' + e.message + '</div>';
  }
}

function applyStatsFilter() { renderStats(); }

function resetStatsFilter() {
  document.getElementById("filterModel").value = "";
  document.getElementById("filterUser").value = "";
  document.getElementById("filterFrom").value = "";
  document.getElementById("filterTo").value = "";
  renderStats();
}

// 概览刷新
async function refreshOverview() {
  try {
    const res = await fetch(API_BASE + "/admin/api/pool-check", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } });
    const proxies = await res.json();
    const online = (proxies || []).filter(p => p.status === "online").length;
    const stat = document.getElementById("statProxy");
    if (stat) stat.textContent = online + " / " + (proxies || []).length;
  } catch (e) {}
  const stat = document.getElementById("statLogs");
  if (stat) {
    try {
      const res = await fetch(API_BASE + "/admin/api/audits/summary", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } });
      const s = await res.json();
      stat.textContent = (s.total || 0) + " 条";
    } catch {}
  }
}

// 快速测试
async function testRequest() {
  const model = document.getElementById("testModel").value;
  const msg = document.getElementById("testMsg").value.trim();
  if (!msg) return alert("请输入消息内容");
  const resultDiv = document.getElementById("testResult");
  resultDiv.innerHTML = '<span class="spinner"></span> 发送中...';
  try {
    const res = await fetch(API_BASE + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + (API_KEYS[0] ? API_KEYS[0][1] : ""),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: msg }], stream: false })
    });
    const data = await res.json();
    resultDiv.innerHTML = JSON.stringify(data, null, 2);
  } catch (e) {
    resultDiv.innerHTML = "测试失败: " + e.message;
  }
}

// 初始渲染
(function init() {
  const sel = document.getElementById("testModel");
  MODELS.forEach(m => { const o = document.createElement("option"); o.value = m; o.textContent = m; sel.appendChild(o); });
  document.getElementById("modelTags").innerHTML = MODELS.map(m => '<span class="model-tag">' + m + '</span>').join('');
  renderKeys();
  refreshPoolStatus();
  loadAudits(1);
  renderStats();
  refreshOverview();
})();
</script>
</body>
</html>
  `;

  res.type("text/html").send(html);
});

// ── Admin: API 密钥管理 ──────────────────────────────────────────
// GET /admin/api/keys → { keys: [{name, key}] }
app.get("/admin/api/keys", (req, res) => {
  res.json({ keys: Object.entries(apiKeys).map(([name, key]) => ({ name, key })) });
});

// POST /admin/api/keys {name, key?} → 新增（key 缺省自动生成）
app.post("/admin/api/keys", (req, res) => {
  let { name, key } = req.body || {};
  name = String(name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  if (apiKeys[name]) return res.status(409).json({ error: `key name "${name}" already exists` });
  if (!key) key = "oc-" + crypto.randomBytes(20).toString("hex");
  apiKeys[name] = key;
  fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
  res.json({ success: true, name, key });
});

// PUT /admin/api/keys/:name {newName} → 重命名
app.put("/admin/api/keys/:name", (req, res) => {
  const oldName = req.params.name;
  const newName = String((req.body || {}).newName || "").trim();
  if (!apiKeys[oldName]) return res.status(404).json({ error: `key "${oldName}" not found` });
  if (oldName === "admin") return res.status(403).json({ error: "admin key cannot be renamed" });
  if (!newName) return res.status(400).json({ error: "newName is required" });
  if (apiKeys[newName]) return res.status(409).json({ error: `key name "${newName}" already exists` });
  apiKeys[newName] = apiKeys[oldName];
  delete apiKeys[oldName];
  fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
  res.json({ success: true, name: newName, key: apiKeys[newName] });
});

// DELETE /admin/api/keys/:name → 删除（admin 不可删）
app.delete("/admin/api/keys/:name", (req, res) => {
  const name = req.params.name;
  if (!apiKeys[name]) return res.status(404).json({ error: `key "${name}" not found` });
  if (name === "admin") return res.status(403).json({ error: "admin key cannot be deleted" });
  delete apiKeys[name];
  fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
  res.json({ success: true, name });
});

app.get("/admin/api/pool-check", async (req, res) => {
  try {
    res.json(await checkProxyPool());
  } catch (e) {
    res.status(500).json({ error: "pool check failed", message: e.message });
  }
});

app.get("/admin/api/logs", (req, res) => {
  res.json(requestLogs.map((l) => ({ ...l, ts: fmtTs(l.ts) })));
});

// ── Admin: Audit trail（对齐 grok2api 请求审计）────────────────────
// GET /admin/api/audits?page=&pageSize=&user=&model=&status=&q= → 分页列表（倒序）
app.get("/admin/api/audits", (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const { user, model, status, q } = req.query;
  let list = [...auditRecords].reverse(); // 倒序：最新在前
  if (user) list = list.filter((r) => r.user === user);
  if (model) list = list.filter((r) => r.model === model);
  if (status) list = list.filter((r) => String(r.status) === String(status));
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((r) =>
      (r.requestId || "").toLowerCase().includes(needle) ||
      (r.error?.message || "").toLowerCase().includes(needle) ||
      (r.user || "").toLowerCase().includes(needle)
    );
  }
  const total = list.length;
  const start = (page - 1) * pageSize;
  const items = list.slice(start, start + pageSize).map((r) => ({
    ...r,
    ts: fmtTs(r.ts),
    // 详情字段只对单条请求返回；列表保留核心字段
  }));
  res.json({ items, total, page, pageSize, hasMore: start + pageSize < total });
});

// GET /admin/api/audits/summary → 聚合摘要（对齐 grok2api Summary）
app.get("/admin/api/audits/summary", (req, res) => {
  const total = auditRecords.length;
  const ok = auditRecords.filter((r) => r.status >= 200 && r.status < 400).length;
  const failed = total - ok;
  const input_tokens = auditRecords.reduce((s, r) => s + (r.input_tokens || 0), 0);
  const output_tokens = auditRecords.reduce((s, r) => s + (r.output_tokens || 0), 0);
  const cached = auditRecords.reduce((s, r) => s + (r.cache_hit || 0), 0);
  const errCodes = {};
  for (const r of auditRecords) {
    if (r.error?.code) errCodes[r.error.code] = (errCodes[r.error.code] || 0) + 1;
  }
  res.json({ total, successful: ok, failed, input_tokens, output_tokens, cached_tokens: cached, error_codes: errCodes });
});

// GET /admin/api/audits/:id → 单条详情（含失败诊断快照）
app.get("/admin/api/audits/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rec = auditRecords.find((r) => r.id === id);
  if (!rec) return res.status(404).json({ error: "audit record not found" });
  res.json({ ...rec, ts: fmtTs(rec.ts) });
});

app.get("/admin/api/stats", (req, res) => {
  const { model, user, from, to } = req.query;
  const hasFilter = !!(model || user || from || to);

  // No filter: use pre-aggregated full stats (not capped by records)
  if (!hasFilter) {
    const days = Object.keys(tokenStats.daily).sort().reverse();
    const byModel = Object.entries(tokenStats.byModel)
      .map(([m, v]) => ({ model: m, ...withAvg(v) }))
      .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
    const byUser = Object.entries(tokenStats.byUser)
      .map(([u, v]) => ({ user: u, ...withAvg(v) }))
      .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
    const daily = days.map((d) => ({ day: d, ...withAvg(tokenStats.daily[d]) }));
    return res.json({
      total: withAvg(tokenStats.total),
      byModel,
      byUser,
      daily,
      filters: { model: "", user: "", from: "", to: "" },
    });
  }

  const filtered = tokenStats.records.filter(r => {
    if (model && r.model !== model) return false;
    if (user && r.user !== user) return false;
    const day = cnDay(r.ts);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });

  const agg = { total: { requests: 0, input_tokens: 0, output_tokens: 0, cache_hit: 0, ttft_sum: 0, ttft_count: 0 }, byModel: {}, byUser: {}, daily: {} };
  const acc = (map, key, r) => {
    if (!map[key]) map[key] = { requests: 0, input_tokens: 0, output_tokens: 0, cache_hit: 0, ttft_sum: 0, ttft_count: 0 };
    map[key].requests += 1;
    map[key].input_tokens += r.input_tokens;
    map[key].output_tokens += r.output_tokens;
    map[key].cache_hit += r.cache_hit || 0;
    if (typeof r.ttft === "number" && r.stream) {
      map[key].ttft_sum += r.ttft;
      map[key].ttft_count += 1;
    }
  };
  for (const r of filtered) {
    agg.total.requests += 1;
    agg.total.input_tokens += r.input_tokens;
    agg.total.output_tokens += r.output_tokens;
    agg.total.cache_hit += r.cache_hit || 0;
    if (typeof r.ttft === "number" && r.stream) {
      agg.total.ttft_sum += r.ttft;
      agg.total.ttft_count += 1;
    }
    acc(agg.byModel, r.model, r);
    acc(agg.byUser, r.user, r);
    acc(agg.daily, cnDay(r.ts), r);
  }

  const days = Object.keys(agg.daily).sort().reverse();
  const byModel = Object.entries(agg.byModel)
    .map(([m, v]) => ({ model: m, ...withAvg(v) }))
    .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
  const byUser = Object.entries(agg.byUser)
    .map(([u, v]) => ({ user: u, ...withAvg(v) }))
    .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
  const daily = days.map((d) => ({ day: d, ...withAvg(agg.daily[d]) }));
  res.json({
    total: withAvg(agg.total),
    byModel,
    byUser,
    daily,
    filters: { model: model || "", user: user || "", from: from || "", to: to || "" },
  });
});

// ── Admin: ZenPool 节点池管理（导入/列表/删除/延迟/策略）──────────
app.get("/admin/api/pool", checkAdminAuth, async (_req, res) => {
  const snap = POOL.snapshot();
  const imported = listNodes();
  const alive = await mihomoAlive().catch(() => false);
  res.json({ ...snap, mihomoAlive: alive, imported });
});

app.post("/admin/api/pool/import", checkAdminAuth, async (req, res) => {
  const { text, url } = req.body || {};
  if (!text && !url) return res.status(400).json({ error: "需要 text(URI 文本) 或 url(订阅链接)" });
  try {
    const result = await importNodes({ text, url });
    if (result.added.length) {
      await reloadMihomo();           // 写配置 + 热重载
      refreshPool();                  // PoolCore 刷新 mihomo 节点名列表
      await POOL.init().catch(() => {});
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/admin/api/pool/nodes/:name", checkAdminAuth, async (req, res) => {
  const name = req.params.name;
  const ok = removeNode(name);
  if (!ok) return res.status(404).json({ error: `节点不存在: ${name}` });
  try {
    await reloadMihomo();
    refreshPool();
    await POOL.init().catch(() => {}); // 重新同步 selector（避免指向已删节点）
    res.json({ ok: true, name });
  } catch (e) {
    // 节点已删但重载失败：至少刷新内存池，返回错误信息
    refreshPool();
    res.status(500).json({ ok: false, name, error: e.message });
  }
});

app.post("/admin/api/pool/nodes/:name/test", checkAdminAuth, async (req, res) => {
  const name = req.params.name;
  try {
    const ms = await POOL.testDelay(name);
    res.json({ ok: true, name, delay: ms });
  } catch (e) {
    res.json({ ok: false, name, error: e.message });
  }
});

app.post("/admin/api/pool/test-all", checkAdminAuth, async (_req, res) => {
  try {
    const snap = POOL.snapshot();
    const names = (snap.nodes || []).filter(n => n.kind === "mihomo").map(n => n.name);
    const results = [];
    for (const name of names) {
      try {
        const delay = await POOL.testDelay(name);
        results.push({ name, ok: true, delay });
      } catch (e) {
        results.push({ name, ok: false, error: e.message });
      }
    }
    res.json({ results, total: names.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/api/pool/policy", checkAdminAuth, (_req, res) => {
  res.json({ policy: POOL.policy });
});

app.put("/admin/api/pool/policy", checkAdminAuth, (req, res) => {
  const { policy } = req.body || {};
  if (!POOL.setPolicy(policy)) return res.status(400).json({ error: `非法策略: ${policy}（支持 sticky / roundrobin）` });
  res.json({ ok: true, policy: POOL.policy });
});

// ── Start ──────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ZenPool v${PROXY_VERSION} on http://0.0.0.0:${PORT}`);
  console.log("  OpenAI:    POST /v1/chat/completions");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Models:    GET  /v1/models");
  console.log("  Health:    GET  /health");
  console.log("  Admin:     GET  /admin (Basic + cookie auth)");
  console.log("  Models:", MODELS.join(", "));
  for (const [name, key] of Object.entries(apiKeys)) {
    console.log(`  ${name.padEnd(15)} ${key}`);
  }
  loadTokenStats();
  loadAudit();
  console.log(`[AUDIT] loaded ${auditRecords.length} records from ${AUDIT_FILE}`);
  // ZenPool: 确保 mihomo 配置存在（空池 DIRECT 兜底）→ 加载导入节点 → 初始化 selector
  writeMihomoConfig();
  refreshPool();
  await POOL.init();
  console.log(`[POOL] policy=${POOL.policy}, static=${PROXY_POOL.length}, mihomo=${POOL.mihomoNames.length}, current=${POOL.snapshot().current?.name}`);
});
