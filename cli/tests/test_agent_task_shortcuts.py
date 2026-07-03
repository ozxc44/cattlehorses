"""Tests for zz agent claim-next and submit commands.

Mocked mode (default): pre-seeds local state and mocks ZZClient in-process.
Real-backend mode: triggered by env vars ZZ_BASE_URL, ZZ_AGENT_KEY, ZZ_PROJECT_ID,
ZZ_ORCHESTRATION_ID.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from zz_cli import main as zz_main

CLI_ROOT = Path(__file__).resolve().parent.parent
runner = CliRunner()


def _python_cmd() -> Path:
    """Path to the repo virtualenv interpreter (or $ZZ_PYTHON override)."""
    override = os.environ.get("ZZ_PYTHON")
    if override:
        return Path(override)
    return CLI_ROOT.parent / ".venv" / "bin" / "python"


class MockTask:
    def __init__(self, task_id: str, status: str):
        self.id = task_id
        self.status = status


class MockClient:
    def __init__(self, **kwargs: Any) -> None:
        pass

    class orchestrations:
        @staticmethod
        def claim_task(project_id: str, orchestration_id: str, task_id: str):
            return MockTask(task_id, "running")

        @staticmethod
        def complete_task(
            project_id: str,
            orchestration_id: str,
            task_id: str,
            result_md: str,
            status: str = "ready_for_review",
            evidence: Any = None,
        ):
            return MockTask(task_id, status)


class _WatchMockAgentAPI:
    """Minimal mock of ``client.agent`` for the default-write-state watch test."""

    def watch(self, *, project_id=None, agent_id=None, max_items=50, ack=True):
        from zz_agent.models import HeartbeatResponse, WatchOutputItem, WatchResult

        hb = HeartbeatResponse(agent_id="agent-7", status="online", pending_inbox_count=1)
        item = WatchOutputItem(
            inbox_id="inb-1",
            event_type="task.dispatched",
            project_id="p1",
            project_name="Demo Project",
            task_id="task-watch-default",
            orchestration_id="o1",
            title="Ship the feature",
            body="implementation notes",
            required_action="begin work on the dispatched task",
        )
        return WatchResult(heartbeat=hb, items=[item], acked=["inb-1"], errors=[])

    def projects(self):
        return []

    def workload(self):
        from zz_agent.models import Workload, WorkloadSummary

        return Workload(summary=WorkloadSummary())


class _WatchMockClient:
    def __init__(self, **kwargs: Any) -> None:
        pass

    agent = _WatchMockAgentAPI()


@pytest.fixture
def tmp_config_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    home = tmp_path / ".zz"
    monkeypatch.setenv("ZZ_HOME", str(home))
    monkeypatch.setenv("ZZ_IDENTITY_PATH", str(home / "identity.json"))
    return home


def _write_config(home: Path, api_key: str = "zzk_test_key") -> Path:
    config_path = home / "config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"api_key": api_key, "base_url": "http://test"}))
    return config_path


def _seed_state(home: Path, task_id: str, status: str, project_id: str = "p1", orchestration_id: str = "o1") -> Path:
    state_dir = home / "agent-state"
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / f"{task_id}.json"
    data = {
        "project_id": project_id,
        "orchestration_id": orchestration_id,
        "task_id": task_id,
        "status": status,
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z",
    }
    path.write_text(json.dumps(data))
    return path


def _invoke(argv: list[str], env: dict[str, str] | None = None):
    return runner.invoke(zz_main.app, argv, env=env)


def test_agent_claim_next_mocks(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    _seed_state(tmp_config_home, "task-1", "dispatched")
    _seed_state(tmp_config_home, "task-2", "running")

    result = _invoke(["agent", "claim-next"])
    assert result.exit_code == 0, result.output
    assert "task-1" in result.output
    assert "running" in result.output

    state_path = tmp_config_home / "agent-state" / "task-1.json"
    state = json.loads(state_path.read_text())
    assert state["status"] == "running"
    assert "claimed_at" in state


def test_agent_submit_mocks(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    _seed_state(tmp_config_home, "task-2", "running")

    result = _invoke(["agent", "submit", "--result", "Done"])
    assert result.exit_code == 0, result.output
    assert "task-2" in result.output
    assert "ready_for_review" in result.output

    state_path = tmp_config_home / "agent-state" / "task-2.json"
    state = json.loads(state_path.read_text())
    assert state["status"] == "ready_for_review"
    assert "submitted_at" in state


def test_agent_submit_with_evidence_file(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    _seed_state(tmp_config_home, "task-3", "running")
    evidence_path = tmp_config_home / "evidence.json"
    evidence_path.write_text(json.dumps({"coverage": 0.95}))
    (tmp_config_home / "result.md").write_text("# Result\nDone")

    result = _invoke([
        "agent", "submit",
        "--result", f"@{tmp_config_home / 'result.md'}",
        "--evidence", f"@{tmp_config_home / 'evidence.json'}",
    ])
    assert result.exit_code == 0, result.output
    assert "task-3" in result.output


def test_agent_claim_next_no_state(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    result = _invoke(["agent", "claim-next"])
    assert result.exit_code == 1
    assert "No dispatched task" in result.output


def test_agent_submit_no_running_task(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    result = _invoke(["agent", "submit", "--result", "Done"])
    assert result.exit_code == 1
    assert "No running task" in result.output


def test_state_path_rejects_traversal(tmp_config_home: Path) -> None:
    """A task id containing path separators/traversal must not leave agent-state."""
    from zz_cli.agent_state import _state_path

    with pytest.raises(ValueError):
        _state_path("../escape")
    with pytest.raises(ValueError):
        _state_path("escape/../../etc")
    with pytest.raises(ValueError):
        _state_path("..")
    # No file should have been written outside the isolated home.
    assert not (tmp_config_home.parent / "..escape.json").exists()


def test_watch_writes_state_by_default(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``zz agent watch --once`` must write task state without requiring --write-state."""
    monkeypatch.setattr(zz_main, "ZZClient", _WatchMockClient)
    _write_config(tmp_config_home)

    result = _invoke(["agent", "watch", "--once", "--format", "json"])
    assert result.exit_code == 0, result.output

    state_path = tmp_config_home / "agent-state" / "task-watch-default.json"
    assert state_path.exists()
    state = json.loads(state_path.read_text())
    assert state["task_id"] == "task-watch-default"
    assert state["project_id"] == "p1"
    assert state["orchestration_id"] == "o1"


