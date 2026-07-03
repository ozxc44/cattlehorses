from __future__ import annotations

from typing import Any, Generator, Optional

import httpx

from .auth import TokenManager
from .models import (
    Agent,
    AgentProjectDiscovery,
    AgentProjectDiscoveryList,
    Changeset,
    ChangesetFileOp,
    EventEnvelope,
    HealthStatus,
    HeartbeatResponse,
    InboxItem,
    InboxList,
    InboxMeta,
    GitLog,
    GitLogEntry,
    Member,
    Message,
    Orchestration,
    OrchestrationTask,
    Project,
    ProjectCommit,
    ProjectFile,
    ProjectFileProposal,
    ProjectFileRevision,
    ProjectFileSummary,
    ProjectJoinRequest,
    ProjectMemory,
    Session,
    TokenResponse,
    User,
    WatchOutputItem,
    WatchResult,
    Workload,
)
from .stream import EventStreamClient


def _response_data(response: httpx.Response) -> Any:
    data = response.json()
    if isinstance(data, dict) and "data" in data:
        return data["data"]
    return data


def _response_items(response: httpx.Response, *keys: str) -> list[Any]:
    data = _response_data(response)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, list):
                return value
        value = data.get("items")
        if isinstance(value, list):
            return value
    return []


class _AuthAPI:
    """Auth API methods."""

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    def login(
        self,
        api_key: str | None = None,
        *,
        email: str | None = None,
        password: str | None = None,
    ) -> TokenResponse:
        """Log in with email/password."""
        return self._client._token_manager.login(
            api_key=api_key,
            email=email,
            password=password,
        )

    def me(self) -> User:
        """Get the currently authenticated user."""
        response = self._client._request("GET", "/v1/auth/me")
        return User(**_response_data(response))


class _ProjectsAPI:
    """Projects API methods."""

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    def list(self, skip: int = 0, limit: int = 50) -> list[Project]:
        """List all accessible projects."""
        response = self._client._request(
            "GET", "/v1/projects", params={"skip": skip, "limit": limit},
        )
        return [Project(**item) for item in _response_items(response, "projects")]

    def create(self, name: str, description: Optional[str] = None) -> Project:
        """Create a new project."""
        body: dict[str, Any] = {"name": name}
        if description is not None:
            body["description"] = description
        response = self._client._request("POST", "/v1/projects", json=body)
        return Project(**_response_data(response))

    def get(self, project_id: str) -> Project:
        """Get a project by ID."""
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}",
        )
        return Project(**_response_data(response))

    def update(
        self, project_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Project:
        """Update a project."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if description is not None:
            body["description"] = description
        response = self._client._request(
            "PATCH", f"/v1/projects/{project_id}", json=body,
        )
        return Project(**_response_data(response))

    def list_members(self, project_id: str) -> list[Member]:
        """List all members of a project."""
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/members",
        )
        return [Member(**item) for item in _response_items(response, "members")]

    def add_member(
        self, project_id: str, user_id: str,
        role: str = "member",
    ) -> Member:
        """Add a member to a project."""
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/members",
            json={"user_id": user_id, "role": role},
        )
        return Member(**_response_data(response))

    def update_member(
        self, project_id: str, user_id: str, role: str,
    ) -> Member:
        """Update a member's role."""
        response = self._client._request(
            "PATCH", f"/v1/projects/{project_id}/members/{user_id}",
            json={"role": role},
        )
        return Member(**_response_data(response))

    def remove_member(self, project_id: str, user_id: str) -> None:
        """Remove a member from a project."""
        self._client._request(
            "DELETE", f"/v1/projects/{project_id}/members/{user_id}",
        )


class _AgentsAPI:
    """Agents API methods."""

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    def list(
        self, project_id: str, skip: int = 0, limit: int = 50,
    ) -> list[Agent]:
        """List all agents in a project."""
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/agents",
            params={"skip": skip, "limit": limit},
        )
        return [Agent(**item) for item in _response_items(response, "agents")]

    def register(
        self, project_id: str, name: str,
        endpoint_url: str,
        invoke_secret: str,
        system_prompt: Optional[str] = None,
        scopes: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Agent:
        """Register an HTTP runtime agent in a project."""
        body: dict[str, Any] = {
            "name": name,
            "endpoint_url": endpoint_url,
            "invoke_secret": invoke_secret,
        }
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
        if scopes is not None:
            body["scopes"] = scopes
        if metadata is not None:
            body["metadata"] = metadata
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/agents", json=body,
        )
        return Agent(**_response_data(response))

    def create(
        self, project_id: str, name: str,
        system_prompt: Optional[str] = None,
        endpoint_url: Optional[str] = None,
        invoke_secret: Optional[str] = None,
        scopes: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Agent:
        """Create or register an agent in a project.

        V1 runtime agents should pass ``endpoint_url`` and ``invoke_secret``.
        The method remains permissive so older local backends that only stored
        metadata can still be exercised during development.
        """
        body: dict[str, Any] = {"name": name}
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
        if endpoint_url is not None:
            body["endpoint_url"] = endpoint_url
        if invoke_secret is not None:
            body["invoke_secret"] = invoke_secret
        if scopes is not None:
            body["scopes"] = scopes
        if metadata is not None:
            body["metadata"] = metadata
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/agents", json=body,
        )
        return Agent(**_response_data(response))

    def get(self, agent_id: str) -> Agent:
        """Get an agent by ID."""
        response = self._client._request(
            "GET", f"/v1/agents/{agent_id}",
        )
        return Agent(**_response_data(response))

    def update(
        self, agent_id: str,
        name: Optional[str] = None,
        system_prompt: Optional[str] = None,
        endpoint_url: Optional[str] = None,
        invoke_secret: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Agent:
        """Update an agent."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
        if endpoint_url is not None:
            body["endpoint_url"] = endpoint_url
        if invoke_secret is not None:
            body["invoke_secret"] = invoke_secret
        if status is not None:
            body["status"] = status
        response = self._client._request(
            "PATCH", f"/v1/agents/{agent_id}",
            json=body,
        )
        return Agent(**_response_data(response))

    def delete(self, agent_id: str) -> None:
        """Delete an agent."""
        self._client._request("DELETE", f"/v1/agents/{agent_id}")

    def rotate_key(self, project_id: str, agent_id: str) -> Agent:
        """Rotate the agent's API key. Returns the new key once in agent.api_key."""
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/agents/{agent_id}/rotate-key",
        )
        return Agent(**_response_data(response))

    def revoke_key(self, project_id: str, agent_id: str) -> Agent:
        """Revoke the agent's API key. The old key will no longer work."""
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/agents/{agent_id}/revoke-key",
        )
        return Agent(**_response_data(response))


