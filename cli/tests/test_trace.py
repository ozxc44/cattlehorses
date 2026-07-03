"""Tests for ``zz trace show`` and ``zz trace task`` commands.

Mocked mode (default): seeds mock project-space files and mocks ZZClient.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from zz_cli import main as zz_main

runner = CliRunner()

# ── Mock file storage (module-level, survives class re-import) ────────────
_TRACE_MOCK_FILES: list[tuple[str, str, str]] = []  # (file_id, path, content)
_TRACE_MOCK_COUNTER = 0


def _trace_reset() -> None:
    """Clear all mock files and reset the ID counter."""
    global _TRACE_MOCK_FILES, _TRACE_MOCK_COUNTER
    _TRACE_MOCK_FILES.clear()
    _TRACE_MOCK_COUNTER = 0


def _trace_add_file(path: str, content: str) -> str:
    """Add a file to the mock store and return its auto-generated file_id."""
    global _TRACE_MOCK_FILES, _TRACE_MOCK_COUNTER
    _TRACE_MOCK_COUNTER += 1
    fid = f"mock-file-{_TRACE_MOCK_COUNTER}"
    _TRACE_MOCK_FILES.append((fid, path, content))
    return fid


class _MockOrch:
    """Minimal stand-in for the SDK's Orchestration model."""

    def __init__(self, orchestration_id: str) -> None:
        self.id = orchestration_id
        self.base_path = f"orch/{orchestration_id}"


class _TraceMockClient:
    """Mock ZZClient for trace command tests.

    Uses the module-level ``_TRACE_MOCK_FILES`` list as its backing store.
    Callers seed data via ``_trace_add_file`` before invoking the CLI.
    """

    def __init__(self, **kwargs: Any) -> None:
        pass

    class orchestrations:
        @staticmethod
        def get(project_id: str, orchestration_id: str) -> _MockOrch:
            return _MockOrch(orchestration_id)

    class project_space:
        @staticmethod
        def list_files(
            project_id: str, path_prefix: str | None = None
        ) -> list[Any]:
            results: list[Any] = []
            for fid, fpath, content in _TRACE_MOCK_FILES:
                if path_prefix is not None and not fpath.startswith(path_prefix):
                    continue

                class MockSummary:
                    pass

                s = MockSummary()
                s.id = fid
                s.path = fpath
                results.append(s)
            return results

        @staticmethod
        def get_file(project_id: str, file_id: str) -> Any:
            for fid, fpath, content in _TRACE_MOCK_FILES:
                if fid == file_id:

                    class MockFile:
                        pass

                    f = MockFile()
                    f.id = fid
                    f.path = fpath
                    f.content = content
                    return f
            raise RuntimeError(f"Mock file {file_id!r} not found in store")


# ── Fixtures and helpers ─────────────────────────────────────────────────


def _write_config(home: Path, api_key: str = "zzk_test_key") -> Path:
    config_path = home / "config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"api_key": api_key, "base_url": "http://test"}))
    return config_path


def _invoke(argv: list[str]) -> Any:
    return runner.invoke(zz_main.app, argv)


@pytest.fixture
def tmp_config_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    home = tmp_path / ".zz"
    monkeypatch.setenv("ZZ_HOME", str(home))
    monkeypatch.setenv("ZZ_IDENTITY_PATH", str(home / "identity.json"))
    return home


# ══════════════════════════════════════════════════════════════════════════
#  trace show
# ══════════════════════════════════════════════════════════════════════════


