"""Dependency-free conformance checks for adapter implementations."""

from __future__ import annotations

from typing import Any

from .contract import BaseAdapter


def run_conformance(adapter: BaseAdapter) -> dict:
    """Run the adapter contract checks and return a structured report."""

    checks: list[dict[str, Any]] = []
    checks.append(_check_name(adapter))
    checks.append(_check_execute(adapter))
    checks.append(_check_health_check(adapter))
    return {
        "passed": all(check["passed"] for check in checks),
        "checks": checks,
    }


def _check_name(adapter: BaseAdapter) -> dict[str, Any]:
    try:
        name = adapter.name
        passed = isinstance(name, str) and bool(name.strip())
        detail = "name is a non-empty string" if passed else "name must be a non-empty string"
    except Exception as exc:
        passed = False
        detail = f"name raised {exc.__class__.__name__}: {exc}"
    return {"name": "name", "passed": passed, "detail": detail}


def _check_execute(adapter: BaseAdapter) -> dict[str, Any]:
    try:
        result = adapter.execute({"title": "test", "goal": "reply OK"})
        passed = (
            isinstance(result, dict)
            and isinstance(result.get("content"), str)
            and bool(result["content"].strip())
        )
        detail = (
            "execute returned non-empty content"
            if passed
            else "execute must return a dict with a non-empty string content key"
        )
    except Exception as exc:
        passed = False
        detail = f"execute raised {exc.__class__.__name__}: {exc}"
    return {"name": "execute", "passed": passed, "detail": detail}


def _check_health_check(adapter: BaseAdapter) -> dict[str, Any]:
    try:
        result = adapter.health_check()
        passed = isinstance(result, bool)
        detail = "health_check returned bool" if passed else "health_check must return bool"
    except Exception as exc:
        passed = False
        detail = f"health_check raised {exc.__class__.__name__}: {exc}"
    return {"name": "health_check", "passed": passed, "detail": detail}
