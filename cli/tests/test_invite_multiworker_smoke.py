"""Multi-worker invite-link acceptance smoke test.

Mocked mode (default): patches ZZClient in-process and exercises the full
PM + workers lifecycle via CliRunner.

Real-backend mode: set ZZ_BASE_URL, ZZ_EMAIL, and ZZ_PASSWORD env vars.
Runs real CLI subprocesses with isolated ZZ_HOME dirs.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from typer.testing import CliRunner

from zz_cli import main as zz_main

CLI_ROOT = Path(__file__).resolve().parent.parent
runner = CliRunner()


def _python_cmd() -> Path:
    """Path to the repo virtualenv interpreter (or $ZZ_PYTHON override)."""
    override = os.environ.get("ZZ_PYTHON")
    if override:
        return Path(override)
    return CLI_ROOT.parent / ".venv" / "bin" / "python"


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ─── Mock data classes ───────────────────────────────────────────────────────

class MockUser:
    id = "pm-user-1"
    username = "pm"
    display_name = "PM"
    created_at = _iso_now()


class MockProject:
    id = "proj-1"
    name = "Smoke Project"
    description = "Multi-worker smoke test project"
    owner_id = "pm-user-1"
    created_at = _iso_now()


class MockOrchestration:
    id = "orch-1"
    title = "Smoke Orchestration"
    objective = "Test multi-worker flow"
    status = "running"
    main_agent_id = "pm-agent-1"
    paths = None


class MockAgent:
    def __init__(self, agent_id: str, name: str, api_key: str | None = None):
        self.id = agent_id
        self.name = name
        self.api_key = api_key
        self.project_id = MockProject.id
        self.status = "idle"
        self.created_at = _iso_now()


class MockTask:
    def __init__(self, task_id: str, title: str, status: str, assigned_agent_id: str | None = None):
        self.id = task_id
        self.title = title
        self.status = status
        self.assigned_agent_id = assigned_agent_id
        self.goal = "Do the thing"
        self.worker_task_path = None
        self.result_path = None
        self.evidence_path = None
        self.created_at = _iso_now()


class MockJoinRequest:
    def __init__(self, request_id: str, status: str, role: str, requester_token: str = "", note: str | None = None):
        self.id = request_id
        self.status = status
        self.requested_role = role
        self.project_id = MockProject.id
        self.user_id = "worker-user"
        self.requester_token = requester_token
        self.note = note
        self.created_at = _iso_now()


class MockInboxItem:
    def __init__(self, task_id: str, orchestration_id: str, event_type: str = "task_dispatched"):
        self.inbox_id = f"inbox-{task_id}"
        self.event_type = event_type
        self.project_id = MockProject.id
        self.project_name = MockProject.name
        self.task_id = task_id
        self.orchestration_id = orchestration_id
        self.title = f"Task {task_id}"
        self.body = "Do the thing"
        self.required_action = "claim"
        self.status = "dispatched"
        self.goal = "Do the thing"
        self.agent_id = None

    def model_dump(self, mode: str = "json") -> dict[str, Any]:
        return {
            "inbox_id": self.inbox_id,
            "event_type": self.event_type,
            "project_id": self.project_id,
            "project_name": self.project_name,
            "task_id": self.task_id,
            "orchestration_id": self.orchestration_id,
            "title": self.title,
            "body": self.body,
            "required_action": self.required_action,
            "status": self.status,
            "goal": self.goal,
            "agent_id": self.agent_id,
        }


class MockHeartbeat:
    def __init__(self, agent_id: str, pending: int = 0):
        self.agent_id = agent_id
        self.status = "idle"
        self.pending_inbox_count = pending


class MockWatchResult:
    def __init__(self, items: list[Any], acked: list[str], agent_id: str):
        self.items = items
        self.acked = acked
        self.errors = []
        self.heartbeat = MockHeartbeat(agent_id, pending=len(items))


class MockClient:
    """Stateful mock client that tracks projects, agents, orchestrations, tasks.

    Membership is modelled per-caller so the worker join path mirrors the real
    backend: a worker that has not been approved is *not* a member, so
    ``projects.get`` 403s and ``agent join`` falls through to submitting a join
    request. Only after the owner approves the request is the caller's token
    added to the project membership. CliRunner invokes commands sequentially,
    so the most recently constructed client's token (set in ``__init__``) is the
    active caller for the nested namespace methods.
    """

    _projects: list[Any] = []
    _agents: list[Any] = []
    _orchestrations: list[Any] = []
    _tasks: dict[str, Any] = {}
    _join_requests: list[Any] = []
    _inbox: dict[str, list[Any]] = {}  # agent_id -> items
    _members: dict[str, set[str]] = {}  # project_id -> set of caller tokens
    _current_token: str = ""  # caller token of the most recently built client
    _next_id = 0

    def __init__(self, base_url: str | None = None, api_key: str | None = None, **kwargs: Any) -> None:
        # Capture the caller's credential so membership checks can identify who
        # is calling. Mirrors ZZClient(base_url=..., api_key=...) construction.
        MockClient._current_token = api_key or "anonymous"

    @classmethod
    def _reset(cls) -> None:
        cls._projects = []
        cls._agents = []
        cls._orchestrations = []
        cls._tasks = {}
        cls._join_requests = []
        cls._inbox = {}
        cls._members = {}
        cls._current_token = ""
        cls._next_id = 0

    @classmethod
    def _is_member(cls, project_id: str) -> bool:
        return MockClient._current_token in MockClient._members.get(project_id, set())

    @classmethod
    def _forbidden(cls, project_id: str, status: int = 403) -> httpx.HTTPStatusError:
        resp = httpx.Response(
            status,
            request=httpx.Request("GET", f"http://test/v1/projects/{project_id}"),
            json={"detail": "Forbidden" if status == 403 else "Conflict"},
        )
        return httpx.HTTPStatusError("forbidden", request=resp.request, response=resp)

    @classmethod
    def _mkid(cls, prefix: str) -> str:
        cls._next_id += 1
        return f"{prefix}-{cls._next_id}"

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
        def create(name: str, description: str | None = None):
            p = MockProject()
            p.id = MockClient._mkid("proj")
            p.name = name
            p.description = description or ""
            MockClient._projects.append(p)
            # The creator is the initial member/owner.
            MockClient._members.setdefault(p.id, set()).add(MockClient._current_token)
            return p

        @staticmethod
        def get(project_id: str):
            for p in MockClient._projects:
                if p.id == project_id:
                    # Membership gate: a non-member cannot read the project,
                    # which is what makes `agent join` submit a request instead
                    # of short-circuiting to "already a member".
                    if not MockClient._is_member(project_id):
                        raise MockClient._forbidden(project_id, 403)
                    return p
            raise MockClient._forbidden(project_id, 404)

        @staticmethod
        def list():
            return MockClient._projects

    class project_space:
        @staticmethod
        def create_join_request(project_id: str, requested_role: str, note: str | None = None):
            token = MockClient._current_token
            # A caller that is already a member has nothing to request.
            if MockClient._is_member(project_id):
                raise MockClient._forbidden(project_id, 409)
            # Only one pending request per (caller, project) — mirrors the backend 409.
            for req in MockClient._join_requests:
                if (
                    req.project_id == project_id
                    and req.requester_token == token
                    and req.status == "pending"
                ):
                    raise MockClient._forbidden(project_id, 409)
            req = MockJoinRequest(
                MockClient._mkid("req"),
                "pending",
                requested_role,
                requester_token=token,
                note=note,
            )
            req.project_id = project_id
            MockClient._join_requests.append(req)
            return req

        @staticmethod
        def review_join_request(project_id: str, request_id: str, status: str, role: str | None = None):
            for req in MockClient._join_requests:
                if req.id == request_id:
                    req.status = status
                    # Owner approval grants project membership to the requester,
                    # which is what lets the worker proceed past the join step.
                    if status == "approved" and req.requester_token:
                        MockClient._members.setdefault(project_id, set()).add(req.requester_token)
                    return req
            raise MockClient._forbidden(project_id, 404)

    class agents:
        @staticmethod
        def create(project_id: str, name: str, system_prompt: str | None = None, **kwargs):
            key = f"zzk_{project_id}_{name}_{uuid.uuid4().hex[:8]}"
            a = MockAgent(MockClient._mkid("agent"), name, api_key=key)
            MockClient._agents.append(a)
            return a

        @staticmethod
        def list(project_id: str):
            return [a for a in MockClient._agents if getattr(a, "project_id", None) == project_id]

    class orchestrations:
        @staticmethod
        def create(project_id: str, title: str, objective: str, **kwargs):
            o = MockOrchestration()
            o.id = MockClient._mkid("orch")
            o.title = title
            o.objective = objective
            o.project_id = project_id
            MockClient._orchestrations.append(o)
            return o

        @staticmethod
        def create_task(project_id: str, orchestration_id: str, title: str, goal: str, assigned_agent_id: str | None = None, dispatch: bool = True, **kwargs):
            t = MockTask(MockClient._mkid("task"), title, "dispatched" if dispatch else "pending", assigned_agent_id=assigned_agent_id)
            t.orchestration_id = orchestration_id
            t.project_id = project_id
            MockClient._tasks[t.id] = t
            if dispatch and assigned_agent_id:
                MockClient._inbox.setdefault(assigned_agent_id, []).append(
                    MockInboxItem(t.id, orchestration_id)
                )
            return t

        @staticmethod
        def list_tasks(project_id: str, orchestration_id: str):
            return [t for t in MockClient._tasks.values() if getattr(t, "orchestration_id", None) == orchestration_id]

        @staticmethod
        def get_task(project_id: str, orchestration_id: str, task_id: str):
            t = MockClient._tasks.get(task_id)
            if not t:
                raise Exception("404")
            return t

        @staticmethod
        def claim_task(project_id: str, orchestration_id: str, task_id: str):
            t = MockClient._tasks.get(task_id)
            if not t:
                raise Exception("404")
            t.status = "running"
            return t

        @staticmethod
        def complete_task(project_id: str, orchestration_id: str, task_id: str, result_md: str, status: str = "ready_for_review", evidence: Any = None):
            t = MockClient._tasks.get(task_id)
            if not t:
                raise Exception("404")
            t.status = status
            # Record the actual submitted payload so the smoke can prove a
            # result + evidence were persisted into project space, not just
            # that a path attribute flipped.
            t.result_md = result_md
            t.result_path = f"/orchestrations/{orchestration_id}/tasks/{task_id}/result.md"
            if evidence:
                t.evidence = evidence
                t.evidence_path = f"/orchestrations/{orchestration_id}/tasks/{task_id}/evidence.json"
            return t

        @staticmethod
        def review_task(project_id: str, orchestration_id: str, task_id: str, decision: str, notes: str | None = None, requested_changes: str | None = None):
            t = MockClient._tasks.get(task_id)
            if not t:
                raise Exception("404")
            t.status = "approved" if decision == "approved" else "changes_requested"
            t.review_notes = notes
            return t

    class agent:
        @staticmethod
        def projects():
            return []

        @staticmethod
        def workload():
            class Summary:
                total_units = 0
                completed_units = 0
                total_work = 0
            class Result:
                summary = Summary()
                recent = []
            return Result()

        @staticmethod
        def watch(project_id: str | None = None, agent_id: str | None = None, max_items: int = 50, ack: bool = True):
            if agent_id is None:
                # Return all items across all agents (simplification for tests)
                all_items: list[Any] = []
                for items in MockClient._inbox.values():
                    all_items.extend(items)
                items = all_items[:max_items]
            else:
                items = MockClient._inbox.get(agent_id, [])[:max_items]
            acked = [i.inbox_id for i in items] if ack else []
            return MockWatchResult(items, acked, agent_id or "agent-0")

        @staticmethod
        def heartbeat(status: str | None = None):
            class Result:
                agent_id = "agent-0"
                status = status or "idle"
                pending_inbox_count = 0
            return Result()

        @staticmethod
        def ack_inbox(inbox_id: str):
            class Result:
                id = inbox_id
                status = "acked"
            return Result()


# ─── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def tmp_config_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    home = tmp_path / ".zz"
    monkeypatch.setenv("ZZ_HOME", str(home))
    return home


@pytest.fixture
def mock_client(monkeypatch: pytest.MonkeyPatch) -> None:
    MockClient._reset()
    monkeypatch.setattr(zz_main, "ZZClient", MockClient)


def _write_config(home: Path, api_key: str = "user-jwt", base_url: str = "http://test") -> Path:
    config_path = home / "config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"api_key": api_key, "base_url": base_url}))
    return config_path


def _invoke(argv: list[str], env: dict[str, str] | None = None):
    return runner.invoke(zz_main.app, argv, env=env)


# ─── Mocked smoke test ─────────────────────────────────────────────────────────

def test_multiworker_smoke_mocked(
    tmp_config_home: Path,
    mock_client: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Full PM + two workers lifecycle with mocked backend.

    Exercises the realistic invite flow: workers start as non-members, submit a
    join request, the owner approves it, and only then are they members. Workers
    submit a result *and* evidence, and the smoke asserts both are present in
    project space (instead of the prior assertion that no evidence was sent).
    """
    pm_home = tmp_config_home
    _write_config(pm_home, api_key="pm-jwt")

    # PM creates project
    result = _invoke(["projects", "create", "--name", "Smoke Project", "--description", "test"])
    assert result.exit_code == 0, result.output
    assert "Project created" in result.output
    project_id = MockClient._projects[-1].id

    # PM creates orchestration
    result = _invoke(["orchestrations", "create", "--project", project_id, "--title", "Smoke Orch", "--objective", "test"])
    assert result.exit_code == 0, result.output
    assert "Orchestration created" in result.output
    orch_id = MockClient._orchestrations[-1].id

    # PM creates two worker agents
    result = _invoke(["agents", "create", "--project", project_id, "--name", "worker-1"])
    assert result.exit_code == 0, result.output
    worker1 = MockClient._agents[-1]

    result = _invoke(["agents", "create", "--project", project_id, "--name", "worker-2"])
    assert result.exit_code == 0, result.output
    worker2 = MockClient._agents[-1]

    # Workers are NOT yet project members, so `agent join` must take the
    # non-member path: it submits a join request rather than reporting
    # "Already a member".
    # Worker 1
    w1_home = tmp_config_home / "w1"
    w1_home.mkdir(parents=True, exist_ok=True)
    _write_config(w1_home, api_key="worker1-jwt")
    result = _invoke(["agent", "join", project_id, "--no-register"], env={"ZZ_HOME": str(w1_home)})
    assert result.exit_code == 0, result.output
    assert "Join request submitted" in result.output
    assert "Already a member" not in result.output
    w1_request = MockClient._join_requests[-1]
    assert w1_request.status == "pending"
    assert w1_request.requester_token == "worker1-jwt"
    # Still not a member until the owner approves.
    assert "worker1-jwt" not in MockClient._members.get(project_id, set())

    # Worker 2
    w2_home = tmp_config_home / "w2"
    w2_home.mkdir(parents=True, exist_ok=True)
    _write_config(w2_home, api_key="worker2-jwt")
    result = _invoke(["agent", "join", project_id, "--no-register"], env={"ZZ_HOME": str(w2_home)})
    assert result.exit_code == 0, result.output
    assert "Join request submitted" in result.output
    assert "Already a member" not in result.output
    w2_request = MockClient._join_requests[-1]
    assert w2_request.status == "pending"
    assert w2_request.requester_token == "worker2-jwt"

    # Re-joining before approval is a 409 conflict (one pending request per caller).
    result = _invoke(["agent", "join", project_id, "--no-register"], env={"ZZ_HOME": str(w1_home)})
    assert result.exit_code == 0, result.output
    assert "pending approval" in result.output

    # Owner (PM) approves both join requests; approval grants membership, which
    # is what lets each worker proceed past the join step.
    for req in (w1_request, w2_request):
        result = _invoke([
            "projects", "join-requests", "review", "--project", project_id,
            req.id, "--status", "approved",
        ])
        assert result.exit_code == 0, result.output
        assert "approved" in result.output
        assert req.status == "approved"

    assert "worker1-jwt" in MockClient._members[project_id]
    assert "worker2-jwt" in MockClient._members[project_id]

    # PM dispatches tasks to workers
    result = _invoke([
        "tasks", "create", "--project", project_id, "--orchestration", orch_id,
        "--title", "Task W1", "--goal", "Do w1", "--agent", worker1.id, "--dispatch",
    ])
    assert result.exit_code == 0, result.output
    task1 = list(MockClient._tasks.values())[-1]

    result = _invoke([
        "tasks", "create", "--project", project_id, "--orchestration", orch_id,
        "--title", "Task W2", "--goal", "Do w2", "--agent", worker2.id, "--dispatch",
    ])
    assert result.exit_code == 0, result.output
    task2 = list(MockClient._tasks.values())[-1]

    # Worker 1: watch --once --write-state
    (w1_home / "config.json").write_text(json.dumps({"api_key": worker1.api_key, "base_url": "http://test"}))
    result = _invoke(["agent", "watch", "--once", "--format", "json", "--write-state", "--agent", worker1.id], env={"ZZ_HOME": str(w1_home)})
    assert result.exit_code == 0, result.output

    # Worker 1: claim-next
    result = _invoke(["agent", "claim-next"], env={"ZZ_HOME": str(w1_home)})
    assert result.exit_code == 0, result.output
    assert task1.id in result.output
    assert "running" in result.output

    # Worker 1: submit result + evidence into project space
    w1_evidence = {"tests": "passed", "files_changed": 3, "worker": worker1.id}
    result = _invoke(
        ["agent", "submit", "--result", "Done by w1", "--evidence", json.dumps(w1_evidence)],
        env={"ZZ_HOME": str(w1_home)},
    )
    assert result.exit_code == 0, result.output
    assert task1.id in result.output
    assert "ready_for_review" in result.output

    # Worker 2: watch / claim / submit
    (w2_home / "config.json").write_text(json.dumps({"api_key": worker2.api_key, "base_url": "http://test"}))
    result = _invoke(["agent", "watch", "--once", "--format", "json", "--write-state", "--agent", worker2.id], env={"ZZ_HOME": str(w2_home)})
    assert result.exit_code == 0, result.output

    result = _invoke(["agent", "claim-next"], env={"ZZ_HOME": str(w2_home)})
    assert result.exit_code == 0, result.output
    assert task2.id in result.output

    w2_evidence = {"tests": "passed", "files_changed": 5, "worker": worker2.id}
    result = _invoke(
        ["agent", "submit", "--result", "Done by w2", "--evidence", json.dumps(w2_evidence)],
        env={"ZZ_HOME": str(w2_home)},
    )
    assert result.exit_code == 0, result.output
    assert task2.id in result.output
    assert "ready_for_review" in result.output

    # PM reviews both tasks approved
    result = _invoke([
        "tasks", "review", "--project", project_id, "--orchestration", orch_id, task1.id,
        "--decision", "approved", "--notes", "LGTM",
    ])
    assert result.exit_code == 0, result.output
    assert "approved" in result.output

    result = _invoke([
        "tasks", "review", "--project", project_id, "--orchestration", orch_id, task2.id,
        "--decision", "approved", "--notes", "LGTM",
    ])
    assert result.exit_code == 0, result.output
    assert "approved" in result.output

    # Project space must now hold a result + evidence for every worker task.
    # (The old smoke asserted `evidence_path is None`, which proved the opposite
    # of the requirement — that nothing was submitted.)
    t1 = MockClient._tasks[task1.id]
    t2 = MockClient._tasks[task2.id]
    assert t1.status == "approved" and t2.status == "approved"
    assert t1.result_path is not None and t2.result_path is not None
    assert t1.result_md == "Done by w1" and t2.result_md == "Done by w2"
    assert t1.evidence_path is not None and t2.evidence_path is not None
    assert t1.evidence == w1_evidence and t2.evidence == w2_evidence

    # Write the run evidence artifact to a portable, test-local directory and
    # prove it lands there (not under a hard-coded PM task ledger path).
    monkeypatch.setenv("ZZ_SMOKE_EVIDENCE_DIR", str(tmp_path / "evidence"))
    evidence_path = _write_evidence(
        mode="mocked",
        base_url="http://test",
        project_id=project_id,
        orchestration_id=orch_id,
        pm_agent_id="pm-user-1",
        worker_ids=[worker1.id, worker2.id],
        task_ids=[task1.id, task2.id],
        final_statuses={task1.id: "approved", task2.id: "approved"},
        evidence_submitted=True,
        commands=[
            "projects create",
            "orchestrations create",
            "agents create (x2)",
            "agent join (x2) -> non-member request",
            "projects join-requests review --status approved (x2)",
            "tasks create --dispatch (x2)",
            "agent watch --once --write-state (x2)",
            "agent claim-next (x2)",
            "agent submit --result --evidence (x2)",
            "tasks review --decision approved (x2)",
        ],
    )
    assert evidence_path.exists()
    assert evidence_path.parent == (tmp_path / "evidence")
    written = json.loads(evidence_path.read_text())
    assert written["status"] == "passed"
    assert written["evidence_submitted"] is True


