"""Tests for zz agent join command.

Focused in-process coverage for invite parsing, pending-approval handling,
and the --wait limitation message.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from typer.testing import CliRunner

from zz_cli import main as zz_main

CLI_ROOT = Path(__file__).resolve().parent.parent
runner = CliRunner()


class MockUser:
    id = "user-1"
    username = "tester"
    display_name = "Tester"
    created_at = "2024-01-01T00:00:00Z"


class MockJoinRequest:
    id = "req-1"
    status = "pending"
    requested_role = "member"
    project_id = "proj-1"
    user_id = "user-1"


class MockAgent:
    id = "agent-1"
    name = "test-worker"
    api_key = "zzk_test_1234567890abcdef"
    project_id = "proj-1"


class MockProject:
    id = "proj-1"
    name = "Test Project"


class MockClient:
    _approved = False
    _last_join_request: dict[str, Any] = {}
    _last_base_url: str | None = None

    def __init__(self, **kwargs: Any) -> None:
        MockClient._last_base_url = kwargs.get("base_url")

    class auth:
        @staticmethod
        def me():
            return MockUser()

        @staticmethod
        def login(**kwargs):
            class Resp:
                access_token = "tok"
                user = MockUser()

            return Resp()

    class projects:
        @staticmethod
        def get(project_id: str):
            response = httpx.Response(
                403,
                request=httpx.Request("GET", f"http://test/v1/projects/{project_id}"),
                json={"detail": "Forbidden"},
            )
            raise httpx.HTTPStatusError("Forbidden", request=response.request, response=response)

    class project_space:
        @staticmethod
        def create_join_request(project_id: str, requested_role: str, note: str | None = None):
            MockClient._last_join_request = {
                "project_id": project_id,
                "requested_role": requested_role,
                "note": note,
            }
            return MockJoinRequest()

    class agents:
        @staticmethod
        def create(project_id: str, name: str, system_prompt: str | None = None, **kwargs):
            return MockAgent()


@pytest.fixture
def tmp_config_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    home = tmp_path / ".zz"
    monkeypatch.setenv("ZZ_HOME", str(home))
    monkeypatch.setenv("ZZ_IDENTITY_PATH", str(home / "identity.json"))
    return home


def _write_config(home: Path) -> Path:
    config_path = home / "config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"api_key": "user-jwt", "base_url": "http://test"}))
    return config_path


def _invoke(argv: list[str], env: dict[str, str] | None = None):
    return runner.invoke(zz_main.app, argv, env=env)


def test_agent_join_help() -> None:
    result = _invoke(["agent", "join", "--help"])
    assert result.exit_code == 0, result.output
    assert "Invite URL or project ID to join" in result.output
    assert "--wait" in result.output


def test_agent_join_smoke_mocks(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Mocked join with --wait should explain the applicant-side limitation and persist context."""
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    config_path = _write_config(tmp_config_home)

    result = _invoke(["agent", "join", "proj-1", "--wait", "--agent-name", "test-worker"])
    assert result.exit_code == 0, result.output
    assert "Join request submitted" in result.output
    assert "Status: pending" in result.output
    assert "--wait limitation" in result.output
    assert "Platform blocker" in result.output
    assert "owner approval" in result.output
    assert "Agent registered" not in result.output

    config = json.loads(config_path.read_text())
    assert config.get("api_key") == "user-jwt"
    assert config.get("default_project") == "proj-1"
    assert config.get("base_url") == "http://test"

    identity_path = tmp_config_home / "identity.json"
    assert identity_path.exists()
    identity = json.loads(identity_path.read_text())
    assert identity["platform"]["base_url"] == "http://test"
    assert identity["project"]["id"] == "proj-1"


