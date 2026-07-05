import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-cancel-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

let passed = 0;
let failed = 0;

function check<T>(label: string, actual: T, expected: T): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const { ProjectOrchestrationTask } = await import('../src/entities');
  const app = (await import('../src/app')).default;
  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // ── Bootstrap: owner + pm (project main agent) + worker ────────────────
    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');
    const wUser = await register(baseUrl, 'worker');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Task Cancel Test', visibility: 'public',
    });
    const projectId = project.data.id;
    for (const u of [pmUser, wUser]) {
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: u.userId, role: 'member' });
    }

    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm' });
    const pmKey = pm.data.api_key;
    const pmId = pm.data.id;
    const worker = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, wUser.token, { name: 'worker' });
    const workerKey = worker.data.api_key;
    const workerId = worker.data.id;

    for (const k of [pmKey, workerKey]) {
      await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', k, {});
    }
    // pm is the project-level main agent (PM).
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmId });

    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'cancel orch', objective: 'exercise the task cancel endpoint edge cases',
      main_agent_id: pmId, worker_agent_ids: [workerId],
    });
    const orchId = orch.data.id;
    const taskPath = (taskId: string) => `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}`;

    // ── Dispatch a cancellable task to the worker ──────────────────────────
    const t = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'doomed task', goal: 'will be cancelled before completion',
      assigned_agent_id: workerId, acceptance_criteria: ['feature works'],
    });
    check('dispatch task to worker', t.status, 201);
    const taskId = t.data.id;

    // ── Edge case (1) + (2): cancel → cancelled_at set + metadata.cancellation populated
    const cancel = await apiWithKey(baseUrl, 'POST', `${taskPath(taskId)}/cancel`, pmKey, {
      reason: 'obsolete',
    });
    check('cancel returns 200', cancel.status, 200);
    check('cancel sets status to cancelled', cancel.data.status, 'cancelled');
    // (1) cancelledAt is set: response exposes a non-null ISO `cancelled_at`.
    check('cancelled_at is set (non-null)', cancel.data.cancelled_at !== null, true);
    check('cancelled_at is a valid ISO string', typeof cancel.data.cancelled_at === 'string' && !isNaN(new Date(cancel.data.cancelled_at).getTime()), true);
    // (2) metadata.cancellation is populated with who/when/why. The serializer
    //     exposes the structured `cancellation` field (derived from the stored
    //     metadata.cancellation), and we additionally read the DB row to confirm
    //     the metadata.cancellation object is literally persisted.
    const cancellation = cancel.data.cancellation;
    check('cancellation field present', cancellation !== undefined && cancellation !== null, true);
    check('cancellation.cancelled_at set', typeof cancellation?.cancelled_at === 'string', true);
    check('cancellation.cancelled_by is the PM', cancellation?.cancelled_by, pmId);
    check('cancellation.reason recorded', cancellation?.reason, 'obsolete');

    const dbRow = await AppDataSource.getRepository(ProjectOrchestrationTask).findOne({ where: { id: taskId } });
    const dbCancellation = (dbRow?.metadata as Record<string, unknown> | null | undefined)?.cancellation as Record<string, unknown> | undefined;
    check('DB metadata.cancellation populated', dbCancellation !== undefined && dbCancellation !== null, true);
    check('DB metadata.cancellation.cancelled_by is PM', dbCancellation?.cancelled_by, pmId);
    check('DB metadata.cancellation.cancelled_at set', typeof dbCancellation?.cancelled_at === 'string', true);

    // Re-fetch to confirm persistence through the serialize path (GET task).
    const refetch = await apiWithKey(baseUrl, 'GET', taskPath(taskId), pmKey);
    check('GET cancelled task 200', refetch.status, 200);
    check('GET reflects cancelled_at', refetch.data.cancelled_at !== null, true);
    check('GET reflects cancellation field', refetch.data.cancellation?.cancelled_by, pmId);

    // ── Edge case (3): worker receives a task_cancelled inbox notification ──
    const workerInbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox?unread=true', workerKey);
    check('worker inbox 200', workerInbox.status, 200);
    const cancelledNotify = (workerInbox.data.data || []).find((i: any) => i.task_id === taskId && i.event_type === 'task_cancelled');
    check('worker got task_cancelled inbox notification', !!cancelledNotify, true);
    // The stale task_dispatched notification for this task must be cleared
    // (acked) so the worker cannot claim a dead task (ghost-notification guard).
    const staleDispatch = (workerInbox.data.data || []).find((i: any) => i.task_id === taskId && i.event_type === 'task_dispatched' && i.status === 'unread');
    check('stale task_dispatched notification cleared', !staleDispatch, true);

    // ── Edge case (4): terminal-status tasks return 409 ────────────────────
    // 4a. Cancelling an already-CANCELLED task → 409.
    const reCancel = await apiWithKey(baseUrl, 'POST', `${taskPath(taskId)}/cancel`, pmKey, { reason: 'again' });
    check('cancel already-cancelled task → 409', reCancel.status, 409);

    // 4b. Cancelling an APPROVED task → 409. Drive a fresh task through
    //     complete → PM review(approved), then attempt cancel.
    const t2 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'approved task', goal: 'will be approved then cancel-attempted',
      assigned_agent_id: workerId, acceptance_criteria: ['feature works'],
    });
    const t2Id = t2.data.id;
    // Worker completes (result addresses the acceptance criterion; >20 chars).
    const complete = await apiWithKey(baseUrl, 'POST', `${taskPath(t2Id)}/complete`, workerKey, {
      result_md: '# Result\n\nfeature works as expected and is fully implemented here.',
      evidence: { files_changed: ['deliverables/result.md'], test_passed: true },
    });
    check('complete task → 200 (ready_for_review)', complete.status, 200);
    check('task is ready_for_review', complete.data.status, 'ready_for_review');
    // PM approves.
    const approve = await apiWithKey(baseUrl, 'PATCH', `${taskPath(t2Id)}/review`, pmKey, {
      decision: 'approved', notes: 'Looks good.',
    });
    check('review approved → 200', approve.status, 200);
    check('task is approved (terminal)', approve.data.status, 'approved');
    // Now cancel must be refused.
    const cancelApproved = await apiWithKey(baseUrl, 'POST', `${taskPath(t2Id)}/cancel`, pmKey, { reason: 'too late' });
    check('cancel approved (terminal) task → 409', cancelApproved.status, 409);

    // ── RBAC sanity: a worker cannot cancel its own task ───────────────────
    const t3 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'rbac task', goal: 'worker must not be able to cancel',
      assigned_agent_id: workerId, acceptance_criteria: ['rbac enforced'],
    });
    const cancelByWorker = await apiWithKey(baseUrl, 'POST', `${taskPath(t3.data.id)}/cancel`, workerKey, { reason: 'worker tries' });
    check('worker denied cancel (403)', cancelByWorker.status, 403);

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exit(1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'TaskCancel123!', display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(baseUrl: string, method: string, path: string, token: string | undefined, body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

async function apiWithKey(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

main().catch((err) => { console.error(err); process.exit(1); });
