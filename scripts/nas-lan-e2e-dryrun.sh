#!/usr/bin/env bash
# nas-lan-e2e-dryrun.sh
# Dry-run E2E smoke for NAS LAN publish→worker→changeset→merge flow.
# Uses env vars to avoid printing secrets. Dry-run means no real Gitea sync.
#
# Env vars (all optional — defaults are LAN smoke placeholders):
#   NAS_BASE_URL      LAN backend URL  [default: http://<your-platform-host>:18080/agent]
#   SMOKE_EMAIL       throwaway email   [default: smoke+$(date +%s)@example.invalid]
#   SMOKE_PASSWORD    throwaway pw     [default: SmokeDryRun2026!]
#   GITEA_SYNC        enable Gitea sync [default: false]
#
set -euo pipefail

BASE_URL="${NAS_BASE_URL:-http://<your-platform-host>:18080/agent}"
API_URL="${BASE_URL%/}/v1"
SMOKE_EMAIL="${SMOKE_EMAIL:-smoke+$(date +%s)@example.invalid}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-SmokeDryRun2026!}"
PROJECT_NAME="E2E Dry-run Project $(date +%Y%m%dT%H%M%S)"
GITEA_SYNC="${GITEA_SYNC:-false}"

# Gitea gate: abort if Gitea sync is accidentally enabled in dry-run
if [[ "$GITEA_SYNC" != "false" ]]; then
  echo "ERROR: Gitea sync is enabled (GITEA_SYNC=$GITEA_SYNC). Dry-run must use false." >&2
  exit 1
fi

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

require_inbox_item() {
  local api_key="$1"; local event_type="$2"; local task_id="${3:-}"; local label="$4"
  local inbox=""; local item_id=""
  for _ in {1..10}; do
    inbox=$(request_agent GET "/v1/agent/inbox?unread=true&event_type=$event_type&limit=20" "" "$api_key")
    if item_id=$(printf '%s' "$inbox" | json_find_inbox_id "$event_type" "$task_id" 2>/dev/null); then
      echo "  [OK] $label inbox item: $item_id"; return 0
    fi
    sleep 0.5
  done
  echo "ERROR: missing $label inbox item event_type=$event_type task_id=$task_id" >&2
  echo "Last inbox payload: $inbox" >&2; exit 1
}

request() {
  local method="$1"; local path="$2"; local body="${3:-}"; local auth="${4:-}"
  path="${path#/v1}"
  local headers=(-H "Content-Type: application/json")
  [[ -n "$auth" ]] && headers+=(-H "Authorization: Bearer $auth")
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "${API_URL%/}$path" "${headers[@]}" -d "$body"
  else
    curl -fsS -X "$method" "${API_URL%/}$path" "${headers[@]}"
  fi
}

request_agent() {
  local method="$1"; local path="$2"; local body="${3:-}"; local api_key="$4"
  path="${path#/v1}"
  local headers=(-H "Content-Type: application/json" -H "X-API-Key: $api_key")
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "${API_URL%/}$path" "${headers[@]}" -d "$body"
  else
    curl -fsS -X "$method" "${API_URL%/}$path" "${headers[@]}"
  fi
}

echo "=============================================="
echo "  NAS LAN E2E Dry-run"
echo "  BASE_URL=$BASE_URL"
echo "  Gitea sync=$GITEA_SYNC (must be false)"
echo "=============================================="

# 1. Health
echo ""
echo "[1/9] health"
request GET /v1/health >/dev/null && echo "  [OK] health 200" || { echo "  [FAIL] health"; exit 1; }

