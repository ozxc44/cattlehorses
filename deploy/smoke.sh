#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ALLOW_REMOTE_VERIFY="${ALLOW_REMOTE_VERIFY:-0}"
ALLOW_AGENT_RUNTIME_WARN="${ALLOW_AGENT_RUNTIME_WARN:-0}"
SMOKE_EMAIL="${SMOKE_EMAIL:-smoke+$(date +%s)@example.invalid}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-SmokeTestPassword123!}"
PROJECT_NAME="${PROJECT_NAME:-Production smoke project}"
FAKE_AGENT_ENDPOINT_URL="${FAKE_AGENT_ENDPOINT_URL:-http://127.0.0.1:7781/zz/v1/invoke}"
FAKE_AGENT_INVOKE_SECRET="${FAKE_AGENT_INVOKE_SECRET:-smoke-fake-invoke-secret}"

json_get() {
  node -e '
    const path = process.argv[1].split(".");
    let value = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const key of path) value = value && value[key];
    if (value === undefined || value === null) process.exit(2);
    process.stdout.write(String(value));
  ' "$1"
}

json_find_inbox_id() {
  node -e '
    const eventType = process.argv[1];
    const taskId = process.argv[2] || "";
    const payload = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const items = Array.isArray(payload.data) ? payload.data : [];
    const hit = items.find((item) =>
      item.event_type === eventType && (!taskId || item.task_id === taskId)
    );
    if (!hit || !hit.id) process.exit(2);
    process.stdout.write(String(hit.id));
  ' "$1" "${2:-}"
}

json_find_inbox_field() {
  node -e '
    const eventType = process.argv[1];
    const taskId = process.argv[2] || "";
    const field = process.argv[3];
    const payload = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const items = Array.isArray(payload.data) ? payload.data : [];
    const hit = items.find((item) =>
      item.event_type === eventType && (!taskId || item.task_id === taskId)
    );
    if (!hit || hit[field] === undefined) process.exit(2);
    process.stdout.write(String(hit[field]));
  ' "$1" "${2:-}" "$3"
}

json_assert_recent_task() {
  node -e '
    const taskId = process.argv[1];
    const payload = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const recent = Array.isArray(payload.recent) ? payload.recent : [];
    if (!recent.some((unit) => unit.task_id === taskId)) process.exit(2);
  ' "$1"
}

assert_eq() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: $label expected '$expected' but got '$actual'" >&2
    exit 1
  fi
}

warn_or_fail() {
  local msg="$1"
  if [[ "${ALLOW_AGENT_RUNTIME_WARN:-0}" == "1" ]]; then
    echo "WARN: $msg — continuing"
  else
    echo "ERROR: $msg" >&2
    exit 1
  fi
}

require_inbox_item() {
  local api_key="$1"
  local event_type="$2"
  local task_id="${3:-}"
  local label="$4"
  local inbox=""
  local item_id=""

  for _ in {1..10}; do
    inbox=$(request_agent GET "/v1/agent/inbox?unread=true&event_type=$event_type&limit=20" "" "$api_key")
    if item_id=$(printf '%s' "$inbox" | json_find_inbox_id "$event_type" "$task_id" 2>/dev/null); then
      echo "  $label inbox item: $item_id"
      return 0
    fi
    sleep 0.5
  done

  echo "ERROR: missing $label inbox item event_type=$event_type task_id=$task_id" >&2
  echo "Last inbox payload: $inbox" >&2
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

request_agent() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local api_key="$4"
  local headers=(-H "Content-Type: application/json" -H "X-API-Key: $api_key")

  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "${BASE_URL%/}$path" "${headers[@]}" -d "$body"
  else
    curl -fsS -X "$method" "${BASE_URL%/}$path" "${headers[@]}"
  fi
}

