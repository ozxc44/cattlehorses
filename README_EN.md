# Agent Collaboration OS

> Orchestrate any local AI model (kimi / claude / codex / hermes / mimo / deepseek …) to collaboratively build software — dispatch, execute, review, and merge like a real dev team.

**Agent Collaboration OS** is a multi-agent collaboration platform. It organizes the local AI models on one (or many) machines into a development team: **a main agent (PM) breaks down requirements and dispatches tasks → worker agents execute using their own model instances → the PM reviews changesets → merges**. Everything runs on a real Git backend with an MD-driven workflow — auditable and privately deployable.

[中文文档 (Chinese)](README.md)

## What it is / What it isn't

**Is**: a multi-agent collaboration **governance platform** — orchestrate, route, review, and merge the output of a swarm of AI agents.

**Isn't**: another single-agent coding assistant (that's Cursor / Copilot territory). This governs *how a group of agents collaborate*.

## Core Capabilities

| Capability | Description |
|------------|-------------|
| 🤖 **Unified local-model runtime** | One process serves **all** local models on a host (kimi/mimo/codex/claude/hermes), routed precisely by agent identity. `--discover` auto-detects and onboards each model with its own agent identity. |
| 📋 **PM/worker orchestration** | The main agent decomposes goals into tasks, dispatches to workers, workers submit results, PM reviews and approves (GitHub-PR-style flow). |
| 🌳 **Real Git backend** | True version control via isomorphic-git (not a DB simulation) — branches, merges, history; integrates with Gitea/Forgejo. |
| 📝 **MD-driven workflow** | `goal.md → TASK.md → RESULT.md → REVIEW.md` — a human- and machine-readable collaboration contract. |
| 🔒 **Private deployment** | Data never leaves your network. Self-host to counter the data-egress concerns of Devin/Azure. |
| ⚡ **Autostart + warm cache** | macOS launchd / systemd autostart; on-demand model instantiation with warm caching; context persists across tasks. |

## Quick Start

### 1. Deploy the platform (Docker Compose)

```bash
git clone https://github.com/ozxc44/agent-collaboration-os.git
cd agent-collaboration-os/deploy/nas
# Edit .env (database / JWT secret / Gitea config)
cp .env.example .env
docker compose --env-file .env up -d
# Platform runs at http://<your-platform-host>:18080/agent
```

### 2. Onboard local models (agent side)

On a machine with local models installed (kimi/claude/codex/hermes/mimo):

```bash
# Download the unified runtime (pure Python stdlib, no dependencies)
curl -s http://<your-platform-host>:18080/agent/v1/agent/bootstrap/runtime.py -o runtime.py

# One command discovers all local models + autostarts
python3 runtime.py --discover --install-launchd --port 7788
```

The runtime scans for kimi/mimo/codex/claude/hermes + API models (deepseek/openai/moonshot/GLM), creates **a separate agent identity for each model**, and prints the registration commands.

### 3. Register models with the platform

Following the commands printed by `--discover`, register each model as an agent on the platform:

```bash
zz agents register -p <project-id> -n kimi-agent \
  --endpoint-url http://<your-host>:7788/zz/v1/invoke \
  --invoke-secret <secret-from-agents.json>
```

### 4. PM dispatches, models execute

The PM (main agent) dispatches tasks via the platform; the platform routes precisely by agent identity to the corresponding model instance:

```bash
zz tasks create -p <project> -o <orchestration> \
  -t "Implement user login" -g "Implement login with JWT" -a <worker-agent-id>
```

## Architecture

```
┌──────────── Platform (Node.js + Postgres + isomorphic-git) ──────────────────┐
│  PM dispatch → task routing → changeset review → git merge                     │
│       │  X-ZZ-Agent-Id                                                         │
└───────┼───────────────────────────────────────────────────────────────────────┘
        ▼
┌─── Unified Runtime (per host, pure Python) ──────────────────────────────────┐
│  agent_id → backend routing table (agents.json)                               │
│   ├─ cli:kimi / cli:claude / cli:codex / cli:hermes / cli:mimo  (one-shot)    │
│   ├─ instance:claude / instance:hermes / ...  (persistent agent, tmux)        │
│   └─ api  (deepseek/openai/moonshot/GLM, OpenAI-compatible)                   │
└───────────────────────────────────────────────────────────────────────────────┘
        ▼
   Local model instantiated → read files / write code / use tools → submit → PM review
```

## Supported Model Backends

| Backend | Models | Mode |
|---------|--------|------|
| `instance:<model>` | claude/hermes/kimi/mimo/codex | **Persistent agent instance** (tmux, read/write/tools/multi-turn context) |
| `cli:<model>` | same as above | One-shot chat (fast ack) |
| `api` | deepseek/openai/moonshot/GLM | OpenAI-compatible HTTP |
| `echo` | — | Test mode |

See [`cli/zz_cli/RUNTIME.md`](cli/zz_cli/RUNTIME.md) for full details.

## Project Structure

```
backend/          Node.js + TypeScript backend (197 APIs, 37 entities)
  src/routes/     API routes (orchestrations, versioning, agents, inbox ...)
  src/services/   Core services (git, gitea-sync, session-dispatch, runtime-adapter)
  src/entities/   TypeORM entities
dashboard/        Frontend (raw HTML, planned refactor to React/Vue)
cli/              Python CLI + unified runtime
  zz_cli/runtime.py       Unified local-model runtime (discover/route/instantiate/autostart)
  zz_cli/executor.py      Agent executor daemon (transport TASK.md + PM review)
  zz_cli/invoke_server.py HTTP invoke endpoint (runtime.v1)
sdk/              Python SDK
deploy/           Docker Compose + deployment scripts
docs/             Docs + product planning
```

## Roadmap

- [x] **Core loop**: PM dispatch → model instantiation → submit → PM review
- [x] **Unified runtime**: multi-model discovery + precise routing + persistent instances
- [x] **Real Git backend** + Gitea gateway
- [ ] **Frontend refactor** (current raw HTML → React/Vue)
- [ ] **Multi-tenancy** + team RBAC + SSO
- [ ] **Hosted platform** (open-core commercialization)

Full product plan in [`docs/PRODUCT-PLAN.md`](docs/PRODUCT-PLAN.md).

## Commercialization

**Open-Core model**: the core runtime + orchestration engine is open source (this repo); commercial hosting (multi-tenant/SSO/billing/SLA) is the paid tier.

Differentiation moat: unified local-model runtime + PM/worker engineering orchestration + private deployment.

See [`docs/RESEARCH-FINAL-PLAN.md`](docs/RESEARCH-FINAL-PLAN.md) (three-model collaborative research report).

## Development

```bash
cd backend && npm install && npm run build && npm start
cd cli && pip install -e .
```

## License

MIT

## Acknowledgements

The unified runtime incorporates non-interactive instantiation patterns from these agent frameworks:
- [Claude Code](https://code.claude.com) (Anthropic) — print mode + interactive agent
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research)
- [kimi-code](https://kimi.com) / [mimocode](https://mimocode.com) / [Codex](https://github.com/openai/codex)
