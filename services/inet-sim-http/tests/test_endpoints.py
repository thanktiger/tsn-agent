"""U2/U3：HTTP 端点（run/status/result）。mock _run_in_inet_env 避免真跑 opp_env。"""

import subprocess
import threading
import time

import config
import pytest
import runner
from fastapi.testclient import TestClient

import app as app_module

client = TestClient(app_module.app)

_BODY = {
    "network_ned": "network Net {}",
    "omnetpp_ini": "[General]\n",
    "manifest_json": "{}",
    "scavetool_filter": "module=~clock",
}


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RUN_BASE_DIR", str(tmp_path / "runs"))
    runner._jobs.clear()
    yield
    runner._jobs.clear()


def _mock_ok(monkeypatch, csv="module,name,vectime,vecvalue\n"):
    def fake(inner: str) -> subprocess.CompletedProcess:
        if "opp_scavetool" in inner:
            return subprocess.CompletedProcess([], 0, csv, "")
        return subprocess.CompletedProcess([], 0, "inet ran", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", fake)


def _poll_status(job_id: str, timeout=5.0) -> str:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = client.get(f"/sim/run/{job_id}/status").json()["status"]
        if last in ("done", "failed"):
            return last
        time.sleep(0.02)
    return last


def test_run_status_result_happy(monkeypatch):
    _mock_ok(monkeypatch)
    resp = client.post("/sim/run", json=_BODY)
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    assert job_id.startswith("run-")
    assert _poll_status(job_id) == "done"
    result = client.get(f"/sim/run/{job_id}/result")
    assert result.status_code == 200
    body = result.json()
    assert body["exit_code"] == 0
    assert body["csv"] == "module,name,vectime,vecvalue\n"
    assert body["scavetool_failed"] is False


_PLAN_BODY = {
    "network_ned": "network Net {}",
    "omnetpp_ini": "[General]\n",
    "manifest_json": "{}",
}


def _mock_plan_ok(
    monkeypatch,
    grep_out='par N.sw1.eth[1].macLayer.queue.transmissionGate[0] durations "[300us, 700us]"\n',
):
    def fake(inner: str) -> subprocess.CompletedProcess:
        if "grep" in inner:
            return subprocess.CompletedProcess([], 0, grep_out, "")
        return subprocess.CompletedProcess([], 0, "inet ran", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", fake)


def _poll_plan_status(job_id: str, timeout=5.0) -> str:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = client.get(f"/sim/plan/{job_id}/status").json()["status"]
        if last in ("done", "failed"):
            return last
        time.sleep(0.02)
    return last


def test_plan_status_result_happy(monkeypatch):
    _mock_plan_ok(monkeypatch)
    resp = client.post("/sim/plan", json=_PLAN_BODY)
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    assert _poll_plan_status(job_id) == "done"
    result = client.get(f"/sim/plan/{job_id}/result")
    assert result.status_code == 200
    body = result.json()
    assert body["exit_code"] == 0
    assert "transmissionGate" in body["sca_gcl"]
    assert body["solver"] == "Z3"


def test_plan_missing_fields_422(monkeypatch):
    _mock_plan_ok(monkeypatch)
    resp = client.post("/sim/plan", json={"network_ned": "x"})
    assert resp.status_code == 422


def test_missing_fields_returns_422(monkeypatch):
    _mock_ok(monkeypatch)
    resp = client.post("/sim/run", json={"network_ned": "x"})  # 缺字段
    assert resp.status_code == 422  # pydantic 校验


def test_busy_returns_409(monkeypatch):
    gate = threading.Event()

    def blocking(inner: str) -> subprocess.CompletedProcess:
        gate.wait(timeout=5)
        return subprocess.CompletedProcess([], 0, "ok", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", blocking)
    first = client.post("/sim/run", json=_BODY)
    assert first.status_code == 202
    second = client.post("/sim/run", json=_BODY)
    assert second.status_code == 409
    gate.set()
    _poll_status(first.json()["job_id"])


def test_status_unknown_404():
    assert client.get("/sim/run/run-nope/status").status_code == 404


def test_result_unknown_404():
    assert client.get("/sim/run/run-nope/result").status_code == 404


def test_result_before_done_409(monkeypatch):
    gate = threading.Event()

    def blocking(inner: str) -> subprocess.CompletedProcess:
        gate.wait(timeout=5)
        return subprocess.CompletedProcess([], 0, "ok", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", blocking)
    job_id = client.post("/sim/run", json=_BODY).json()["job_id"]
    early = client.get(f"/sim/run/{job_id}/result")
    assert early.status_code == 409
    gate.set()
    _poll_status(job_id)
