"""Smoke tests for zz CLI main-agent publish commands."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

CLI_ROOT = Path(__file__).resolve().parent.parent
MAIN = CLI_ROOT / "zz_cli" / "main.py"


def _python_cmd() -> Path:
    """Path to the repo virtualenv interpreter (or $ZZ_PYTHON override)."""
    override = os.environ.get("ZZ_PYTHON")
    if override:
        return Path(override)
    return CLI_ROOT.parent / ".venv" / "bin" / "python"


def _run(argv: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(_python_cmd()), "-m", "zz_cli.main", *argv],
        cwd=CLI_ROOT,
        capture_output=True,
        text=True,
    )


def test_top_level_help() -> None:
    result = _run(["--help"])
    assert result.returncode == 0
    assert "orchestrations" in result.stdout
    assert "tasks" in result.stdout
    assert "changesets" in result.stdout


def test_orchestrations_help() -> None:
    result = _run(["orchestrations", "--help"])
    assert result.returncode == 0
    assert "create" in result.stdout
    assert "list" in result.stdout
    assert "get" in result.stdout
    assert "complete" in result.stdout


def test_tasks_help() -> None:
    result = _run(["tasks", "--help"])
    assert result.returncode == 0
    assert "create" in result.stdout
    assert "list" in result.stdout
    assert "get" in result.stdout
    assert "review" in result.stdout
    assert "claim" in result.stdout
    assert "complete" in result.stdout


def test_changesets_help() -> None:
    result = _run(["changesets", "--help"])
    assert result.returncode == 0
    assert "create" in result.stdout
    assert "list" in result.stdout
    assert "get" in result.stdout
    assert "review" in result.stdout
    assert "merge" in result.stdout
    assert "rebase" in result.stdout


def test_agent_help() -> None:
    result = _run(["agent", "--help"])
    assert result.returncode == 0
    assert "join" in result.stdout
    assert "claim-next" in result.stdout
    assert "submit" in result.stdout
    assert "state" in result.stdout
    assert "watch" in result.stdout


def test_agent_state_help() -> None:
    result = _run(["agent", "state", "--help"])
    assert result.returncode == 0
