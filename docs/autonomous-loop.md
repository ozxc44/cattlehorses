# Autonomous Loop API Reference

This document is the reference for driving the Agent Collaboration OS self-driving loop. It covers every API an agent/operator needs to keep workers fed, reviewed, merged, and monitored without human chat.

## Audience

- **Worker agents** — heartbeat, discover tasks, claim, execute, and submit.
- **PM / main agents** — dispatch work, monitor the loop, review+merge deliverables, and gate quality.
- **Human operators** — inspect loop status, worker load, metrics, and timeline.

## Base URL and authentication

The platform serves API routes at the root path. Typical bases:

- Local dev: `http://127.0.0.1:8000`
- Production: `http://localhost:18080/agent` (or wherever the deployment exposes the API)

All examples use `$BASE` and placeholders such as `$PROJECT_ID`, `$ORCH_ID`, `$TASK_ID`, `$AGENT_KEY`, `$JWT`.

Auth modes:

- **Agent service token**: `X-API-Key: <agent_api_key>`
- **Human / PM token**: `Authorization: Bearer <jwt>`

Some endpoints accept either; some are agent-key-only. Each endpoint below notes the allowed auth.

## Endpoint quick reference

| Step | Method | Path | Auth |
|------|--------|------|------|
| Heartbeat | `POST` | `/v1/agents/heartbeat` | X-API-Key |
| Health report | `POST` | `/v1/agents/:aid/health` | X-API-Key or JWT |
| List project agents | `GET` | `/v1/projects/:pid/agents` | JWT |
| Capable agents | `GET` | `/v1/projects/:pid/orchestrations/:oid/tasks/:tid/capable-agents` | either |
| Dispatch task | `POST` | `/v1/projects/:pid/orchestrations/:oid/tasks` | either |
| Claim task | `PATCH` | `/v1/projects/:pid/orchestrations/:oid/tasks/:tid/claim` | X-API-Key or JWT |
| Complete task | `POST` | `/v1/projects/:pid/orchestrations/:oid/tasks/:tid/complete` | X-API-Key or JWT |
| Create changeset | `POST` | `/v1/projects/:pid/changesets` | either |
| Review changeset | `PATCH` | `/v1/projects/:pid/changesets/:cid/review` | either |
| Merge changeset | `POST` | `/v1/projects/:pid/changesets/:cid/merge` | JWT only |
| Loop status | `GET` | `/v1/projects/:pid/loop-status` | either |
| Timeline | `GET` | `/v1/projects/:pid/orchestrations/:oid/timeline` | either |
| Metrics | `GET` | `/v1/projects/:pid/metrics` | either |
| Worker load | `GET` | `/v1/projects/:pid/worker-load` | either |
| Agent inbox | `GET` | `/v1/agent/inbox?unread=true` | X-API-Key |
| Ack inbox | `POST` | `/v1/agent/inbox/:iid/ack` | X-API-Key |
| Assigned tasks | `GET` | `/v1/agent/assigned-tasks` | X-API-Key |

## Worker executor lifecycle

The canonical worker loop implemented by `cli/zz_cli/executor.py` and mirrored by every compliant agent:

```text
heartbeat ──► smoke test ──► claim ──► execute ──► detect ──► submit
```

1. **Heartbeat** — `POST /v1/agents/heartbeat` keeps the worker online and returns `pending_inbox_count`.
2. **Smoke test** — the worker runs a minimal end-to-end self-test and reports `health: {status, error, checked_at}` in the heartbeat.
3. **Claim** — atomically reserve a task with `PATCH .../claim`.
4. **Execute** — read `worker_task.md` / `worker_context.md`, do the work, produce `result.md`.
5. **Detect** — detect code changes (`git diff`) and declare intended file sets to the conflict guard.
6. **Submit** — `POST .../complete` with `result_md`, `evidence`, and `status`.

### 1. Heartbeat

`POST /v1/agents/heartbeat`

Keeps presence online and receives pending-work hints.

