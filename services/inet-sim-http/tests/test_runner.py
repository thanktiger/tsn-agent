"""U2/U3：runner（执行 + 单运行 + GC）。mock _run_in_inet_env 避免真跑 opp_env。"""

import os
import subprocess
import threading
import time

import config
import pytest
import runner

_NED = "network Net {}"
_INI = "[General]\n"
_MANIFEST = "{}"


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RUN_BASE_DIR", str(tmp_path / "runs"))
    runner._jobs.clear()
    yield
    runner._jobs.clear()


def _submit(filt="filt"):
    return runner.submit(_NED, _INI, _MANIFEST, filt)


def _fake_inet_env(inet_rc=0, inet_out="inet ran", scave_rc=0, scave_out="csv-data"):
    def fake(inner: str) -> subprocess.CompletedProcess:
        if "opp_scavetool" in inner:
            return subprocess.CompletedProcess([], scave_rc, scave_out, "")
        return subprocess.CompletedProcess([], inet_rc, inet_out, "")

    return fake


def _wait_done(job_id: str, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = runner.get_job(job_id)
        if job and job.status in ("done", "failed"):
            return job
        time.sleep(0.02)
    raise AssertionError("job 未在超时内完成")


def test_happy_path_writes_bundle_and_returns_csv(monkeypatch):
    monkeypatch.setattr(
        runner, "_run_in_inet_env", _fake_inet_env(scave_out="module,name,vectime,vecvalue\n")
    )
    job = _wait_done(_submit())
    assert job.status == "done"
    assert job.result["exit_code"] == 0
    assert job.result["csv"] == "module,name,vectime,vecvalue\n"
    assert job.result["scavetool_failed"] is False
    # bundle 写到固定布局（与 SSH 路径一致）
    assert os.path.isfile(os.path.join(job.run_dir, "omnetpp.ini"))
    assert os.path.isfile(os.path.join(job.run_dir, "manifest.json"))
    assert os.path.isfile(os.path.join(job.run_dir, "tsnagent/generated/network.ned"))


def test_inet_nonzero_exit_skips_scavetool(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env(inet_rc=1, inet_out="boom"))
    job = _wait_done(_submit())
    assert job.result["exit_code"] == 1
    assert job.result["csv"] is None
    assert job.result["scavetool_failed"] is False


def test_scavetool_empty_is_not_failure(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env(scave_out="   \n"))
    job = _wait_done(_submit())
    assert job.result["csv"] is None
    assert job.result["scavetool_failed"] is False  # 跑成功但 0 行 → 结果为空，非失败


def test_scavetool_nonzero_is_failure(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env(scave_rc=2, scave_out=""))
    job = _wait_done(_submit())
    assert job.result["csv"] is None
    assert job.result["scavetool_failed"] is True


def test_single_run_rejects_second(monkeypatch):
    gate = threading.Event()

    def blocking(inner: str) -> subprocess.CompletedProcess:
        gate.wait(timeout=5)
        return subprocess.CompletedProcess([], 0, "ok", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", blocking)
    first = _submit()  # 卡在 inet 上
    with pytest.raises(runner.Busy):
        _submit()
    gate.set()
    _wait_done(first)
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env())
    second = _submit()
    assert second != first


def _fake_plan_env(
    inet_rc=0,
    inet_out="inet ran",
    grep_out='par N.sw1.eth[1].macLayer.queue.transmissionGate[0] durations "[300us, 700us]"\n',
):
    """plan verb 的 _run_in_inet_env mock：inet（param-recording）+ grep .sca 两步。"""

    def fake(inner: str) -> subprocess.CompletedProcess:
        if "grep" in inner:
            return subprocess.CompletedProcess([], 0, grep_out, "")
        return subprocess.CompletedProcess([], inet_rc, inet_out, "")

    return fake


def test_plan_happy_returns_sca_gcl(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_plan_env())
    job = _wait_done(runner.submit_plan(_NED, _INI, _MANIFEST))
    assert job.status == "done"
    assert job.result["exit_code"] == 0
    assert "transmissionGate" in job.result["sca_gcl"]
    assert job.result["solver"] == "Z3"
    # bundle 写到固定布局。
    assert os.path.isfile(os.path.join(job.run_dir, "omnetpp.ini"))


def test_plan_inet_nonzero_no_gcl(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_plan_env(inet_rc=1, inet_out="UNSAT"))
    job = _wait_done(runner.submit_plan(_NED, _INI, _MANIFEST))
    assert job.result["exit_code"] == 1
    assert job.result["sca_gcl"] is None
    assert job.result["solver"] is None


def test_plan_empty_grep_is_none(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_plan_env(grep_out="   \n"))
    job = _wait_done(runner.submit_plan(_NED, _INI, _MANIFEST))
    assert job.result["exit_code"] == 0
    assert job.result["sca_gcl"] is None  # grep 0 行 → None


def test_plan_and_sim_share_single_run_lock(monkeypatch):
    gate = threading.Event()

    def blocking(inner: str) -> subprocess.CompletedProcess:
        gate.wait(timeout=5)
        return subprocess.CompletedProcess([], 0, "ok", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", blocking)
    first = runner.submit_plan(_NED, _INI, _MANIFEST)  # 卡住
    with pytest.raises(runner.Busy):
        _submit()  # sim 提交应被单运行锁拒
    gate.set()
    _wait_done(first)


def test_gc_keeps_recent_n(monkeypatch):
    base = config.RUN_BASE_DIR
    os.makedirs(base, exist_ok=True)
    for i in range(5):
        d = os.path.join(base, f"run-{i:02d}")
        os.makedirs(d)
        os.utime(d, (i, i))
    other = os.path.join(base, "not-a-run")
    os.makedirs(other)
    removed = runner.gc(retention=2)
    assert removed == 3
    remaining = sorted(n for n in os.listdir(base) if n.startswith("run-"))
    assert remaining == ["run-03", "run-04"]
    assert os.path.isdir(other)  # 非 run-* 不动


def test_execute_run_gcs_old_runs_each_time(monkeypatch):
    """每次软仿跑完自动回收旧 run（不再只靠服务启动 gc），防 /tmp 无界增长。"""
    monkeypatch.setattr(config, "RUN_RETENTION", 2)
    monkeypatch.setattr(
        runner, "_run_in_inet_env", _fake_inet_env(scave_out="module,name,vectime,vecvalue\n")
    )
    base = config.RUN_BASE_DIR
    os.makedirs(base, exist_ok=True)
    # 预置 3 个旧 run（mtime 很旧），模拟此前累积。
    for i in range(3):
        d = os.path.join(base, f"run-old{i}")
        os.makedirs(d)
        os.utime(d, (i, i))
    job = _wait_done(_submit())  # 新 run 跑完 → finally gc(retention=2)
    # gc 在 status=done 之后的 finally 里跑（后台线程），轮询等其生效。
    deadline = time.time() + 2.0
    remaining: list[str] = []
    while time.time() < deadline:
        remaining = sorted(n for n in os.listdir(base) if n.startswith("run-"))
        if len(remaining) == 2:
            break
        time.sleep(0.02)
    assert len(remaining) == 2, remaining  # 只留最近 2 个
    assert os.path.basename(job.run_dir) in remaining  # 刚跑的（最新）必保留
