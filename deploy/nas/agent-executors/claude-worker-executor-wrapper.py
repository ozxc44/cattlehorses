#!/usr/bin/env python3
"""Claude worker executor wrapper.

Downloads the upstream executor.py, starts it in worker+PM mode with a
handler bridging to the local claude CLI for synchronous real task
execution. Mirrors the kimi/mimo wrappers.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import urllib.request

BASE_URL = os.environ.get("ZZ_BASE_URL", "http://127.0.0.1:18080/agent")
IDENTITY_PATH = pathlib.Path(
    os.environ.get(
        "ZZ_IDENTITY_PATH",
        os.path.join(os.path.expanduser("~/.zz-agent"), "identities", "claude-agent.json"),
    )
)
EXECUTOR_PATH = pathlib.Path(
    os.environ.get("ZZ_EXECUTOR_PATH", os.path.join(os.path.expanduser("~/.zz-agent"), "executor.py"))
)
EXECUTOR_URL = f"{BASE_URL.rstrip('/')}/v1/agent/bootstrap/executor.py"
INTERVAL = int(os.environ.get("ZZ_EXECUTOR_INTERVAL", "30"))


def load_agent_key() -> str:
    identity = json.loads(IDENTITY_PATH.read_text())
    key = identity.get("credentials", {}).get("agent_key")
    if not key:
        raise RuntimeError(f"No agent_key found in {IDENTITY_PATH}")
    return key


def load_executor(path: pathlib.Path):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(EXECUTOR_URL, timeout=30) as response:
        path.write_bytes(response.read())


if __name__ == "__main__":
    api_key = os.environ.get("CLAUDE_AGENT_KEY") or load_agent_key()
    load_executor(EXECUTOR_PATH)
    import runpy
    sys.argv = [
        str(EXECUTOR_PATH),
        "--base-url", BASE_URL,
        "--api-key", api_key,
        "--interval", str(INTERVAL),
        "--handler", f"{sys.executable} {os.path.join(os.path.expanduser('~/.zz-agent'), 'claude-worker-handler.py')}",
    ]
    runpy.run_path(str(EXECUTOR_PATH), run_name="__main__")