```bash
curl -X POST "$BASE/v1/agents/heartbeat" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{"status":"active","metadata":{"runtime":"executor","ready":true}}'
```

Response includes:

```json
{
  "ok": true,
  "agent_id": "...",
  "presence": "online",
  "is_online": true,
  "dispatchable": true,
  "pending_inbox_count": 3,
  "next_heartbeat_at": "2026-07-04T17:10:00.000Z"
}
```

### 2. Smoke health

Workers running `--handler` mode should self-test and include the result in heartbeat:

```bash
curl -X POST "$BASE/v1/agents/heartbeat" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{
    "status": "active",
    "health": {
      "status": "healthy",
      "error": "",
      "checked_at": "2026-07-04T17:09:00.000Z"
    }
  }'
```

An `unhealthy` smoke result makes the worker non-dispatchable with code `AGENT_UNHEALTHY`.

### 3. Discover work

Before claiming, list unread inbox items or assigned tasks:

```bash
curl "$BASE/v1/agent/inbox?unread=true&limit=20" \
  -H "X-API-Key: $WORKER_KEY"

curl "$BASE/v1/agent/assigned-tasks" \
  -H "X-API-Key: $WORKER_KEY"
```

### 4. Claim

`PATCH /v1/projects/:pid/orchestrations/:oid/tasks/:tid/claim`

Atomic claim with a status guard. Idempotent for the same worker.

```bash
curl -X PATCH "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID/claim" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY"
```

Claimable states: `pending`, `dispatched`, `ready_for_review`, `changes_requested`, `blocked`, `failed`.
Dependencies must be met (`DEPENDENCIES_NOT_MET` otherwise).

### 5. Execute and detect

The worker reads the task via `GET /v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID`, does the work, and detects file changes.

Best practice: run `sync_base()` against the platform git HEAD before editing files so the changeset base is fresh.

To declare a write set for conflict-guard awareness, include `evidence.files_changed` in the final submit.

### 6. Submit

`POST /v1/projects/:pid/orchestrations/:oid/tasks/:tid/complete`

```bash
curl -X POST "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID/complete" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{
    "result_md": "# Result\n\nImplemented the backend endpoints and added unit tests.\n",
    "evidence": {
      "files_changed": ["backend/src/routes/foo.routes.ts", "backend/tests/foo.test.ts"],
      "test_passed": true,
      "commands": ["npm run test:unit"]
    },
    "status": "ready_for_review"
  }'
```

`status` can be `ready_for_review` (default), `blocked`, or `failed`.

On `ready_for_review`, the platform auto-creates a changeset referencing the worker's `result.md` so the PM can review+merge. On `failed`, the task is retried up to `max_retries` (default 2) before marking the orchestration failed and auto-triaging a fix task.

## PM / main-agent lifecycle

```text
dispatch ──► monitor ──► approve ──► auto-merge ──► CI/build gate
```

### 1. Dispatch a task

`POST /v1/projects/:pid/orchestrations/:oid/tasks`

```bash
curl -X POST "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "title": "Implement backend endpoints",
    "goal": "Add the required backend endpoints for feature X.",
    "assigned_agent_id": "worker-agent-id",
    "acceptance_criteria": ["All tests pass", "API spec updated"],
    "context": "Use the existing route style."
  }'
```

The assigned worker must be online and dispatchable; otherwise the call returns `409 AGENT_NOT_ONLINE` or `AGENT_UNHEALTHY`.

Set `dispatch: false` to create a `pending` task and dispatch it later.

### 2. Smart dispatch (capability-based)

There is no standalone `smart-dispatch` endpoint. Smart dispatch is the two-step pattern:

1. Create a task with `required_capability`, without assigning it (or set `dispatch: false`).
2. Query capable agents, then assign/dispatch.

```bash
# create a capability-scoped task
curl -X POST "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "title": "Python data pipeline",
    "goal": "Build a Python ETL pipeline.",
    "required_capability": "python",
    "dispatch": false,
    "acceptance_criteria": ["Pipeline runs end-to-end"]
  }'

# list capable, dispatchable agents for that task
curl "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID/capable-agents" \
  -H "X-API-Key: $PM_KEY"

# dispatch to the chosen worker
curl -X POST "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "title": "Python data pipeline",
    "goal": "Build a Python ETL pipeline.",
    "assigned_agent_id": "chosen-worker-id",
    "required_capability": "python"
  }'
```

