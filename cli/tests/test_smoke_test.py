"""Tests for the worker handler smoke test (R10a).

Covers ``ExecutorDaemon.run_smoke_test`` and the ``zz agent smoke-test`` /
``zz agents smoke-test`` CLI commands. The handler subprocess is mocked so no
real external command runs.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from zz_cli import executor as executor_mod
from zz_cli import main as zz_main
from zz_cli.executor import ExecutorDaemon

runner = CliRunner()


# ─── helpers ───────────────────────────────────────────────────────────────────

def _new_daemon(handler: str = "fake-handler", **kwargs: Any) -> ExecutorDaemon:
    """Build a daemon that makes no real network calls."""
    return ExecutorDaemon(
        base_url="http://localhost",
        api_key="test-key",
        handler_cmd=handler,
        no_self_update=True,
        **kwargs,
    )


def _extract_smoke_path(goal: str) -> str | None:
    """Pull the temp file path out of a smoke-test task goal."""
    m = re.search(r"create file (\S+) with content", goal)
    return m.group(1) if m else None


def _make_cooperative_run(
    content: str = "ok",
    write_file: bool = True,
    stdout: str = '{"result_md":"done"}',
):
    """Return a fake subprocess.run that simulates a cooperative handler.

    The handler reads the task JSON on stdin, creates the requested temp file
    with the requested content, and prints a result JSON on stdout — exactly
    what a real handler bridge would do.
    """

    def fake_run(cmd, *args, **kwargs):
        task_json = kwargs.get("input") or (args[0] if args else "")
        try:
            ctx = json.loads(task_json)
        except Exception:
            ctx = {}
        if write_file:
            path = _extract_smoke_path(ctx.get("goal", ""))
            if path:
                with open(path, "w") as f:
                    f.write(content)
        return subprocess.CompletedProcess(
            args=cmd, returncode=0, stdout=stdout, stderr=""
        )

    return fake_run


# ─── run_smoke_test: happy path ────────────────────────────────────────────────

def test_smoke_test_healthy(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    daemon = _new_daemon()
    monkeypatch.setattr(executor_mod.subprocess, "run", _make_cooperative_run())

    result = daemon.run_smoke_test(working_copy=str(tmp_path))

    assert result["healthy"] is True
    assert result["last_error"] is None
    assert isinstance(result["duration_ms"], int)
    assert result["duration_ms"] >= 0


def test_smoke_test_invokes_same_handler_cmd(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The smoke test must go through the configured handler_cmd, not some other path."""
    daemon = _new_daemon(handler="my-special-handler")
    captured: dict[str, Any] = {}

    def fake_run(cmd, *args, **kwargs):
        captured["cmd"] = cmd
        captured["input"] = kwargs.get("input")
        ctx = json.loads(kwargs.get("input") or "{}")
        path = _extract_smoke_path(ctx.get("goal", ""))
        if path:
            Path(path).write_text("ok")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout='{"result_md":"done"}', stderr="")

    monkeypatch.setattr(executor_mod.subprocess, "run", fake_run)

    daemon.run_smoke_test(working_copy=str(tmp_path))

    assert captured["cmd"] == "my-special-handler"
    # The minimal task JSON carries title=smoke and the file-creation goal.
    ctx = json.loads(captured["input"])
    assert ctx["title"] == "smoke"
    assert "create file" in ctx["goal"]
    assert "with content ok" in ctx["goal"]


def test_smoke_test_cleans_up_temp_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    daemon = _new_daemon()

    created_paths: list[str] = []

    def fake_run(cmd, *args, **kwargs):
        ctx = json.loads(kwargs.get("input") or "{}")
        path = _extract_smoke_path(ctx.get("goal", ""))
        if path:
            Path(path).write_text("ok")
            created_paths.append(path)
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout='{"result_md":"done"}', stderr="")

    monkeypatch.setattr(executor_mod.subprocess, "run", fake_run)

    daemon.run_smoke_test(working_copy=str(tmp_path))

    # The temp file was created during the test and removed afterwards.
    assert created_paths, "smoke test never created a temp file"
    leftover = [p for p in created_paths if Path(p).exists()]
    assert not leftover, f"temp file not cleaned up: {leftover}"


