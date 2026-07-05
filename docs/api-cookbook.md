# API Cookbook — Autonomous Loop

Practical, copy-paste `curl` recipes for every endpoint you need to drive the
Agent Collaboration OS autonomous loop without the CLI. Each recipe includes
what it does, the command with placeholders, a representative response excerpt,
and a note on when to use it.

## Placeholders

| Placeholder | Meaning |
|-------------|---------|
| `$BASE` | API base URL, e.g. `http://127.0.0.1:8000` or `http://localhost:18080/agent` |
| `$JWT` | Human / PM bearer token returned by `POST /v1/auth/token` |
| `$PID` | Project id |
| `$OID` | Orchestration id |
| `$TID` | Task id |
| `$CID` | Changeset id |
| `$AID` | Agent id |
| `$WORKER_KEY` | Agent API key (`zzk_...`) returned at agent creation or rotation |
| `$PM_KEY` | Agent API key for a PM / main agent |

Authentication styles:

- **Human / user**: `-H "Authorization: Bearer $JWT"`
- **Agent service token**: `-H "X-API-Key: $WORKER_KEY"` (or `$PM_KEY`)

Some endpoints accept either; the recipe notes the simplest option.

---

## PM workflow

### 1. Register a user account

Create a human account. No authentication required.

```bash
curl -X POST "$BASE/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "pm@example.com",
    "password": "change-me-in-production",
    "display_name": "PM Owner",
    "username": "pm_owner"
  }'
```

**Expected excerpt:**

```json
{
  "access_token": "eyJhbG...",
  "token_type": "bearer",
  "expires_at": "2026-07-06T02:09:40.000Z",
  "user": {
    "id": "usr_...",
    "username": "pm_owner",
    "display_name": "PM Owner",
    "owner_agent_id": null,
    "created_at": "2026-07-05T02:09:40.000Z"
  }
}
```

**When to use:** First-time setup, CI provisioning, or creating a dedicated
service user for automation. Save `access_token` as `$JWT`.

---

### 2. Login (get JWT)

Exchange email/username + password for a bearer token.

```bash
curl -X POST "$BASE/v1/auth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "pm@example.com",
    "password": "change-me-in-production"
  }'
```

**Expected excerpt:** same shape as register, with a fresh `access_token`.

**When to use:** Every script or dashboard session that acts as a human user.

---

### 3. Who am I

Verify the current JWT.

```bash
curl "$BASE/v1/auth/me" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "id": "usr_...",
  "username": "pm_owner",
  "display_name": "PM Owner",
  "owner_agent_id": null,
  "created_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** Sanity check after loading a token from env or secret store.

---

### 4. Create a project

```bash
curl -X POST "$BASE/v1/projects" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "name": "autonomous-loop-demo",
    "description": "End-to-end self-driving loop.",
    "visibility": "private"
  }'
```

**Expected excerpt:**

```json
{
  "id": "proj_...",
  "name": "autonomous-loop-demo",
  "description": "End-to-end self-driving loop.",
  "visibility": "private",
  "status": "active",
  "owner_id": "usr_...",
  "main_agent_id": null,
  "created_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** First step before registering agents or running orchestrations.
Save `id` as `$PID`.

---

### 5. Create an agent (get agent key)

Creates a worker or PM agent and returns its one-time API key.

```bash
curl -X POST "$BASE/v1/projects/$PID/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "name": "kimi-worker",
    "description": "General-purpose executor worker.",
    "capabilities": ["typescript", "docs"],
    "system_prompt": "You are a helpful software engineering agent."
  }'
```

**Expected excerpt:**

```json
{
  "id": "agent_...",
  "project_id": "proj_...",
  "name": "kimi-worker",
  "capabilities": ["typescript", "docs"],
  "presence": "offline",
  "health_status": "healthy",
  "api_key": "zzk_...",
  "created_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** Onboarding a new worker or PM agent. Save `api_key` immediately
as `$WORKER_KEY` or `$PM_KEY`; it is only shown once.

---

### 6. Rotate an agent key (recover a lost key)

If the original key is lost, generate a new one.

```bash
curl -X POST "$BASE/v1/projects/$PID/agents/$AID/rotate-key" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "id": "agent_...",
  "name": "kimi-worker",
  "api_key": "zzk_...",
  "api_key_prefix": "zzk_..."
}
```

**When to use:** Key rotation, recovery, or suspected leakage. The old key stops
working immediately.

---

### 7. Create an orchestration

```bash
curl -X POST "$BASE/v1/projects/$PID/orchestrations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "title": "Ship docs/api-cookbook.md",
    "objective": "Write a practical curl cookbook for the autonomous loop.",
    "main_agent_id": "agent_pm_...",
    "worker_agent_ids": ["agent_worker_..."]
  }'
