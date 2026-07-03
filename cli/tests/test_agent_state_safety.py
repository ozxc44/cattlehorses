"""Focused tests for local agent-state path safety.

Regression coverage for the path-traversal hole where a hostile task id such
as ``../escape`` could write a state file outside the ``agent-state`` directory.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest


def _state_module(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Import agent_state against an isolated ZZ_HOME so tests never touch the
    real ~/.zz directory."""
    monkeypatch.setenv("ZZ_HOME", str(tmp_path / "home"))
    # Force a fresh import bound to this ZZ_HOME.
    import importlib

    from zz_cli import agent_state

    importlib.reload(agent_state)
    return agent_state


def test_state_path_rejects_traversal(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    mod = _state_module(monkeypatch, tmp_path)
    state_dir = mod._get_agent_state_dir()

    for bad in ("../escape", "..", ".", "a/b", "a\\b", " /x", "ok\x00bad"):
        with pytest.raises(ValueError):
            mod._state_path(bad)

    # Legitimate ids resolve strictly inside the state directory.
    good = mod._state_path("task-1")
    assert os.path.dirname(good) == os.path.realpath(state_dir)
    assert good.endswith("task-1.json")


def test_write_task_state_does_not_escape(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A traversal task id must raise and never create a file outside agent-state."""
    mod = _state_module(monkeypatch, tmp_path)
    state_dir = Path(mod._get_agent_state_dir())

    # Sentinel located OUTSIDE the state directory; it must never be created.
    escape_target = tmp_path / "escape.json"
    assert not escape_target.exists()

    item = SimpleNamespace(
        task_id="../escape",
        project_id="proj-1",
        orchestration_id="orch-1",
        agent_id="agent-1",
        inbox_id="inbox-1",
        title="Evil",
        goal="pwn",
        status="dispatched",
        created_at=None,
    )

    with pytest.raises(ValueError):
        mod._write_task_state(item)

    # No file was written outside the state directory...
    assert not escape_target.exists()
    # ...and the state directory stayed empty.
    assert list(state_dir.glob("*.json")) == []


def test_write_task_state_roundtrip(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A normal task id writes inside agent-state and survives a read cycle."""
    mod = _state_module(monkeypatch, tmp_path)

    item = SimpleNamespace(
        task_id="task-42",
        project_id="proj-1",
        orchestration_id="orch-1",
        agent_id="agent-1",
        inbox_id="inbox-1",
        title="Work",
        goal="ship it",
        status="dispatched",
        created_at=None,
    )
    path = mod._write_task_state(item)
    assert os.path.dirname(path) == os.path.realpath(mod._get_agent_state_dir())

    loaded = mod._get_task_state("task-42")
    assert loaded is not None
    assert loaded["task_id"] == "task-42"
    assert loaded["project_id"] == "proj-1"

    # The on-disk filename is exactly the sanitized id, no traversal remnant.
    assert os.path.basename(path) == "task-42.json"


def test_update_task_state_safe_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """_update_task_state must also reject traversal ids."""
    mod = _state_module(monkeypatch, tmp_path)
    with pytest.raises(ValueError):
        mod._update_task_state("../../etc/passwd", {"status": "running"})