def test_trace_show_renders_table_and_trace(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """trace show renders a task table with artifact checkmarks + TRACE.md."""
    monkeypatch.setattr(zz_main, "ZZClient", _TraceMockClient)
    _write_config(tmp_config_home)
    _trace_reset()

    base_path = "orch/o1"
    tasks = [
        {"id": "t1", "title": "Task one", "status": "pending", "assigned_agent_id": None},
        {"id": "t2", "title": "Task two", "status": "ready_for_review", "assigned_agent_id": "agent-7"},
    ]
    _trace_add_file(f"{base_path}/tasks.json", json.dumps(tasks))
    _trace_add_file(f"{base_path}/TRACE.md", "# Trace\n\nEverything went well.")
    _trace_add_file(f"{base_path}/tasks/t1/TASK.md", "# Task one spec")
    _trace_add_file(f"{base_path}/tasks/t2/TASK.md", "# Task two spec")
    _trace_add_file(f"{base_path}/tasks/t2/RESULT.md", "## Result\nAll done.")
    _trace_add_file(f"{base_path}/tasks/t2/EVIDENCE.md", '{"passed": true}')

    result = _invoke(["trace", "show", "--project", "p1", "--orchestration", "o1"])

    assert result.exit_code == 0, result.output
    # Table content
    assert "Task one" in result.output
    assert "Task two" in result.output
    # Trace content
    assert "Everything went well." in result.output
    # Checkmarks — t2 has more artifacts than t1
    assert "✓" in result.output


def test_trace_show_no_trace_file(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """trace show handles missing TRACE.md gracefully."""
    monkeypatch.setattr(zz_main, "ZZClient", _TraceMockClient)
    _write_config(tmp_config_home)
    _trace_reset()

    tasks = [{"id": "t1", "title": "Only task", "status": "running", "assigned_agent_id": "agent-1"}]
    _trace_add_file("orch/o2/tasks.json", json.dumps(tasks))
    # No TRACE.md added

    result = _invoke(["trace", "show", "--project", "p1", "--orchestration", "o2"])

    assert result.exit_code == 0, result.output
    assert "Only task" in result.output
    assert "TRACE.md not found" in result.output


def test_trace_show_no_tasks_json(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """trace show handles missing tasks.json gracefully."""
    monkeypatch.setattr(zz_main, "ZZClient", _TraceMockClient)
    _write_config(tmp_config_home)
    _trace_reset()

    _trace_add_file("orch/o3/TRACE.md", "# Just a trace")

    result = _invoke(["trace", "show", "--project", "p1", "--orchestration", "o3"])

    assert result.exit_code == 0, result.output
    assert "tasks.json not found" in result.output
    assert "# Just a trace" in result.output


def test_trace_show_empty_tasks_json(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """trace show handles an empty tasks.json."""
    monkeypatch.setattr(zz_main, "ZZClient", _TraceMockClient)
    _write_config(tmp_config_home)
    _trace_reset()

    _trace_add_file("orch/o4/tasks.json", "")
    _trace_add_file("orch/o4/TRACE.md", "Trace content")

    result = _invoke(["trace", "show", "--project", "p1", "--orchestration", "o4"])

    assert result.exit_code == 0, result.output
    assert "Trace content" in result.output


# ══════════════════════════════════════════════════════════════════════════
#  trace task
# ══════════════════════════════════════════════════════════════════════════


def test_trace_task_renders_existing_artifacts(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """trace task renders existing and marks missing artifacts."""
    monkeypatch.setattr(zz_main, "ZZClient", _TraceMockClient)
    _write_config(tmp_config_home)
    _trace_reset()

    _trace_add_file("orch/o5/tasks/t99/TASK.md", "# Build the thing")
    _trace_add_file("orch/o5/tasks/t99/RESULT.md", "Done.")
    # EVIDENCE.md, REVIEW.md, CHANGELOG.md intentionally missing

    result = _invoke(["trace", "task", "--project", "p1", "--orchestration", "o5", "--task", "t99"])

    assert result.exit_code == 0, result.output
    assert "# Build the thing" in result.output
    assert "Done." in result.output
    # Missing ones are marked
    assert result.output.count("not found") >= 3  # EVIDENCE, REVIEW, CHANGELOG


def test_trace_task_all_missing(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """trace task reports no artifacts when none exist."""
    monkeypatch.setattr(zz_main, "ZZClient", _TraceMockClient)
    _write_config(tmp_config_home)
    _trace_reset()

    result = _invoke(["trace", "task", "--project", "p1", "--orchestration", "o6", "--task", "ghost"])

    assert result.exit_code == 0, result.output
    assert "No artifacts found" in result.output
    assert result.output.count("not found") == 5  # all five artifact slots


def test_trace_task_shows_all_five_artifacts(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """trace task shows all 5 artifacts when they all exist."""
    monkeypatch.setattr(zz_main, "ZZClient", _TraceMockClient)
    _write_config(tmp_config_home)
    _trace_reset()

    _trace_add_file("orch/o7/tasks/t1/TASK.md", "# Task")
    _trace_add_file("orch/o7/tasks/t1/RESULT.md", "## Result")
    _trace_add_file("orch/o7/tasks/t1/EVIDENCE.md", '{"ok": true}')
    _trace_add_file("orch/o7/tasks/t1/REVIEW.md", "## Review\nApproved.")
    _trace_add_file("orch/o7/tasks/t1/CHANGELOG.md", "## Changelog\n- Fixed.")

    result = _invoke(["trace", "task", "--project", "p1", "--orchestration", "o7", "--task", "t1"])

    assert result.exit_code == 0, result.output
    assert "# Task" in result.output
    assert "## Result" in result.output
    assert "Approved." in result.output
    assert "Changelog" in result.output
    assert "not found" not in result.output  # All present


# ══════════════════════════════════════════════════════════════════════════
#  Integration
# ══════════════════════════════════════════════════════════════════════════


def test_trace_group_in_help(tmp_config_home: Path) -> None:
    """zz --help shows the trace group."""
    _write_config(tmp_config_home)
    result = _invoke(["--help"])
    assert result.exit_code == 0, result.output
    assert "trace" in result.output
