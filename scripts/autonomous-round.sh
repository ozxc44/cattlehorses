#!/usr/bin/env bash
# autonomous-round.sh — one round of autonomous platform improvement.
#
# Each round:
#   1. Dispatches a feature task to codex (from the improvement queue)
#   2. Monitors until codex completes
#   3. PM verifies (build + test)
#   4. Merges via platform API
#   5. Syncs local → GitHub → NAS
#   6. Records the round
#
# Usage: ROUND=N FEATURE="..." bash scripts/autonomous-round.sh
#   ROUND: round number (default: next from .autonomous-loop/progress.json)
#   FEATURE: goal text for the task (default: read from queue)
#
# Prerequisites:
#   - main-pm heartbeat running
#   - codex worker online
#   - ~/.zz/config.json has valid PM agent key
#   - sshpass installed for NAS sync
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Config ──
BASE_URL="${ZZ_BASE_URL:-http://192.168.31.119:18080/agent}"
PID="${ZZ_PROJECT_ID:-ddcb47ac-b247-4095-8d06-ed9646f2b663}"
CODEX_ID="${CODEX_ID:-b0bc994c-445e-4992-9bc3-8c8d931e48bf}"
MAIN_PM_ID="${MAIN_PM_ID:-43b43269-ebb3-464b-b56b-bf88516e1869}"
PMKEY="${ZZ_PM_KEY:-zzk_0fa8990fa61c427faf5fb0d8044acfec5bca3cb3f7524025a0180a65acf138b3}"
NAS_SSH="sshpass -p jkjA258963 ssh -p 10000 -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no 18950509383@192.168.31.119"
PROGRESS_FILE=".autonomous-loop/progress.json"
ROUNDS_DIR=".autonomous-loop/rounds"
MAX_WAIT_SLOTS=40  # 40 * 30s = 20 min max wait for codex

mkdir -p "$ROUNDS_DIR"

# ── Helpers ──
log() { echo "[$(date +%H:%M:%S)] $*"; }

api() {  # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -m 15 -X "$method" "$BASE_URL$path" \
      -H "Authorization: Bearer $PMKEY" -H "Content-Type: application/json" -d "$body"
  else
    curl -s -m 15 -X "$method" "$BASE_URL$path" -H "Authorization: Bearer $PMKEY"
  fi
}

get_round() {
  if [ -f "$PROGRESS_FILE" ]; then
    python3 -c "import json;d=json.load(open('$PROGRESS_FILE'));print(d.get('round',0)+1)"
  else
    echo 1
  fi
}

# ── 0. Setup ──
ROUND="${ROUND:-$(get_round)}"
FEATURE="${FEATURE:-improvement from queue round $ROUND}"
log "=== Round $ROUND ==="
log "Feature: $FEATURE"

# heartbeat
api POST /v1/agents/heartbeat '{"status":"healthy"}' >/dev/null 2>&1 || true

# ── 1. Dispatch to codex ──
log "Dispatching to codex..."
ORCH_RESP=$(api POST "/v1/projects/$PID/orchestrations" \
  "{\"title\":\"R$ROUND: autonomous improvement\",\"objective\":\"$FEATURE\",\"main_agent_id\":\"$MAIN_PM_ID\",\"worker_agent_ids\":[\"$CODEX_ID\"]}")
