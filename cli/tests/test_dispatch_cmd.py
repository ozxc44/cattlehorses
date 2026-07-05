"""Tests for `zz dispatch` command."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from typer.testing import CliRunner

from zz_cli import main as zz_main

runner = CliRunner()


class MockTask:
    def __init__(
        self,
        task_id: str,
        status: str,
        title: str = "Mock task",
        assigned_agent_id: str | None = None,
    ):
        self.id = task_id
        self.status = status
        self.title = title
        self.assigned_agent_id = assigned_agent_id


class MockResponse:
    def __init__(self, json_data: dict[str, Any]):
        self._json = json_data

    def json(self) -> dict[str, Any]:
        return self._json


class MockOrchestrationsAPI:
    """Stateful mock for client.orchestrations."""

    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.task_sequence: dict[str, list[MockTask]] = {}
        self._default_task = MockTask("task-1", "dispatched", assigned_agent_id="agent-1")

    def create_task(self, **kwargs: Any) -> MockTask:
        self.created.append(kwargs)
        return MockTask(
            kwargs.get("task_id") or "task-1",
            "dispatched",
            title=kwargs.get("title", "Mock task"),
            assigned_agent_id=kwargs.get("assigned_agent_id"),
        )

    def get_task(self, *, task_id: str, **kwargs: Any) -> MockTask:
        sequence = self.task_sequence.get(task_id, [self._default_task])
        if len(sequence) == 1:
            return sequence[0]
        # Pop the next state for polling tests.
        return sequence.pop(0)


class MockClient:
    def __init__(self, **kwargs: Any) -> None:
        self.orchestrations = MockOrchestrationsAPI()
        self._smart_response: dict[str, Any] = {
            "task_id": "task-smart-1",
            "assigned_agent_id": "agent-smart-1",
            "assigned_agent_name": "Smart Worker",
            "selection_reason": "online, dispatchable, fewest active tasks (0)",
        }
        self._request_log: list[tuple[str, str, dict[str, Any] | None]] = []

    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> MockResponse:
        self._request_log.append((method, path, json))
        return MockResponse(self._smart_response)


@pytest.fixture(autouse=True)
def _mock_client(monkeypatch: pytest.MonkeyPatch) -> MockClient:
    mock = MockClient()
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    monkeypatch.setattr(zz_main, "_get_client", lambda: mock)
    return mock


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


def _invoke(argv: list[str]):
    return runner.invoke(zz_main.app, argv)


def test_dispatch_with_agent(tmp_config_home: Path) -> None:
    """Non-smart dispatch creates a task with assigned_agent_id."""
    _write_config(tmp_config_home)

    result = _invoke([
        "dispatch",
        "--project", "p1",
        "--orchestration", "o1",
        "--title", "Fix bug",
        "--goal", "Fix the login bug",
        "--agent", "agent-1",
    ])

    assert result.exit_code == 0, result.output
    assert "Task dispatched" in result.output
    assert "agent-1" in result.output
    assert "dispatched" in result.output


def test_dispatch_smart(tmp_config_home: Path, _mock_client: MockClient) -> None:
    """Smart dispatch calls the smart-dispatch endpoint."""
    _write_config(tmp_config_home)

    result = _invoke([
        "dispatch",
        "--project", "p1",
        "--orchestration", "o1",
        "--title", "Write docs",
        "--goal", "Update the cookbook",
        "--smart",
        "--capability", "docs",
    ])

    assert result.exit_code == 0, result.output
    assert "task-smart-1" in result.output
    assert "agent-smart-1" in result.output
    assert _mock_client._request_log
    method, path, body = _mock_client._request_log[0]
    assert method == "POST"
    assert path.endswith("/tasks/smart-dispatch")
    assert body == {"title": "Write docs", "goal": "Update the cookbook", "required_capability": "docs"}


def test_dispatch_smart_without_capability(tmp_config_home: Path, _mock_client: MockClient) -> None:
    """Smart dispatch works without --capability."""
    _write_config(tmp_config_home)

    result = _invoke([
        "dispatch",
        "--project", "p1",
        "--orchestration", "o1",
        "--title", "Write docs",
        "--goal", "Update the cookbook",
        "--smart",
    ])

    assert result.exit_code == 0, result.output
    assert "task-smart-1" in result.output
    method, path, body = _mock_client._request_log[0]
    assert body == {"title": "Write docs", "goal": "Update the cookbook"}


def test_dispatch_requires_agent_or_smart(tmp_config_home: Path) -> None:
    """Dispatch fails when neither --agent nor --smart is provided."""
    _write_config(tmp_config_home)

    result = _invoke([
        "dispatch",
        "--project", "p1",
        "--orchestration", "o1",
        "--title", "Fix bug",
        "--goal", "Fix the login bug",
    ])

    assert result.exit_code != 0
    assert "--agent is required unless --smart is used" in result.output


def test_dispatch_wait_ready_for_review(tmp_config_home: Path, _mock_client: MockClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """--wait polls until the task reaches ready_for_review."""
    _write_config(tmp_config_home)
    monkeypatch.setattr(zz_main, "time", MagicMock())

    _mock_client.orchestrations.task_sequence["task-1"] = [
        MockTask("task-1", "dispatched", assigned_agent_id="agent-1"),
        MockTask("task-1", "running", assigned_agent_id="agent-1"),
        MockTask("task-1", "ready_for_review", assigned_agent_id="agent-1"),
    ]

    result = _invoke([
        "dispatch",
        "--project", "p1",
        "--orchestration", "o1",
        "--title", "Fix bug",
        "--goal", "Fix the login bug",
        "--agent", "agent-1",
        "--wait",
        "--timeout", "30",
        "--poll-interval", "1",
    ])

    assert result.exit_code == 0, result.output
    assert "Waiting for task task-1" in result.output
    assert "ready_for_review" in result.output


def test_dispatch_wait_timeout(tmp_config_home: Path, _mock_client: MockClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """--wait exits non-zero when the task does not reach a terminal state in time."""
    _write_config(tmp_config_home)
    monkeypatch.setattr(zz_main, "time", MagicMock())

    _mock_client.orchestrations.task_sequence["task-1"] = [
        MockTask("task-1", "dispatched", assigned_agent_id="agent-1"),
    ]

    result = _invoke([
        "dispatch",
        "--project", "p1",
        "--orchestration", "o1",
        "--title", "Fix bug",
        "--goal", "Fix the login bug",
        "--agent", "agent-1",
        "--wait",
        "--timeout", "2",
        "--poll-interval", "1",
    ])

    assert result.exit_code != 0
    assert "Timeout waiting for task task-1" in result.output
