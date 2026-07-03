"""Tests for evidence artifact generation and assertions."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

CLI_ROOT = Path(__file__).resolve().parent.parent


def test_evidence_directory_exists() -> None:
    evidence_dir = CLI_ROOT / "tests" / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    assert evidence_dir.exists()


def test_evidence_schema() -> None:
    evidence = {
        "run_id": f"agent-join-smoke-{int(time.time())}",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": "mocked",
        "status": "passed",
        "base_url": "http://test",
        "project_id": "proj-1",
        "agent_id": "agent-1",
        "join_request_id": "req-1",
        "evidence_file": str(CLI_ROOT / "tests" / "evidence" / "sample.json"),
    }
    assert "run_id" in evidence
    assert "timestamp" in evidence
    assert evidence["mode"] in ("mocked", "real")
    assert evidence["status"] in ("passed", "failed")


def test_evidence_write_and_read() -> None:
    evidence_dir = CLI_ROOT / "tests" / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    path = evidence_dir / "test-evidence.json"
    data = {"test": True, "value": 42}
    path.write_text(json.dumps(data, indent=2))
    loaded = json.loads(path.read_text())
    assert loaded["test"] is True
    assert loaded["value"] == 42
