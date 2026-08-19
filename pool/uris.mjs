// zenpool - 多协议代理 URI 解析器
// 支持: ss:// ssr:// vmess:// vless:// trojan:// hysteria2:// hy2:// tuic://
// 订阅: HTTP(S) 链接 → base64 列表 / 纯文本列表 / clash yaml proxies 段
import { URL } from "node:url";

const b64decode = (s) => {
  try {
    const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(t, "base64").toString("utf8");
  } catch {
    return "";
  }
};

const b64encode = (s) => Buffer.from(s, "utf8").toString("base64").replace(/=+$/, "");

function parseSs(uri) {
  // ss://base64(method:password@host:port)#name
  // ss://method:password@host:port#name
  const u = new URL(uri);
  let raw = "";
  // 尝试1: 明文形式 method:password@host:port（username+password 都有值）
  if (u.username && u.password) {
    raw = `${u.username}:${u.password}`;
    if (!raw.includes("@")) raw = `${raw}@${u.hostname}:${u.port || 8388}`;
  }
  // 尝试2: base64 被 URL 解析成 username
  //  - 完整: ss://b64(method:pass@host:port)#name
  //  - 变体: ss://b64(method:pass)@host:port#name（主机在 base64 外）
  if (!raw.includes("@") && u.username) {
    const dec = b64decode(u.username);
    if (dec.includes("@")) {
      raw = dec;
    } else if (dec.includes(":")) {
      raw = `${dec}@${u.hostname}:${u.port || 8388}`;
    }
  }
  // 尝试3: host 部分是 base64
  if (!raw.includes("@")) {
    raw = b64decode((u.host || "").split("#")[0]);
  }
  if (!raw.includes("@")) return null;
  const at = raw.lastIndexOf("@");
  const cred = raw.slice(0, at);
  const hostport = raw.slice(at + 1);
  const ci = cred.lastIndexOf(":");
  const method = cred.slice(0, ci);
  const password = cred.slice(ci + 1);
  const hp = hostport.lastIndexOf(":");
  const host = hostport.slice(0, hp);
  const port = parseInt(hostport.slice(hp + 1), 10);
  if (!method || !host || !port) return null;
  const name = decodeURIComponent(u.hash?.slice(1) || "") || `ss-${host}:${port}`;
  const node = {
    name,
    type: "ss",
    server: host,
    port,
    cipher: method,
    password,
    udp: true,
  };
  // plugin 参数（obfs 等）
  const plugin = u.searchParams.get("plugin");
  if (plugin) node.plugin = plugin;
  return node;
}

function parseSsr(uri) {
  // ssr://base64(host:port:protocol:method:obfs:password_base64/?params#name)
  const u = new URL(uri);
  const raw = b64decode(u.hostname || u.host || "");
  if (!raw) return null;
  const hash = decodeURIComponent(u.hash?.slice(1) || "");
  const body = raw.includes("/?") ? raw : `${raw}/?`;
  const [head, qs] = body.split("/?");
  const parts = head.split(":");
  if (parts.length < 6) return null;
  const [host, port, protocol, method, obfs, passB64] = parts;
  const params = new URLSearchParams(qs || "");
  const password = b64decode(passB64);
  const name = hash || params.get("group") || `ssr-${host}:${port}`;
  return {
    name,
    type: "ssr",
    server: host,
    port: parseInt(port, 10),
    cipher: method,
    password,
    protocol,
    "protocol-param": params.get("protoparam") || "",
    obfs,
    "obfs-param": params.get("obfsparam") || "",
    udp: true,
  };
}

function parseVmess(uri) {
  // vmess://base64(JSON)
  const u = new URL(uri);
  const raw = b64decode(u.hostname || u.host || "");
  if (!raw) return null;
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const node = {
    name: j.ps || `vmess-${j.add}:${j.port}`,
    type: "vmess",
    server: j.add,
    port: parseInt(j.port, 10),
    uuid: j.id,
    alterId: parseInt(j.aid || "0", 10),
    cipher: "auto",
    udp: true,
  };
  const net = j.net || "tcp";
  node.network = net;
  if (net === "ws") {
    node["ws-opts"] = {
      path: j.path || "/",
      headers: j.host ? { Host: j.host } : {},
    };
  } else if (net === "grpc") {
    node["grpc-opts"] = { "grpc-service-name": j.path || "" };
  }
  if (j.tls === "tls" || j.scy === "tls") {
    node.tls = true;
    node.servername = j.sni || j.host || "";
  } else if (j.scy === "reality") {
    node.tls = true;
    node["reality-opts"] = {
      "public-key": j.pbk || "",
      "short-id": j.sid || "",
    };
    node.servername = j.sni || "";
    node["client-fingerprint"] = "chrome";
  }
  return node;
}

