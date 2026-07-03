"""Tests for zz agent deliver / progress command wiring.

Verifies the command parses args, reads local files, resolves the agent id via
heartbeat, and calls project_space.upsert_file with the correct deliverables/
path. Uses a mocked ZZClient so no live backend is required.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest import mock

import pytest
from typer.testing import CliRunner

# Ensure cli package importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

runner = CliRunner()


def _make_record(ns):
    """Build a simple record-like object from a namespace dict."""
    return mock.Mock(**ns)


def test_deliver_reads_local_file_and_upserts_under_deliverables(tmp_path):
    from zz_cli.main import app

    local = tmp_path / "report.md"
    local.write_text("# Report\n\nbody", encoding="utf-8")

    captured = {}

    fake_client = mock.Mock()
    fake_client.agent.heartbeat.return_value = _make_record({"agent_id": "agent-123"})
    fake_client.project_space.upsert_file.side_effect = lambda **kw: captured.update(kw) or _make_record({"id": "file-1"})

    with mock.patch("zz_cli.main._get_agent_client", return_value=fake_client), \
         mock.patch("zz_cli.main._resolve_agent_id", return_value="agent-123"):
        result = runner.invoke(app, [
            "agent", "deliver", str(local),
            "--project", "proj-1",
        ], env={"ZZ_BASE_URL": "http://x/agent"})

    assert result.exit_code == 0, result.output
    fake_client.project_space.upsert_file.assert_called_once()
    assert captured["project_id"] == "proj-1"
    assert captured["path"] == "deliverables/agent-123/report.md"
    assert "body" in captured["content"]


def test_deliver_missing_file_errors(tmp_path):
    from zz_cli.main import app

    fake_client = mock.Mock()
    with mock.patch("zz_cli.main._get_agent_client", return_value=fake_client):
        result = runner.invoke(app, [
            "agent", "deliver", str(tmp_path / "nope.md"),
            "--project", "proj-1",
        ], env={"ZZ_BASE_URL": "http://x/agent"})

    assert result.exit_code == 1
    assert "File not found" in result.output
    fake_client.project_space.upsert_file.assert_not_called()


def test_progress_appends_to_existing(tmp_path):
    from zz_cli.main import app

    fake_client = mock.Mock()
    fake_client.agent.heartbeat.return_value = _make_record({"agent_id": "agent-9"})
    # Existing PROGRESS.md content returned by list_files
    existing = mock.Mock()
    existing.content = "# Progress: task-1\n\n## 2026-01-01\n\nfirst"
    fake_client.project_space.list_files.return_value = [existing]
    captured = {}

    def upsert(**kw):
        captured.update(kw)
        return mock.Mock()

    fake_client.project_space.upsert_file.side_effect = upsert

    with mock.patch("zz_cli.main._get_agent_client", return_value=fake_client), \
         mock.patch("zz_cli.main._resolve_agent_id", return_value="agent-9"):
        result = runner.invoke(app, [
            "agent", "progress", "task-1",
            "--note", "second step done",
            "--project", "proj-2",
        ], env={"ZZ_BASE_URL": "http://x/agent"})

    assert result.exit_code == 0, result.output
    assert captured["path"] == "deliverables/agent-9/task-1/PROGRESS.md"
    # New content must contain BOTH the old entry and the new note
    assert "first" in captured["content"]
    assert "second step done" in captured["content"]


def test_progress_creates_when_no_existing(tmp_path):
    from zz_cli.main import app

    fake_client = mock.Mock()
    fake_client.agent.heartbeat.return_value = _make_record({"agent_id": "agent-7"})
    fake_client.project_space.list_files.return_value = []  # no existing
    captured = {}

    def upsert(**kw):
        captured.update(kw)
        return mock.Mock()

    fake_client.project_space.upsert_file.side_effect = upsert

    with mock.patch("zz_cli.main._get_agent_client", return_value=fake_client), \
         mock.patch("zz_cli.main._resolve_agent_id", return_value="agent-7"):
        result = runner.invoke(app, [
            "agent", "progress", "task-x",
            "--note", "initial",
            "--project", "proj-3",
        ], env={"ZZ_BASE_URL": "http://x/agent"})

    assert result.exit_code == 0, result.output
    assert captured["path"] == "deliverables/agent-7/task-x/PROGRESS.md"
    assert "initial" in captured["content"]
    assert captured["content"].startswith("# Progress: task-x")
