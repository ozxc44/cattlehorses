"""Focused coverage for the zero-prep onboarding acceptance criteria.

These tests guard behaviour that the broader smoke/shortcuts suites exercise
only indirectly:

* ``zz agent watch --once --format json`` must emit a machine-readable JSON
  payload (parseable, with the expected heartbeat/items contract) and must
  NEVER leak the agent's secret key (``zzk_``) into stdout.
* ``zz agent submit`` must refuse clearly (exit 1, helpful message) when there
  is no current claimed task.

All runs are in-process (CliRunner) with a mocked ``ZZClient`` and an isolated
``ZZ_HOME`` — no network.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from zz_cli import main as zz_main
from zz_agent.models import (
    HeartbeatResponse,
    WatchOutputItem,
    WatchResult,
    Workload,
    WorkloadSummary,
)

# A stand-in secret. It is placed in config (so the agent client is built) but
# must never appear in the watch JSON output.
SECRET_KEY = "zzk_TOPSECRET_leakcheck_4242"


class _AgentAPI:
    """Minimal mock of the SDK ``client.agent`` namespace used by watch."""

    def watch(self, *, project_id=None, agent_id=None, max_items=50, ack=True):
        hb = HeartbeatResponse(agent_id="agent-7", status="online", pending_inbox_count=2)
        item = WatchOutputItem(
            inbox_id="inb-1",
            event_type="task.dispatched",
            project_id="proj-1",
            project_name="Demo Project",
            task_id="task-1",
            orchestration_id="orch-1",
            title="Ship the feature",
            body="implementation notes",
            required_action="begin work on the dispatched task",
        )
        return WatchResult(heartbeat=hb, items=[item], acked=["inb-1"], errors=[])

    def projects(self):
        return []

    def workload(self):
        return Workload(summary=WorkloadSummary())


class MockClient:
    def __init__(self, **kwargs: Any) -> None:
        pass

    agent = _AgentAPI()


@pytest.fixture
def isolated_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    home = tmp_path / ".zz"
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.json").write_text(
        json.dumps({"api_key": SECRET_KEY, "base_url": "http://test"})
    )
    monkeypatch.setenv("ZZ_HOME", str(home))
    return home


runner = CliRunner()


def _extract_json_payload(output: str) -> dict:
    """Find and parse the watch JSON object within mixed stdout/stderr output."""
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            parsed = json.loads(stripped)
        except ValueError:
            continue
        if isinstance(parsed, dict) and "heartbeat" in parsed:
            return parsed
    raise AssertionError(f"No watch JSON payload found in output:\n{output}")


def test_watch_once_json_is_machine_readable_and_secret_free(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)

    result = runner.invoke(zz_main.app, ["agent", "watch", "--once", "--format", "json"])

    assert result.exit_code == 0, result.output

    # Machine-readable contract.
    payload = _extract_json_payload(result.output)
    assert payload["heartbeat"]["agent_id"] == "agent-7"
    assert payload["heartbeat"]["pending_inbox_count"] == 2
    assert payload["items"][0]["task_id"] == "task-1"
    assert payload["items"][0]["orchestration_id"] == "orch-1"
    assert payload["acked"] == ["inb-1"]

    # No secret leakage: the agent key from config must never reach the payload.
    assert SECRET_KEY not in result.output
    assert "TOPSECRET" not in result.output
    # Sanity: the serialised payload itself carries no credentials.
    assert "api_key" not in json.dumps(payload).lower()


def test_submit_refuses_without_current_task(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)

    result = runner.invoke(zz_main.app, ["agent", "submit", "--result", "Done"])

    assert result.exit_code == 1
    assert "No running task" in result.output
    # The refusal message must guide the user, not just bare-error.
    assert "claim" in result.output.lower() or "--task" in result.output


def test_watch_requires_no_explicit_ids_after_join(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After join, watch works with neither --agent nor --project."""
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)

    result = runner.invoke(zz_main.app, ["agent", "watch", "--once", "--format", "json"])
    assert result.exit_code == 0, result.output
    payload = _extract_json_payload(result.output)
    assert payload["items"], "watch should surface the dispatched task without IDs"
