"""Tests for the Codex worker handler (R21a).

The handler reads a task JSON on stdin, builds a prompt, shells out to the
local codex CLI with the prompt piped via stdin (``codex exec ... -``), and
prints ``{"content": "<codex stdout>"}``. The codex binary is mocked via
``subprocess.run`` so no real subprocess runs.

These tests mirror the mocking style of test_smoke_test.py (R10a).
"""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
from pathlib import Path

import pytest

HANDLER_PATH = (
    Path(__file__).resolve().parents[2]
    / "deploy"
    / "nas"
    / "agent-executors"
    / "codex-worker-handler.py"
)


@pytest.fixture(scope="module")
def handler():
    """Load the standalone handler script as an importable module."""
    assert HANDLER_PATH.exists(), f"handler not found at {HANDLER_PATH}"
    spec = importlib.util.spec_from_file_location("codex_worker_handler", HANDLER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _feed_stdin(monkeypatch: pytest.MonkeyPatch, payload: object) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))


# ─── build_prompt ──────────────────────────────────────────────────────────────


def test_build_prompt_carries_task_context(handler) -> None:
    prompt = handler.build_prompt(
        {
            "title": "R21a: codex worker handler",
            "goal": "Create the codex worker handler.",
            "acceptance_criteria": ["returns content", "prompt via stdin"],
            "project_id": "zz-cli",
            "code_map": "deploy/nas/agent-executors/codex-worker-handler.py",
        }
    )
    assert "codex worker handler" in prompt
    assert "Create the codex worker handler." in prompt
    assert "zz-cli" in prompt
    assert "- returns content" in prompt
    assert "- prompt via stdin" in prompt
    assert "codex-worker-handler.py" in prompt


def test_build_prompt_omits_empty_sections(handler) -> None:
    prompt = handler.build_prompt({"title": "t", "goal": "g"})
    # No criteria/code_map → neither block header is emitted. (Note: the fixed
    # 工作要求 line "严格满足验收标准。" always contains 验收标准, so we check the
    # block header "验收标准:" with its colon instead.)
    assert "验收标准:" not in prompt
    assert "代码地图(摘要)" not in prompt
    assert "g" in prompt


# ─── happy path ────────────────────────────────────────────────────────────────


def test_handler_returns_codex_stdout_as_content(
    handler, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    _feed_stdin(monkeypatch, {"title": "t", "goal": "do the work"})

    def fake_run(cmd, *args, **kwargs):
        return subprocess.CompletedProcess(
            args=cmd, returncode=0, stdout="## Result\nall done", stderr=""
        )

    monkeypatch.setattr(handler.subprocess, "run", fake_run)
    rc = handler.main()

    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["content"] == "## Result\nall done"


def test_handler_pipes_prompt_via_stdin(
    handler, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """The prompt must reach codex through subprocess stdin, not an argv slot."""
    _feed_stdin(monkeypatch, {"title": "t", "goal": "prompt-from-stdin-please"})
    seen: dict = {}

    def fake_run(cmd, *args, **kwargs):
        seen["cmd"] = list(cmd)
        seen["input"] = kwargs.get("input")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(handler.subprocess, "run", fake_run)
    handler.main()

    # `codex exec ... -` — the trailing "-" reads the prompt from stdin.
    assert seen["cmd"][1] == "exec"
    assert seen["cmd"][-1] == "-"
    # The prompt was carried as the subprocess stdin, never as an argv element.
    assert seen["input"] and "prompt-from-stdin-please" in seen["input"]
    assert all("prompt-from-stdin-please" not in str(c) for c in seen["cmd"])


def test_handler_runs_inside_workspace_with_bypass_flags(
    handler, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    _feed_stdin(monkeypatch, {"title": "t", "goal": "g"})
    seen: dict = {}

    def fake_run(cmd, *args, **kwargs):
        seen["cmd"] = list(cmd)
        seen["cwd"] = kwargs.get("cwd")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(handler.subprocess, "run", fake_run)
    handler.main()

    assert "--dangerously-bypass-approvals-and-sandbox" in seen["cmd"]
    assert "--dangerously-bypass-hook-trust" in seen["cmd"]
    assert "--cd" in seen["cmd"]
    assert seen["cwd"], "codex must be launched inside the workspace"


# ─── failure modes ─────────────────────────────────────────────────────────────


def test_handler_empty_stdout_falls_back_to_stderr(
    handler, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    _feed_stdin(monkeypatch, {"title": "t", "goal": "g"})

    def fake_run(cmd, *args, **kwargs):
        return subprocess.CompletedProcess(
            args=cmd, returncode=1, stdout="", stderr="boom: model unavailable"
        )

    monkeypatch.setattr(handler.subprocess, "run", fake_run)
    handler.main()

    out = json.loads(capsys.readouterr().out)
    assert "no output" in out["content"].lower()
    assert "boom: model unavailable" in out["content"]


def test_handler_codex_binary_missing(
    handler, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    _feed_stdin(monkeypatch, {"title": "t", "goal": "g"})

    def fake_run(cmd, *args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", cmd[0])

    monkeypatch.setattr(handler.subprocess, "run", fake_run)
    handler.main()

    out = json.loads(capsys.readouterr().out)
    assert "not found" in out["content"].lower()


def test_handler_timeout(
    handler, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    _feed_stdin(monkeypatch, {"title": "t", "goal": "g"})

    def fake_run(cmd, *args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=10)

    monkeypatch.setattr(handler.subprocess, "run", fake_run)
    handler.main()

    out = json.loads(capsys.readouterr().out)
    assert "timed out" in out["content"].lower()


def test_handler_invalid_json(
    handler, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("not json{"))
    handler.main()
    out = json.loads(capsys.readouterr().out)
    assert "Invalid task JSON" in out["content"]


def test_handler_empty_stdin_is_safe(
    handler, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """Empty stdin must not crash; it builds a prompt from defaults and runs."""
    monkeypatch.setattr("sys.stdin", io.StringIO(""))

    def fake_run(cmd, *args, **kwargs):
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(handler.subprocess, "run", fake_run)
    rc = handler.main()

    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["content"] == "ok"
