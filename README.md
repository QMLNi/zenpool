# zenpool

> 把 OpenCode Zen 免费模型变成 OpenAI / Anthropic 兼容 API，并内置**多协议代理池**自动管理出口节点。

zenpool 是一个轻量代理服务：你的工具（Cursor / CLI / 任意 OpenAI SDK）只需把 base URL 指到 zenpool，就能用 OpenAI / Anthropic 协议调用 OpenCode Zen 免费档模型。内置的代理池支持 SS / VMess / VLESS / Trojan / Hysteria2 / TUIC / HTTP / SOCKS5 多协议节点，自动切换、冷却、测速，最大化缓存命中与可用性。

基于 [bigdata2211it-web/opencode-free-proxy](https://github.com/bigdata2211it-web/opencode-free-proxy) 深度改造：保留顺位节点缓存命中 + 429 冷却切换的架构，新增 mihomo 引擎的统一节点池与导入功能。

## 核心功能

### 🎯 智能出口策略
- **顺位（sticky）**：一直复用当前节点，429 限流才切下一个——**缓存命中率最高**，适合多数场景
- **轮询（roundrobin）**：请求轮流分配节点，分散配额压力
- 429 自动冷却：限流节点按指数冷却，避免连环限流

### 🌐 多协议代理池
- 一键导入：`ss://` `vmess://` `vless://` `trojan://` `hysteria2://` `tuic://` `http://` `socks5://`，支持**多行批量**与**订阅链接自动拉取**（base64 / 纯文本 / clash yaml）
- 由独立 **mihomo 实例**统一管理：热重载配置、延迟测试、selector 切换
- 配置热重载失败自动**回滚**到上一个好版本，坏节点不会污染运行时

### 🖥️ 管理面板（Basic Auth 保护）
- **🌐 代理池**：策略切换、导入节点、删除节点、一键测速/单节点测速（延迟常驻显示）、实时冷却状态
- **🔑 密钥管理**：多 API key 增删改、自动生成
- **🕵️ 请求审计**：分页检索、失败诊断快照、按用户/状态筛选
- **📊 Token 统计**：按日 / 按模型 / 按用户聚合
- **🚀 快速测试**：面板内直接发请求验证

### ⚡ 兼容层
- OpenAI 三端点：`/v1/chat/completions` `/v1/responses` `/v1/models`（原生透传）
- Anthropic：`/v1/messages`
- 工具调用清洗、流式事件补全、失败诊断快照、请求审计与 Token 统计

## 架构

```
你的工具 (Cursor / CLI / curl ...)
        │  OpenAI / Anthropic 协议
        ▼
zenpool (server.mjs, 默认 7446)
        ├── 静态节点池: PROXY_POOL 本地端口（SSH 隧道等）
        └── mihomo 引擎 (zenpool-mihomo, mixed 16446 / API 19090)
              └── 导入节点（多协议，selector 切换出口）
        ▼ HTTPS
opencode.ai/zen/v1 (免费档)
```

## 快速开始（Docker Compose）

```bash
# 1. 准备 .env（PROXY_POOL 静态节点，逗号分隔 http 代理 URL）
echo 'PROXY_POOL=http://user:pass@127.0.0.1:15446,...,http://user:pass@127.0.0.1:15451' > .env

# 2. 构建并启动
docker compose up -d --build
# 或手动：
docker run -d --name zenpool-mihomo --restart always --network host \
  -v $PWD/pool:/root/.config/mihomo -e TZ=Asia/Shanghai metacubex/mihomo:latest
docker run -d --name zenpool --restart always --network host \
  -v $PWD/data:/app/data -v $PWD/pool:/app/pool \
  -e PROXY_PORT=7446 -e PROXY_POOL="$PROXY_POOL" \
  -e ZENPOOL_DATA_DIR=/app/data -e MIHOMO_CONTROLLER=127.0.0.1:19090 \
  zenpool:local
```

启动后：`http://localhost:7446/health`、面板 `http://localhost:7446/admin`。

## Linux 裸机部署（无 Docker）

需要 Node.js >= 18。一条命令安装（自动下载 mihomo 二进制 + 初始化配置 + 装依赖）：

```bash
git clone https://github.com/QMLNi/zenpool.git
cd zenpool
./install.sh                # 安装
./bin/start.sh              # 前台启动（Ctrl+C 停止）
# 或安装为 systemd 服务：
./install.sh --with-systemd  # 需要 root/sudo，装完 systemctl start zenpool
```

- `install.sh --mihomo v1.19.30` 可指定 mihomo 版本（默认 latest）
- 支持 amd64 / arm64；`pool/config.yaml` 不存在时自动从 example 生成
- 启动脚本会自动拉起 mihomo（若 19090 未运行）再启动 zenpool

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（版本 / 模型数 / 端点） |
| GET | `/v1/models` | 模型列表（OpenAI 格式） |
| POST | `/v1/chat/completions` | Chat Completions（流式/同步） |
| POST | `/v1/responses` | Responses API（原生透传） |
| POST | `/v1/messages` | Anthropic Messages |
| GET | `/admin` | 管理面板 |
| POST | `/admin/api/pool/import` | 导入节点（`text` URI 文本 / `url` 订阅链接） |
| GET | `/admin/api/pool` | 节点池快照（含冷却/当前节点） |
| DELETE | `/admin/api/pool/nodes/:name` | 删除节点 |
| POST | `/admin/api/pool/nodes/:name/test` | 延迟测试 |
| PUT | `/admin/api/pool/policy` | 切换策略（`sticky` / `roundrobin`） |
| GET | `/admin/api/audits` `/admin/api/stats` | 审计 / 统计 |

## 节点导入 API（面板「🌐 节点池」Tab 同款）

```bash
# 单/多行 URI
curl -u admin:你的密码 http://localhost:7446/admin/api/pool/import \
  -H 'Content-Type: application/json' \
  -d '{"text": "ss://BASE64@host:port#节点1\nvless://uuid@host:443?security=reality#节点2"}'

# 订阅链接
curl -u admin:你的密码 http://localhost:7446/admin/api/pool/import \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/sub"}'

# 策略切换
curl -u admin:你的密码 -X PUT http://localhost:7446/admin/api/pool/policy \
  -H 'Content-Type: application/json' -d '{"policy": "roundrobin"}'
```

### vless reality 节点格式要求

- `pbk`（public-key）必须是 **URL-safe base64**（字符集 `A-Za-z0-9_-`，43 字符无 `=` padding）；标准 base64 的 `+` `/` 会被 mihomo 判 `invalid REALITY public key`
- 必须带 `sni`（REALITY 握手需要）；`sid`、`fp` 可选
- 示例：`vless://uuid@host:443?security=reality&pbk=<43字符URL-safe>&sni=example.com#my-reality`

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PROXY_PORT` | `7446` | 服务端口 |
| `PROXY_POOL` | 空 | 静态节点列表（http 代理 URL，逗号分隔） |
| `ZENPOOL_DATA_DIR` | `./data` | 数据目录（keys / 统计 / 审计 / 导入节点） |
| `MIHOMO_CONTROLLER` | `127.0.0.1:19090` | mihomo external-controller |
| `ADMIN_PASSWORD` | `ocpool-admin` | 面板/管理 API 密码（**部署后务必修改**） |
| `TZ` | `Asia/Shanghai` | 时区 |

## 使用场景

- **白嫖 OpenCode Zen 免费档**：一个服务同时喂给 Cursor / Claude Code / 自研工具，协议都兼容
- **多账号/多节点抗限流**：粘性策略保证缓存命中，429 自动切下一个节点
- **机场订阅整合**：粘贴订阅链接即得可用出口，无需手写配置

## 文件结构

```
zenpool/
├── server.mjs              # 主服务（Express）
├── install.sh              # Linux 裸机一键安装（下载 mihomo + 初始化 + 装依赖）
├── bin/                    # start.sh 启动脚本 / mihomo 二进制
├── pool/
│   ├── uris.mjs            # 多协议 URI / 订阅解析器
│   ├── mihomo-config.mjs   # mihomo YAML 配置生成
│   ├── node-pool.mjs       # 导入节点持久化 + 热重载
│   ├── pool-core.mjs       # 统一节点池核心（粘性/轮询/冷却）
│   └── config.yaml         # mihomo 运行时配置（自动生成）
└── data/                   # api-keys / 统计 / 审计 / 导入节点
```

## 部署参考

- 静态节点由 `ocpool-tunnels`（autossh SSH 隧道）提供：每台远端服务器跑 gost，SSH 转发到本地端口
- 导入节点走 mihomo：`data/pool-nodes.json` 持久化，导入后自动生成 `pool/config.yaml` 并热重载

## License

MIT（上游无 license，本改造为原创实现 + 协议兼容层）
