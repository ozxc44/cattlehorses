"""zz CLI — Command-line interface for zhuzeyang-agent.

Usage:
    zz login --email <email> --password <password>
    zz projects list
    zz projects create --name <name>
    zz agents list --project <id>
    zz agents register --project <id> --name <name> --endpoint-url <url> --invoke-secret <secret>
    zz sessions list --project <id>
    zz sessions create --project <id> --agents <a1,a2>
    zz send --session <id> --message <text>
    zz stream --session <id>
    zz health --project <id>
    zz dev fake-agent
    zz dev quickstart-runtime
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Optional
from urllib.parse import parse_qs, unquote, urlparse

import typer
from rich.console import Console
from rich.live import Live
from rich.table import Table

# Add SDK to path for development (pip install -e . handles this in production)
_sdk_path = os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python")
if _sdk_path not in sys.path and os.path.isdir(_sdk_path):
    sys.path.insert(0, _sdk_path)

try:
    from zz_agent import ZZClient as _ZZClient
    ZZClient = _ZZClient  # type: ignore[misc,assignment]
except Exception:
    ZZClient = None  # type: ignore[misc,assignment]

console = Console()

# ─── App ───────────────────────────────────────────────────────────────────────

app = typer.Typer(
    name="zz",
    help="zz — Agent Collaboration OS CLI.\n\nManage projects, agents, sessions, and monitor health.",
    no_args_is_help=True,
)
projects_app = typer.Typer(name="projects", help="Manage project spaces.")
agents_app = typer.Typer(name="agents", help="Manage agents.")
sessions_app = typer.Typer(name="sessions", help="Manage sessions and messages.")
health_app = typer.Typer(name="health", help="Get and report health.")
dev_app = typer.Typer(name="dev", help="Development runtime tools.")
identity_app = typer.Typer(name="identity", help="Manage local Agent Platform identity.")

files_app = typer.Typer(name="files", help="Manage project files and revisions.")
memories_app = typer.Typer(name="memories", help="Manage project memories.")
join_requests_app = typer.Typer(name="join-requests", help="Manage project join requests.")
proposals_app = typer.Typer(name="proposals", help="Manage file proposals (agent-authored, user-reviewed).")

projects_app.add_typer(files_app, name="files")
projects_app.add_typer(memories_app, name="memories")
projects_app.add_typer(join_requests_app, name="join-requests")
projects_app.add_typer(proposals_app, name="proposals")

agent_app = typer.Typer(
    name="agent",
    help="Agent runtime commands for approved agents (project discovery, inbox, heartbeat, workload).",
)

orchestrations_app = typer.Typer(
    name="orchestrations",
    help="Create and manage orchestrations (main-agent driven task workflows).",
)
tasks_app = typer.Typer(
    name="tasks",
    help="Dispatch, list, get, and review orchestration tasks.",
)
changesets_app = typer.Typer(
    name="changesets",
    help="Create, review, merge, and rebase version-controlled changesets.",
)
git_app = typer.Typer(
    name="git",
    help="Read the project's real git history (isomorphic-git backend).",
)
trace_app = typer.Typer(
    name="trace",
    help="Read MD collaboration artifacts from project-space orchestration traces.",
)
repo_app = typer.Typer(
    name="repo",
    help="Repository operations: import, summary, checkout (GitHub-lite project space).",
)

app.add_typer(projects_app, name="projects")
app.add_typer(agents_app, name="agents")
app.add_typer(sessions_app, name="sessions")
app.add_typer(health_app, name="health")
app.add_typer(dev_app, name="dev")
app.add_typer(identity_app, name="identity")
app.add_typer(agent_app, name="agent")
app.add_typer(orchestrations_app, name="orchestrations")
app.add_typer(tasks_app, name="tasks")
app.add_typer(changesets_app, name="changesets")
app.add_typer(git_app, name="git")
app.add_typer(repo_app, name="repo")
app.add_typer(trace_app, name="trace")

# ─── Config helpers ────────────────────────────────────────────────────────────

DEFAULT_BASE_URL = os.environ.get("ZZ_BASE_URL", "http://127.0.0.1:18080/agent")
IDENTITY_SCHEMA = "agent-platform.identity.v1"
OPENCLAW_PACKAGE = "@zhuzeyang/openclaw-agent-social-platform"


def _get_base_url() -> str:
    config = _load_config()
    return os.environ.get("ZZ_BASE_URL") or config.get("base_url") or DEFAULT_BASE_URL


def _zz_home() -> str:
    """Local CLI home directory (``~/.zz`` by default).

    Override with the ``ZZ_HOME`` environment variable — used by tests to keep
    config/state isolated from the real home directory.
    """
    override = os.environ.get("ZZ_HOME")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    return os.path.join(os.path.expanduser("~"), ".zz")


def _get_config_path() -> str:
    config_dir = _zz_home()
    os.makedirs(config_dir, exist_ok=True)
    return os.path.join(config_dir, "config.json")


def _load_config() -> dict[str, Any]:
    path = _get_config_path()
    if os.path.exists(path):
        with open(path, "r") as f:
            return dict(json.load(f))
    return {}


def _save_config(config: dict[str, Any]) -> None:
    path = _get_config_path()
    with open(path, "w") as f:
        json.dump(config, f, indent=2, default=str)


def _get_identity_path(path: Optional[str] = None) -> str:
    if path:
        return os.path.expanduser(path)
    override = os.environ.get("ZZ_IDENTITY_PATH")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
        return os.path.join(base, "AgentPlatform", "identity.json")
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "Agent Platform", "identity.json")
    return os.path.join(os.path.expanduser("~"), ".config", "agent-platform", "identity.json")


def _write_identity_file(payload: dict[str, Any], path: str) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, mode=0o700, exist_ok=True)
    with open(path, "w") as f:
        json.dump(payload, f, indent=2, default=str)
        f.write("\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _build_identity(
    *,
    base_url: str,
    user_token: Optional[str] = None,
    user: Optional[dict[str, Any]] = None,
    project: Optional[dict[str, Any]] = None,
    agent: Optional[dict[str, Any]] = None,
    agent_key: Optional[str] = None,
) -> dict[str, Any]:
    credentials: dict[str, Any] = {}
    if user_token:
        credentials["user_token"] = user_token
    if agent_key:
        credentials["agent_key"] = agent_key
    return {
        "schema": IDENTITY_SCHEMA,
        "platform": {
            "name": "Agent Collaboration OS",
            "base_url": base_url.rstrip("/"),
        },
        "user": user,
        "project": project,
        "agent": agent,
        "credentials": credentials,
        "openclaw": {
            "plugin_id": "agent-social-platform",
            "package": OPENCLAW_PACKAGE,
            "config": {
                "baseUrl": base_url.rstrip("/"),
                "userToken": user_token,
                "agentKey": agent_key,
                "timeoutMs": 30000,
            },
        },
    }


def _get_client() -> Any:
    """Create an authenticated ZZClient from stored config.

    Credential priority (first match wins):
      1. ``ZZ_AGENT_KEY`` — a main/PM agent can drive orchestration/task/review
         commands with its own key. The SDK sends it as ``X-API-Key``, which the
         backend accepts via ``authenticateJwtOrAgentApiKey``.
      2. ``ZZ_API_KEY`` or stored config ``api_key`` — human JWT session.
    """
    if ZZClient is None:
        raise RuntimeError("SDK not available")

    agent_key = os.environ.get("ZZ_AGENT_KEY")
    if agent_key:
        return ZZClient(base_url=_get_base_url(), api_key=agent_key)

    config = _load_config()
    api_key = os.environ.get("ZZ_API_KEY") or config.get("api_key")

    if not api_key:
        console.print("[red]Not authenticated. Run: zz login --email <email> --password <password>[/red]")
        raise typer.Exit(1)

    client = ZZClient(base_url=_get_base_url(), api_key=api_key)
    return client


def _get_project_id(config_override: Optional[str] = None) -> str:
    """Get project_id from override, config, or prompt."""
    if config_override:
        return config_override
    config = _load_config()
    pid = config.get("default_project")
    if not pid:
        console.print(
            "[red]No project specified. Use --project <id> or set a default.[/red]"
        )
        raise typer.Exit(1)
    return pid


def _load_identity() -> dict[str, Any]:
    path = _get_identity_path()
    if os.path.exists(path):
        with open(path, "r") as f:
            return dict(json.load(f))
    return {}


def _get_agent_client() -> Any:
    """Create a ZZClient authenticated as an agent.

    Credential priority:
      1. ZZ_AGENT_KEY environment variable
      2. ~/.zz/config.json credential if it starts with zzk_
      3. OS identity file credentials.agent_key
    """
    if ZZClient is None:
        raise RuntimeError("SDK not available")

    config = _load_config()
    identity = _load_identity()

    api_key = os.environ.get("ZZ_AGENT_KEY")
    if not api_key:
        stored = config.get("api_key") or config.get("access_token")
        if stored and stored.startswith("zzk_"):
            api_key = stored

    if not api_key:
        api_key = identity.get("credentials", {}).get("agent_key")

    if not api_key:
        console.print("[red]No agent credential found.[/red]")
        console.print(
            "[dim]To get started on a new machine/terminal:[/dim]\n"
            "  1. zz agent join \"<invite-link>\"   # discover the platform + apply to a project\n"
            "     — or —\n"
            "  2. zz login --email <email> --password <password>   # then zz agents register / zz agent join\n"
            "\n"
            "Credentials (agent_key) persist in the identity file, so after the first\n"
            "setup you never need to log in again — including across reboots."
        )
        raise typer.Exit(1)

    base_url = (
        os.environ.get("ZZ_BASE_URL")
        or config.get("base_url")
        or identity.get("platform", {}).get("base_url")
        or DEFAULT_BASE_URL
    )

    return ZZClient(base_url=base_url, api_key=api_key)


# ─── Error handler ─────────────────────────────────────────────────────────────


def _handle_error(e: Exception, msg: str = "Operation failed") -> None:
    """Display a user-friendly error and exit."""
    import httpx

    if isinstance(e, httpx.HTTPStatusError):
        status = e.response.status_code
        body = ""
        try:
            body = e.response.json().get("message", e.response.text)
        except Exception:
            body = e.response.text[:200]
        if status == 401:
            console.print(
                "[red]Authentication expired or invalid. Please login again:[/red]"
            )
            console.print("  zz login --email <email> --password <password>")
        elif status == 404:
            console.print(f"[red]Resource not found:[/red] {body}")
        else:
            console.print(f"[red]{msg} (HTTP {status}):[/red] {body}")
    elif isinstance(e, httpx.ConnectError):
        console.print(
            f"[red]Connection error:[/red] Could not reach {_get_base_url()}. "
            "Check your network and base URL."
        )
    elif isinstance(e, httpx.TimeoutException):
        console.print("[red]Request timed out.[/red] Please try again.")
    else:
        console.print(f"[red]{msg}:[/red] {e}")
    raise typer.Exit(1)


# ═══════════════════════════════════════════════════════════════════════════════
#  AUTH
# ═══════════════════════════════════════════════════════════════════════════════


@app.command()
def login(
    credential: Optional[str] = typer.Argument(
        None, help="Optional pasted JWT bearer token or agent API key"
    ),
    email: Optional[str] = typer.Option(
        None, "--email", "-e", help="User email for password login"
    ),
    password: Optional[str] = typer.Option(
        None, "--password", "-p", help="User password"
    ),
    base_url: str = typer.Option(
        DEFAULT_BASE_URL, "--base-url", help="API base URL"
    ),
) -> None:
    """Authenticate and store credentials locally."""
    if ZZClient is None:
        raise RuntimeError("SDK not available")

    client = ZZClient(base_url=base_url)
    try:
        if email or password:
            if not email or not password:
                console.print("[red]Use --email and --password together.[/red]")
                raise typer.Exit(1)
            token_resp = client.auth.login(email=email, password=password)
            stored_credential = token_resp.access_token
        elif credential:
            if credential.startswith("zzk_"):
                token_resp = client.auth.login(credential)
                stored_credential = credential
            else:
                stored_credential = credential
                token_resp = None
        else:
            console.print("[red]Provide --email/--password or paste a JWT token.[/red]")
            raise typer.Exit(1)

        access_token = getattr(token_resp, "access_token", None) if token_resp else stored_credential
        expires_at = str(getattr(token_resp, "expires_at", "")) if token_resp else ""
        user = getattr(token_resp, "user", None) if token_resp else None
        _save_config({
            "api_key": stored_credential,
            "access_token": access_token,
            "base_url": base_url,
            "expires_at": expires_at,
        })
        console.print("[green]✓ Logged in successfully[/green]")
        if expires_at:
            console.print(f"  Token expires at: {expires_at}")
        identity_path = _get_identity_path()
        _write_identity_file(
            _build_identity(
                base_url=base_url,
                user_token=access_token,
                user=dict(user) if isinstance(user, dict) else None,
            ),
            identity_path,
        )
        console.print(f"  Identity file: {identity_path}")
    except Exception as e:
        if isinstance(e, typer.Exit):
            raise
        _handle_error(e, "Login failed")


# ═══════════════════════════════════════════════════════════════════════════════
#  INIT — guided first-time setup
# ═══════════════════════════════════════════════════════════════════════════════


def _init_http(method: str, base_url: str, path: str, body: Optional[dict] = None,
               token: Optional[str] = None, timeout: float = 10.0) -> tuple[int, dict]:
    """Minimal urllib HTTP helper so `zz init` works without the SDK installed."""
    import urllib.request
    import urllib.error
    url = base_url.rstrip("/") + path
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {"detail": str(e)}
    except urllib.error.URLError as e:
        raise ConnectionError(f"Cannot reach {url}: {e.reason}")


@app.command()
def init(
    base_url: str = typer.Option(
        None, "--base-url", help="Platform base URL (e.g. http://192.168.1.10:18080/agent)"
    ),
    email: Optional[str] = typer.Option(None, "--email", "-e", help="Existing account email"),
    password: Optional[str] = typer.Option(None, "--password", "-p", help="Account password"),
    project_name: Optional[str] = typer.Option(None, "--project", help="Project name to create"),
    agent_name: Optional[str] = typer.Option(None, "--agent", help="Agent name to register"),
    capabilities: Optional[str] = typer.Option(
        None, "--capabilities",
        help="Comma-separated agent capabilities, e.g. 'code,docs,analysis'. If omitted, prompted interactively."
    ),
) -> None:
    """Guided first-time setup: connect to a platform, log in, create a project
    and an agent, then print how to keep the executor running.

    Fully interactive when options are omitted; fully scriptable when provided.
    """
    console.print("[bold cyan]zz init[/bold cyan] — guided platform setup\n")

    # 1. Platform base URL
    url = base_url or typer.prompt("Platform base URL", default=DEFAULT_BASE_URL)
    try:
        status, body = _init_http("GET", url, "/v1/health", timeout=8)
        if status == 200:
            console.print(f"  [green]✓[/green] Reachable (status={body.get('status')})")
        else:
            console.print(f"  [yellow]! Reachable but health returned {status}[/yellow]")
    except ConnectionError as e:
        console.print(f"  [red]✗ Cannot reach {url}[/red]")
        console.print(f"    {e}")
        console.print("    Start the platform first: [cyan]bash deploy/setup.sh[/cyan]")
        raise typer.Exit(1)
    # persist so subsequent zz commands target this platform
    config = _load_config()
    config["base_url"] = url
    _save_config(config)

    # 2. Authenticate (register or login)
    token = None
    user_info: dict = {}
    if email and password:
        # Non-interactive: try login first, fall back to register if the account
        # does not exist yet (covers both first-run and returning users).
        status, body = _init_http("POST", url, "/v1/auth/token", {"email": email, "password": password})
        if status == 200:
            token = body.get("access_token")
            user_info = body.get("user", {})
            console.print(f"  [green]✓[/green] Logged in as {user_info.get('display_name') or email}")
        else:
            uname = email.split("@")[0]
            status, body = _init_http("POST", url, "/v1/auth/register",
                                      {"email": email, "password": password, "username": uname})
            if status == 201:
                token = body.get("access_token")
                user_info = body.get("user", {})
                console.print(f"  [green]✓[/green] Registered as {user_info.get('display_name') or uname}")
            else:
                console.print(f"  [red]✗ Auth failed ({status}): {body.get('detail')}[/red]")
                raise typer.Exit(1)
        choice = "done"
    else:
        choice = typer.prompt("Account? (r)egister new / (l)ogin existing", default="l").strip().lower()

    if choice.startswith("r"):
        em = email or typer.prompt("Email")
        pw = password or typer.prompt("Password", hide_input=True, confirmation_prompt=True)
        uname = typer.prompt("Username", default=em.split("@")[0])
        status, body = _init_http("POST", url, "/v1/auth/register",
                                  {"email": em, "password": pw, "username": uname})
        if status != 201:
            console.print(f"  [red]✗ Register failed ({status}): {body.get('detail')}[/red]")
            raise typer.Exit(1)
        token = body.get("access_token")
        user_info = body.get("user", {})
        console.print(f"  [green]✓[/green] Registered as {user_info.get('display_name') or uname}")
    else:
        em = email or typer.prompt("Email")
        pw = password or typer.prompt("Password", hide_input=True)
        status, body = _init_http("POST", url, "/v1/auth/token", {"email": em, "password": pw})
        if status != 200:
            console.print(f"  [red]✗ Login failed ({status}): {body.get('detail')}[/red]")
            raise typer.Exit(1)
        token = body.get("access_token")
        user_info = body.get("user", {})
        console.print(f"  [green]✓[/green] Logged in as {user_info.get('display_name') or em}")

    config = _load_config()
    config["access_token"] = token
    config["api_key"] = token
    config["base_url"] = url
    _save_config(config)
    _write_identity_file(
        _build_identity(base_url=url, user_token=token, user=user_info),
        _get_identity_path(),
    )

    # 3. Project
    pid: Optional[str] = None
    create_proj = project_name is not None or typer.confirm("Create a project space?", default=True)
    if create_proj:
        pname = project_name or typer.prompt("Project name", default="my-project")
        status, body = _init_http("POST", url, "/v1/projects", {"name": pname}, token=token)
        if status in (200, 201):
            pid = body.get("id")
            console.print(f"  [green]✓[/green] Project: {pname} ({pid})")
            config["default_project"] = pid
            _save_config(config)
        else:
            console.print(f"  [yellow]! Project create returned {status}: {body.get('detail')}[/yellow]")

    # 4. Agent
    create_agent = agent_name is not None or typer.confirm("Register an agent now?", default=True)
    agent_key: Optional[str] = None
    if create_agent and pid:
        aname = agent_name or typer.prompt("Agent name", default="my-worker")
        caps_str = capabilities or typer.prompt(
            "Capabilities (comma-separated, e.g. code,docs,chat)", default="code"
        )
        caps = [c.strip() for c in caps_str.split(",") if c.strip()]
        agent_body: dict[str, Any] = {"name": aname}
        if caps:
            agent_body["capabilities"] = caps
        status, body = _init_http("POST", url, f"/v1/projects/{pid}/agents", agent_body, token=token)
        if status in (200, 201):
            agent_key = body.get("api_key")
            console.print(f"  [green]✓[/green] Agent: {aname} ({body.get('id')})")
            console.print(f"    [bold]API key:[/bold] {agent_key}")
            _write_identity_file(
                _build_identity(
                    base_url=url, user_token=token, user=user_info,
                    project={"id": pid}, agent={"id": body.get("id"), "name": aname, "project_id": pid},
                    agent_key=agent_key,
                ),
                _get_identity_path(),
            )
        else:
            console.print(f"  [yellow]! Agent create returned {status}: {body.get('detail')}[/yellow]")

    # 5. Next steps — executor keepalive guidance
    console.print("\n[bold]── Next: keep the executor alive ──[/bold]")
    plat = sys.platform
    key_arg = f"--api-key {agent_key}" if agent_key else "--api-key <your-agent-key>"
    if plat == "darwin":
        console.print("macOS (launchd):")
        console.print(f"  [cyan]zz agent executor {key_arg} --base-url {url}[/cyan]")
        console.print("  The daemon auto-generates and loads a launchd plist (KeepAlive).")
    elif plat.startswith("linux"):
        console.print("Linux (systemd):")
        console.print(f"  [cyan]zz agent executor {key_arg} --base-url {url}[/cyan]")
        console.print("  Or with nohup: [cyan]nohup zz agent executor {key_arg} --base-url {url} &[/cyan]")
    else:
        console.print(f"Platform {plat}:")
        console.print(f"  [cyan]nohup zz agent executor {key_arg} --base-url {url} &[/cyan]")
    console.print("\nThen dispatch work from the dashboard or: [cyan]zz orchestrations create --help[/cyan]")


# ═══════════════════════════════════════════════════════════════════════════════
#  IDENTITY
# ═══════════════════════════════════════════════════════════════════════════════



@identity_app.command("status")
def identity_status() -> None:
    """Show the current stored identity, including identity code for disambiguation.

    Shows the agent's identity code (the agent UUID) which is stable and unique,
    useful for distinguishing agents that share the same display name.
    """
    identity = _load_identity()
    if not identity:
        console.print("[yellow]No identity found.[/yellow]")
        console.print(
            "  Run 'zz login' or 'zz agents register' to create one, or\n"
            "  run 'zz identity export' to export a stored credential."
        )
        raise typer.Exit(1)

    platform = identity.get("platform", {})
    user = identity.get("user") or {}
    agent = identity.get("agent") or {}
    creds = identity.get("credentials", {}) or {}

    console.print("[bold]Identity[/bold]")
    console.print(f"  Schema:   {identity.get('schema', '—')}")
    console.print(f"  Platform: {platform.get('name', '—')}")
    console.print(f"  Base URL: {platform.get('base_url', '—')}")
    console.print()

    console.print("[bold]User[/bold]")
    console.print(f"  ID:          {user.get('id', '—')}")
    console.print(f"  Display name: {user.get('display_name') or user.get('username') or '—'}")
    console.print()

    console.print("[bold]Agent[/bold]")
    console.print(f"  Identity code (UUID): {agent.get('id', '—')}")
    console.print(f"  Name:               {agent.get('name', '—')}")
    console.print(f"  Project ID:         {agent.get('project_id', '—')}")
    console.print()

    console.print("[bold]Credentials[/bold]")
    has_token = bool(creds.get("user_token"))
    has_key = bool(creds.get("agent_key"))
    console.print(f"  user_token: {'[green]present[/green]' if has_token else '[dim]not set[/dim]'}")
    console.print(f"  agent_key:  {'[green]present[/green]' if has_key else '[dim]not set[/dim]'}")
    if has_key:
        key_val = creds.get("agent_key", "")
        key_str = f"{key_val[:6]}..." if len(key_val) > 8 else "***"
        console.print(f"            ({key_str})")
    console.print()
    console.print(f"[dim]Identity file: {_get_identity_path()}[/dim]")


@identity_app.command("list-agents")
def identity_list_agents() -> None:
    """List all agents owned by the current user across all projects.

    Shows each agent's identity code (stable UUID) which can be used to
    distinguish agents that share the same display name. Agents without a
    valid key are marked as [dim]revoked[/dim] or [dim]no key[/dim].
    """
    client = _get_client()
    try:
        user = client.auth.me()
    except Exception as e:
        _handle_error(e, "Failed to get current user")

    try:
        projects = client.projects.list()
    except Exception as e:
        _handle_error(e, "Failed to list projects")

    all_agents: list[tuple[str, str, str, str, str | None]] = []  # (project_name, agent_id, agent_name, api_key_prefix, status)

    for proj in projects:
        try:
            agents = client.agents.list(project_id=proj.id)
            for ag in agents:
                prefix = getattr(ag, "api_key_prefix", None) or (
                    getattr(ag, "api_key", None)[:6] if getattr(ag, "api_key", None) else None
                )
                status = "running" if getattr(ag, "status", None) == "running" else (
                    "idle" if getattr(ag, "status", None) == "idle" else
                    "offline" if getattr(ag, "status", None) in ("offline", "unknown") else
                    getattr(ag, "status", "unknown") or "unknown"
                )
                all_agents.append((proj.name, ag.id, ag.name, prefix, status))
        except Exception:
            pass

    if not all_agents:
        console.print("[yellow]No agents found for this user.[/yellow]")
        console.print("  Register an agent with 'zz agents register' or via the dashboard.")
        raise typer.Exit(0)

    table = Table(title="My Agents", title_style="bold")
    table.add_column("Identity Code", style="cyan", no_wrap=True)
    table.add_column("Name", style="bold")
    table.add_column("Project", style="dim")
    table.add_column("Key Prefix", style="dim")
    table.add_column("Status")

    # Track duplicate names
    name_counts: dict[str, int] = {}
    for _, _, name, _, _ in all_agents:
        name_counts[name] = name_counts.get(name, 0) + 1

    for proj_name, ag_id, ag_name, key_prefix, status in all_agents:
        status_color = {
            "running": "green",
            "idle": "blue",
            "offline": "dim",
            "error": "red",
        }.get(status, "white")
        prefix_str = key_prefix if key_prefix else "[dim]no key[/dim]"
        note = " [dim](use identity code to distinguish)[/dim]" if name_counts.get(ag_name, 0) > 1 else ""
        table.add_row(
            ag_id,
            ag_name + note,
            proj_name,
            prefix_str,
            f"[{status_color}]{status}[/{status_color}]",
        )
    console.print(table)
    console.print(
        "\n[dim]Tip: Identity codes (UUIDs) are stable and unique. Use them to[/dim]"
        "\n[dim]distinguish agents that share the same display name.[/dim]"
    )


@identity_app.command("path")
def identity_path() -> None:
    """Print the default local identity file path."""
    console.print(_get_identity_path())


@identity_app.command("export")
def identity_export(
    path: Optional[str] = typer.Option(
        None, "--path", help="Output path. Defaults to the OS standard identity path."
    ),
) -> None:
    """Export the current stored user token as an OpenClaw-readable identity file."""
    config = _load_config()
    token = config.get("access_token") or config.get("api_key")
    if not token:
        console.print("[red]No stored login. Run zz login first.[/red]")
        raise typer.Exit(1)
    target = _get_identity_path(path)
    _write_identity_file(
      _build_identity(base_url=_get_base_url(), user_token=token),
      target,
    )
    console.print(f"[green]✓ Identity file written:[/green] {target}")


# ═══════════════════════════════════════════════════════════════════════════════
#  PROJECTS
# ═══════════════════════════════════════════════════════════════════════════════


@projects_app.command("list")
def projects_list() -> None:
    """List all projects."""
    client = _get_client()
    try:
        projects = client.projects.list()
    except Exception as e:
        _handle_error(e, "Failed to list projects")

    if not projects:
        console.print("[yellow]No projects found.[/yellow]")
        return

    table = Table(title="Projects", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Name", style="bold")
    table.add_column("Description")
    table.add_column("Created")

    for p in projects:
        table.add_row(
            p.id,
            p.name,
            (p.description or "")[:50],
            p.created_at.strftime("%Y-%m-%d %H:%M") if hasattr(p, 'created_at') and p.created_at else "—",
        )
    console.print(table)


@projects_app.command("create")
def projects_create(
    name: str = typer.Option(..., "--name", "-n", help="Project name"),
    description: Optional[str] = typer.Option(
        None, "--description", "-d", help="Project description"
    ),
) -> None:
    """Create a new project."""
    client = _get_client()
    try:
        project = client.projects.create(name=name, description=description)
    except Exception as e:
        _handle_error(e, "Failed to create project")

    # Set as default project
    config = _load_config()
    config["default_project"] = project.id
    _save_config(config)

    console.print(f"[green]✓ Project created:[/green] {project.name} ({project.id})")


@projects_app.command("get")
def projects_get(
    project_id: str = typer.Argument(..., help="Project ID"),
) -> None:
    """Get project details."""
    client = _get_client()
    try:
        p = client.projects.get(project_id)
    except Exception as e:
        _handle_error(e, "Failed to get project")

    console.print(f"[bold]Name:[/bold] {p.name}")
    console.print(f"[bold]ID:[/bold] {p.id}")
    console.print(f"[bold]Description:[/bold] {p.description or '—'}")
    console.print(f"[bold]Owner:[/bold] {p.owner_id}")
    console.print(f"[bold]Created:[/bold] {p.created_at}")


@projects_app.command("clone")
def projects_clone(
    project_id: str = typer.Argument(..., help="Project ID to clone"),
    name: Optional[str] = typer.Option(None, "--name", "-n", help="New project name"),
    description: Optional[str] = typer.Option(None, "--description", "-d", help="New project description"),
    visibility: str = typer.Option("private", "--visibility", "-v", help="Visibility: private or public"),
) -> None:
    """Clone a public project or a project visible to the caller."""
    client = _get_client()
    try:
        project = client.project_space.clone_project(
            project_id=project_id,
            name=name,
            description=description,
            visibility=visibility,
        )
    except Exception as e:
        _handle_error(e, "Failed to clone project")

    console.print(f"[green]✓ Project cloned:[/green] {project.name} ({project.id})")


# ─── Project Files ───────────────────────────────────────────────────────────


@files_app.command("list")
def files_list(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    path_prefix: Optional[str] = typer.Option(None, "--path-prefix", help="Filter by path prefix"),
) -> None:
    """List project files."""
    client = _get_client()
    try:
        files = client.project_space.list_files(project_id=project_id, path_prefix=path_prefix)
    except Exception as e:
        _handle_error(e, "Failed to list files")

    if not files:
        console.print("[yellow]No files found in this project.[/yellow]")
        return

    table = Table(title=f"Files in {project_id}", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Path", style="bold")
    table.add_column("Type")
    table.add_column("Size")
    table.add_column("Updated")

    for f in files:
        table.add_row(
            f.id,
            f.path,
            f.content_type,
            str(f.size_bytes),
            f.updated_at.strftime("%Y-%m-%d %H:%M") if hasattr(f, "updated_at") and f.updated_at else "—",
        )
    console.print(table)


@files_app.command("upsert")
def files_upsert(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    path: str = typer.Option(..., "--path", help="File path within project"),
    content: str = typer.Option(..., "--content", "-c", help="File content"),
    content_type: str = typer.Option("text/markdown", "--type", "-t", help="Content type"),
    base_revision_id: Optional[str] = typer.Option(None, "--base-revision", help="Optimistic concurrency guard"),
    message: Optional[str] = typer.Option(None, "--message", "-m", help="Revision message"),
) -> None:
    """Create or update a project file."""
    client = _get_client()
    try:
        f = client.project_space.upsert_file(
            project_id=project_id,
            path=path,
            content=content,
            content_type=content_type,
            base_revision_id=base_revision_id,
            message=message,
        )
    except Exception as e:
        _handle_error(e, "Failed to upsert file")

    console.print(f"[green]✓ File upserted:[/green] {f.path} ({f.id})")


@files_app.command("get")
def files_get(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    file_id: str = typer.Argument(..., help="File ID"),
) -> None:
    """Get a project file with current content."""
    client = _get_client()
    try:
        f = client.project_space.get_file(project_id=project_id, file_id=file_id)
    except Exception as e:
        _handle_error(e, "Failed to get file")

    console.print(f"[bold]Path:[/bold] {f.path}")
    console.print(f"[bold]ID:[/bold] {f.id}")
    console.print(f"[bold]Type:[/bold] {f.content_type}")
    console.print(f"[bold]Size:[/bold] {f.size_bytes} bytes")
    console.print(f"[bold]Content:[/bold]")
    console.print(f.content)


@files_app.command("revisions")
def files_revisions(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    file_id: str = typer.Argument(..., help="File ID"),
) -> None:
    """List revisions for a project file."""
    client = _get_client()
    try:
        revisions = client.project_space.list_revisions(project_id=project_id, file_id=file_id)
    except Exception as e:
        _handle_error(e, "Failed to list revisions")

    if not revisions:
        console.print("[yellow]No revisions found.[/yellow]")
        return

    table = Table(title=f"Revisions for {file_id}", title_style="bold")
    table.add_column("Rev", style="dim", no_wrap=True)
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Message")
    table.add_column("Created")

    for r in revisions:
        table.add_row(
            str(r.revision_number),
            r.id,
            r.message or "—",
            r.created_at.strftime("%Y-%m-%d %H:%M") if hasattr(r, "created_at") and r.created_at else "—",
        )
    console.print(table)


# ─── Project Memories ────────────────────────────────────────────────────────


@memories_app.command("list")
def memories_list(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    agent_id: Optional[str] = typer.Option(None, "--agent", "-a", help="Filter by agent ID"),
    q: Optional[str] = typer.Option(None, "--query", help="Search query"),
) -> None:
    """List project memories."""
    client = _get_client()
    try:
        memories = client.project_space.list_memories(project_id=project_id, agent_id=agent_id, q=q)
    except Exception as e:
        _handle_error(e, "Failed to list memories")

    if not memories:
        console.print("[yellow]No memories found.[/yellow]")
        return

    table = Table(title=f"Memories in {project_id}", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Visibility")
    table.add_column("Tags")
    table.add_column("Content")
    table.add_column("Updated")

    for m in memories:
        content = m.content[:60] + "..." if len(m.content) > 60 else m.content
        tags = ", ".join(m.tags) if m.tags else "—"
        table.add_row(
            m.id,
            m.visibility,
            tags,
            content,
            m.updated_at.strftime("%Y-%m-%d %H:%M") if hasattr(m, "updated_at") and m.updated_at else "—",
        )
    console.print(table)


@memories_app.command("create")
def memories_create(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    content: str = typer.Option(..., "--content", "-c", help="Memory content"),
    agent_id: Optional[str] = typer.Option(None, "--agent", "-a", help="Scope to agent ID"),
    tags: Optional[str] = typer.Option(None, "--tags", help="Comma-separated tags"),
) -> None:
    """Create a project memory."""
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else None
    client = _get_client()
    try:
        m = client.project_space.create_memory(
            project_id=project_id,
            content=content,
            agent_id=agent_id,
            tags=tag_list,
        )
    except Exception as e:
        _handle_error(e, "Failed to create memory")

    console.print(f"[green]✓ Memory created:[/green] {m.id}")


# ─── Project Join Requests ───────────────────────────────────────────────────


@join_requests_app.command("list")
def join_requests_list(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    status: Optional[str] = typer.Option(None, "--status", "-s", help="Filter by status"),
) -> None:
    """List project join requests."""
    client = _get_client()
    try:
        requests = client.project_space.list_join_requests(project_id=project_id, status=status)
    except Exception as e:
        _handle_error(e, "Failed to list join requests")

    if not requests:
        console.print("[yellow]No join requests found.[/yellow]")
        return

    table = Table(title=f"Join Requests in {project_id}", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("User")
    table.add_column("Role")
    table.add_column("Status")
    table.add_column("Note")
    table.add_column("Created")

    for r in requests:
        user = r.user_display_name or r.user_email or r.user_id
        status_color = {
            "pending": "yellow",
            "approved": "green",
            "rejected": "red",
            "cancelled": "dim",
        }.get(r.status, "white")
        note = (r.note or "")[:30]
        table.add_row(
            r.id,
            user,
            r.requested_role,
            f"[{status_color}]{r.status}[/{status_color}]",
            note,
            r.created_at.strftime("%Y-%m-%d %H:%M") if hasattr(r, "created_at") and r.created_at else "—",
        )
    console.print(table)


@join_requests_app.command("create")
def join_requests_create(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    requested_role: str = typer.Option("member", "--role", "-r", help="Requested role: member or viewer"),
    note: Optional[str] = typer.Option(None, "--note", "-n", help="Optional note"),
) -> None:
    """Request to join a project."""
    client = _get_client()
    try:
        r = client.project_space.create_join_request(
            project_id=project_id,
            requested_role=requested_role,
            note=note,
        )
    except Exception as e:
        _handle_error(e, "Failed to create join request")

    console.print(f"[green]✓ Join request created:[/green] {r.id} ({r.status})")


@join_requests_app.command("review")
def join_requests_review(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    request_id: str = typer.Argument(..., help="Join request ID"),
    status: str = typer.Option(..., "--status", "-s", help="approved or rejected"),
    role: Optional[str] = typer.Option(None, "--role", "-r", help="Role to assign: admin, member, or viewer"),
) -> None:
    """Approve or reject a project join request."""
    client = _get_client()
    try:
        r = client.project_space.review_join_request(
            project_id=project_id,
            request_id=request_id,
            status=status,
            role=role,
        )
    except Exception as e:
        _handle_error(e, "Failed to review join request")

    console.print(f"[green]✓ Join request {status}:[/green] {r.id}")


# ─── File Proposals ──────────────────────────────────────────────────────────


@proposals_app.command("list")
def proposals_list(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    status: Optional[str] = typer.Option(None, "--status", "-s", help="Filter by status: pending, approved, rejected"),
    path: Optional[str] = typer.Option(None, "--path", help="Filter by file path"),
) -> None:
    """List file proposals for a project."""
    client = _get_client()
    try:
        proposals = client.project_space.list_file_proposals(project_id=project_id, status=status, path=path)
    except Exception as e:
        _handle_error(e, "Failed to list proposals")

    if not proposals:
        console.print("[yellow]No proposals found.[/yellow]")
        return

    table = Table(title=f"File Proposals in {project_id}", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Path", style="bold")
    table.add_column("Status")
    table.add_column("Creator")
    table.add_column("Title")
    table.add_column("Created")

    for p in proposals:
        status_color = {
            "pending": "yellow",
            "approved": "green",
            "rejected": "red",
        }.get(p.status, "white")
        creator = p.created_by_agent_id or p.created_by_user_id or "—"
        title = (p.title or "")[:30]
        table.add_row(
            p.id,
            p.path,
            f"[{status_color}]{p.status}[/{status_color}]",
            creator,
            title,
            p.created_at.strftime("%Y-%m-%d %H:%M") if hasattr(p, "created_at") and p.created_at else "—",
        )
    console.print(table)


@proposals_app.command("create")
def proposals_create(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    path: str = typer.Option(..., "--path", help="File path within project"),
    content: str = typer.Option(..., "--content", "-c", help="Proposed file content"),
    title: Optional[str] = typer.Option(None, "--title", "-t", help="Proposal title"),
    description: Optional[str] = typer.Option(None, "--description", "-d", help="Proposal description"),
    file_id: Optional[str] = typer.Option(None, "--file-id", help="Existing file ID"),
    base_revision_id: Optional[str] = typer.Option(None, "--base-revision", help="Base revision for concurrency guard"),
) -> None:
    """Create a file proposal. Agents use this to suggest Markdown changes."""
    client = _get_client()
    try:
        p = client.project_space.create_file_proposal(
            project_id=project_id,
            path=path,
            proposed_content=content,
            title=title,
            description=description,
            file_id=file_id,
            base_revision_id=base_revision_id,
        )
    except Exception as e:
        _handle_error(e, "Failed to create proposal")

    console.print(f"[green]✓ Proposal created:[/green] {p.id} ({p.status})")
    console.print(f"  Path: {p.path}")


@proposals_app.command("get")
def proposals_get(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    proposal_id: str = typer.Argument(..., help="Proposal ID"),
) -> None:
    """Get a file proposal with its full proposed content."""
    client = _get_client()
    try:
        p = client.project_space.get_file_proposal(project_id=project_id, proposal_id=proposal_id)
    except Exception as e:
        _handle_error(e, "Failed to get proposal")

    status_color = {
        "pending": "yellow",
        "approved": "green",
        "rejected": "red",
    }.get(p.status, "white")
    console.print(f"[bold]Path:[/bold] {p.path}")
    console.print(f"[bold]ID:[/bold] {p.id}")
    console.print(f"[bold]Status:[/bold] [{status_color}]{p.status}[/{status_color}]")
    if p.title:
        console.print(f"[bold]Title:[/bold] {p.title}")
    if p.description:
        console.print(f"[bold]Description:[/bold] {p.description}")
    if p.created_by_agent_id:
        console.print(f"[bold]Created by agent:[/bold] {p.created_by_agent_id}")
    if p.created_by_user_id:
        console.print(f"[bold]Created by user:[/bold] {p.created_by_user_id}")
    if p.reviewed_by:
        console.print(f"[bold]Reviewed by:[/bold] {p.reviewed_by}")
    console.print(f"[bold]Content:[/bold]")
    console.print(p.proposed_content)


@proposals_app.command("review")
def proposals_review(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    proposal_id: str = typer.Argument(..., help="Proposal ID"),
    status: str = typer.Option(..., "--status", "-s", help="approved or rejected"),
    message: Optional[str] = typer.Option(None, "--message", "-m", help="Optional review note"),
) -> None:
    """Approve or reject a file proposal (project owner/admin only)."""
    client = _get_client()
    try:
        p = client.project_space.review_file_proposal(
            project_id=project_id,
            proposal_id=proposal_id,
            status=status,
            message=message,
        )
    except Exception as e:
        _handle_error(e, "Failed to review proposal")

    console.print(f"[green]✓ Proposal {status}:[/green] {p.id}")


# ═══════════════════════════════════════════════════════════════════════════════
#  AGENTS
# ═══════════════════════════════════════════════════════════════════════════════


@agents_app.command("list")
def agents_list(
    project_id: str = typer.Option(
        ..., "--project", "-p", help="Project ID"
    ),
) -> None:
    """List all agents in a project."""
    client = _get_client()
    try:
        agents = client.agents.list(project_id=project_id)
    except Exception as e:
        _handle_error(e, "Failed to list agents")

    if not agents:
        console.print("[yellow]No agents found in this project.[/yellow]")
        return

    table = Table(title=f"Agents in {project_id}", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Name", style="bold")
    table.add_column("Status")
    table.add_column("Created")

    for a in agents:
        status_color = {
            "running": "green",
            "idle": "blue",
            "offline": "dim",
            "error": "red",
        }.get(a.status, "white")
        table.add_row(
            a.id,
            a.name,
            f"[{status_color}]{a.status}[/{status_color}]",
            a.created_at.strftime("%Y-%m-%d %H:%M") if hasattr(a, 'created_at') and a.created_at else "—",
        )
    console.print(table)


@agents_app.command("create")
def agents_create(
    project_id: str = typer.Option(
        ..., "--project", "-p", help="Project ID"
    ),
    name: str = typer.Option(..., "--name", "-n", help="Agent name"),
    system_prompt: Optional[str] = typer.Option(
        None, "--prompt", help="System prompt for the agent"
    ),
    runtime: Optional[str] = typer.Option(
        None, "--runtime", help="Agent runtime (informational)"
    ),
    endpoint_url: Optional[str] = typer.Option(
        None, "--endpoint-url", help="Runtime invoke endpoint URL"
    ),
    invoke_secret: Optional[str] = typer.Option(
        None, "--invoke-secret", help="Shared HMAC secret for runtime invoke"
    ),
) -> None:
    """Create a new agent in a project."""
    if bool(endpoint_url) != bool(invoke_secret):
        console.print("[red]Use --endpoint-url and --invoke-secret together.[/red]")
        raise typer.Exit(1)

    client = _get_client()
    try:
        agent = client.agents.create(
            project_id=project_id,
            name=name,
            system_prompt=system_prompt,
            endpoint_url=endpoint_url,
            invoke_secret=invoke_secret,
        )
    except Exception as e:
        _handle_error(e, "Failed to create agent")

    console.print(f"[green]✓ Agent created:[/green] {agent.name} ({agent.id})")
    if runtime:
        console.print(f"  Runtime: {runtime}")
    if endpoint_url:
        console.print(f"  Endpoint: {endpoint_url}")


@agents_app.command("rotate-key")
def agents_rotate_key(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    agent_id: str = typer.Argument(..., help="Agent ID"),
    identity_file: Optional[str] = typer.Option(
        None, "--identity-file", help="Update the local identity file with the new key."
    ),
) -> None:
    """Rotate an agent's API key. The old key is immediately and permanently invalid.

    The new key is shown exactly once in the CLI output. There is no way to
    recover or retrieve it after the rotation — save it to the local identity
    file immediately using --identity-file, then update the agent runtime.
    If the old key is lost, ask the project owner to rotate again."""
    client = _get_client()
    try:
        agent = client.agents.rotate_key(project_id=project_id, agent_id=agent_id)
    except Exception as e:
        _handle_error(e, "Failed to rotate agent key")

    console.print(f"[green]✓ Agent key rotated:[/green] {agent.name} ({agent.id})")
    console.print("  [dim]The old key is now permanently invalid.[/dim]")
    if agent.api_key:
        console.print(f"  New API key: [bold yellow]{agent.api_key}[/bold yellow]")
        console.print("  [dim]Save this key now — it won't be shown again.[/dim]")
        if identity_file:
            config = _load_config()
            target = _get_identity_path(identity_file)
            _write_identity_file(
                _build_identity(
                    base_url=_get_base_url(),
                    user_token=config.get("access_token") or config.get("api_key"),
                    project={"id": project_id},
                    agent={"id": agent.id, "name": agent.name, "project_id": project_id},
                    agent_key=agent.api_key,
                ),
                target,
            )
            console.print(f"  Identity file updated: {target}")
    else:
        console.print("  [dim]API key was not returned by the server.[/dim]")


@agents_app.command("revoke-key")
def agents_revoke_key(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    agent_id: str = typer.Argument(..., help="Agent ID"),
) -> None:
    """Revoke an agent's API key. The agent cannot authenticate until a new key is rotated."""
    client = _get_client()
    try:
        agent = client.agents.revoke_key(project_id=project_id, agent_id=agent_id)
    except Exception as e:
        _handle_error(e, "Failed to revoke agent key")

    console.print(f"[green]✓ Agent key revoked:[/green] {agent.name} ({agent.id})")
    console.print("  The old API key is no longer valid.")
    console.print("  To re-activate, run: zz agents rotate-key <agent-id>")


