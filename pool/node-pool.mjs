// zenpool - 节点池管理器
// 职责:
//  1. 导入节点持久化 (data/pool-nodes.json: {uri, node, source, addedAt})
//  2. 生成 mihomo 配置 (pool/mihomo.yaml) 并热重载 (PUT /configs)
//  3. mihomo external-controller 交互: 当前节点 / 切换 / 延迟测试
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateConfig, GROUP_NAME } from "./mihomo-config.mjs";
import { parseUri, parseUris, parseSubscription, fetchSubscription } from "./uris.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ZENPOOL_DATA_DIR || join(__dirname, "..", "data");
const POOL_DIR = process.env.ZENPOOL_POOL_DIR || join(__dirname);
const NODES_FILE = join(DATA_DIR, "pool-nodes.json");
const CONFIG_FILE = join(POOL_DIR, "config.yaml");
const CONFIG_BAK = join(POOL_DIR, "config.yaml.bak");
const CONTROLLER = process.env.MIHOMO_CONTROLLER || "127.0.0.1:19090";

mkdirSync(DATA_DIR, { recursive: true });

let nodes = [];
try {
  nodes = existsSync(NODES_FILE) ? JSON.parse(readFileSync(NODES_FILE, "utf8")) : [];
} catch {
  nodes = [];
}

function saveNodes() {
  writeFileSync(NODES_FILE, JSON.stringify(nodes, null, 2));
}

// mihomo external-controller 请求
async function mihomoApi(method, path, body) {
  const res = await fetch(`http://${CONTROLLER}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// 从 nodes[] 提取 mihomo proxy 对象（跳过 name 冲突的）
function allProxies() {
  const seen = new Set();
  const out = [];
  for (const entry of nodes) {
    const n = entry.node;
    if (!n || !n.name || !n.type || !n.server) continue;
    const name = n.name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(n);
  }
  return out;
}

// 生成并写入 mihomo.yaml（写前备份旧配置到 .bak，供 reload 失败回滚）
export function writeMihomoConfig() {
  const config = generateConfig(allProxies());
  try {
    if (existsSync(CONFIG_FILE)) {
      const old = readFileSync(CONFIG_FILE, "utf8");
      if (old !== config) writeFileSync(CONFIG_BAK, old);
    }
  } catch {}
  writeFileSync(CONFIG_FILE, config);
  return config;
}

// 热重载 mihomo（配置挂载在容器内 /root/.config/mihomo/config.yaml）
// 失败时回滚 config.yaml 到上一个好版本（防止坏配置在下次 mihomo 重启时生效）
export async function reloadMihomo() {
  const config = writeMihomoConfig();
  const res = await mihomoApi("PUT", "/configs", { path: "/root/.config/mihomo/config.yaml" });
  if (!res.ok) {
    // 回滚：恢复上一个成功配置
    try {
      if (existsSync(CONFIG_BAK)) {
        writeFileSync(CONFIG_FILE, readFileSync(CONFIG_BAK, "utf8"));
        console.log(`[POOL] config reload failed (HTTP ${res.status}) → rolled back to .bak`);
      }
    } catch {}
    const detail = res.data && res.data.message ? `: ${res.data.message}` : "";
    throw new Error(`mihomo reload failed: HTTP ${res.status}${detail}`);
  }
  return config;
}

// 导入: 支持单条/多行 URI、订阅 URL、订阅文本
export async function importNodes(input) {
  const { text, url } = input || {};
  const added = [];
  const failed = [];

  let batch = [];
  if (url) {
    try {
      const body = await fetchSubscription(url);
      const parsed = parseSubscription(body, url);
      batch = parsed.nodes;
      if (!batch.length) failed.push({ source: url, error: "订阅解析为空或格式不支持" });
    } catch (e) {
      failed.push({ source: url, error: `拉取失败: ${e.message}` });
    }
  }
  if (text) {
    batch = batch.concat(parseUris(text));
  }

  const seenNames = new Set(nodes.map((e) => e.node.name));
  for (const item of batch) {
    const n = item.node;
    if (!n) { failed.push({ source: item.uri || "?", error: "解析失败" }); continue; }
    if (seenNames.has(n.name)) { failed.push({ source: item.uri || n.name, error: `名称冲突: ${n.name}` }); continue; }
    seenNames.add(n.name);
    nodes.push({ uri: item.uri || "", node: n, source: url ? "subscription" : "manual", addedAt: new Date().toISOString() });
    added.push(n.name);
  }
  saveNodes();
  return { added, failed, total: nodes.length };
}

// 删除节点
export function removeNode(name) {
  const before = nodes.length;
  nodes = nodes.filter((e) => e.node.name !== name);
  saveNodes();
  return nodes.length !== before;
}

export function listNodes() {
  return nodes.map((e) => ({
    name: e.node.name,
    type: e.node.type,
    server: e.node.server,
    port: e.node.port,
    source: e.source,
    addedAt: e.addedAt,
    uri: e.uri,
  }));
}

// mihomo 当前 POOL 选中节点
export async function getCurrentNode() {
  const res = await mihomoApi("GET", `/proxies/${GROUP_NAME}`);
  if (!res.ok || !res.data?.now) return null;
  return res.data.now;
}

// 切换 POOL 选中节点
export async function selectNode(name) {
  const res = await mihomoApi("PUT", `/proxies/${GROUP_NAME}`, { name });
  return res.ok;
}

// 延迟测试（mihomo 内建 url-test 探测，返回 ms）
export async function testNode(name) {
  const res = await mihomoApi("GET", `/proxies/${encodeURIComponent(name)}/delay?timeout=5000&url=http://www.gstatic.com/generate_204`);
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return { ok: true, delay: res.data.delay };
}

// mihomo 是否在线
export async function mihomoAlive() {
  try {
    const res = await mihomoApi("GET", "/version");
    return res.ok;
  } catch {
    return false;
  }
}
