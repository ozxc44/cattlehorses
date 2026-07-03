#!/usr/bin/env bash
# Durable local parity command for CI's golden-path-smoke job.
#
# Mirrors `.github/workflows/ci.yml` lines 122-163 (CI `golden-path-smoke` job),
# including CI-equivalent backend start env (NODE_ENV/PORT/INBOX_LEASE_TTL_MS):
#   1. npm ci + build (backend/)
#   2. Start backend on 127.0.0.1:3000 with CI-equivalent env, wait up to 30 s for health
#   3. RUN_LEASE_SMOKE=1 RUN_ORCHESTRATION_SMOKE=1 bash deploy/smoke.sh
#   4. node dist/tests/e2e-api.test.js  (always, even if smoke fails)
#   5. Kill backend                              (always, even if E2E fails)
#   6. Exit non-zero if either smoke or E2E failed
#
# Usage:
#   bash scripts/golden-path-smoke.sh
#
# Environment:
#   SMOKE_EMAIL      (default: smoke+<timestamp>@example.invalid)
#   SMOKE_PASSWORD   (default: SmokeTestPassword123!)
#
# Exit code: 0 on full success, non-zero if any step failed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FAILED=0

cleanup() {
  local code=$?
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT

echo "=========================================="
echo " Golden Path Smoke — CI Parity (Local)"
echo "=========================================="

# ---- 1. Install backend dependencies -----------------------------------------
echo ""
echo "--- [1/6] Install backend dependencies (npm ci) ---"
cd backend
npm ci
cd "$REPO_ROOT"

# ---- 2. Build backend --------------------------------------------------------
echo ""
echo "--- [2/6] Build backend (npm run build) ---"
cd backend
npm run build
cd "$REPO_ROOT"

# ---- 3. Start backend and wait for health ------------------------------------
echo ""
echo "--- [3/6] Start backend + wait for health ---"
cd backend
# CI-equivalent backend env (see .github/workflows/ci.yml "Start backend and wait
# for health"). INBOX_LEASE_TTL_MS=2000 keeps lease expiry/redelivery within the
# smoke's <30s wait window (deploy/smoke.sh skips it above a 30s TTL).
NODE_ENV=test PORT=3000 INBOX_LEASE_TTL_MS=2000 npm start &
SERVER_PID=$!
cd "$REPO_ROOT"

for i in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/v1/health >/dev/null 2>&1; then
    echo "  Backend healthy after ${i}s (PID=$SERVER_PID)"
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "  ERROR: backend failed to become healthy within 30 s" >&2
    exit 1
  fi
  sleep 1
done

# ---- 4. Run Golden Path orchestration smoke ----------------------------------
echo ""
echo "--- [4/6] Golden Path orchestration smoke ---"
if RUN_LEASE_SMOKE=1 RUN_ORCHESTRATION_SMOKE=1 BASE_URL=http://127.0.0.1:3000 bash deploy/smoke.sh; then
  echo "  SMOKE PASSED"
else
  echo "  SMOKE FAILED — continuing for E2E diagnostics"
  FAILED=1
fi

# ---- 5. API E2E (always, even if smoke failed) --------------------------------
echo ""
echo "--- [5/6] API E2E ---"
if NODE_ENV=test API_URL=http://127.0.0.1:3000 node backend/dist/tests/e2e-api.test.js; then
  echo "  E2E PASSED"
else
  echo "  E2E FAILED"
  FAILED=1
fi

# ---- 6. Stop backend (cleanup trap handles this, but log it) ------------------
echo ""
echo "--- [6/6] Stop backend ---"
# trap handles actual kill; this is a status step
echo "  Backend PID $SERVER_PID will be cleaned up by trap"

# ---- Summary -----------------------------------------------------------------
echo ""
echo "=========================================="
if [[ "$FAILED" -eq 0 ]]; then
  echo "  Result: ALL PASSED"
else
  echo "  Result: $FAILED step(s) FAILED"
fi
echo "=========================================="
exit "$FAILED"
