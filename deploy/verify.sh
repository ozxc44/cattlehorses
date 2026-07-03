#!/usr/bin/env bash
# Pre-release QA verification script for zhuzeyang-agent.
#
# Usage:
#   bash deploy/verify.sh                         # local build + unit checks
#   bash deploy/verify.sh --health                 # + health against BASE_URL
#   bash deploy/verify.sh --smoke                  # + smoke against BASE_URL
#   bash deploy/verify.sh --orchestration-smoke   # + smoke + orchestration loop
#   bash deploy/verify.sh --multiworker-smoke      # + NAS LAN multi-worker E2E
#   bash deploy/verify.sh --e2e                    # + full API E2E against BASE_URL
#   bash deploy/verify.sh --dashboard-e2e          # + browser-level dashboard E2E
#   bash deploy/verify.sh --onboarding-smoke       # + simplified onboarding pages E2E
#   bash deploy/verify.sh --orchestration-smoke    # smoke production (opt-in)
#   ALLOW_REMOTE_VERIFY=1 BASE_URL=http://<your-platform-host>:18080/agent \
#     bash deploy/verify.sh --multiworker-smoke    # multi-worker E2E on NAS
#   bash deploy/verify.sh                          # includes MD trace fixture gate
#
# Environment:
#   PYTHON_BIN           Python 3.10+ interpreter (auto-detected if unset). The
#                        SDK and CLI declare requires-python >=3.10.
#   NODE_BIN             Node interpreter (default: node)
#   NPM_BIN              npm binary (default: npm)
#   BASE_URL             Target base URL for remote checks
#                        (default: http://127.0.0.1:3000)
#   ALLOW_REMOTE_VERIFY  Set to 1 to allow write-like smoke/e2e steps against a
#                        non-localhost BASE_URL. Health checks do not require
#                        this opt-in.
#
# Smoke covers (deploy/smoke.sh):
#   - health, user register/login (JWT), project create, agent register
#   - agent runtime: /v1/agent/projects, /v1/agents/heartbeat,
#     /v1/agent/inbox, /v1/agent/workload (X-API-Key auth)
#   - optional orchestration: RUN_ORCHESTRATION_SMOKE=1
#     (main+worker registration, heartbeat, create orchestration, dispatch task,
#      claim, complete, review, workload check)
#
# By default all BASE_URL-dependent write operations target 127.0.0.1:3000.
# Pointing them at a public/production URL requires ALLOW_REMOTE_VERIFY=1.
#
# Returns non-zero on any failure.

set -euo pipefail

readonly SELF="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SELF"

# ---- config ----------------------------------------------------------------
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ALLOW_REMOTE_VERIFY="${ALLOW_REMOTE_VERIFY:-0}"
PYTHON_BIN="${PYTHON_BIN:-}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
VENV_DIR="${VENV_DIR:-$SELF/.venv}"
VENV_PYTHON="$VENV_DIR/bin/python"
PASS=0
FAIL=0
RUN_HEALTH=false
RUN_SMOKE=false
RUN_ORCHESTRATION_SMOKE=false
RUN_MULTIWORKER_SMOKE=false
RUN_E2E=false
RUN_DASHBOARD_E2E=false
RUN_ONBOARDING_SMOKE=false
E2E_JWT=""

