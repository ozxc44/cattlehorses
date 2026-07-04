"""Tests for the empty-output guard in process_worker_task.

Verifies that:
  (i)   short stdout + changeset submitted  → ready_for_review (not blocked)
  (ii)  short stdout + no changeset         → blocked
  (iii) long  stdout + no changeset         → ready_for_review
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _make_executor():
    """Create a minimal executor instance with mocked API + methods."""
    from zz_cli.executor import ExecutorDaemon

    executor = ExecutorDaemon.__new__(ExecutorDaemon)
    executor.project_id = "proj-1"
    executor.handler_cmd = "mock-handler"
    executor.agent_endpoint = None
    executor.manual = False
    executor.llm = None
    executor._api_calls = []

    def fake_api(method, path, body=None):
        executor._api_calls.append((method, path, body))
        return {"status": "ok"}

    executor.api = fake_api
    executor.ack_inbox = mock.Mock()
    executor.claim_task = mock.Mock(return_value={"id": "claim-1"})
    executor.get_task = mock.Mock(return_value={
        "id": "tid-1",
        "title": "Test task",
        "goal": "Do something",
        "acceptance_criteria": [],
    })
    executor._lay_out_task = mock.Mock()
    executor.get_code_map = mock.Mock(return_value="")
    executor.sync_base = mock.Mock(return_value={})
    executor._heal_evidence = lambda e=None, force=False: e or {}
    return executor


def test_short_stdout_with_changeset_is_not_blocked():
    """(i) short stdout + changeset submitted → ready_for_review."""
    executor = _make_executor()
    executor.execute_task = mock.Mock(return_value={
        "result_md": "done",  # < 50 chars
        "evidence": {},
    })
    executor.detect_code_changes = mock.Mock(return_value=[
        {"path": "foo.py", "op": "upsert", "content": "x = 1\n"},
    ])
    executor.submit_code_changeset = mock.Mock(return_value="cs-abc123")
    executor.submit_task = mock.Mock(return_value={"status": "ready_for_review"})

    result = executor.process_worker_task(
        {"id": "inbox-1", "event_type": "task_dispatched"},
        pid="proj-1", oid="orch-1", tid="tid-1",
    )

    assert result is True
    executor.detect_code_changes.assert_called_once()
    executor.submit_code_changeset.assert_called_once_with(
        "proj-1", "orch-1", "tid-1",
        [{"path": "foo.py", "op": "upsert", "content": "x = 1\n"}],
    )
    executor.submit_task.assert_called_once()
    # Must NOT have called blocked-submit
    blocked_calls = [c for c in executor._api_calls if c[1].endswith("/complete") and c[2] and c[2].get("status") == "blocked"]
    assert len(blocked_calls) == 0


def test_short_stdout_without_changeset_is_blocked():
    """(ii) short stdout + no changeset → blocked."""
    executor = _make_executor()
    executor.execute_task = mock.Mock(return_value={
        "result_md": "done",  # < 50 chars
        "evidence": {},
    })
    executor.detect_code_changes = mock.Mock(return_value=[])
    executor.submit_code_changeset = mock.Mock()
    executor.submit_task = mock.Mock()

    result = executor.process_worker_task(
        {"id": "inbox-2", "event_type": "task_dispatched"},
        pid="proj-1", oid="orch-1", tid="tid-1",
    )

    assert result is True
    executor.detect_code_changes.assert_called_once()
    executor.submit_code_changeset.assert_not_called()
    executor.submit_task.assert_not_called()
    blocked_calls = [c for c in executor._api_calls if c[1].endswith("/complete") and c[2] and c[2].get("status") == "blocked"]
    assert len(blocked_calls) == 1


def test_long_stdout_without_changeset_is_ready_for_review():
    """(iii) long stdout + no changeset → ready_for_review."""
    executor = _make_executor()
    long_output = "x" * 100  # >= 50 chars
    executor.execute_task = mock.Mock(return_value={
        "result_md": long_output,
        "evidence": {},
    })
    executor.detect_code_changes = mock.Mock(return_value=[])
    executor.submit_code_changeset = mock.Mock()
    executor.submit_task = mock.Mock(return_value={"status": "ready_for_review"})

    result = executor.process_worker_task(
        {"id": "inbox-3", "event_type": "task_dispatched"},
        pid="proj-1", oid="orch-1", tid="tid-1",
    )

    assert result is True
    executor.detect_code_changes.assert_called_once()
    executor.submit_code_changeset.assert_not_called()
    executor.submit_task.assert_called_once()
    blocked_calls = [c for c in executor._api_calls if c[1].endswith("/complete") and c[2] and c[2].get("status") == "blocked"]
    assert len(blocked_calls) == 0