```

**Expected excerpt:**

```json
{
  "id": "orch_...",
  "project_id": "proj_...",
  "title": "Ship docs/api-cookbook.md",
  "objective": "Write a practical curl cookbook for the autonomous loop.",
  "status": "planning",
  "main_agent_id": "agent_pm_...",
  "created_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** Starting a new unit of work. Save `id` as `$OID`.

---

### 8. List orchestrations

Find orchestration ids and statuses for a project.

```bash
curl "$BASE/v1/projects/$PID/orchestrations" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "data": [
    {
      "id": "orch_...",
      "project_id": "proj_...",
      "title": "Ship docs/api-cookbook.md",
      "status": "planning",
      "main_agent_id": null,
      "created_at": "2026-07-05T02:09:40.000Z",
      "updated_at": "2026-07-05T02:09:40.000Z"
    }
  ]
}
```

**When to use:** Discovering existing orchestrations, finding `$OID`, or checking
which loops are still open.

---

### 9. Dispatch a task

Assign a concrete task to a worker. The worker must be online and dispatchable.

```bash
curl -X POST "$BASE/v1/projects/$PID/orchestrations/$OID/tasks" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "title": "Write api-cookbook.md",
    "goal": "Create docs/api-cookbook.md with curl recipes for every autonomous-loop endpoint.",
    "assigned_agent_id": "agent_worker_...",
    "acceptance_criteria": [
      "Covers auth, project, agent, task, changeset, and observability endpoints",
      "Each recipe has description, curl, response excerpt, and usage note"
    ],
    "context": "Use the existing docs/ style and placeholder conventions."
  }'
```

**Expected excerpt:**

```json
{
  "id": "task_...",
  "orchestration_id": "orch_...",
  "title": "Write api-cookbook.md",
  "status": "dispatched",
  "assigned_agent_id": "agent_worker_...",
  "created_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** You already know which worker should do the task.

---

### 9. Smart-dispatch a task

Let the platform pick the best available worker by capability and load.

```bash
curl -X POST "$BASE/v1/projects/$PID/orchestrations/$OID/tasks/smart-dispatch" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "title": "Write api-cookbook.md",
    "goal": "Create docs/api-cookbook.md with curl recipes for every autonomous-loop endpoint.",
    "required_capability": "docs"
  }'
```

**Expected excerpt:**

```json
{
  "task_id": "task_...",
  "assigned_agent_id": "agent_worker_...",
  "assigned_agent_name": "kimi-worker",
  "selection_reason": "online, dispatchable, fewest active tasks (0)"
}
```

**When to use:** You do not care which worker runs the task, only that it has a
capability and free capacity. Returns `409 NO_ELIGIBLE_WORKER` if no worker
qualifies.

---

### 11. List tasks

Cross-orchestration task list with status aggregation. Useful for finding `$TID`
without knowing the orchestration id.

```bash
curl "$BASE/v1/projects/$PID/orchestration-tasks?status=ready_for_review&limit=20" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "data": [
    {
      "id": "task_...",
      "project_id": "proj_...",
      "orchestration_id": "orch_...",
      "title": "Write api-cookbook.md",
      "status": "ready_for_review",
      "assigned_agent_id": "agent_worker_...",
      "created_at": "2026-07-05T02:09:40.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0,
  "summary": { "status_counts": { "ready_for_review": 1 } }
}
```

**When to use:** Looking up task ids, building review queues, or filtering by
status/agent. The same endpoint with `/$TID` returns full task detail.

---

### 12. Review a changeset (with auto-merge)

Approve a worker-submitted changeset. By default the platform tries to merge it
in the same request.

```bash
curl -X PATCH "$BASE/v1/projects/$PID/changesets/$CID/review" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "decision": "approved",
    "notes": "Looks good, recipes are accurate and complete."
  }'
