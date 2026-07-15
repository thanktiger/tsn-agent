#!/usr/bin/env bash
# INET SSH execution wrapper — runner.py 的 INET_ENV_CMD 指向此脚本。
# 用法: inet-remote.sh -c '<inner_command>'
# 把命令通过 SSH 发给有 INET/opp_env/nix 的远程宿主机跑、结果 stdout 回传。
# 环境变量 INET_SIM_SSH_HOST 覆写目标主机（默认 zhang@100.104.38.106）。
set -euo pipefail

INET_HOST="${INET_SIM_SSH_HOST:-zhang@100.104.38.106}"
NIX_SRC="source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh"
OPP="/home/zhang/.local/bin/opp_env"
WS="/home/zhang/inet-workspace"

if [ "${1:-}" != "-c" ] || [ -z "${2:-}" ]; then
    echo "Usage: $0 -c '<command>'" >&2
    exit 1
fi
inner="$2"
# shell 转义内层命令（对齐 Python shlex.quote），逐字进 SSH 远端。
quoted=$(printf "%q" "$inner")
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=30 "$INET_HOST" \
  "cd /tmp/tsn-agent-runs && ${NIX_SRC} && NIX_CONFIG='substituters =' ${OPP} run inet-4.6.0 -w ${WS} --build-modes=release -c ${quoted}"