class _SessionsAPI:
    """Sessions API methods."""

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    def list(
        self, project_id: str, skip: int = 0, limit: int = 50,
        status: Optional[str] = None,
    ) -> list[Session]:
        """List sessions in a project."""
        params: dict[str, Any] = {"skip": skip, "limit": limit}
        if status is not None:
            params["status"] = status
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/sessions",
            params=params,
        )
        return [Session(**item) for item in _response_items(response, "sessions")]

    def create(
        self, project_id: str, agent_ids: Optional[list[str]] = None,
        title: Optional[str] = None,
        participant_agent_ids: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Session:
        """Create a new session."""
        body: dict[str, Any] = {}
        if agent_ids is not None:
            body["agent_ids"] = agent_ids
        if participant_agent_ids is not None:
            body["participant_agent_ids"] = participant_agent_ids
        if title is not None:
            body["title"] = title
        if metadata is not None:
            body["metadata"] = metadata
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/sessions",
            json=body,
        )
        return Session(**_response_data(response))

    def get(self, session_id: str) -> Session:
        """Get a session by ID."""
        response = self._client._request("GET", f"/v1/sessions/{session_id}")
        return Session(**_response_data(response))

    def update(
        self,
        session_id: str,
        title: Optional[str] = None,
        status: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Session:
        """Update session metadata or close/archive a session."""
        body: dict[str, Any] = {}
        if title is not None:
            body["title"] = title
        if status is not None:
            body["status"] = status
        if metadata is not None:
            body["metadata"] = metadata
        response = self._client._request(
            "PATCH", f"/v1/sessions/{session_id}", json=body,
        )
        return Session(**_response_data(response))

    def send(
        self,
        session_id: str,
        message: str,
        recipient_participant_ids: Optional[list[str]] = None,
        visibility: str = "session",
        dispatch_ttl: Optional[int] = None,
        project_id: Optional[str] = None,
    ) -> Message:
        """Send a message to a session.

        Args:
            session_id: The session to send to.
            message: Message content.
            recipient_participant_ids: Empty/None means broadcast. Non-empty means targeted.
            visibility: ``session`` or ``direct``.
            dispatch_ttl: Optional runtime propagation TTL.
            project_id: Ignored for V1; accepted for backwards compatibility.
        """
        body: dict[str, Any] = {
            "content": message,
            "visibility": visibility,
        }
        if recipient_participant_ids is not None:
            body["recipient_participant_ids"] = recipient_participant_ids
        if dispatch_ttl is not None:
            body["dispatch_ttl"] = dispatch_ttl
        response = self._client._request(
            "POST",
            f"/v1/sessions/{session_id}/messages",
            json=body,
        )
        return Message(**_response_data(response))

    def messages(
        self,
        session_id: str,
        after_seq: Optional[int] = None,
        limit: int = 50,
    ) -> list[Message]:
        """List materialized messages for a session."""
        params: dict[str, Any] = {"limit": limit}
        if after_seq is not None:
            params["after_seq"] = after_seq
        response = self._client._request(
            "GET", f"/v1/sessions/{session_id}/messages", params=params,
        )
        return [Message(**item) for item in _response_items(response, "messages")]

    def events(
        self,
        session_id: str,
        after_seq: Optional[int] = None,
        limit: int = 50,
    ) -> list[EventEnvelope]:
        """List append-only events for a session."""
        params: dict[str, Any] = {"limit": limit}
        if after_seq is not None:
            params["after_seq"] = after_seq
        response = self._client._request(
            "GET", f"/v1/sessions/{session_id}/events", params=params,
        )
        return [EventEnvelope(**item) for item in _response_items(response, "events")]

    def stream(
        self, session_id: str,
        after_seq: int | None = None,
    ) -> Generator[EventEnvelope, None, None]:
        """Stream session events via SSE.

        Args:
            session_id: The session to stream events from.
            after_seq: Optional sequence number to resume from.

        Yields:
            EventEnvelope objects as they arrive.
        """
        stream_client = EventStreamClient(
            base_url=self._client._base_url,
            http_client=self._client._http_client,
            token_manager=self._client._token_manager,
        )
        yield from stream_client.stream(session_id, after_seq=after_seq)


class _HealthAPI:
    """Health API methods."""

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    def get(
        self,
        project_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> HealthStatus:
        """Get system, project, or agent health."""
        params: dict[str, Any] = {}
        if project_id is not None:
            params["project_id"] = project_id
        if agent_id is not None:
            params["agent_id"] = agent_id
        response = self._client._request("GET", "/v1/health", params=params)
        return HealthStatus(**_response_data(response))

    def check(self, project_id: str) -> HealthStatus:
        """Alias for project health lookup."""
        return self.get(project_id=project_id)

    def system(self) -> dict[str, Any]:
        """Get the global system health as a raw dict."""
        response = self._client._request("GET", "/v1/health")
        data = _response_data(response)
        return data if isinstance(data, dict) else {"items": data}

    def report(
        self,
        agent_id: str,
        status: Optional[str] = None,
        metrics: Optional[dict[str, float]] = None,
        details: Optional[dict[str, Any]] = None,
        observed_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """Report agent health or heartbeat metrics."""
        body: dict[str, Any] = {}
        if status is not None:
            body["status"] = status
        if metrics is not None:
            body["metrics"] = metrics
        if details is not None:
            body["details"] = details
        if observed_at is not None:
            body["observed_at"] = observed_at
        response = self._client._request(
            "POST",
            f"/v1/agents/{agent_id}/health",
            json=body,
        )
        data = _response_data(response)
        return data if isinstance(data, dict) else {"result": data}


class _ProjectSpaceAPI:
    """Project Space V2 API methods: files, revisions, memories, join requests, clone."""

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    # ─── Files ───────────────────────────────────────────────────────────────

    def list_files(
        self, project_id: str, path_prefix: Optional[str] = None,
    ) -> list[ProjectFileSummary]:
        """List Markdown-driven project files."""
        params: dict[str, Any] = {}
        if path_prefix is not None:
            params["path_prefix"] = path_prefix
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/files", params=params,
        )
        return [ProjectFileSummary(**item) for item in _response_items(response, "data")]

    def upsert_file(
        self,
        project_id: str,
        path: str,
        content: str,
        content_type: str = "text/markdown",
        base_revision_id: Optional[str] = None,
        message: Optional[str] = None,
    ) -> ProjectFile:
        """Create or update a project file and append a revision."""
        body: dict[str, Any] = {
            "path": path,
            "content": content,
            "content_type": content_type,
        }
        if base_revision_id is not None:
            body["base_revision_id"] = base_revision_id
        if message is not None:
            body["message"] = message
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/files", json=body,
        )
        return ProjectFile(**_response_data(response))

    def get_file(self, project_id: str, file_id: str) -> ProjectFile:
        """Get a project file with current content."""
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/files/{file_id}",
        )
        return ProjectFile(**_response_data(response))

    def list_revisions(
        self, project_id: str, file_id: str,
    ) -> list[ProjectFileRevision]:
        """List revisions for a project file."""
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/files/{file_id}/revisions",
        )
        return [ProjectFileRevision(**item) for item in _response_items(response, "data")]

    # ─── Memories ────────────────────────────────────────────────────────────

    def list_memories(
        self,
        project_id: str,
        agent_id: Optional[str] = None,
        q: Optional[str] = None,
    ) -> list[ProjectMemory]:
        """List project or agent-scoped memories."""
        params: dict[str, Any] = {}
        if agent_id is not None:
            params["agent_id"] = agent_id
        if q is not None:
            params["q"] = q
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/memories", params=params,
        )
        return [ProjectMemory(**item) for item in _response_items(response, "data")]

    def create_memory(
        self,
        project_id: str,
        content: str,
        agent_id: Optional[str] = None,
        tags: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> ProjectMemory:
        """Store project-level or agent-scoped memory."""
        body: dict[str, Any] = {"content": content}
        if agent_id is not None:
            body["agent_id"] = agent_id
        if tags is not None:
            body["tags"] = tags
        if metadata is not None:
            body["metadata"] = metadata
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/memories", json=body,
        )
        return ProjectMemory(**_response_data(response))

    # ─── Join Requests ───────────────────────────────────────────────────────

    def list_join_requests(
        self, project_id: str, status: Optional[str] = None,
    ) -> list[ProjectJoinRequest]:
        """List pending or reviewed project join requests."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/join-requests", params=params,
        )
        return [ProjectJoinRequest(**item) for item in _response_items(response, "data")]

    def create_join_request(
        self,
        project_id: str,
        requested_role: str = "member",
        note: Optional[str] = None,
    ) -> ProjectJoinRequest:
        """Request access to a project."""
        body: dict[str, Any] = {"requested_role": requested_role}
        if note is not None:
            body["note"] = note
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/join-requests", json=body,
        )
        return ProjectJoinRequest(**_response_data(response))

    def review_join_request(
        self,
        project_id: str,
        request_id: str,
        status: str,
        role: Optional[str] = None,
    ) -> ProjectJoinRequest:
        """Approve or reject a project join request."""
        body: dict[str, Any] = {"status": status}
        if role is not None:
            body["role"] = role
        response = self._client._request(
            "PATCH",
            f"/v1/projects/{project_id}/join-requests/{request_id}",
            json=body,
        )
        return ProjectJoinRequest(**_response_data(response))

    # ─── Clone ───────────────────────────────────────────────────────────────

    def clone_project(
        self,
        project_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        visibility: str = "private",
    ) -> Project:
        """Clone a public project or a project visible to the caller."""
        body: dict[str, Any] = {"visibility": visibility}
        if name is not None:
            body["name"] = name
        if description is not None:
            body["description"] = description
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/clone", json=body,
        )
        return Project(**_response_data(response))

    # ─── File Proposals ──────────────────────────────────────────────────────

    def list_file_proposals(
        self,
        project_id: str,
        status: Optional[str] = None,
        path: Optional[str] = None,
    ) -> list[ProjectFileProposal]:
        """List file proposals for a project."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if path is not None:
            params["path"] = path
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/file-proposals", params=params,
        )
        return [ProjectFileProposal(**item) for item in _response_items(response, "data")]

    def create_file_proposal(
        self,
        project_id: str,
        path: str,
        proposed_content: str,
        title: Optional[str] = None,
        description: Optional[str] = None,
        content_type: str = "text/markdown",
        file_id: Optional[str] = None,
        base_revision_id: Optional[str] = None,
    ) -> ProjectFileProposal:
        """Create a file proposal (agentKey or JWT)."""
        body: dict[str, Any] = {
            "path": path,
            "proposed_content": proposed_content,
            "content_type": content_type,
        }
        if title is not None:
            body["title"] = title
        if description is not None:
            body["description"] = description
        if file_id is not None:
            body["file_id"] = file_id
        if base_revision_id is not None:
            body["base_revision_id"] = base_revision_id
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/file-proposals", json=body,
        )
        return ProjectFileProposal(**_response_data(response))

    def get_file_proposal(
        self,
        project_id: str,
        proposal_id: str,
    ) -> ProjectFileProposal:
        """Get a single file proposal."""
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/file-proposals/{proposal_id}",
        )
        return ProjectFileProposal(**_response_data(response))

    def review_file_proposal(
        self,
        project_id: str,
        proposal_id: str,
        status: str,
        message: Optional[str] = None,
    ) -> ProjectFileProposal:
        """Approve or reject a file proposal (JWT only)."""
        body: dict[str, Any] = {"status": status}
        if message is not None:
            body["message"] = message
        response = self._client._request(
            "PATCH",
            f"/v1/projects/{project_id}/file-proposals/{proposal_id}/review",
            json=body,
        )
        return ProjectFileProposal(**_response_data(response))