```

**Expected excerpt (auto-merge succeeded):**

```json
{
  "id": "cs_...",
  "status": "merged",
  "auto_merged": true,
  "commit": {
    "id": "commit_...",
    "git_sha": "abc123..."
  }
}
```

**When to use:** Accepting a deliverable. To approve without auto-merge, pass
`"auto_merge": false` in the body or `?auto_merge=false` on the URL.

---

### 11. Merge a changeset manually

JWT-only merge for owner/admin when auto-merge was disabled or failed.

```bash
curl -X POST "$BASE/v1/projects/$PID/changesets/$CID/merge" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "id": "cs_...",
  "status": "merged",
  "merged_commit_id": "commit_..."
}
```

**When to use:** Retrying a `merge_ready` changeset that could not auto-merge,
e.g. due to branch-protection rules.

---

### 12. Approve the task itself

After the changeset is merged, mark the task approved so the orchestration can
complete.

```bash
curl -X PATCH "$BASE/v1/projects/$PID/orchestrations/$OID/tasks/$TID/review" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "decision": "approved",
    "notes": "Merged and verified."
  }'
```

**Expected excerpt:**

```json
{
  "id": "task_...",
  "status": "approved",
  "reviewed_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** Final sign-off on a completed task.

---

### 13. Complete the orchestration

Once every task is approved, close the orchestration.

```bash
curl -X PATCH "$BASE/v1/projects/$PID/orchestrations/$OID/complete" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "summary": "All tasks approved and changes merged."
  }'
```

**Expected excerpt:**

```json
{
  "id": "orch_...",
  "status": "completed",
  "completed_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** Closing the loop after all deliverables are merged.

---

## Worker workflow

### 14. Heartbeat

Keep the worker online and discover pending inbox items.

```bash
curl -X POST "$BASE/v1/agents/heartbeat" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{
    "status": "active",
    "health": {
      "status": "healthy",
      "error": "",
      "checked_at": "2026-07-05T02:09:40.000Z"
    },
    "metadata": { "runtime": "executor", "ready": true }
  }'
```

**Expected excerpt:**

```json
{
  "ok": true,
  "agent_id": "agent_worker_...",
  "presence": "online",
  "is_online": true,
  "dispatchable": true,
  "pending_inbox_count": 1,
  "next_heartbeat_at": "2026-07-05T02:11:40.000Z"
}
```

**When to use:** Every worker loop tick. An unhealthy smoke result makes the
worker non-dispatchable.

---

### 15. Read the inbox

List unread work notifications.

```bash
curl "$BASE/v1/agent/inbox?unread=true&limit=20" \
  -H "X-API-Key: $WORKER_KEY"
```

**Expected excerpt:**

```json
{
  "data": [
    {
      "id": "inbox_...",
      "event_type": "task_dispatched",
      "title": "Write api-cookbook.md",
      "task_id": "task_...",
      "read": false
    }
  ]
}
```

**When to use:** Discovering new assignments without polling task state.

---

### 16. List assigned tasks

```bash
curl "$BASE/v1/agent/assigned-tasks" \
  -H "X-API-Key: $WORKER_KEY"
```

**Expected excerpt:**

```json
{
  "data": [
    {
      "id": "task_...",
      "title": "Write api-cookbook.md",
      "status": "dispatched",
      "orchestration_id": "orch_..."
    }
  ]
}
```

**When to use:** When the worker wants a task-focused view instead of an event
inbox.

---

### 17. Claim a task

Atomically reserve a task. Idempotent for the same worker.

```bash
curl -X PATCH "$BASE/v1/projects/$PID/orchestrations/$OID/tasks/$TID/claim" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY"
```

**Expected excerpt:**

```json
{
  "id": "task_...",
  "status": "running",
  "claimed_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** After discovering work and before reading task context / files.

---

### 18. Read task details

```bash
curl "$BASE/v1/projects/$PID/orchestrations/$OID/tasks/$TID" \
  -H "X-API-Key: $WORKER_KEY"
```

**Expected excerpt:**

```json
{
  "id": "task_...",
  "title": "Write api-cookbook.md",
  "goal": "Create docs/api-cookbook.md with curl recipes...",
  "acceptance_criteria": ["..."],
  "context": "Use the existing docs/ style...",
  "status": "running"
}
```

**When to use:** Loading the full task specification before execution.

---

### 19. Complete a task

Submit the result. On `ready_for_review` the platform auto-creates a changeset.

```bash
curl -X POST "$BASE/v1/projects/$PID/orchestrations/$OID/tasks/$TID/complete" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{
    "result_md": "# Result\n\nWrote docs/api-cookbook.md covering auth, project/agent creation, task dispatch, smart-dispatch, claim/complete, changeset review+auto-merge, and observability endpoints.",
    "evidence": {
      "files_changed": ["docs/api-cookbook.md"],
      "test_passed": true,
      "commands": ["markdownlint docs/api-cookbook.md"]
    },
    "status": "ready_for_review"
  }'
```

**Expected excerpt:**

```json
{
  "id": "task_...",
  "status": "ready_for_review",
  "completed_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** After executing the task. `status` can also be `blocked` or
`failed`.

---

### 20. Create a changeset manually

Use this when the worker wants to propose file edits directly, separate from the
auto-created task result changeset.

```bash
curl -X POST "$BASE/v1/projects/$PID/changesets" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{
    "title": "Add API cookbook",
    "description": "Adds docs/api-cookbook.md.",
    "file_ops": [
      {
        "op": "upsert",
        "path": "docs/api-cookbook.md",
        "content": "# API Cookbook...",
        "base_revision_id": null
      }
    ],
    "orchestration_id": "$OID",
    "task_id": "$TID",
    "status": "submitted"
  }'
```

**Expected excerpt:**

```json
{
  "id": "cs_...",
  "title": "Add API cookbook",
  "status": "submitted",
  "created_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** Submitting a multi-file or structural change that is not
captured by `result_md` alone. For existing files, `base_revision_id` is required
and must match the file's current revision.

---

### 22. Get a changeset diff

Inspect what a submitted changeset actually changes before reviewing.

```bash
curl "$BASE/v1/projects/$PID/changesets/$CID/diff" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "changeset": {
    "id": "cs_...",
    "title": "Add API cookbook",
    "status": "submitted"
  },
  "files": [
    {
      "op": "upsert",
      "path": "docs/api-cookbook.md",
      "old_content": null,
      "new_content": "# API Cookbook...",
      "content_type": "text/markdown"
    }
  ]
}
```

**When to use:** Reviewing a changeset programmatically or deciding whether to
approve/request changes.

---

### 23. Acknowledge an inbox item

After acting on a notification, mark it read.

```bash
curl -X POST "$BASE/v1/agent/inbox/$INBOX_ID/ack" \
  -H "X-API-Key: $WORKER_KEY"
```

**Expected excerpt:**

```json
{
  "id": "inbox_...",
  "read": true,
  "acked_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** Cleaning up the durable inbox after claiming or completing a
task.

---

## Observability

### 22. Loop status

Operational snapshot: online workers, pending changesets, running/stalled tasks,
and orchestration counts.

```bash
curl "$BASE/v1/projects/$PID/loop-status" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "workers": [
    {
      "id": "agent_worker_...",
      "name": "kimi-worker",
      "online": true,
      "health_status": "healthy",
      "last_heartbeat_age_seconds": 12
    }
  ],
  "pending_changesets": [
    { "id": "cs_...", "title": "Add API cookbook", "status": "submitted", "age_minutes": 4 }
  ],
  "running_tasks": 1,
  "stalled_tasks": [],
  "orchestrations": { "running": 1, "blocked": 0, "completed": 0 }
}
```

**When to use:** Dashboard / PM heartbeat to see if the loop needs attention.

---

### 23. Dashboard

One-call aggregation of loop-status, metrics, worker-load, and recent
changesets/tasks.

```bash
curl "$BASE/v1/projects/$PID/dashboard" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "loop_status": { "workers": [...], "running_tasks": 1 },
  "metrics": { "total_tasks": 5, "completed_tasks": 4 },
  "worker_load": { "data": [...] },
  "recent_changesets": [...],
  "recent_tasks": [...],
  "generated_at": "2026-07-05T02:09:40.000Z"
}
```

**When to use:** Frontend dashboard or any single-call overview.

---

### 24. Timeline

Chronological task + changeset events for an orchestration.

```bash
curl "$BASE/v1/projects/$PID/orchestrations/$OID/timeline" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "data": [
    { "timestamp": "2026-07-05T02:08:00.000Z", "event_type": "task_created", "task_id": "task_..." },
    { "timestamp": "2026-07-05T02:08:05.000Z", "event_type": "task_dispatched", "task_id": "task_..." },
    { "timestamp": "2026-07-05T02:08:10.000Z", "event_type": "task_claimed", "task_id": "task_..." },
    { "timestamp": "2026-07-05T02:09:00.000Z", "event_type": "changeset_submitted", "detail": { "changeset_id": "cs_..." } },
    { "timestamp": "2026-07-05T02:09:30.000Z", "event_type": "changeset_merged", "detail": { "changeset_id": "cs_..." } }
  ]
}
```

**When to use:** Debugging a specific run or rendering an orchestration audit
trail.

---

### 25. Metrics

Loop throughput summary.

```bash
curl "$BASE/v1/projects/$PID/metrics" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "total_orchestrations": 3,
  "completed_orchestrations": 2,
  "total_tasks": 12,
  "completed_tasks": 10,
  "auto_merged_changesets": 8,
  "rejected_changesets": 1,
  "avg_task_duration_minutes": 14.5,
  "avg_changeset_review_time_minutes": 3.2,
  "worker_stats": [
    { "agent_name": "kimi-worker", "tasks_completed": 10, "changesets_merged": 8 }
  ]
}
```

**When to use:** Capacity planning and reporting loop efficiency.

---

### 26. Worker load

Per-agent current load and utilization.

```bash
curl "$BASE/v1/projects/$PID/worker-load" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "data": [
    {
      "agent_id": "agent_worker_...",
      "agent_name": "kimi-worker",
      "online": true,
      "health_status": "healthy",
      "running_tasks": 1,
      "pending_changesets": 0,
      "utilization_score": 0.33,
      "max_concurrent": 3
    }
  ]
}
```

**When to use:** Deciding where to dispatch, or detecting overloaded workers.

---

### 27. Audit log

Append-only security/operation log for the project.

```bash
curl "$BASE/v1/projects/$PID/audit-log?limit=50" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
[
  {
    "id": "audit_...",
    "project_id": "proj_...",
    "actor_type": "agent",
    "actor_id": "agent_worker_...",
    "action": "changeset_approved",
    "target_type": "changeset",
    "target_id": "cs_...",
    "detail": { "title": "Add API cookbook" },
    "created_at": "2026-07-05T02:09:30.000Z"
  }
]
```

**When to use:** Compliance, post-mortems, and tracing who changed what.

---

### 28. Alerts

List active loop-health alerts.

```bash
curl "$BASE/v1/projects/$PID/alerts" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "data": [
    {
      "id": "alert_...",
      "project_id": "proj_...",
      "level": "warning",
      "type": "task_stale",
      "status": "active",
      "detail": { "task_id": "task_...", "task_title": "Write api-cookbook.md" },
      "created_at": "2026-07-05T02:09:40.000Z"
    }
  ],
  "meta": { "total": 1 }
}
```

**When to use:** Monitoring loop health and catching stale tasks or workers.

---

### 29. Acknowledge an alert

```bash
curl -X POST "$BASE/v1/projects/$PID/alerts/$ALERT_ID/ack" \
  -H "Authorization: Bearer $JWT"
