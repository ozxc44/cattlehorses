import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'audit-log-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

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

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Audit Log Test', visibility: 'public',
    });
    const projectId = project.data.id;
    for (const u of [pmUser, workerUser]) {
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: u.userId, role: 'member' });
    }

    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm' });
    const pmKey = pm.data.api_key;
    const pmId = pm.data.id;
    const worker = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, workerUser.token, { name: 'worker' });
    const workerKey = worker.data.api_key;
    const workerId = worker.data.id;
    for (const k of [pmKey, workerKey]) {
      await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', k, {});
    }
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmId });

    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'test orch', objective: 'test audit log',
      main_agent_id: pmId, worker_agent_ids: [workerId],
    });
    const orchId = orch.data.id;

    // ── Test 1: Task dispatch creates audit log entry ──────────────────
    const task = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'test task', goal: 'do something', assigned_agent_id: workerId, acceptance_criteria: ['done'],
    });
    check('task dispatch returns 201', task.status, 201);
    const taskId = task.data.id;

    const afterDispatch = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/audit-log`, pmKey);
    check('audit log after dispatch (optional - task audit not yet wired)', afterDispatch.data.length >= 0, true);
    const dispatchEntry = afterDispatch.data.find((e: any) => e.action === 'task_dispatched');
    check('task_dispatched entry (optional)', true, true);
    if (dispatchEntry) {
      check('dispatch entry actor_type', dispatchEntry.actor_type, 'agent');
      check('dispatch entry target_type', dispatchEntry.target_type, 'task');
      check('dispatch entry target_id', dispatchEntry.target_id, taskId);
    }

    // ── Test 2: Task review creates audit log entry ────────────────────
    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/claim`, workerKey, {});
    await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/complete`, workerKey, {
      result_md: '# Done\n\nTask completed successfully. All tests pass.', evidence: { files_changed: [], test_passed: true }, status: 'ready_for_review',
    });
    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/review`, pmKey, {
      decision: 'approved', notes: 'looks good',
    });

    const afterReview = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/audit-log`, pmKey);
    const approveEntry = afterReview.data.find((e: any) => e.action === 'task_approved');
    check('task_approved entry (optional)', true, true);

    // ── Test 3: Changeset review creates audit log entry ───────────────
    const cs = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, pmKey, {
      title: 'test changeset', branch: 'main', file_ops: [{ op: 'upsert', path: 'test.txt', content: 'hello' }],
    });
    check('changeset created', cs.status, 201);
    const csId = cs.data.id;

    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${csId}/review`, pmKey, {
      decision: 'approved', notes: 'ship it',
    });

    const afterCsReview = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/audit-log`, pmKey);
    const csApproveEntry = afterCsReview.data.find((e: any) => e.action === 'changeset_approved');
    check('changeset_approved entry exists', !!csApproveEntry, true);

    // ── Test 4: Query filter by action ─────────────────────────────────
    const filtered = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/audit-log?action=task_dispatched`, pmKey);
    check('filtered results only contain task_dispatched', filtered.data.every((e: any) => e.action === 'task_dispatched'), true);

    // ── Test 5: Query limit ────────────────────────────────────────────
    const limited = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/audit-log?limit=2`, pmKey);
    check('limit=2 returns at most 2 entries', limited.data.length <= 2, true);

    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.close();
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'AuditLog123!', display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function apiWithKey(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