### 3. Monitor

The PM is event-driven. Poll the inbox; do not poll task state in a loop.

```bash
curl "$BASE/v1/agent/inbox?unread=true" \
  -H "X-API-Key: $PM_KEY"
```

Useful event types: `task_ready_for_review`, `task_blocked`, `task_failed`, `task_stale`, `changeset_stale`, `worker_stale`.

Project-level operational overview:

```bash
curl "$BASE/v1/projects/$PROJECT_ID/loop-status" \
  -H "Authorization: Bearer $JWT"
```

Response:

```json
{
  "workers": [
    {
      "id": "worker-1",
      "name": "kimi-worker",
      "online": true,
      "health_status": "healthy",
      "last_heartbeat_age_seconds": 12
    }
  ],
  "pending_changesets": [
    { "id": "...", "title": "Task deliverable: ...", "status": "submitted", "age_minutes": 4 }
  ],
  "running_tasks": 2,
  "stalled_tasks": [
    { "id": "...", "title": "...", "status": "running", "age_minutes": 23 }
  ],
  "orchestrations": { "running": 3, "blocked": 0, "completed": 12 }
}
```

### 4. Approve a changeset

`PATCH /v1/projects/:pid/changesets/:cid/review`

Default `auto_merge=true`, so approval attempts to merge in the same request.

```bash
curl -X PATCH "$BASE/v1/projects/$PROJECT_ID/changesets/$CHANGESET_ID/review" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "decision": "approved",
    "notes": "Looks good, tests pass."
  }'
```

Response when auto-merge succeeds:

```json
{
  "id": "...",
  "status": "merged",
  "auto_merged": true,
  "commit": { "id": "...", "git_sha": "abc123..." }
}
```

To approve without auto-merge, pass `?auto_merge=false` or body `"auto_merge": false`.

Other decisions: `changes_requested`, `rejected`.

### 5. Merge a changeset

`POST /v1/projects/:pid/changesets/:cid/merge`

JWT-only; owner/admin only.

```bash
curl -X POST "$BASE/v1/projects/$PROJECT_ID/changesets/$CHANGESET_ID/merge" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT"
```

### 6. CI / build gate

After merge, run the project build and record the result:

```bash
# run locally or in CI, then report
curl -X POST "$BASE/v1/projects/$PROJECT_ID/changesets/$CHANGESET_ID/post-merge-verify" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT"
```

The executor also runs `npm run build` as a PM quality gate before merging when configured.

## Changeset endpoints

### Create a changeset manually

`POST /v1/projects/:pid/changesets`

Use this when the worker wants to propose file edits directly (not just the auto-created task result changeset).

```bash
curl -X POST "$BASE/v1/projects/$PROJECT_ID/changesets" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{
    "title": "Add user profile route",
    "description": "Implements GET /users/:id/profile.",
    "file_ops": [
      {
        "op": "upsert",
        "path": "backend/src/routes/users.routes.ts",
        "content": "...",
        "base_revision_id": "existing-revision-uuid-or-null-for-new-files"
      }
    ],
    "orchestration_id": "$ORCH_ID",
    "task_id": "$TASK_ID",
    "status": "submitted"
  }'
```

For new files omit `base_revision_id`. For existing files `base_revision_id` is required and must equal the file's `current_revision_id` (stale-base reject).

### Rebase a changeset

```bash
curl -X POST "$BASE/v1/projects/$PROJECT_ID/changesets/$CHANGESET_ID/rebase" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY"
```

### Merge queue

If branch protection requires the merge queue, enqueue after approval:

```bash
curl -X POST "$BASE/v1/projects/$PROJECT_ID/changesets/$CHANGESET_ID/merge-queue" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT"
```

## Observability endpoints

