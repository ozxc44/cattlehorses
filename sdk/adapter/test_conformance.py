from __future__ import annotations

from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sdk.adapter import AdapterManifest, load_manifest, run_conformance
from sdk.adapter.examples.shell_adapter import ShellAdapter


def test_shell_adapter_conformance() -> None:
    report = run_conformance(ShellAdapter())
    assert report["passed"] is True
    assert report["checks"]
    assert all(check["passed"] for check in report["checks"])


def test_load_manifest() -> None:
    manifest = load_manifest(Path(__file__).with_name("example_agent.adapter.json"))
    assert manifest == AdapterManifest(
        name="shell-adapter",
        version="0.1.0",
        capabilities=["code", "shell"],
        handler_command="python3 sdk/adapter/examples/shell_adapter.py",
    )


if __name__ == "__main__":
    test_shell_adapter_conformance()
    test_load_manifest()
    print("ok")
