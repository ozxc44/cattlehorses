"""Tests for the top-level ``zz doctor`` diagnostic command."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from zz_cli import main as zz_main


runner = CliRunner()
SECRET_KEY = "zzk_TOPSECRET_doctor_123"


@pytest.fixture
def isolated_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    home = tmp_path / ".zz"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("ZZ_HOME", str(home))
    monkeypatch.setenv("ZZ_IDENTITY_PATH", str(home / "identity.json"))
    monkeypatch.delenv("ZZ_BASE_URL", raising=False)
    monkeypatch.delenv("ZZ_AGENT_KEY", raising=False)
    return home


def test_doctor_reports_all_checks_healthy(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (isolated_home / "config.json").write_text(
        json.dumps({
            "api_key": SECRET_KEY,
            "base_url": "http://platform.test/agent",
            "default_project": "p1",
        })
    )

    def fake_http(
        method: str,
        base_url: str,
        path: str,
        *,
        api_key: str | None = None,
        body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        timeout: float = 8.0,
    ) -> tuple[int, Any]:
        assert base_url == "http://platform.test/agent"
        if path == "/v1/health":
            return 200, {"status": "healthy"}
        if path == "/v1/agent/projects":
            assert api_key == SECRET_KEY
            return 200, {
                "data": [
                    {
                        "project": {"id": "p1", "name": "Demo"},
                        "agent": {"id": "a1", "name": "worker", "capabilities": ["code", "docs"]},
                    }
                ]
            }
        if path == "/v1/agents/heartbeat":
            assert api_key == SECRET_KEY
            assert body == {}
            return 200, {
                "ok": True,
                "agent_id": "a1",
                "presence": "online",
                "is_online": True,
                "dispatchable": True,
            }
        if path == "/v1/projects/p1/orchestration-tasks":
            assert params and params["assigned_agent_id"] == "a1"
            return 200, {"data": [{"status": "approved"}, {"status": "approved"}]}
        raise AssertionError(f"unexpected doctor request: {method} {path}")

    monkeypatch.setattr(zz_main, "_doctor_http_json", fake_http)
    monkeypatch.setattr(
        zz_main,
        "_doctor_find_executor_processes",
        lambda: [("12345", "zz agent executor")],
    )

    result = runner.invoke(zz_main.app, ["doctor", "--project", "p1"])

    assert result.exit_code == 0, result.output
    assert "Platform connectivity" in result.output
    assert "Agent online status" in result.output
    assert "Executor running" in result.output
    assert "Capabilities set" in result.output
    assert "Recent task success rate" in result.output
    assert "2/2 approved (100%)" in result.output
    assert "Overall: healthy" in result.output
    assert SECRET_KEY not in result.output
    assert "TOPSECRET" not in result.output


def test_doctor_degrades_without_agent_credentials(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (isolated_home / "config.json").write_text(
        json.dumps({"base_url": "http://platform.test/agent"})
    )

    def fake_http(
        method: str,
        base_url: str,
        path: str,
        *,
        api_key: str | None = None,
        body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        timeout: float = 8.0,
    ) -> tuple[int, Any]:
        assert api_key is None
        assert path == "/v1/health"
        return 200, {"status": "healthy"}

    monkeypatch.setattr(zz_main, "_doctor_http_json", fake_http)
    monkeypatch.setattr(zz_main, "_doctor_find_executor_processes", lambda: [])

    result = runner.invoke(zz_main.app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "no agent credential found" in result.output
    assert "no zz agent executor process found" in result.output
    assert "Overall: degraded" in result.output