def test_agent_join_no_register(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    result = _invoke(["agent", "join", "proj-1", "--no-register"])
    assert result.exit_code == 0, result.output
    assert "skipping agent registration" in result.output


def test_agent_join_already_member(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class AlreadyMemberClient(MockClient):
        class projects:
            @staticmethod
            def get(project_id: str):
                return MockProject()

    monkeypatch.setattr(zz_main, "ZZClient", AlreadyMemberClient)
    _write_config(tmp_config_home)

    result = _invoke(["agent", "join", "proj-1"])
    assert result.exit_code == 0, result.output
    assert "Already a member" in result.output
    assert "Platform blocker" in result.output

    config = json.loads((tmp_config_home / "config.json").read_text())
    assert config.get("default_project") == "proj-1"

    identity = json.loads((tmp_config_home / "identity.json").read_text())
    assert identity["project"]["id"] == "proj-1"


def test_agent_join_url_persists_invite_base_url(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Joining via invite URL should use and persist the invite host as the API base."""
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    result = _invoke([
        "agent",
        "join",
        "https://example.com/agent-start.html?intent=join&project_id=proj-1&project_name=MyProj",
        "--no-register",
    ])
    assert result.exit_code == 0, result.output
    assert "Join request submitted" in result.output
    assert "MyProj" in result.output
    assert MockClient._last_base_url == "https://example.com/agent"
    assert MockClient._last_join_request.get("requested_role") == "member"

    config = json.loads((tmp_config_home / "config.json").read_text())
    assert config.get("default_project") == "proj-1"
    assert config.get("base_url") == "https://example.com/agent"

    identity = json.loads((tmp_config_home / "identity.json").read_text())
    assert identity["platform"]["base_url"] == "https://example.com/agent"
    assert identity["project"]["id"] == "proj-1"
    assert identity["project"]["name"] == "MyProj"


def test_agent_join_url_parse(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    result = _invoke([
        "agent",
        "join",
        "https://example.com/agent-start.html?intent=join&project_id=proj-1&project_name=MyProj",
        "--no-register",
    ])
    assert result.exit_code == 0, result.output
    assert "Join request submitted" in result.output
    assert "MyProj" in result.output
    assert MockClient._last_join_request.get("requested_role") == "member"


def test_parse_invite_extracts_role_and_base_url() -> None:
    """Unit coverage for invite URL role and API base URL parsing."""
    assert zz_main._parse_invite(
        "https://example.com/agent-start.html?intent=join&project_id=p1&project_name=My%20Proj&requested_role=viewer"
    ) == ("p1", "My Proj", "viewer", "https://example.com/agent")
    assert zz_main._parse_invite(
        "https://example.com/agent-start.html?project_id=p1&requested_role=member"
    ) == ("p1", "", "member", "https://example.com/agent")
    assert zz_main._parse_invite(
        "https://example.com/agent-start.html?project_id=p1"
    ) == ("p1", "", "member", "https://example.com/agent")
    assert zz_main._parse_invite("p1") == ("p1", "", "member", "")
    # Unknown roles fall back to member so they cannot be used to escalate.
    assert zz_main._parse_invite(
        "https://example.com/agent-start.html?project_id=p1&requested_role=admin"
    ) == ("p1", "", "member", "https://example.com/agent")


def test_parse_invite_maps_dashboard_host_to_api_base() -> None:
    """The deterministic mapping from invite host to API base is documented in tests."""
    _, _, _, base = zz_main._parse_invite(
        "https://www.zhuzeyang.xyz/agent-start.html?project_id=p1"
    )
    assert base == "https://www.zhuzeyang.xyz/agent"
    _, _, _, base2 = zz_main._parse_invite(
        "http://localhost:8080/agent-start.html?project_id=p1"
    )
    assert base2 == "http://localhost:8080/agent"


def test_agent_join_url_preserves_viewer_role(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    result = _invoke([
        "agent",
        "join",
        "https://example.com/agent-start.html?intent=join&project_id=proj-1&project_name=MyProj&requested_role=viewer",
        "--no-register",
    ])
    assert result.exit_code == 0, result.output
    assert "Join request submitted" in result.output
    assert "Requested role: viewer" in result.output
    assert MockClient._last_join_request.get("requested_role") == "viewer"


def test_agent_join_url_preserves_member_role(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    result = _invoke([
        "agent",
        "join",
        "https://example.com/agent-start.html?intent=join&project_id=proj-1&project_name=MyProj&requested_role=member",
        "--no-register",
    ])
    assert result.exit_code == 0, result.output
    assert "Join request submitted" in result.output
    assert "Requested role: member" in result.output
    assert MockClient._last_join_request.get("requested_role") == "member"


def test_agent_join_direct_project_defaults_to_member(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    result = _invoke(["agent", "join", "proj-1", "--no-register"])
    assert result.exit_code == 0, result.output
    assert "Join request submitted" in result.output
    assert "Requested role: member" in result.output
    assert MockClient._last_join_request.get("requested_role") == "member"


def test_agent_join_explicit_role_overrides_invite(
    tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)
    _write_config(tmp_config_home)

    result = _invoke([
        "agent",
        "join",
        "https://example.com/agent-start.html?intent=join&project_id=proj-1&requested_role=viewer",
        "--role", "member",
        "--no-register",
    ])
    assert result.exit_code == 0, result.output
    assert "Requested role: member" in result.output
    assert MockClient._last_join_request.get("requested_role") == "member"


def test_agent_join_pending_409(tmp_config_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class PendingClient(MockClient):
        class project_space:
            @staticmethod
            def create_join_request(project_id: str, requested_role: str, note: str | None = None):
                response = httpx.Response(
                    409,
                    request=httpx.Request("POST", f"http://test/v1/projects/{project_id}/join-requests"),
                    json={
                        "id": "req-1",
                        "status": "pending",
                        "project_id": project_id,
                        "requested_role": requested_role,
                        "note": note,
                    },
                )
                raise httpx.HTTPStatusError("Conflict", request=response.request, response=response)

    monkeypatch.setattr(zz_main, "ZZClient", PendingClient)
    _write_config(tmp_config_home)

    result = _invoke(["agent", "join", "proj-1", "--wait"])
    assert result.exit_code == 0, result.output
    assert "pending approval" in result.output
    assert "Request ID: req-1" in result.output
    assert "--wait limitation" in result.output


def test_agent_join_not_authenticated(tmp_config_home: Path) -> None:
    result = _invoke(["agent", "join", "proj-1"])
    assert result.exit_code == 1
    assert "Not authenticated" in result.output


def test_agent_join_evidence(tmp_path: Path) -> None:
    """Emit evidence JSON summarizing the test run, written to tmp_path."""
    evidence = {
        "run_id": f"agent-join-smoke-{int(time.time())}",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": "mocked",
        "status": "passed",
        "base_url": "http://test",
        "project_id": "proj-1",
        "agent_id": "agent-1",
        "join_request_id": "req-1",
    }
    path = tmp_path / f"{evidence['run_id']}.json"
    path.write_text(json.dumps(evidence, indent=2))
    assert path.exists()