@agents_app.command("register")
def agents_register(
    project_id: str = typer.Option(
        ..., "--project", "-p", help="Project ID"
    ),
    name: str = typer.Option(..., "--name", "-n", help="Agent name"),
    endpoint_url: str = typer.Option(
        ..., "--endpoint-url", help="Full POST /zz/v1/invoke endpoint URL"
    ),
    invoke_secret: str = typer.Option(
        ..., "--invoke-secret", help="Shared HMAC secret for runtime invoke"
    ),
    system_prompt: Optional[str] = typer.Option(
        None, "--prompt", help="System prompt for the agent"
    ),
    identity_file: Optional[str] = typer.Option(
        None,
        "--identity-file",
        help="Where to save the agent identity JSON. Defaults to the OS standard path.",
    ),
    no_identity_file: bool = typer.Option(
        False,
        "--no-identity-file",
        help="Do not write the local OpenClaw identity JSON after registration.",
    ),
) -> None:
    """Register a V1 HTTP runtime agent."""
    client = _get_client()
    try:
        agent = client.agents.register(
            project_id=project_id,
            name=name,
            endpoint_url=endpoint_url,
            invoke_secret=invoke_secret,
            system_prompt=system_prompt,
        )
    except Exception as e:
        _handle_error(e, "Failed to register agent")

    console.print(f"[green]✓ Agent registered:[/green] {agent.name} ({agent.id})")
    console.print(f"  Endpoint: {endpoint_url}")
    agent_key = getattr(agent, "api_key", None)
    if agent_key and not no_identity_file:
        config = _load_config()
        target = _get_identity_path(identity_file)
        _write_identity_file(
            _build_identity(
                base_url=_get_base_url(),
                user_token=config.get("access_token") or config.get("api_key"),
                project={"id": project_id},
                agent={
                    "id": agent.id,
                    "name": agent.name,
                    "project_id": project_id,
                },
                agent_key=agent_key,
            ),
            target,
        )
        console.print(f"  Identity file: {target}")
    elif not agent_key:
        console.print("  Agent key was not returned; rotate/register again to export a full agent identity.")


