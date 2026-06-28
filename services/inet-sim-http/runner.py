"""软仿执行器：在宿主机本地复刻 app 侧 SSH 路径（inet_remote.rs SshRunner）的命令，
区别只是去掉 ssh/scp、改本地写文件 + 子进程。结果形状（exit_code/output_tail/csv/
scavetool_failed）与 SimRunOutcome 对齐，app 端 HttpRunner 直接映射（plan KTD1/R1）。

bundle 就是三段文本（network.ned / omnetpp.ini / manifest.json），经 JSON 传来，服务写到
run-<hex> 的固定布局（tsnagent/generated/network.ned 等）——无 tar、无路径穿越面。

单运行（plan R6）：同一时刻只跑一个软仿，忙时 submit 抛 Busy（端点转 409）。
异步：submit 立即返回 job_id，真正执行在后台线程；app 轮询 status/result。
"""

from __future__ import annotations

import os
import secrets
import shlex
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field

import config

_OUTPUT_TAIL_MAX = 2000


class Busy(Exception):
    """已有软仿在跑（单运行）。"""


@dataclass
class Job:
    job_id: str
    status: str = "queued"  # queued | running | done | failed
    result: dict | None = None  # {exit_code, output_tail, csv, scavetool_failed}
    error: str | None = None  # status=failed 时的内部原因
    created_at: float = field(default_factory=time.time)
    run_dir: str | None = None


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def _gen_run_id() -> str:
    """run-<16 hex>，随机源（不用时钟，避碰撞 + 不可预测），仅 [a-z0-9-]（对齐 SSH 路径）。"""
    return "run-" + secrets.token_hex(8)


def _tail(text: str, limit: int = _OUTPUT_TAIL_MAX) -> str:
    if len(text) <= limit:
        return text
    return "…" + text[-limit:]


def _write_bundle(run_dir: str, network_ned: str, omnetpp_ini: str, manifest_json: str) -> None:
    """把三段文本写到 run_dir 固定布局（与 inet_remote.rs SshRunner 写的本地布局一致）。"""
    gen_dir = os.path.join(run_dir, "tsnagent", "generated")
    os.makedirs(gen_dir, exist_ok=True)
    with open(os.path.join(gen_dir, "network.ned"), "w") as fh:
        fh.write(network_ned)
    with open(os.path.join(run_dir, "omnetpp.ini"), "w") as fh:
        fh.write(omnetpp_ini)
    with open(os.path.join(run_dir, "manifest.json"), "w") as fh:
        fh.write(manifest_json)


def _run_in_inet_env(inner: str) -> subprocess.CompletedProcess:
    """以 `<INET_ENV_CMD> -c '<inner>'` 在 OMNeT++/INET 环境里跑 inner（bash 解释整条）。"""
    full = f"{config.INET_ENV_CMD} -c {shlex.quote(inner)}"
    return subprocess.run(
        ["bash", "-c", full],
        capture_output=True,
        text=True,
        timeout=config.CMD_TIMEOUT_S,
    )


def _execute_run(job: Job, scavetool_filter: str) -> None:
    """后台线程体：跑 inet →（exit 0 则）跑 scavetool 取 CSV → 落 result。"""
    run_dir = job.run_dir
    try:
        # 跑 inet（与 inet_remote.rs remote_run_cmd 同形）。
        inet_inner = f"cd {shlex.quote(run_dir)} && inet -u Cmdenv -f omnetpp.ini -n ."
        inet = _run_in_inet_env(inet_inner)
        combined = (inet.stdout or "") + (inet.stderr or "")
        exit_code = inet.returncode

        if exit_code != 0:
            # inet 非 0 → load_failed：不取数，csv=None（app 端 classify 分型）。
            _set_result(job, exit_code, _tail(combined), None, False)
            return

        # 跑 scavetool（与 inet_remote.rs remote_scavetool_cmd 同形：导出 CSV-R 再 cat）。
        scave_inner = (
            f"cd {shlex.quote(run_dir)} && opp_scavetool export -f {shlex.quote(scavetool_filter)} "
            "-F CSV-R -o timechanged.csv results/*.vec >/dev/null 2>&1 && cat timechanged.csv"
        )
        scave = _run_in_inet_env(scave_inner)
        if scave.returncode == 0:
            out = scave.stdout or ""
            csv = out if out.strip() else None  # 跑成功但 0 行 → 真·结果为空
            _set_result(job, exit_code, _tail(combined), csv, False)
        else:
            # 非零退出/缺失 → 命令失败（区别于结果为空）。
            _set_result(job, exit_code, _tail(combined), None, True)
    except subprocess.TimeoutExpired:
        _set_failed(job, "命令超时")
    except OSError as err:
        _set_failed(job, f"执行出错：{err}")
    finally:
        # 每跑完一次就回收旧 run 目录（保留最近 RUN_RETENTION 个）。不再只靠服务启动时
        # gc——服务长跑不重启会让 /tmp/tsn-agent-runs 随仿真次数无界增长（.vec 文件大）。
        # 当前 run 刚写完、mtime 最新，必被保留；gc 内部吞 OSError，不影响 result。
        gc()


def _set_result(
    job: Job, exit_code: int, output_tail: str, csv: str | None, scavetool_failed: bool
) -> None:
    with _lock:
        job.result = {
            "exit_code": exit_code,
            "output_tail": output_tail,
            "csv": csv,
            "scavetool_failed": scavetool_failed,
        }
        job.status = "done"


def _set_failed(job: Job, reason: str) -> None:
    with _lock:
        job.error = reason
        job.status = "failed"


def _has_active_job() -> bool:
    return any(j.status in ("queued", "running") for j in _jobs.values())


def submit(network_ned: str, omnetpp_ini: str, manifest_json: str, scavetool_filter: str) -> str:
    """单运行：有活跃任务则抛 Busy。同步写 bundle，再起后台线程跑慢的 inet+scavetool，返回 job_id。"""
    with _lock:
        if _has_active_job():
            raise Busy("已有软仿在运行")
        job = Job(job_id=_gen_run_id(), status="running")
        _jobs[job.job_id] = job
    run_dir = os.path.join(config.RUN_BASE_DIR, job.job_id)
    job.run_dir = run_dir
    try:
        _write_bundle(run_dir, network_ned, omnetpp_ini, manifest_json)
    except OSError as err:
        _set_failed(job, f"写 bundle 失败：{err}")
        raise
    thread = threading.Thread(target=_execute_run, args=(job, scavetool_filter), daemon=True)
    thread.start()
    return job.job_id


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def gc(retention: int | None = None) -> int:
    """回收旧 run 目录：保留 mtime 最新的 retention 个 run-* 目录，删其余。返回删除数。
    服务启动时调用。只动 run-* 目录（不碰 base_dir 下其它东西）。"""
    keep = config.RUN_RETENTION if retention is None else retention
    base = config.RUN_BASE_DIR
    try:
        entries = [
            os.path.join(base, n)
            for n in os.listdir(base)
            if n.startswith("run-") and os.path.isdir(os.path.join(base, n))
        ]
    except OSError:
        return 0
    entries.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    removed = 0
    for path in entries[keep:]:
        try:
            shutil.rmtree(path)
            removed += 1
        except OSError:
            pass
    return removed
