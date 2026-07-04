#!/usr/bin/env python3
"""Codex worker executor wrapper for Agent Platform.

Starts the executor in worker+PM mode with a handler that bridges to the
local Codex CLI for synchronous real task execution. Mirrors the mimo/kimi
worker wrappers.

The api key is loaded from the local identity file (with a CODEX_AGENT_KEY
env fallback) so it stays out of process arguments. The worker runs in its
own isolated workspace (ZZ_PROJECT_DIR=/tmp/zz-workspace-codex) so it does
not collide with the codex PM or any sibling worker.
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
        os.path.join(os.path.expanduser("~/.zz-agent"), "identities", "codex-worker-agent.json"),
    )
)
EXECUTOR_PATH = pathlib.Path(
    os.environ.get("ZZ_EXECUTOR_PATH", "/Users/z/.zz-agent/executor.py")
)
# Fallback: the key is known from the running process if no identity file exists.
FALLBACK_API_KEY = os.environ.get("CODEX_AGENT_KEY", "")
EXECUTOR_URL = f"{BASE_URL.rstrip('/')}/v1/agent/bootstrap/executor.py"
INTERVAL = int(os.environ.get("ZZ_EXECUTOR_INTERVAL", "30"))

# R17: this worker operates in its own isolated workspace so it never touches
# the codex PM's checkout or sibling workers. ExecutorDaemon reads ZZ_PROJECT_DIR
# at construction time, so it must be set before we build the daemon.
os.environ.setdefault("ZZ_PROJECT_DIR", "/tmp/zz-workspace-codex")


def ensure_executor() -> pathlib.Path:
    EXECUTOR_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not EXECUTOR_PATH.exists():
        with urllib.request.urlopen(EXECUTOR_URL, timeout=30) as response:
            EXECUTOR_PATH.write_bytes(response.read())
        EXECUTOR_PATH.chmod(0o700)
    return EXECUTOR_PATH


def load_agent_key() -> str:
    if IDENTITY_PATH.exists():
        identity = json.loads(IDENTITY_PATH.read_text())
        key = identity.get("credentials", {}).get("agent_key")
        if key:
            return key
    if FALLBACK_API_KEY:
        return FALLBACK_API_KEY
    raise RuntimeError(f"No agent_key found in {IDENTITY_PATH} or CODEX_AGENT_KEY env")


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
        pm_only=False, worker_only=True,
        no_self_update=True,
        handler_cmd=os.environ.get(
            "CODEX_WORKER_HANDLER",
            "/Library/Developer/CommandLineTools/usr/bin/python3 /Users/z/.zz-agent/codex-worker-handler.py",
        ),
    )
    print("Codex worker+PM executor wrapper started", flush=True)
    print(f"base_url={BASE_URL} interval={INTERVAL}s mode=worker+pm handler=codex-worker-handler.py", flush=True)
    # R11: run a startup smoke test + periodic re-checks, mirroring daemon.run().
    # The wrapper's manual run_cycle() loop bypasses run(), so smoke test must
    # be wired in here explicitly (otherwise codex never reports health).
    daemon._cycle_count = 0
    daemon._maybe_run_periodic_smoke(force=True)
    while True:
        started = time.strftime("%Y-%m-%dT%H:%M:%S")
        try:
            # Use daemon.heartbeat() so the smoke-test health is carried in body.
            heartbeat_result = daemon.heartbeat()
            if heartbeat_result.get("_error"):
                print(f"{started} heartbeat_error={heartbeat_result}", flush=True)
                pending = 0
            else:
                pending = heartbeat_result.get("pending_inbox_count", 0)
            daemon.run_cycle()
            daemon._cycle_count += 1
            if daemon.smoke_interval > 0 and daemon._cycle_count % daemon.smoke_interval == 0:
                daemon._maybe_run_periodic_smoke()
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