# ---- helpers ---------------------------------------------------------------
pass() { PASS=$((PASS+1)); echo "  PASS: $*"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $*"; }

is_local_base_url() {
  local host=""
  [[ "$BASE_URL" =~ ^https?://(\[::1\]|[^/:]+) ]] || return 1
  host="${BASH_REMATCH[1]}"
  [[ "$host" =~ ^127\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
  [[ "$host" == "localhost" ]] || \
  [[ "$host" == "::1" ]] || \
  [[ "$host" == "[::1]" ]]
}

require_local_or_opt_in() {
  if [[ "$ALLOW_REMOTE_VERIFY" == "1" ]]; then
    return 0
  fi
  if is_local_base_url; then
    return 0
  fi
  fail "Refusing write-like verification against remote BASE_URL ($BASE_URL)." \
       "Set ALLOW_REMOTE_VERIFY=1 to opt in, or leave BASE_URL unset to use the local default."
  exit 1
}

usage() {
  echo "Usage: $0 [--health] [--smoke] [--orchestration-smoke] [--multiworker-smoke] [--e2e [jwt]] [--dashboard-e2e] [--onboarding-smoke]"
  echo "  --health              Check GET /v1/health against BASE_URL ($BASE_URL)"
  echo "  --smoke               Run smoke.sh against BASE_URL ($BASE_URL)"
  echo "  --orchestration-smoke Run smoke.sh with RUN_ORCHESTRATION_SMOKE=1; verifies"
  echo "                        full orchestration loop (register, heartbeat, dispatch,"
  echo "                        claim, complete, review, workload) against BASE_URL"
  echo "  --multiworker-smoke   Run scripts/nas-lan-multiworker-e2e.sh against BASE_URL"
  echo "                        ($BASE_URL). Requires ALLOW_REMOTE_VERIFY=1 for non-local URLs."
  echo "  --e2e [jwt]           Run API E2E flow against BASE_URL; optional jwt is exported for future tests"
  echo "  --dashboard-e2e       Run browser-level dashboard E2E via Playwright against BASE_URL"
  echo "  --onboarding-smoke    Run simplified human/agent onboarding E2E via Playwright against BASE_URL"
  echo ""
  echo "BASE_URL defaults to http://127.0.0.1:3000. To run write-like checks"
  echo "(--smoke, --orchestration-smoke, --multiworker-smoke, --e2e, --dashboard-e2e, --onboarding-smoke)"
  echo "against a non-localhost URL, set ALLOW_REMOTE_VERIFY=1."
}

die_usage() {
  usage
  exit 1
}

check_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    fail "required command not found: $1"; return 1
  }
}

# Find a Python 3.10+ interpreter. The SDK and CLI both declare
# requires-python = ">=3.10" and use pyproject.toml editable installs.
detect_python() {
  local candidate

  if [[ -n "$PYTHON_BIN" ]]; then
    if command -v "$PYTHON_BIN" >/dev/null 2>&1; then
      if "$PYTHON_BIN" -c "import sys; assert sys.version_info >= (3, 10)" 2>/dev/null; then
        return 0
      fi
      fail "PYTHON_BIN=$PYTHON_BIN is older than 3.10 (SDK/CLI require >=3.10)"
    else
      fail "PYTHON_BIN set but not found: $PYTHON_BIN"
    fi
    return 1
  fi

  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c "import sys; assert sys.version_info >= (3, 10)" 2>/dev/null; then
        PYTHON_BIN="$candidate"
        return 0
      fi
    fi
  done

  fail "Python 3.10+ is required but not found. Install Python >=3.10 or set PYTHON_BIN."
  return 1
}

# Create/update an isolated venv for SDK/CLI verification. This avoids PEP 668
# "externally managed environment" errors and keeps verification reproducible
# without touching the system Python.
ensure_venv() {
  local need_create=false

  if [[ ! -x "$VENV_PYTHON" ]]; then
    need_create=true
  elif ! "$VENV_PYTHON" -c "import sys; assert sys.version_info >= (3, 10)" 2>/dev/null; then
    need_create=true
  fi

  if $need_create; then
    echo "  Creating Python venv at $VENV_DIR using $PYTHON_BIN..."
    rm -rf "$VENV_DIR"
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  fi

  # Upgrade pip so editable pyproject.toml installs (PEP 660) work reliably.
  "$VENV_PYTHON" -m pip install -q --upgrade pip
}

# ---- arg parse -------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --health) RUN_HEALTH=true; shift ;;
    --smoke)  RUN_HEALTH=true; RUN_SMOKE=true; shift ;;
    --orchestration-smoke)
      RUN_HEALTH=true; RUN_SMOKE=true; RUN_ORCHESTRATION_SMOKE=true; shift ;;
    --multiworker-smoke)
      RUN_MULTIWORKER_SMOKE=true; shift ;;
    --e2e)
      RUN_HEALTH=true
      RUN_E2E=true
      if [[ -n "${2:-}" && "${2:0:1}" != "-" ]]; then
        E2E_JWT="$2"
        shift 2
      else
        shift
      fi
      ;;
    --dashboard-e2e)
      RUN_HEALTH=true
      RUN_DASHBOARD_E2E=true
      shift
      ;;
    --onboarding-smoke)
      RUN_HEALTH=true
      RUN_ONBOARDING_SMOKE=true
      shift
      ;;
    *)       die_usage ;;
  esac
done

echo "========================================"
echo "  ZZ Agent — Pre-Release QA Verification"
echo "  Repo root: $SELF"
echo "  BASE_URL:  $BASE_URL"
echo "========================================"
echo ""