function parseVless(uri) {
  const u = new URL(uri);
  const name = decodeURIComponent(u.hash?.slice(1) || "") || `vless-${u.hostname}:${u.port}`;
  const node = {
    name,
    type: "vless",
    server: u.hostname,
    port: parseInt(u.port, 10) || 443,
    uuid: u.username || "",
    udp: true,
  };
  const type = u.searchParams.get("type") || "tcp";
  node.network = type;
  if (type === "ws") {
    node["ws-opts"] = {
      path: u.searchParams.get("path") || "/",
      headers: { Host: u.searchParams.get("host") || "" },
    };
  } else if (type === "grpc") {
    node["grpc-opts"] = { "grpc-service-name": u.searchParams.get("serviceName") || "" };
  } else if (type === "http" || type === "h2") {
    node["h2-opts"] = { path: u.searchParams.get("path") || "/", host: [u.searchParams.get("host") || ""] };
  } else if (type === "xhttp") {
    node["xhttp-opts"] = { path: u.searchParams.get("path") || "/", host: u.searchParams.get("host") || "" };
  }
  const security = u.searchParams.get("security") || "";
  if (security === "tls") {
    node.tls = true;
    node.servername = u.searchParams.get("sni") || u.searchParams.get("host") || "";
    if (u.searchParams.get("allowInsecure") === "1" || u.searchParams.get("insecure") === "1") {
      node["skip-cert-verify"] = true;
    }
  } else if (security === "reality") {
    // mihomo 的 REALITY public-key 约定为 URL-safe base64（A-Za-z0-9_-，43 字符无 padding）；
    // 标准 base64 的 +/ 会被判 invalid（实测），= 也拒绝。统一转 URL-safe 再校验解码 32 字节。
    const pbkRaw = (u.searchParams.get("pbk") || "").replace(/=+$/, "");
    const pbk = pbkRaw.replace(/\+/g, "-").replace(/\//g, "_");
    const sni = u.searchParams.get("sni") || "";
    let pbkOk = false;
    try {
      pbkOk = /^[A-Za-z0-9_-]{43}$/.test(pbk) && Buffer.from(pbk, "base64url").length === 32;
    } catch {}
    // REALITY 必须同时有合法公钥 + SNI（实测缺任一都会被 mihomo 判 invalid）
    if (!pbkOk || !sni) return null;
    node.tls = true;
    node.servername = sni;
    node["reality-opts"] = {
      "public-key": pbk,
      "short-id": u.searchParams.get("sid") || "",
      fingerprint: u.searchParams.get("fp") || "chrome",
    };
    node["client-fingerprint"] = u.searchParams.get("fp") || "chrome";
  }
  return node;
}

function parseTrojan(uri) {
  const u = new URL(uri);
  const name = decodeURIComponent(u.hash?.slice(1) || "") || `trojan-${u.hostname}:${u.port}`;
  const node = {
    name,
    type: "trojan",
    server: u.hostname,
    port: parseInt(u.port, 10) || 443,
    password: u.username || "",
    udp: true,
  };
  const sni = u.searchParams.get("sni") || u.searchParams.get("peer") || u.searchParams.get("host") || "";
  if (sni) {
    node.sni = sni;
    node.servername = sni;
  }
  if (u.searchParams.get("allowInsecure") === "1" || u.searchParams.get("insecure") === "1") {
    node["skip-cert-verify"] = true;
  }
  const type = u.searchParams.get("type") || "tcp";
  if (type === "ws") {
    node.network = "ws";
    node["ws-opts"] = {
      path: u.searchParams.get("path") || "/",
      headers: { Host: u.searchParams.get("host") || "" },
    };
  } else if (type === "grpc") {
    node.network = "grpc";
    node["grpc-opts"] = { "grpc-service-name": u.searchParams.get("serviceName") || "" };
  }
  return node;
}

function parseHysteria2(uri) {
  const u = new URL(uri);
  const name = decodeURIComponent(u.hash?.slice(1) || "") || `hy2-${u.hostname}:${u.port}`;
  const node = {
    name,
    type: "hysteria2",
    server: u.hostname,
    port: parseInt(u.port, 10) || 443,
    password: u.username || "",
    udp: true,
  };
  const sni = u.searchParams.get("sni") || u.searchParams.get("peer") || u.hostname;
  if (sni) node.sni = sni;
  if (u.searchParams.get("insecure") === "1" || u.searchParams.get("allowInsecure") === "1") {
    node["skip-cert-verify"] = true;
  }
  const up = u.searchParams.get("up");
  const down = u.searchParams.get("down");
  if (up) node.up = up;
  if (down) node.down = down;
  return node;
}

function parseTuic(uri) {
  const u = new URL(uri);
  const name = decodeURIComponent(u.hash?.slice(1) || "") || `tuic-${u.hostname}:${u.port}`;
  const node = {
    name,
    type: "tuic",
    server: u.hostname,
    port: parseInt(u.port, 10) || 443,
    uuid: u.username || "",
    password: u.searchParams.get("password") || "",
    udp: true,
  };
  const sni = u.searchParams.get("sni") || u.hostname;
  if (sni) node.sni = sni;
  if (u.searchParams.get("allowInsecure") === "1" || u.searchParams.get("insecure") === "1") {
    node["skip-cert-verify"] = true;
  }
  const cc = u.searchParams.get("congestion_control") || u.searchParams.get("congestion-control");
  if (cc) node["congestion-controller"] = cc;
  return node;
}

function parseHttpSocks(uri) {
  // http://user:pass@host:port#name / socks5://user:pass@host:port#name
  const u = new URL(uri);
  const type = u.protocol === "socks5:" || u.protocol === "socks:" ? "socks5" : "http";
  const name = decodeURIComponent(u.hash?.slice(1) || "") || `${type}-${u.hostname}:${u.port}`;
  const node = {
    name,
    type,
    server: u.hostname,
    port: parseInt(u.port, 10) || (type === "http" ? 80 : 1080),
    udp: type === "socks5",
  };
  if (u.username) node.username = decodeURIComponent(u.username);
  if (u.password) node.password = decodeURIComponent(u.password);
  return node;
}

// 解析单个 URI → mihomo proxy 对象（null = 不支持/解析失败）
export function parseUri(uri) {
  const s = String(uri).trim();
  if (!s) return null;
  const scheme = s.split("://")[0]?.toLowerCase();
  try {
    switch (scheme) {
      case "ss": return parseSs(s);
      case "ssr": return parseSsr(s);
      case "vmess": return parseVmess(s);
      case "vless": return parseVless(s);
      case "trojan": return parseTrojan(s);
      case "hysteria2":
      case "hy2": return parseHysteria2(s);
      case "tuic": return parseTuic(s);
      case "http":
      case "socks5":
      case "socks": return parseHttpSocks(s);
      default: return null;
    }
  } catch {
    return null;
  }
}

// 解析多行/批量文本（每行一个 URI，支持 # 注释）
export function parseUris(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const node = parseUri(t);
    if (node) out.push({ uri: t, node });
  }
  return out;
}