class _OrchestrationsAPI:
    """Orchestration API methods for main-agent driven task workflows."""

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    def create(
        self,
        project_id: str,
        title: str,
        objective: str,
        worker_agent_ids: Optional[list[str]] = None,
        main_agent_id: Optional[str] = None,
        acceptance_criteria: Optional[list[str]] = None,
        plan: Optional[str] = None,
        base_path: Optional[str] = None,
        create_session: bool = True,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Orchestration:
        """Create a new orchestration."""
        body: dict[str, Any] = {
            "title": title,
            "objective": objective,
            "create_session": create_session,
        }
        if worker_agent_ids is not None:
            body["worker_agent_ids"] = worker_agent_ids
        if main_agent_id is not None:
            body["main_agent_id"] = main_agent_id
        if acceptance_criteria is not None:
            body["acceptance_criteria"] = acceptance_criteria
        if plan is not None:
            body["plan"] = plan
        if base_path is not None:
            body["base_path"] = base_path
        if metadata is not None:
            body["metadata"] = metadata
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/orchestrations", json=body,
        )
        return Orchestration(**_response_data(response))

    def list(
        self,
        project_id: str,
        status: Optional[str] = None,
    ) -> list[Orchestration]:
        """List orchestrations in a project."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/orchestrations", params=params,
        )
        return [Orchestration(**item) for item in _response_items(response, "data")]

    def get(
        self,
        project_id: str,
        orchestration_id: str,
    ) -> Orchestration:
        """Get an orchestration by ID."""
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/orchestrations/{orchestration_id}",
        )
        return Orchestration(**_response_data(response))

    def complete(
        self,
        project_id: str,
        orchestration_id: str,
        summary: Optional[str] = None,
    ) -> Orchestration:
        """Complete an orchestration after all tasks are approved."""
        body: dict[str, Any] = {}
        if summary is not None:
            body["summary"] = summary
        response = self._client._request(
            "PATCH",
            f"/v1/projects/{project_id}/orchestrations/{orchestration_id}/complete",
            json=body,
        )
        return Orchestration(**_response_data(response))

    # ─── Tasks ───────────────────────────────────────────────────────────────

    def create_task(
        self,
        project_id: str,
        orchestration_id: str,
        title: str,
        goal: str,
        assigned_agent_id: Optional[str] = None,
        acceptance_criteria: Optional[list[str]] = None,
        depends_on: Optional[list[str]] = None,
        scope: Optional[str] = None,
        context: Optional[str] = None,
        dispatch: bool = True,
    ) -> OrchestrationTask:
        """Create and optionally dispatch a task within an orchestration."""
        body: dict[str, Any] = {
            "title": title,
            "goal": goal,
            "dispatch": dispatch,
        }
        if assigned_agent_id is not None:
            body["assigned_agent_id"] = assigned_agent_id
        if acceptance_criteria is not None:
            body["acceptance_criteria"] = acceptance_criteria
        if depends_on is not None:
            body["depends_on"] = depends_on
        if scope is not None:
            body["scope"] = scope
        if context is not None:
            body["context"] = context
        response = self._client._request(
            "POST",
            f"/v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks",
            json=body,
        )
        return OrchestrationTask(**_response_data(response))

    def list_tasks(
        self,
        project_id: str,
        orchestration_id: str,
    ) -> list[OrchestrationTask]:
        """List tasks in an orchestration."""
        response = self._client._request(
            "GET",
            f"/v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks",
        )
        return [OrchestrationTask(**item) for item in _response_items(response, "data")]

    def get_task(
        self,
        project_id: str,
        orchestration_id: str,
        task_id: str,
    ) -> OrchestrationTask:
        """Get a task by ID."""
        response = self._client._request(
            "GET",
            f"/v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks/{task_id}",
        )
        return OrchestrationTask(**_response_data(response))

    def claim_task(
        self,
        project_id: str,
        orchestration_id: str,
        task_id: str,
    ) -> OrchestrationTask:
        """Claim a task (worker agent only)."""
        response = self._client._request(
            "PATCH",
            f"/v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks/{task_id}/claim",
        )
        return OrchestrationTask(**_response_data(response))

    def complete_task(
        self,
        project_id: str,
        orchestration_id: str,
        task_id: str,
        result_md: str,
        status: str = "ready_for_review",
        evidence: Optional[dict[str, Any]] = None,
    ) -> OrchestrationTask:
        """Submit a completed task with result and evidence."""
        body: dict[str, Any] = {
            "result_md": result_md,
            "status": status,
        }
        if evidence is not None:
            body["evidence"] = evidence
        response = self._client._request(
            "POST",
            f"/v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks/{task_id}/complete",
            json=body,
        )
        return OrchestrationTask(**_response_data(response))

    def review_task(
        self,
        project_id: str,
        orchestration_id: str,
        task_id: str,
        decision: str,
        notes: Optional[str] = None,
        requested_changes: Optional[str] = None,
    ) -> OrchestrationTask:
        """Review a completed task (main agent or PM only)."""
        body: dict[str, Any] = {"decision": decision}
        if notes is not None:
            body["notes"] = notes
        if requested_changes is not None:
            body["requested_changes"] = requested_changes
        response = self._client._request(
            "PATCH",
            f"/v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks/{task_id}/review",
            json=body,
        )
        return OrchestrationTask(**_response_data(response))

    def reassign_task(
        self,
        project_id: str,
        orchestration_id: str,
        task_id: str,
        new_agent_id: str,
        reason: Optional[str] = None,
    ) -> OrchestrationTask:
        """Reassign a stalled task to a different worker (PM only)."""
        body: dict[str, Any] = {"new_agent_id": new_agent_id}
        if reason is not None:
            body["reason"] = reason
        response = self._client._request(
            "POST",
            f"/v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks/{task_id}/reassign",
            json=body,
        )
        return OrchestrationTask(**_response_data(response))

    def switch_main_agent(
        self,
        project_id: str,
        orchestration_id: str,
        new_main_agent_id: str,
    ) -> Orchestration:
        """Switch the main agent (PM) for an orchestration."""
        response = self._client._request(
            "PATCH",
            f"/v1/projects/{project_id}/orchestrations/{orchestration_id}/main-agent",
            json={"new_main_agent_id": new_main_agent_id},
        )
        return Orchestration(**_response_data(response))


class _ChangesetsAPI:
    """Changeset API methods for version-controlled file edits."""

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    def create(
        self,
        project_id: str,
        title: str,
        file_ops: list[ChangesetFileOp],
        description: Optional[str] = None,
        status: str = "submitted",
        base_commit_id: Optional[str] = None,
        result_path: Optional[str] = None,
        evidence_path: Optional[str] = None,
        orchestration_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Changeset:
        """Create a new changeset."""
        body: dict[str, Any] = {
            "title": title,
            "file_ops": [op.model_dump(by_alias=True, exclude_none=True) for op in file_ops],
            "status": status,
        }
        if description is not None:
            body["description"] = description
        if base_commit_id is not None:
            body["base_commit_id"] = base_commit_id
        if result_path is not None:
            body["result_path"] = result_path
        if evidence_path is not None:
            body["evidence_path"] = evidence_path
        if orchestration_id is not None:
            body["orchestration_id"] = orchestration_id
        if task_id is not None:
            body["task_id"] = task_id
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/changesets", json=body,
        )
        return Changeset(**_response_data(response))

    def list(
        self,
        project_id: str,
        status: Optional[str] = None,
    ) -> list[Changeset]:
        """List changesets in a project."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/changesets", params=params,
        )
        return [Changeset(**item) for item in _response_items(response, "data")]

    def get(
        self,
        project_id: str,
        changeset_id: str,
    ) -> Changeset:
        """Get a changeset by ID."""
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/changesets/{changeset_id}",
        )
        return Changeset(**_response_data(response))

    def update(
        self,
        project_id: str,
        changeset_id: str,
        title: Optional[str] = None,
        description: Optional[str] = None,
        file_ops: Optional[list[ChangesetFileOp]] = None,
        status: Optional[str] = None,
    ) -> Changeset:
        """Update an existing changeset (draft or submitted only)."""
        body: dict[str, Any] = {}
        if title is not None:
            body["title"] = title
        if description is not None:
            body["description"] = description
        if file_ops is not None:
            body["file_ops"] = [op.model_dump(by_alias=True, exclude_none=True) for op in file_ops]
        if status is not None:
            body["status"] = status
        response = self._client._request(
            "PATCH", f"/v1/projects/{project_id}/changesets/{changeset_id}", json=body,
        )
        return Changeset(**_response_data(response))

    def review(
        self,
        project_id: str,
        changeset_id: str,
        decision: str,
        notes: Optional[str] = None,
    ) -> Changeset:
        """Review a changeset (approve, request changes, or reject)."""
        body: dict[str, Any] = {"decision": decision}
        if notes is not None:
            body["notes"] = notes
        response = self._client._request(
            "PATCH",
            f"/v1/projects/{project_id}/changesets/{changeset_id}/review",
            json=body,
        )
        return Changeset(**_response_data(response))

    def merge(
        self,
        project_id: str,
        changeset_id: str,
    ) -> dict[str, Any]:
        """Merge an approved changeset into the default branch."""
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/changesets/{changeset_id}/merge",
        )
        return _response_data(response)

    def rebase(
        self,
        project_id: str,
        changeset_id: str,
    ) -> Changeset:
        """Rebase a changeset onto the current branch head."""
        response = self._client._request(
            "POST", f"/v1/projects/{project_id}/changesets/{changeset_id}/rebase",
        )
        return Changeset(**_response_data(response))


