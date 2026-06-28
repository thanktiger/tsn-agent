"""薄 HTTP 软仿服务的配置（沉淀指令 + 运行目录 + 端口），全部可由环境变量覆盖。

`INET_ENV_CMD` 是软仿在宿主机本地跑命令的环境前缀，以 `<INET_ENV_CMD> -c '<inner>'`
把 inet / opp_scavetool 丢进 opp_env 的 OMNeT++/INET 环境里跑。
"""

import os

# 沉淀的 INET 环境命令前缀：把任意命令丢进 opp_env 的 OMNeT++/INET 环境里跑
# （inet 与 opp_scavetool 都在该环境 PATH 上）。以 `<INET_ENV_CMD> -c '<inner>'` 调用。
#
# NIX_CONFIG='substituters =' 强制 nix 离线：本宿主机连不上 cache.nixos.org（被墙，
# curl 返回 000），但本地 nix store 已有完整 inet-4.6.0/omnetpp-6.4.0 环境。不置空时
# nix 每次 opp_env run 会去 cache.nixos.org 校验/补下载、撞网络就挂（仿真时好时坏、
# 常卡在取数那步）。置空 substituters → 只用本地 store、零网络依赖、稳定。
INET_ENV_CMD = os.environ.get(
    "INET_SIM_ENV_CMD",
    "source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && "
    "NIX_CONFIG='substituters =' "
    "/home/zhang/.local/bin/opp_env run inet-4.6.0 "
    "-w /home/zhang/inet-workspace --build-modes=release",
)

# 每个软仿在 RUN_BASE_DIR 下建独立 run-<hex> 子目录（与 SSH 路径同基目录，互不影响）。
RUN_BASE_DIR = os.environ.get("INET_SIM_RUN_DIR", "/tmp/tsn-agent-runs")

# 服务监听端口（与硬件部署 19080 区分）。
PORT = int(os.environ.get("INET_SIM_PORT", "19090"))

# 前置验证用的轻量探针：只查存在性，不实跑 opp_env（首跑编译数分钟，不能塞进 healthz）。
NIX_PROFILE_SCRIPT = os.environ.get(
    "INET_SIM_NIX_PROFILE",
    "/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh",
)
OPP_ENV_BIN = os.environ.get("INET_SIM_OPP_ENV_BIN", "/home/zhang/.local/bin/opp_env")

# run 目录保留个数（GC 时保留最近 N 个，超出清理）。
RUN_RETENTION = int(os.environ.get("INET_SIM_RUN_RETENTION", "20"))

# 单条命令超时（秒）。opp_env 首跑编译慢，给足。
CMD_TIMEOUT_S = int(os.environ.get("INET_SIM_CMD_TIMEOUT", "600"))
