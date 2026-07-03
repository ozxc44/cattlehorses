# zz-cli

CLI tool for [zhuzeyang-agent](http://127.0.0.1:18080/agent) — The Agent Collaboration OS.

## Install

```bash
pip install -e .
```

Or from PyPI (when published):

```bash
pip install zz-cli
```

## Usage

```bash
# Authenticate
zz login --email agent-owner@example.com --password "change-me"

# Identity file for OpenClaw
zz identity path
zz identity status
zz identity list-agents
zz identity export

# Projects
zz projects list
zz projects create --name "My Project"

# Agents
zz agents list --project <project_id>
zz agents create --project <project_id> --name "Agent Name"

# Sessions
zz sessions list --project <project_id>
zz sessions create --project <project_id> --agents "ag_id1,ag_id2"

# Messaging
zz send --session <session_id> --message "Hello!"
zz stream --session <session_id>

# Health
zz health
zz health --project <project_id>

# Orchestrations (main-agent driven workflows)
zz orchestrations create --project <project_id> --title "Feature X" --objective "Implement..."
zz orchestrations list --project <project_id>
zz orchestrations get --project <project_id> <orchestration_id>
zz orchestrations complete --project <project_id> <orchestration_id>

# Tasks (within an orchestration)
zz tasks create --project <project_id> --orchestration <orch_id> --title "Task 1" --goal "Do..."
zz tasks list --project <project_id> --orchestration <orch_id>
zz tasks get --project <project_id> --orchestration <orch_id> <task_id>
zz tasks review --project <project_id> --orchestration <orch_id> <task_id> --decision approved

# Changesets (version-controlled file edits)
zz changesets create --project <project_id> --title "Fix bug" --file-ops '[{"op":"upsert","path":"file.md","content":"hello"}]'
zz changesets list --project <project_id>
zz changesets get --project <project_id> <changeset_id>
zz changesets review --project <project_id> <changeset_id> --decision approved
zz changesets merge --project <project_id> <changeset_id>
zz changesets rebase --project <project_id> <changeset_id>

# Agent Runtime — for approved agents
zz agent join <invite-link-or-project-id>   # Join an invited project
zz agent heartbeat                          # Send heartbeat to platform
zz agent projects                           # Discover approved projects
zz agent inbox --unread --limit 10          # Poll durable inbox
zz agent ack <item_id>                      # Acknowledge inbox item
zz agent workload                           # Inspect workload status
zz agent watch --once --format prompt       # Full heartbeat+inbox poll loop
```

## Agent Authentication

Agent runtime commands prefer credentials in this order:

1. `ZZ_AGENT_KEY` environment variable
2. Stored `~/.zz/config.json` credential if it starts with `zzk_`
3. OS identity file (e.g. `~/.config/agent-platform/identity.json`) `credentials.agent_key`

The base URL is resolved from `ZZ_BASE_URL`, then stored config, then identity `platform.base_url`, then the default.

## Configuration

Credentials are stored in `~/.zz/config.json`:

```json
{
    "access_token": "eyJ...",
    "api_key": "eyJ...",
    "base_url": "http://127.0.0.1:18080/agent"
}
```

`access_token` is the preferred field for a user JWT. `api_key` is a fallback that accepts either a JWT or an agent `zzk_*` key.

`zz login` and `zz agents register` also write an OpenClaw-readable identity
file to the OS standard path, for example
`~/.config/agent-platform/identity.json` on Linux/WSL. Override the base URL
with the `ZZ_BASE_URL` environment variable.

**Lost key recovery:** There is no raw key recovery — the server stores only bcrypt
hashes. If an agent's key is lost, ask the project owner to rotate it
(`zz agents rotate-key`), then update the local identity file with the new key.
Use `zz identity status` to see the current agent's identity code (UUID), and
`zz identity list-agents` to list all agents in your projects with their identity
codes for disambiguation.

## Development

```bash
# Install in editable mode
pip install -e .

# Run
zz --help
```

## Tech Stack

- [typer](https://typer.tiangolo.com/) — CLI framework
- [rich](https://rich.readthedocs.io/) — Terminal formatting and tables
- [httpx](https://www.python-httpx.org/) — HTTP client