class _GitAPI:
    """Real-git backend access (isomorphic-git).

    Each project has a true git repo on the platform; these methods expose its
    native history so a worker/PM can read real commit SHAs, messages, and
    authors — distinct from the DB-simulated ProjectCommit rows.
    """

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    def log(self, project_id: str, depth: int = 50) -> GitLog:
        """List real git commits (newest first) on the project default branch.

        Args:
            depth: max commits to return (1-500, default 50).
        """
        response = self._client._request(
            "GET", f"/v1/projects/{project_id}/git/log", params={"depth": depth},
        )
        # The endpoint returns {backend, head, data: [...]} — do NOT use
        # _response_data here (it would unwrap the inner `data` list and drop
        # backend/head).
        raw = response.json() if hasattr(response, "json") else {}
        entries = []
        for item in raw.get("data", []) or []:
            entries.append(GitLogEntry(
                sha=item.get("sha", ""),
                message=item.get("message"),
                author=item.get("author") or {},
                committer=item.get("committer") or {},
                parents=item.get("parents") or [],
                timestamp=item.get("timestamp"),
            ))
        return GitLog(
            backend=raw.get("backend", "isomorphic-git"),
            head=raw.get("head"),
            data=entries,
        )

    def head(self, project_id: str) -> str | None:
        """The current HEAD commit SHA of the project's default branch, or None."""
        return self.log(project_id, depth=1).head


