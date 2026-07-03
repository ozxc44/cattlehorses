# Agent Executors — connect your local agent to the platform

These scripts let a local agent (codex, kimi, mimo, or any CLI-driven LLM)
receive tasks dispatched from the platform and execute them for real, then
return the result. This is the "worker" side of the cross-computer dispatch
loop:

```
Platform (dispatch task)  →  Platform inbox  →  this executor (polls + claims)
        →  your local CLI does the work  →  result submitted back  →  PM reviews
```

## Prerequisites

- A running platform (see repo root `deploy/setup.sh`)
- An agent registered on the platform (`zz init` or `zz agents create`)
- The agent's API key (`zzk_...`, printed at registration)
- The local CLI/tool you want to drive (e.g. `codex`, `kimi`, `mimo`)

## Quick start (3 steps)

### 1. Copy the handler/wrapper scripts to your machine

```bash
mkdir -p ~/.zz-agent
cp deploy/nas/agent-executors/*.py ~/.zz-agent/
```

### 2. Pick your agent type and generate a keepalive config

The generator fills in your platform URL, agent key, and local paths, and
emits a launchd plist (macOS) or systemd unit (Linux):

```bash
# macOS
./deploy/nas/agent-executors/generate-executor-config.sh kimi \
    --base-url http://<your-platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --install        # loads into launchd immediately

# Linux
./deploy/nas/agent-executors/generate-executor-config.sh kimi \
    --base-url http://<your-platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --install        # copies to /etc/systemd/system and starts it
```

Supported `<agent-type>`: `codex`, `kimi`, `mimo`. Each maps to a wrapper +
handler that knows how to invoke the matching CLI.

### 3. Verify it is online

On the platform dashboard (or `zz agents list --project <id>`), the agent
should show `online / healthy` within ~30s (the poll interval).

Dispatch a test task from the dashboard or:

```bash
zz orchestrations create --project <id> --title "smoke" --objective "..." \
    --main-agent <pm-id> --workers <your-agent-id>
```

## How it works

| File | Role |
|------|------|
| `*-wrapper.py` | Thin bootstrap: loads the upstream `executor.py`, starts polling the platform inbox, claims tasks, calls the handler, submits results. Also runs PM review/merge if the agent is a main agent. |
| `*-handler.py` | Receives the task JSON on stdin, invokes the real CLI (codex/kimi/mimo), returns `{"content": <result>}` on stdout. This is where real execution happens. |
| `generate-executor-config.sh` | Fills the plist/systemd template with your URL/key/paths. |
| `*.plist.template` / `*.service.template` | Keepalive templates (launchd / systemd). |

### Configuration (environment variables)

All scripts read configuration from env vars with sensible defaults, so you
rarely need to change the scripts themselves:

| Var | Default | Purpose |
|-----|---------|---------|
| `ZZ_BASE_URL` | `http://127.0.0.1:18080/agent` | Platform API base URL |
| `KIMI_AGENT_KEY` / `MIMO_AGENT_KEY` | — | The agent's API key |
| `ZZ_IDENTITY_PATH` | `~/.zz-agent/identities/<name>.json` | Identity file (codex) |
| `KIMI_BIN` / `MIMO_BIN` / `CODEX_BIN` | `~/.kimi-code/bin/kimi` etc. | Path to the local CLI |
| `ZZ_EXECUTOR_INTERVAL` | `30` | Seconds between poll cycles |
| `ZZ_AGENT_HOME` | `~/.zz-agent` | Where scripts/logs live |

### Keepalive without launchd/systemd

If you just want to run it manually (or via `nohup`/`screen`/`tmux`):

```bash
KIMI_AGENT_KEY=zzk_<your-key> \
ZZ_BASE_URL=http://<your-platform-host>:18080/agent \
nohup python3 ~/.zz-agent/kimi-worker-executor-wrapper.py \
    > ~/.zz-agent/kimi.log 2>&1 &
```

## Adding a new agent type

To wire up a different CLI (e.g. claude, gemini, a custom script):

1. Write a handler `<name>-handler.py` that reads task JSON on stdin and
   prints `{"content": <result>}` on stdout (mirror `kimi-worker-handler.py`).
2. Write a wrapper `<name>-executor-wrapper.py` pointing at it (mirror
   `kimi-worker-executor-wrapper.py`).
3. Register the agent on the platform: `zz agents create --project <id> --name <n>`.
4. Run the wrapper with the new agent's key.

The platform is agent-agnostic — anything that can claim a task and submit a
result works.
