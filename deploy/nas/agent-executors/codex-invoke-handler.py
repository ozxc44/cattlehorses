#!/usr/bin/env python3
"""Codex brain bridge for Agent Platform invoke requests.

Reads an AgentInvokeRequest JSON object on stdin, asks Codex CLI to handle it,
and prints {"content": "..."} for invoke-server.py.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap


CODEX_BIN = os.environ.get(
    "CODEX_BIN",
    "/Applications/Codex.app/Contents/Resources/codex",
)
CODEX_HOME = os.environ.get("CODEX_HOME", "/Users/z/.codex")
WORKSPACE = os.environ.get(
    "CODEX_INVOKE_WORKSPACE",
    "/Users/z/Documents/Codex/zhuzeyang-agent",
)
TIMEOUT_SECONDS = int(os.environ.get("CODEX_INVOKE_TIMEOUT_SECONDS", "1500"))


def build_prompt(req: dict) -> str:
    safe_req = dict(req)
    platform = "http://192.168.31.119:18080/agent"
    project_id = req.get("project_id") or req.get("project", {}).get("id")
    agent_id = req.get("agent_id") or req.get("agent", {}).get("id")
    trigger = req.get("trigger") or {}
    recent = req.get("recent_messages") or []

    return textwrap.dedent(
        f"""
        你是通过 Agent Collaboration OS invoke endpoint 唤醒的 Codex worker agent。

        平台地址: {platform}
        project_id: {project_id or ""}
        agent_id: {agent_id or ""}
        trigger: {json.dumps(trigger, ensure_ascii=False)}

        工作要求:
        - 根据下面的 AgentInvokeRequest 完成平台派给你的任务或消息响应。
        - 如果请求里包含任务目标、验收标准、上下文或最近消息，优先严格满足它们。
        - 需要操作本地仓库时，工作目录是 {WORKSPACE}。
        - 不要输出、复述或泄露任何 zzk_/sk_/token/secret。
        - 最终回答必须是可以直接交给平台的 markdown 结果，不要写空泛占位。

        最近消息摘要:
        {json.dumps(recent[-8:], ensure_ascii=False, indent=2)}

        完整 AgentInvokeRequest:
        ```json
        {json.dumps(safe_req, ensure_ascii=False, indent=2)}
        ```
        """
    ).strip()


def main() -> int:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"content": f"Invalid invoke JSON: {exc}"}))
        return 0

    prompt = build_prompt(req)
    with tempfile.TemporaryDirectory(prefix="codex-invoke-") as td:
        out_path = pathlib.Path(td) / "last-message.md"
        cmd = [
            CODEX_BIN,
            "exec",
            "--cd",
            WORKSPACE,
            "--dangerously-bypass-approvals-and-sandbox",
            "--dangerously-bypass-hook-trust",
            "--output-last-message",
            str(out_path),
            "-",
        ]
        try:
            child_env = dict(os.environ)
            child_env.setdefault("HOME", "/Users/z")
            child_env.setdefault("CODEX_HOME", CODEX_HOME)
            child_env["PATH"] = ":".join(
                [
                    "/Applications/Codex.app/Contents/Resources",
                    "/opt/homebrew/bin",
                    "/usr/local/bin",
                    "/usr/bin",
                    "/bin",
                    "/usr/sbin",
                    "/sbin",
                    child_env.get("PATH", ""),
                ]
            )
            proc = subprocess.run(
                cmd,
                input=prompt,
                text=True,
                capture_output=True,
                timeout=TIMEOUT_SECONDS,
                cwd=WORKSPACE,
                env=child_env,
            )
        except subprocess.TimeoutExpired:
            print(json.dumps({"content": "Codex invoke handler timed out before producing a result."}))
            return 0

        if out_path.exists():
            content = out_path.read_text(errors="replace").strip()
        else:
            content = (proc.stdout or "").strip()

        if not content:
            stderr = (proc.stderr or "").strip()[-1200:]
            content = f"Codex invoke handler produced no final message. stderr:\n\n```text\n{stderr}\n```"

        print(json.dumps({"content": content}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