class _AgentRuntimeAPI:
    """Agent runtime API methods for approved agents.

    These endpoints use ``X-API-Key`` authentication (agent keys starting
    with ``zzk_``) and are designed for agent-to-platform runtime loops.
    """

    def __init__(self, client: ZZClient) -> None:
        self._client = client

    def projects(self) -> list[AgentProjectDiscovery]:
        """Discover projects this agent is approved to access."""
        response = self._client._request("GET", "/v1/agent/projects")
        data = _response_data(response)
        if isinstance(data, list):
            return [AgentProjectDiscovery(**item) for item in data]
        wrapped = AgentProjectDiscoveryList(**data)
        return wrapped.data

    def inbox(
        self,
        unread: bool | None = None,
        status: str | None = None,
        event_type: str | None = None,
        since: str | None = None,
        limit: int = 50,
    ) -> InboxList:
        """Poll durable inbox items for this agent.

        Supports all production response shapes:
        - top-level list ``[...]``
        - ``{"data": [...]}``
        - ``{"items": [...]}``
        - ``{"data": {"data": [...], "meta": {...}}}``

        Args:
            unread: Filter to unread items only.
            status: Filter by item status.
            event_type: Filter by event type.
            since: ISO8601 timestamp cursor.
            limit: Maximum items to return.
        """
        params: dict[str, Any] = {"limit": limit}
        if unread is not None:
            params["unread"] = "true" if unread else "false"
        if status is not None:
            params["status"] = status
        if event_type is not None:
            params["event_type"] = event_type
        if since is not None:
            params["since"] = since
        response = self._client._request("GET", "/v1/agent/inbox", params=params)
        data = _response_data(response)

        # Top-level list → wrap into InboxList shape
        if isinstance(data, list):
            return InboxList(data=[InboxItem(**item) for item in data])

        # Dict responses: unwrap nested {"data": {"data": [...], "meta": {...}}}
        if isinstance(data, dict):
            inner = data.get("data")
            if isinstance(inner, dict):
                return InboxList(**inner)
            if isinstance(inner, list):
                items_data = inner
                meta = data.get("meta")
                return InboxList(
                    data=[InboxItem(**item) for item in items_data],
                    meta=InboxMeta(**meta) if isinstance(meta, dict) else InboxMeta(),
                )
            # {"items": [...]} → treat "items" as the inbox list
            items_key = data.get("items")
            if isinstance(items_key, list):
                return InboxList(data=[InboxItem(**item) for item in items_key])
            # Already flat InboxList shape
            return InboxList(**data)

        return InboxList()

    def ack_inbox(self, inbox_id: str) -> InboxItem:
        """Acknowledge an inbox item so it is no longer returned as unread.

        Args:
            inbox_id: The ``id`` of the InboxItem to acknowledge.
        """
        response = self._client._request(
            "POST", f"/v1/agent/inbox/{inbox_id}/ack"
        )
        return InboxItem(**_response_data(response))

    def workload(self) -> Workload:
        """Inspect the agent's current workload summary and recent units."""
        response = self._client._request("GET", "/v1/agent/workload")
        return Workload(**_response_data(response))

    def assigned_tasks(self, status: str | None = None) -> list[OrchestrationTask]:
        """List tasks assigned to this agent that are not yet terminal.

        One-stop view for a worker: instead of paging through inbox items, this
        returns every task assigned to the caller whose work is still owed (by
        default excludes ``approved``). Pass ``status`` to filter explicitly
        (e.g. ``changes_requested`` to see rework).

        Args:
            status: Optional exact status filter (e.g. ``running``,
                ``dispatched``, ``changes_requested``). Omit for all non-terminal.
        """
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        response = self._client._request("GET", "/v1/agent/assigned-tasks", params=params)
        data = _response_data(response)
        items: list = []
        if isinstance(data, list):
            items = data
        elif isinstance(data, dict):
            inner = data.get("data")
            if isinstance(inner, list):
                items = inner
        return [OrchestrationTask(**item) for item in items]

    def heartbeat(
        self,
        status: str | None = None,
        metadata: dict | None = None,
    ) -> HeartbeatResponse:
        """Send a heartbeat to the platform.

        Args:
            status: Optional status override (e.g. ``online``, ``idle``).
            metadata: Optional free-form metadata dict.
        """
        body: dict[str, Any] = {}
        if status is not None:
            body["status"] = status
        if metadata is not None:
            body["metadata"] = metadata
        response = self._client._request(
            "POST", "/v1/agents/heartbeat", json=body
        )
        return HeartbeatResponse(**_response_data(response))

    def watch(
        self,
        *,
        project_id: str | None = None,
        agent_id: str | None = None,
        max_items: int = 50,
        ack: bool = True,
    ) -> WatchResult:
        """Single watch iteration: heartbeat, poll inbox, format items, ack after output.

        Args:
            project_id: Optional project filter.
            agent_id: Optional agent id to validate against heartbeat response.
            max_items: Maximum inbox items to process.
            ack: Whether to ack inbox items after emitting them.

        Returns:
            WatchResult containing heartbeat, items, acked ids, and any errors.
        """
        result = WatchResult()

        # 1) Heartbeat
        try:
            hb = self.heartbeat(status="online")
            result.heartbeat = hb
        except Exception as e:
            result.errors.append(f"heartbeat failed: {e}")
            return result

        # Optional agent_id validation
        if agent_id and hb.agent_id and hb.agent_id != agent_id:
            result.errors.append(
                f"agent_id mismatch: expected {agent_id}, got {hb.agent_id}"
            )
            return result

        # 2) Poll inbox (unread only, limited)
        try:
            inbox = self.inbox(unread=True, limit=max_items)
        except Exception as e:
            result.errors.append(f"inbox poll failed: {e}")
            return result

        items: list[InboxItem] = getattr(inbox, "data", []) or []

        for item in items:
            # Optional project filter
            if project_id and getattr(item, "project_id", None) != project_id:
                continue

            # Determine required action from event_type and payload heuristics
            event_type = getattr(item, "event_type", "")
            payload = getattr(item, "payload", {}) or {}
            required_action = self._infer_required_action(event_type, payload)

            out = WatchOutputItem(
                inbox_id=getattr(item, "id", ""),
                event_type=event_type,
                project_id=getattr(item, "project_id", None),
                project_name=payload.get("project_name") if payload else None,
                task_id=getattr(item, "task_id", None),
                orchestration_id=getattr(item, "orchestration_id", None),
                title=getattr(item, "title", None),
                body=getattr(item, "body", None),
                required_action=required_action,
                payload=payload,
                created_at=getattr(item, "created_at", None),
            )
            result.items.append(out)

            # 3) Ack after successful output formatting
            if ack:
                try:
                    self.ack_inbox(out.inbox_id)
                    result.acked.append(out.inbox_id)
                except Exception as e:
                    result.errors.append(f"ack failed for {out.inbox_id}: {e}")

        return result

    @staticmethod
    def _infer_required_action(event_type: str, payload: dict[str, Any]) -> str:
        """Infer a human-readable required action from event type and payload.

        Maps all platform event types to actionable next steps, distinguishing
        worker vs PM responsibilities.
        """
        # ── Worker-side events ──
        if event_type in ("task.dispatched", "task_dispatched"):
            return "begin work on the dispatched task (run: zz agent resume → zz tasks claim → zz agent submit)"
        if event_type in ("task_changes_requested", "task.changes_requested"):
            return "rework the task per requested changes, then re-submit (run: zz agent submit --result ...)"
        if event_type in ("task_approved", "task.approved"):
            return "task approved — no action needed, your work shipped"
        if event_type in ("task_reassigned_away", "task_cancelled"):
            return "this task was reassigned/cancelled — no further action needed"
        if event_type in ("orchestration_completed",):
            return "orchestration completed — no action needed"
        if event_type in ("promoted_to_main_agent",):
            return "you are now the PM — dispatch tasks, review submissions, merge changesets"
        # ── PM-side events ──
        if event_type in ("task_ready_for_review", "task.review.requested"):
            return "review the submitted work (run: zz changesets approve-and-merge <id>)"
        if event_type in ("task_stale",):
            return "a task may be stalled — consider reassigning (run: zz tasks reassign <id> --to <agent>)"
        if event_type in ("task_reassigned",):
            return "task was reassigned — confirmation only"
        # ── Legacy / generic ──
        if event_type == "agent.run.queued":
            return "execute the queued agent run"
        if event_type == "agent.run.started":
            return "continue executing the started run"
        if event_type == "task.created":
            return "accept or start the task"
        if event_type == "task.assigned":
            return "begin work on the assigned task"
        if event_type == "message.created":
            return "respond to the session message"
        if event_type == "proposal.created":
            return "review the file proposal"
        action = payload.get("action") or payload.get("required_action")
        if action:
            return str(action)
        return "process the inbox item"


