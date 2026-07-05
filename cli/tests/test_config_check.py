"""Tests for the ``zz config-check`` worker setup validation command."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from zz_cli import main as zz_main


runner = CliRunner()
SECRET_KEY = "zzk_TOPSECRET_config_123"


@pytest.fixture
def isolated_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    home = tmp_path / ".zz"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("ZZ_HOME", str(home))
    monkeypatch.setenv("ZZ_IDENTITY_PATH", str(home / "identity.json"))
    monkeypatch.delenv("ZZ_BASE_URL", raising=False)
    monkeypatch.delenv("ZZ_AGENT_KEY", raising=False)
    monkeypatch.delenv("HANDLER_CMD", raising=False)
    monkeypatch.delenv("ZZ_HANDLER", raising=False)
    monkeypatch.delenv("ZZ_PROJECT_DIR", raising=False)
    return home


def _write_config(home: Path, **kwargs: Any) -> None:
    (home / "config.json").write_text(json.dumps(kwargs))


def test_config_check_all_pass(isolated_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_config(
        isolated_home,
        api_key=SECRET_KEY,
        base_url="http://platform.test/agent",
    )

    project_dir = isolated_home / "project"
    project_dir.mkdir()
    (project_dir / ".git").mkdir()

    def fake_project_dir(_override: str | None) -> tuple[bool, str, str]:
        return True, f"git repository ({project_dir / '.git'})", ""

    def fake_handler(_override: str | None) -> tuple[bool, str, str]:
        return True, "handler on PATH: kimi", ""

    def fake_executor(_base_url: str, _api_key: str | None) -> tuple[bool, str, str]:
        return True, "up-to-date (aabbccdd1234)", ""

    def fake_api_key(_base_url: str, _api_key: str | None) -> tuple[bool, str, str]:
        return True, "heartbeat accepted (agent=a1)", ""

    def fake_platform(_base_url: str) -> tuple[bool, str]:
        return True, "GET /v1/health HTTP 200, status=healthy"

    monkeypatch.setattr(zz_main, "_config_check_project_dir", fake_project_dir)
    monkeypatch.setattr(zz_main, "_config_check_handler", fake_handler)
    monkeypatch.setattr(zz_main, "_config_check_executor_up_to_date", fake_executor)
    monkeypatch.setattr(zz_main, "_config_check_api_key", fake_api_key)
    monkeypatch.setattr(zz_main, "_doctor_check_platform", fake_platform)

    result = runner.invoke(zz_main.app, ["config-check", "--project-dir", str(project_dir)])

    assert result.exit_code == 0, result.output
    assert "zz config-check" in result.output
    assert "Project directory (ZZ_PROJECT_DIR)" in result.output
    assert "Handler binary on PATH" in result.output
    assert "executor.py up-to-date" in result.output
    assert "API key valid" in result.output
    assert "Platform reachable" in result.output
    assert "Overall: all checks passed" in result.output
    assert SECRET_KEY not in result.output
    assert "TOPSECRET" not in result.output


def test_config_check_fails_when_any_check_fails(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_config(
        isolated_home,
        api_key=SECRET_KEY,
        base_url="http://platform.test/agent",
    )

    def fake_project_dir(_override: str | None) -> tuple[bool, str, str]:
        return True, "git repository", ""

    def fake_handler(_override: str | None) -> tuple[bool, str, str]:
        return False, "handler not on PATH: missing-bin", "Install missing-bin"

    def fake_executor(_base_url: str, _api_key: str | None) -> tuple[bool, str, str]:
        return True, "up-to-date", ""

    def fake_api_key(_base_url: str, _api_key: str | None) -> tuple[bool, str, str]:
        return True, "heartbeat accepted", ""

    def fake_platform(_base_url: str) -> tuple[bool, str]:
        return True, "GET /v1/health HTTP 200"

    monkeypatch.setattr(zz_main, "_config_check_project_dir", fake_project_dir)
    monkeypatch.setattr(zz_main, "_config_check_handler", fake_handler)
    monkeypatch.setattr(zz_main, "_config_check_executor_up_to_date", fake_executor)
    monkeypatch.setattr(zz_main, "_config_check_api_key", fake_api_key)
    monkeypatch.setattr(zz_main, "_doctor_check_platform", fake_platform)

    result = runner.invoke(zz_main.app, ["config-check"])

    assert result.exit_code == 1, result.output
    assert "Overall: one or more checks failed" in result.output
    output = "".join(result.output.split())
    assert "Install" in output
    assert "missing-bin" in output


def test_config_check_project_dir_validation(isolated_home: Path) -> None:
    """Project directory check detects missing env and non-git directories."""
    # Missing env
    ok, detail, hint = zz_main._config_check_project_dir(None)
    assert not ok
    assert "not set" in detail
    assert "export ZZ_PROJECT_DIR" in hint

    # Directory does not exist
    ok, detail, hint = zz_main._config_check_project_dir(str(isolated_home / "nope"))
    assert not ok
    assert "does not exist" in detail

    # Directory exists but is not a git repo
    bare_dir = isolated_home / "bare"
    bare_dir.mkdir()
    ok, detail, hint = zz_main._config_check_project_dir(str(bare_dir))
    assert not ok
    assert "not a git repository" in detail


def test_config_check_handler_validation(isolated_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Handler check respects override, env, config, and PATH lookup."""
    # Explicit override
    ok, detail, _ = zz_main._config_check_handler("python3")
    assert ok
    assert "python3" in detail

    # Env var
    monkeypatch.setenv("HANDLER_CMD", "python3")
    ok, detail, _ = zz_main._config_check_handler(None)
    assert ok
    assert "python3" in detail
    monkeypatch.delenv("HANDLER_CMD")

    # Config
    _write_config(isolated_home, handler="python3")
    ok, detail, _ = zz_main._config_check_handler(None)
    assert ok
    assert "python3" in detail

    # Missing handler and no known CLI on PATH
    _write_config(isolated_home)
    monkeypatch.setattr(zz_main.shutil, "which", lambda _name: None)
    ok, detail, hint = zz_main._config_check_handler(None)
    assert not ok
    assert "no handler configured" in detail
    assert "HANDLER_CMD" in hint


def test_config_check_api_key_without_credential(isolated_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_config(isolated_home, base_url="http://platform.test/agent")

    def fake_platform(_base_url: str) -> tuple[bool, str]:
        return True, "healthy"

    monkeypatch.setattr(zz_main, "_doctor_check_platform", fake_platform)
    monkeypatch.setattr(
        zz_main,
        "_config_check_project_dir",
        lambda _o: (True, "git", ""),
    )
    monkeypatch.setattr(
        zz_main,
        "_config_check_handler",
        lambda _o: (True, "handler", ""),
    )
    monkeypatch.setattr(
        zz_main,
        "_config_check_executor_up_to_date",
        lambda _b, _k: (True, "up-to-date", ""),
    )

    result = runner.invoke(zz_main.app, ["config-check"])

    assert result.exit_code == 1, result.output
    output = "".join(result.output.split())
    assert "noagent" in output
    assert "credential" in output
    assert "found" in output
    assert "Overall: one or more checks failed" in result.output
