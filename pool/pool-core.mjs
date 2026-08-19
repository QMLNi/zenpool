// zenpool - 统一节点池核心（静态 SSH 端口 + mihomo 动态导入节点）
// 请求路径全同步：pick() 不发起网络；mihomo selector 切换只在 429 后异步预热
// 策略: sticky（顺位，一直用当前节点，429 才切） / roundrobin（轮询）
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class PoolCore {
  constructor(opts = {}) {
    this.staticUrls = opts.staticUrls || [];
    this.cooldownMs = opts.cooldownMs || 5 * 60 * 1000;
    this.dataDir = opts.dataDir || join(__dirname, "..", "data");
    this.controller = opts.controller || "127.0.0.1:19090";
    this.groupName = opts.groupName || "POOL";
    this.mixedUrl = opts.mixedUrl || "http://127.0.0.1:16446";

    this.policyFile = join(this.dataDir, "pool-config.json");
    this.policy = "sticky"; // sticky | roundrobin
    this.loadPolicy();

    this.staticCooldown = this.staticUrls.map(() => 0);
    this.currentPos = 0;

    this.mihomoNames = [];         // 导入节点名（顺序 = mihomo proxies 顺序）
    this.mihomoCooldown = new Map(); // name -> 冷却到期时间戳
    this.mihomoOk = false;         // mihomo 当前认为可用
    this.mihomoActual = null;      // mihomo selector 实际选中节点
    this.latencies = new Map();    // name -> {delay, at} 最近一次测速结果（持久化）
    this.loadLatency();
    this._initPromise = null;
  }

  // ── 策略 ──────────────────────────────────────────────
  loadPolicy() {
    try {
      const j = JSON.parse(readFileSync(this.policyFile, "utf8"));
      if (j.policy === "sticky" || j.policy === "roundrobin") this.policy = j.policy;
    } catch {}
  }
  savePolicy() {
    try { writeFileSync(this.policyFile, JSON.stringify({ policy: this.policy }, null, 2)); } catch {}
  }
  loadLatency() {
    try {
      const j = JSON.parse(readFileSync(join(this.dataDir, "pool-latency.json"), "utf8"));
      if (j && typeof j === "object") {
        for (const [k, v] of Object.entries(j)) {
          if (v && typeof v.delay === "number") this.latencies.set(k, v);
        }
      }
    } catch {}
  }
  saveLatency() {
    try {
      const obj = {};
      for (const [k, v] of this.latencies) obj[k] = v;
      writeFileSync(join(this.dataDir, "pool-latency.json"), JSON.stringify(obj, null, 2));
    } catch {}
  }
  setPolicy(p) {
    if (!["sticky", "roundrobin"].includes(p)) return false;
    this.policy = p;
    this.savePolicy();
    return true;
  }

  // ── 节点视图 ──────────────────────────────────────────
  setMihomoNames(names) {
    this.mihomoNames = names;
    this._initPromise = null; // 节点列表变化后需重新初始化 selector
    const total = this.totalNodes();
    if (total && this.currentPos >= total) this.currentPos = 0;
  }

  totalNodes() { return this.staticUrls.length + this.mihomoNames.length; }

  nodeAt(i) {
    if (i < this.staticUrls.length) {
      return { kind: "static", idx: i, pos: i, name: `static-${i + 1}`, url: this.staticUrls[i] };
    }
    const mi = i - this.staticUrls.length;
    const name = this.mihomoNames[mi] || `mihomo-${mi + 1}`;
    return { kind: "mihomo", idx: mi, pos: i, name, url: this.mixedUrl };
  }

  cooldownUntil(n) {
    if (n.kind === "static") return this.staticCooldown[n.idx] || 0;
    return this.mihomoCooldown.get(n.name) || 0;
  }

  // 同步选中节点（不发起网络）
  pick() {
    const total = this.totalNodes();
    if (!total) return null;
    if (this.currentPos >= total) this.currentPos = 0;
    const now = Date.now();
    // sticky: 优先当前节点（缓存命中）；roundrobin: 从下一个开始轮询
    const start = this.policy === "sticky" ? this.currentPos : (this.currentPos + 1) % total;
    for (let i = 0; i < total; i++) {
      const idx = (start + i) % total;
      if (this.cooldownUntil(this.nodeAt(idx)) > now) continue;
      this.currentPos = idx;
      return this.nodeAt(idx);
    }
    return this.nodeAt(this.currentPos % total); // 全冷却兜底
  }

  // 标记节点耗尽（429）：冷却 + 前移游标 + 尽力异步同步 mihomo selector
  markExhausted(sel) {
    const now = Date.now();
    if (sel.kind === "static") {
      this.staticCooldown[sel.idx] = now + this.cooldownMs;
    } else {
      this.mihomoCooldown.set(sel.name, now + this.cooldownMs);
    }
    const total = this.totalNodes();
    this.currentPos = total ? (this.currentPos + 1) % total : 0;
    // 若游标现在指向 mihomo 节点，异步把 selector 切过去（尽力而为，不阻塞）
    this._switchMihomoAsync().catch(() => {});
    console.log(`[POOL] ${sel.kind}:${sel.name} exhausted → cooldown ${this.cooldownMs / 1000}s, pos → ${this.currentPos}`);
  }

  // ── mihomo external-controller ────────────────────────
  async _api(method, path, body) {
    const res = await fetch(`http://${this.controller}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(6000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  }

  async getSelectorNow() {
    const r = await this._api("GET", `/proxies/${this.groupName}`);
    if (r.ok && r.data?.now) return r.data.now;
    throw new Error(`mihomo get selector failed: HTTP ${r.status}`);
  }

  async setSelector(name) {
    const r = await this._api("PUT", `/proxies/${this.groupName}`, { name });
    if (!r.ok) throw new Error(`mihomo set selector failed: HTTP ${r.status}`);
    return true;
  }

  async testDelay(name) {
    const r = await this._api("GET", `/proxies/${encodeURIComponent(name)}/delay?timeout=5000&url=http://www.gstatic.com/generate_204`);
    if (!r.ok) {
      this.latencies.delete(name);
      this.saveLatency();
      throw new Error(`delay test failed: HTTP ${r.status}`);
    }
    this.latencies.set(name, { delay: r.data.delay, at: Date.now() });
    this.saveLatency();
    return r.data.delay;
  }

  // 初始化（启动调一次）：确保 selector 指向有效 mihomo 节点（修正悬空/已删节点）
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      if (!this.mihomoNames.length) { this.mihomoOk = false; return; }
      try {
        const cur = await this.getSelectorNow();
        this.mihomoActual = cur;
        if (!this.mihomoNames.includes(cur)) {
          // selector 悬空（指向已删/测试残留节点）→ 切到第一个未冷却 mihomo 节点
          const now = Date.now();
          let target = null;
          for (let i = 0; i < this.totalNodes(); i++) {
            const n = this.nodeAt(i);
            if (n.kind === "mihomo" && this.cooldownUntil(n) <= now) { target = n; break; }
          }
          if (target) {
            await this.setSelector(target.name);
            this.mihomoActual = target.name;
            this.currentPos = target.pos;
          }
        }
        this.mihomoOk = true;
        console.log(`[POOL] mihomo init OK, selector=${this.mihomoActual}`);
      } catch (e) {
        this.mihomoOk = false;
        console.log(`[POOL] mihomo init FAIL: ${e.message}`);
      }
    })();
    return this._initPromise;
  }

  // 异步把 selector 切到「游标指向的下一个可用 mihomo 节点」；无需求时不动
  async _switchMihomoAsync() {
    if (!this.mihomoNames.length) return;
    const total = this.totalNodes();
    const now = Date.now();
    // 从当前游标开始找 mihomo 节点（跳过冷却）
    let target = null;
    for (let i = 0; i < total; i++) {
      const idx = (this.currentPos + i) % total;
      const n = this.nodeAt(idx);
      if (n.kind !== "mihomo") continue;
      if (this.cooldownUntil(n) > now) continue;
      target = n;
      this.currentPos = idx;
      break;
    }
    if (!target || target.name === this.mihomoActual) return;
    try {
      await this.setSelector(target.name);
      this.mihomoActual = target.name;
      this.mihomoOk = true;
      console.log(`[POOL] mihomo switch → ${target.name}`);
    } catch (e) {
      this.mihomoOk = false;
      console.log(`[POOL] mihomo switch FAIL: ${e.message}`);
    }
  }

  mihomoReady() { return this.mihomoOk; }

  // 状态快照（面板/API 用）
  snapshot() {
    const now = Date.now();
    const total = this.totalNodes();
    const nodes = [];
    for (let i = 0; i < total; i++) {
      const n = this.nodeAt(i);
      const until = this.cooldownUntil(n);
      nodes.push({
        pos: i,
        kind: n.kind,
        name: n.name,
        url: n.url,
        latency: this.latencies.get(n.name)?.delay ?? null,
        cooling: until > now,
        cooldownLeftMs: until > now ? until - now : 0,
        current: i === this.currentPos,
      });
    }
    return {
      policy: this.policy,
      total,
      currentPos: total ? this.currentPos : 0,
      current: total ? this.nodeAt(Math.min(this.currentPos, total - 1)) : null,
      mihomoOk: this.mihomoOk,
      mihomoActual: this.mihomoActual,
      nodes,
    };
  }
}