#!/usr/bin/env python3
"""Codex worker handler for Agent Platform executor.

Reads a task context JSON on stdin (from executor.py --handler), asks the
local Codex CLI to actually EXECUTE the task, and prints {"content": "..."}.

This is the real-execution worker handler (codex exec runs and does the work),
distinct from codex-invoke-handler.py which bridges the invoke server.

Contract (matches kimi/mimo/claude worker handlers):
  - stdin  : task JSON {task_id, title, goal, acceptance_criteria, project_id, code_map}
  - stdout : {"content": "<markdown result>"}

The prompt is piped to codex via stdin (``codex exec ... -``) and the final
assistant message is read from codex's stdout.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap

# Prefer the bundled Codex.app binary; fall back to the pm-workers wrapper
# (~/.codex/pm-workers/bin/codex) which is a drop-in shell wrapper around it.
_APP_CODEX = "/Applications/Codex.app/Contents/Resources/codex"
_PM_CODEX = os.path.join(os.path.expanduser("~/.codex/pm-workers/bin"), "codex")
CODEX_BIN = os.environ.get("CODEX_BIN", "")
if not CODEX_BIN:
    CODEX_BIN = _APP_CODEX if os.path.exists(_APP_CODEX) else _PM_CODEX

CODEX_HOME = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))


def _resolve_workspace() -> str:
    for var in ("CODEX_WORKSPACE", "ZZ_PROJECT_DIR"):
        val = os.environ.get(var)
        if val:
            return val
    try:
        return os.getcwd()
    except (OSError, PermissionError):
        return os.path.expanduser("~")


WORKSPACE = _resolve_workspace()
TIMEOUT_SECONDS = int(os.environ.get("CODEX_TIMEOUT_SECONDS", "1500"))


def build_prompt(req: dict) -> str:
    """Turn the task context into a prompt that makes codex DO the work."""
    title = req.get("title", "")
    goal = req.get("goal", "")
    criteria = req.get("acceptance_criteria") or []
    project_id = req.get("project_id", "")
    code_map = req.get("code_map", "")

    crit_block = ""
    if criteria:
        crit_block = "\n验收标准:\n" + "\n".join(f"- {c}" for c in criteria)

    code_map_block = ""
    if code_map:
        code_map_block = f"\n代码地图(摘要):\n```\n{code_map}\n```\n"

    return textwrap.dedent(
        f"""
        你是 Agent Collaboration OS 平台派给的 codex worker agent，请在当前工作目录真实执行任务。

        项目: {project_id}
        任务标题: {title}
        工作目录: {WORKSPACE}

        任务目标:
        {goal}
        {crit_block}
        {code_map_block}

        工作要求:
        - 在工作目录 {WORKSPACE} 下真实执行任务(可读写文件、运行命令)。
        - 严格满足验收标准。
        - 完成后用简洁 markdown 总结:你做了什么、改了哪些文件、如何验证。
        - 不要输出 token/secret。
        """
    ).strip()


def main() -> int:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"content": f"Invalid task JSON: {exc}"}))
        return 0

    prompt = build_prompt(req)
    # codex exec: non-interactive, runs the prompt to completion and prints the
    # final assistant message to stdout. The prompt is fed via stdin ("-").
    # --dangerously-bypass-approvals-and-sandbox: auto-approve file writes so the
    # worker can actually edit the repo (mirrors codex-invoke-handler.py).
    # --dangerously-bypass-hook-trust: skip interactive hook-trust prompts that
    # would otherwise hang a non-interactive worker running under launchd.
    cmd = [
        CODEX_BIN,
        "exec",
        "--cd",
        WORKSPACE,
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
        "-",
    ]
    env = dict(os.environ)
    env.setdefault("HOME", os.path.expanduser("~"))
    env.setdefault("CODEX_HOME", CODEX_HOME)
    env["PATH"] = ":".join(
        [
            "/Applications/Codex.app/Contents/Resources",
            os.path.dirname(CODEX_BIN) or ".",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            env.get("PATH", ""),
        ]
    )
    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            cwd=WORKSPACE,
            env=env,
        )
    except subprocess.TimeoutExpired:
        print(json.dumps({"content": "codex handler timed out before producing a result."}))
        return 0
    except FileNotFoundError:
        print(json.dumps({"content": f"codex binary not found at {CODEX_BIN}"}))
        return 0

    content = (proc.stdout or "").strip()
    if not content:
        stderr = (proc.stderr or "").strip()[-1200:]
        content = f"codex handler produced no output. stderr:\n\n```text\n{stderr}\n```"

    print(json.dumps({"content": content}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
