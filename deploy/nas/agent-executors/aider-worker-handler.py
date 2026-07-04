#!/usr/bin/env python3
"""Aider worker handler — bridges platform tasks to the local aider CLI.

Reads task JSON on stdin, runs `aider --message` to execute, prints
{"content": ...}. Same contract as kimi/mimo/codex handlers."""
from __future__ import annotations
import json, os, subprocess, sys, textwrap


def _resolve_workspace() -> str:
    for v in ("AIDER_WORKSPACE", "ZZ_PROJECT_DIR"):
        if os.environ.get(v):
            return os.environ[v]
    try:
        return os.getcwd()
    except (OSError, PermissionError):
        return os.path.expanduser("~")


AIDER_BIN = os.environ.get("AIDER_BIN", "aider")
WORKSPACE = _resolve_workspace()
TIMEOUT_SECONDS = int(os.environ.get("AIDER_TIMEOUT_SECONDS", "1500"))


def build_prompt(req: dict) -> str:
    title = req.get("title", "")
    goal = req.get("goal", "")
    criteria = req.get("acceptance_criteria") or []
    crit = "\n验收标准:\n" + "\n".join(f"- {c}" for c in criteria) if criteria else ""
    return textwrap.dedent(f"""
        你是 Agent Collaboration OS 平台派给的 aider worker agent，请在当前工作目录真实执行任务。

        任务标题: {title}
        工作目录: {WORKSPACE}

        任务目标:
        {goal}
        {crit}

        工作要求:
        - 在工作目录 {WORKSPACE} 下真实执行任务(可读写文件、运行命令)。
        - 严格满足验收标准。
        - 完成后用简洁 markdown 总结:你做了什么、改了哪些文件、如何验证。
        - 不要输出 token/secret。
    """).strip()


def main() -> int:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"content": f"Invalid task JSON: {exc}"}))
        return 0
    prompt = build_prompt(req)
    try:
        proc = subprocess.run(
            [AIDER_BIN, "--message", prompt, "--no-auto-commits"],
            capture_output=True, text=True,
            timeout=TIMEOUT_SECONDS, cwd=WORKSPACE,
        )
    except subprocess.TimeoutExpired:
        print(json.dumps({"content": "aider handler timed out before producing a result."}))
        return 0
    except FileNotFoundError:
        print(json.dumps({"content": f"aider binary not found at {AIDER_BIN}"}))
        return 0
    content = (proc.stdout or "").strip()
    if not content:
        stderr = (proc.stderr or "").strip()[-1200:]
        content = f"aider handler produced no output. stderr:\n\n```text\n{stderr}\n```"
    print(json.dumps({"content": content}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