# ---- remote-write safety guard ---------------------------------------------
if $RUN_SMOKE || $RUN_ORCHESTRATION_SMOKE || $RUN_MULTIWORKER_SMOKE || $RUN_E2E || \
   $RUN_DASHBOARD_E2E || $RUN_ONBOARDING_SMOKE; then
  require_local_or_opt_in
fi

# ---- prerequisites ---------------------------------------------------------
echo "--- [gate 0] prerequisites ---"
gate0_failed=false
check_cmd "$NODE_BIN" || gate0_failed=true
check_cmd "$NPM_BIN" || gate0_failed=true
detect_python || gate0_failed=true
check_cmd curl || gate0_failed=true
if ! $gate0_failed; then
  node_version="$($NODE_BIN --version | head -1)"
  npm_version="$($NPM_BIN --version | head -1)"
  python_version="$($PYTHON_BIN --version | head -1)"
  pass "node $node_version"
  pass "npm $npm_version"
  pass "$python_version (SDK/CLI require >=3.10)"
fi

# ---- gate 1: backend typecheck ---------------------------------------------
echo ""
echo "--- [gate 1] backend typecheck (tsc --noEmit) ---"
pushd backend >/dev/null
if $NPM_BIN run typecheck 2>&1 | tail -5; then
  pass "backend typecheck"
else
  fail "backend typecheck — see errors above"
fi
popd >/dev/null

# ---- gate 2: backend unit tests --------------------------------------------
echo ""
echo "--- [gate 2] backend unit tests ---"
pushd backend >/dev/null
# test:unit builds (tsc) then runs compiled test scripts
if $NPM_BIN run test:unit 2>&1 | tail -10; then
  pass "backend unit tests"
else
  fail "backend unit tests — see errors above"
fi
popd >/dev/null

# ---- gate 3: dashboard JS syntax check (all dashboard/*.html) ---------------
echo ""
echo "--- [gate 3] dashboard JS syntax (all dashboard/*.html) ---"
if [[ -d dashboard ]]; then
  if $NODE_BIN scripts/check-dashboard-syntax.js dashboard 2>&1; then
    pass "dashboard JS syntax"
  else
    fail "dashboard JS syntax — see errors above"
  fi
else
  fail "dashboard/ directory not found"
fi

# ---- gate 3b: final MD-driven PM trace fixture gate ------------------------
echo ""
echo "--- [gate 3b] MD-driven PM trace validator fixtures ---"
if $NODE_BIN scripts/validate-md-pm-trace.test.js 2>&1; then
  pass "MD-driven PM trace validator fixtures"
else
  fail "MD-driven PM trace validator fixtures — see errors above"
fi

# ---- gate 4: SDK compileall + import ---------------------------------------
echo ""
echo "--- [gate 4] SDK import check ---"
ensure_venv
if "$VENV_PYTHON" -m pip install -q -e sdk/python/ 2>&1 | tail -1; then
  if "$VENV_PYTHON" -c "import zz_agent; print('zz_agent', getattr(zz_agent, '__version__', 'ok'))" 2>&1; then
    pass "SDK import"
  else
    fail "SDK import failed"
  fi
else
  fail "SDK pip install"
fi

# ---- gate 5: CLI compileall + import ---------------------------------------
echo ""
echo "--- [gate 5] CLI import check ---"
if "$VENV_PYTHON" -m pip install -q -e cli/ 2>&1 | tail -1; then
  if "$VENV_PYTHON" -c "import zz_cli; print('zz_cli', getattr(zz_cli, '__version__', 'ok'))" 2>&1; then
    pass "CLI import"
  else
    fail "CLI import failed"
  fi
else
  fail "CLI pip install"
fi

echo ""
echo "SDK/CLI packages are installed in the local venv. To run Python tests:"
echo "  $VENV_PYTHON -m pip install pytest"
echo "  $VENV_PYTHON -m pytest cli/tests test_watch_smoke.py -q"

# ---- gate 6: public health smoke -------------------------------------------
echo ""
echo "--- [gate 6] health endpoint ---"
if $RUN_HEALTH; then
  if curl -fsS -o /dev/null -w "HTTP %{http_code}\n" "${BASE_URL%/}/v1/health" 2>&1; then
    pass "health endpoint at $BASE_URL/v1/health"
  else
    fail "health endpoint — is the server running?"
  fi
else
  echo "(skipped gate 6 — use --health, --smoke, --orchestration-smoke, or --e2e to check BASE_URL)"