# ─── Real-backend smoke test ─────────────────────────────────────────────────

@pytest.mark.skipif(
    not os.environ.get("ZZ_BASE_URL") or not os.environ.get("ZZ_EMAIL") or not os.environ.get("ZZ_PASSWORD"),
    reason="Real-backend mode requires ZZ_BASE_URL, ZZ_EMAIL, and ZZ_PASSWORD",
)
def test_multiworker_smoke_real() -> None:
    """Full PM + two workers lifecycle against a real backend."""
    base_url = os.environ["ZZ_BASE_URL"]
    email = os.environ["ZZ_EMAIL"]
    password = os.environ["ZZ_PASSWORD"]

    with tempfile.TemporaryDirectory() as pm_dir, tempfile.TemporaryDirectory() as w1_dir, tempfile.TemporaryDirectory() as w2_dir:
        pm_env = {**os.environ, "ZZ_HOME": pm_dir}
        w1_env = {**os.environ, "ZZ_HOME": w1_dir}
        w2_env = {**os.environ, "ZZ_HOME": w2_dir}

        def _run(argv: list[str], env: dict[str, str]) -> subprocess.CompletedProcess:
            return subprocess.run(
                [str(_python_cmd()), "-m", "zz_cli.main", *argv],
                cwd=CLI_ROOT,
                capture_output=True,
                text=True,
                env=env,
            )

        # PM login
        result = _run(["login", "--email", email, "--password", password, "--base-url", base_url], env=pm_env)
        assert result.returncode == 0, result.stderr

        # PM creates project
        result = _run(["projects", "create", "--name", "Smoke Multiworker"], env=pm_env)
        assert result.returncode == 0, result.stderr
        # Extract project ID from stdout
        import re
        m = re.search(r"\(([a-zA-Z0-9_-]+)\)", result.stdout)
        assert m, f"Could not find project ID in: {result.stdout}"
        project_id = m.group(1)

        # PM creates orchestration
        result = _run(["orchestrations", "create", "--project", project_id, "--title", "Smoke Orch", "--objective", "test"], env=pm_env)
        assert result.returncode == 0, result.stderr
        m = re.search(r"\(([a-zA-Z0-9_-]+)\)", result.stdout)
        assert m, f"Could not find orch ID in: {result.stdout}"
        orch_id = m.group(1)

        # PM creates worker agents. `agents create` prints the agent id but
        # NEVER its API key, so we must not scrape `zzk_...` from its output.
        # The supported way to materialize a key is `agents rotate-key`, which
        # prints the key exactly once (by design) — that is the only printed
        # secret we read.
        def _agent_id_and_key(name: str) -> tuple[str, str]:
            result = _run(["agents", "create", "--project", project_id, "--name", name], env=pm_env)
            assert result.returncode == 0, result.stderr
            m = re.search(r"\(([a-zA-Z0-9_-]+)\)", result.stdout)
            assert m, f"Could not find agent ID in: {result.stdout}"
            agent_id = m.group(1)
            rot = _run(["agents", "rotate-key", "--project", project_id, agent_id], env=pm_env)
            key_m = re.search(r"zzk_[A-Za-z0-9_]+", rot.stdout)
            if not key_m:
                pytest.skip(
                    "Real-backend multi-worker smoke could not obtain a worker API "
                    "key: `agents create` does not print keys and `agents rotate-key` "
                    "returned none. Provision worker keys (register/rotate-key) to "
                    "enable this smoke."
                )
            return agent_id, key_m.group(0)

        worker1_id, worker1_key = _agent_id_and_key("worker-1")
        worker2_id, worker2_key = _agent_id_and_key("worker-2")

        # Workers login with their own user creds (same user for simplicity)
        for env in (w1_env, w2_env):
            result = _run(["login", "--email", email, "--password", password, "--base-url", base_url], env=env)
            assert result.returncode == 0, result.stderr

        # Workers join project. NOTE: this smoke reuses the PM's own account for
        # the workers (only one set of credentials is provided via ZZ_*), so on a
        # real backend the caller is the project owner and `agent join` reports
        # "already a member". The non-member -> request -> approve -> member
        # lifecycle is proven by the mocked smoke; exercising it for real
        # requires distinct worker user accounts, which this harness does not
        # provision.
        result = _run(["agent", "join", project_id, "--no-register"], env=w1_env)
        assert result.returncode == 0, result.stderr

        result = _run(["agent", "join", project_id, "--no-register"], env=w2_env)
        assert result.returncode == 0, result.stderr

        # PM dispatches tasks
        result = _run(["tasks", "create", "--project", project_id, "--orchestration", orch_id, "--title", "Task W1", "--goal", "Do w1", "--agent", worker1_id, "--dispatch"], env=pm_env)
        assert result.returncode == 0, result.stderr
        m = re.search(r"\(([a-zA-Z0-9_-]+)\)", result.stdout)
        assert m
        task1_id = m.group(1)

        result = _run(["tasks", "create", "--project", project_id, "--orchestration", orch_id, "--title", "Task W2", "--goal", "Do w2", "--agent", worker2_id, "--dispatch"], env=pm_env)
        assert result.returncode == 0, result.stderr
        m = re.search(r"\(([a-zA-Z0-9_-]+)\)", result.stdout)
        assert m
        task2_id = m.group(1)

        # Workers watch / claim / submit
        for env, key, task_id in ((w1_env, worker1_key, task1_id), (w2_env, worker2_key, task2_id)):
            env = {**env, "ZZ_AGENT_KEY": key}
            result = _run(["agent", "watch", "--once", "--format", "json", "--write-state"], env=env)
            assert result.returncode == 0, result.stderr

            result = _run(["agent", "claim-next"], env=env)
            assert result.returncode == 0, result.stderr
            assert task_id in result.stdout

            evidence_json = json.dumps({"worker_key_prefix": key[:12], "task_id": task_id})
            result = _run(["agent", "submit", "--result", f"Done by {task_id}", "--evidence", evidence_json], env=env)
            assert result.returncode == 0, result.stderr
            assert task_id in result.stdout

        # PM reviews
        for task_id in (task1_id, task2_id):
            result = _run(["tasks", "review", "--project", project_id, "--orchestration", orch_id, task_id, "--decision", "approved"], env=pm_env)
            assert result.returncode == 0, result.stderr
            assert "approved" in result.stdout

        # Assert tasks are approved
        result = _run(["tasks", "list", "--project", project_id, "--orchestration", orch_id], env=pm_env)
        assert result.returncode == 0, result.stderr
        assert "approved" in result.stdout

        # Write evidence artifact
        _write_evidence(
            mode="real",
            base_url=base_url,
            project_id=project_id,
            orchestration_id=orch_id,
            pm_agent_id=email,
            worker_ids=[worker1_id, worker2_id],
            task_ids=[task1_id, task2_id],
            final_statuses={task1_id: "approved", task2_id: "approved"},
            evidence_submitted=True,
            commands=[
                "projects create",
                "orchestrations create",
                "agents create (x2)",
                "agents rotate-key (x2) [key printed once]",
                "agent join (x2)",
                "tasks create --dispatch (x2)",
                "agent watch --once --write-state (x2)",
                "agent claim-next (x2)",
                "agent submit --result --evidence (x2)",
                "tasks review --decision approved (x2)",
            ],
        )