class ZZClient:
    """Client for the zz-agent API.

    Usage::

        from zz_agent import ZZClient

        client = ZZClient(
            base_url="http://127.0.0.1:18080/agent",
            api_key="your-api-key",
        )

        # Authenticate
        client.auth.login(email="user@example.com", password="your-password")
        user = client.auth.me()

        # Projects
        projects = client.projects.list()
        project = client.projects.create("My Project")

        # Agents
        agents = client.agents.list(project_id=project.id)
        agent = client.agents.create(project.id, name="helper")

        # Sessions
        session = client.sessions.create(project.id, agent_ids=[agent.id])
        msg = client.sessions.send(session_id=session.id, message="Hello!", project_id=project.id)

        # Stream events
        for event in client.sessions.stream(session.id):
            print(event.type, event.payload)

        # Health
        health = client.health.check(project.id)
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:18080/agent",
        api_key: str | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._http_client = http_client or httpx.Client()
        self._token_manager = TokenManager(
            base_url=self._base_url,
            api_key=api_key,
            http_client=self._http_client,
        )

        # API namespaces
        self.auth = _AuthAPI(self)
        self.projects = _ProjectsAPI(self)
        self.agents = _AgentsAPI(self)
        self.sessions = _SessionsAPI(self)
        self.health = _HealthAPI(self)
        self.project_space = _ProjectSpaceAPI(self)
        self.orchestrations = _OrchestrationsAPI(self)
        self.changesets = _ChangesetsAPI(self)
        self.git = _GitAPI(self)
        self.agent = _AgentRuntimeAPI(self)

    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Make an authenticated HTTP request."""
        url = f"{self._base_url}{path}"
        headers = self._token_manager.get_headers()
        response = self._http_client.request(
            method, url, headers=headers,
            params=params, json=json,
        )
        response.raise_for_status()
        return response

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._http_client.close()