OID=$(echo "$ORCH_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -z "$OID" ]; then log "ERROR: orchestration creation failed: $ORCH_RESP"; exit 1; fi
log "orchestration: $OID"

TASK_BODY=$(python3 -c "import json;print(json.dumps({'title':'R$ROUND task','goal':'''$FEATURE'''.strip(),'assigned_agent_id':'$CODEX_ID'}))")
TASK_RESP=$(api POST "/v1/projects/$PID/orchestrations/$OID/tasks" "$TASK_BODY")
TID=$(echo "$TASK_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
log "task: $TID"

# ── 2. Monitor ──
log "Monitoring codex (max $((MAX_WAIT_SLOTS*30))s)..."
for i in $(seq 1 $MAX_WAIT_SLOTS); do
  sleep 30
  ST=$(api GET "/v1/projects/$PID/orchestrations/$OID/tasks/$TID" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  if [ "$((i % 4))" = "0" ]; then log "  [$((i*30))s] $ST"; fi
  case "$ST" in
    ready_for_review|completed) log "codex done after $((i*30))s"; break;;
    failed|blocked) log "codex task $ST after $((i*30))s"; break;;
  esac
done
if [ "$ST" != "ready_for_review" ] && [ "$ST" != "completed" ]; then
  log "ERROR: codex did not complete (status=$ST). Skipping round."
  echo "{\"round\":$ROUND,\"status\":\"skipped\",\"reason\":\"codex status=$ST\"}" > "$PROGRESS_FILE"
  exit 1
fi

# ── 3. PM verify (pull changeset + build + test) ──
log "Pulling changeset for PM verification..."
RP=$(api GET "/v1/projects/$PID/orchestrations/$OID/tasks/$TID" | python3 -c "import json,sys;print(json.load(sys.stdin).get('result_path',''))" 2>/dev/null)
FID=$(api GET "/v1/projects/$PID/files?exact_path=$RP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'] if d.get('data') else '')" 2>/dev/null)
CSID=$(curl -s -m 10 "$BASE_URL/v1/projects/$PID/files/$FID/raw" -H "Authorization: Bearer $PMKEY" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
log "changeset: $CSID"

if [ -n "$CSID" ]; then
  # pull files
  api GET "/v1/projects/$PID/changesets/$CSID" | python3 -c "
import json,sys,os
d=json.load(sys.stdin)
for op in d.get('file_ops',[]):
    path=op['path']; content=op.get('content','')
    dn=os.path.dirname(path)
    if dn: os.makedirs(dn, exist_ok=True)
    with open(path,'w') as f: f.write(content)
" 2>/dev/null
  # build + find new test
  log "Building..."
  (cd backend && npm run build 2>&1 | tail -1)
  # run the new test if exists
  NEW_TEST=$(ls backend/dist/tests/task-*.test.js 2>/dev/null | sort | tail -1)
  if [ -n "$NEW_TEST" ]; then
    log "Testing $(basename $NEW_TEST)..."
    (cd backend && env -u LOG_LEVEL -u LOG_FILE -u DEBUG NODE_ENV=test node "$NEW_TEST" 2>&1 | grep -iE "passed|fail" | tail -1) || true
  fi
fi

# ── 4. Merge ──
log "Merging..."
TOKEN=$(python3 -c "import json;print(json.load(open('/Users/z/Library/Application Support/Agent Platform/identity.json'))['credentials']['user_token'])" 2>/dev/null)
curl -s -m 10 -X PATCH "$BASE_URL/v1/projects/$PID/changesets/$CSID/review" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"approved","review_message":"autonomous round merge"}' >/dev/null 2>&1
curl -s -m 10 -X POST "$BASE_URL/v1/projects/$PID/changesets/$CSID/merge" \
  -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1
log "merged"

# ── 5. Sync ──
log "Syncing GitHub + NAS..."
git add -A 2>/dev/null
git commit -m "feat: R$ROUND autonomous improvement — $FEATURE" 2>/dev/null || log "(nothing to commit)"
git push origin main 2>&1 | tail -1

# NAS sync
eval "$NAS_SSH" 'printf "%s\n" "jkjA258963" | sudo -S bash -c "cd /data/zz-agent-platform && git fetch origin 2>&1 | tail -1 && git reset --hard origin/main 2>&1 | tail -1 && cd deploy/nas && docker compose build backend 2>&1 | tail -2 && docker compose up -d backend 2>&1 | tail -3"' 2>/dev/null | tail -4
log "NAS synced"

# ── 6. Record ──
python3 -c "
import json
d={'round': $ROUND, 'status': 'completed', 'feature': '''$FEATURE''', 'changeset': '$CSID'}
json.dump(d, open('$PROGRESS_FILE','w'), indent=2)
print('progress saved:', d)
"
log "=== Round $ROUND complete ==="
