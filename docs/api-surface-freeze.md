# API Surface Freeze: Golden Path Router Inventory

> **Status:** Accepted PM Recommendation 3 (assessment `20260620_004638_c`)
> **Target:** All 18 Express route groups mounted in `backend/src/app.ts`
> **Goal:** Prevent accidental expansion of non-Golden-Path route groups

---

## 1. Classification Key

| Label | Meaning | Action |
|---|---|---|
| **Golden Path Required** | Endpoint(s) a worker or PM must hit to complete the 8-step GP loop. | Keep, test, maintain. |
| **Golden Path Support** | Required for operating the loop (monitoring, metrics, user mgmt, real-time). | Keep, test, maintain. Do not expand. |
| **Exploratory / Frozen** | Built beyond the narrowed V1; `golden-path-ledger.md` "Do Not Build Now" applies. | Do not add new endpoints. Do not remove (nonfunctional change). |
| **Needs PM Decision** | Route file exists but its role in the frozen V1 surface is ambiguous. | PM must decide: Support or Frozen. |

---

## 2. Router Inventory

All 18 groups are mounted in `backend/src/app.ts` (lines 143-160). Each is classified below with its prefix pattern, endpoint count, and rationale.

### 2.1 Golden Path Required (6 groups)

| # | File | Mounted prefix / key patterns | Endpoints | Rationale |
|---|---|---|---|---|
| 1 | `auth.routes.ts` | `/v1/auth/register`, `/v1/auth/token`, `/v1/auth/me` | 3 | GP step 1: user must register/login to create a project. |
| 2 | `projects.routes.ts` | `/v1/projects` (CRUD), `/v1/projects/:id/summary`, `/v1/projects/:id/members` (CRUD) | 10 | GP step 1: Create Project. Step 8 result visibility uses project scope. |
| 3 | `agents.routes.ts` | `/v1/projects/:pid/agents` (CRUD, send, runs), `/v1/agents/:aid` (get, patch, delete, health, retire), `/v1/agents/heartbeat`, `/v1/agents/metrics`, `/v1/users/me/agents` | ~18 | GP step 2: Register/bring online PM and Worker agents. Heartbeat/metrics required for dispatchable presence. |
| 4 | `sessions.routes.ts` | `/v1/projects/:pid/sessions` (CRUD, messages), `/v1/sessions/:sid` (messages) | 6 | GP step 3: Create orchestration/session. |
| 5 | `orchestrations.routes.ts` | `/v1/projects/:pid/orchestrations` (CRUD, tasks, claim, complete, review, main-agent switch) | ~12 | GP steps 4, 6, 7: Dispatch task, claim/complete, PM review. |
| 6 | `agent-inbox.routes.ts` | `/v1/agent/inbox`, `/v1/agent/inbox/:id/ack`, `/v1/agent/workload`, `/v1/agent/projects`, `/v1/projects/:pid/workload` | 5 | GP step 5: Worker receives durable inbox item. Workload tracking. |

### 2.2 Golden Path Support (6 groups)

| # | File | Mounted prefix / key patterns | Endpoints | Rationale |
|---|---|---|---|---|
| 7 | `project-space.routes.ts` | `/v1/projects/:pid/files` (CRUD, revisions), `/v1/projects/:pid/memories` (CRUD), `/v1/projects/:pid/join-requests` (CRUD), `/v1/projects/:pid/clone`, `/v1/projects/:pid/file-proposals` (CRUD, review) | ~14 | GP step 8 needs file/memory visibility. **Sub-endpoints `clone` and `file-proposals` are frozen**; `join-requests` is Golden Path Support — see §3. |
| 8 | `health.routes.ts` | `/v1/health`, `/v1/projects/:pid/health`, `/v1/projects/:pid/health/incidents` | 4 | Operations: availability probe, project health, incident list in health context. |
| 9 | `users.routes.ts` | `/v1/users/search`, `/v1/users/me/owner-agent` (get, patch) | 3 | User search + owner-agent binding (required for agent-to-owner dispatch). |
| 10 | `events.routes.ts` | `/v1/sessions/:sid/events`, `/v1/sessions/:sid/stream`, `/v1/projects/:pid/events` | 3 | SSE event streaming (real-time session comms) + webhook delivery. |
| 11 | `notification-metrics.routes.ts` | `/v1/projects/:pid/notification-metrics`, `/v1/admin/notification-metrics` | 2 | TTFT north-star metric surface. Admin variant for cross-project view. |
| 12 | `collaboration-requests.routes.ts` | `/v1/requests` (CRUD, approve, reject, cancel), `/v1/agent/request-owner-bind` | 6 | Agent-initiated owner binding required for GP step 2. **Strict surface freeze — do not expand:** no new request types, cross-project scopes, or new approval entry points. Bridged `ProjectJoinRequest` approvals/rejections back-sync the legacy request status. |