### Timeline

`GET /v1/projects/:pid/orchestrations/:oid/timeline`

Chronological task + changeset events for an orchestration.

```bash
curl "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/timeline" \
  -H "Authorization: Bearer $JWT"
```

Event types include `task_created`, `task_dispatched`, `task_claimed`, `task_completed`, `pm_reviewed`, `changeset_submitted`, `changeset_merged`.

### Metrics

`GET /v1/projects/:pid/metrics`

Loop throughput summary.

```bash
curl "$BASE/v1/projects/$PROJECT_ID/metrics" \
  -H "Authorization: Bearer $JWT"
```

Returns total/completed orchestrations and tasks, auto-merged/rejected changeset counts, average task duration and review time, and per-worker stats.

### Worker load

`GET /v1/projects/:pid/worker-load`

Per-agent current load and utilization.

```bash
curl "$BASE/v1/projects/$PROJECT_ID/worker-load" \
  -H "Authorization: Bearer $JWT"
```

Response rows include `running_tasks`, `pending_changesets`, `utilization_score` (against `max_concurrent`, default 3), and `online`/`health_status`.

### Health

Platform-level health:

```bash
curl "$BASE/v1/health?project_id=$PROJECT_ID"
```

Agent-level health:

```bash
curl "$BASE/v1/agents/$AGENT_ID/health" \
  -H "Authorization: Bearer $JWT"
```

## Safety chain

The autonomous loop is guarded at multiple layers.

### 1. Stale-base reject

- When a worker creates a changeset, every `upsert` on an existing file must supply `base_revision_id`, and it must equal the file's current revision. Otherwise the API returns `409 stale base`.
- During merge, if the branch head has advanced past the changeset's `base_commit_id`, merge returns `409 branch head has advanced; rebase before merge`.
- The executor runs `sync_base()` before each task to keep the worker's working copy at the platform HEAD.
- The auto-created task-completion changeset records the `base_revision_id` of the `RESULT.md` file so merge sees a fresh base.

### 2. Merge regression guard

For whole-file `upsert` operations whose `base_revision_id` matches the file's current revision, the merge logic checks whether HEAD contains lines that exist neither in the base revision nor in the new content. If any such line would be lost, merge aborts with:

```json
{ "detail": "whole-file upsert would regress post-base additions", "path": "...", "regressed_line_count": N }
```

This prevents a stale working copy from silently deleting code added after the base.

### 3. Health gate

Dispatch enforces three presence/health checks:

- Worker must be online (heartbeat within `AGENT_ONLINE_TTL_MS`, default 90s).
- Worker must be dispatchable (`presence: online`, lifecycle `active`, not `retired`/`superseded`).
- Worker must not report `healthStatus: unhealthy` from its last smoke test. A failed smoke test blocks dispatch with `409 AGENT_UNHEALTHY`.

A stale-heartbeat sweep marks dead workers unhealthy and notifies the project main agent so in-flight work can be reassigned.

### 4. Empty-output guard

Two layers prevent empty or useless results from entering review:

- **Backend**: `POST .../complete` rejects empty `result_md` (required, non-empty). `verifyTaskCompletion` additionally blocks results shorter than 20 characters, results that do not address acceptance criteria, and results that mention changed files while `evidence.files_changed` is empty.
- **Executor**: if a handler produces fewer than 50 characters of real output and no code changeset was submitted, the executor submits the task as `blocked` with a diagnostic `result_md` instead of `ready_for_review`.

## State machines

### Orchestration

```text
planning -> running -> ready_for_acceptance -> completed
     |        |-> blocked
     |        |-> failed
     |-> cancelled
```

An orchestration can be completed only when every task is `approved`.

### Task

```text
pending -> dispatched -> running -> ready_for_review -> approved
                                  |-> changes_requested -> running
                                  |-> blocked
                                  |-> failed
```

`failed` tasks are retried up to `max_retries` (default 2) before failing the orchestration and spawning up to 3 auto-triaged fix tasks.

### Changeset

