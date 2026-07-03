#!/usr/bin/env bash
# Live Time-to-First-Reviewed-Task (TTFT) measurement helper.
#
# Runs the Golden Path orchestration smoke end-to-end against a *local* backend,
# then reads the notification-metrics endpoint and asserts that the total
# `time_to_first_reviewed_task_ms` is below the configured threshold.
#
# Usage:
#   bash deploy/measure-ttft.sh
#   TTFT_THRESHOLD_MS=120000 TTFT_ARTIFACT_PATH=ttft.json bash deploy/measure-ttft.sh
#   START_BACKEND=1 bash deploy/measure-ttft.sh
#
# Environment:
#   BASE_URL                Target API base URL (default: http://127.0.0.1:3000)
#   ALLOW_REMOTE_VERIFY     Set to 1 to allow a non-local BASE_URL (default: 0)
#   TTFT_THRESHOLD_MS       TTFT SLA in milliseconds (default: 300000 = 5 min)
#   TTFT_ARTIFACT_PATH      Optional path to write a machine-readable JSON artifact
#   START_BACKEND           If 1 and BASE_URL is local/unhealthy, build and start
#                           the backend in NODE_ENV=test mode, then stop it on exit
#   PORT                    Port for auto-started backend (default: 3000)
#   NODE_BIN                Node interpreter (default: node)
#   SMOKE_EMAIL             Owner email for the measurement project
#   SMOKE_PASSWORD          Owner password for the measurement project
#   PROJECT_NAME            Project name used by the smoke run
#   FAKE_AGENT_ENDPOINT_URL Worker endpoint URL passed to the smoke
#   FAKE_AGENT_INVOKE_SECRET Worker invoke secret passed to the smoke
#
# Required local backend mode:
#   The backend must be running on localhost, or you must set START_BACKEND=1.
#   For a clean ephemeral measurement, run the backend with NODE_ENV=test so it
#   uses an in-memory SQLite database:
#       cd backend && npm run build
#       NODE_ENV=test PORT=3000 npm start
#   Then, in another shell:
#       bash deploy/measure-ttft.sh

set -euo pipefail

readonly SELF="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SELF"

# ---- config -----------------------------------------------------------------
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ALLOW_REMOTE_VERIFY="${ALLOW_REMOTE_VERIFY:-0}"
if [[ -z "${TTFT_THRESHOLD_MS+x}" ]]; then
  TTFT_THRESHOLD_MS="300000"
fi
TTFT_ARTIFACT_PATH="${TTFT_ARTIFACT_PATH:-}"
START_BACKEND="${START_BACKEND:-0}"
PORT="${PORT:-3000}"
NODE_BIN="${NODE_BIN:-node}"

if ! [[ "$TTFT_THRESHOLD_MS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: TTFT_THRESHOLD_MS must be a non-negative integer (got '$TTFT_THRESHOLD_MS')." >&2
  exit 1
fi

RUN_TS="$(date +%s)"
SMOKE_EMAIL="${SMOKE_EMAIL:-ttft+${RUN_TS}@example.invalid}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-TtftMeasurementPassword123!}"
PROJECT_NAME="${PROJECT_NAME:-TTFT measurement $(date -u +%Y-%m-%dT%H:%M:%SZ)}"
FAKE_AGENT_ENDPOINT_URL="${FAKE_AGENT_ENDPOINT_URL:-http://127.0.0.1:7781/zz/v1/invoke}"
FAKE_AGENT_INVOKE_SECRET="${FAKE_AGENT_INVOKE_SECRET:-ttft-fake-invoke-secret}"

# ---- helpers ----------------------------------------------------------------
json_get() {
  "$NODE_BIN" -e '
    const path = process.argv[1].split(".");
    let value = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const key of path) value = value && value[key];
    if (value === undefined || value === null) process.exit(2);
    process.stdout.write(String(value));
  ' "$1"
}

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
  echo "ERROR: Refusing TTFT measurement against remote BASE_URL ($BASE_URL)." >&2
  echo "Set ALLOW_REMOTE_VERIFY=1 to opt in, or leave BASE_URL unset to use the local default." >&2
  exit 1
}

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local auth="${4:-}"
  local headers=(-H "Content-Type: application/json")
  if [[ -n "$auth" ]]; then
    headers+=(-H "Authorization: Bearer $auth")
  fi

  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "${BASE_URL%/}$path" "${headers[@]}" -d "$body"
  else
    curl -fsS -X "$method" "${BASE_URL%/}$path" "${headers[@]}"
  fi
}