# Sleep until the ISO-8601 timestamp is reached, plus an optional buffer (ms).
sleep_until_iso() {
  local iso="$1"
  local extra_ms="${2:-200}"
  local wait_ms
  wait_ms=$(node -e '
    const target = new Date(process.argv[1]).getTime();
    const now = Date.now();
    const extra = parseInt(process.argv[2], 10);
    process.stdout.write(String(Math.max(0, target - now + extra)));
  ' "$iso" "$extra_ms")
  if [[ "$wait_ms" -gt 0 ]]; then
    local wait_s
    wait_s=$(awk "BEGIN {printf \"%.3f\", $wait_ms/1000}")
    sleep "$wait_s"
  fi
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
  echo "ERROR: Refusing smoke against remote BASE_URL ($BASE_URL)." >&2
  echo "Set ALLOW_REMOTE_VERIFY=1 to opt in, or leave BASE_URL unset to use the local default." >&2
  exit 1
}

# Abort early before any write-like request when targeting a non-local URL.
require_local_or_opt_in

echo "==> health: ${BASE_URL%/}/v1/health"
request GET /v1/health >/dev/null

echo "==> register smoke user"
register_body=$(printf '{"email":"%s","password":"%s","display_name":"Smoke Test"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")
if ! auth_response=$(request POST /v1/auth/register "$register_body" 2>/tmp/zz-agent-smoke-register.err); then
  if grep -q "Email already registered" /tmp/zz-agent-smoke-register.err; then
    echo "==> user exists; logging in"
    login_body=$(printf '{"email":"%s","password":"%s"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")
    auth_response=$(request POST /v1/auth/token "$login_body")
  else
    cat /tmp/zz-agent-smoke-register.err >&2
    exit 1
  fi
fi
token=$(printf '%s' "$auth_response" | json_get access_token)

echo "==> create project"
project_body=$(printf '{"name":"%s","description":"Created by deploy/smoke.sh"}' "$PROJECT_NAME")
project_response=$(request POST /v1/projects "$project_body" "$token")
project_id=$(printf '%s' "$project_response" | json_get id)
echo "project_id=$project_id"

echo "==> register fake runtime agent record"
agent_body=$(printf '{"name":"smoke-fake-agent","endpoint_url":"%s","invoke_secret":"%s","system_prompt":"Smoke test placeholder agent."}' "$FAKE_AGENT_ENDPOINT_URL" "$FAKE_AGENT_INVOKE_SECRET")
agent_response=$(request POST "/v1/projects/$project_id/agents" "$agent_body" "$token")
agent_id=$(printf '%s' "$agent_response" | json_get id)
agent_api_key=$(printf '%s' "$agent_response" | json_get api_key)
echo "agent_id=$agent_id"
echo "agent_api_key=${agent_api_key:0:12}..."  # prefix only for logging safety

# --- Agent runtime smoke: X-API-Key auth on /v1/agent/* endpoints ----------
if [[ -n "$agent_api_key" ]]; then
  echo "==> agent runtime: GET /v1/agent/projects (X-API-Key)"
  if ! agent_projects=$(request_agent GET /v1/agent/projects "" "$agent_api_key"); then
    warn_or_fail "agent projects discovery failed"
  else
    echo "agent_projects OK"
  fi

  echo "==> agent runtime: POST /v1/agents/heartbeat"
  if ! heartbeat_resp=$(request_agent POST /v1/agents/heartbeat '{}' "$agent_api_key"); then
    warn_or_fail "agent heartbeat failed"
  else
    echo "heartbeat OK: $heartbeat_resp"
  fi

  echo "==> agent runtime: GET /v1/agent/inbox"
  if ! inbox_resp=$(request_agent GET /v1/agent/inbox "" "$agent_api_key"); then
    warn_or_fail "agent inbox failed"
  else
    echo "inbox OK"
  fi

  echo "==> agent runtime: GET /v1/agent/workload"
  if ! workload_resp=$(request_agent GET /v1/agent/workload "" "$agent_api_key"); then
    warn_or_fail "agent workload failed"
  else
    echo "workload OK"
  fi
else
  warn_or_fail "no agent api_key in registration response; skipping /v1/agent/* runtime smoke"
fi

# --- Optional orchestration smoke (requires full project/task setup) ---------
# Set RUN_ORCHESTRATION_SMOKE=1 to attempt task create/claim/complete/review.
# Set RUN_LEASE_SMOKE=1 (with a short backend INBOX_LEASE_TTL_MS) to also
# exercise durable-inbox lease expiry and redelivery.
# This requires the backend to support project-task orchestration endpoints.
if [[ "${RUN_ORCHESTRATION_SMOKE:-0}" == "1" ]]; then
  echo "==> orchestration smoke (RUN_ORCHESTRATION_SMOKE=1)"

  main_agent_body=$(printf '{"name":"smoke-pm-agent","endpoint_url":"%s","invoke_secret":"%s","system_prompt":"Smoke test PM agent."}' "$FAKE_AGENT_ENDPOINT_URL" "$FAKE_AGENT_INVOKE_SECRET")
  main_agent_response=$(request POST "/v1/projects/$project_id/agents" "$main_agent_body" "$token")
  main_agent_id=$(printf '%s' "$main_agent_response" | json_get id)
  main_agent_api_key=$(printf '%s' "$main_agent_response" | json_get api_key)
  echo "main_agent_id=$main_agent_id"
  echo "main_agent_api_key=${main_agent_api_key:0:12}..."

  worker_agent_body=$(printf '{"name":"smoke-worker-agent","endpoint_url":"%s","invoke_secret":"%s","system_prompt":"Smoke test worker agent."}' "$FAKE_AGENT_ENDPOINT_URL" "$FAKE_AGENT_INVOKE_SECRET")
  worker_agent_response=$(request POST "/v1/projects/$project_id/agents" "$worker_agent_body" "$token")
  worker_agent_id=$(printf '%s' "$worker_agent_response" | json_get id)
  worker_agent_api_key=$(printf '%s' "$worker_agent_response" | json_get api_key)
  echo "worker_agent_id=$worker_agent_id"
  echo "worker_agent_api_key=${worker_agent_api_key:0:12}..."

  echo "  ==> heartbeat main agent"
  main_hb=$(request_agent POST /v1/agents/heartbeat '{"status":"active","metrics":{"load":0}}' "$main_agent_api_key")
  assert_eq "main agent dispatchable" "$(printf '%s' "$main_hb" | json_get dispatchable)" "true"
  echo "  main agent heartbeat OK"

  echo "  ==> heartbeat worker agent"
  worker_hb=$(request_agent POST /v1/agents/heartbeat '{"status":"active","metrics":{"load":0}}' "$worker_agent_api_key")
  assert_eq "worker agent dispatchable" "$(printf '%s' "$worker_hb" | json_get dispatchable)" "true"
  echo "  worker agent heartbeat OK"

  echo "  ==> create orchestration"
  orch_body=$(printf '{"title":"Smoke PM Loop","objective":"Verify orchestration task dispatch and review.","main_agent_id":"%s","worker_agent_ids":["%s"],"acceptance_criteria":["Worker evidence is reviewed"],"plan":"1. Dispatch task 2. Worker completes 3. PM reviews"}' "$main_agent_id" "$worker_agent_id")
  orch_response=$(request_agent POST "/v1/projects/$project_id/orchestrations" "$orch_body" "$main_agent_api_key")
  orch_id=$(printf '%s' "$orch_response" | json_get id)
  assert_eq "orchestration status" "$(printf '%s' "$orch_response" | json_get status)" "planning"
  echo "  orchestration_id=$orch_id"

  echo "  ==> dispatch task to worker"
  task_body=$(printf '{"title":"Smoke task","goal":"Return a brief result with evidence.","assigned_agent_id":"%s","acceptance_criteria":["Result exists"]}' "$worker_agent_id")
  task_response=$(request_agent POST "/v1/projects/$project_id/orchestrations/$orch_id/tasks" "$task_body" "$main_agent_api_key")
  task_id=$(printf '%s' "$task_response" | json_get id)
  assert_eq "task dispatch status" "$(printf '%s' "$task_response" | json_get status)" "dispatched"
  echo "  task_id=$task_id"

  echo "  ==> verify worker task_dispatched inbox item"
  require_inbox_item "$worker_agent_api_key" "task_dispatched" "$task_id" "worker dispatch"

  # --- Optional durable-inbox lease / redelivery smoke ------------------------
  # Set RUN_LEASE_SMOKE=1 and start the backend with a short INBOX_LEASE_TTL_MS
  # (e.g. 2000) to exercise lease expiry and redelivery end-to-end.
  if [[ "${RUN_LEASE_SMOKE:-0}" == "1" ]]; then
    echo "  ==> lease smoke: poll inbox to lease dispatched item"
    lease_inbox=""
    lease_item_id=""
    lease_token=""
    lease_expires=""
    delivery_attempts=""
    for _ in {1..10}; do
      lease_inbox=$(request_agent GET "/v1/agent/inbox?unread=true&event_type=task_dispatched&limit=20" "" "$worker_agent_api_key")
      if lease_item_id=$(printf '%s' "$lease_inbox" | json_find_inbox_id "task_dispatched" "$task_id" 2>/dev/null); then
        lease_token=$(printf '%s' "$lease_inbox" | json_find_inbox_field "task_dispatched" "$task_id" "lease_token")
        lease_expires=$(printf '%s' "$lease_inbox" | json_find_inbox_field "task_dispatched" "$task_id" "lease_expires_at")
        delivery_attempts=$(printf '%s' "$lease_inbox" | json_find_inbox_field "task_dispatched" "$task_id" "delivery_attempts")
        break
      fi
      sleep 0.5
    done
    if [[ -z "$lease_item_id" ]]; then
      echo "ERROR: lease smoke could not find dispatched inbox item" >&2
      exit 1
    fi
    echo "  lease smoke: item=$lease_item_id token=${lease_token:0:8}... expires=$lease_expires attempts=$delivery_attempts"

    echo "  ==> lease smoke: active lease must suppress immediate duplicate delivery"
    second_poll=$(request_agent GET "/v1/agent/inbox?unread=true&event_type=task_dispatched&limit=20" "" "$worker_agent_api_key")
    if duplicate_id=$(printf '%s' "$second_poll" | json_find_inbox_id "task_dispatched" "$task_id" 2>/dev/null); then
      echo "ERROR: actively leased item was returned on second poll (duplicate delivery) duplicate_id=$duplicate_id" >&2
      exit 1
    fi
    echo "  lease smoke: actively leased item suppressed on second poll"

    echo "  ==> lease smoke: wait for lease expiry then verify redelivery"
    # Avoid multi-minute waits if the backend is using the default 5 min TTL.
    lease_wait_ms=$(node -e '
      const target = new Date(process.argv[1]).getTime();
      process.stdout.write(String(Math.max(0, target - Date.now())));
    ' "$lease_expires")
    if [[ "$lease_wait_ms" -gt 30000 ]]; then
      echo "  WARN: INBOX_LEASE_TTL_MS is >30s; skipping lease expiry wait to keep smoke fast"
      echo "  Set INBOX_LEASE_TTL_MS <= 5000 and restart the backend to exercise lease expiry end-to-end."
    else
      sleep_until_iso "$lease_expires" 300
      redelivered_inbox=$(request_agent GET "/v1/agent/inbox?unread=true&event_type=task_dispatched&limit=20" "" "$worker_agent_api_key")
      redelivered_item_id=$(printf '%s' "$redelivered_inbox" | json_find_inbox_id "task_dispatched" "$task_id")
      new_token=$(printf '%s' "$redelivered_inbox" | json_find_inbox_field "task_dispatched" "$task_id" "lease_token")
      new_attempts=$(printf '%s' "$redelivered_inbox" | json_find_inbox_field "task_dispatched" "$task_id" "delivery_attempts")
      echo "  lease smoke: redelivered item=$redelivered_item_id token=${new_token:0:8}... attempts=$new_attempts"
      if [[ "$new_token" == "$lease_token" ]]; then
        echo "ERROR: redelivered item reused the old lease token" >&2
        exit 1
      fi
      if [[ "$new_attempts" -le "$delivery_attempts" ]]; then
        echo "ERROR: redelivery did not increment delivery_attempts ($new_attempts <= $delivery_attempts)" >&2
        exit 1
      fi
      echo "  lease smoke: redelivery OK (new lease token, delivery_attempts $delivery_attempts -> $new_attempts)"

      echo "  ==> lease smoke: ack redelivered item so it does not stay pending"
      ack_resp=$(request_agent POST "/v1/agent/inbox/$redelivered_item_id/ack" "" "$worker_agent_api_key")
      ack_status=$(printf '%s' "$ack_resp" | json_get status)
      assert_eq "ack status" "$ack_status" "acked"
      echo "  lease smoke: ack OK"
    fi
  fi

  echo "  ==> worker claims task"
  claim_resp=$(request_agent PATCH "/v1/projects/$project_id/orchestrations/$orch_id/tasks/$task_id/claim" "" "$worker_agent_api_key")
  claim_status=$(printf '%s' "$claim_resp" | json_get status)
  assert_eq "claim status" "$claim_status" "running"
  echo "  claim status: $claim_status"

  echo "  ==> worker completes task"
  complete_body='{"result_md":"# Smoke Result\n\nThe worker completed the smoke task. A result exists with passing evidence.","evidence":{"smoke_test":"pass","commands":["echo done"]},"status":"ready_for_review"}'
  complete_resp=$(request_agent POST "/v1/projects/$project_id/orchestrations/$orch_id/tasks/$task_id/complete" "$complete_body" "$worker_agent_api_key")
  complete_status=$(printf '%s' "$complete_resp" | json_get status)
  assert_eq "complete status" "$complete_status" "ready_for_review"
  echo "  complete status: $complete_status"

  echo "  ==> verify main task_ready_for_review inbox item"
  require_inbox_item "$main_agent_api_key" "task_ready_for_review" "$task_id" "main review"

  echo "  ==> main agent reviews task"
  review_body='{"decision":"approved","notes":"Smoke approved."}'
  review_resp=$(request_agent PATCH "/v1/projects/$project_id/orchestrations/$orch_id/tasks/$task_id/review" "$review_body" "$main_agent_api_key")
  review_decision=$(printf '%s' "$review_resp" | json_get status)
  assert_eq "review status" "$review_decision" "approved"
  echo "  review status: $review_decision"

  echo "  ==> verify worker task_approved inbox item"
  require_inbox_item "$worker_agent_api_key" "task_approved" "$task_id" "worker approval"

  echo "  ==> read workload for worker agent"
  worker_workload=$(request_agent GET /v1/agent/workload "" "$worker_agent_api_key")
  printf '%s' "$worker_workload" | json_assert_recent_task "$task_id"
  worker_units=$(printf '%s' "$worker_workload" | json_get summary.total_units)
  echo "  worker workload total_units: $worker_units"

  echo "  ==> read workload for main agent"
  main_workload=$(request_agent GET /v1/agent/workload "" "$main_agent_api_key")
  main_units=$(printf '%s' "$main_workload" | json_get summary.total_units)
  echo "  main workload total_units: $main_units"

  echo "  ==> complete orchestration"
  complete_orch_resp=$(request_agent PATCH "/v1/projects/$project_id/orchestrations/$orch_id/complete" '{"summary":"Smoke orchestration accepted."}' "$main_agent_api_key")
  assert_eq "orchestration complete status" "$(printf '%s' "$complete_orch_resp" | json_get status)" "completed"

  echo "  orchestration smoke OK: orchestration=$orch_id task=$task_id claim=$claim_status complete=$complete_status review=$review_decision"
else
  echo "(skipped orchestration smoke — set RUN_ORCHESTRATION_SMOKE=1 to attempt)"
fi

cat <<EOF
==> smoke complete

Covers:
  - health, user register/login (JWT)
  - project create, agent register (returns api_key for X-API-Key auth)
  - GET /v1/agent/projects (agent runtime discovery)
  - POST /v1/agents/heartbeat
  - GET /v1/agent/inbox
  - GET /v1/agent/workload
  - Optional orchestration: RUN_ORCHESTRATION_SMOKE=1 (register main+worker, heartbeat, create orchestration, dispatch task, claim, complete, review, workload check)
  - Optional lease / redelivery: RUN_LEASE_SMOKE=1 with a short backend INBOX_LEASE_TTL_MS (active-lease suppression, expiry, redelivery with new token, delivery_attempts increment)
  - Optional runtime loop: RUN_QUICKSTART=1 when 'zz' is on PATH
  - Agent runtime endpoints are fatal by default; set ALLOW_AGENT_RUNTIME_WARN=1
    to downgrade failures to WARN (compatibility/development mode only).

Optional runtime loop, after installing the Python SDK/CLI on the host:
  ZZ_API_KEY="<token from this smoke run>" zz dev quickstart-runtime --base-url "${BASE_URL%/}"

Set RUN_QUICKSTART=1 to run it automatically when 'zz' is on PATH.
EOF

if [[ "${RUN_QUICKSTART:-0}" == "1" ]]; then
  command -v zz >/dev/null
  ZZ_API_KEY="$token" zz dev quickstart-runtime --base-url "${BASE_URL%/}"
fi