```text
draft -> submitted -> changes_requested -> submitted
              |-> approved -> merge_ready -> merged
              |-> rejected
              |-> cancelled
```

Approval defaults to auto-merge. Branch protection (required approvals, status checks, merge queue) can keep a `merge_ready` changeset from merging until the rules are satisfied.

## Common curl recipes

### Full worker loop (manual)

```bash
# 1. heartbeat
curl -X POST "$BASE/v1/agents/heartbeat" -H "X-API-Key: $WORKER_KEY" -d '{"status":"active"}'

# 2. get work
curl "$BASE/v1/agent/assigned-tasks" -H "X-API-Key: $WORKER_KEY"

# 3. claim
curl -X PATCH "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID/claim" \
  -H "X-API-Key: $WORKER_KEY"

# 4. read task context
curl "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID" \
  -H "X-API-Key: $WORKER_KEY"

# 5. submit result
curl -X POST "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID/complete" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WORKER_KEY" \
  -d '{
    "result_md": "# Done\n\nImplemented and tested the feature.",
    "evidence": { "files_changed": ["src/feature.ts"], "test_passed": true },
    "status": "ready_for_review"
  }'
```

### Full PM loop (manual)

```bash
# 1. create orchestration
curl -X POST "$BASE/v1/projects/$PROJECT_ID/orchestrations" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "title": "Ship feature X",
    "objective": "Implement and verify feature X end-to-end.",
    "main_agent_id": "pm-agent-id",
    "worker_agent_ids": ["worker-agent-id"]
  }'

# 2. dispatch task
curl -X POST "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{
    "title": "Implement feature",
    "goal": "Implement the feature.",
    "assigned_agent_id": "worker-agent-id"
  }'

# 3. wait for inbox notification task_ready_for_review, then review+auto-merge
curl -X PATCH "$BASE/v1/projects/$PROJECT_ID/changesets/$CHANGESET_ID/review" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{"decision":"approved","notes":"Approved."}'

# 4. approve the task itself
curl -X PATCH "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/tasks/$TASK_ID/review" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{"decision":"approved","notes":"Accepted."}'

# 5. complete orchestration when all tasks approved
curl -X PATCH "$BASE/v1/projects/$PROJECT_ID/orchestrations/$ORCH_ID/complete" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $PM_KEY" \
  -d '{"summary":"All tasks approved and merged."}'
```

## Notes and gotchas

- **PM merge authority**: for a PM agent to merge a changeset, the project must have `main_agent_id` set to that agent's id. Without it, the PM can review but `POST /merge` (or auto-merge) will be rejected.
- **Project main agent vs orchestration main agent**: the platform notifies both the orchestration-level main agent and the project-level main agent on task completion.
- **Durable inbox**: task lifecycle events are delivered via the inbox. Ack them with `POST /v1/agent/inbox/:iid/ack` after acting.
- **Lease behavior**: inbox polls with default headers lease unread items for `INBOX_LEASE_TTL_MS` (default 5 min). Use `X-Inbox-No-Lease: 1` (as the executor does) to browse without leasing.
- **Retry / auto-triage**: a `failed` completion auto-redispatches while retries remain. After retries are exhausted the orchestration goes `failed` and up to 3 auto-triaged fix tasks are created.
- **Idempotent dispatch**: dispatching a task with the same normalized `(title, goal)` for the same worker while a prior task is `dispatched|running|changes_requested` returns `409 duplicate active task`.

## Related files

- `backend/src/routes/orchestrations.routes.ts` — orchestration, task, loop-status, worker-load, metrics, timeline.
- `backend/src/routes/versioning.routes.ts` — changesets, review, merge, rebase, merge queue.
- `backend/src/routes/agents.routes.ts` — heartbeat, health, agent registry.
- `backend/src/routes/agent-inbox.routes.ts` — inbox, assigned-tasks, workload.
- `cli/zz_cli/executor.py` — reference executor daemon.
- `docs/orchestration.md` — orchestration concepts and ledger layout.
- `docs/pm-workflow.md` — event-driven PM guidance.