# ═══════════════════════════════════════════════════════════════════════════════
#  SESSIONS
# ═══════════════════════════════════════════════════════════════════════════════


@sessions_app.command("list")
def sessions_list(
    project_id: str = typer.Option(
        ..., "--project", "-p", help="Project ID"
    ),
    status: Optional[str] = typer.Option(
        None, "--status", "-s", help="Filter by status (active/closed)"
    ),
) -> None:
    """List all sessions in a project."""
    client = _get_client()
    try:
        sessions = client.sessions.list(
            project_id=project_id, status=status
        )
    except Exception as e:
        _handle_error(e, "Failed to list sessions")

    if not sessions:
        console.print("[yellow]No sessions found in this project.[/yellow]")
        return

    table = Table(title=f"Sessions in {project_id}", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Title", style="bold")
    table.add_column("Status")
    table.add_column("Agents")
    table.add_column("Created")

    for s in sessions:
        status_color = "green" if s.status == "active" else "dim"
        agent_list = ", ".join(s.agent_ids) if s.agent_ids else "—"
        table.add_row(
            s.id,
            getattr(s, 'title', '') or "—",
            f"[{status_color}]{s.status}[/{status_color}]",
            agent_list,
            s.created_at.strftime("%Y-%m-%d %H:%M") if hasattr(s, 'created_at') and s.created_at else "—",
        )
    console.print(table)


@sessions_app.command("create")
def sessions_create(
    project_id: str = typer.Option(
        ..., "--project", "-p", help="Project ID"
    ),
    agents: str = typer.Option(
        ..., "--agents", "-a", help="Comma-separated agent IDs"
    ),
    title: Optional[str] = typer.Option(
        None, "--title", "-t", help="Session title"
    ),
) -> None:
    """Create a new session with specified agents."""
    agent_ids = [a.strip() for a in agents.split(",") if a.strip()]
    if not agent_ids:
        console.print("[red]At least one agent ID is required.[/red]")
        raise typer.Exit(1)

    client = _get_client()
    try:
        session = client.sessions.create(
            project_id=project_id,
            agent_ids=agent_ids,
            title=title,
        )
    except Exception as e:
        _handle_error(e, "Failed to create session")

    # Store as default session
    config = _load_config()
    config["default_session"] = session.id
    config["default_project"] = project_id
    _save_config(config)

    console.print(f"[green]✓ Session created:[/green] {session.id}")
    if title:
        console.print(f"  Title: {title}")
    console.print(f"  Agents: {', '.join(agent_ids)}")


@sessions_app.command("get")
def sessions_get(
    session_id: str = typer.Argument(..., help="Session ID"),
) -> None:
    """Get a session and show its participants."""
    client = _get_client()
    try:
        session = client.sessions.get(session_id)
    except Exception as e:
        _handle_error(e, "Failed to get session")

    console.print(f"[bold]Session:[/bold] {session.id}")
    console.print(f"[bold]Project:[/bold] {session.project_id}")
    console.print(f"[bold]Status:[/bold] {session.status}")
    if getattr(session, "title", None):
        console.print(f"[bold]Title:[/bold] {session.title}")

    participants = getattr(session, "participants", []) or []
    if participants:
        table = Table(title="Participants", title_style="bold")
        table.add_column("Participant ID", style="cyan", no_wrap=True)
        table.add_column("Type")
        table.add_column("Ref ID")
        table.add_column("Role")
        table.add_column("Status")
        for participant in participants:
            table.add_row(
                getattr(participant, "id", ""),
                getattr(participant, "participant_type", ""),
                getattr(participant, "ref_id", ""),
                getattr(participant, "role", ""),
                getattr(participant, "status", ""),
            )
        console.print(table)


@sessions_app.command("events")
def sessions_events(
    session_id: str = typer.Option(..., "--session", "-s", help="Session ID"),
    after_seq: Optional[int] = typer.Option(
        None, "--after-seq", help="Exclusive sequence cursor"
    ),
    limit: int = typer.Option(50, "--limit", "-l", help="Maximum events to fetch"),
) -> None:
    """Fetch append-only session events."""
    client = _get_client()
    try:
        events = client.sessions.events(
            session_id=session_id,
            after_seq=after_seq,
            limit=limit,
        )
    except Exception as e:
        _handle_error(e, "Failed to fetch events")

    if not events:
        console.print("[yellow]No events found.[/yellow]")
        return

    table = Table(title=f"Events in {session_id}", title_style="bold")
    table.add_column("Seq", style="dim", no_wrap=True)
    table.add_column("Type", style="cyan")
    table.add_column("Payload")
    for event in events:
        payload = json.dumps(event.payload, ensure_ascii=False)
        if len(payload) > 96:
            payload = payload[:93] + "..."
        table.add_row(str(event.seq), str(event.type), payload)
    console.print(table)


# ═══════════════════════════════════════════════════════════════════════════════
#  SEND (top-level command)
# ═══════════════════════════════════════════════════════════════════════════════


@app.command()
def send(
    session_id: str = typer.Option(
        ..., "--session", "-s", help="Session ID"
    ),
    message: str = typer.Option(
        ..., "--message", "-m", help="Message text"
    ),
    to: Optional[str] = typer.Option(
        None,
        "--to",
        help="Comma-separated recipient participant IDs. Omit for broadcast.",
    ),
    visibility: str = typer.Option(
        "session", "--visibility", help="Message visibility: session or direct"
    ),
    dispatch_ttl: Optional[int] = typer.Option(
        None, "--dispatch-ttl", help="Optional runtime propagation TTL"
    ),
    project_id: Optional[str] = typer.Option(
        None, "--project", "-p", help="Project ID (optional, uses default)"
    ),
) -> None:
    """Send a message to a session."""
    if visibility not in {"session", "direct"}:
        console.print("[red]--visibility must be 'session' or 'direct'.[/red]")
        raise typer.Exit(1)
    recipient_ids = [item.strip() for item in to.split(",") if item.strip()] if to else None
    client = _get_client()
    try:
        msg = client.sessions.send(
            session_id=session_id,
            message=message,
            recipient_participant_ids=recipient_ids,
            visibility=visibility,
            dispatch_ttl=dispatch_ttl,
            project_id=project_id,
        )
    except Exception as e:
        _handle_error(e, "Failed to send message")

    console.print(f"[green]✓ Message sent[/green] ({msg.id})")


# ═══════════════════════════════════════════════════════════════════════════════
#  STREAM (top-level command)
# ═══════════════════════════════════════════════════════════════════════════════


@app.command()
def stream(
    session_id: str = typer.Option(
        ..., "--session", "-s", help="Session ID to stream events from"
    ),
    project_id: Optional[str] = typer.Option(
        None, "--project", "-p", help="Project ID (optional, uses default)"
    ),
) -> None:
    """SSE real-time event stream for a session.

    Displays incoming events as they arrive using a live-updating panel.
    Press Ctrl+C to stop.
    """
    from zz_agent.models import EventType

    if ZZClient is None:
        raise RuntimeError("SDK not available")

    config = _load_config()
    api_key = os.environ.get("ZZ_API_KEY") or config.get("api_key")
    if not api_key:
        console.print("[red]Not authenticated. Run: zz login --email <email> --password <password>[/red]")
        raise typer.Exit(1)

    client = ZZClient(base_url=_get_base_url(), api_key=api_key)

    console.print(
        f"[bold]Streaming events for session {session_id}...[/bold]"
    )
    console.print("[dim]Press Ctrl+C to stop[/dim]\n")

    event_history: list[dict[str, Any]] = []

    def _generate_table() -> Table:
        table = Table(
            title=f"Session Events — {session_id[:12]}...",
            title_style="bold",
            box=None,
        )
        table.add_column("Seq", style="dim", width=5)
        table.add_column("Type", style="bold", width=22)
        table.add_column("Payload", width=70)
        for ev in event_history[-20:]:
            type_str = ev["type"]
            payload_str = ev["payload"]
            table.add_row(str(ev["seq"]), type_str, payload_str)
        return table

    try:
        with Live(auto_refresh=True, console=console) as live:
            for event in client.sessions.stream(session_id):
                type_str = (
                    event.type.value
                    if hasattr(event.type, "value")
                    else str(event.type)
                )

                type_color = {
                    EventType.MESSAGE_CREATED.value: "green",
                    EventType.SESSION_CREATED.value: "blue",
                    EventType.AGENT_JOINED.value: "cyan",
                    EventType.SESSION_ENDED.value: "red",
                    EventType.ERROR_OCCURRED.value: "red",
                    EventType.HEALTH_DEGRADED.value: "yellow",
                    EventType.HEALTH_RESOLVED.value: "green",
                }.get(type_str, "white")

                payload_str = json.dumps(event.payload, ensure_ascii=False)
                if len(payload_str) > 70:
                    payload_str = payload_str[:67] + "..."

                event_history.append({
                    "seq": event.seq,
                    "type": f"[{type_color}]{type_str}[/{type_color}]",
                    "payload": payload_str,
                })

                live.update(_generate_table())

    except KeyboardInterrupt:
        console.print("\n[dim]Stream stopped by user[/dim]")
    except Exception as e:
        _handle_error(e, "Stream error")


# ═══════════════════════════════════════════════════════════════════════════════
#  HEALTH
# ═══════════════════════════════════════════════════════════════════════════════


@health_app.callback(invoke_without_command=True)
def health(
    ctx: typer.Context,
    project_id: Optional[str] = typer.Option(
        None, "--project", "-p", help="Project ID"
    ),
    agent_id: Optional[str] = typer.Option(
        None, "--agent", "-a", help="Agent ID"
    ),
) -> None:
    """Check health status for a project or the whole platform."""
    if ctx.invoked_subcommand is not None:
        return
    _print_health(project_id=project_id, agent_id=agent_id)


@health_app.command("get")
def health_get(
    project_id: Optional[str] = typer.Option(
        None, "--project", "-p", help="Project ID"
    ),
    agent_id: Optional[str] = typer.Option(
        None, "--agent", "-a", help="Agent ID"
    ),
) -> None:
    """Get system, project, or agent health."""
    _print_health(project_id=project_id, agent_id=agent_id)


@health_app.command("report")
def health_report(
    agent_id: str = typer.Option(..., "--agent", "-a", help="Agent ID"),
    status: str = typer.Option("healthy", "--status", "-s", help="Agent status"),
    metric: Optional[list[str]] = typer.Option(
        None,
        "--metric",
        "-m",
        help="Metric as key=value. Repeat for multiple metrics.",
    ),
) -> None:
    """Report an agent heartbeat or health metrics."""
    metrics: dict[str, float] = {}
    for item in metric or []:
        if "=" not in item:
            console.print(f"[red]Invalid metric '{item}'. Use key=value.[/red]")
            raise typer.Exit(1)
        key, value = item.split("=", 1)
        try:
            metrics[key] = float(value)
        except ValueError:
            console.print(f"[red]Invalid metric value '{value}' for {key}.[/red]")
            raise typer.Exit(1)

    client = _get_client()
    try:
        result = client.health.report(
            agent_id=agent_id,
            status=status,
            metrics=metrics or None,
        )
    except Exception as e:
        _handle_error(e, "Failed to report health")

    console.print("[green]✓ Health reported[/green]")
    console.print_json(data=result)


def _print_health(
    project_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> None:
    client = _get_client()

    if project_id or agent_id:
        try:
            h = client.health.get(project_id=project_id, agent_id=agent_id)
        except Exception as e:
            _handle_error(e, "Failed to check health")

        status_color = {
            "healthy": "green",
            "degraded": "yellow",
            "down": "red",
        }.get(h.status, "white")

        console.print(
            f"[bold]Project Health:[/bold] "
            f"[{status_color}]{h.status}[/{status_color}]"
        )
        if hasattr(h, 'last_check') and h.last_check:
            console.print(f"[bold]Last Check:[/bold] {h.last_check}")
        if hasattr(h, 'metrics') and h.metrics:
            console.print("[bold]Metrics:[/bold]")
            for key, val in h.metrics.items():
                console.print(f"  {key}: {val}")
        if hasattr(h, 'agents') and h.agents:
            console.print_json(data=h.agents)
    else:
        try:
            h = client.health.system()
        except Exception as e:
            _handle_error(e, "Failed to check system health")

        status = h.get("status", "unknown")
        status_color = {
            "healthy": "green",
            "degraded": "yellow",
            "down": "red",
        }.get(status, "white")
        console.print(
            f"[bold]System Health:[/bold] "
            f"[{status_color}]{status}[/{status_color}]"
        )
        if "version" in h:
            console.print(f"[bold]Version:[/bold] {h['version']}")
        if "uptime_seconds" in h:
            console.print(f"[bold]Uptime:[/bold] {h['uptime_seconds']}s")


# ═══════════════════════════════════════════════════════════════════════════════
#  AGENT RUNTIME
# ═══════════════════════════════════════════════════════════════════════════════


@agent_app.command("projects")
def agent_projects() -> None:
    """Discover projects this agent is approved to access."""
    client = _get_agent_client()
    try:
        items = client.agent.projects()
    except Exception as e:
        _handle_error(e, "Failed to list agent projects")

    if not items:
        console.print("[yellow]No projects found for this agent.[/yellow]")
        return

    table = Table(title="Agent Projects", title_style="bold")
    table.add_column("Project ID", style="cyan", no_wrap=True)
    table.add_column("Project Name", style="bold")
    table.add_column("Agent ID", style="dim", no_wrap=True)
    table.add_column("Agent Name")
    table.add_column("Agent Status")
    table.add_column("Role")

    for item in items:
        project = getattr(item, "project", {}) or {}
        agent = getattr(item, "agent", {}) or {}
        status = getattr(agent, "status", "unknown") or "unknown"
        status_color = {
            "running": "green",
            "idle": "blue",
            "online": "green",
            "offline": "dim",
            "error": "red",
        }.get(status, "white")
        table.add_row(
            getattr(project, "id", ""),
            getattr(project, "name", ""),
            getattr(agent, "id", ""),
            getattr(agent, "name", ""),
            f"[{status_color}]{status}[/{status_color}]",
            getattr(item, "role", "agent"),
        )
    console.print(table)


def _derive_api_base(parsed: Any) -> str:
    """Map a public invite/dashboard URL to the platform API base URL.

    The CLI treats the invite host plus ``/agent`` as the deterministic API
    base path. For example ``https://example.com/agent-start.html?...`` maps
    to ``https://example.com/agent``. Pass ``--base-url`` to override.
    """
    return f"{parsed.scheme}://{parsed.netloc}/agent".rstrip("/")


def _parse_invite(invite: str) -> tuple[str, str, str, str]:
    """Parse project_id, project_name, requested_role, and API base URL from an invite URL or direct ID.

    Only the public invite parameters are parsed. Raw JWTs, agent keys, or other
    secrets are never accepted or propagated through an invite URL.
    """
    project_id = ""
    project_name = ""
    requested_role = ""
    invite_base_url = ""
    if invite.startswith(("http://", "https://")):
        parsed = urlparse(invite)
        qs = parse_qs(parsed.query)
        project_id = qs.get("project_id", [""])[0]
        project_name = unquote(qs.get("project_name", [""])[0])
        requested_role = qs.get("requested_role", [""])[0]
        invite_base_url = _derive_api_base(parsed)
    else:
        project_id = invite

    if requested_role not in ("member", "viewer"):
        requested_role = "member"
    return project_id, project_name, requested_role, invite_base_url


def _persist_join_context(
    base_url: str,
    project_id: str,
    project_name: Optional[str] = None,
    user_token: Optional[str] = None,
) -> None:
    """Persist the project/base URL context needed for later CLI commands.

    Writes ``~/.zz/config.json`` (``default_project``, ``base_url``) and the
    OS identity file. This is intentionally partial: an agent key is not
    included because owner approval/agent provisioning is still required.
    """
    config = _load_config()
    config["base_url"] = base_url
    config["default_project"] = project_id
    _save_config(config)

    identity_path = _get_identity_path()
    _write_identity_file(
        _build_identity(
            base_url=base_url,
            user_token=user_token or config.get("access_token") or config.get("api_key"),
            project={"id": project_id, "name": project_name} if project_name else {"id": project_id},
        ),
        identity_path,
    )


@agent_app.command("join")
def agent_join(
    invite: str = typer.Argument(..., help="Invite URL or project ID to join"),
    role: Optional[str] = typer.Option(
        None, "--role", "-r", help="Requested role: member or viewer (overrides invite URL; defaults to member)"
    ),
    note: Optional[str] = typer.Option(None, "--note", "-n", help="Optional note for the join request"),
    wait: bool = typer.Option(False, "--wait", "-w", help="Report the applicant-side wait limitation instead of polling"),
    wait_timeout: int = typer.Option(300, "--wait-timeout", help="Reserved for future approval polling; currently unused"),
    agent_name: Optional[str] = typer.Option(None, "--agent-name", help="Reserved for future agent registration after approval"),
    no_register: bool = typer.Option(False, "--no-register", help="Skip automatic agent registration after approval"),
    base_url: Optional[str] = typer.Option(None, "--base-url", help="Override API base URL"),
) -> None:
    """Join a project via invite link or project ID.

    Parses an invite URL or direct project ID, derives the API base URL from
    the invite host, checks membership, and submits a join request if needed.
    The project context is persisted to local config/identity so later agent
    commands do not need explicit IDs.

    Because agent keys are issued only after owner approval, the CLI reports
    that remaining step as an explicit platform blocker rather than fulfilled
    zero-prep onboarding.

    Examples::

        zz agent join "https://example.com/agent-start.html?intent=join&project_id=abc123&project_name=MyProject&requested_role=viewer"

        zz agent join abc123 --role member --note "Worker agent joining"
    """
    import httpx

    project_id, project_name, invite_role, invite_base_url = _parse_invite(invite)
    if not project_id:
        console.print("[red]Could not parse a project ID from the invite.[/red]")
        console.print("  Usage: zz agent join <invite-link-or-project-id>")
        raise typer.Exit(1)

    resolved_role = role or invite_role
    if resolved_role not in ("member", "viewer"):
        console.print("[red]Invalid role. Use --role member or --role viewer.[/red]")
        raise typer.Exit(1)

    # Authenticate with stored user credentials, using the invite host as the
    # API base when no explicit override or stored base URL is available.
    config = _load_config()
    token = config.get("access_token") or config.get("api_key") or os.environ.get("ZZ_API_KEY")
    if not token:
        console.print("[red]Not authenticated. Run: zz login --email <email> --password <password>[/red]")
        raise typer.Exit(1)

    resolved_base_url = (
        base_url
        or invite_base_url
        or os.environ.get("ZZ_BASE_URL")
        or config.get("base_url")
        or DEFAULT_BASE_URL
    )

    if ZZClient is None:
        console.print("[red]SDK not available.[/red]")
        raise typer.Exit(1)

    try:
        client = ZZClient(base_url=resolved_base_url, api_key=token)
    except Exception as e:
        console.print(f"[red]Authentication failed:[/red] {e}")
        console.print("  Run 'zz login' first, then retry the join command.")
        raise typer.Exit(1)

    display_name = project_name or project_id

    # Try to load the project
    try:
        project = client.projects.get(project_id)
        _persist_join_context(
            base_url=resolved_base_url,
            project_id=project.id,
            project_name=getattr(project, "name", None),
            user_token=token,
        )
        console.print(f"[green]✓ Already a member of project:[/green] {project.name} ({project.id})")
        console.print()
        console.print("[bold]Next steps:[/bold]")
        console.print("  1. View project agents:")
        console.print(f"     zz agents list --project {project.id}")
        console.print("  2. If you do not have an agent registered yet, register one:")
        console.print(f"     zz agents create --project {project.id} --name agent-$(whoami)")
        console.print("  3. After agent registration, start watching:")
        console.print("     zz agent watch --once --format prompt")
        console.print()
        console.print("[yellow]Platform blocker:[/yellow]")
        console.print("  Agent key registration still requires owner/admin approval and manual agent creation.")
        console.print("  Zero-prep onboarding is not complete until an agent key is provisioned for this project.")
        console.print()
        console.print("  Or visit the agent onboarding page:")
        console.print(f"     {resolved_base_url}/agent-start.html?project_id={project.id}")
        return
    except httpx.HTTPStatusError as e:
        if e.response.status_code not in (403, 404):
            _handle_error(e, "Failed to check project access")
            return
    except Exception as e:
        _handle_error(e, "Failed to check project access")
        return

    # Not a member — submit join request
    console.print(f"[yellow]You are not yet a member of project '{display_name}'.[/yellow]")
    console.print("  Submitting join request...")
    console.print()

    try:
        join_result = client.project_space.create_join_request(
            project_id=project_id,
            requested_role=resolved_role,
            note=note or f"Agent join request via CLI. Invite: {project_id}",
        )
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 409:
            pending_detail: dict[str, Any] = {}
            try:
                payload = e.response.json()
                if isinstance(payload, dict):
                    pending_detail = payload
            except Exception:
                pass

            _persist_join_context(
                base_url=resolved_base_url,
                project_id=project_id,
                project_name=project_name or None,
                user_token=token,
            )
            console.print("[yellow]A join request is already pending for this account.[/yellow]")
            console.print("  Status: [yellow]pending approval[/yellow]")
            console.print(f"  Project ID: {project_id}")
            if pending_detail.get("id"):
                console.print(f"  Request ID: {pending_detail['id']}")
            if pending_detail.get("requested_role"):
                console.print(f"  Requested role: {pending_detail['requested_role']}")
            if pending_detail.get("note"):
                console.print(f"  Note: {pending_detail['note']}")
            console.print()
            console.print("[yellow]Platform blocker:[/yellow]")
            console.print("  Agent key registration still requires owner approval.")
            console.print("  Zero-prep onboarding is not complete until an agent key is provisioned.")
            if wait:
                console.print()
                console.print("[bold]--wait limitation:[/bold] the applicant account cannot poll an owner-only join-request list route.")
                console.print("  Ask the project owner to approve the request, or check the dashboard later.")
            return
        _handle_error(e, "Failed to submit join request")
        return
    except Exception as e:
        _handle_error(e, "Failed to submit join request")
        return

    request_id = getattr(join_result, "id", None)
    _persist_join_context(
        base_url=resolved_base_url,
        project_id=project_id,
        project_name=project_name or None,
        user_token=token,
    )
    console.print("[green]✓ Join request submitted successfully![/green]")
    console.print()
    console.print(f"  Project ID: {project_id}")
    console.print(f"  Requested role: {resolved_role}")
    console.print(f"  Status: [yellow]pending[/yellow] (awaiting owner approval)")
    if request_id:
        console.print(f"  Request ID: {request_id}")
    console.print()
    console.print("[yellow]Platform blocker:[/yellow]")
    console.print("  Agent key registration still requires owner approval and manual agent creation.")
    console.print("  Zero-prep onboarding is not complete until an agent key is provisioned for this project.")
    console.print()

    if wait:
        console.print("[bold]--wait limitation:[/bold] the applicant account cannot poll an owner-only join-request list route.")
        console.print("  Ask the project owner to approve the request, or check the dashboard later.")
        return

    if no_register:
        console.print("[dim]--no-register was passed; skipping agent registration.[/dim]")
        return

    console.print("[bold]What happens next:[/bold]")
    console.print("  1. The project owner reviews your join request on the dashboard.")
    console.print("  2. Once approved, an owner/admin must create your agent:")
    console.print(f"     zz agents create --project {project_id} --name agent-$(whoami)")
    console.print("  3. After agent creation, store the agent key and start watching:")
    console.print("     zz agent watch --once --format prompt")
    console.print()
    console.print("[dim]Tip: If you are an owner/admin, review pending requests on the dashboard or with the owner-only join-requests list route.[/dim]")
    return


@agent_app.command("claim-next")
def agent_claim_next(
    project_id: Optional[str] = typer.Option(None, "--project", "-p", help="Override project_id"),
    orchestration_id: Optional[str] = typer.Option(None, "--orchestration", "-o", help="Override orchestration_id"),
) -> None:
    """Claim the most recent unclaimed task from local state."""
    from .agent_state import _find_next_dispatched_task, _update_task_state

    state = _find_next_dispatched_task()
    if not state:
        console.print("[yellow]No dispatched task found in local state.[/yellow]")
        console.print("  Run 'zz agent watch --once' to populate state.")
        raise typer.Exit(1)

    pid = project_id or state.get("project_id")
    oid = orchestration_id or state.get("orchestration_id")
    tid = state.get("task_id")
    if not pid or not oid or not tid:
        console.print("[red]Task state is missing project_id, orchestration_id, or task_id.[/red]")
        raise typer.Exit(1)

    client = _get_agent_client()
    try:
        task = client.orchestrations.claim_task(project_id=pid, orchestration_id=oid, task_id=tid)
    except Exception as e:
        _handle_error(e, "Failed to claim task")

    _update_task_state(tid, {"status": "running", "claimed_at": _iso_now()})
    console.print(f"[green]✓ Task claimed:[/green] {task.id}")
    console.print(f"  Status: {task.status}")


@agent_app.command("resume")
def agent_resume(
    claim: bool = typer.Option(
        True, "--claim/--no-claim",
        help="Re-claim tasks already in 'running' state (idempotent on the server).",
    ),
) -> None:
    """Resume unfinished work across sessions.

    Queries the server for tasks still assigned to this agent (via
    /v1/agent/assigned-tasks), writes them to local state so claim-next/submit
    can find them, optionally re-claims any already-running task, and prints a
    "to-do" list. Designed for the scenario: you joined a project, did some
    work, opened a NEW terminal — run this to pick up where you left off
    without re-logging in (your agent_key in the identity file is persistent).
    """
    from .agent_state import _write_task_state, _update_task_state

    client = _get_agent_client()
    try:
        tasks = client.agent.assigned_tasks()
    except Exception as e:
        _handle_error(e, "Failed to fetch assigned tasks")

    if not tasks:
        console.print("[green]✓ No unfinished tasks assigned to you.[/green]")
        console.print("  You're all caught up. Run 'zz agent watch' to await new work.")
        return

    resumed = 0
    for task in tasks:
        # Persist to local state so claim-next/submit/deliver can recover it.
        # _write_task_state reads task_id/title/goal/status; OrchestrationTask
        # uses `id` (not task_id), so adapt via a small shim object.
        class _StateShim:
            pass
        shim = _StateShim()
        for attr in ("project_id", "orchestration_id", "title", "goal", "status", "created_at"):
            setattr(shim, attr, getattr(task, attr, None))
        shim.task_id = task.id
        _write_task_state(shim)
        if task.status == "running" and claim:
            try:
                client.orchestrations.claim_task(
                    project_id=task.project_id,
                    orchestration_id=task.orchestration_id,
                    task_id=task.id,
                )
                _update_task_state(task.id, {"status": "running"})
            except Exception:
                # Idempotent: server rejects a double-claim; that's fine.
                pass
        resumed += 1
        status_color = "yellow" if task.status == "dispatched" else "cyan"
        console.print(f"[green]•[/green] [bold]{task.title}[/bold] [{status_color}]{task.status}[/]")
        console.print(f"  id={task.id}  orch={task.orchestration_id}")
        console.print(f"  goal: {task.goal}")
        if task.requested_changes:
            console.print(f"  [red]rework requested:[/red] {task.requested_changes}")
        console.print(f"  task file: {task.worker_task_path}")
        console.print(f"  context:   {task.worker_context_path}")

    if resumed > 0:
        console.print(
            f"\n[green]✓ Resumed {resumed} task(s).[/green] "
            "Execute them now:\n"
            "[dim]  1. zz agent inbox — ack the task notification[/dim]\n"
            "[dim]  2. zz tasks claim -p <pid> -o <oid> <tid> — claim[/dim]\n"
            "[dim]  3. Read goal + do the work[/dim]\n"
            "[dim]  4. zz agent submit --result @./result.md — submit[/dim]\n"
            "[dim]  Full guide: GET /v1/agent/execution-guide[/dim]"
        )
    else:
        console.print("[green]✓ No unfinished tasks assigned to you.[/green]")


@agent_app.command("inbox")
def agent_inbox(
    unread: bool = typer.Option(True, "--all/--unread", help="Show all items or only unread."),
    limit: int = typer.Option(50, "--limit", "-n"),
) -> None:
    """Show this agent's durable inbox (notifications + dispatched work).

    Each item references a task/orchestration when relevant. Use 'zz agent ack
    <inbox_id>' to acknowledge an item after handling it, or 'zz agent watch'
    for the continuous heartbeat + poll loop.
    """
    client = _get_agent_client()
    try:
        result = client.agent.inbox(unread=unread if unread else None, limit=limit)
    except Exception as e:
        _handle_error(e, "Failed to fetch inbox")

    items = getattr(result, "data", []) or []
    if not items:
        console.print("[green]✓ Inbox empty.[/green]")
        return
    console.print(f"[bold]Inbox ({len(items)} item(s)):[/bold]")
    for item in items:
        et = getattr(item, "event_type", "?")
        title = getattr(item, "title", "") or ""
        iid = getattr(item, "id", "")
        status = getattr(item, "status", "")
        tid = getattr(item, "task_id", None)
        console.print(f"  [{et}] {title}")
        console.print(f"    id={iid}  status={status}" + (f"  task={tid}" if tid else ""))


@agent_app.command("executor")
def agent_executor(
    handler: str = typer.Option("", "--handler", "-H", help="Command that executes each task (receives task JSON on stdin, outputs result on stdout). Bridges to the agent's own runtime/brain."),
    interval: int = typer.Option(30, "--interval", "-i", help="Seconds between execution cycles"),
    manual: bool = typer.Option(False, "--manual", help="Manual mode: print task, wait for you to type the result (interactive session)."),
    pm_only: bool = typer.Option(False, "--pm-only", help="Only run the PM review+merge loop."),
    worker_only: bool = typer.Option(False, "--worker-only", help="Only run the worker task loop."),
    headless: bool = typer.Option(False, "--headless", help="Built-in LLM fallback (ONLY for nodes with no brain of their own). Needs AGENT_LLM_API_KEY."),
    no_self_update: bool = typer.Option(False, "--no-self-update", help="Disable automatic re-download when the platform ships a newer executor.py."),
    once: bool = typer.Option(False, "--once", help="Run one cycle then exit"),
) -> None:
    """Start the executor daemon — a thin relay to the agent's own brain.

    This is the missing execution loop: inbox -> claim -> execute -> submit.
    The daemon itself is NOT an LLM. Real agents already have a model; this
    daemon just transports a task TO that model (via endpoint_url, --handler,
    or --manual) and the result back.

    If no execution source is configured, tasks are SURFACED but not claimed —
    no placeholders, no occupied outhouse. PM review (pure API calls) always runs.

    The daemon auto-updates: each cycle it checks the platform's published SHA of
    executor.py and, if newer, re-downloads and re-execs itself. So once an agent
    runs this version, it tracks platform changes forever with no manual poking.
    Disable with --no-self-update.

    Examples:
        zz agent executor                       # relay; uses agent endpoint_url if set
        zz agent executor --handler "python3 my_handler.py"
        zz agent executor --manual              # interactive
        zz agent executor --pm-only             # just review+merge as PM
        zz agent executor --once
    """
    base_url = _get_base_url()
    agent_key = os.environ.get("ZZ_AGENT_KEY") or _load_config().get("api_key") or ""
    if not agent_key:
        identity = _load_identity() if _get_identity_path() else {}
        agent_key = identity.get("credentials", {}).get("agent_key", "")
    if not agent_key:
        console.print("[red]No agent key found. Set ZZ_AGENT_KEY or configure identity.[/red]")
        raise typer.Exit(1)

    from zz_cli.executor import ExecutorDaemon
    daemon = ExecutorDaemon(
        base_url=base_url,
        api_key=agent_key,
        handler_cmd=handler,
        interval=interval,
        manual=manual,
        pm_only=pm_only,
        worker_only=worker_only,
        headless=headless,
        no_self_update=no_self_update,
    )
    if once:
        console.print("[bold]Running one cycle...[/bold]")
        daemon.run_cycle()
        console.print("[green]Done.[/green]")
    else:
        daemon.run()


@agent_app.command("submit")
def agent_submit(
    result: str = typer.Option(..., "--result", "-r", help="Result markdown content or @file path"),
    evidence: Optional[str] = typer.Option(None, "--evidence", "-e", help="Evidence JSON string or @file path"),
    status: str = typer.Option("ready_for_review", "--status", "-s", help="Completion status"),
    project_id: Optional[str] = typer.Option(None, "--project", "-p", help="Override project_id"),
    orchestration_id: Optional[str] = typer.Option(None, "--orchestration", "-o", help="Override orchestration_id"),
    task_id: Optional[str] = typer.Option(None, "--task", "-t", help="Override task_id (defaults to current running task)"),
) -> None:
    """Submit the current claimed task with result and optional evidence."""
    from .agent_state import _find_current_running_task, _get_task_state, _update_task_state

    tid = task_id
    state = None
    if not tid:
        state = _find_current_running_task()
        if not state:
            console.print("[yellow]No running task found in local state.[/yellow]")
            console.print("  Claim a task first with 'zz agent claim-next', or pass --task.")
            raise typer.Exit(1)
        tid = state.get("task_id")

    if not state:
        state = _get_task_state(tid) or {}

    pid = project_id or state.get("project_id")
    oid = orchestration_id or state.get("orchestration_id")
    if not pid or not oid or not tid:
        console.print("[red]Task context is missing project_id, orchestration_id, or task_id.[/red]")
        raise typer.Exit(1)

    result_content = _read_cli_file_arg(result)
    evidence_data = None
    if evidence:
        evidence_raw = _read_cli_file_arg(evidence)
        evidence_data = json.loads(evidence_raw)

    client = _get_agent_client()
    try:
        task = client.orchestrations.complete_task(
            project_id=pid,
            orchestration_id=oid,
            task_id=tid,
            result_md=result_content,
            status=status,
            evidence=evidence_data,
        )
    except Exception as e:
        _handle_error(e, "Failed to submit task")

    _update_task_state(tid, {"status": status, "submitted_at": _iso_now()})
    console.print(f"[green]✓ Task submitted:[/green] {task.id}")
    console.print(f"  Status: {task.status}")


@agent_app.command("state")
def agent_state(
    action: str = typer.Argument("list", help="Action: list or show"),
    task_id: Optional[str] = typer.Argument(None, help="Task ID for 'show'"),
) -> None:
    """List or show local agent task state files."""
    from .agent_state import _list_task_states, _get_task_state

    if action == "list":
        states = _list_task_states()
        if not states:
            console.print("[yellow]No task state files found.[/yellow]")
            return
        table = Table(title="Agent Task States", title_style="bold")
        table.add_column("Task ID", style="cyan", no_wrap=True)
        table.add_column("Status")
        table.add_column("Project ID", style="dim")
        table.add_column("Orchestration ID", style="dim")
        table.add_column("Title")
        for s in states:
            status_color = {
                "dispatched": "blue",
                "running": "yellow",
                "ready_for_review": "cyan",
                "approved": "green",
                "changes_requested": "red",
            }.get(s.get("status"), "white")
            table.add_row(
                s.get("task_id", "—"),
                f"[{status_color}]{s.get('status', '—')}[/{status_color}]",
                s.get("project_id", "—") or "—",
                s.get("orchestration_id", "—") or "—",
                s.get("title", "") or "—",
            )
        console.print(table)
    elif action == "show":
        if not task_id:
            console.print("[red]Usage: zz agent state show <task_id>[/red]")
            raise typer.Exit(1)
        s = _get_task_state(task_id)
        if not s:
            console.print(f"[yellow]No state found for task {task_id}.[/yellow]")
            raise typer.Exit(1)
        console.print_json(data=s)
    else:
        console.print(f"[red]Unknown action '{action}'. Use 'list' or 'show'.[/red]")
        raise typer.Exit(1)


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@agent_app.command("ack")
def agent_ack(
    inbox_id: str = typer.Argument(..., help="Inbox item ID to acknowledge"),
) -> None:
    """Acknowledge an inbox item so it is no longer returned as unread."""
    client = _get_agent_client()
    try:
        item = client.agent.ack_inbox(inbox_id=inbox_id)
    except Exception as e:
        _handle_error(e, "Failed to ack inbox item")

    console.print(f"[green]✓ Acknowledged:[/green] {getattr(item, 'id', inbox_id)}")
    console.print(f"  Status: {getattr(item, 'status', 'acked')}")


@agent_app.command("workload")
def agent_workload() -> None:
    """Inspect this agent's workload summary and recent units."""
    client = _get_agent_client()
    try:
        result = client.agent.workload()
    except Exception as e:
        _handle_error(e, "Failed to fetch workload")

    summary = getattr(result, "summary", None)
    if summary is not None:
        total = getattr(summary, "total_units", 0)
        completed = getattr(summary, "completed_units", 0)
        total_work = getattr(summary, "total_work", 0)
        console.print("[bold]Workload Summary[/bold]")
        console.print(f"  Total units:    {total}")
        console.print(f"  Completed:      {completed}")
        console.print(f"  Total work:     {total_work}")

    recent = getattr(result, "recent", []) or []
    if recent:
        table = Table(title="Recent Work", title_style="bold")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Source/Event")
        table.add_column("Task ID", style="dim")
        table.add_column("Status")
        table.add_column("Review")
        table.add_column("Work Units")
        table.add_column("Created")
        for unit in recent:
            unit_status = getattr(unit, "status", "")
            status_color = {
                "completed": "green",
                "running": "blue",
                "failed": "red",
                "pending": "yellow",
            }.get(unit_status, "white")
            table.add_row(
                getattr(unit, "id", ""),
                getattr(unit, "source_event", "") or "—",
                getattr(unit, "task_id", "") or "—",
                f"[{status_color}]{unit_status}[/{status_color}]",
                getattr(unit, "review_decision", "") or "—",
                str(getattr(unit, "normalized_work_units", "") or "—"),
                getattr(unit, "created_at", "") or "—",
            )
        console.print(table)
    elif not summary:
        console.print("[yellow]No workload data found.[/yellow]")


@agent_app.command("heartbeat")
def agent_heartbeat(
    status: Optional[str] = typer.Option(
        None, "--status", "-s", help="Status override (online, idle, etc.)"
    ),
) -> None:
    """Send a heartbeat to the platform."""
    client = _get_agent_client()
    try:
        result = client.agent.heartbeat(status=status)
    except Exception as e:
        _handle_error(e, "Failed to send heartbeat")

    pending = getattr(result, "pending_inbox_count", 0)
    console.print("[green]✓ Heartbeat sent[/green]")
    console.print(f"  Agent ID:   {getattr(result, 'agent_id', '—')}")
    console.print(f"  Status:     {getattr(result, 'status', '—')}")
    console.print(f"  Unread inbox: {pending}")
    if pending > 0:
        console.print("  [dim]Run `zz agent inbox` to view unread items.[/dim]")


def _resolve_agent_id() -> str:
    """Resolve the current agent's id via a heartbeat round-trip."""
    client = _get_agent_client()
    result = client.agent.heartbeat()
    agent_id = getattr(result, "agent_id", None)
    if not agent_id:
        console.print("[red]Could not resolve agent id from heartbeat.[/red]")
        raise typer.Exit(1)
    return agent_id


@agent_app.command("deliver")
def agent_deliver(
    local_path: str = typer.Argument(..., help="Local file path to deliver (or @path)"),
    remote_name: Optional[str] = typer.Option(
        None, "--as", help="Remote filename (default: same as local basename)"
    ),
    project_id: Optional[str] = typer.Option(None, "--project", "-p", help="Override project_id"),
) -> None:
    """Deliver a finished file into the project workspace (deliverables/<agent>/)."""
    # Read local file content (@path or plain path)
    src = local_path[1:] if local_path.startswith("@") else local_path
    if not os.path.isfile(src):
        console.print(f"[red]File not found: {src}[/red]")
        raise typer.Exit(1)
    with open(src, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    config = _load_config()
    pid = project_id or config.get("default_project")
    if not pid:
        # Try to infer from agent local state
        try:
            from .agent_state import _find_current_running_task
            st = _find_current_running_task()
            pid = st.get("project_id") if st else None
        except Exception:
            pid = None
    if not pid:
        console.print("[red]No project_id. Use --project or set a default project.[/red]")
        raise typer.Exit(1)

    agent_id = _resolve_agent_id()
    basename = remote_name or os.path.basename(src)
    remote_path = f"deliverables/{agent_id}/{basename}"

    client = _get_agent_client()
    try:
        # agent client uses X-API-Key; upsert_file POSTs to /files which now
        # accepts agent keys scoped to deliverables/.
        client.project_space.upsert_file(project_id=pid, path=remote_path, content=content, message=f"delivered by agent {agent_id}")
    except Exception as e:
        _handle_error(e, "Failed to deliver file")

    console.print(f"[green]✓ Delivered:[/green] {basename}")
    console.print(f"  Remote path: {remote_path}")
    console.print(f"  Size: {len(content)} chars")
    console.print("  [dim]Visible in the project workspace.[/dim]")


@agent_app.command("progress")
def agent_progress(
    task_id: str = typer.Argument(..., help="Task ID this progress note belongs to"),
    note: str = typer.Option(..., "--note", "-n", help="Progress note text"),
    project_id: Optional[str] = typer.Option(None, "--project", "-p", help="Override project_id"),
) -> None:
    """Append a progress note for a task (deliverables/<agent>/<task>/PROGRESS.md)."""
    config = _load_config()
    pid = project_id or config.get("default_project")
    if not pid:
        try:
            from .agent_state import _get_task_state
            st = _get_task_state(task_id)
            pid = st.get("project_id") if st else None
        except Exception:
            pid = None
    if not pid:
        console.print("[red]No project_id. Use --project or set a default project.[/red]")
        raise typer.Exit(1)

    agent_id = _resolve_agent_id()
    remote_path = f"deliverables/{agent_id}/{task_id}/PROGRESS.md"
    ts = _iso_now()

    client = _get_agent_client()
    # Read existing PROGRESS.md (if any) to append
    existing = ""
    try:
        files = client.project_space.list_files(project_id=pid, path_prefix=remote_path)
        if files:
            existing = getattr(files[0], "content", "") or ""
    except Exception:
        pass

    entry = f"\n## {ts}\n\n{note.strip()}\n"
    new_content = (existing.rstrip() + "\n" + entry) if existing else f"# Progress: {task_id}\n{entry}"

    try:
        client.project_space.upsert_file(project_id=pid, path=remote_path, content=new_content, message=f"progress by agent {agent_id}")
    except Exception as e:
        _handle_error(e, "Failed to record progress")

    console.print(f"[green]✓ Progress recorded:[/green] {task_id}")
    console.print(f"  Remote path: {remote_path}")
    console.print(f"  Note: {note.strip()[:80]}")


def _watch_lock_path() -> str:
    return os.path.join(_zz_home(), "watch.lock")


def _acquire_watch_lock() -> bool:
    """Try to acquire a local lock to prevent duplicate watch loops.

    Robust against crashes: if a stale lock file exists but its PID is no longer
    alive (the previous watch crashed/was killed), the lock is reclaimed. Without
    this, a launchd/systemd KeepAlive relaunch after a crash would self-deadlock
    on the leftover lock and exit.
    """
    lock_path = _watch_lock_path()
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    # If a lock exists, check whether its PID is still alive; reclaim if not.
    if os.path.exists(lock_path):
        try:
            with open(lock_path) as f:
                holder_pid = int((f.read() or "0").strip())
            if holder_pid and _pid_alive(holder_pid):
                return False  # a live watch is genuinely running
            # Stale lock from a crashed process — remove and reclaim.
            os.unlink(lock_path)
        except (OSError, ValueError):
            # Unreadable/corrupt lock — reclaim.
            try:
                os.unlink(lock_path)
            except OSError:
                pass
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w") as f:
            f.write(str(os.getpid()))
        return True
    except FileExistsError:
        return False


def _pid_alive(pid: int) -> bool:
    """True if a process with the given PID is currently running."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)  # signal 0 = existence check
        return True
    except OSError:
        return False


def _release_watch_lock() -> None:
    """Release the local watch lock (only if we still own it)."""
    lock_path = _watch_lock_path()
    try:
        with open(lock_path) as f:
            holder_pid = int((f.read() or "0").strip())
        # Only remove if it's ours; avoid clobbering a newer watch's lock.
        if holder_pid == os.getpid():
            os.unlink(lock_path)
    except (OSError, ValueError):
        pass


def _redact_secret(value: str | None, visible: int = 4) -> str:
    """Redact a secret to avoid printing it in full."""
    if not value:
        return "—"
    if len(value) <= visible * 2:
        return "***"
    return f"{value[:visible]}...{value[-visible:]}"


def _format_watch_prompt(item: Any) -> str:
    """Format a watch output item as a stable prompt text block."""
    lines: list[str] = [
        "---",
        f"inbox_id: {getattr(item, 'inbox_id', '')}",
        f"event_type: {getattr(item, 'event_type', '')}",
    ]
    project_id = getattr(item, "project_id", None)
    project_name = getattr(item, "project_name", None)
    if project_id:
        lines.append(f"project_id: {project_id}")
    if project_name:
        lines.append(f"project_name: {project_name}")
    task_id = getattr(item, "task_id", None)
    orch_id = getattr(item, "orchestration_id", None)
    if task_id:
        lines.append(f"task_id: {task_id}")
    if orch_id:
        lines.append(f"orchestration_id: {orch_id}")
    required_action = getattr(item, "required_action", "")
    if required_action:
        lines.append(f"required_action: {required_action}")
    title = getattr(item, "title", None)
    if title:
        lines.append(f"title: {title}")
    body = getattr(item, "body", None)
    if body:
        lines.append(f"body: {body}")
    lines.append("instruction: >")
    lines.append("  Complete or review this item using the platform task APIs.")
    lines.append("  Do NOT use social chat for task completion or review.")
    lines.append("---")
    return "\n".join(lines)


@agent_app.command("watch")
def agent_watch(
    interval: int = typer.Option(
        30, "--interval", "-i", help="Polling interval in seconds"
    ),
    max_items: int = typer.Option(
        50, "--max-items", "-n", help="Maximum inbox items to process per tick"
    ),
    format_: str = typer.Option(
        "prompt", "--format", "-f", help="Output format: prompt or json"
    ),
    once: bool = typer.Option(
        False, "--once", help="Run a single tick and exit"
    ),
    no_ack: bool = typer.Option(
        False, "--no-ack", help="Skip acking inbox items (debug only)"
    ),
    agent_id: Optional[str] = typer.Option(
        None, "--agent", "-a", help="Optional agent ID to validate against"
    ),
    project_id: Optional[str] = typer.Option(
        None, "--project", "-p", help="Optional project filter"
    ),
    write_state: bool = typer.Option(
        True, "--write-state/--no-write-state", help="Write task state files for dispatched/assigned items (default: True)"
    ),
) -> None:
    """Run the P1.5 agent watch loop: heartbeat, poll inbox, emit output, ack.

    Emits a stable prompt/json contract for actionable inbox items.
    Acknowledges items only after successful output.
    Never auto-completes or auto-reviews tasks.
    Never prints raw JWTs, agent keys, NAS credentials, or full identity secrets.

    Minimum usage::

        zz agent watch --once --format prompt
        zz agent watch --once --format json --write-state

    Press Ctrl+C to stop.
    """
    if format_ not in ("prompt", "json"):
        console.print("[red]--format must be 'prompt' or 'json'[/red]")
        raise typer.Exit(1)

    if not once:
        if not _acquire_watch_lock():
            console.print(
                "[red]Another watch loop is already running.[/red]"
            )
            console.print(
                f"  Lock file: {_watch_lock_path()}"
            )
            console.print(
                "  Use --once for a single tick, or stop the other process first."
            )
            raise typer.Exit(1)
        try:
            _run_watch_loop(
                interval=interval,
                max_items=max_items,
                format_=format_,
                ack=not no_ack,
                agent_id=agent_id,
                project_id=project_id,
                write_state=write_state,
            )
        finally:
            _release_watch_lock()
    else:
        _run_watch_tick(
            format_=format_,
            ack=not no_ack,
            agent_id=agent_id,
            project_id=project_id,
            max_items=max_items,
            write_state=write_state,
        )


def _stderr_console() -> Console:
    return Console(file=sys.stderr, stderr=True)


def _discover_projects_and_workload(
    client: Any,
    err_console: Console,
    format_: str,
) -> tuple[list[Any], Any | None]:
    """Discover projects and workload for the agent. Diagnostics go to stderr only."""
    projects: list[Any] = []
    workload_result: Any | None = None
    try:
        projects = client.agent.projects()
        if projects:
            names = ", ".join(
                getattr(p, "project", {}).name or getattr(p, "project", {}).id or "?"
                for p in projects
            )
            err_console.print(f"[dim]projects | {len(projects)} approved: {names}[/dim]")
        else:
            err_console.print("[yellow]No approved project membership found.[/yellow]")
            err_console.print(
                "  [dim]The agent key has no approved project. Ask a project "
                "owner to approve a join request or register this agent in a project.[/dim]"
            )
    except Exception as e:
        if format_ != "json":
            err_console.print(f"[yellow]Project discovery failed (may be transient): {e}[/yellow]")

    try:
        workload_result = client.agent.workload()
        summary = getattr(workload_result, "summary", None)
        if summary is not None:
            err_console.print(
                f"[dim]workload  | units={getattr(summary, 'total_units', 0)} "
                f"completed={getattr(summary, 'completed_units', 0)} "
                f"total_work={getattr(summary, 'total_work', 0)}[/dim]"
            )
    except Exception as e:
        if format_ != "json":
            err_console.print(f"[yellow]Workload fetch failed (may be transient): {e}[/yellow]")

    return projects, workload_result


def _run_watch_tick(
    format_: str,
    ack: bool,
    agent_id: Optional[str],
    project_id: Optional[str],
    max_items: int,
    write_state: bool = False,
) -> None:
    """Execute a single watch tick and emit output."""
    from .agent_state import _write_task_state

    client = _get_agent_client()
    err_console = _stderr_console()

    # Discover projects and workload context on each --once tick
    _discover_projects_and_workload(client, err_console, format_)

    try:
        result = client.agent.watch(
            project_id=project_id,
            agent_id=agent_id,
            max_items=max_items,
            ack=ack,
        )
    except Exception as e:
        if format_ == "json":
            json.dump({"error": str(e)}, sys.stdout)
            sys.stdout.write("\n")
            sys.stdout.flush()
            raise typer.Exit(1)
        _handle_error(e, "Watch tick failed")

    hb = result.heartbeat

    # Non-JSON diagnostics always go to stderr
    if hb.agent_id:
        err_console.print(
            f"[dim]heartbeat | agent={hb.agent_id} status={hb.status} "
            f"pending={hb.pending_inbox_count}[/dim]"
        )

    if result.errors:
        for err in result.errors:
            err_console.print(f"[red]Error:[/red] {err}")

    items = result.items
    if not items:
        if format_ == "prompt":
            err_console.print("[dim]No actionable inbox items.[/dim]")
        else:
            json.dump({"heartbeat": {"agent_id": hb.agent_id, "status": hb.status, "pending_inbox_count": hb.pending_inbox_count}, "items": [], "acked": result.acked, "errors": result.errors}, sys.stdout)
            sys.stdout.write("\n")
            sys.stdout.flush()
        return

    if format_ == "json":
        payload = {
            "heartbeat": {
                "agent_id": hb.agent_id,
                "status": hb.status,
                "pending_inbox_count": hb.pending_inbox_count,
            },
            "items": [item.model_dump(mode="json") for item in items],
            "acked": result.acked,
            "errors": result.errors,
        }
        json.dump(payload, sys.stdout, default=str)
        sys.stdout.write("\n")
        sys.stdout.flush()
    else:
        for item in items:
            console.print(_format_watch_prompt(item))
            if item.inbox_id in result.acked:
                console.print(f"[dim]  -> acked {item.inbox_id}[/dim]")

    if write_state:
        for item in items:
            event_type = getattr(item, "event_type", "") or ""
            if "task" in event_type.lower() or getattr(item, "task_id", None):
                try:
                    path = _write_task_state(item)
                    err_console.print(f"[dim]  -> state written {path}[/dim]")
                except Exception as e:
                    err_console.print(f"[yellow]State write failed for item {getattr(item, 'inbox_id', '?')}: {e}[/yellow]")


def _run_watch_loop(
    interval: int,
    max_items: int,
    format_: str,
    ack: bool,
    agent_id: Optional[str],
    project_id: Optional[str],
    write_state: bool = False,
) -> None:
    """Run the watch loop until interrupted."""
    from .agent_state import _write_task_state

    client = _get_agent_client()
    err_console = _stderr_console()
    _first_tick = True

    # Banner always to stderr so stdout stays clean
    err_console.print("[bold]zz agent watch[/bold]")
    err_console.print(f"  Interval:  {interval}s")
    err_console.print(f"  Format:    {format_}")
    err_console.print(f"  Ack:       {ack}")
    if agent_id:
        err_console.print(f"  Agent ID:  {agent_id}")
    if project_id:
        err_console.print(f"  Project:   {project_id}")
    err_console.print("[dim]Press Ctrl+C to stop[/dim]")
    err_console.print()

    try:
        _watch_failures = 0
        while True:
            tick = time.time()

            # On first tick, discover projects and workload for startup context
            if _first_tick:
                _first_tick = False
                _discover_projects_and_workload(client, err_console, format_)

            try:
                result = client.agent.watch(
                    project_id=project_id,
                    agent_id=agent_id,
                    max_items=max_items,
                    ack=ack,
                )
            except Exception as e:
                ts = time.strftime("%H:%M:%S")
                err_console.print(f"[{ts}] [red]Watch failed:[/red] {e}")
                # Exponential backoff on repeated failures (caps at 5min) so a
                # long network outage / platform restart doesn't hammer the API.
                _watch_failures += 1
                backoff = min(interval * (2 ** min(_watch_failures - 1, 6)), 300)
                if _watch_failures > 1:
                    err_console.print(f"[{ts}] retry in {int(backoff)}s (attempt {_watch_failures})")
                time.sleep(backoff)
                continue

            # Success: reset the failure counter.
            _watch_failures = 0
            hb = result.heartbeat
            ts = time.strftime("%H:%M:%S")
            err_console.print(
                f"[{ts}] heartbeat | agent={hb.agent_id or '—'} "
                f"status={hb.status} pending={hb.pending_inbox_count}"
            )

            if result.errors:
                for err in result.errors:
                    err_console.print(f"[{ts}] [red]Error:[/red] {err}")

            for item in result.items:
                if format_ == "json":
                    payload = {
                        "item": item.model_dump(mode="json"),
                        "acked": item.inbox_id in result.acked,
                    }
                    json.dump(payload, sys.stdout, default=str)
                    sys.stdout.write("\n")
                    sys.stdout.flush()
                else:
                    console.print(_format_watch_prompt(item))
                    if item.inbox_id in result.acked:
                        console.print(f"[dim]  -> acked {item.inbox_id}[/dim]")

                if write_state:
                    event_type = getattr(item, "event_type", "") or ""
                    if "task" in event_type.lower() or getattr(item, "task_id", None):
                        try:
                            path = _write_task_state(item)
                            err_console.print(f"[dim]  -> state written {path}[/dim]")
                        except Exception as e:
                            err_console.print(f"[yellow]State write failed for item {getattr(item, 'inbox_id', '?')}: {e}[/yellow]")

            elapsed = time.time() - tick
            sleep_time = max(1.0, interval - elapsed)
            time.sleep(sleep_time)
    except KeyboardInterrupt:
        err_console.print("\n[dim]Watch loop stopped.[/dim]")


@agent_app.command("autostart")
def agent_autostart(
    action: str = typer.Argument("install", help="install | uninstall | status"),
    interval: int = typer.Option(30, "--interval", "-i", help="Heartbeat/watch interval seconds"),
) -> None:
    """Install/uninstall an OS-level auto-restart so the agent survives terminal
    close, crashes, and reboots.

    - macOS: writes a launchd LaunchAgent (KeepAlive + RunAtLoad) and loads it.
    - Linux: writes a systemd user unit (Restart=always) and enables it.

    Once installed, `zz agent watch` runs detached and is relaunched on crash or
    login. Logs go to ~/.zz/autostart.{out,err}.log. Remove with `autostart uninstall`.
    """
    import platform
    system = platform.system()
    home = os.path.expanduser("~")
    label = "xyz.zhuzeyang.zz-agent-watch"

    if action == "status":
        _autostart_status(system, label, home)
        return

    # Resolve the zz executable + identity so the unit invokes the right binary.
    # The OS daemon runs in a minimal environment (no shell PATH/PYTHONPATH), so
    # when zz isn't pip-installed we invoke the project's python with -m and pass
    # PYTHONPATH via the launchd/systemd environment so the SDK + CLI are found.
    zz_bin = shutil.which("zz")
    if zz_bin:
        run_args = [zz_bin, "agent", "watch", "--interval", str(interval)]
        python_path_env = None
    else:
        cli_dir = os.path.dirname(os.path.abspath(__file__))                 # .../cli/zz_cli
        repo_cli = os.path.dirname(cli_dir)                                  # .../cli
        sdk_src = os.path.normpath(os.path.join(repo_cli, "..", "sdk", "python", "src"))
        python_path_env = os.pathsep.join(p for p in [sdk_src, repo_cli] if os.path.isdir(p))
        # OS daemons (launchd/systemd) often don't honor PYTHONPATH reliably,
        # so generate a tiny wrapper shell script that exports it then execs
        # the interpreter running the CLI module. Robust across minimal envs.
        wrapper_path = os.path.join(_zz_home(), "autostart-run.sh")
        with open(wrapper_path, "w") as wf:
            wf.write("#!/bin/sh\n")
            wf.write(f"export PYTHONPATH={shlex.quote(python_path_env or '')}\n")
            wf.write(f"exec {shlex.quote(sys.executable)} -m zz_cli.main agent watch --interval {interval}\n")
        os.chmod(wrapper_path, 0o755)
        run_args = ["/bin/sh", wrapper_path]
    run_cmd = " ".join(shlex.quote(a) for a in run_args)

    zz_home = _zz_home()
    os.makedirs(zz_home, exist_ok=True)
    out_log = os.path.join(zz_home, "autostart.out.log")
    err_log = os.path.join(zz_home, "autostart.err.log")

    if action == "uninstall":
        _autostart_uninstall(system, label, home)
        console.print(f"[green]✓ Autostart removed ({system}).[/green]")
        return

    if action != "install":
        console.print(f"[red]Unknown action '{action}'. Use install | uninstall | status.[/red]")
        raise typer.Exit(1)

    # Verify we have credentials before installing (otherwise the daemon would
    # spin up and immediately exit on "No agent credential found").
    try:
        _get_agent_client()
    except Exception:
        console.print("[red]No agent credential found. Run 'zz agent join <invite>' or 'zz login' first.[/red]")
        raise typer.Exit(1)

    # Capture the credentials/endpoint currently in use so the detached daemon
    # authenticates without any shell config (launchd/systemd start clean).
    env_for_unit: dict[str, str] = {"PATH": "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"}
    if python_path_env:
        env_for_unit["PYTHONPATH"] = python_path_env
    if os.environ.get("ZZ_BASE_URL"):
        env_for_unit["ZZ_BASE_URL"] = os.environ["ZZ_BASE_URL"]
    if os.environ.get("ZZ_AGENT_KEY"):
        env_for_unit["ZZ_AGENT_KEY"] = os.environ["ZZ_AGENT_KEY"]
    else:
        # Persist the agent_key from the identity/config so the daemon uses the
        # same agent even if ZZ_AGENT_KEY wasn't set in this shell.
        cfg = _load_config()
        ident_path = _get_identity_path()
        identity = _load_identity() if ident_path and os.path.exists(ident_path) else {}
        agent_key = (os.environ.get("ZZ_AGENT_KEY")
                     or cfg.get("api_key")
                     or identity.get("credentials", {}).get("agent_key"))
        if agent_key:
            env_for_unit["ZZ_AGENT_KEY"] = agent_key

    if system == "Darwin":
        plist_dir = os.path.join(home, "Library", "LaunchAgents")
        os.makedirs(plist_dir, exist_ok=True)
        plist_path = os.path.join(plist_dir, f"{label}.plist")
        env_xml = "\n".join(f"    <key>{k}</key><string>{v}</string>" for k, v in env_for_unit.items())
        plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{''.join(f'    <string>{a}</string>' for a in run_args)}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{out_log}</string>
  <key>StandardErrorPath</key><string>{err_log}</string>
  <key>EnvironmentVariables</key>
  <dict>
{env_xml}
  </dict>
</dict>
</plist>
"""
        with open(plist_path, "w") as f:
            f.write(plist)
        # Unload (if previously loaded) then load.
        subprocess.run(["launchctl", "unload", plist_path], capture_output=True)
        r = subprocess.run(["launchctl", "load", plist_path], capture_output=True)
        console.print(f"[green]✓ Installed launchd agent:[/green] {plist_path}")
        console.print(f"  KeepAlive=true (relaunch on crash), RunAtLoad=true (start at login).")
        console.print(f"  Logs: {out_log} / {err_log}")
        console.print(f"  Uninstall: zz agent autostart uninstall")
    elif system == "Linux":
        unit_dir = os.path.join(home, ".config", "systemd", "user")
        os.makedirs(unit_dir, exist_ok=True)
        unit_path = os.path.join(unit_dir, "zz-agent-watch.service")
        env_lines = "\n".join(f"Environment={k}={v}" for k, v in env_for_unit.items() if k != "PATH")
        unit = f"""[Unit]
Description=zz-agent watch (auto-restart agent runtime)
After=network-online.target

[Service]
ExecStart={run_cmd}
{env_lines}
Restart=always
RestartSec=10
StandardOutput=append:{out_log}
StandardError=append:{err_log}

[Install]
WantedBy=default.target
"""
        with open(unit_path, "w") as f:
            f.write(unit)
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", "zz-agent-watch.service"], capture_output=True)
        console.print(f"[green]✓ Installed systemd user unit:[/green] {unit_path}")
        console.print(f"  Restart=always (relaunch on crash), WantedBy=default.target (start at login).")
        console.print(f"  Logs: {out_log} / {err_log}")
        console.print(f"  Uninstall: zz agent autostart uninstall")
    else:
        console.print(f"[red]Autostart not supported on {system}. Run 'zz agent watch' manually (or via nohup).[/red]")
        raise typer.Exit(1)


def _autostart_uninstall(system: str, label: str, home: str) -> None:
    if system == "Darwin":
        plist_path = os.path.join(home, "Library", "LaunchAgents", f"{label}.plist")
        subprocess.run(["launchctl", "unload", plist_path], capture_output=True)
        try:
            os.unlink(plist_path)
        except OSError:
            pass
    elif system == "Linux":
        subprocess.run(["systemctl", "--user", "disable", "--now", "zz-agent-watch.service"], capture_output=True)
        try:
            os.unlink(os.path.join(home, ".config", "systemd", "user", "zz-agent-watch.service"))
        except OSError:
            pass
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)


def _autostart_status(system: str, label: str, home: str) -> None:
    if system == "Darwin":
        plist_path = os.path.join(home, "Library", "LaunchAgents", f"{label}.plist")
        loaded = subprocess.run(["launchctl", "list", label], capture_output=True)
        installed = os.path.exists(plist_path)
        running = loaded.returncode == 0
        console.print(f"  Installed: {'✅' if installed else '❌'} ({plist_path})")
        console.print(f"  Loaded:    {'✅' if running else '❌'}")
    elif system == "Linux":
        r = subprocess.run(["systemctl", "--user", "is-active", "zz-agent-watch.service"], capture_output=True)
        state = r.stdout.decode().strip() or "unknown"
        console.print(f"  systemd unit: {state}")
    else:
        console.print(f"  Unsupported on {system}")


# ═══════════════════════════════════════════════════════════════════════════════
#  ORCHESTRATIONS
# ═══════════════════════════════════════════════════════════════════════════════


@orchestrations_app.command("create")
def orchestrations_create(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    title: str = typer.Option(..., "--title", "-t", help="Orchestration title"),
    objective: str = typer.Option(..., "--objective", "-o", help="Orchestration objective"),
    worker_agent_ids: Optional[str] = typer.Option(
        None, "--workers", "-w", help="Comma-separated worker agent IDs"
    ),
    main_agent_id: Optional[str] = typer.Option(
        None, "--main-agent", "-m", help="Main agent ID (defaults to calling agent)"
    ),
    plan: Optional[str] = typer.Option(None, "--plan", help="Plan markdown text"),
    base_path: Optional[str] = typer.Option(None, "--base-path", help="Base path for orchestration files"),
    create_session: bool = typer.Option(True, "--create-session/--no-session", help="Create a session for the orchestration"),
    acceptance_criteria: Optional[str] = typer.Option(
        None, "--criteria", "-c", help="Comma-separated acceptance criteria"
    ),
    metadata_json: Optional[str] = typer.Option(
        None, "--metadata", help="JSON metadata string"
    ),
) -> None:
    """Create a new orchestration."""
    workers = [w.strip() for w in worker_agent_ids.split(",") if w.strip()] if worker_agent_ids else None
    criteria = [c.strip() for c in acceptance_criteria.split(",") if c.strip()] if acceptance_criteria else None
    metadata = json.loads(metadata_json) if metadata_json else None

    client = _get_client()
    try:
        orch = client.orchestrations.create(
            project_id=project_id,
            title=title,
            objective=objective,
            worker_agent_ids=workers,
            main_agent_id=main_agent_id,
            plan=plan,
            base_path=base_path,
            create_session=create_session,
            acceptance_criteria=criteria,
            metadata=metadata,
        )
    except Exception as e:
        _handle_error(e, "Failed to create orchestration")

    console.print(f"[green]✓ Orchestration created:[/green] {orch.id}")
    console.print(f"  Title: {orch.title}")
    console.print(f"  Status: {orch.status}")
    if orch.paths and orch.paths.goal:
        console.print(f"  Goal: {orch.paths.goal}")


@orchestrations_app.command("list")
def orchestrations_list(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    status: Optional[str] = typer.Option(None, "--status", "-s", help="Filter by status"),
) -> None:
    """List orchestrations in a project."""
    client = _get_client()
    try:
        orchs = client.orchestrations.list(project_id=project_id, status=status)
    except Exception as e:
        _handle_error(e, "Failed to list orchestrations")

    if not orchs:
        console.print("[yellow]No orchestrations found.[/yellow]")
        return

    table = Table(title=f"Orchestrations in {project_id}", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Title", style="bold")
    table.add_column("Status")
    table.add_column("Main Agent", style="dim")
    table.add_column("Created")

    for o in orchs:
        status_color = {
            "planning": "yellow",
            "running": "blue",
            "ready_for_acceptance": "green",
            "completed": "green",
            "blocked": "red",
            "failed": "red",
        }.get(o.status, "white")
        table.add_row(
            o.id,
            o.title,
            f"[{status_color}]{o.status}[/{status_color}]",
            o.main_agent_id or "—",
            o.created_at.strftime("%Y-%m-%d %H:%M") if hasattr(o, "created_at") and o.created_at else "—",
        )
    console.print(table)


@orchestrations_app.command("get")
def orchestrations_get(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Argument(..., help="Orchestration ID"),
) -> None:
    """Get an orchestration with its tasks."""
    client = _get_client()
    try:
        orch = client.orchestrations.get(project_id=project_id, orchestration_id=orchestration_id)
    except Exception as e:
        _handle_error(e, "Failed to get orchestration")

    status_color = {
        "planning": "yellow",
        "running": "blue",
        "ready_for_acceptance": "green",
        "completed": "green",
        "blocked": "red",
        "failed": "red",
    }.get(orch.status, "white")

    console.print(f"[bold]Title:[/bold] {orch.title}")
    console.print(f"[bold]ID:[/bold] {orch.id}")
    console.print(f"[bold]Status:[/bold] [{status_color}]{orch.status}[/{status_color}]")
    console.print(f"[bold]Objective:[/bold] {orch.objective}")
    if orch.main_agent_id:
        console.print(f"[bold]Main Agent:[/bold] {orch.main_agent_id}")
    if orch.paths:
        console.print(f"[bold]Paths:[/bold]")
        console.print(f"  Goal: {orch.paths.goal}")
        console.print(f"  Plan: {orch.paths.plan}")
        console.print(f"  Tasks: {orch.paths.tasks}")

    tasks = orch.tasks or []
    if tasks:
        table = Table(title="Tasks", title_style="bold")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Title", style="bold")
        table.add_column("Status")
        table.add_column("Assigned Agent", style="dim")
        for t in tasks:
            tstatus_color = {
                "pending": "yellow",
                "dispatched": "blue",
                "running": "blue",
                "ready_for_review": "cyan",
                "approved": "green",
                "changes_requested": "red",
                "blocked": "red",
                "failed": "red",
            }.get(t.get("status", ""), "white")
            table.add_row(
                t.get("id", ""),
                t.get("title", ""),
                f"[{tstatus_color}]{t.get('status', '')}[/{tstatus_color}]",
                t.get("assigned_agent_id") or "—",
            )
        console.print(table)


@orchestrations_app.command("complete")
def orchestrations_complete(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Argument(..., help="Orchestration ID"),
    summary: Optional[str] = typer.Option(None, "--summary", help="Completion summary"),
) -> None:
    """Complete an orchestration after all tasks are approved."""
    client = _get_client()
    try:
        orch = client.orchestrations.complete(
            project_id=project_id,
            orchestration_id=orchestration_id,
            summary=summary,
        )
    except Exception as e:
        _handle_error(e, "Failed to complete orchestration")

    console.print(f"[green]✓ Orchestration completed:[/green] {orch.id}")
    console.print(f"  Status: {orch.status}")


# ═══════════════════════════════════════════════════════════════════════════════
#  TASKS
# ═══════════════════════════════════════════════════════════════════════════════


@tasks_app.command("create")
def tasks_create(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Option(..., "--orchestration", "-o", help="Orchestration ID"),
    title: str = typer.Option(..., "--title", "-t", help="Task title"),
    goal: str = typer.Option(..., "--goal", "-g", help="Task goal"),
    assigned_agent_id: Optional[str] = typer.Option(
        None, "--agent", "-a", help="Assigned worker agent ID"
    ),
    acceptance_criteria: Optional[str] = typer.Option(
        None, "--criteria", "-c", help="Comma-separated acceptance criteria"
    ),
    depends_on: Optional[str] = typer.Option(
        None, "--depends-on", help="Comma-separated task IDs this task depends on"
    ),
    scope: Optional[str] = typer.Option(None, "--scope", help="Task scope description"),
    context: Optional[str] = typer.Option(None, "--context", help="Worker context text"),
    dispatch: bool = typer.Option(True, "--dispatch/--no-dispatch", help="Dispatch immediately"),
) -> None:
    """Create and optionally dispatch a task within an orchestration."""
    criteria = [c.strip() for c in acceptance_criteria.split(",") if c.strip()] if acceptance_criteria else None
    deps = [d.strip() for d in depends_on.split(",") if d.strip()] if depends_on else None

    client = _get_client()
    try:
        task = client.orchestrations.create_task(
            project_id=project_id,
            orchestration_id=orchestration_id,
            title=title,
            goal=goal,
            assigned_agent_id=assigned_agent_id,
            acceptance_criteria=criteria,
            depends_on=deps,
            scope=scope,
            context=context,
            dispatch=dispatch,
        )
    except Exception as e:
        _handle_error(e, "Failed to create task")

    console.print(f"[green]✓ Task {'dispatched' if dispatch else 'created'}:[/green] {task.id}")
    console.print(f"  Title: {task.title}")
    console.print(f"  Status: {task.status}")
    if task.assigned_agent_id:
        console.print(f"  Assigned: {task.assigned_agent_id}")


@tasks_app.command("list")
def tasks_list(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Option(..., "--orchestration", "-o", help="Orchestration ID"),
) -> None:
    """List tasks in an orchestration."""
    client = _get_client()
    try:
        tasks = client.orchestrations.list_tasks(
            project_id=project_id,
            orchestration_id=orchestration_id,
        )
    except Exception as e:
        _handle_error(e, "Failed to list tasks")

    if not tasks:
        console.print("[yellow]No tasks found.[/yellow]")
        return

    table = Table(title=f"Tasks in {orchestration_id}", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Title", style="bold")
    table.add_column("Status")
    table.add_column("Assigned Agent", style="dim")
    table.add_column("Created")

    for t in tasks:
        status_color = {
            "pending": "yellow",
            "dispatched": "blue",
            "running": "blue",
            "ready_for_review": "cyan",
            "approved": "green",
            "changes_requested": "red",
            "blocked": "red",
            "failed": "red",
        }.get(t.status, "white")
        table.add_row(
            t.id,
            t.title,
            f"[{status_color}]{t.status}[/{status_color}]",
            t.assigned_agent_id or "—",
            t.created_at.strftime("%Y-%m-%d %H:%M") if hasattr(t, "created_at") and t.created_at else "—",
        )
    console.print(table)


@tasks_app.command("get")
def tasks_get(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Option(..., "--orchestration", "-o", help="Orchestration ID"),
    task_id: str = typer.Argument(..., help="Task ID"),
) -> None:
    """Get a task by ID."""
    client = _get_client()
    try:
        task = client.orchestrations.get_task(
            project_id=project_id,
            orchestration_id=orchestration_id,
            task_id=task_id,
        )
    except Exception as e:
        _handle_error(e, "Failed to get task")

    status_color = {
        "pending": "yellow",
        "dispatched": "blue",
        "running": "blue",
        "ready_for_review": "cyan",
        "approved": "green",
        "changes_requested": "red",
        "blocked": "red",
        "failed": "red",
    }.get(task.status, "white")

    console.print(f"[bold]Title:[/bold] {task.title}")
    console.print(f"[bold]ID:[/bold] {task.id}")
    console.print(f"[bold]Status:[/bold] [{status_color}]{task.status}[/{status_color}]")
    console.print(f"[bold]Goal:[/bold] {task.goal}")
    if task.assigned_agent_id:
        console.print(f"[bold]Assigned Agent:[/bold] {task.assigned_agent_id}")
    if task.worker_task_path:
        console.print(f"[bold]Task File:[/bold] {task.worker_task_path}")
    if task.result_path:
        console.print(f"[bold]Result File:[/bold] {task.result_path}")
    if task.evidence_path:
        console.print(f"[bold]Evidence File:[/bold] {task.evidence_path}")


@tasks_app.command("claim")
def tasks_claim(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Option(..., "--orchestration", "-o", help="Orchestration ID"),
    task_id: str = typer.Argument(..., help="Task ID"),
) -> None:
    """Claim a task (worker agent only)."""
    client = _get_client()
    try:
        task = client.orchestrations.claim_task(
            project_id=project_id,
            orchestration_id=orchestration_id,
            task_id=task_id,
        )
    except Exception as e:
        _handle_error(e, "Failed to claim task")

    console.print(f"[green]✓ Task claimed:[/green] {task.id}")
    console.print(f"  Status: {task.status}")


@tasks_app.command("complete")
def tasks_complete(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Option(..., "--orchestration", "-o", help="Orchestration ID"),
    task_id: str = typer.Argument(..., help="Task ID"),
    result_md: str = typer.Option(..., "--result", "-r", help="Result markdown content or @file path"),
    status: str = typer.Option("ready_for_review", "--status", "-s", help="Completion status"),
    evidence_json: Optional[str] = typer.Option(None, "--evidence", "-e", help="Evidence JSON string or @file path"),
) -> None:
    """Submit a completed task with result and evidence."""
    result_content = _read_cli_file_arg(result_md)
    evidence = None
    if evidence_json:
        evidence_raw = _read_cli_file_arg(evidence_json)
        evidence = json.loads(evidence_raw)

    client = _get_client()
    try:
        task = client.orchestrations.complete_task(
            project_id=project_id,
            orchestration_id=orchestration_id,
            task_id=task_id,
            result_md=result_content,
            status=status,
            evidence=evidence,
        )
    except Exception as e:
        _handle_error(e, "Failed to complete task")

    console.print(f"[green]✓ Task completed:[/green] {task.id}")
    console.print(f"  Status: {task.status}")


@tasks_app.command("review")
def tasks_review(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Option(..., "--orchestration", "-o", help="Orchestration ID"),
    task_id: str = typer.Argument(..., help="Task ID"),
    decision: str = typer.Option(..., "--decision", "-d", help="approved or changes_requested"),
    notes: Optional[str] = typer.Option(None, "--notes", "-n", help="Notes markdown content or @file path"),
    requested_changes: Optional[str] = typer.Option(
        None, "--requested-changes", help="Requested changes content or @file path"
    ),
) -> None:
    """Review a completed task (main agent or PM only)."""
    notes_content = _read_cli_file_arg(notes) if notes else None
    requested_changes_content = _read_cli_file_arg(requested_changes) if requested_changes else None

    client = _get_client()
    try:
        task = client.orchestrations.review_task(
            project_id=project_id,
            orchestration_id=orchestration_id,
            task_id=task_id,
            decision=decision,
            notes=notes_content,
            requested_changes=requested_changes_content,
        )
    except Exception as e:
        _handle_error(e, "Failed to review task")

    console.print(f"[green]✓ Task {decision}:[/green] {task.id}")
    if task.review_notes:
        console.print(f"  Notes: {task.review_notes}")


@tasks_app.command("reassign")
def tasks_reassign(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Option(..., "--orchestration", "-o", help="Orchestration ID"),
    task_id: str = typer.Argument(..., help="Task ID to reassign"),
    new_agent_id: str = typer.Option(..., "--to", help="New agent ID to assign the task to"),
    reason: str = typer.Option("", "--reason", "-r", help="Reason for reassignment"),
) -> None:
    """Reassign a stalled task to a different worker (PM only)."""
    client = _get_client()
    try:
        task = client.orchestrations.reassign_task(
            project_id=project_id,
            orchestration_id=orchestration_id,
            task_id=task_id,
            new_agent_id=new_agent_id,
            reason=reason or None,
        )
    except Exception as e:
        _handle_error(e, "Failed to reassign task")
    console.print(f"[green]✓ Task reassigned:[/green] {task.id}")
    console.print(f"  New assignee: {new_agent_id}")
    console.print(f"  Status: {task.status}")


@agent_app.command("assigned-tasks")
def agent_assigned_tasks(
    status: Optional[str] = typer.Option(None, "--status", "-s", help="Filter by status (running/dispatched/changes_requested)"),
) -> None:
    """List tasks assigned to this agent that are not yet terminal.

    One-stop view for a worker: shows all tasks assigned to the caller whose
    work is still owed. Use --status to filter (e.g. changes_requested to see rework).
    """
    client = _get_agent_client()
    try:
        tasks = client.agent.assigned_tasks(status=status)
    except Exception as e:
        _handle_error(e, "Failed to fetch assigned tasks")
    if not tasks:
        console.print("[green]✓ No unfinished tasks assigned to you.[/green]")
        return
    console.print(f"[bold]Your tasks ({len(tasks)}):[/bold]")
    for t in tasks:
        st_color = "yellow" if t.status == "dispatched" else "cyan" if t.status == "running" else "red"
        console.print(f"  [{st_color}]{t.status}[/] [bold]{t.title}[/]")
        console.print(f"    id={t.id}  goal={t.goal[:60] if t.goal else ''}")
        if t.requested_changes:
            console.print(f"    [red]rework:[/red] {t.requested_changes[:80]}")
        console.print(f"    task file: {t.worker_task_path}")
        console.print()


# ═══════════════════════════════════════════════════════════════════════════════
#  CHANGESETS
# ═══════════════════════════════════════════════════════════════════════════════


@changesets_app.command("create")
def changesets_create(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    title: str = typer.Option(..., "--title", "-t", help="Changeset title"),
    file_ops_json: str = typer.Option("", "--file-ops", help="File operations JSON or @file path"),
    from_git_diff: bool = typer.Option(False, "--from-git-diff", help="Generate file_ops from local git diff (staged + unstaged)"),
    description: Optional[str] = typer.Option(None, "--description", "-d", help="Changeset description"),
    status: str = typer.Option("submitted", "--status", "-s", help="draft or submitted"),
    base_commit_id: Optional[str] = typer.Option(None, "--base-commit", help="Base commit ID"),
    result_path: Optional[str] = typer.Option(None, "--result-path", help="Path to result markdown"),
    evidence_path: Optional[str] = typer.Option(None, "--evidence-path", help="Path to evidence JSON"),
    orchestration_id: Optional[str] = typer.Option(None, "--orchestration", "-o", help="Linked orchestration ID"),
    task_id: Optional[str] = typer.Option(None, "--task", help="Linked task ID"),
) -> None:
    """Create a new changeset with file operations.

    Use --from-git-diff to auto-generate file_ops from the local git working
    tree (reads staged + modified files via `git diff --name-only` + file content).
    """
    from zz_agent.models import ChangesetFileOp

    if from_git_diff:
        # Generate file_ops from local git diff.
        import subprocess as _sp
        try:
            changed = _sp.run(["git", "diff", "--name-only", "HEAD"], capture_output=True, text=True, check=True).stdout.strip().split("\n")
            changed = [f for f in changed if f]
        except Exception as e:
            console.print(f"[red]git diff failed: {e}. Ensure you're in a git repo.[/red]")
            raise typer.Exit(1)
        if not changed:
            console.print("[yellow]No changed files detected (git diff --name-only HEAD is empty).[/yellow]")
            raise typer.Exit(0)
        ops_data = []
        for fpath in changed:
            try:
                with open(fpath, "r") as fh:
                    content = fh.read()
                ops_data.append({"op": "upsert", "path": fpath, "content": content})
            except (IOError, UnicodeDecodeError):
                ops_data.append({"op": "delete", "path": fpath})  # deleted or binary
        console.print(f"[dim]Generated {len(ops_data)} file_ops from git diff: {', '.join(changed[:5])}{'...' if len(changed) > 5 else ''}[/dim]")
    elif file_ops_json:
        ops_raw = _read_cli_file_arg(file_ops_json)
        ops_data = json.loads(ops_raw)
    else:
        console.print("[red]Provide --file-ops <json> or --from-git-diff.[/red]")
        raise typer.Exit(1)

    if not isinstance(ops_data, list):
        console.print("[red]file_ops must be a JSON array.[/red]")
        raise typer.Exit(1)

    file_ops = [ChangesetFileOp(**op) for op in ops_data]

    client = _get_client()
    try:
        cs = client.changesets.create(
            project_id=project_id,
            title=title,
            file_ops=file_ops,
            description=description,
            status=status,
            base_commit_id=base_commit_id,
            result_path=result_path,
            evidence_path=evidence_path,
            orchestration_id=orchestration_id,
            task_id=task_id,
        )
    except Exception as e:
        _handle_error(e, "Failed to create changeset")

    console.print(f"[green]✓ Changeset created:[/green] {cs.id}")
    console.print(f"  Title: {cs.title}")
    console.print(f"  Status: {cs.status}")
    console.print(f"  Operations: {len(cs.file_ops)}")


@changesets_app.command("list")
def changesets_list(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    status: Optional[str] = typer.Option(None, "--status", "-s", help="Filter by status"),
) -> None:
    """List changesets in a project."""
    client = _get_client()
    try:
        css = client.changesets.list(project_id=project_id, status=status)
    except Exception as e:
        _handle_error(e, "Failed to list changesets")

    if not css:
        console.print("[yellow]No changesets found.[/yellow]")
        return

    table = Table(title=f"Changesets in {project_id}", title_style="bold")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Title", style="bold")
    table.add_column("Status")
    table.add_column("Branch", style="dim")
    table.add_column("Created")

    for cs in css:
        status_color = {
            "draft": "dim",
            "submitted": "blue",
            "approved": "green",
            "changes_requested": "yellow",
            "rejected": "red",
            "merged": "green",
            "conflict": "red",
        }.get(cs.status, "white")
        table.add_row(
            cs.id,
            cs.title,
            f"[{status_color}]{cs.status}[/{status_color}]",
            cs.branch_id or "—",
            cs.created_at.strftime("%Y-%m-%d %H:%M") if hasattr(cs, "created_at") and cs.created_at else "—",
        )
    console.print(table)


@changesets_app.command("get")
def changesets_get(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    changeset_id: str = typer.Argument(..., help="Changeset ID"),
) -> None:
    """Get a changeset by ID."""
    client = _get_client()
    try:
        cs = client.changesets.get(project_id=project_id, changeset_id=changeset_id)
    except Exception as e:
        _handle_error(e, "Failed to get changeset")

    status_color = {
        "draft": "dim",
        "submitted": "blue",
        "approved": "green",
        "changes_requested": "yellow",
        "rejected": "red",
        "merged": "green",
        "conflict": "red",
    }.get(cs.status, "white")

    console.print(f"[bold]Title:[/bold] {cs.title}")
    console.print(f"[bold]ID:[/bold] {cs.id}")
    console.print(f"[bold]Status:[/bold] [{status_color}]{cs.status}[/{status_color}]")
    if cs.description:
        console.print(f"[bold]Description:[/bold] {cs.description}")
    console.print(f"[bold]File Operations:[/bold] {len(cs.file_ops)}")
    for op in cs.file_ops:
        console.print(f"  {op.op}: {op.path}")
    if cs.conflicts:
        console.print(f"[bold red]Conflicts:[/bold red] {len(cs.conflicts)}")


@changesets_app.command("update")
def changesets_update(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    changeset_id: str = typer.Argument(..., help="Changeset ID"),
    title: Optional[str] = typer.Option(None, "--title", "-t", help="New title"),
    description: Optional[str] = typer.Option(None, "--description", "-d", help="New description"),
    file_ops_json: Optional[str] = typer.Option(None, "--file-ops", help="New file operations JSON or @file path"),
    status: Optional[str] = typer.Option(None, "--status", "-s", help="draft or submitted"),
) -> None:
    """Update an existing changeset (draft or submitted only)."""
    from zz_agent.models import ChangesetFileOp

    file_ops = None
    if file_ops_json:
        ops_raw = _read_cli_file_arg(file_ops_json)
        ops_data = json.loads(ops_raw)
        if not isinstance(ops_data, list):
            console.print("[red]file_ops must be a JSON array.[/red]")
            raise typer.Exit(1)
        file_ops = [ChangesetFileOp(**op) for op in ops_data]

    client = _get_client()
    try:
        cs = client.changesets.update(
            project_id=project_id,
            changeset_id=changeset_id,
            title=title,
            description=description,
            file_ops=file_ops,
            status=status,
        )
    except Exception as e:
        _handle_error(e, "Failed to update changeset")

    console.print(f"[green]✓ Changeset updated:[/green] {cs.id}")
    console.print(f"  Status: {cs.status}")


@changesets_app.command("review")
def changesets_review(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    changeset_id: str = typer.Argument(..., help="Changeset ID"),
    decision: str = typer.Option(..., "--decision", "-d", help="approved, changes_requested, or rejected"),
    notes: Optional[str] = typer.Option(None, "--notes", "-n", help="Review notes"),
) -> None:
    """Review a changeset (owner, admin, or orchestration main agent)."""
    client = _get_client()
    try:
        cs = client.changesets.review(
            project_id=project_id,
            changeset_id=changeset_id,
            decision=decision,
            notes=notes,
        )
    except Exception as e:
        _handle_error(e, "Failed to review changeset")

    console.print(f"[green]✓ Changeset {decision}:[/green] {cs.id}")
    if cs.review_notes:
        console.print(f"  Notes: {cs.review_notes}")


@changesets_app.command("merge")
def changesets_merge(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    changeset_id: str = typer.Argument(..., help="Changeset ID"),
) -> None:
    """Merge an approved changeset into the default branch."""
    client = _get_client()
    try:
        result = client.changesets.merge(
            project_id=project_id,
            changeset_id=changeset_id,
        )
    except Exception as e:
        _handle_error(e, "Failed to merge changeset")

    cs = result.get("changeset", {})
    commit = result.get("commit", {})
    console.print(f"[green]✓ Changeset merged:[/green] {cs.get('id', changeset_id)}")
    if commit.get("id"):
        console.print(f"  Commit: {commit['id']}")
    # The merge produces a real git commit; surface its SHA so the PM/worker can
    # verify the deliverable landed in true git history.
    if commit.get("git_sha"):
        console.print(f"  [cyan]git sha:[/cyan] {commit['git_sha']}")


@changesets_app.command("approve-and-merge")
def changesets_approve_and_merge(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    changeset_id: str = typer.Argument(..., help="Changeset ID to review (approved) then merge"),
    notes: str = typer.Option("", "--notes", "-n", help="Optional review notes"),
) -> None:
    """One-step PM acceptance: approve a changeset and merge it immediately.

    Intended for the project/orchestration main agent. Equivalent to running
    `changesets review --decision approved` then `changesets merge`, but in a
    single command — and prints the real git commit SHA produced by the merge.
    """
    client = _get_client()
    try:
        client.changesets.review(
            project_id=project_id,
            changeset_id=changeset_id,
            decision="approved",
            notes=notes or None,
        )
    except Exception as e:
        _handle_error(e, "Failed to review (approve) changeset")
    console.print(f"[green]✓ Approved:[/green] {changeset_id}")
    try:
        result = client.changesets.merge(project_id=project_id, changeset_id=changeset_id)
    except Exception as e:
        _handle_error(e, "Failed to merge changeset")
    cs = result.get("changeset", {})
    commit = result.get("commit", {})
    console.print(f"[green]✓ Merged:[/green] {cs.get('id', changeset_id)}")
    if commit.get("git_sha"):
        console.print(f"  [cyan]git sha:[/cyan] {commit['git_sha']}  (real commit)")
    elif commit.get("id"):
        console.print(f"  Commit: {commit['id']}")


@changesets_app.command("rebase")
def changesets_rebase(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    changeset_id: str = typer.Argument(..., help="Changeset ID"),
) -> None:
    """Rebase a changeset onto the current branch head."""
    client = _get_client()
    try:
        cs = client.changesets.rebase(
            project_id=project_id,
            changeset_id=changeset_id,
        )
    except Exception as e:
        _handle_error(e, "Failed to rebase changeset")

    console.print(f"[green]✓ Changeset rebased:[/green] {cs.id}")
    console.print(f"  Status: {cs.status}")


# ═══════════════════════════════════════════════════════════════════════════════
#  TRACE (MD collaboration artifact reader)
# ═══════════════════════════════════════════════════════════════════════════════


def _list_files_by_prefix(client: Any, project_id: str, prefix: str) -> list[Any]:
    """List project-space files under a path prefix. Returns empty list on error."""
    try:
        return client.project_space.list_files(project_id=project_id, path_prefix=prefix)
    except Exception:
        return []


def _find_file_by_exact_path(files: list[Any], path: str) -> Any | None:
    """Find a file summary in the list by exact path match."""
    for f in files:
        if f.path == path:
            return f
    return None


def _md_check(filename: str, existing: set[str]) -> str:
    """Return a checkmark or cross depending on whether the file exists."""
    return "[green]✓[/green]" if filename in existing else "[dim]✗[/dim]"


@trace_app.command("show")
def trace_show(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Option(..., "--orchestration", "-o", help="Orchestration ID"),
) -> None:
    """Show the trace for an orchestration: task index table + TRACE.md content."""
    client = _get_client()

    try:
        orch = client.orchestrations.get(project_id=project_id, orchestration_id=orchestration_id)
    except Exception as e:
        _handle_error(e, "Failed to get orchestration")

    # Derive base_path from the orchestration model
    base_path: str | None = getattr(orch, "base_path", None)
    if not base_path:
        paths = getattr(orch, "paths", None)
        if paths:
            tasks_path = getattr(paths, "tasks", "")
            if tasks_path.endswith("/tasks.json"):
                base_path = tasks_path[: -len("/tasks.json")]
    if not base_path:
        console.print("[red]Orchestration has no base_path. Cannot locate trace artifacts.[/red]")
        raise typer.Exit(1)

    # List all files under the orchestration base path (one API call)
    all_files = _list_files_by_prefix(client, project_id, base_path)

    # ── Read tasks.json ledger ──────────────────────────────────────────────
    tasks_entry = _find_file_by_exact_path(all_files, f"{base_path}/tasks.json")
    tasks_data: list[dict[str, Any]] = []
    if tasks_entry:
        try:
            tf = client.project_space.get_file(project_id=project_id, file_id=tasks_entry.id)
            raw = tf.content.strip() if tf.content else ""
            tasks_data = json.loads(raw) if raw else []
        except Exception as e:
            console.print(f"[yellow]Failed to parse tasks.json: {e}[/yellow]")
    else:
        console.print("[yellow]tasks.json not found — no task index available.[/yellow]")

    # ── Collect per-task artifact existence ─────────────────────────────────
    # Path pattern: {base_path}/tasks/{task_id}/{ARTIFACT}.md
    task_artifacts: dict[str, set[str]] = {}
    for f in all_files:
        p = f.path
        if p.startswith(f"{base_path}/tasks/") and p.endswith((".md", ".json")):
            parts = p.split("/")
            if len(parts) >= 3 and parts[-2] != "tasks":
                tid, fname = parts[-2], parts[-1]
                if tid not in task_artifacts:
                    task_artifacts[tid] = set()
                task_artifacts[tid].add(fname)

    # ── Render task table ───────────────────────────────────────────────────
    if tasks_data:
        table = Table(
            title=f"Task Index — {orchestration_id}",
            title_style="bold",
        )
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Title", style="bold")
        table.add_column("Status")
        table.add_column("Agent", style="dim")
        table.add_column("TASK", justify="center")
        table.add_column("RESULT", justify="center")
        table.add_column("EVIDENCE", justify="center")
        table.add_column("REVIEW", justify="center")

        STATUS_COLORS = {
            "pending": "yellow",
            "dispatched": "blue",
            "running": "blue",
            "ready_for_review": "cyan",
            "approved": "green",
            "changes_requested": "red",
            "blocked": "red",
            "failed": "red",
        }

        for t in tasks_data:
            tid = t.get("id", "") or ""
            arts = task_artifacts.get(tid, set())
            sc = STATUS_COLORS.get(t.get("status", ""), "white")
            table.add_row(
                tid,
                t.get("title", ""),
                f"[{sc}]{t.get('status', '')}[/{sc}]",
                t.get("assigned_agent_id") or "—",
                _md_check("TASK.md", arts),
                _md_check("RESULT.md", arts),
                _md_check("EVIDENCE.md", arts),
                _md_check("REVIEW.md", arts),
            )
        console.print(table)
    else:
        console.print("[dim]No tasks to display.[/dim]")

    # ── Print TRACE.md ──────────────────────────────────────────────────────
    trace_entry = _find_file_by_exact_path(all_files, f"{base_path}/TRACE.md")
    if trace_entry:
        try:
            tf = client.project_space.get_file(project_id=project_id, file_id=trace_entry.id)
            content = (tf.content or "").strip()
            if content:
                console.print()
                console.print("[bold]TRACE.md[/bold]")
                console.print()
                console.print(content)
            else:
                console.print()
                console.print("[dim]TRACE.md exists but is empty.[/dim]")
        except Exception:
            console.print()
            console.print("[yellow]Could not read TRACE.md content.[/yellow]")
    else:
        console.print()
        console.print("[yellow]TRACE.md not found.[/yellow]")


@trace_app.command("task")
def trace_task(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    orchestration_id: str = typer.Option(..., "--orchestration", "-o", help="Orchestration ID"),
    task_id: str = typer.Option(..., "--task", "-t", help="Task ID"),
) -> None:
    """Show per-task MD artifacts for a specific task."""
    client = _get_client()

    try:
        orch = client.orchestrations.get(project_id=project_id, orchestration_id=orchestration_id)
    except Exception as e:
        _handle_error(e, "Failed to get orchestration")

    base_path: str | None = getattr(orch, "base_path", None)
    if not base_path:
        console.print("[red]Orchestration has no base_path.[/red]")
        raise typer.Exit(1)

    task_dir = f"{base_path}/tasks/{task_id}"
    artifact_names = ["TASK.md", "RESULT.md", "EVIDENCE.md", "REVIEW.md", "CHANGELOG.md"]

    # List all files under the task directory
    all_files = _list_files_by_prefix(client, project_id, task_dir)

    console.print(f"[bold]Orchestration:[/bold] {orchestration_id}")
    console.print(f"[bold]Task:[/bold] {task_id}")
    console.print()

    found_any = False
    for art in artifact_names:
        expected_path = f"{task_dir}/{art}"
        entry = _find_file_by_exact_path(all_files, expected_path)

        if entry:
            found_any = True
            try:
                af = client.project_space.get_file(project_id=project_id, file_id=entry.id)
                content = af.content or ""
                console.print(f"[bold]{art}[/bold]  [dim]({len(content)} B)[/dim]")
                console.print()
                if content.strip():
                    console.print(content)
                else:
                    console.print("[dim](empty)[/dim]")
                console.print()
            except Exception as e:
                console.print(f"[bold]{art}[/bold]  [red]Error reading:[/red] {e}")
                console.print()
        else:
            console.print(f"[bold]{art}[/bold]  [dim]— not found[/dim]")
            console.print()

    if not found_any:
        console.print("[yellow]No artifacts found for this task.[/yellow]")
        console.print(f"  (expected directory: {task_dir})")


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _read_cli_file_arg(value: str) -> str:
    """Read file content if value starts with '@', otherwise return value as-is."""
    if value.startswith("@"):
        path = value[1:]
        with open(path, "r") as f:
            return f.read()
    return value


# ═══════════════════════════════════════════════════════════════════════════════
#  DEV
# ═══════════════════════════════════════════════════════════════════════════════


@dev_app.command("fake-agent")
def dev_fake_agent(
    host: str = typer.Option("127.0.0.1", "--host", help="Bind host"),
    port: int = typer.Option(7777, "--port", "-p", help="Bind port"),
    name: str = typer.Option("fake-agent", "--name", "-n", help="Agent name"),
    mode: str = typer.Option(
        "normal",
        "--mode",
        "-m",
        help="normal, slow, fail, reject, invalid-json, or no-reply",
    ),
    invoke_secret: str = typer.Option(
        "dev-secret", "--invoke-secret", help="Shared HMAC invoke secret"
    ),
    delay_seconds: float = typer.Option(
        3.0, "--delay", help="Delay used by slow mode"
    ),
    require_hmac: bool = typer.Option(
        True, "--require-hmac/--allow-unsigned", help="Require runtime HMAC headers"
    ),
    timestamp_tolerance_seconds: int = typer.Option(
        300,
        "--timestamp-tolerance",
        help="Allowed HMAC timestamp skew in seconds; 0 disables the check",
    ),
) -> None:
    """Run a local V1 fake agent at POST /zz/v1/invoke."""
    from .fake_agent import FAKE_AGENT_MODES, FakeAgentConfig, run_fake_agent

    mode = mode.lower()
    if mode not in FAKE_AGENT_MODES:
        console.print(
            f"[red]Invalid mode '{mode}'. Choose one of: "
            f"{', '.join(sorted(FAKE_AGENT_MODES))}[/red]"
        )
        raise typer.Exit(1)

    endpoint = f"http://{host}:{port}/zz/v1/invoke"
    console.print("[bold]zz fake agent[/bold]")
    console.print(f"  endpoint: {endpoint}")
    console.print(f"  mode:     {mode}")
    console.print(f"  secret:   {invoke_secret}")
    console.print("[dim]Press Ctrl+C to stop[/dim]")

    run_fake_agent(
        host=host,
        port=port,
        config=FakeAgentConfig(
            name=name,
            mode=mode,
            invoke_secret=invoke_secret,
            delay_seconds=delay_seconds,
            require_hmac=require_hmac,
            timestamp_tolerance_seconds=timestamp_tolerance_seconds,
        ),
    )


@dev_app.command("quickstart-runtime")
def dev_quickstart_runtime(
    api_key: Optional[str] = typer.Option(
        None, "--api-key", envvar="ZZ_API_KEY", help="JWT bearer token or legacy API key for the backend"
    ),
    base_url: Optional[str] = typer.Option(
        None, "--base-url", help="API base URL; defaults to config or ZZ_BASE_URL"
    ),
    project_name: str = typer.Option(
        "V1 Runtime Demo", "--project-name", help="Project name to create"
    ),
    host: str = typer.Option(
        "127.0.0.1", "--host", help="Host used for local fake-agent endpoints"
    ),
    reviewer_mode: str = typer.Option(
        "normal", "--reviewer-mode", help="Fake-agent mode for reviewer"
    ),
    tester_mode: str = typer.Option(
        "normal", "--tester-mode", help="Fake-agent mode for tester"
    ),
    tail_seconds: float = typer.Option(
        10.0, "--tail-seconds", help="How long to poll session events"
    ),
    poll_interval_seconds: float = typer.Option(
        0.5, "--poll-interval", help="Event polling interval"
    ),
) -> None:
    """Create project, start two fake agents, register, send, tail, and check health."""
    from .fake_agent import FAKE_AGENT_MODES
    from .runtime_demo import run_quickstart_runtime

    config = _load_config()
    api_key = api_key or os.environ.get("ZZ_API_KEY") or config.get("api_key")
    if not api_key:
        console.print("[red]No credential found. Use --api-key, ZZ_API_KEY, or zz login.[/red]")
        raise typer.Exit(1)

    reviewer_mode = reviewer_mode.lower()
    tester_mode = tester_mode.lower()
    for label, selected_mode in {
        "reviewer": reviewer_mode,
        "tester": tester_mode,
    }.items():
        if selected_mode not in FAKE_AGENT_MODES:
            console.print(
                f"[red]Invalid {label} mode '{selected_mode}'. Choose one of: "
                f"{', '.join(sorted(FAKE_AGENT_MODES))}[/red]"
            )
            raise typer.Exit(1)

    try:
        run_quickstart_runtime(
            console=console,
            base_url=base_url or _get_base_url(),
            api_key=api_key,
            project_name=project_name,
            host=host,
            reviewer_mode=reviewer_mode,
            tester_mode=tester_mode,
            tail_seconds=tail_seconds,
            poll_interval_seconds=poll_interval_seconds,
        )
    except Exception as e:
        _handle_error(e, "Runtime quickstart failed")


# ═══════════════════════════════════════════════════════════════════════════════
#  whoami
# ═══════════════════════════════════════════════════════════════════════════════


@app.command()
def whoami() -> None:
    """Show current authenticated user."""
    client = _get_client()
    try:
        user = client.auth.me()
    except Exception as e:
        _handle_error(e, "Failed to get user info")

    console.print(f"[bold]User ID:[/bold] {user.id}")
    console.print(f"[bold]Username:[/bold] {user.username}")
    if user.display_name:
        console.print(f"[bold]Display Name:[/bold] {user.display_name}")
    console.print(f"[bold]Created:[/bold] {user.created_at}")


# ═══════════════════════════════════════════════════════════════════════════════
#  zz git — real git history (isomorphic-git backend)
# ═══════════════════════════════════════════════════════════════════════════════

@git_app.command("log")
def git_log(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    depth: int = typer.Option(20, "--depth", "-n", help="Max commits (1-500)"),
) -> None:
    """Show the project's real git commit history (newest first).

    Each row is a true git commit produced by changeset merges — distinct from
    the DB ProjectCommit rows. Use this to verify deliverables landed in git.
    """
    client = _get_client()
    try:
        result = client.git.log(project_id=project_id, depth=depth)
    except Exception as e:
        _handle_error(e, "Failed to read git log")
    console.print(f"[bold]Git history[/bold] (backend: {result.backend})")
    if result.head:
        console.print(f"  [cyan]HEAD:[/cyan] {result.head}")
    if not result.data:
        console.print("  [yellow]No commits yet.[/yellow]")
        return
    for entry in result.data:
        sha = entry.sha[:12] if entry.sha else "?"
        msg = (entry.message or "").splitlines()[0][:60] if entry.message else ""
        who = (entry.author.get("name") if isinstance(entry.author, dict) else "") or ""
        console.print(f"  [cyan]{sha}[/cyan]  {msg}")
        if who:
            console.print(f"         by {who}")


@git_app.command("head")
def git_head(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
) -> None:
    """Print the HEAD commit SHA of the project's default branch."""
    client = _get_client()
    try:
        sha = client.git.head(project_id=project_id)
    except Exception as e:
        _handle_error(e, "Failed to read git HEAD")
    if sha:
        console.print(sha)
    else:
        console.print("[yellow]No commits yet (empty repo).[/yellow]")


@git_app.command("remote")
def git_remote(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
) -> None:
    """Show the remote clone URL (Git gateway) for the project.

    Returns the clone_url + web_url when a Git gateway (Gitea/Forgejo) is
    configured. If disabled, explains how to use archive download instead.
    """
    client = _get_client()
    try:
        resp = client._request("GET", f"/v1/projects/{project_id}/git/remote")
        data = resp.json() if hasattr(resp, "json") else {}
    except Exception as e:
        _handle_error(e, "Failed to read git remote")
    if data.get("enabled") and data.get("clone_url"):
        console.print(f"[bold]Clone URL:[/bold] {data['clone_url']}")
        if data.get("web_url"):
            console.print(f"[bold]Web UI:[/bold]    {data['web_url']}")
        console.print(f"\n[dim]git clone {data['clone_url']}[/dim]")
    else:
        console.print("[yellow]Git gateway not enabled.[/yellow]")
        console.print("  Changeset merges still produce real git commits (use `zz git log` to see them).")
        console.print("  For a file snapshot, use `Download archive` (ZIP) in the dashboard.")


@git_app.command("tree")
def git_tree(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
) -> None:
    """List files in the project's current git HEAD tree."""
    client = _get_client()
    try:
        # Use the files endpoint (branch-scoped = git tree when gitSha present)
        resp = client._request("GET", f"/v1/projects/{project_id}/files", params={"branch": "main", "limit": "200"})
        data = resp.json() if hasattr(resp, "json") else {}
    except Exception as e:
        _handle_error(e, "Failed to read git tree")
    files = data.get("data", []) if isinstance(data, dict) else data
    if not files:
        console.print("[yellow]No files in the repository yet.[/yellow]")
        return
    console.print(f"[bold]Files ({len(files)}):[/bold]")
    for f in files:
        console.print(f"  {f.get('path', '?')}")


# ═══════════════════════════════════════════════════════════════════════════════
#  zz repo — Repository operations (GitHub-lite project space)
# ═══════════════════════════════════════════════════════════════════════════════

@repo_app.command("import")
def repo_import(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    archive_path: str = typer.Argument(..., help="Path to .zip archive"),
    mode: str = typer.Option("changeset", "--mode", "-m", help="changeset or direct"),
) -> None:
    """Import a local project archive (zip) into the project space."""
    import base64 as _b64
    with open(archive_path, "rb") as f:
        b64 = _b64.b64encode(f.read()).decode()
    client = _get_client()
    try:
        result = client._request("POST", f"/v1/projects/{project_id}/files/import", {"archive_base64": b64, "mode": mode})
        data = result.json() if hasattr(result, "json") else {}
    except Exception as e:
        _handle_error(e, "Failed to import archive")
    if data.get("mode") == "changeset":
        console.print(f"[green]✓ Imported {data.get('file_count', 0)} files into changeset {data.get('changeset_id', '')[:8]}[/green]")
        console.print("  Owner/PM must review and merge before files appear.")
    else:
        console.print(f"[green]✓ Imported {data.get('file_count', 0)} files directly.[/green]")


@repo_app.command("summary")
def repo_summary(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
) -> None:
    """Show a structured repository summary (file tree, languages, entry points).

    Designed for the PM agent to read project structure and generate a plan.
    """
    client = _get_agent_client()
    try:
        resp = client._request("GET", f"/v1/projects/{project_id}/repository/summary")
        data = resp.json() if hasattr(resp, "json") else {}
    except Exception as e:
        _handle_error(e, "Failed to get repository summary")
    console.print(f"[bold]Repository Summary[/bold] ({data.get('total_files', 0)} files, {data.get('total_bytes', 0)} bytes)")
    if data.get("git_head_sha"):
        console.print(f"  Git HEAD: {data['git_head_sha'][:12]}")
    # Tree
    console.print(f"\n[bold]File Tree (top-level):[/bold]")
    for item in data.get("tree", []):
        icon = "📁" if item.get("type") == "directory" else "📄"
        console.print(f"  {icon} {item['name']} ({item.get('file_count', 0)} files)")
    # Languages
    if data.get("languages"):
        console.print(f"\n[bold]Languages:[/bold]")
        for lang in data["languages"][:8]:
            console.print(f"  {lang['name']}: {lang['files']} files ({lang['bytes']} bytes)")
    # Entry points
    if data.get("entry_points"):
        console.print(f"\n[bold]Entry Points:[/bold]")
        for ep in data["entry_points"]:
            console.print(f"  🚀 {ep}")
    # Package
    pkg = data.get("package")
    if pkg:
        console.print(f"\n[bold]Package ({pkg.get('type')}):[/bold]")
        if pkg.get("name"):
            console.print(f"  name: {pkg['name']}  version: {pkg.get('version', '?')}")
        if pkg.get("dependencies"):
            console.print(f"  deps: {', '.join(pkg['dependencies'][:10])}")
        if pkg.get("scripts"):
            console.print(f"  scripts: {', '.join(pkg['scripts'])}")
    # Test files
    if data.get("test_files"):
        console.print(f"\n[bold]Test Files ({len(data['test_files'])}):[/bold]")
        for tf in data["test_files"][:5]:
            console.print(f"  🧪 {tf}")
    # README
    if data.get("readme_preview"):
        console.print(f"\n[bold]README Preview:[/bold]")
        console.print(data["readme_preview"][:300])


@repo_app.command("code-map")
def repo_code_map(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
) -> None:
    """Generate or refresh the project's code map (.agent/code-map.md).

    Scans all source files, extracts symbols/imports/summaries, and writes a
    structured markdown map. This map is auto-injected into every agent's
    dispatch context so they understand the codebase without reading every file.
    """
    client = _get_client()
    try:
        resp = client._request("POST", f"/v1/projects/{project_id}/repository/generate-code-map")
        data = resp.json() if hasattr(resp, "json") else {}
    except Exception as e:
        _handle_error(e, "Failed to generate code map")
    console.print(f"[green]✓ Code map generated:[/green] {data.get('path', '.agent/code-map.md')}")
    console.print(f"  Files indexed: {data.get('files_indexed', 0)}")
    console.print(f"  Content size: {data.get('content_length', 0)} chars")
    console.print("  Auto-injected into every agent context via projectRules.")


@repo_app.command("checkout")
def repo_checkout(
    project_id: str = typer.Option(..., "--project", "-p", help="Project ID"),
    dest: str = typer.Argument(".", help="Destination directory"),
) -> None:
    """Download all project files to a local directory (like git checkout).

    Creates the directory structure and writes each file's content. Useful for
    agents to work locally, then use `zz changesets create --from-git-diff`.
    """
    import os as _os
    client = _get_agent_client()
    try:
        resp = client._request("GET", f"/v1/projects/{project_id}/files?limit=500")
        data = resp.json() if hasattr(resp, "json") else {}
        files = data.get("data", []) if isinstance(data, dict) else data
    except Exception as e:
        _handle_error(e, "Failed to fetch files")
    if not files:
        console.print("[yellow]No files in project.[/yellow]")
        return
    _os.makedirs(dest, exist_ok=True)
    written = 0
    for f in files:
        path = f.get("path", "")
        if not path:
            continue
        # Fetch file content
        try:
            file_resp = client._request("GET", f"/v1/projects/{project_id}/files/{f['id']}/raw")
            content = file_resp.text if hasattr(file_resp, "text") else str(file_resp)
        except Exception:
            continue
        full_path = _os.path.join(dest, path)
        _os.makedirs(_os.path.dirname(full_path), exist_ok=True) if _os.path.dirname(full_path) else None
        with open(full_path, "w") as wf:
            wf.write(content)
        written += 1
    console.print(f"[green]✓ Checked out {written} files to {dest}[/green]")
    console.print("  Modify files locally, then: zz changesets create --from-git-diff -p " + project_id + " -t 'Local changes'")


# ═══════════════════════════════════════════════════════════════════════════════
#  Entry point
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app()
