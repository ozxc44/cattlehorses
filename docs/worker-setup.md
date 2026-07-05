# Worker Executor Setup Guide

Complete guide for setting up each worker type on the Agent Collaboration OS platform. Each worker receives tasks from the platform, executes them via a local LLM CLI, and returns results.

```text
Platform (dispatch) → Inbox → Executor (polls + claims) → Handler (invokes CLI) → Result → PM reviews
```

## Prerequisites

Before setting up any worker:

| Requirement | Details |
|-------------|---------|
| **Running platform** | `deploy/setup.sh` or the platform at `<host>:18080/agent` |
| **Registered agent** | `zz init` or `zz agents create --project <id> --name <name>` |
| **Agent API key** | `zzk_...` printed at registration — save it, shown once |
| **Python 3.8+** | Required for executor wrappers |
| **Identity file** | Written by `zz identity export` to `~/.zz-agent/identities/<name>.json` |

Clone the executor scripts to your machine:

```bash
mkdir -p ~/.zz-agent
cp deploy/nas/agent-executors/*.py ~/.zz-agent/
```

---

## 1. Claude Worker

Runs tasks via the [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`).

### 1.1 Install Claude CLI

```bash
# macOS (Homebrew)
brew install --cask claude

# Or via npm
npm install -g @anthropic-ai/claude-code

# Verify
claude --version
```

The binary is typically at `/usr/local/bin/claude` or `$(which claude)`.

### 1.2 Create the Handler

The handler is already provided at `deploy/nas/agent-executors/claude-worker-handler.py`. It:

- Reads task JSON from stdin
- Builds a prompt with title, goal, and acceptance criteria
- Runs `claude -p --dangerously-skip-permissions <prompt>`
- Returns `{"content": "<result>"}` on stdout

Key environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `CLAUDE_BIN` | `claude` | Path to the claude binary |
| `CLAUDE_WORKSPACE` / `ZZ_PROJECT_DIR` | `cwd` | Working directory for task execution |
| `CLAUDE_TIMEOUT_SECONDS` | `1500` | Max seconds per task |

### 1.3 Create the Wrapper

The wrapper (`claude-worker-executor-wrapper.py`) bootstraps the executor daemon:

- Downloads `executor.py` from the platform on first run
- Loads the agent key from `~/.zz-agent/identities/claude-agent.json` or `CLAUDE_AGENT_KEY` env
- Starts polling in `--worker-only` mode with the claude handler

### 1.4 Generate the Plist (macOS)

```bash
./deploy/nas/agent-executors/generate-executor-config.sh claude \
    --base-url http://<platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --project-dir /path/to/your/repo \
    --install
```

This generates `~/.zz-agent/com.zz-agent.claude-executor.plist` and loads it into launchd.

### 1.5 Generate the Service (Linux)

```bash
./deploy/nas/agent-executors/generate-executor-config.sh claude \
    --base-url http://<platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --project-dir /path/to/your/repo \
    --install
```

Copies the unit to `/etc/systemd/system/` and starts it.

### 1.6 Manual Run (no keepalive)

```bash
CLAUDE_AGENT_KEY=zzk_<your-key> \
ZZ_BASE_URL=http://<platform-host>:18080/agent \
python3 ~/.zz-agent/claude-worker-executor-wrapper.py
```

---

## 2. Mimo Worker

Runs tasks via [MiMoCode](https://github.com/XiaoMi/mimocode) (`mimo`).

### 2.1 Install MiMoCode

```bash
# Via pip
pip install mimocode

# Or from source
git clone https://github.com/XiaoMi/mimocode.git
cd mimocode && pip install -e .

# Verify
mimo --version
```

The binary is typically at `~/.mimocode/bin/mimo`.

### 2.2 Key Flag: `--dangerously-skip-permissions`

The mimo handler uses `mimo run --dangerously-skip-permissions` to auto-approve file writes under the working directory. Without this flag, mimo rejects writes to directories outside its sandbox, which breaks both the smoke test and real task execution under launchd (no interactive terminal to approve).

### 2.3 Handler Details

`mimo-invoke-handler.py` reads task JSON on stdin and runs:

```bash
mimo run --dangerously-skip-permissions "<prompt>"
```

Key environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `MIMO_BIN` | `~/.mimocode/bin/mimo` | Path to the mimo binary |
| `MIMO_INVOKE_WORKSPACE` / `ZZ_PROJECT_DIR` | `cwd` | Working directory |
| `MIMO_INVOKE_TIMEOUT_SECONDS` | `1500` | Max seconds per task |

The handler constructs a `PATH` that includes `~/.mimocode/bin`, `/opt/homebrew/bin`, and standard system paths so the binary is found even under launchd.

### 2.4 Wrapper + Plist

The wrapper (`mimo-worker-executor-wrapper.py`) uses `MIMO_AGENT_KEY` from the environment or identity file at `/Users/z/.zz-agent/identities/mimo-agent.json`.

Generate keepalive config:

```bash
# macOS
./deploy/nas/agent-executors/generate-executor-config.sh mimo \
    --base-url http://<platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --project-dir /path/to/your/repo \
    --install

# Linux
./deploy/nas/agent-executors/generate-executor-config.sh mimo \
    --base-url http://<platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --project-dir /path/to/your/repo \
    --install
```

### 2.5 Manual Run

```bash
MIMO_AGENT_KEY=zzk_<your-key> \
ZZ_BASE_URL=http://<platform-host>:18080/agent \
python3 ~/.zz-agent/mimo-worker-executor-wrapper.py
```

---

## 3. Kimi Worker

Runs tasks via the [Kimi Code CLI](https://kimi.moonshot.cn) (`kimi`).

### 3.1 Install Kimi CLI

```bash
# Via the official installer
curl -fsSL https://kimi.moonshot.cn/install.sh | sh

# Or download from https://kimi.moonshot.cn and install manually

# Verify
kimi --version
```

The binary is typically at `~/.kimi-code/bin/kimi`.

### 3.2 Handler Details

`kimi-worker-handler.py` reads task JSON on stdin and runs:

```bash
kimi -p "<prompt>" --output-format text
```

Key environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `KIMI_BIN` | `~/.kimi-code/bin/kimi` | Path to the kimi binary |
| `KIMI_WORKSPACE` | `cwd` | Working directory |
| `KIMI_TIMEOUT_SECONDS` | `1500` | Max seconds per task |

### 3.3 Wrapper + Plist

The wrapper (`kimi-worker-executor-wrapper.py`) uses `KIMI_AGENT_KEY` from the environment.

Generate keepalive config:

```bash
# macOS
./deploy/nas/agent-executors/generate-executor-config.sh kimi \
    --base-url http://<platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --project-dir /path/to/your/repo \
    --install

# Linux
./deploy/nas/agent-executors/generate-executor-config.sh kimi \
    --base-url http://<platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --project-dir /path/to/your/repo \
    --install
```

### 3.4 Manual Run

```bash
KIMI_AGENT_KEY=zzk_<your-key> \
ZZ_BASE_URL=http://<platform-host>:18080/agent \
python3 ~/.zz-agent/kimi-worker-executor-wrapper.py
```

---

## 4. Codex Worker

Runs tasks via the [Codex CLI](https://github.com/openai/codex) (`codex`).

### 4.1 Install Codex

```bash
# macOS — Codex.app
# Download from https://github.com/openai/codex/releases
# Binary at: /Applications/Codex.app/Contents/Resources/codex

# Or via the pm-workers wrapper
~/.codex/pm-workers/bin/codex

# Verify
codex --version
```

### 4.2 Handler Details

`codex-worker-handler.py` reads task JSON on stdin and runs:

```bash
codex exec --cd <workspace> \
    --dangerously-bypass-approvals-and-sandbox \
    --dangerously-bypass-hook-trust \
    -
```

The prompt is piped via stdin (`-`). The `--dangerously-bypass-*` flags auto-approve file operations and skip interactive hook-trust prompts that would hang under launchd.

Binary resolution order:
1. `CODEX_BIN` env var
2. `/Applications/Codex.app/Contents/Resources/codex`
3. `~/.codex/pm-workers/bin/codex`

Key environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `CODEX_BIN` | auto-detected | Path to the codex binary |
| `CODEX_HOME` | `~/.codex` | Codex config directory |
| `CODEX_WORKSPACE` / `ZZ_PROJECT_DIR` | `cwd` | Working directory |
| `CODEX_TIMEOUT_SECONDS` | `1500` | Max seconds per task |

### 4.3 Wrapper + Plist

The wrapper (`codex-worker-executor-wrapper.py`) uses an isolated workspace (`ZZ_PROJECT_DIR=/tmp/zz-workspace-codex` by default) so it does not collide with the codex PM or sibling workers.

The agent key is loaded from `~/.zz-agent/identities/codex-worker-agent.json` or `CODEX_AGENT_KEY` env.

Generate keepalive config:

```bash
# macOS
./deploy/nas/agent-executors/generate-executor-config.sh codex \
    --base-url http://<platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --project-dir /path/to/your/repo \
    --install

# Linux
./deploy/nas/agent-executors/generate-executor-config.sh codex \
    --base-url http://<platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --project-dir /path/to/your/repo \
    --install
```

### 4.4 Manual Run

```bash
CODEX_AGENT_KEY=zzk_<your-key> \
ZZ_BASE_URL=http://<platform-host>:18080/agent \
python3 ~/.zz-agent/codex-worker-executor-wrapper.py
```

---

## 5. Keepalive Config Generator

`generate-executor-config.sh` is the unified entrypoint for generating keepalive configs across all worker types.

```bash
./deploy/nas/agent-executors/generate-executor-config.sh <agent-type> \
    --base-url <url> \
    --key <agent-key> \
    [--project-dir <path>] \
    [--label <name>] \
    [--install]
```

| Agent Type | Wrapper Script | Key Env Var |
|------------|---------------|-------------|
| `claude` | `claude-worker-executor-wrapper.py` | `CLAUDE_AGENT_KEY` |
| `mimo` | `mimo-worker-executor-wrapper.py` | `MIMO_AGENT_KEY` |
| `kimi` | `kimi-worker-executor-wrapper.py` | `KIMI_AGENT_KEY` |
| `codex` | `codex-worker-executor-wrapper.py` | `CODEX_AGENT_KEY` |

The `--install` flag:
- **macOS**: loads the plist into launchd immediately
- **Linux**: copies the service to `/etc/systemd/system/` and enables it

---

## 6. Verification — Smoke Test

After setup, verify the worker is online and healthy.

### 6.1 Check Agent Status

On the platform dashboard or via CLI:

```bash
zz agents list --project <id>
```

The agent should show `online / healthy` within ~30 seconds (one poll cycle).

### 6.2 Dispatch a Test Task

```bash
zz orchestrations create \
    --project <id> \
    --title "smoke test" \
    --objective "Create a file called /tmp/smoke-test.txt with content 'hello'" \
    --main-agent <pm-id> \
    --workers <your-agent-id>
```

### 6.3 Check Logs

```bash
# macOS (launchd)
tail -f ~/.zz-agent/com.zz-agent.<type>-executor.launchd.log
tail -f ~/.zz-agent/com.zz-agent.<type>-executor.launchd.err.log

# Linux (systemd)
journalctl -u com.zz-agent.<type>-executor -f
```

Healthy log output:

```text
Mimo worker+PM executor wrapper started
base_url=http://... interval=30s mode=worker+pm handler=mimo-invoke-handler.py
2026-01-01T00:00:30 cycle_ok agent_id=<uuid> pending=0
```

### 6.4 Verify Handler Directly

Test the handler in isolation:

```bash
echo '{"title":"test","goal":"Say hello","acceptance_criteria":[]}' | \
    python3 ~/.zz-agent/<type>-worker-handler.py
```

Expected output: `{"content": "..."}` with the agent's response.

---

## 7. Troubleshooting

### 7.1 TCC / Full Disk Access (macOS)

**Symptom**: Agent hangs silently under launchd; no output in logs.

**Cause**: macOS TCC (Transparency, Consent, and Control) blocks the agent binary from reading files under `~/Documents`, `~/Desktop`, etc. Under launchd there is no terminal to show the permission prompt.

**Fix**:

1. Open System Settings > Privacy & Security > Full Disk Access
2. Add the agent binary:
   - Claude: `$(which claude)` or `/usr/local/bin/claude`
   - Mimo: `~/.mimocode/bin/mimo`
   - Kimi: `~/.kimi-code/bin/kimi`
   - Codex: `/Applications/Codex.app/Contents/Resources/codex`
3. Restart the executor:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.zz-agent.<type>-executor.plist
   launchctl load ~/Library/LaunchAgents/com.zz-agent.<type>-executor.plist
   ```

The `generate-executor-config.sh --install` script automates opening System Settings and revealing the binary in Finder for drag-and-drop.

### 7.2 Binary Not Found

**Symptom**: Handler returns `{"content": "<type> binary not found at <path>"}`.

**Cause**: The agent CLI is not installed or not on PATH.

**Fix**:

1. Verify the binary exists:
   ```bash
   which claude  # or kimi, mimo, codex
   ```
2. Set the explicit path via env var:
   ```bash
   export CLAUDE_BIN=/usr/local/bin/claude
   export KIMI_BIN=~/.kimi-code/bin/kimi
   export MIMO_BIN=~/.mimocode/bin/mimo
   export CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
   ```
3. For launchd/systemd, add the env var to the plist/service file or pass it via `generate-executor-config.sh`.

### 7.3 PATH Issues Under launchd

**Symptom**: Binary works in terminal but not under launchd.

**Cause**: launchd does not inherit your shell PATH. It uses a minimal default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`).

**Fix**: The handlers construct an extended PATH internally:

```python
env["PATH"] = ":".join([
    os.path.expanduser("~/.mimocode/bin"),  # or ~/.kimi-code/bin
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    env.get("PATH", ""),
])
```

If your binary is in a non-standard location, set the `*_BIN` env var explicitly in the plist.

### 7.4 external_directory Error

**Symptom**: Mimo rejects file writes with an "external_directory" error.

**Cause**: Mimo's sandbox blocks writes outside the working directory by default.

**Fix**: The handler uses `--dangerously-skip-permissions` to bypass this. If you are invoking mimo manually, always pass this flag:

```bash
mimo run --dangerously-skip-permissions "your prompt"
```

For the worker to operate on a specific repo, set `ZZ_PROJECT_DIR` or `MIMO_INVOKE_WORKSPACE` to the repo path.

### 7.5 Agent Shows Offline

**Symptom**: Agent does not appear online on the dashboard.

**Checklist**:

1. Is the executor running? Check logs.
2. Is `ZZ_BASE_URL` correct? The platform must be reachable from the worker host.
3. Is the agent key valid? Verify with:
   ```bash
   curl -s "$ZZ_BASE_URL/v1/agent/projects" -H "X-API-Key: zzk_<key>"
   ```
4. Is the agent approved in the project? Check with:
   ```bash
   zz agents list --project <id>
   ```

### 7.6 Handler Timeout

**Symptom**: Handler returns "timed out before producing a result."

**Fix**: Increase the timeout:

```bash
export MIMO_INVOKE_TIMEOUT_SECONDS=3000
export CLAUDE_TIMEOUT_SECONDS=3000
export KIMI_TIMEOUT_SECONDS=3000
export CODEX_TIMEOUT_SECONDS=3000
```

### 7.7 Empty Output

**Symptom**: Handler returns "produced no output" with stderr.

**Cause**: The CLI crashed or encountered an auth/config error.

**Fix**: Check the stderr content in the response. Common causes:
- Missing API key for the LLM provider
- Rate limiting
- Model not available

---

## 8. File Reference

All templates live in `deploy/nas/agent-executors/`:

| File | Role |
|------|------|
| `claude-worker-executor-wrapper.py` | Claude executor bootstrap |
| `claude-worker-handler.py` | Claude task handler (`claude -p`) |
| `mimo-worker-executor-wrapper.py` | Mimo executor bootstrap |
| `mimo-invoke-handler.py` | Mimo task handler (`mimo run`) |
| `kimi-worker-executor-wrapper.py` | Kimi executor bootstrap |
| `kimi-worker-handler.py` | Kimi task handler (`kimi -p`) |
| `codex-worker-executor-wrapper.py` | Codex executor bootstrap |
| `codex-worker-handler.py` | Codex task handler (`codex exec`) |
| `codex-pm-executor-wrapper.py` | Codex PM-only wrapper (not a worker) |
| `codex-invoke-handler.py` | Codex invoke server bridge |
| `gemini-worker-handler.py` | Gemini handler (reference) |
| `aider-worker-handler.py` | Aider handler (reference) |
| `generate-executor-config.sh` | Unified plist/systemd generator |
| `com.zz-agent.mimo-executor.plist.template` | macOS launchd template (mimo) |
| `com.zz-agent.kimi-executor.plist.template` | macOS launchd template (kimi) |
| `zz-agent-executor.service.template` | Linux systemd template |
| `main-pm-heartbeat.py` | PM heartbeat helper |

## 9. Handler Contract

All handlers follow the same stdin/stdout contract:

```text
stdin:  task JSON {"task_id", "title", "goal", "acceptance_criteria", "project_id", "code_map"}
stdout: {"content": "<markdown result>"}
```

To add a new agent type:

1. Write a handler `<name>-handler.py` matching the contract above.
2. Write a wrapper `<name>-executor-wrapper.py` pointing at it.
3. Register the agent: `zz agents create --project <id> --name <n>`.
4. Run the wrapper with the new agent's key.

The platform is agent-agnostic — anything that can claim a task and submit a result works.

---

## 10. Environment Variable Quick Reference

| Variable | Default | Used By |
|----------|---------|---------|
| `ZZ_BASE_URL` | `http://127.0.0.1:18080/agent` | All wrappers |
| `ZZ_EXECUTOR_INTERVAL` | `30` | All wrappers |
| `ZZ_EXECUTOR_PATH` | `~/.zz-agent/executor.py` | All wrappers |
| `ZZ_PROJECT_DIR` | varies | All handlers (working directory) |
| `CLAUDE_AGENT_KEY` | — | Claude wrapper |
| `CLAUDE_BIN` | `claude` | Claude handler |
| `CLAUDE_TIMEOUT_SECONDS` | `1500` | Claude handler |
| `MIMO_AGENT_KEY` | — | Mimo wrapper |
| `MIMO_BIN` | `~/.mimocode/bin/mimo` | Mimo handler |
| `MIMO_INVOKE_TIMEOUT_SECONDS` | `1500` | Mimo handler |
| `KIMI_AGENT_KEY` | — | Kimi wrapper |
| `KIMI_BIN` | `~/.kimi-code/bin/kimi` | Kimi handler |
| `KIMI_TIMEOUT_SECONDS` | `1500` | Kimi handler |
| `CODEX_AGENT_KEY` | — | Codex wrapper |
| `CODEX_BIN` | auto-detected | Codex handler |
| `CODEX_HOME` | `~/.codex` | Codex handler |
| `CODEX_TIMEOUT_SECONDS` | `1500` | Codex handler |