### 2.3 Exploratory / Frozen (6 groups)

| # | File | Mounted prefix / key patterns | Endpoints | GK "Do Not Build Now" match |
|---|---|---|---|---|
| 13 | `versioning.routes.ts` | `/v1/projects/:pid/branches`, `/v1/projects/:pid/commits`, `/v1/projects/:pid/changesets` (CRUD, review, merge, rebase), `/v1/projects/:pid/rollback` | ~12 | "Complex version-control semantics beyond one reviewed-change path." Branches, commits, changesets, merge, rebase, rollback are all beyond "one reviewed-change path." |
| 14 | `incidents.routes.ts` | `/v1/incidents` (list, get, patch), `/v1/projects/:pid/agents/:aid/incidents`, `/v1/projects/:pid/agents/:aid/health-check` | 5 | "A separate observability product around health/incidents." Platform-wide incident management with status transitions. |
| 15 | `mcp.routes.ts` | `/v1/projects/:pid/mcp/capabilities` (CRUD) | 3 | "Protocol compatibility abstractions." MCP bridge capability registration. |
| 16 | `debug.routes.ts` | `/v1/debug/logs`, `/v1/debug/logs/config` | 2 | Debug tooling for operators. Already gated behind `DEBUG_LOG_API_TOKEN`. Not in GP. |
| 17 | `reward-preview.routes.ts` | `/v1/projects/:pid/reward-preview`, `/v1/projects/:pid/reward-preview/recalculate`, `/v1/work-units/:id/adjust` | 3 | Reward/contribution calculation. "New endpoints unless they remove a real manual step in the Golden Path" — does not remove a GP step. |
| 18 | `gates.routes.ts` | `/v1/gate-templates` (list), `/v1/projects/:pid/gates` (CRUD, attempts, prefilter, review) | 8 endpoint families / 10 Express handlers | "No marketplace, cross-org collaboration, or protocol compatibility abstractions." Admission gate system for project membership. V1 owner/admin membership via `ProjectJoinRequest` covers the Golden Path — gates are V1-optional admission machinery for deferred public-contributor/marketplace scenarios. |

---

## 3. Mixed-Route Files

Some route files contain a mix of GP and non-GP endpoints within a single file.

### `project-space.routes.ts` — the biggest concern

The file bundles 5 distinct endpoint families:

| Sub-group | GP relevance | Classification |
|---|---|---|
| Files CRUD + revisions | Step 8: safe reviewed result visible in Project Space | **Golden Path Required** |
| Memories CRUD | Agent persistence for context | **Golden Path Support** |
| Join Requests (create/list/review) | V1 project membership / owner approval | **Golden Path Support** — V1 project membership gateway. Legacy requests bridge into `collaboration-requests`, and collaboration approve/reject back-syncs the legacy request status. Do not expand. |
| Clone project | Edge operation, not in GP | **Frozen** |
| File Proposals (CRUD, review, approval) | Change-suggestion workflow; overlaps with versioning | **Frozen** — this is a review-and-approve loop for proposed file changes. Building a proposal system is beyond "one reviewed-change path." |

> **Risk**: Adding new endpoints to this file "for convenience" would accidentally expand non-GP surface. Consider extracting the frozen sub-groups (clone, file-proposals) into separate files if the file grows.

---

## 4. New Endpoint Gate Rule

**Rule:** *No new API endpoint may be added to any route group unless it removes a real manual step from the Golden Path.*

Guiding questions for any proposed endpoint:

1. **Which Golden Path step does this endpoint remove or replace a manual action in?**
   - If the answer is "none," the endpoint is blocked.
   - "Makes the existing step easier" is not enough — it must *eliminate* a manual step.