// 解析订阅内容（自动识别 base64 列表 / 纯文本 / clash yaml）
export function parseSubscription(text, sourceUrl = "") {
  const t = String(text);
  const trimmed = t.trim();
  // 1) clash yaml: 含 proxies: 段
  if (/^proxies:|(^|\n)\s*proxies:/m.test(trimmed) || trimmed.startsWith("mixed-port") || /^port:/m.test(trimmed)) {
    return { kind: "clash", nodes: parseClashYamlProxies(trimmed) };
  }
  // 2) 纯文本 URI 列表
  if (trimmed.includes("://")) {
    const nodes = parseUris(trimmed);
    if (nodes.length) return { kind: "text", nodes };
  }
  // 3) base64（v2ray 订阅最常见）
  const decoded = b64decode(trimmed);
  if (decoded.includes("://")) {
    const nodes = parseUris(decoded);
    if (nodes.length) return { kind: "base64", nodes };
  }
  return { kind: "unknown", nodes: [] };
}

// 极简 clash yaml proxies 段解析（不做完整 yaml，只认 proxies: 块里的条目）
function parseClashYamlProxies(yamlText) {
  const nodes = [];
  const lines = yamlText.split(/\r?\n/);
  let inProxies = false;
  let cur = null;
  const keyRe = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
  const itemRe = /^\s*-\s*(?:name\s*:\s*)?/;
  for (const line of lines) {
    if (!inProxies) {
      if (/^\s*proxies\s*:\s*$/.test(line)) { inProxies = true; continue; }
      continue;
    }
    if (/^\s*[A-Za-z0-9_-]+\s*:/.test(line) && !itemRe.test(line) && !keyRe.test(line)) {
      // 新顶层 key（proxies 结束）
      if (cur) { nodes.push(cur); cur = null; }
      inProxies = false;
      continue;
    }
    if (/^\s*-\s/.test(line)) {
      if (cur) nodes.push(cur);
      cur = {};
      continue;
    }
    const m = line.match(keyRe);
    if (!m || !cur) continue;
    let val = m[2].trim().replace(/^["']|["']$/g, "");
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (/^\d+$/.test(val)) val = parseInt(val, 10);
    cur[m[1]] = val;
  }
  if (cur) nodes.push(cur);
  // 清洗：只需要 mihomo 认的字段
  return nodes.filter((n) => n && n.name && n.type && n.server && n.port);
}

// 拉取订阅 URL（自动跟随重定向，超时 15s）
export async function fetchSubscription(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "zenpool/1.0" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text;
  } finally {
    clearTimeout(timer);
  }
}