fi

# ---- optional gate 7: deploy/smoke.sh ---------------------------------------
if $RUN_SMOKE; then
  echo ""
  echo "--- [gate 7] deploy/smoke.sh ---"
  if [[ "$RUN_ORCHESTRATION_SMOKE" == "true" ]]; then
    if BASE_URL="$BASE_URL" RUN_ORCHESTRATION_SMOKE=1 bash deploy/smoke.sh 2>&1 | tail -15; then
      pass "deploy/smoke.sh (orchestration smoke)"
    else
      fail "deploy/smoke.sh — see errors above"
    fi
  elif BASE_URL="$BASE_URL" bash deploy/smoke.sh 2>&1 | tail -15; then
    pass "deploy/smoke.sh"
  else
    fail "deploy/smoke.sh — see errors above"
  fi
else
  echo ""
  echo "(skipped gate 7 — use --smoke or --orchestration-smoke to run deploy/smoke.sh)"
fi

# ---- optional gate 8: production E2E ---------------------------------------
if $RUN_E2E; then
  echo ""
  echo "--- [gate 8] API E2E against BASE_URL ---"
  # Exercises register, login, project, agent, session, message, and events.
  # The current E2E script creates throwaway users and does not require a JWT.
  pushd backend >/dev/null
  # Build once so we can run standalone test scripts.
  $NPM_BIN run build >/dev/null 2>&1
  if NODE_ENV=test \
     API_URL="$BASE_URL" \
     E2E_JWT="$E2E_JWT" \
     $NODE_BIN dist/tests/e2e-api.test.js 2>&1 | tail -20; then
    pass "API E2E (e2e-api.test.js)"
  else
    fail "API E2E — see errors above"
  fi
  popd >/dev/null
else
  echo ""
  echo "(skipped gate 8 — use --e2e to run API E2E)"
fi

# ---- optional gate 9: dashboard E2E ----------------------------------------
if $RUN_DASHBOARD_E2E; then
  echo ""
  echo "--- [gate 9] Dashboard E2E (Playwright) against BASE_URL ---"
  if command -v python3 >/dev/null 2>&1 && python3 -c "from playwright.sync_api import sync_playwright" 2>/dev/null; then
    if BASE_URL="$BASE_URL" python3 deploy/dashboard-e2e.py 2>&1 | tail -25; then
      pass "Dashboard E2E (Playwright)"
    else
      fail "Dashboard E2E — see errors above"
    fi
  else
    fail "Dashboard E2E — python3 + playwright not available"
  fi
else
  echo ""
  echo "(skipped gate 9 — use --dashboard-e2e to run browser dashboard E2E)"
fi

# ---- optional gate 10: simplified onboarding smoke -------------------------
if $RUN_ONBOARDING_SMOKE; then
  echo ""
  echo "--- [gate 10] Onboarding smoke (Playwright) against BASE_URL ---"
  if command -v python3 >/dev/null 2>&1 && python3 -c "from playwright.sync_api import sync_playwright" 2>/dev/null; then
    if BASE_URL="$BASE_URL" python3 deploy/onboarding-smoke.py 2>&1 | tail -25; then
      pass "Onboarding smoke (Playwright)"
    else
      fail "Onboarding smoke — see errors above"
    fi
  else
    fail "Onboarding smoke — python3 + playwright not available"
  fi
else
  echo ""
  echo "(skipped gate 10 — use --onboarding-smoke to run simplified onboarding E2E)"
fi

# ---- optional gate 11: multi-worker E2E --------------------------------------
if $RUN_MULTIWORKER_SMOKE; then
  echo ""
  echo "--- [gate 11] multi-worker E2E (scripts/nas-lan-multiworker-e2e.sh) ---"
  # The multi-worker script reads NAS_BASE_URL; point it at the same target.
  if NAS_BASE_URL="$BASE_URL" bash scripts/nas-lan-multiworker-e2e.sh 2>&1 | tail -25; then
    pass "multi-worker E2E (nas-lan-multiworker-e2e.sh)"
  else
    fail "multi-worker E2E — see errors above"
  fi
else
  echo ""
  echo "(skipped gate 11 — use --multiworker-smoke to run scripts/nas-lan-multiworker-e2e.sh)"
fi

# ---- summary ---------------------------------------------------------------
echo ""
echo "========================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================"
exit $(( FAIL > 0 ? 1 : 0 ))