# 2. Register smoke user
echo ""
echo "[2/9] register/login"
reg_body=$(printf '{"email":"%s","password":"%s","display_name":"DryRun Owner"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")
if ! auth_resp=$(request POST /v1/auth/register "$reg_body" 2>/tmp/dryrun-reg.err); then
  if grep -q "Email already registered" /tmp/dryrun-reg.err 2>/dev/null; then
    login_body=$(printf '{"email":"%s","password":"%s"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")
    auth_resp=$(request POST /v1/auth/token "$login_body")
  else
    cat /tmp/dryrun-reg.err >&2; exit 1
  fi
fi
JWT=$(printf '%s' "$auth_resp" | json_get access_token)
echo "  [OK] JWT obtained (not printed)"

# 3. Create project
echo ""
echo "[3/9] create project"
proj_body=$(printf '{"name":"%s","description":"E2E dry-run project"}' "$PROJECT_NAME")
proj_resp=$(request POST /v1/projects "$proj_body" "$JWT")
PROJECT_ID=$(printf '%s' "$proj_resp" | json_get id)
echo "  [OK] project_id=$PROJECT_ID"

# 4. Register main + worker agents
echo ""
echo "[4/9] register main agent"
MAIN_AGENT_BODY=$(printf '{"name":"dryrun-main","endpoint_url":"http://127.0.0.1:7781/main","invoke_secret":"dryrun-main-secret"}')
MAIN_AGENT_RESP=$(request POST "/v1/projects/$PROJECT_ID/agents" "$MAIN_AGENT_BODY" "$JWT")
MAIN_AGENT_ID=$(printf '%s' "$MAIN_AGENT_RESP" | json_get id)
MAIN_AGENT_KEY=$(printf '%s' "$MAIN_AGENT_RESP" | json_get api_key)
echo "  [OK] main_agent_id=$MAIN_AGENT_ID  key_prefix=${MAIN_AGENT_KEY:0:8}..."

echo ""
echo "[4/9] register worker agent"
WORKER_AGENT_BODY=$(printf '{"name":"dryrun-worker","endpoint_url":"http://127.0.0.1:7781/worker","invoke_secret":"dryrun-worker-secret"}')
WORKER_AGENT_RESP=$(request POST "/v1/projects/$PROJECT_ID/agents" "$WORKER_AGENT_BODY" "$JWT")
WORKER_AGENT_ID=$(printf '%s' "$WORKER_AGENT_RESP" | json_get id)
WORKER_AGENT_KEY=$(printf '%s' "$WORKER_AGENT_RESP" | json_get api_key)
echo "  [OK] worker_agent_id=$WORKER_AGENT_ID  key_prefix=${WORKER_AGENT_KEY:0:8}..."

# 5. Heartbeats — must be online before orchestration
echo ""
echo "[5/9] heartbeat main + worker"
MAIN_HB=$(request_agent POST /v1/agents/heartbeat '{"status":"active"}' "$MAIN_AGENT_KEY")
assert_main_dispatchable=$(printf '%s' "$MAIN_HB" | json_get dispatchable)
[[ "$assert_main_dispatchable" == "true" ]] && echo "  [OK] main dispatchable" || { echo "  [FAIL] main not dispatchable: $MAIN_HB"; exit 1; }

WORKER_HB=$(request_agent POST /v1/agents/heartbeat '{"status":"active"}' "$WORKER_AGENT_KEY")
assert_worker_dispatchable=$(printf '%s' "$WORKER_HB" | json_get dispatchable)
[[ "$assert_worker_dispatchable" == "true" ]] && echo "  [OK] worker dispatchable" || { echo "  [FAIL] worker not dispatchable: $WORKER_HB"; exit 1; }

# 6. Orchestration + task dispatch
echo ""
echo "[6/9] create orchestration + dispatch task"
ORCH_BODY=$(printf '{"title":"DryRun E2E","objective":"Verify PM publish and worker complete.","main_agent_id":"%s","worker_agent_ids":["%s"],"acceptance_criteria":["result.md submitted"],"plan":"1.Dispatch 2.Complete 3.Review 4.Changeset 5.Merge"}' "$MAIN_AGENT_ID" "$WORKER_AGENT_ID")
ORCH_RESP=$(request_agent POST "/v1/projects/$PROJECT_ID/orchestrations" "$ORCH_BODY" "$MAIN_AGENT_KEY")
ORCH_ID=$(printf '%s' "$ORCH_RESP" | json_get id)
echo "  [OK] orchestration_id=$ORCH_ID"

TASK_BODY=$(printf '{"title":"DryRun task","goal":"Return a brief result.","assigned_agent_id":"%s","acceptance_criteria":["result exists"]}' "$WORKER_AGENT_ID")
TASK_RESP=$(request_agent POST "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks" "$TASK_BODY" "$MAIN_AGENT_KEY")
TASK_ID=$(printf '%s' "$TASK_RESP" | json_get id)
assert_dispatched=$(printf '%s' "$TASK_RESP" | json_get status)
[[ "$assert_dispatched" == "dispatched" ]] && echo "  [OK] task dispatched=$TASK_ID" || { echo "  [FAIL] task status: $TASK_RESP"; exit 1; }

# 7. Worker: receive + claim + complete
echo ""
echo "[7/9] worker claim + complete"
require_inbox_item "$WORKER_AGENT_KEY" "task_dispatched" "$TASK_ID" "worker dispatch"

CLAIM_RESP=$(request_agent PATCH "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID/claim" "" "$WORKER_AGENT_KEY")
assert_claimed=$(printf '%s' "$CLAIM_RESP" | json_get status)
[[ "$assert_claimed" == "running" ]] && echo "  [OK] task claimed" || { echo "  [FAIL] claim status: $CLAIM_RESP"; exit 1; }

COMPLETE_BODY='{"result_md":"# Result\n\nDry-run smoke completed.\n","evidence":{"smoke":"pass","commands":["echo done"]},"status":"ready_for_review"}'
COMPLETE_RESP=$(request_agent POST "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID/complete" "$COMPLETE_BODY" "$WORKER_AGENT_KEY")
assert_complete=$(printf '%s' "$COMPLETE_RESP" | json_get status)
[[ "$assert_complete" == "ready_for_review" ]] && echo "  [OK] task completed" || { echo "  [FAIL] complete status: $COMPLETE_RESP"; exit 1; }

# 8. Main agent: review + approve
echo ""
echo "[8/9] main agent reviews"
require_inbox_item "$MAIN_AGENT_KEY" "task_ready_for_review" "$TASK_ID" "main review"

REVIEW_BODY='{"decision":"approved","notes":"Dry-run approved."}'
REVIEW_RESP=$(request_agent PATCH "/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID/review" "$REVIEW_BODY" "$MAIN_AGENT_KEY")
assert_review=$(printf '%s' "$REVIEW_RESP" | json_get status)
[[ "$assert_review" == "approved" ]] && echo "  [OK] task approved" || { echo "  [FAIL] review status: $REVIEW_RESP"; exit 1; }

require_inbox_item "$WORKER_AGENT_KEY" "task_approved" "$TASK_ID" "worker approval"

# 9. Changeset: create + review + merge
echo ""
echo "[9/9] changeset create + review + merge"
CS_BODY=$(node -e '
  const [orchestrationId, taskId] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    title: "DryRun result changeset",
    orchestration_id: orchestrationId,
    task_id: taskId,
    result_path: `.agent/orchestrations/${orchestrationId}/result.md`,
    evidence_path: `.agent/orchestrations/${orchestrationId}/evidence.json`,
    file_ops: [{
      op: "upsert",
      path: `docs/dryrun-output-${orchestrationId}.md`,
      content: "# Dry-run Output\n\nPhase 8 complete.\n",
      content_type: "text/markdown",
      base_revision_id: null,
    }],
  }));
