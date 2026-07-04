#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# R23c: deploy/sync-all.sh — one-command NAS + GitHub + CI sync
#
# One command pushes the local main branch, syncs the NAS backend container,
# rolls out the latest executor.py, restarts local worker executors, and
# verifies platform health + worker heartbeats + GitHub CI status.
#
# Usage:
#   bash deploy/sync-all.sh
#   bash deploy/sync-all.sh --check     # report status only, make no changes
#
# Configuration (env vars):
#   NAS_HOST              NAS hostname/IP (required for NAS sync)
#   NAS_USER              SSH user on NAS [default: $USER]
#   NAS_REPO_DIR          Repo path on NAS [default: /opt/cattlehorses]
#   NAS_COMPOSE_DIR       docker-compose.yml directory on NAS
#                         [default: $NAS_REPO_DIR/deploy/nas]
#   NAS_SSH_KEY           Optional SSH private key path
#   COMPOSE_PROJECT_NAME  Docker Compose project name [default: agentcollab]
#   ZZ_BASE_URL           Platform base URL [default: http://localhost:18080/agent]
#   ZZ_PROJECT_ID         Project ID to verify worker heartbeats (optional)
#   ZZ_USER_TOKEN         User JWT for platform API (optional, also reads
#                         ~/.zz/config.json access_token)
#   ZZ_AGENT_HOME         Local agent directory [default: ~/.zz-agent]
#   GH_REPO               Override GitHub owner/repo (auto-detected from origin)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── config / defaults ─────────────────────────────────────────────────────────
DRY_RUN=false
NAS_HOST="${NAS_HOST:-}"
NAS_USER="${NAS_USER:-${USER:-}}"
NAS_REPO_DIR="${NAS_REPO_DIR:-/opt/cattlehorses}"
NAS_COMPOSE_DIR="${NAS_COMPOSE_DIR:-$NAS_REPO_DIR/deploy/nas}"
NAS_SSH_KEY="${NAS_SSH_KEY:-}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-agentcollab}"
BACKEND_SERVICE="backend"
ZZ_BASE_URL="${ZZ_BASE_URL:-http://localhost:18080/agent}"
ZZ_PROJECT_ID="${ZZ_PROJECT_ID:-}"
ZZ_USER_TOKEN="${ZZ_USER_TOKEN:-}"
ZZ_AGENT_HOME="${ZZ_AGENT_HOME:-$HOME/.zz-agent}"
EXECUTOR_SRC="$REPO_ROOT/cli/zz_cli/executor.py"
HEARTBEAT_MAX_AGE_MS="${HEARTBEAT_MAX_AGE_MS:-120000}"

PASS=0
FAIL=0
WARN=0

