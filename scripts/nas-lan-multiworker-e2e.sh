#!/usr/bin/env bash
# nas-lan-multiworker-e2e.sh
# End-to-end multi-worker project collaboration smoke test.
#
# Modes (pass as $1):
#   full (default)  — Full 12-step multi-worker E2E (original flow)
#   race            — Claim-race stress test (default 30 attempts on NAS, 100 locally)
#   persistence     — Full E2E + re-query persistence check after restart
#   persistence-check — Standalone persistence check given existing IDs via env vars
#
# Env vars (all optional — defaults are LAN smoke placeholders):
#   NAS_BASE_URL      LAN backend URL  [default: http://<your-platform-host>:18080/agent]
#   SMOKE_EMAIL       throwaway email   [default: smoke+$(date +%s)@example.invalid]
#   SMOKE_PASSWORD    throwaway pw     [default: SmokeMultiWorker2026!]
#   GITEA_SYNC        enable Gitea sync [default: false]
#   RACE_LOOPS        claim-race attempts [default: 30 on NAS, 100 for CI/local]
#   RUN_ID            explicit run id   [default: auto-generated]
#   VERBOSE           set to "true" for verbose curl output
#
# persistence-check env vars (must provide all when using that mode):
#   PC_PROJECT_ID
#   PC_ORCHESTRATION_ID
#   PC_TASK_IDS            comma-separated
#   PC_CHANGESET_ID
#   PC_COMMIT_ID
#   PC_MAIN_AGENT_KEY      set out-of-band; never echo the value
#   PC_JWT                 set out-of-band; never echo the value
#   PC_URL                 backend base URL
#
set -euo pipefail

MODE="${1:-full}"

# ── Base env vars ──────────────────────────────────────────────────────────
BASE_URL="${NAS_BASE_URL:-http://<your-platform-host>:18080/agent}"
API_URL="${BASE_URL%/}/v1"
SMOKE_EMAIL="${SMOKE_EMAIL:-smoke+$(date +%s)@example.invalid}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-SmokeMultiWorker2026!}"
PROJECT_NAME="E2E Multi-worker Project $(date +%Y%m%dT%H%M%S)"
GITEA_SYNC="${GITEA_SYNC:-false}"
VERBOSE="${VERBOSE:-false}"

# ── Gitea gate ─────────────────────────────────────────────────────────────
if [[ "$GITEA_SYNC" != "false" ]]; then
  echo "ERROR: Gitea sync (GITEA_SYNC=$GITEA_SYNC) is enabled. Multi-worker E2E must use false." >&2
  exit 1
fi
if [[ "${GITEA_SYNC_ENABLED:-}" == "true" ]]; then
  echo "ERROR: Gitea sync is enabled (GITEA_SYNC_ENABLED=true). Multi-worker E2E must not run with sync enabled." >&2
  exit 1
fi
if [[ "${GITEA_SYNC_DRY_RUN:-}" == "false" ]]; then
  echo "ERROR: Gitea sync dry-run is disabled (GITEA_SYNC_DRY_RUN=false). Multi-worker E2E must not run without dry-run guard." >&2
  exit 1
fi

# ── Run ID ─────────────────────────────────────────────────────────────────
if [[ -n "${RUN_ID:-}" ]]; then
  EVIDENCE_RUN_ID="$RUN_ID"
else
  EVIDENCE_RUN_ID="mw-$(date +%Y%m%d-%H%M%S)-$$"
fi

# ── Race loops ─────────────────────────────────────────────────────────────
RACE_LOOPS="${RACE_LOOPS:-30}"  # default 30 (NAS); CI/local override to 100

# ── Helper: detect if we are on NAS or local/CI ────────────────────────────
is_nas() {
  # heuristic: NAS_BASE_URL uses 192.168.x.x
  [[ "$BASE_URL" =~ \.168\. ]] || [[ "$BASE_URL" =~ \/nas\. ]]
}

# ── Curl helper with optional verbose ──────────────────────────────────────
curl_cmd() {
  if [[ "$VERBOSE" == "true" ]]; then
    curl -v "$@"
  else
    curl -fsS "$@"
  fi
}

# ── Output redaction ──────────────────────────────────────────────────────
# Replaces known secret values with <REDACTED> for safe shell output.
# Uses node for reliable literal string replacement (not regex).
# Currently redacts env vars PC_JWT and PC_MAIN_AGENT_KEY if set.
redact_output() {
  node -e '
    const line = process.argv[1] || "";
    const secrets = [];
    if (process.env.PC_JWT) secrets.push(process.env.PC_JWT);
    if (process.env.PC_MAIN_AGENT_KEY) secrets.push(process.env.PC_MAIN_AGENT_KEY);
    let result = line;
    for (const s of secrets) {
      if (s && result.includes(s)) {
        result = result.split(s).join("<REDACTED>");
      }
    }
    process.stdout.write(result);
  ' "$1"
}

# ── Redacted curl evidence printer ────────────────────────────────────────
# Prints a shell-compatible curl command with secrets replaced by <REDACTED>.
# Used by the persistence check for reproducible-yet-safe evidence output.
pc_print_curl() {
  local method="$1"; local path="$2"; local auth_type="$3"; shift 3
  path="${path#/v1}"
  local auth_header=""
  case "$auth_type" in
    jwt)  auth_header='-H "Authorization: Bearer <REDACTED>"' ;;
    key)  auth_header='-H "X-API-Key: <REDACTED>"' ;;
    *)    auth_header="" ;;
  esac
  local body_str=""
  while [[ $# -gt 0 ]]; do
    local part="$1"; shift
    if [[ -n "$part" ]]; then
      body_str="-d '$(redact_output "$part")'"
    fi
  done
  if [[ -n "$body_str" ]]; then
    printf '  $ curl -sS -X %s %s %s %s\n' \
      "$method" "'${API_URL%/}$path'" "$auth_header" "$body_str" >&2
  else
    printf '  $ curl -sS -X %s %s %s\n' \
      "$method" "'${API_URL%/}$path'" "$auth_header" >&2
  fi
}

# ── Shared helper functions ────────────────────────────────────────────────

json_get() {
  node -e '
    const path = process.argv[1].split(".");
    let value = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const key of path) value = value && value[key];
    if (value === undefined || value === null) process.exit(2);
    process.stdout.write(String(value));
  ' "$1"
}

