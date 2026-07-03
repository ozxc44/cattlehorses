"""Minimal shell-backed adapter example."""

from __future__ import annotations

import subprocess
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from sdk.adapter import BaseAdapter


class ShellAdapter(BaseAdapter):
    @property
    def name(self) -> str:
        return "shell-adapter"

    def execute(self, task: dict) -> dict:
        command = task.get("goal")
        if not isinstance(command, str) or not command.strip():
            return {"content": "No shell command provided.", "evidence": None}

        completed = subprocess.run(
            command,
            shell=True,
            check=False,
            capture_output=True,
            text=True,
        )
        output = completed.stdout.strip() or completed.stderr.strip() or f"exit_code={completed.returncode}"
        return {
            "content": output,
            "evidence": {
                "exit_code": completed.returncode,
            },
        }

    def health_check(self) -> bool:
        return True


if __name__ == "__main__":
    adapter = ShellAdapter()
    result = adapter.execute({"title": "shell demo", "goal": "printf OK"})
    print(result["content"])