# ── helpers ───────────────────────────────────────────────────────────────────
log_step() { echo ""; echo "▶ $*"; }
pass() { PASS=$((PASS+1)); echo "  ✓ $*"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $*" >&2; }
warn() { WARN=$((WARN+1)); echo "  ⚠ $*"; }

die() { echo "ERROR: $*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# //'
  echo ""
  echo "Usage: $0 [--check]"
  echo "  --check   Report status only; do not push, copy, build, or restart."
}

# Parse CLI args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) DRY_RUN=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

if $DRY_RUN; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║   sync-all --check (read-only status report)                 ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
else
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║   sync-all — NAS + GitHub + CI sync                          ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
fi

# Resolve SSH options
SSH_OPTS=(-o "BatchMode=yes" -o "ConnectTimeout=5" -o "StrictHostKeyChecking=accept-new")
if [[ -n "$NAS_SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$NAS_SSH_KEY")
fi
NAS_SSH=""
if [[ -n "$NAS_HOST" ]]; then
  NAS_SSH="${NAS_USER}@${NAS_HOST}"
fi

# Try to load a user token from ~/.zz/config.json if not provided
load_user_token() {
  if [[ -n "$ZZ_USER_TOKEN" ]]; then
    return 0
  fi
  local config_file="$HOME/.zz/config.json"
  if [[ -f "$config_file" ]] && command -v python3 >/dev/null 2>&1; then
    ZZ_USER_TOKEN="$(python3 -c "import json,sys; print(json.load(open('$config_file')).get('access_token',''))" 2>/dev/null || true)"
  fi
}
load_user_token

# ── 1. Local git status / push ────────────────────────────────────────────────
log_step "1. Local git status"

current_branch="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || echo "unknown")"
if [[ "$current_branch" != "main" ]]; then
  warn "not on main branch (currently '$current_branch')"
else
  pass "on branch main"
fi

remote_url="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
if [[ -n "$remote_url" ]]; then
  pass "origin remote: ${remote_url}"
else
  warn "no origin remote configured"
fi

if [[ -n "$remote_url" ]] && [[ "$current_branch" == "main" ]]; then
  ahead_behind="$(git -C "$REPO_ROOT" rev-list --left-right --count origin/main...main 2>/dev/null || echo "?\t?")"
  ahead="$(echo "$ahead_behind" | awk '{print $2}')"
  behind="$(echo "$ahead_behind" | awk '{print $1}')"
  if [[ "$ahead" == "0" && "$behind" == "0" ]]; then
    pass "local main is in sync with origin"
  else
    warn "local main: $ahead ahead, $behind behind origin/main"
  fi
fi

if [[ -n "$(git -C "$REPO_ROOT" status --short 2>/dev/null)" ]]; then
  warn "working tree has uncommitted changes"
else
  pass "working tree clean"
fi

if ! $DRY_RUN; then
  log_step "1b. git push origin main"
  if [[ "$current_branch" != "main" ]]; then
    fail "refusing to push: not on main branch"
  elif [[ -z "$remote_url" ]]; then
    fail "refusing to push: no origin remote"
  else
    if git -C "$REPO_ROOT" push origin main; then
      pass "pushed origin main"
    else
      fail "git push origin main failed"
    fi
  fi
fi

# ── 2. NAS sync (git pull → copy backend/src → build → migrate → restart) ─────
log_step "2. NAS backend sync"

if [[ -z "$NAS_HOST" ]]; then
  warn "NAS_HOST not set; skipping NAS sync"
else
  nas_reachable=false
  if ssh "${SSH_OPTS[@]}" "$NAS_SSH" "echo ok" >/dev/null 2>&1; then
    nas_reachable=true
    pass "NAS reachable ($NAS_SSH)"
  else
    fail "NAS unreachable ($NAS_SSH)"
  fi

  if $DRY_RUN; then
    if $nas_reachable; then
      # Check remote container status without making changes
      remote_backend_status="$(ssh "${SSH_OPTS[@]}" "$NAS_SSH" "
        cd '$NAS_COMPOSE_DIR' 2>/dev/null || exit 1
        docker compose --env-file .env ps --format json '$BACKEND_SERVICE' 2>/dev/null || echo 'not running'
      " 2>/dev/null || true)"
      if [[ -n "$remote_backend_status" && "$remote_backend_status" != "not running" ]]; then
        pass "NAS backend container reported: $(echo "$remote_backend_status" | head -1)"
      else
        warn "NAS backend container status unavailable"
      fi
    fi
  elif $nas_reachable; then
    log_step "2b. NAS: git pull + copy backend/src + build + migrate + restart"
    if ssh "${SSH_OPTS[@]}" "$NAS_SSH" "
      set -euo pipefail
      export COMPOSE_PROJECT_NAME='$COMPOSE_PROJECT_NAME'
      echo '  [NAS] git pull in $NAS_REPO_DIR'
      cd '$NAS_REPO_DIR'
      git pull origin main

      echo '  [NAS] locating backend container'
      cd '$NAS_COMPOSE_DIR'
      CID=\$(docker compose --env-file .env ps -q '$BACKEND_SERVICE' | head -1)
      if [[ -z \"\$CID\" ]]; then
        echo '  [NAS] backend container not running; starting compose stack'
        docker compose --env-file .env up -d --build
        CID=\$(docker compose --env-file .env ps -q '$BACKEND_SERVICE' | head -1)
      fi
      echo \"  [NAS] backend container: \$CID\"

      echo '  [NAS] copying backend/src into container'
      docker cp '$NAS_REPO_DIR/backend/src/.' \"\$CID:/app/backend/src/\"

      echo '  [NAS] build + migrate inside container'
      docker compose --env-file .env exec -T '$BACKEND_SERVICE' sh -c 'npm run build && npm run migration:run'

      echo '  [NAS] restarting backend'
      docker compose --env-file .env restart '$BACKEND_SERVICE'

      echo '  [NAS] waiting for health'
      for i in \$(seq 1 30); do
        if curl -fsS 'http://localhost:18080/agent/v1/health' >/dev/null 2>&1; then
          echo '  [NAS] backend healthy'
          break
        fi
        if [[ \"\$i\" -eq 30 ]]; then
          echo '  [NAS] backend not healthy after 5 min' >&2
          exit 1
        fi
        sleep 10
      done
    "; then
      pass "NAS backend synced and healthy"
    else
      fail "NAS backend sync failed"
    fi
  fi
fi

# ── 3. Roll out executor.py ───────────────────────────────────────────────────
log_step "3. Roll out executor.py"

if [[ ! -f "$EXECUTOR_SRC" ]]; then
  fail "executor.py source not found: $EXECUTOR_SRC"
else
  pass "executor.py source found"
fi

# 3a. Local ~/.zz-agent/
if [[ -f "$EXECUTOR_SRC" ]]; then
  mkdir -p "$ZZ_AGENT_HOME"
  local_executor="$ZZ_AGENT_HOME/executor.py"
  if [[ -f "$local_executor" ]] && diff -q "$EXECUTOR_SRC" "$local_executor" >/dev/null 2>&1; then
    pass "~/.zz-agent/executor.py already up to date"
  else
    if ! $DRY_RUN; then
      cp -p "$EXECUTOR_SRC" "$local_executor"
      chmod 700 "$local_executor"
    fi
    pass "~/.zz-agent/executor.py $(if $DRY_RUN; then echo 'would be '; fi)updated"
  fi
fi

# 3b. Backend container (so /v1/agent/bootstrap/executor.py serves the latest)
if [[ -n "$NAS_HOST" ]] && [[ -f "$EXECUTOR_SRC" ]]; then
  if $DRY_RUN; then
    pass "executor.py container copy $(if $nas_reachable; then echo 'would be'; else echo 'skipped (NAS unreachable)'; fi) pushed to /app/cli/zz_cli/executor.py"
  else
    if ssh "${SSH_OPTS[@]}" "$NAS_SSH" "
      set -euo pipefail
      cd '$NAS_COMPOSE_DIR'
      CID=\$(docker compose --env-file .env ps -q '$BACKEND_SERVICE' | head -1)
      if [[ -z \"\$CID\" ]]; then
        echo 'backend container not found' >&2
        exit 1
      fi
      docker cp '$NAS_REPO_DIR/cli/zz_cli/executor.py' \"\$CID:/app/cli/zz_cli/executor.py\"
      echo \"copied executor.py to \$CID:/app/cli/zz_cli/executor.py\"
    "; then
      pass "executor.py copied into backend container"
    else
      fail "executor.py container copy failed"
    fi
  fi
fi

# ── 4. Restart local worker executors (launchctl) ─────────────────────────────
log_step "4. Restart worker executors"

if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "launchctl restart only implemented for macOS; this host is $(uname -s)"
else
  launchagents_dir="$HOME/Library/LaunchAgents"
  mapfile -t plist_files < <(find "$launchagents_dir" -maxdepth 1 -name 'com.zz-agent.*-executor.plist' 2>/dev/null || true)

  if [[ ${#plist_files[@]} -eq 0 ]]; then
    warn "no com.zz-agent.*-executor.plist files found in $launchagents_dir"
  else
    for plist in "${plist_files[@]}"; do
      label="$(basename "$plist" .plist)"
      loaded=false
      if launchctl list "$label" >/dev/null 2>&1; then
        loaded=true
      fi
      if $DRY_RUN; then
        if $loaded; then
          pass "$label is loaded"
        else
          warn "$label is present but not loaded"
        fi
      else
        launchctl unload "$plist" >/dev/null 2>&1 || true
        if launchctl load "$plist"; then
          pass "$label restarted"
        else
          fail "$label restart failed"
        fi
      fi
    done
  fi
fi

# ── 5. Verify health + worker heartbeats + CI ─────────────────────────────────
log_step "5. Verification"

# 5a. Platform health
health_url="${ZZ_BASE_URL%/}/v1/health"
if curl -fsS "$health_url" >/dev/null 2>&1; then
  pass "platform health OK ($health_url)"
else
  fail "platform health check failed ($health_url)"
fi

# 5b. Worker heartbeat check (requires project + user token)
if [[ -z "$ZZ_PROJECT_ID" ]]; then
  warn "ZZ_PROJECT_ID not set; skipping per-worker heartbeat check"
elif [[ -z "$ZZ_USER_TOKEN" ]]; then
  warn "ZZ_USER_TOKEN not available; skipping per-worker heartbeat check"
else
  agents_url="${ZZ_BASE_URL%/}/v1/projects/$ZZ_PROJECT_ID/agents"
  agents_json="$(curl -fsS -H "Authorization: Bearer $ZZ_USER_TOKEN" "$agents_url" 2>/dev/null || true)"
  if [[ -z "$agents_json" ]]; then
    fail "could not list agents for project $ZZ_PROJECT_ID"
  else
    heartbeat_report="$(python3 - "$HEARTBEAT_MAX_AGE_MS" <<'PY'
import json, sys
max_age = int(sys.argv[1])
data = json.load(sys.stdin)
agents = data.get('data', [])
if not agents:
    print('no_agents')
else:
    online = 0
    stale = 0
    offline = 0
    for a in agents:
        name = a.get('name', a.get('id', '?'))
        is_online = a.get('is_online', False)
        age = a.get('heartbeat_age_ms')
        if is_online and (age is None or age <= max_age):
            online += 1
            print(f'ok {name}')
        elif is_online:
            stale += 1
            print(f'stale {name} age_ms={age}')
        else:
            offline += 1
            print(f'offline {name}')
    print(f'summary online={online} stale={stale} offline={offline}')
PY
    )" || true
    if [[ -n "$heartbeat_report" ]]; then
      summary_line="$(echo "$heartbeat_report" | grep '^summary' || true)"
      online_count="$(echo "$summary_line" | grep -oE 'online=[0-9]+' | cut -d= -f2 || echo 0)"
      stale_count="$(echo "$summary_line" | grep -oE 'stale=[0-9]+' | cut -d= -f2 || echo 0)"
      offline_count="$(echo "$summary_line" | grep -oE 'offline=[0-9]+' | cut -d= -f2 || echo 0)"
      if [[ "$stale_count" -gt 0 || "$offline_count" -gt 0 ]]; then
        fail "worker heartbeat check: $summary_line"
      else
        pass "worker heartbeat check: $summary_line"
      fi
    else
      fail "failed to parse agent list"
    fi
  fi
fi

# 5c. GitHub CI status
log_step "5c. GitHub CI status"
if ! command -v gh >/dev/null 2>&1; then
  warn "gh CLI not installed; skipping CI status"
else
  # Auto-detect owner/repo from origin if GH_REPO not set
  gh_repo="${GH_REPO:-}"
  if [[ -z "$gh_repo" && -n "$remote_url" ]]; then
    if [[ "$remote_url" =~ github\.com[:/]([^/]+/[^/]+)(\.git)?$ ]]; then
      gh_repo="${BASH_REMATCH[1]}"
    fi
  fi
  if [[ -z "$gh_repo" ]]; then
    warn "origin is not a github.com URL; skipping CI status"
  else
    ci_json="$(gh run list --repo "$gh_repo" --branch main --limit 1 --json status,conclusion,url,name 2>/dev/null || true)"
    if [[ -z "$ci_json" ]]; then
      fail "could not fetch CI status for $gh_repo"
    else
      ci_report="$(python3 - <<'PY'
import json, sys
data = json.load(sys.stdin)
if not data:
    print('no_runs')
else:
    run = data[0]
    status = run.get('status', '?')
    conclusion = run.get('conclusion') or 'in-progress'
    name = run.get('name', 'CI')
    url = run.get('url', '')
    print(f'{status}|{conclusion}|{name}|{url}')
PY
      )" || true
      if [[ "$ci_report" == "no_runs" ]]; then
        warn "no CI runs found on main for $gh_repo"
      elif [[ -n "$ci_report" ]]; then
        IFS='|' read -r ci_status ci_conclusion ci_name ci_url <<< "$ci_report"
        if [[ "$ci_status" == "completed" && "$ci_conclusion" == "success" ]]; then
          pass "CI $ci_name: $ci_conclusion ($ci_url)"
        elif [[ "$ci_status" == "completed" ]]; then
          fail "CI $ci_name: $ci_conclusion ($ci_url)"
        else
          warn "CI $ci_name: $ci_status ($ci_url)"
        fi
      else
        fail "could not parse CI status"
      fi
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
if $DRY_RUN; then
  echo "║   sync-all --check summary                                   ║"
else
  echo "║   sync-all summary                                           ║"
fi
echo "╠══════════════════════════════════════════════════════════════╣"
printf  "║   PASS: %-3d   WARN: %-3d   FAIL: %-3d                      ║\n" "$PASS" "$WARN" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════╝"

exit $(( FAIL > 0 ? 1 : 0 ))
