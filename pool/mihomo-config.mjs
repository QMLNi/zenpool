// zenpool - mihomo 配置生成器
// 节点对象数组 → mihomo YAML 配置字符串
// 每个节点 = mihomo proxies[] 条目；POOL selector group 用于 server 切换出口

export const MIXED_PORT = 16446;          // zenpool 专用 mixed 端口（不碰现有 mihomo）
export const CONTROLLER = "127.0.0.1:19090"; // external-controller
export const GROUP_NAME = "POOL";

function yamlStr(v) {
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v);
  if (/^[A-Za-z0-9_.\-\/]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function yamlObj(obj, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      lines.push(`${pad}${k}:`);
      for (const item of v) lines.push(`${pad}  - ${yamlStr(item)}`);
    } else if (typeof v === "object") {
      lines.push(`${pad}${k}:`);
      lines.push(...yamlObj(v, indent + 2));
    } else {
      lines.push(`${pad}${k}: ${yamlStr(v)}`);
    }
  }
  return lines;
}

function proxyToYaml(node, indent) {
  const pad = " ".repeat(indent);
  const lines = [`${pad}- name: ${yamlStr(node.name)}`];
  for (const [k, v] of Object.entries(node)) {
    if (k === "name") continue;
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      lines.push(`${pad}  ${k}:`);
      for (const item of v) lines.push(`${pad}    - ${yamlStr(item)}`);
    } else if (typeof v === "object") {
      lines.push(`${pad}  ${k}:`);
      lines.push(...yamlObj(v, indent + 4));
    } else {
      lines.push(`${pad}  ${k}: ${yamlStr(v)}`);
    }
  }
  return lines.join("\n");
}

// 生成完整 mihomo 配置
export function generateConfig(nodes, opts = {}) {
  const mixedPort = opts.mixedPort || MIXED_PORT;
  const controller = opts.controller || CONTROLLER;
  const groupName = opts.groupName || GROUP_NAME;
  const allNames = nodes.map((n) => n.name);
  const groupProxies = allNames.length ? allNames : ["DIRECT"]; // 空池兜底 DIRECT
  const lines = [
    `mixed-port: ${mixedPort}`,
    "allow-lan: false",
    "mode: rule",
    "log-level: warning",
    "ipv6: false",
    `external-controller: ${controller}`,
    ...(opts.secret ? [`secret: ${yamlStr(opts.secret)}`] : []),
    "",
    "proxies:",
  ];
  for (const n of nodes) {
    lines.push(proxyToYaml(n, 2));
  }
  lines.push(
    "",
    "proxy-groups:",
    `  - name: ${groupName}`,
    "    type: select",
    "    disable-udp: false",
    "    proxies:",
  );
  for (const name of groupProxies) {
    lines.push(`      - ${yamlStr(name)}`);
  }
  lines.push(
    "",
    "rules:",
    `  - MATCH,${groupName}`,
    "",
  );
  return lines.join("\n");
}
