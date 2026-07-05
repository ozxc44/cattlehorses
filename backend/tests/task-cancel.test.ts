import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-cancel-test-secret';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
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
  const app = (await import('../src/app')).default;
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');
    const workerUser = await register(baseUrl, 'worker');
    const otherUser = await register(baseUrl, 'other');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Task Cancel Test',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    for (const u of [pmUser, workerUser, otherUser]) {
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
        user_id: u.userId,
        role: 'member',
      });
    }

    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm' });
    const pmKey = pm.data.api_key;
    const pmId = pm.data.id;
    const worker = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, workerUser.token, { name: 'worker' });
    const workerKey = worker.data.api_key;
    const workerId = worker.data.id;
    const other = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, otherUser.token, { name: 'other' });
    const otherKey = other.data.api_key;

    for (const k of [pmKey, workerKey, otherKey]) {
      await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', k, {});
    }

    // pm is project-level main agent.
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmId });

    const orch = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, pmKey, {
      title: 'cancel orch',
      objective: 'test task cancellation',
      main_agent_id: pmId,
      worker_agent_ids: [workerId],
    });
    check('create orchestration', orch.status, 201);
    const orchId = orch.data.id;

    // ── Cancel from dispatched status ────────────────────────────────────────
    const dispatchedTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'dispatched-task',
      goal: 'to be cancelled while dispatched',
      assigned_agent_id: workerId,
    });
    check('dispatch task', dispatchedTask.status, 201);
    check('dispatched task status', dispatchedTask.data.status, 'dispatched');

    const cancelDispatched = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${dispatchedTask.data.id}/cancel`, pmKey, {
      reason: 'no longer needed',
    });
    check('cancel dispatched task status code', cancelDispatched.status, 200);
    check('cancelled task status', cancelDispatched.data.status, 'cancelled');
    check('cancelled_at is set', typeof cancelDispatched.data.cancelled_at, 'string');
    check('metadata.cancellation.reason', cancelDispatched.data.metadata?.cancellation?.reason, 'no longer needed');
    check('metadata.cancellation.cancelled_by_agent_id', cancelDispatched.data.metadata?.cancellation?.cancelled_by_agent_id, pmId);

    // Worker receives task_cancelled inbox item.
    const workerInbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox?unread=true', workerKey);
    const cancelledNotify = (workerInbox.data.data || []).find(
      (i: any) => i.task_id === dispatchedTask.data.id && i.event_type === 'task_cancelled',
    );
    check('worker notified of cancellation', Boolean(cancelledNotify), true);

    // ── Cancel from running status (via claim) ───────────────────────────────
    const runningTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'running-task',
      goal: 'to be cancelled while running',
      assigned_agent_id: workerId,
    });
    const claim = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${runningTask.data.id}/claim`, workerKey);
    check('claim task', claim.status, 200);
    check('claimed task status', claim.data.status, 'running');

    const cancelRunning = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${runningTask.data.id}/cancel`, pmKey, {
      reason: 'priority shifted',
    });
    check('cancel running task', cancelRunning.status, 200);
    check('cancelled running task status', cancelRunning.data.status, 'cancelled');
    check('cancelled running task metadata.reason', cancelRunning.data.metadata?.cancellation?.reason, 'priority shifted');

    // ── Cancel from changes_requested status ─────────────────────────────────
    const changesTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'changes-task',
      goal: 'to be cancelled while changes requested',
      assigned_agent_id: workerId,
    });
    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${changesTask.data.id}/claim`, workerKey);
    await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${changesTask.data.id}/complete`, workerKey, {
      result_md: '# Result\n\nneeds review',
      evidence: { files_changed: [] },
      status: 'ready_for_review',
    });
    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${changesTask.data.id}/review`, pmKey, {
      decision: 'changes_requested',
      requested_changes: 'do better',
    });

    const cancelChanges = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${changesTask.data.id}/cancel`, pmKey, {});
    check('cancel changes_requested task', cancelChanges.status, 200);
    check('cancelled changes task status', cancelChanges.data.status, 'cancelled');

    // ── Cancel from blocked status ───────────────────────────────────────────
    const blockedTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'blocked-task',
      goal: 'to be cancelled while blocked',
      assigned_agent_id: workerId,
    });
    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${blockedTask.data.id}/claim`, workerKey);
    await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${blockedTask.data.id}/complete`, workerKey, {
      result_md: '# Result\n\nblocked',
      evidence: { files_changed: [] },
      status: 'blocked',
    });

    const cancelBlocked = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${blockedTask.data.id}/cancel`, pmKey, {
      reason: 'blocked upstream',
    });
    check('cancel blocked task', cancelBlocked.status, 200);
    check('cancelled blocked task status', cancelBlocked.data.status, 'cancelled');

    // ── User (JWT) can cancel ────────────────────────────────────────────────
    const userTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'user-cancel-task',
      goal: 'to be cancelled by a user',
      assigned_agent_id: workerId,
    });
    const cancelByUser = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${userTask.data.id}/cancel`, owner.token, {
      reason: 'user called it off',
    });
    check('user can cancel task', cancelByUser.status, 200);
    check('user cancelled task status', cancelByUser.data.status, 'cancelled');

    // ── Not allowed from terminal statuses ───────────────────────────────────
    const approvedTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'approved-task',
      goal: 'to test cancellation after approval',
      assigned_agent_id: workerId,
    });
    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${approvedTask.data.id}/claim`, workerKey);
    await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${approvedTask.data.id}/complete`, workerKey, {
      result_md: '# Result\n\ndone',
      evidence: { files_changed: [] },
      status: 'ready_for_review',
    });
    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${approvedTask.data.id}/review`, pmKey, {
      decision: 'approved',
    });

    const cancelApproved = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${approvedTask.data.id}/cancel`, pmKey, {
      reason: 'too late',
    });
    check('cannot cancel approved task', cancelApproved.status, 409);

    const cancelAgain = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${dispatchedTask.data.id}/cancel`, pmKey, {});
    check('cannot cancel already cancelled task', cancelAgain.status, 409);

    // ── RBAC: non-main-agent worker cannot cancel ────────────────────────────
    const workerCancelTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'worker-cancel-attempt',
      goal: 'to test worker cannot cancel',
      assigned_agent_id: workerId,
    });
    const workerCancel = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${workerCancelTask.data.id}/cancel`, workerKey, {
      reason: 'worker wants out',
    });
    check('worker denied cancel', workerCancel.status, 403);

    // ── Summary ──────────────────────────────────────────────────────────────
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
    password: 'TaskCancel123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

async function apiWithKey(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
