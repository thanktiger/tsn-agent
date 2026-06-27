#!/usr/bin/env bash
# 在 INET 宿主机部署薄 HTTP 软仿服务：建 venv 装依赖 → 渲染并安装 systemd unit → 起服务。
# 用法：bash deploy/install.sh   （需 sudo 装 unit；可用 INET_SIM_PORT 覆盖端口）
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${SUDO_USER:-$USER}"
PORT="${INET_SIM_PORT:-19090}"

echo "==> 服务目录：$SERVICE_DIR  用户：$USER_NAME  端口：$PORT"

echo "==> 建 venv 并装依赖"
python3 -m venv "$SERVICE_DIR/.venv"
"$SERVICE_DIR/.venv/bin/pip" install --upgrade pip >/dev/null
"$SERVICE_DIR/.venv/bin/pip" install -r "$SERVICE_DIR/requirements.txt"

echo "==> 渲染并安装 systemd unit（需 sudo）"
sed -e "s|__USER__|$USER_NAME|g" \
    -e "s|__SERVICE_DIR__|$SERVICE_DIR|g" \
    -e "s|__PORT__|$PORT|g" \
    "$SERVICE_DIR/deploy/inet-sim-http.service" \
  | sudo tee /etc/systemd/system/inet-sim-http.service >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now inet-sim-http

echo "==> 已启动。自检："
echo "    curl -s http://localhost:$PORT/sim/healthz"
echo "    journalctl -u inet-sim-http -f   # 看日志"
