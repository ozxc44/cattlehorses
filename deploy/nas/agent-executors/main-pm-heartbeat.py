#!/usr/bin/env python3
"""Main-PM heartbeat keepalive — keeps the PM agent online on the platform.

The platform requires a fresh heartbeat every 90s (TTL) for an agent to be
considered online/dispatchable. A PM that only sends heartbeats on demand
drops offline between actions, which blocks orchestration creation (which
requires the main agent to be online).

This daemon sends a heartbeat every 60s so main-pm stays online permanently.
Run under nohup/launchd; it exits cleanly on SIGTERM/SIGINT.
"""
import os
import signal
import sys
import time
import urllib.request
import json

BASE_URL = os.environ.get("ZZ_BASE_URL", "http://192.168.31.119:18080/agent")
PM_KEY = os.environ.get("MAIN_PM_KEY") or os.environ.get("ZZ_PM_KEY", "")
INTERVAL = int(os.environ.get("PM_HEARTBEAT_INTERVAL", "60"))

_running = True


def _stop(signum, frame):
    global _running
    _running = False


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


def heartbeat() -> bool:
    if not PM_KEY:
        print("MAIN_PM_KEY / ZZ_PM_KEY not set; exiting", flush=True)
        return False
    req = urllib.request.Request(
        f"{BASE_URL.rstrip('/')}/v1/agents/heartbeat",
        data=b'{"status":"healthy"}',
        headers={
            "Authorization": f"Bearer {PM_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            d = json.loads(resp.read().decode())
            return bool(d.get("ok"))
    except Exception as e:
        print(f"heartbeat error: {e}", flush=True)
        return False


def main() -> int:
    print(f"main-pm heartbeat keepalive: base={BASE_URL} interval={INTERVAL}s", flush=True)
    while _running:
        ok = heartbeat()
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] {'ok' if ok else 'fail'}", flush=True)
        # sleep in 1s chunks so SIGTERM is responsive
        for _ in range(INTERVAL):
            if not _running:
                break
            time.sleep(1)
    print("main-pm heartbeat stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
