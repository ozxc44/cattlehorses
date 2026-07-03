"""Tests for zz tasks review --notes / --requested-changes @file expansion."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from zz_cli import main as zz_main

runner = CliRunner()


class MockReviewTask:
    def __init__(self, task_id: str, status: str, review_notes: str | None = None):
        self.id = task_id
        self.status = status
        self.review_notes = review_notes


class MockClient:
    def __init__(self, **kwargs: Any) -> None:
        pass

    class orchestrations:
        @staticmethod
        def review_task(
            project_id: str,
            orchestration_id: str,
            task_id: str,
            decision: str,
            notes: str | None = None,
            requested_changes: str | None = None,
        ):
            return MockReviewTask(task_id, decision, review_notes=notes)


@pytest.fixture(autouse=True)
def _mock_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    monkeypatch.setattr(zz_main, "_get_client", lambda: MockClient())


def _invoke(argv: list[str]):
    return runner.invoke(zz_main.app, argv)


def test_review_inline_notes() -> None:
    """Plain inline string for --notes still works."""
    result = _invoke([
        "tasks", "review", "task-1",
        "--project", "p1",
        "--orchestration", "o1",
        "--decision", "approved",
        "--notes", "Looks good",
    ])
    assert result.exit_code == 0, result.output
    assert "approved" in result.output


def test_review_inline_requested_changes() -> None:
    """Plain inline string for --requested-changes still works."""
    result = _invoke([
        "tasks", "review", "task-2",
        "--project", "p1",
        "--orchestration", "o1",
        "--decision", "changes_requested",
        "--requested-changes", "Fix the bug",
    ])
    assert result.exit_code == 0, result.output
    assert "changes_requested" in result.output


def test_review_notes_at_file(tmp_path: Path) -> None:
    """--notes @file expands file contents."""
    review_file = tmp_path / "REVIEW.md"
    review_file.write_text("# Review\n\nAll checks passed.\n")

    result = _invoke([
        "tasks", "review", "task-3",
        "--project", "p1",
        "--orchestration", "o1",
        "--decision", "approved",
        "--notes", f"@{review_file}",
    ])
    assert result.exit_code == 0, result.output
    assert "approved" in result.output


def test_review_requested_changes_at_file(tmp_path: Path) -> None:
    """--requested-changes @file expands file contents."""
    changes_file = tmp_path / "changes.md"
    changes_file.write_text("## Changes\n\n- Fix typo\n- Add tests\n")

    result = _invoke([
        "tasks", "review", "task-4",
        "--project", "p1",
        "--orchestration", "o1",
        "--decision", "changes_requested",
        "--requested-changes", f"@{changes_file}",
    ])
    assert result.exit_code == 0, result.output
    assert "changes_requested" in result.output


def test_review_nonexistent_file_errors() -> None:
    """@nonexistent-file fails with a clear error and non-zero exit."""
    result = _invoke([
        "tasks", "review", "task-5",
        "--project", "p1",
        "--orchestration", "o1",
        "--decision", "approved",
        "--notes", "@/tmp/this_file_should_not_exist_ever_12345.md",
    ])
    assert result.exit_code != 0


def test_review_both_at_files(tmp_path: Path) -> None:
    """Both --notes and --requested-changes can use @file simultaneously."""
    notes_file = tmp_path / "notes.md"
    notes_file.write_text("LGTM")
    changes_file = tmp_path / "changes.md"
    changes_file.write_text("Minor nit")

    result = _invoke([
        "tasks", "review", "task-6",
        "--project", "p1",
        "--orchestration", "o1",
        "--decision", "changes_requested",
        "--notes", f"@{notes_file}",
        "--requested-changes", f"@{changes_file}",
    ])
    assert result.exit_code == 0, result.output