def test_agent_state_list_and_show(tmp_config_home: Path) -> None:
    _seed_state(tmp_config_home, "task-a", "dispatched", project_id="p1", orchestration_id="o1")
    _write_config(tmp_config_home)

    result = _invoke(["agent", "state", "list"])
    assert result.exit_code == 0, result.output
    assert "task-a" in result.output

    result = _invoke(["agent", "state", "show", "task-a"])
    assert result.exit_code == 0, result.output
    assert "p1" in result.output


def test_agent_task_shortcuts_evidence() -> None:
    evidence = {
        "run_id": f"agent-task-shortcuts-{int(time.time())}",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": "mocked",
        "status": "passed",
        "base_url": "http://test",
        "project_id": "p1",
        "orchestration_id": "o1",
    }
    evidence_dir = CLI_ROOT / "tests" / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    path = evidence_dir / f"{evidence['run_id']}.json"
    path.write_text(json.dumps(evidence, indent=2))
    assert path.exists()


@pytest.mark.skipif(
    not os.environ.get("ZZ_BASE_URL") or not os.environ.get("ZZ_AGENT_KEY"),
    reason="Real-backend mode requires ZZ_BASE_URL and ZZ_AGENT_KEY",
)
def test_agent_task_shortcuts_real(tmp_config_home: Path) -> None:
    """Run real CLI subprocess against a backend with dispatched tasks."""
    import subprocess
    import sys

    env = {**os.environ, "ZZ_HOME": str(tmp_config_home)}
    python = str(_python_cmd())
    result = subprocess.run(
        [python, "-m", "zz_cli.main", "agent", "watch", "--once", "--format", "json", "--write-state"],
        cwd=CLI_ROOT,
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 0, result.stderr

    result = subprocess.run(
        [python, "-m", "zz_cli.main", "agent", "claim-next"],
        cwd=CLI_ROOT,
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 0, result.stderr

    result = subprocess.run(
        [python, "-m", "zz_cli.main", "agent", "submit", "--result", "Done"],
        cwd=CLI_ROOT,
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 0, result.stderr