wait_for_health() {
  local deadline="$1"
  for ((i=1; i<=deadline; i++)); do
    if curl -fsS "${BASE_URL%/}/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ---- remote-write safety guard ---------------------------------------------
require_local_or_opt_in

# ---- optional backend auto-start --------------------------------------------
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if ! curl -fsS "${BASE_URL%/}/v1/health" >/dev/null 2>&1; then
  if [[ "$START_BACKEND" != "1" ]]; then
    echo "ERROR: no healthy backend at $BASE_URL" >&2
    echo "Start it manually, or set START_BACKEND=1 to build and run a local backend." >&2
    exit 1
  fi

  if ! is_local_base_url; then
    echo "ERROR: cannot auto-start a backend for a non-local BASE_URL ($BASE_URL)" >&2
    exit 1
  fi

  echo "==> building and starting local backend (NODE_ENV=test PORT=$PORT) ..."
  if [[ ! -f "backend/dist/src/index.js" ]]; then
    (cd backend && npm run build >/dev/null)
  fi

  # Use `exec node` directly so $server_pid is the server process and a
  # SIGTERM reliably tears it down.
  (cd backend && NODE_ENV=test PORT="$PORT" exec node dist/src/index.js >/tmp/zz-ttft-backend.log 2>&1) &
  server_pid=$!

  if ! wait_for_health 30; then
    echo "ERROR: local backend did not become healthy within 30s" >&2
    echo "Backend log tail:" >&2
    tail -30 /tmp/zz-ttft-backend.log >&2 || true
    exit 1
  fi
  echo "==> local backend healthy (pid $server_pid)"
fi

# ---- run Golden Path orchestration smoke ------------------------------------
echo "==> running Golden Path orchestration smoke ..."
smoke_output="$(mktemp)"
if ! BASE_URL="$BASE_URL" \
     SMOKE_EMAIL="$SMOKE_EMAIL" \
     SMOKE_PASSWORD="$SMOKE_PASSWORD" \
     PROJECT_NAME="$PROJECT_NAME" \
     FAKE_AGENT_ENDPOINT_URL="$FAKE_AGENT_ENDPOINT_URL" \
     FAKE_AGENT_INVOKE_SECRET="$FAKE_AGENT_INVOKE_SECRET" \
     RUN_ORCHESTRATION_SMOKE=1 \
     bash deploy/smoke.sh >"$smoke_output" 2>&1; then
  echo "ERROR: orchestration smoke failed" >&2
  tail -60 "$smoke_output" >&2
  rm -f "$smoke_output"
  exit 1
fi

project_id="$(grep -oE 'project_id=[^[:space:]]+' "$smoke_output" | head -1 | cut -d= -f2 || true)"
task_id="$(grep -oE 'task_id=[^[:space:]]+' "$smoke_output" | head -1 | cut -d= -f2 || true)"
rm -f "$smoke_output"

if [[ -z "$project_id" ]]; then
  echo "ERROR: could not extract project_id from smoke output" >&2
  exit 1
fi
if [[ -z "$task_id" ]]; then
  echo "ERROR: could not extract task_id from smoke output" >&2
  exit 1
fi

echo "  smoke project_id=$project_id task_id=$task_id"

# ---- obtain owner token ------------------------------------------------------
echo "==> obtaining owner token for metrics read ..."
login_body="$(printf '{"email":"%s","password":"%s"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")"
token="$(request POST /v1/auth/token "$login_body" | json_get access_token)"

# ---- read notification metrics ----------------------------------------------
echo "==> reading notification metrics ..."
metrics_response="$(request GET "/v1/projects/$project_id/notification-metrics" "" "$token")"

# Use Node to extract fields robustly and to build the artifact JSON.
measurement="$(printf '%s' "$metrics_response" | "$NODE_BIN" -e '
  const threshold = parseInt(process.argv[1], 10);
  const taskId = process.argv[2];
  const projectId = process.argv[3];
  const baseUrl = process.argv[4];
  const artifactPath = process.argv[5] || null;
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const summary = data.summary || {};

  const ttftMs = typeof summary.time_to_first_reviewed_task_ms === "number"
    ? summary.time_to_first_reviewed_task_ms
    : null;
  const phases = summary.ttft_phases || null;

  let pass = true;
  const failures = [];
  if (ttftMs === null) {
    pass = false;
    failures.push("time_to_first_reviewed_task_ms is null (no reviewed task recorded)");
  }
  if (ttftMs !== null && ttftMs >= threshold) {
    pass = false;
    failures.push(`TTFT ${ttftMs}ms exceeds threshold ${threshold}ms`);
  }
  if (phases === null) {
    pass = false;
    failures.push("ttft_phases is null");
  }

  const result = {
    schema_version: "ttft-measurement/v1",
    measured_at: new Date().toISOString(),
    base_url: baseUrl,
    project_id: projectId,
    task_id: taskId,
    threshold_ms: threshold,
    time_to_first_reviewed_task_ms: ttftMs,
    ttft_phases: phases,
    pass,
    failures: failures.length ? failures : undefined,
    artifact_path: artifactPath || undefined,
  };
  process.stdout.write(JSON.stringify(result, null, 2));
' "$TTFT_THRESHOLD_MS" "$task_id" "$project_id" "$BASE_URL" "${TTFT_ARTIFACT_PATH:-}")"

# ---- write artifact ----------------------------------------------------------
if [[ -n "$TTFT_ARTIFACT_PATH" ]]; then
  printf '%s\n' "$measurement" > "$TTFT_ARTIFACT_PATH"
  echo "==> artifact written: $TTFT_ARTIFACT_PATH"
fi

# ---- emit result -------------------------------------------------------------
printf '%s\n' "$measurement"

if [[ "$(printf '%s' "$measurement" | "$NODE_BIN" -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(d.pass?"true":"false"))')" != "true" ]]; then
  echo "==> TTFT measurement FAILED" >&2
  exit 1
fi

echo "==> TTFT measurement PASSED"
