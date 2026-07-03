#!/usr/bin/env python3
"""Kimi worker handler for Agent Platform executor.

Reads a task context JSON on stdin (from executor.py --handler), asks the
local kimi CLI to actually EXECUTE the task, and prints {"content": "..."}.

This is a real-execution handler (kimi -p runs and does the work), NOT the
ACK-only kimi_invoke_handler.py used by the invoke server.

Contract:
  - stdin  : task JSON {task_id, title, goal, acceptance_criteria, project_id, code_map}
  - stdout : {"content": "<markdown result>"}
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap

KIMI_BIN = os.environ.get("KIMI_BIN", "/Users/z/.kimi-code/bin/kimi")
WORKSPACE = os.environ.get(
    "KIMI_WORKSPACE",
    "/Users/z/Documents/Codex/zhuzeyang-agent",
)
TIMEOUT_SECONDS = int(os.environ.get("KIMI_TIMEOUT_SECONDS", "270"))


def build_prompt(req: dict) -> str:
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
        你是 Agent Collaboration OS 平台派给的 kimi worker agent，请在当前工作目录真实执行任务。

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
    env = dict(os.environ)
    env["PATH"] = ":".join([
        "/Users/z/.kimi-code/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        env.get("PATH", ""),
    ])
    try:
        proc = subprocess.run(
            [KIMI_BIN, "-p", prompt, "--output-format", "text"],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            cwd=WORKSPACE,
            env=env,
        )
    except subprocess.TimeoutExpired:
        print(json.dumps({"content": "kimi handler timed out before producing a result."}))
        return 0
    except FileNotFoundError:
        print(json.dumps({"content": f"kimi binary not found at {KIMI_BIN}"}))
        return 0

    content = (proc.stdout or "").strip()
    if not content:
        stderr = (proc.stderr or "").strip()[-1200:]
        content = f"kimi handler produced no output. stderr:\n\n```text\n{stderr}\n```"

    print(json.dumps({"content": content}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
