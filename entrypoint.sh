#!/bin/sh
# ZenPool SSH 隧道模板（ocpool-tunnels）
# 通过 TUNNELS 环境变量注入隧道列表（每行一条 autossh 参数），部署时自行替换。
# 示例格式（环境变量 TUNNELS）：
#   -i /keys/my_key -L 0.0.0.0:15446:127.0.0.1:15446 user@YOUR_SERVER_IP &
# 多行用换行分隔；每行会追加公共参数后执行。
COMMON="-o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes"

if [ -n "$TUNNELS" ]; then
  echo "$TUNNELS" | while IFS= read -r line; do
    [ -z "$line" ] && continue
    # shellcheck disable=SC2086
    autossh -M 0 -N $COMMON $line &
  done
fi

# ── 备用：取消注释并按需修改，直接内置你的隧道 ──────────────
# autossh -M 0 -N $COMMON -i /keys/ssh_key -L 0.0.0.0:15446:127.0.0.1:15446 user@1.2.3.4 &

# 等待所有隧道进程
wait