json_get_array_len() {
  node -e '
    const value = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const arr = value && value.data;
    if (!Array.isArray(arr)) process.exit(2);
    process.stdout.write(String(arr.length));
  '
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

require_inbox_item() {
  local api_key="$1"; local event_type="$2"; local task_id="${3:-}"; local label="$4"
  local inbox=""; local item_id=""
  for _ in {1..20}; do
    inbox=$(request_agent GET "/v1/agent/inbox?unread=true&event_type=$event_type&limit=50" "" "$api_key")
    if item_id=$(printf '%s' "$inbox" | json_find_inbox_id "$event_type" "$task_id" 2>/dev/null); then
      echo "  [OK] $label inbox item: $item_id"; return 0
    fi
    sleep 0.5
  done
  echo "ERROR: missing $label inbox item event_type=$event_type task_id=$task_id" >&2
  echo "Last inbox payload: $inbox" >&2; exit 1
}

require_inbox_items_once() {
  local api_key="$1"; local event_type="$2"; local label="$3"; shift 3
  local inbox=""
  for _ in {1..20}; do
    inbox=$(request_agent GET "/v1/agent/inbox?unread=true&event_type=$event_type&limit=50" "" "$api_key")
    if printf '%s' "$inbox" | node -e '
      const expected = process.argv.slice(1);
      const payload = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const items = Array.isArray(payload.data) ? payload.data : [];
      const seen = new Set(items.map((item) => item.task_id));
      const missing = expected.filter((taskId) => !seen.has(taskId));
      if (missing.length) {
        process.stderr.write(`missing=${missing.join(",")}`);
        process.exit(2);
      }
    ' "$@" 2>/dev/null; then
      echo "  [OK] $label inbox items: $*"
      return 0
    fi
    sleep 0.5
  done
  echo "ERROR: missing $label inbox items event_type=$event_type task_ids=$*" >&2
  echo "Last inbox payload: $inbox" >&2
  exit 1
}

# Poll until the inbox does NOT contain an event for a given foreign task id.
# This proves inbox isolation: a worker must not see another worker's dispatch.
require_inbox_isolation() {
  local api_key="$1"; local event_type="$2"; local foreign_task_id="$3"; local label="$4"
  local inbox=""
  inbox=$(request_agent GET "/v1/agent/inbox?event_type=$event_type&limit=50" "" "$api_key")
  if printf '%s' "$inbox" | json_find_inbox_id "$event_type" "$foreign_task_id" 2>/dev/null; then
    echo "ERROR: $label worker saw foreign task $foreign_task_id in inbox" >&2
    echo "Inbox payload: $inbox" >&2; exit 1
  fi
  echo "  [OK] $label worker inbox isolated from task $foreign_task_id"
}

request() {
  local method="$1"; local path="$2"; local body="${3:-}"; local auth="${4:-}"
  path="${path#/v1}"
  local headers=(-H "Content-Type: application/json")
  [[ -n "$auth" ]] && headers+=(-H "Authorization: Bearer $auth")
  if [[ -n "$body" ]]; then
    curl_cmd -X "$method" "${API_URL%/}$path" "${headers[@]}" -d "$body"
  else
    curl_cmd -X "$method" "${API_URL%/}$path" "${headers[@]}"
  fi
}

# Variant that accepts HTTP error status codes and returns the status + body.
request_allow_error() {
  local method="$1"; local path="$2"; local body="${3:-}"; local api_key="$4"
  path="${path#/v1}"
  local headers=(-H "Content-Type: application/json" -H "X-API-Key: $api_key")
  local http_code; local resp
  if [[ -n "$body" ]]; then
    resp=$(curl -sS -X "$method" "${API_URL%/}$path" "${headers[@]}" -d "$body" -w "\n%{http_code}")
  else
    resp=$(curl -sS -X "$method" "${API_URL%/}$path" "${headers[@]}" -w "\n%{http_code}")
  fi
  http_code=$(printf '%s' "$resp" | tail -n1)
  body_out=$(printf '%s' "$resp" | sed '$d')
  printf '%s\n%s' "$http_code" "$body_out"
}

request_agent() {
  local method="$1"; local path="$2"; local body="${3:-}"; local api_key="$4"
  path="${path#/v1}"
  local headers=(-H "Content-Type: application/json" -H "X-API-Key: $api_key")
  if [[ -n "$body" ]]; then
    curl_cmd -X "$method" "${API_URL%/}$path" "${headers[@]}" -d "$body"
  else
    curl_cmd -X "$method" "${API_URL%/}$path" "${headers[@]}"
  fi
}

expect_status() {
  local method="$1"; local path="$2"; local body="${3:-}"; local api_key="$4"; local expected="$5"; local label="$6"
  local out; local code
  out=$(request_allow_error "$method" "$path" "$body" "$api_key")
  code=$(printf '%s' "$out" | head -n1)
  if [[ "$code" != "$expected" ]]; then
    echo "ERROR: expected $expected for $label, got $code" >&2
    echo "Response body: $(printf '%s' "$out" | tail -n +2)" >&2
    exit 1
  fi
  echo "  [OK] $label returned $code as expected"
}

assert_eq() {
  local actual="$1"; local expected="$2"; local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: $label expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

heartbeat_agent() {
  local api_key="$1"; local label="$2"
  local hb; local dispatchable
  hb=$(request_agent POST /v1/agents/heartbeat '{"status":"active"}' "$api_key")
  dispatchable=$(printf '%s' "$hb" | json_get dispatchable)
  [[ "$dispatchable" == "true" ]] && echo "  [OK] $label dispatchable" || { echo "  [FAIL] $label not dispatchable: $hb"; exit 1; }
}

# ── Evidence output ─────────────────────────────────────────────────────────
# Prints structured JSON evidence summary and saves it to a deterministic file.
# Call at the end of each mode with the collected IDs.
# Argument layout after the first five positional args:
#   worker_ids... --sep-- first_wave_task_ids... --wave2-- second_wave_task_id
#   --cs-- changeset_id --commit-- commit_id [--sync-- gitea_sync_json]
save_evidence() {
  local mode="$1"; local status="$2"
  local project_id="${3:-}"
  local orch_id="${4:-}"
  local main_agent_id="${5:-}"
  shift 5

  local evidence
  evidence=$(node -e '
    const argv = process.argv.slice(1);
    const shift = () => argv.shift() || "";
    const consumeUntil = (marker) => {
      const out = [];
      while (argv.length && argv[0] !== marker) out.push(argv.shift());
      if (argv.length && argv[0] === marker) argv.shift();
      return out;
    };

    const run_id              = shift();
    const mode                = shift();
    const status              = shift();
    const base_url            = shift();
    const project_id          = shift();
    const orchestration_id    = shift();
    const main_agent_id       = shift();
    const worker_ids          = consumeUntil("--sep--");
    const first_wave_task_ids = consumeUntil("--wave2--");
    const second_wave_task_id = shift();
    consumeUntil("--cs--");
    const changeset_id        = shift();
    consumeUntil("--commit--");
    const commit_id           = shift();

    let gitea_sync = undefined;
    if (argv[0] === "--sync--") {
      argv.shift();
      const raw = argv.shift() || "";
      if (raw) {
        try { gitea_sync = JSON.parse(raw); }
        catch (e) { gitea_sync = { action: raw, parse_error: e.message }; }
      }
    }

    const ev = {
      run_id,
      timestamp: new Date().toISOString(),
      mode,
      status,
      base_url,
      project_id,
      orchestration_id,
      main_agent_id,
      worker_ids,
      first_wave_task_ids,
      second_wave_task_id,
      changeset_id,
      commit_id,
      hostname: require("os").hostname(),
    };
    if (gitea_sync !== undefined) ev.gitea_sync = gitea_sync;
    process.stdout.write(JSON.stringify(ev, null, 2));
  ' "$EVIDENCE_RUN_ID" "$mode" "$status" "$BASE_URL" "$project_id" "$orch_id" "$main_agent_id" "$@")

  # Print to stdout
  echo ""
  echo "=============================================="
  echo "  EVIDENCE PACKAGE"
  echo "=============================================="
  printf '%s\n' "$evidence"

  # Save to file
  local evidence_file="multiworker-evidence-${EVIDENCE_RUN_ID}.json"
  printf '%s\n' "$evidence" > "$evidence_file"
  echo ""
  echo "  Evidence saved to: $evidence_file"
  echo "=============================================="
}

# ── Claim Race Test ─────────────────────────────────────────────────────────
# Stress-tests that exactly one of many concurrent claim attempts succeeds.
# Each race round dispatches a fresh task so the race is real every iteration
# and the per-round assertion is strict: exactly one worker receives HTTP 200.
run_race_test() {
  echo "=============================================="
  echo "  CLAIM RACE TEST  (run_id=$EVIDENCE_RUN_ID)"
  echo "  BASE_URL=$BASE_URL"
  echo "  RACE_LOOPS=$RACE_LOOPS"
  echo "=============================================="
  echo ""
  echo "  Race command template (secrets replaced with <REDACTED>):"
  echo "    RACE_LOOPS=$RACE_LOOPS NAS_BASE_URL=<REDACTED> bash '$0' race"
  echo "    RACE_LOOPS=$RACE_LOOPS NAS_BASE_URL=http://127.0.0.1:31337 bash '$0' race"

  # 1. Health
  echo ""
  echo "[race:1] health"
  request GET /v1/health >/dev/null && echo "  [OK] health 200" || { echo "  [FAIL] health"; exit 1; }

  # 2. Register smoke user
  echo ""
  echo "[race:2] register/login"
  reg_body=$(printf '{"email":"%s","password":"%s","display_name":"Race Owner %s"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD" "$EVIDENCE_RUN_ID")
  if ! auth_resp=$(request POST /v1/auth/register "$reg_body" 2>/tmp/multiworker-race-reg.err); then
    if grep -q "Email already registered" /tmp/multiworker-race-reg.err 2>/dev/null; then
      login_body=$(printf '{"email":"%s","password":"%s"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")
      auth_resp=$(request POST /v1/auth/token "$login_body")
    else
      cat /tmp/multiworker-race-reg.err >&2; exit 1
    fi
  fi
  RACE_JWT=$(printf '%s' "$auth_resp" | json_get access_token)
  echo "  [OK] JWT obtained (not printed)"

  # 3. Create project
  echo ""
  echo "[race:3] create project"
  race_proj_name="${PROJECT_NAME} RACE ${EVIDENCE_RUN_ID}"
  proj_resp=$(request POST /v1/projects "$(printf '{"name":"%s","description":"Race test project"}' "$race_proj_name")" "$RACE_JWT")
  RACE_PROJECT_ID=$(printf '%s' "$proj_resp" | json_get id)
  echo "  [OK] project_id=$RACE_PROJECT_ID"

  # 4. Register main + 3 worker agents
  echo ""
  echo "[race:4] register crowd of agents"
  # Main agent
  main_body=$(printf '{"name":"race-main-%s","endpoint_url":"http://127.0.0.1:7781/race-main","invoke_secret":"race-main-secret-%s"}' "$EVIDENCE_RUN_ID" "$EVIDENCE_RUN_ID")
  main_resp=$(request POST "/v1/projects/$RACE_PROJECT_ID/agents" "$main_body" "$RACE_JWT")
  RACE_MAIN_ID=$(printf '%s' "$main_resp" | json_get id)
  RACE_MAIN_KEY=$(printf '%s' "$main_resp" | json_get api_key)
  echo "  [OK] main_agent_id=$RACE_MAIN_ID"

  # Register a crowd of workers (3 for the race)
  RACE_CROWD_IDS=()
  RACE_CROWD_KEYS=()
  for i in 0 1 2; do
    worker_body=$(printf '{"name":"race-worker-%s-%d","endpoint_url":"http://127.0.0.1:7781/race-%d","invoke_secret":"race-secret-%s"}' "$EVIDENCE_RUN_ID" "$i" "$i" "$EVIDENCE_RUN_ID")
    worker_resp=$(request POST "/v1/projects/$RACE_PROJECT_ID/agents" "$worker_body" "$RACE_JWT")
    wid=$(printf '%s' "$worker_resp" | json_get id)
    wkey=$(printf '%s' "$worker_resp" | json_get api_key)
    RACE_CROWD_IDS+=("$wid")
    RACE_CROWD_KEYS+=("$wkey")
    echo "  [OK] worker[$i] id=$wid"
  done

  # 5. Heartbeats
  echo ""
  echo "[race:5] heartbeats"
  heartbeat_agent "$RACE_MAIN_KEY" "race-main"
  for i in 0 1 2; do
    heartbeat_agent "${RACE_CROWD_KEYS[$i]}" "race-worker[$i]"
  done

  # 6. Create orchestration
  echo ""
  echo "[race:6] create orchestration"
  orch_body=$(node -e '
    const main = process.argv[1];
    const workers = process.argv.slice(2);
    process.stdout.write(JSON.stringify({
      title: "Claim Race Test",
      objective: "Prove exactly one claim succeeds per fresh task among concurrent attempts.",
      main_agent_id: main,
      worker_agent_ids: workers,
      acceptance_criteria: ["exactly one claim succeeds per round", "other claims rejected"],
      plan: "Each round dispatches a fresh task. All three workers race to claim it. Exactly one succeeds; the rest get 403/409."
    }));
  ' "$RACE_MAIN_ID" "${RACE_CROWD_IDS[@]}")
  orch_resp=$(request_agent POST "/v1/projects/$RACE_PROJECT_ID/orchestrations" "$orch_body" "$RACE_MAIN_KEY")
  RACE_ORCH_ID=$(printf '%s' "$orch_resp" | json_get id)
  echo "  [OK] orchestration_id=$RACE_ORCH_ID"

  # 7. Race: each round dispatches a fresh task; all workers claim concurrently.
  echo ""
  echo "[race:7] claim race (${RACE_LOOPS} rounds, fresh task per round)"

  local rounds_passed=0
  local rounds_failed=0
  local total_unauthorized=0
  local total_conflicts=0
  local total_successes=0
  local RACE_TASK_IDS=()

  for round in $(seq 1 "$RACE_LOOPS"); do
    # Dispatch a fresh task for this round without pinning it to a single worker,
    # so all workers are legitimate racers.
    task_body=$(node -e '
      process.stdout.write(JSON.stringify({
        title: "Race Target Task Round " + process.argv[1],
        goal: "All workers race to claim this fresh task. Only one may succeed.",
        acceptance_criteria: ["claimed by exactly one worker"]
      }));
    ' "$round")
    task_resp=$(request_agent POST "/v1/projects/$RACE_PROJECT_ID/orchestrations/$RACE_ORCH_ID/tasks" "$task_body" "$RACE_MAIN_KEY")
    this_task_id=$(printf '%s' "$task_resp" | json_get id)
    this_task_status=$(printf '%s' "$task_resp" | json_get status)
    assert_eq "$this_task_status" "dispatched" "race round $round task status"
    RACE_TASK_IDS+=("$this_task_id")

    # Launch claims from all 3 workers in background for true concurrency.
    local tmpdir_race
    tmpdir_race=$(mktemp -d /tmp/race-claim-XXXXXX)

    for i in 0 1 2; do
      {
        resp=$(request_allow_error PATCH "/v1/projects/$RACE_PROJECT_ID/orchestrations/$RACE_ORCH_ID/tasks/$this_task_id/claim" "" "${RACE_CROWD_KEYS[$i]}")
        http_code=$(printf '%s' "$resp" | head -n1)
        body=$(printf '%s' "$resp" | tail -n +2)
        printf '%d|%s' "$http_code" "$body" > "${tmpdir_race}/claim-${i}.out"
      } &
    done
    wait

    # Collect results and enforce exactly one success per round.
    local claim_count=0
    local claim_winner=""
    local round_unauthorized=0
    local round_conflicts=0

    for i in 0 1 2; do
      if [[ ! -f "${tmpdir_race}/claim-${i}.out" ]]; then
        echo "  [FAIL] round $round worker[$i] produced no output" >&2
        rm -rf "$tmpdir_race"
        exit 1
      fi
      result=$(< "${tmpdir_race}/claim-${i}.out")
      code="${result%%|*}"
      rest="${result#*|}"
      if [[ "$code" == "200" ]]; then
        claim_count=$((claim_count + 1))
        claim_winner="$i"
        total_successes=$((total_successes + 1))
      elif [[ "$code" == "403" ]]; then
        round_unauthorized=$((round_unauthorized + 1))
        total_unauthorized=$((total_unauthorized + 1))
      elif [[ "$code" == "409" ]]; then
        round_conflicts=$((round_conflicts + 1))
        total_conflicts=$((total_conflicts + 1))
      else
        echo "  [FAIL] race round $round worker[$i] unexpected code=$code body=$rest" >&2
        rm -rf "$tmpdir_race"
        exit 1
      fi
    done

    rm -rf "$tmpdir_race"

    if [[ "$claim_count" -eq 1 ]]; then
      rounds_passed=$((rounds_passed + 1))
      if [[ "$(( round % 10 ))" -eq 0 || "$RACE_LOOPS" -lt 10 ]]; then
        echo "  [OK] round $round: exactly one winner (worker[$claim_winner])"
      fi
    else
      rounds_failed=$((rounds_failed + 1))
      echo "  [FAIL] round $round: $claim_count workers succeeded (expected exactly 1)" >&2
      # Fail immediately so the test cannot pass with a broken race.
      exit 1
    fi
  done

  echo ""
  echo "  Race results after ${RACE_LOOPS} rounds:"
  echo "    Rounds passed:       $rounds_passed / $RACE_LOOPS"
  echo "    Successful claims:   $total_successes"
  echo "    Failed races (409):  $total_conflicts"
  echo "    Unauthorized (403):  $total_unauthorized"

  # Verify final state of the last task: claimed by exactly one worker.
  local last_task_idx=$(( ${#RACE_TASK_IDS[@]} - 1 ))
  status_resp=$(request_agent GET "/v1/projects/$RACE_PROJECT_ID/orchestrations/$RACE_ORCH_ID/tasks/${RACE_TASK_IDS[$last_task_idx]}" "" "$RACE_MAIN_KEY")
  curr_status=$(printf '%s' "$status_resp" | json_get status)
  assert_eq "$curr_status" "running" "final race task status"
  echo "  [OK] final race task status=$curr_status"

  # Save evidence for race test
  save_evidence "race" "passed" \
    "$RACE_PROJECT_ID" "$RACE_ORCH_ID" "$RACE_MAIN_ID" \
    "${RACE_CROWD_IDS[@]}" --sep-- \
    "${RACE_TASK_IDS[@]}" --wave2-- "" --cs-- "" --commit-- ""

  # Save aggregate race stats as sidecar evidence.
  local race_stats_file="multiworker-race-stats-${EVIDENCE_RUN_ID}.json"
  node -e '
    const stats = {
      run_id: process.argv[1],
      mode: "race-stats",
      race_loops: parseInt(process.argv[2], 10),
      rounds_passed: parseInt(process.argv[3], 10),
      rounds_failed: parseInt(process.argv[4], 10),
      total_successful_claims: parseInt(process.argv[5], 10),
      total_conflicts_409: parseInt(process.argv[6], 10),
      total_unauthorized_403: parseInt(process.argv[7], 10),
      verdict: parseInt(process.argv[4], 10) === 0 ? "passed" : "failed",
      timestamp: new Date().toISOString(),
      hostname: require("os").hostname(),
    };
    process.stdout.write(JSON.stringify(stats, null, 2));
  ' "$EVIDENCE_RUN_ID" "$RACE_LOOPS" "$rounds_passed" "$rounds_failed" \
    "$total_successes" "$total_conflicts" "$total_unauthorized" \
    > "$race_stats_file"
  echo ""
  echo "  Aggregate stats saved to: $race_stats_file"
  echo "  Stats summary:"
  echo "    Rounds: $rounds_passed / $RACE_LOOPS passed (0 failures)"
  echo "    Claim codes: $total_successes × 200 (winner), $total_conflicts × 409 (conflict), $total_unauthorized × 403 (unauthorized)"

  echo ""
  echo "=============================================="
  echo "  CLAIM RACE TEST PASSED"
  echo "  project=$RACE_PROJECT_ID  orch=$RACE_ORCH_ID"
  echo "  tasks=${RACE_TASK_IDS[*]}"
  echo "  loops=$RACE_LOOPS  passed_rounds=$rounds_passed"
  echo "=============================================="
}

# ── Persistence Check ──────────────────────────────────────────────────────
# Re-queries all IDs from a prior run and asserts everything still exists and
# is in the expected state. Uses valid auth for every protected route and fails
# hard on any invariant violation.
run_persistence_check() {
  echo "=============================================="
  echo "  PERSISTENCE CHECK  (run_id=$EVIDENCE_RUN_ID)"
  echo "  Evidence: all curl commands printed below have secrets replaced"
  echo "  with <REDACTED> and are safe to share in logs/artifacts."
  echo "=============================================="

  # ── Read inputs ──────────────────────────────────────────────────────────
  local pc_project_id="${PC_PROJECT_ID:-}"
  local pc_orch_id="${PC_ORCHESTRATION_ID:-}"
  local pc_task_ids_csv="${PC_TASK_IDS:-}"
  local pc_cs_id="${PC_CHANGESET_ID:-}"
  local pc_commit_id="${PC_COMMIT_ID:-}"
  local pc_main_key="${PC_MAIN_AGENT_KEY:-}"
  local pc_jwt="${PC_JWT:-}"
  local pc_url="${PC_URL:-$BASE_URL}"

  if [[ -z "$pc_project_id" || -z "$pc_orch_id" || -z "$pc_task_ids_csv" || -z "$pc_cs_id" || -z "$pc_commit_id" || -z "$pc_main_key" || -z "$pc_jwt" ]]; then
    echo "ERROR: persistence-check mode requires all PC_* env vars:" >&2
    echo "  PC_PROJECT_ID PC_ORCHESTRATION_ID PC_TASK_IDS (comma-sep)" >&2
    echo "  PC_CHANGESET_ID PC_COMMIT_ID" >&2
    echo "  PC_MAIN_AGENT_KEY PC_JWT" >&2
    echo "  PC_URL (optional, defaults to NAS_BASE_URL)" >&2
    exit 1
  fi

  IFS=',' read -ra pc_task_ids <<< "$pc_task_ids_csv"

  echo ""
  echo "  Persistence check targets:"
  echo "    project=$pc_project_id"
  echo "    orchestration=$pc_orch_id"
  echo "    tasks=${pc_task_ids[*]}"
  echo "    changeset=$pc_cs_id"
  echo "    commit=$pc_commit_id"
  echo "    url=$pc_url"

  # Override BASE_URL/API_URL for the re-query
  local saved_base="$BASE_URL"
  local saved_api="$API_URL"
  BASE_URL="$pc_url"
  API_URL="${BASE_URL%/}/v1"

  # Use a file-based pass flag so we never print PASSED unless every check succeeds.
  # A file (not a local var) avoids bash scoping edge cases with nested functions + set -e.
  local pc_failed_file
  pc_failed_file=$(mktemp /tmp/pc-failed-XXXXXX)
  echo "0" > "$pc_failed_file"

  # ── Helper: issue one persistence check with full evidence ──────────────
  # Prints the redacted curl command, executes directly (handles both JWT
  # and X-API-Key auth), prints the HTTP status code, and sets pc_failed=1
  # on unexpected status.
  pc_check() {
    local label="$1"; local method="$2"; local path="$3"; local auth_type="$4"
    shift 4
    # $1 after shift is the auth value (for display, unused here — pc_print_curl
    # redacts it from the header). $2 is the optional request body (always empty
    # for the current GET-only checks). Using ${2:-} skips the auth value.
    local body="${2:-}"

    pc_print_curl "$method" "$path" "$auth_type" "$body"
    local dr_path="${path#/v1}"
    local dr_headers=(-H "Content-Type: application/json")
    case "$auth_type" in
      jwt) dr_headers+=(-H "Authorization: Bearer $pc_jwt") ;;
      key) dr_headers+=(-H "X-API-Key: $pc_main_key") ;;
    esac
    local dr_resp dr_code dr_body
    if [[ -n "$body" ]]; then
      dr_resp=$(curl -sS -X "$method" "${API_URL%/}$dr_path" "${dr_headers[@]}" -d "$body" -w "\n%{http_code}")
    else
      dr_resp=$(curl -sS -X "$method" "${API_URL%/}$dr_path" "${dr_headers[@]}" -w "\n%{http_code}")
    fi
    dr_code=$(printf '%s' "$dr_resp" | tail -n1)
    dr_body=$(printf '%s' "$dr_resp" | sed '$d')
    if [[ "$dr_code" == "200" || "$dr_code" == "201" ]]; then
      echo "    → $dr_code ${label}" >&2
      printf '%s' "$dr_body"
      return 0
    else
      echo "    → $dr_code ${label}" >&2
      echo "    Response: $(redact_output "$(printf '%s' "$dr_body" | head -c 200)")" >&2
      echo "1" > "$pc_failed_file"
      return 1
    fi
  }

  # ── Evidence collection ─────────────────────────────────────────────────
  local pc_evidence_entries=()

  echo ""
  echo "[pc:1] project exists"
  if proj_resp=$(pc_check "project exists" GET "/v1/projects/$pc_project_id" jwt "$pc_jwt" ""); then
    echo "  [OK] project $pc_project_id exists"
    pc_evidence_entries+=("project:200")
  fi

  echo ""
  echo "[pc:2] orchestration exists"
  if orch_resp=$(pc_check "orchestration exists" GET "/v1/projects/$pc_project_id/orchestrations/$pc_orch_id" key "$pc_main_key" ""); then
    local orch_status
    orch_status=$(printf '%s' "$orch_resp" | json_get status) || true
    echo "  [OK] orchestration $pc_orch_id exists status=$orch_status"
    pc_evidence_entries+=("orch:200:$orch_status")
  fi

  echo ""
  echo "[pc:3] tasks exist and are approved"
  for tid in "${pc_task_ids[@]}"; do
    if tresp=$(pc_check "task $tid" GET "/v1/projects/$pc_project_id/orchestrations/$pc_orch_id/tasks/$tid" key "$pc_main_key" ""); then
      local tstatus
      tstatus=$(printf '%s' "$tresp" | json_get status) || true
      if [[ "$tstatus" == "approved" ]]; then
        echo "  [OK] task $tid status=$tstatus"
        pc_evidence_entries+=("task:$tid:200:$tstatus")
      else
        echo "  [FAIL] task $tid status=$tstatus (expected approved)" >&2
        echo "1" > "$pc_failed_file"
        pc_evidence_entries+=("task:$tid:200:$tstatus:UNEXPECTED")
      fi
    fi
  done

  echo ""
  echo "[pc:4] changeset exists and is merged"
  if cs_resp=$(pc_check "changeset $pc_cs_id" GET "/v1/projects/$pc_project_id/changesets/$pc_cs_id" jwt "$pc_jwt" ""); then
    cs_status=$(printf '%s' "$cs_resp" | json_get status) || true
    if [[ "$cs_status" == "merged" ]]; then
      echo "  [OK] changeset $pc_cs_id status=$cs_status"
      pc_evidence_entries+=("changeset:200:$cs_status")
    else
      echo "  [FAIL] changeset $pc_cs_id status=$cs_status (expected merged)" >&2
      echo "1" > "$pc_failed_file"
      pc_evidence_entries+=("changeset:200:$cs_status:UNEXPECTED")
    fi
  fi

  echo ""
  echo "[pc:5] commit exists and references changeset"
  if commit_resp=$(pc_check "commit $pc_commit_id" GET "/v1/projects/$pc_project_id/commits/$pc_commit_id" jwt "$pc_jwt" ""); then
    commit_cs_id=$(printf '%s' "$commit_resp" | json_get changeset_id) || true
    if [[ "$commit_cs_id" == "$pc_cs_id" ]]; then
      echo "  [OK] commit $pc_commit_id references changeset $pc_cs_id"
      pc_evidence_entries+=("commit:200:cs_match")
    else
      echo "  [FAIL] commit changeset_id=$commit_cs_id (expected $pc_cs_id)" >&2
      echo "1" > "$pc_failed_file"
      pc_evidence_entries+=("commit:200:cs_mismatch:$commit_cs_id")
    fi
  fi

  echo ""
  echo "[pc:6] project docs files exist"
  if files_resp=$(pc_check "docs files" GET "/v1/projects/$pc_project_id/files?path_prefix=docs/" jwt "$pc_jwt" ""); then
    fcount=$(printf '%s' "$files_resp" | json_get_array_len) || true
    if [[ "${fcount:-0}" -ge 1 ]]; then
      echo "  [OK] found $fcount files under docs/"
      pc_evidence_entries+=("docs:200:$fcount")
    else
      echo "  [FAIL] no docs/ files found" >&2
      echo "1" > "$pc_failed_file"
      pc_evidence_entries+=("docs:200:0:UNEXPECTED")
    fi
  fi

  # Snapshot the actually-checked URL before restoring env vars.
  local pc_checked_url="$BASE_URL"

  # Restore
  BASE_URL="$saved_base"
  API_URL="$saved_api"

  # ── Save evidence ──────────────────────────────────────────────────────
  # Use the captured pre-restore URL so evidence reflects the endpoint that was curled.
  BASE_URL="$pc_checked_url"
  local pc_failed_val
  pc_failed_val=$(< "$pc_failed_file")
  rm -f "$pc_failed_file"
  save_evidence "persistence-check" "$( [[ "$pc_failed_val" -eq 0 ]] && echo "passed" || echo "failed" )" \
    "$pc_project_id" "$pc_orch_id" "" \
    --sep-- \
    "${pc_task_ids[@]}" --wave2-- "" --cs-- "$pc_cs_id" --commit-- "$pc_commit_id"
  BASE_URL="$saved_base"

  echo ""
  echo "  Evidence entries:"
  for entry in "${pc_evidence_entries[@]+"${pc_evidence_entries[@]}"}"; do
    echo "    - $entry"
  done

  echo ""
  if [[ "$pc_failed_val" -eq 1 ]]; then
    echo "==============================================" >&2
    echo "  PERSISTENCE CHECK FAILED" >&2
    echo "==============================================" >&2
    exit 1
  fi

  echo "=============================================="
  echo "  PERSISTENCE CHECK PASSED"
  echo "=============================================="
}

# ── Full E2E (original 12-step flow) ────────────────────────────────────────
run_full_e2e() {
  echo "=============================================="
  echo "  NAS LAN Multi-worker E2E  (run_id=$EVIDENCE_RUN_ID)"
  echo "  BASE_URL=$BASE_URL"
  echo "  Gitea sync=$GITEA_SYNC (must be false)"
  echo "=============================================="

  # 1. Health
  echo ""
  echo "[1/12] health"
  request GET /v1/health >/dev/null && echo "  [OK] health 200" || { echo "  [FAIL] health"; exit 1; }

  # 2. Register smoke user
  echo ""
  echo "[2/12] register/login"
  reg_body=$(printf '{"email":"%s","password":"%s","display_name":"MultiWorker Owner"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")
  if ! auth_resp=$(request POST /v1/auth/register "$reg_body" 2>/tmp/multiworker-reg.err); then
    if grep -q "Email already registered" /tmp/multiworker-reg.err 2>/dev/null; then
      login_body=$(printf '{"email":"%s","password":"%s"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")
      auth_resp=$(request POST /v1/auth/token "$login_body")
    else
      cat /tmp/multiworker-reg.err >&2; exit 1
    fi
  fi
  JWT=$(printf '%s' "$auth_resp" | json_get access_token)
  echo "  [OK] JWT obtained (not printed)"

  # 3. Create project
  echo ""
  echo "[3/12] create project"
  proj_body=$(printf '{"name":"%s","description":"E2E multi-worker collaboration project"}' "$PROJECT_NAME")
  proj_resp=$(request POST /v1/projects "$proj_body" "$JWT")
  PROJECT_ID=$(printf '%s' "$proj_resp" | json_get id)
  echo "  [OK] project_id=$PROJECT_ID"

  # 4. Register main + 3 worker agents
  echo ""
  echo "[4/12] register main + 3 worker agents"
  MAIN_AGENT_BODY='{"name":"multi-main","endpoint_url":"http://127.0.0.1:7781/main","invoke_secret":"multi-main-secret"}'
  MAIN_AGENT_RESP=$(request POST "/v1/projects/$PROJECT_ID/agents" "$MAIN_AGENT_BODY" "$JWT")
  MAIN_AGENT_ID=$(printf '%s' "$MAIN_AGENT_RESP" | json_get id)
  MAIN_AGENT_KEY=$(printf '%s' "$MAIN_AGENT_RESP" | json_get api_key)
  echo "  [OK] main_agent_id=$MAIN_AGENT_ID  key_prefix=${MAIN_AGENT_KEY:0:8}..."

  WORKER_NAMES=(multi-worker-alpha multi-worker-beta multi-worker-gamma)
  WORKER_IDS=()
  WORKER_KEYS=()
  for i in 0 1 2; do
    body=$(printf '{"name":"%s","endpoint_url":"http://127.0.0.1:7781/%s","invoke_secret":"%s-secret"}' "${WORKER_NAMES[$i]}" "${WORKER_NAMES[$i]}" "${WORKER_NAMES[$i]}")
    resp=$(request POST "/v1/projects/$PROJECT_ID/agents" "$body" "$JWT")
    wid=$(printf '%s' "$resp" | json_get id)
    wkey=$(printf '%s' "$resp" | json_get api_key)
    WORKER_IDS+=("$wid")
    WORKER_KEYS+=("$wkey")
    echo "  [OK] worker[$i] id=$wid name=${WORKER_NAMES[$i]} key_prefix=${wkey:0:8}..."
  done

  # 5. Heartbeats — all must be online before orchestration
  echo ""
  echo "[5/12] heartbeat main + 3 workers"
  heartbeat_agent "$MAIN_AGENT_KEY" "main"
  for i in 0 1 2; do
    heartbeat_agent "${WORKER_KEYS[$i]}" "worker[$i] ${WORKER_NAMES[$i]}"
  done

  # 6. Create orchestration
  echo ""
  echo "[6/12] create orchestration"
  ORCH_BODY=$(node -e '
    const main = process.argv[1];
    const workers = process.argv.slice(2);
    process.stdout.write(JSON.stringify({
      title: "Multi-worker E2E",
      objective: "Prove one PM/main agent can dispatch and review tasks for multiple workers on one project via durable inbox.",
      main_agent_id: main,
      worker_agent_ids: workers,
      acceptance_criteria: [
        "three workers participated",
        "inbox isolation enforced",
        "changes_requested loop exercised",
        "second-wave dispatch exercised",
        "results merged into project space"
      ],
      plan: "1. Dispatch tasks A/B/C to three workers. 2. Workers claim/complete via inbox. 3. PM requests changes on A, worker A resubmits, PM approves. 4. PM approves B/C. 5. Dispatch second-wave task D. 6. Worker completes D, PM approves. 7. Create changeset and merge outputs into project space."
    }));
  ' "$MAIN_AGENT_ID" "${WORKER_IDS[@]}")
  ORCH_RESP=$(request_agent POST "/v1/projects/$PROJECT_ID/orchestrations" "$ORCH_BODY" "$MAIN_AGENT_KEY")
  ORCH_ID=$(printf '%s' "$ORCH_RESP" | json_get id)
  ORCH_BASE_PATH=$(printf '%s' "$ORCH_RESP" | json_get base_path)
  echo "  [OK] orchestration_id=$ORCH_ID base_path=$ORCH_BASE_PATH"

  # 7. First-wave dispatch: one task per worker
  echo ""
  echo "[7/12] first-wave dispatch (3 tasks)"
  TASK_IDS=()
  for i in 0 1 2; do
    task_body=$(node -e '
      const idx = process.argv[1];
      const workerId = process.argv[2];
      process.stdout.write(JSON.stringify({
        title: "First-wave task " + String.fromCharCode(65 + parseInt(idx, 10)),
        goal: "Worker " + String.fromCharCode(65 + parseInt(idx, 10)) + " proves durable inbox delivery by submitting a result and evidence.",
        assigned_agent_id: workerId,
        acceptance_criteria: ["result.md submitted", "evidence.json submitted"]
      }));
    ' "$i" "${WORKER_IDS[$i]}")
    task_resp=$(request_agent POST "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks" "$task_body" "$MAIN_AGENT_KEY")
    tid=$(printf '%s' "$task_resp" | json_get id)
    tstatus=$(printf '%s' "$task_resp" | json_get status)
    assert_eq "$tstatus" "dispatched" "task[$i] status"
    TASK_IDS+=("$tid")
    echo "  [OK] first-wave task[$i] id=$tid assigned=${WORKER_IDS[$i]} status=$tstatus"
  done

  # 8. Inbox isolation: each worker sees only its own task; unauthorized claim fails
  echo ""
  echo "[8/12] per-worker inbox isolation + unauthorized-claim/complete guard"
  for i in 0 1 2; do
    require_inbox_item "${WORKER_KEYS[$i]}" "task_dispatched" "${TASK_IDS[$i]}" "worker[$i] own dispatch"
  done

  # Cross-worker isolation: worker 0 must not see worker 1 or worker 2 dispatch.
  require_inbox_isolation "${WORKER_KEYS[0]}" "task_dispatched" "${TASK_IDS[1]}" "worker[0] vs worker[1]"
  require_inbox_isolation "${WORKER_KEYS[0]}" "task_dispatched" "${TASK_IDS[2]}" "worker[0] vs worker[2]"
  require_inbox_isolation "${WORKER_KEYS[1]}" "task_dispatched" "${TASK_IDS[0]}" "worker[1] vs worker[0]"
  require_inbox_isolation "${WORKER_KEYS[1]}" "task_dispatched" "${TASK_IDS[2]}" "worker[1] vs worker[2]"
  require_inbox_isolation "${WORKER_KEYS[2]}" "task_dispatched" "${TASK_IDS[0]}" "worker[2] vs worker[0]"
  require_inbox_isolation "${WORKER_KEYS[2]}" "task_dispatched" "${TASK_IDS[1]}" "worker[2] vs worker[1]"

  # Unauthorized claim: worker 1 tries to claim worker 0's task -> must fail.
  expect_status PATCH "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/${TASK_IDS[0]}/claim" "" "${WORKER_KEYS[1]}" 403 "unauthorized worker[1] claim worker[0] task"

  # Unauthorized complete: worker 1 tries to complete worker 0's task -> must fail.
  expect_status POST "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/${TASK_IDS[0]}/complete" \
    '{"result_md":"# Unauthorized","evidence":{},"status":"ready_for_review"}' \
    "${WORKER_KEYS[1]}" 403 "unauthorized worker[1] complete worker[0] task"

  # 9. Workers claim + complete their own first-wave tasks
  echo ""
  echo "[9/12] workers claim + complete first-wave tasks"
  for i in 0 1 2; do
    claim_resp=$(request_agent PATCH "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/${TASK_IDS[$i]}/claim" "" "${WORKER_KEYS[$i]}")
    assert_eq "$(printf '%s' "$claim_resp" | json_get status)" "running" "worker[$i] claim status"

    complete_body=$(node -e '
      const name = process.argv[1];
      const idx = process.argv[2];
      process.stdout.write(JSON.stringify({
        result_md: "# Result from " + name + "\n\nFirst-wave deliverable " + idx + " completed.",
        evidence: { worker: name, wave: "first", index: parseInt(idx, 10), commands: ["echo done"] },
        status: "ready_for_review"
      }));
    ' "${WORKER_NAMES[$i]}" "$i")
    complete_resp=$(request_agent POST "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/${TASK_IDS[$i]}/complete" "$complete_body" "${WORKER_KEYS[$i]}")
    assert_eq "$(printf '%s' "$complete_resp" | json_get status)" "ready_for_review" "worker[$i] complete status"
    echo "  [OK] worker[$i] claimed + completed task ${TASK_IDS[$i]}"
  done

  # Main agent must receive three ready_for_review inbox items.
  require_inbox_items_once "$MAIN_AGENT_KEY" "task_ready_for_review" "main first-wave ready-for-review" "${TASK_IDS[@]}"

  # 10. PM requests changes on worker 0, worker 0 resubmits, PM approves; PM approves workers 1 and 2
  echo ""
  echo "[10/12] changes_requested -> resubmit -> approved loop"
  review_changes_body='{"decision":"changes_requested","notes":"Please add a revision marker.","requested_changes":"Append a revision marker to result_md."}'
  review_changes_resp=$(request_agent PATCH "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/${TASK_IDS[0]}/review" "$review_changes_body" "$MAIN_AGENT_KEY")
  assert_eq "$(printf '%s' "$review_changes_resp" | json_get status)" "changes_requested" "worker[0] review changes_requested"
  echo "  [OK] worker[0] task changes_requested"

  require_inbox_item "${WORKER_KEYS[0]}" "task_changes_requested" "${TASK_IDS[0]}" "worker[0] changes_requested inbox"

  # Worker 0 resubmits.
  resubmit_body=$(printf '{"result_md":"# Result from %s\\n\\nFirst-wave deliverable 0 completed.\\n\\nRevision: addressed PM feedback.\\n","evidence":{"worker":"%s","wave":"first","index":0,"revision":2,"commands":["echo revised"]},"status":"ready_for_review"}' "${WORKER_NAMES[0]}" "${WORKER_NAMES[0]}")
  resubmit_resp=$(request_agent POST "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/${TASK_IDS[0]}/complete" "$resubmit_body" "${WORKER_KEYS[0]}")
  assert_eq "$(printf '%s' "$resubmit_resp" | json_get status)" "ready_for_review" "worker[0] resubmit status"
  echo "  [OK] worker[0] resubmitted after changes requested"

  require_inbox_item "$MAIN_AGENT_KEY" "task_ready_for_review" "${TASK_IDS[0]}" "main ready-for-review after resubmit"

  # Approve all three first-wave tasks.
  for i in 0 1 2; do
    approve_body='{"decision":"approved","notes":"LGTM multi-worker"}'
    approve_resp=$(request_agent PATCH "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/${TASK_IDS[$i]}/review" "$approve_body" "$MAIN_AGENT_KEY")
    assert_eq "$(printf '%s' "$approve_resp" | json_get status)" "approved" "worker[$i] approve status"
    echo "  [OK] worker[$i] task approved"
  done

  # Workers receive approval inbox notifications.
  for i in 0 1 2; do
    require_inbox_item "${WORKER_KEYS[$i]}" "task_approved" "${TASK_IDS[$i]}" "worker[$i] approval inbox"
  done

  # 11. Second-wave dispatch after first approvals
  echo ""
  echo "[11/12] second-wave dispatch to worker[1]"
  second_wave_body=$(node -e '
    const workerId = process.argv[1];
    process.stdout.write(JSON.stringify({
      title: "Second-wave task D",
      goal: "Follow-up work dispatched after initial approvals to prove late-stage collaboration.",
      assigned_agent_id: workerId,
      acceptance_criteria: ["second-wave result.md submitted", "second-wave evidence.json submitted"]
    }));
  ' "${WORKER_IDS[1]}")
  second_wave_resp=$(request_agent POST "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks" "$second_wave_body" "$MAIN_AGENT_KEY")
  TASK_D_ID=$(printf '%s' "$second_wave_resp" | json_get id)
  TASK_D_STATUS=$(printf '%s' "$second_wave_resp" | json_get status)
  assert_eq "$TASK_D_STATUS" "dispatched" "second-wave task status"
  echo "  [OK] second-wave task id=$TASK_D_ID"

  require_inbox_item "${WORKER_KEYS[1]}" "task_dispatched" "$TASK_D_ID" "worker[1] second-wave dispatch"

  # Worker 1 claims and completes second-wave task.
  claim_d=$(request_agent PATCH "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_D_ID/claim" "" "${WORKER_KEYS[1]}")
  assert_eq "$(printf '%s' "$claim_d" | json_get status)" "running" "second-wave claim status"
  complete_d_body='{"result_md":"# Second-wave Result\n\nFollow-up deliverable completed.\n","evidence":{"worker":"multi-worker-beta","wave":"second","commands":["echo second-wave done"]},"status":"ready_for_review"}'
  complete_d_resp=$(request_agent POST "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_D_ID/complete" "$complete_d_body" "${WORKER_KEYS[1]}")
  assert_eq "$(printf '%s' "$complete_d_resp" | json_get status)" "ready_for_review" "second-wave complete status"
  echo "  [OK] worker[1] completed second-wave task"

  require_inbox_item "$MAIN_AGENT_KEY" "task_ready_for_review" "$TASK_D_ID" "main second-wave ready-for-review"

  approve_d_body='{"decision":"approved","notes":"Second-wave approved."}'
  approve_d_resp=$(request_agent PATCH "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_D_ID/review" "$approve_d_body" "$MAIN_AGENT_KEY")
  assert_eq "$(printf '%s' "$approve_d_resp" | json_get status)" "approved" "second-wave approve status"
  echo "  [OK] second-wave task approved"

  # 12. Verify project-space artifacts: result/evidence files under orchestration path
  echo ""
  echo "[12/12] verify project-space artifacts + changeset merge"
  files_resp=$(request GET "/v1/projects/$PROJECT_ID/files?path_prefix=$ORCH_BASE_PATH" "" "$JWT")
  files_count=$(printf '%s' "$files_resp" | json_get_array_len)
  [[ "$files_count" -ge 9 ]] || { echo "ERROR: expected at least 9 orchestration files, got $files_count" >&2; echo "$files_resp" >&2; exit 1; }
  echo "  [OK] found $files_count files under $ORCH_BASE_PATH"

  # Verify worker result/evidence files exist.
  for tid in "${TASK_IDS[@]}" "$TASK_D_ID"; do
    result_file=$(printf '%s' "$files_resp" | node -e '
      const path = process.argv[1];
      const files = JSON.parse(require("fs").readFileSync(0, "utf8")).data;
      const hit = files.find(f => f.path === path);
      if (!hit) process.exit(2);
      process.stdout.write(hit.id);
    ' "$ORCH_BASE_PATH/workers/$tid.result.md")
    evidence_file=$(printf '%s' "$files_resp" | node -e '
      const path = process.argv[1];
      const files = JSON.parse(require("fs").readFileSync(0, "utf8")).data;
      const hit = files.find(f => f.path === path);
      if (!hit) process.exit(2);
      process.stdout.write(hit.id);
    ' "$ORCH_BASE_PATH/workers/$tid.evidence.json")
    echo "  [OK] result+evidence files for task $tid"
  done

  # Create a changeset that merges worker outputs into project space.
  CS_BODY=$(node -e '
    const orchestrationId = process.argv[1];
    const taskIds = process.argv.slice(2);
    process.stdout.write(JSON.stringify({
      title: "Multi-worker E2E result merge",
      orchestration_id: orchestrationId,
      result_path: ".agent/orchestrations/" + orchestrationId + "/pm-review.md",
      evidence_path: ".agent/orchestrations/" + orchestrationId + "/tasks.json",
      file_ops: taskIds.map(function(taskId, idx) { return {
        op: "upsert",
        path: "docs/multiworker-output-" + idx + ".md",
        content: "# Multi-worker Output " + idx + "\n\nMerged from task " + taskId + ".\n",
        content_type: "text/markdown",
        base_revision_id: null,
      }; }),
    }));
  ' "$ORCH_ID" "${TASK_IDS[@]}" "$TASK_D_ID")
  CS_RESP=$(request_agent POST "/v1/projects/$PROJECT_ID/changesets" "$CS_BODY" "$MAIN_AGENT_KEY")
  CS_ID=$(printf '%s' "$CS_RESP" | json_get id)
  assert_eq "$(printf '%s' "$CS_RESP" | json_get status)" "submitted" "changeset status"
  echo "  [OK] changeset submitted=$CS_ID"

  # Review and merge changeset as owner.
  REVIEW_CS_BODY='{"decision":"approved","notes":"LGTM multi-worker merge"}'
  REVIEW_CS_RESP=$(request PATCH "/v1/projects/$PROJECT_ID/changesets/$CS_ID/review" "$REVIEW_CS_BODY" "$JWT")
  assert_eq "$(printf '%s' "$REVIEW_CS_RESP" | json_get status)" "approved" "changeset review status"
  echo "  [OK] changeset approved"

  MERGE_RESP=$(request POST "/v1/projects/$PROJECT_ID/changesets/$CS_ID/merge" "" "$JWT")
  assert_eq "$(printf '%s' "$MERGE_RESP" | json_get changeset.status)" "merged" "changeset merge status"
  MERGE_COMMIT=$(printf '%s' "$MERGE_RESP" | json_get commit.id)
  echo "  [OK] changeset merged commit_id=$MERGE_COMMIT"

  # Verify merged project files exist.
  merged_files=$(request GET "/v1/projects/$PROJECT_ID/files?path_prefix=docs/" "" "$JWT")
  merged_count=$(printf '%s' "$merged_files" | json_get_array_len)
  [[ "$merged_count" -ge 4 ]] || { echo "ERROR: expected at least 4 merged docs files, got $merged_count" >&2; echo "$merged_files" >&2; exit 1; }
  echo "  [OK] found $merged_count merged files under docs/"

  # Verify merged docs are content-aware: each file must reference its task id.
  ALL_MERGED_TASK_IDS=("${TASK_IDS[@]}" "$TASK_D_ID")
  for idx in "${!ALL_MERGED_TASK_IDS[@]}"; do
    tid="${ALL_MERGED_TASK_IDS[$idx]}"
    doc_path="docs/multiworker-output-${idx}.md"
    doc_file_id=$(printf '%s' "$merged_files" | node -e '
      const path = process.argv[1];
      const files = JSON.parse(require("fs").readFileSync(0, "utf8")).data;
      const hit = files.find(f => f.path === path);
      if (!hit) { process.stderr.write(`ERROR: merged doc ${path} not found\n`); process.exit(2); }
      process.stdout.write(hit.id);
    ' "$doc_path")
    doc_content=$(request GET "/v1/projects/$PROJECT_ID/files/$doc_file_id" "" "$JWT")
    if ! printf '%s' "$doc_content" | node -e '
      const tid = process.argv[1];
      const file = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const content = typeof file.content === "string" ? file.content : "";
      if (!content.includes(`Merged from task ${tid}.`)) {
        process.stderr.write(`ERROR: merged doc ${file.path} missing expected reference to task ${tid}\n`);
        process.stderr.write(`Content prefix: ${content.slice(0, 200)}\n`);
        process.exit(2);
      }
    ' "$tid" >/dev/null 2>&1; then
      exit 1
    fi
    echo "  [OK] merged doc $doc_path references task $tid"
  done

  # Verify commit exists and references the changeset.
  commit_resp=$(request GET "/v1/projects/$PROJECT_ID/commits/$MERGE_COMMIT" "" "$JWT")
  commit_changeset_id=$(printf '%s' "$commit_resp" | json_get changeset_id)
  assert_eq "$commit_changeset_id" "$CS_ID" "commit changeset_id"
  echo "  [OK] commit references changeset"

  # Optional: complete orchestration now that all tasks are approved.
  ORCH_COMPLETE_RESP=$(request_agent PATCH "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/complete" '{"summary":"Multi-worker E2E completed successfully."}' "$MAIN_AGENT_KEY")
  assert_eq "$(printf '%s' "$ORCH_COMPLETE_RESP" | json_get status)" "completed" "orchestration complete status"
  echo "  [OK] orchestration completed"

  # Optionally report gitea_sync action if present (not a failure in dry-run)
  GITEA_SYNC_ACTION=$(printf '%s' "$MERGE_RESP" | node -e '
    const payload = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const sync = payload.gitea_sync;
    if (sync == null) process.exit(0);
    process.stdout.write(JSON.stringify(sync));
  ' 2>/dev/null) || true
  if [[ -n "$GITEA_SYNC_ACTION" ]]; then
    echo "  gitea_sync=$GITEA_SYNC_ACTION"
  fi

  # ── Evidence output ──────────────────────────────────────────────────────
  save_evidence "full" "passed" \
    "$PROJECT_ID" "$ORCH_ID" "$MAIN_AGENT_ID" \
    "${WORKER_IDS[@]}" --sep-- \
    "${TASK_IDS[@]}" --wave2-- "$TASK_D_ID" --cs-- "$CS_ID" --commit-- "$MERGE_COMMIT" \
    --sync-- "$GITEA_SYNC_ACTION"

  echo ""
  echo "=============================================="
  echo "  ALL MULTI-WORKER E2E STEPS PASSED"
  echo "  project=$PROJECT_ID"
  echo "  orchestration=$ORCH_ID"
  echo "  main_agent=$MAIN_AGENT_ID"
  echo "  workers=${WORKER_IDS[*]}"
  echo "  first_wave_tasks=${TASK_IDS[*]}"
  echo "  second_wave_task=$TASK_D_ID"
  echo "  changeset=$CS_ID  commit=$MERGE_COMMIT"
  echo "  Gitea sync was NOT enabled (dry-run)"
  echo "=============================================="
}

# ── Main dispatch ──────────────────────────────────────────────────────────
case "$MODE" in
  full|"")
    run_full_e2e
    ;;
  race)
    run_race_test
    ;;
  persistence)
    run_full_e2e
    echo ""
    echo "=============================================="
    echo "  RESTART GATE"
    echo "=============================================="
    echo "  The full E2E run completed successfully."
    echo ""
    echo "  To verify restart persistence, restart the backend service now,"
    echo "  then set the required secrets out-of-band (do not echo them) and"
    echo "  run the persistence check with the IDs above:"
    echo ""
    echo "  export PC_PROJECT_ID=$PROJECT_ID"
    echo "  export PC_ORCHESTRATION_ID=$ORCH_ID"
    echo "  export PC_TASK_IDS=$(IFS=,; echo "${TASK_IDS[*]},$TASK_D_ID")"
    echo "  export PC_CHANGESET_ID=$CS_ID"
    echo "  export PC_COMMIT_ID=$MERGE_COMMIT"
    echo "  export PC_URL=$BASE_URL"
    echo "  # Set these secrets out-of-band; do not paste their values into logs:"
    echo "  #   export PC_MAIN_AGENT_KEY=<main-agent-key-from-this-run>"
    echo "  #   export PC_JWT=<owner-jwt-from-this-run>"
    echo "  bash '$0' persistence-check"
    echo ""
    echo "  NAS restart hint:"
    echo "    - SSH into the NAS host"
    echo "    - Restart the agent backend service (e.g. systemctl restart agent-backend)"
    echo "    - Wait for health check to pass (curl $BASE_URL/v1/health)"
    echo "    - Set PC_MAIN_AGENT_KEY and PC_JWT from the E2E run without echoing them"
    echo "    - Then run the persistence-check command above"
    echo "=============================================="
    ;;
  persistence-check)
    run_persistence_check
    ;;
  *)
    echo "Usage: $0 [full|race|persistence|persistence-check]" >&2
    echo "" >&2
    echo "  full (default)       — Full 12-step multi-worker E2E" >&2
    echo "  race                 — Claim-race stress test (env: RACE_LOOPS)" >&2
    echo "  persistence          — Full E2E + restart gate + persistence check" >&2
    echo "  persistence-check    — Standalone re-query via PC_* env vars" >&2
    exit 1
    ;;
esac