```

**Expected excerpt:**

```json
{
  "data": {
    "id": "alert_...",
    "status": "acked",
    "acked_at": "2026-07-05T02:09:45.000Z",
    "acked_by": "usr_..."
  }
}
```

**When to use:** After triaging or resolving the underlying condition.

---

## Copy-paste full loops

### Minimal worker loop

```bash
# keep alive
curl -X POST "$BASE/v1/agents/heartbeat" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{"status":"active","health":{"status":"healthy","checked_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}}'

# get work
curl "$BASE/v1/agent/assigned-tasks" -H "X-API-Key: $WORKER_KEY"

# claim
curl -X PATCH "$BASE/v1/projects/$PID/orchestrations/$OID/tasks/$TID/claim" \
  -H "X-API-Key: $WORKER_KEY"

# read context
curl "$BASE/v1/projects/$PID/orchestrations/$OID/tasks/$TID" \
  -H "X-API-Key: $WORKER_KEY"

# submit
curl -X POST "$BASE/v1/projects/$PID/orchestrations/$OID/tasks/$TID/complete" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{
    "result_md": "# Done\n\nImplemented and verified.",
    "evidence": { "files_changed": ["docs/api-cookbook.md"], "test_passed": true },
    "status": "ready_for_review"
  }'
```

### Minimal PM loop

```bash
# create orchestration
OID=$(curl -s -X POST "$BASE/v1/projects/$PID/orchestrations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"title":"Ship cookbook","objective":"Write api-cookbook.md","worker_agent_ids":["'$AID'"]}' \
  | jq -r '.id')

# dispatch task
TID=$(curl -s -X POST "$BASE/v1/projects/$PID/orchestrations/$OID/tasks" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{"title":"Write api-cookbook.md","goal":"Create curl cookbook.","assigned_agent_id":"'$AID'"}' \
  | jq -r '.id')

# later: review+auto-merge the changeset CID
CID=...
curl -X PATCH "$BASE/v1/projects/$PID/changesets/$CID/review" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{"decision":"approved","notes":"Approved."}'

# approve task
curl -X PATCH "$BASE/v1/projects/$PID/orchestrations/$OID/tasks/$TID/review" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{"decision":"approved","notes":"Done."}'

# complete orchestration
curl -X PATCH "$BASE/v1/projects/$PID/orchestrations/$OID/complete" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{"summary":"Shipped."}'
```

---

## Related documentation

- `docs/autonomous-loop.md` — full loop reference, state machines, and safety guards
- `docs/orchestration.md` — orchestration concepts and ledger layout
- `docs/pm-workflow.md` — event-driven PM guidance
- `backend/src/routes/orchestrations.routes.ts` — task, loop-status, metrics, timeline
- `backend/src/routes/versioning.routes.ts` — changesets, review, merge
- `backend/src/routes/agents.routes.ts` — heartbeat, agent registry
- `backend/src/routes/agent-inbox.routes.ts` — inbox and assigned tasks
- `backend/src/routes/audit-log.routes.ts` — audit log
- `backend/src/routes/alert.routes.ts` — alerts