# ─── run_smoke_test: failure modes ─────────────────────────────────────────────

def test_smoke_test_no_handler_configured(tmp_path: Path) -> None:
    daemon = _new_daemon(handler="")
    result = daemon.run_smoke_test(working_copy=str(tmp_path))

    assert result["healthy"] is False
    assert result["last_error"] is not None
    assert "no handler" in result["last_error"].lower()


def test_smoke_test_handler_not_found(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    daemon = _new_daemon()

    def fake_run(cmd, *args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "bad-handler")

    monkeypatch.setattr(executor_mod.subprocess, "run", fake_run)

    result = daemon.run_smoke_test(working_copy=str(tmp_path))

    assert result["healthy"] is False
    assert result["last_error"] is not None
    assert "not found" in result["last_error"].lower()


def test_smoke_test_handler_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    daemon = _new_daemon()

    def fake_run(cmd, *args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=300)

    monkeypatch.setattr(executor_mod.subprocess, "run", fake_run)

    result = daemon.run_smoke_test(working_copy=str(tmp_path))

    assert result["healthy"] is False
    assert result["last_error"] is not None
    assert "timed out" in result["last_error"].lower()


def test_smoke_test_permission_denied(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    daemon = _new_daemon()

    def fake_run(cmd, *args, **kwargs):
        raise PermissionError(13, "Permission denied", cmd)

    monkeypatch.setattr(executor_mod.subprocess, "run", fake_run)

    result = daemon.run_smoke_test(working_copy=str(tmp_path))

    assert result["healthy"] is False
    assert result["last_error"] is not None
    assert "permission denied" in result["last_error"].lower()


def test_smoke_test_empty_handler_output(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A handler that prints nothing (e.g. shell 'command not found') is unhealthy."""
    daemon = _new_daemon()

    def fake_run(cmd, *args, **kwargs):
        return subprocess.CompletedProcess(
            args=cmd, returncode=127, stdout="", stderr="sh: fake-handler: command not found"
        )

    monkeypatch.setattr(executor_mod.subprocess, "run", fake_run)

    result = daemon.run_smoke_test(working_copy=str(tmp_path))

    assert result["healthy"] is False
    assert result["last_error"] is not None
    assert "no output" in result["last_error"].lower()


def test_smoke_test_file_not_created(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Handler returned output but never created the temp file."""
    daemon = _new_daemon()
    monkeypatch.setattr(
        executor_mod.subprocess, "run", _make_cooperative_run(write_file=False)
    )

    result = daemon.run_smoke_test(working_copy=str(tmp_path))

    assert result["healthy"] is False
    assert result["last_error"] is not None
    assert "did not create" in result["last_error"].lower()


def test_smoke_test_content_mismatch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Temp file created but with the wrong content."""
    daemon = _new_daemon()
    monkeypatch.setattr(
        executor_mod.subprocess, "run", _make_cooperative_run(content="wrong")
    )

    result = daemon.run_smoke_test(working_copy=str(tmp_path))

    assert result["healthy"] is False
    assert result["last_error"] is not None
    assert "mismatch" in result["last_error"].lower()


# ─── heartbeat health reporting ────────────────────────────────────────────────

def test_heartbeat_reports_healthy_after_smoke(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    daemon = _new_daemon()
    monkeypatch.setattr(executor_mod.subprocess, "run", _make_cooperative_run())

    daemon._maybe_run_periodic_smoke(force=True)  # populates last_smoke_result

    captured: dict[str, Any] = {}
    daemon.api = lambda method, path, body=None: captured.update({"body": body}) or {
        "agent_id": "a1", "pending_inbox_count": 0,
    }
    daemon.heartbeat()

    assert "health" in captured["body"]
    assert captured["body"]["health"]["status"] == "healthy"
    assert captured["body"]["health"]["error"] == ""


def test_heartbeat_reports_unhealthy_after_failed_smoke(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    daemon = _new_daemon()

    def fake_run(cmd, *args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "bad-handler")

    monkeypatch.setattr(executor_mod.subprocess, "run", fake_run)

    daemon.project_id = "p1"
    daemon._maybe_run_periodic_smoke(force=True)

    captured: dict[str, Any] = {}
    daemon.api = lambda method, path, body=None: captured.update({"body": body}) or {
        "agent_id": "a1", "pending_inbox_count": 0,
    }
    daemon.heartbeat()

    assert captured["body"]["health"]["status"] == "unhealthy"
    assert "not found" in captured["body"]["health"]["error"].lower()


def test_heartbeat_omits_health_without_smoke() -> None:
    """No smoke test run yet → no health field (legacy/endpoint workers keep dispatch open)."""
    daemon = _new_daemon(handler="")  # no handler → smoke test never runs
    assert daemon.last_smoke_result is None

    captured: dict[str, Any] = {}
    daemon.api = lambda method, path, body=None: captured.update({"body": body}) or {
        "agent_id": "a1", "pending_inbox_count": 0,
    }
    daemon.heartbeat()

    assert "health" not in captured["body"]


# ─── config: ZZ_SMOKE_TEST_INTERVAL ────────────────────────────────────────────

def test_smoke_interval_default() -> None:
    daemon = _new_daemon()
    assert daemon.smoke_interval == 10


def test_smoke_interval_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ZZ_SMOKE_TEST_INTERVAL", "3")
    daemon = _new_daemon()
    assert daemon.smoke_interval == 3


def test_smoke_interval_invalid_env_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ZZ_SMOKE_TEST_INTERVAL", "not-a-number")
    daemon = _new_daemon()
    assert daemon.smoke_interval == 10


# ─── CLI commands ──────────────────────────────────────────────────────────────

@pytest.fixture
def isolated_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Isolate CLI config so the smoke-test command makes no real network calls."""
    home = tmp_path / ".zz"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("ZZ_HOME", str(home))
    monkeypatch.setenv("ZZ_IDENTITY_PATH", str(home / "identity.json"))
    monkeypatch.delenv("ZZ_BASE_URL", raising=False)
    monkeypatch.delenv("ZZ_AGENT_KEY", raising=False)
    return home


def test_cli_agent_smoke_test_healthy(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(executor_mod.subprocess, "run", _make_cooperative_run())

    result = runner.invoke(
        zz_main.app,
        ["agent", "smoke-test", "--handler", "fake-handler", "-w", str(tmp_path)],
    )

    assert result.exit_code == 0, result.output
    assert "healthy" in result.output
    assert "True" in result.output


def test_cli_agent_smoke_test_unhealthy_exit_code(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def fake_run(cmd, *args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "bad-handler")

    monkeypatch.setattr(executor_mod.subprocess, "run", fake_run)

    result = runner.invoke(
        zz_main.app,
        ["agent", "smoke-test", "--handler", "bad-handler", "-w", str(tmp_path)],
    )

    assert result.exit_code == 1, result.output
    assert "UNHEALTHY" in result.output
    assert "not found" in result.output.lower()


def test_cli_agents_smoke_test_alias(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The plural `zz agents smoke-test` form works too (task spec spelling)."""
    monkeypatch.setattr(executor_mod.subprocess, "run", _make_cooperative_run())

    result = runner.invoke(
        zz_main.app,
        ["agents", "smoke-test", "--handler", "fake-handler", "-w", str(tmp_path)],
    )

    assert result.exit_code == 0, result.output
    assert "healthy" in result.output


def test_cli_smoke_test_no_handler(
    isolated_home: Path, tmp_path: Path
) -> None:
    result = runner.invoke(
        zz_main.app,
        ["agent", "smoke-test", "-w", str(tmp_path)],
    )

    assert result.exit_code == 1, result.output
    assert "no handler" in result.output.lower()