# ─── Evidence artifact helper ────────────────────────────────────────────────

def _redact_url(url: str) -> str:
    """Strip any credential fragments from URL."""
    from urllib.parse import urlparse, urlunparse
    p = urlparse(url)
    if p.username or p.password:
        netloc = p.hostname or ""
        if p.port:
            netloc += f":{p.port}"
        p = p._replace(netloc=netloc)
    return urlunparse(p)


def _evidence_dir() -> Path:
    """Resolve a portable, configurable evidence output directory.

    Priority:
      1. ``ZZ_SMOKE_EVIDENCE_DIR`` env var (explicit override; used by CI / PM
         workers to collect artifacts into a known location).
      2. ``<cli>/tests/evidence`` (the repo's existing scratch evidence dir).
    The hard-coded PM task directory was removed so the smoke is not pinned to
    one worker's task ledger path.
    """
    override = os.environ.get("ZZ_SMOKE_EVIDENCE_DIR")
    if override:
        evidence_dir = Path(override).expanduser()
    else:
        evidence_dir = CLI_ROOT / "tests" / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    return evidence_dir


def _write_evidence(
    *,
    mode: str,
    base_url: str,
    project_id: str,
    orchestration_id: str,
    pm_agent_id: str,
    worker_ids: list[str],
    task_ids: list[str],
    final_statuses: dict[str, str],
    commands: list[str],
    evidence_submitted: bool = False,
) -> Path:
    run_id = f"multiworker-smoke-{int(time.time())}"
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    evidence_dir = _evidence_dir()
    path = evidence_dir / f"multiworker-cli-evidence-{timestamp.replace(':', '')}.json"
    evidence = {
        "run_id": run_id,
        "timestamp": timestamp,
        "mode": mode,
        "status": "passed",
        "base_url": _redact_url(base_url),
        "project_id": project_id,
        "orchestration_id": orchestration_id,
        "pm_agent_id": pm_agent_id,
        "worker_ids": worker_ids,
        "task_ids": task_ids,
        "final_statuses": final_statuses,
        "evidence_submitted": evidence_submitted,
        "commands": commands,
    }
    path.write_text(json.dumps(evidence, indent=2))
    return path
