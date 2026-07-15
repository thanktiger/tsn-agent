# 远程 INET 宿主机部署

当 HTTP 服务与 INET 仿真环境不在同一台机器上时（例如新机是 ARM64、没有 nix/opp_env/INET），
可以用 SSHFS + SSH 执行把 bundle 和命令路由到有 INET 环境的旧机上跑。

## 前提

- **执行机**（部署本服务）：Python 3.12+、sshfs、可 SSH 到 INET 机
- **INET 机**：已有 nix + opp_env + inet-4.6.0 workspace（`/tmp/tsn-agent-runs/` 用作运行目录）
- 两机之间已配 SSH 免密（key 方式）

## 部署步骤

### 1. 装 sshfs

```bash
sudo apt-get install -y sshfs
```

### 2. 建 venv + 装依赖

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 3. 设 SSH wrapper

```bash
cp deploy/inet-remote.sh ~/.local/bin/inet-remote
chmod +x ~/.local/bin/inet-remote
```

`inet-remote.sh` 接受 `-c '<command>'`，通过 SSH 把命令发给 INET 机、
在 `opp_env run inet-4.6.0` 环境里执行。

### 4. 安装 user-level systemd 服务

```bash
mkdir -p ~/.config/systemd/user
# 按需改以下 env：
#   INET_SIM_SSH_HOST — INET 机的 SSH user@host
#   INET_SIM_PORT     — 监听端口（默认 19090）
cp deploy/inet-sim-http-remote.service ~/.config/systemd/user/inet-sim-http.service
systemctl --user daemon-reload
systemctl --user enable --now inet-sim-http
loginctl enable-linger $USER   # 用户登出后服务不停止
```

### 5. 自检

```bash
curl http://localhost:19090/sim/healthz
```

## 验证清单

- `healthz` 四探针全绿
- 在 app 里提交一次软仿——bundle 经 SSHFS 写到 `/tmp/tsn-agent-runs/`，
  inet 经 SSH wrapper 在 INET 机上执行，结果通过 SSHFS 读回

## 架构

```
app → HTTP → 新机(:19090)  uvicorn
                  ├─ bundle 写 → SSHFS mount → INET 机 /tmp/tsn-agent-runs/
                  ├─ inet 执行 → inet-remote.sh → SSH → INET 机 opp_env run inet-4.6.0
                  └─ CSV 结果 ← SSHFS mount ← INET 机 /tmp/tsn-agent-runs/
```