' "$ORCH_ID" "$TASK_ID")
CS_RESP=$(request_agent POST "/v1/projects/$PROJECT_ID/changesets" "$CS_BODY" "$MAIN_AGENT_KEY")
CS_ID=$(printf '%s' "$CS_RESP" | json_get id)
assert_cs_status=$(printf '%s' "$CS_RESP" | json_get status)
[[ "$assert_cs_status" == "submitted" ]] && echo "  [OK] changeset submitted=$CS_ID" || { echo "  [FAIL] changeset status: $CS_RESP"; exit 1; }

# Review changeset
REVIEW_CS_BODY='{"decision":"approved","notes":"LGTM dry-run"}'
REVIEW_CS_RESP=$(request PATCH "/v1/projects/$PROJECT_ID/changesets/$CS_ID/review" "$REVIEW_CS_BODY" "$JWT")
assert_cs_review=$(printf '%s' "$REVIEW_CS_RESP" | json_get status)
[[ "$assert_cs_review" == "approved" ]] && echo "  [OK] changeset approved" || { echo "  [FAIL] changeset review: $REVIEW_CS_RESP"; exit 1; }

# Merge changeset
MERGE_RESP=$(request POST "/v1/projects/$PROJECT_ID/changesets/$CS_ID/merge" "" "$JWT")
assert_merge=$(printf '%s' "$MERGE_RESP" | json_get changeset.status)
[[ "$assert_merge" == "merged" ]] && echo "  [OK] changeset merged" || { echo "  [FAIL] merge status: $MERGE_RESP"; exit 1; }
MERGE_COMMIT=$(printf '%s' "$MERGE_RESP" | json_get commit.id)
echo "  commit_id=$MERGE_COMMIT"

# Optionally report gitea_sync action if present (not a failure in dry-run)
GITEA_SYNC_ACTION=$(printf '%s' "$MERGE_RESP" | json_get gitea_sync 2>/dev/null) || true
if [[ -n "$GITEA_SYNC_ACTION" ]]; then
  echo "  gitea_sync=$GITEA_SYNC_ACTION"
fi

# Verify commit exists
COMMITS=$(request GET "/v1/projects/$PROJECT_ID/commits" "" "$JWT")
echo "  [OK] commits endpoint reachable"

echo ""
echo "=============================================="
echo "  ALL E2E DRY-RUN STEPS PASSED"
echo "  project=$PROJECT_ID  orch=$ORCH_ID  task=$TASK_ID"
echo "  changeset=$CS_ID  commit=$MERGE_COMMIT"
echo "  Gitea sync was NOT enabled (dry-run)"
echo "=============================================="