2. **Which route file would this endpoint be added to?**
   - If the file is in the **Exploratory/Frozen** category, the endpoint is blocked regardless.
   - If the file is **Golden Path Required** or **Support**, the endpoint is allowed only if it passes question 1.

3. **Could this endpoint be implemented without adding a new HTTP route?**
   - Prefer client-side logic, configuration, or existing orchestration primitives over new endpoints.
   - Every new endpoint is surface that must be maintained, documented, and audited.

### Exemptions

The following do not require PM pre-approval:
- **Health/readiness probes** on existing support routes.
- **Idempotency keys** or **pagination parameters** on existing endpoints.
- **Error detail improvements** that do not change the response schema in a breaking way.
- **Removal of deprecated endpoints.**

All other new endpoints must be flagged at the weekly PM review in the ledger.

---

## 5. Summary

| Category | Count | Routes |
|---|---|---|
| Golden Path Required | 6 | auth, projects, agents, sessions, orchestrations, agent-inbox |
| Golden Path Support | 6 | project-space (partial), health, users, events, notification-metrics, collaboration-requests |
| Exploratory / Frozen | 6 | versioning, incidents, mcp, debug, reward-preview, gates |
| Needs PM Decision | 0 | |
| **Total** | **18** | |

### Automated Frozen-Surface Guard

A machine-checkable guard enforces the project-space route surface inventory across **four** artifacts at once — source (two files), the in-script manifest, this freeze doc, and the capability matrix — so a developer cannot update two of them and silently forget the rest:

- **Script:** `scripts/validate-project-space-routes.js` — parses both `project-space.routes.ts` (GP-Required + GP-Support) and `project-space-frozen.routes.ts` (Frozen), enumerates all `router.METHOD(...)` registrations, compares against a known 27-route manifest partitioned into three families, AND cross-checks the same family counts + frozen sub-route names against this document and `.codex/pm-workers/current-capability-matrix.md`:
  - **GP-Required** (17 routes): files CRUD (incl. upload, import/import-preview + PATCH/DELETE by id), read helpers (raw/download/blame, revisions/compare), README, agents-rules (AGENTS.md), archive.zip — in `project-space.routes.ts`
  - **GP-Support** (5 routes): memories CRUD, join-requests — in `project-space.routes.ts`
  - **Frozen** (5 routes): clone, file-proposals
- **Test:** `backend/tests/project-space-route-guard.test.ts` — runs the guard end-to-end against the real artifacts (exit 0) and proves drift is caught by pointing the guard at doctored freeze-doc/matrix temp files (exit ≠ 0). Runs as part of `npm test`.
- **Failure modes:**
  - a new route is added to either `project-space.routes.ts` or `project-space-frozen.routes.ts` without updating the manifest;
  - the manifest is updated but the family counts or frozen sub-route names in this document or the capability matrix are left stale.
  - Either drift fails the guard — preventing silent expansion of frozen sub-routes and preventing the docs/matrix from overclaiming a surface that no longer matches the code.
- **Parser limitation (documented):** the guard matches literal `router.METHOD('...')` registrations only; dynamic/conditional route registration is not detected. Both project-space route files use only literal registrations, so this is sufficient. Do not rewrite the router to work around the guard.

To add a legitimate new route:
1. Add the route to the appropriate file (`project-space.routes.ts` for GP-Required/GP-Support, `project-space-frozen.routes.ts` for Frozen)
2. Add a corresponding entry to the `MANIFEST` array in `scripts/validate-project-space-routes.js`
3. Update this document (`docs/api-surface-freeze.md`) family-count bullets and the capability matrix to match the new manifest
4. Run `node scripts/validate-project-space-routes.js` to confirm all four artifacts agree

### Actions for PM

1. ~~**Consider extracting frozen sub-routes** from `project-space.routes.ts` (clone, file-proposals) into separate files to prevent accidental expansion.~~ **Done (Batch 14A):** Frozen sub-routes are now in `project-space-frozen.routes.ts`. The guard checks both files.
2. **Enforce the New Endpoint Gate Rule** (§4) at every weekly review.

---

*Generated by hermes-b, 2026-06-20. See `.codex/pm-workers/golden-path-ledger.md` for the GK decision and `.codex/pm-workers/tasks/20260620_004638_c/result.md` for the full assessment.*
