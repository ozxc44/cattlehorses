"""Core contract for cattlehorses adapter implementations."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class AdapterManifest:
    """Static metadata describing how to launch an adapter."""

    name: str
    version: str
    capabilities: list[str]
    handler_command: str


class BaseAdapter(ABC):
    """Abstract base class every adapter implementation must satisfy."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Return a stable, non-empty adapter name."""

    @abstractmethod
    def execute(self, task: dict) -> dict:
        """Execute a platform task and return {'content': str, 'evidence': dict | None}."""

    @abstractmethod
    def health_check(self) -> bool:
        """Return whether the adapter is ready to handle tasks."""


def load_manifest(path: str | Path) -> AdapterManifest:
    """Load an ``agent.adapter.json`` manifest from disk."""

    manifest_path = Path(path)
    with manifest_path.open("r", encoding="utf-8") as fh:
        raw = json.load(fh)

    if not isinstance(raw, dict):
        raise ValueError("manifest must be a JSON object")

    name = _required_str(raw, "name")
    version = _required_str(raw, "version")
    handler_command = _required_str(raw, "handler_command")
    capabilities = raw.get("capabilities")
    if not isinstance(capabilities, list) or not all(isinstance(item, str) for item in capabilities):
        raise ValueError("manifest capabilities must be a list of strings")

    return AdapterManifest(
        name=name,
        version=version,
        capabilities=list(capabilities),
        handler_command=handler_command,
    )


def _required_str(raw: dict[str, Any], field: str) -> str:
    value = raw.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"manifest {field} must be a non-empty string")
    return value
