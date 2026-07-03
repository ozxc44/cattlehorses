#!/usr/bin/env python3
"""Run the Agent Platform executor for the local Codex main agent.

The upstream standalone executor requires --api-key on the command line. This
wrapper keeps the key out of process arguments by loading it from the local
identity file, then starts the executor in PM-only mode.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import time
import urllib.request


BASE_URL = os.environ.get("ZZ_BASE_URL", "http://192.168.31.119:18080/agent")
IDENTITY_PATH = pathlib.Path(
    os.environ.get(
        "ZZ_IDENTITY_PATH",
        "/Users/z/.zz-agent/identities/codex-test-agent.json",
    )
)
EXECUTOR_PATH = pathlib.Path(
    os.environ.get("ZZ_EXECUTOR_PATH", "/Users/z/.zz-agent/executor.py")
)
EXECUTOR_URL = f"{BASE_URL.rstrip('/')}/v1/agent/bootstrap/executor.py"
INTERVAL = int(os.environ.get("ZZ_EXECUTOR_INTERVAL", "30"))


def ensure_executor() -> pathlib.Path:
    EXECUTOR_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not EXECUTOR_PATH.exists():
        with urllib.request.urlopen(EXECUTOR_URL, timeout=30) as response:
            EXECUTOR_PATH.write_bytes(response.read())
        EXECUTOR_PATH.chmod(0o700)
    return EXECUTOR_PATH


def load_agent_key() -> str:
    identity = json.loads(IDENTITY_PATH.read_text())
    key = identity.get("credentials", {}).get("agent_key")
    if not key:
        raise RuntimeError(f"No agent_key found in {IDENTITY_PATH}")
    return key


def load_executor(path: pathlib.Path):
    spec = importlib.util.spec_from_file_location("agent_platform_executor", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load executor from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> None:
    executor_path = ensure_executor()
    module = load_executor(executor_path)
    daemon = module.ExecutorDaemon(
        base_url=BASE_URL,
        api_key=load_agent_key(),
        interval=INTERVAL,
        pm_only=False,
        worker_only=False,
        no_self_update=True,
        handler_cmd=os.environ.get(
            "CODEX_INVOKE_HANDLER",
            "/Library/Developer/CommandLineTools/usr/bin/python3 /Users/z/.zz-agent/codex-invoke-handler.py",
        ),
    )
    print("Codex worker+PM executor wrapper started", flush=True)
    print(f"base_url={BASE_URL} interval={INTERVAL}s mode=worker+pm handler=codex-invoke-handler.py", flush=True)
    while True:
        started = time.strftime("%Y-%m-%dT%H:%M:%S")
        try:
            heartbeat_result = daemon.api("POST", "/v1/agents/heartbeat", {})
            if heartbeat_result.get("_error"):
                print(f"{started} heartbeat_error={heartbeat_result}", flush=True)
                pending = 0
            else:
                if not daemon.my_agent_id:
                    daemon.my_agent_id = heartbeat_result.get("agent_id")
                pending = heartbeat_result.get("pending_inbox_count", 0)
            daemon.run_cycle()
            print(
                f"{started} cycle_ok agent_id={daemon.my_agent_id or '-'} pending={pending}",
                flush=True,
            )
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(f"{started} cycle_error={exc}", flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
