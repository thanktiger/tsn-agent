# inet-sim-http — 薄 HTTP 软仿服务

部署在 INET 宿主机上，替代 app→宿主机的 SSH/scp 远程软仿执行。app 端只配 `host:port`
（设置面板「INET 软仿服务地址」），不再需要免密 SSH。

服务做的事：收 bundle（tar）→ 在本机以沉淀的 opp_env 指令跑 `inet` + `opp_scavetool`
→ 回原始 CSV + 退出码 + stderr。解析/收敛判定仍在 app 端。一次只跑一个软仿（忙时 409）。

## 前置依赖

服务启动 + `GET /sim/healthz` 都会校验这几项，缺则明确报错、拒接任务：

- **nix profile**：`/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh` 存在（可 source）
- **opp_env**：`/home/zhang/.local/bin/opp_env` 存在且可执行
- **Python**：python3 + venv 支持（Ubuntu/Debian 需 `sudo apt install python3.12-venv`，否则建 venv 会失败）+ 本服务依赖（fastapi/uvicorn，见 requirements.txt）
- **运行目录**：`/tmp/tsn-agent-runs` 可写

（路径都可由环境变量覆盖，见下「配置」。）

## 部署

```bash
cd services/inet-sim-http
bash deploy/install.sh          # 建 venv 装依赖 + 装 systemd unit + 起服务（装 unit 需 sudo）
```

自检：

```bash
curl -s http://localhost:19090/sim/healthz    # 期望 {"ok": true, "checks": {...}}
```

然后在 app 设置面板把「INET 软仿服务地址」填成 `http://<宿主机IP>:19090`，软仿即走 HTTP；
留空则走原 SSH 兜底路径。

## 配置（环境变量）

在 systemd unit 里加 `Environment=KEY=VALUE`，或起服务前 export：

| 变量 | 默认 | 说明 |
|---|---|---|
| `INET_SIM_PORT` | `19090` | 监听端口 |
| `INET_SIM_RUN_DIR` | `/tmp/tsn-agent-runs` | 每次软仿在其下建 `run-<hex>` 子目录 |
| `INET_SIM_ENV_CMD` | 见 config.py | 沉淀的 opp_env 指令前缀（**须与 app 侧 SSH 路径逐字一致**） |
| `INET_SIM_OPP_ENV_BIN` | `/home/zhang/.local/bin/opp_env` | 前置验证探针：opp_env 二进制路径 |
| `INET_SIM_NIX_PROFILE` | `/nix/.../nix-daemon.sh` | 前置验证探针：nix profile 脚本 |
| `INET_SIM_RUN_RETENTION` | `20` | 启动 GC 时保留最近 N 个 run 目录 |
| `INET_SIM_CMD_TIMEOUT` | `600` | 单条命令超时秒数（opp_env 首跑编译慢，给足） |

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sim/healthz` | 前置验证 `{ok, checks}` |
| POST | `/sim/run` | JSON：`{network_ned, omnetpp_ini, manifest_json, scavetool_filter}` → `202 {job_id}`；忙 409 |
| GET | `/sim/run/{job_id}/status` | `{status: queued\|running\|done\|failed}` |
| GET | `/sim/run/{job_id}/result` | done 才回 `{exit_code, output_tail, csv, scavetool_failed}`；运行中 409、失败 500、未知 404 |

## 排障

- **healthz `ok:false`**：看 `checks` 里哪项 `ok:false` + `detail`——按提示装 nix/opp_env、修运行目录权限。
- **软仿一直 `running` 或超时**：opp_env 首次编译可能数分钟；超时上限由 `INET_SIM_CMD_TIMEOUT` 控。`journalctl -u inet-sim-http -f` 看日志。
- **结果对不上 SSH 路径**：确认 `INET_SIM_ENV_CMD` 与 app 侧 `inet_remote.rs` 的 `DEFAULT_INET_ENV_CMD` 逐字一致（这是结果一致的前提）。
- **查某次 run 的实际产物**：去 `/tmp/tsn-agent-runs/run-<hex>/` 看 `omnetpp.ini`/`network.ned`/`results/` 与导出的 `timechanged.csv`。

## 测试

```bash
cd services/inet-sim-http
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
.venv/bin/python -m pytest        # 单测 mock 掉 opp_env 执行，不需真 INET 环境
```
