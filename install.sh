#!/usr/bin/env bash
# ============================================================
# ZenPool Linux 裸机安装脚本（无 Docker）
# 用法:
#   ./install.sh                  # 安装（下载 mihomo + npm install + 初始化配置）
#   ./install.sh --mihomo v1.19.30  # 指定 mihomo 版本
#   ./install.sh --with-systemd    # 额外安装 systemd 服务（需要 root/sudo）
# 安装后:
#   ./bin/start.sh                 # 前台启动（Ctrl+C 停止）
#   或 systemctl start zenpool     # 若使用 --with-systemd
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"
ARCH="$(uname -m)"
MIHOMO_VERSION=""
WITH_SYSTEMD=0

for arg in "$@"; do
  case "$arg" in
    --mihomo) MIHOMO_VERSION="latest" ;;
    --mihomo=*) MIHOMO_VERSION="${arg#*=}" ;;
    --with-systemd) WITH_SYSTEMD=1 ;;
    --help|-h)
      grep '^#' "$0" | head -20 | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
done

say() { printf '\033[1;36m[zenpool]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[zenpool] 错误:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. 检测 node ────────────────────────────────────────────
say "检查 node..."
if ! command -v node >/dev/null 2>&1; then
  die "未找到 node。请先安装 Node.js >= 18（https://nodejs.org），再运行本脚本。"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "node 版本过低（$(node -v)），需要 >= 18。"
fi
say "node $(node -v) ✓"

# ── 2. 下载 mihomo 二进制 ───────────────────────────────────
case "$ARCH" in
  x86_64|amd64) GOARCH="amd64" ;;
  aarch64|arm64) GOARCH="arm64" ;;
  *) die "不支持的架构: $ARCH（支持 amd64 / arm64）" ;;
esac

if command -v mihomo >/dev/null 2>&1; then
  say "已检测到系统 mihomo: $(mihomo -v 2>&1 | head -1)"
elif [ -x ./bin/mihomo ]; then
  say "已存在 ./bin/mihomo: $(./bin/mihomo -v 2>&1 | head -1)"
else
  say "下载 mihomo ($GOARCH)..."
  mkdir -p bin
  if [ "$MIHOMO_VERSION" = "latest" ] || [ -z "$MIHOMO_VERSION" ]; then
    ASSET_URL="$(curl -sL https://api.github.com/repos/MetaCubeX/mihomo/releases/latest \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print([a['browser_download_url'] for a in d['assets'] if 'linux-$GOARCH' in a['name'] and a['name'].endswith('.gz')][0])")"
  else
    ASSET_URL="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-linux-${GOARCH}-compatible-${MIHOMO_VERSION}.gz"
  fi
  curl -sL --max-time 120 -o mihomo.gz "$ASSET_URL" || die "下载 mihomo 失败: $ASSET_URL"
  gunzip -f mihomo.gz
  chmod +x mihomo
  mv mihomo bin/mihomo
  say "mihomo: $(./bin/mihomo -v 2>&1 | head -1)"
fi

# ── 3. 初始化 mihomo 配置 ───────────────────────────────────
if [ ! -f pool/config.yaml ]; then
  say "初始化 pool/config.yaml（从 example）..."
  cp pool/config.yaml.example pool/config.yaml
else
  say "pool/config.yaml 已存在，跳过初始化"
fi

# ── 4. 安装 npm 依赖 ───────────────────────────────────────
say "npm install..."
if [ ! -d node_modules ]; then
  npm install --omit=dev || die "npm install 失败"
else
  say "node_modules 已存在，跳过"
fi

# ── 5. 启动脚本 ─────────────────────────────────────────────
cat > bin/start.sh <<'EOF'
#!/usr/bin/env bash
# ZenPool 启动脚本（前台）
cd "$(dirname "$0")/.."
mkdir -p data
# 先拉起 mihomo（如未运行）
if ! curl -s --max-time 1 http://127.0.0.1:19090/version >/dev/null 2>&1; then
  echo "[zenpool] 启动 mihomo..."
  ./bin/mihomo -d "$PWD/pool" &
  sleep 2
fi
exec node server.mjs
EOF
chmod +x bin/start.sh

# ── 6. systemd（可选）──────────────────────────────────────
if [ "$WITH_SYSTEMD" = "1" ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    die "--with-systemd 需要 systemd（当前系统没有 systemctl）"
  fi
  say "安装 systemd 服务 zenpool..."
  INSTALL_DIR="$(pwd)"
  cat > /tmp/zenpool.service <<EOF
[Unit]
Description=ZenPool proxy (OpenAI/Anthropic compatible)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
Environment=PROXY_PORT=7446
Environment=ZENPOOL_DATA_DIR=${INSTALL_DIR}/data
Environment=MIHOMO_CONTROLLER=127.0.0.1:19090
ExecStartPre=${INSTALL_DIR}/bin/mihomo -d ${INSTALL_DIR}/pool
ExecStart=/usr/bin/env node ${INSTALL_DIR}/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  sudo cp /tmp/zenpool.service /etc/systemd/system/zenpool.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now zenpool
  say "已启动: systemctl status zenpool"
else
  say "安装完成！启动方式:"
  say "  前台运行: ./bin/start.sh"
  say "  或加 --with-systemd 安装为系统服务"
fi

say "完成！health: curl http://127.0.0.1:7446/health  面板: http://127.0.0.1:7446/admin（默认密码 ocpool-admin，请修改）"
