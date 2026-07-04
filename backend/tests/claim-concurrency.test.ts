import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'claim-concurrency-test-secret';
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
  const { ProjectOrchestrationTask, ProjectOrchestrationTaskStatus } = await import('../src/entities');
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
    const w1User = await register(baseUrl, 'w1');
    const w2User = await register(baseUrl, 'w2');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Claim Concurrency Test', visibility: 'public',
    });
    const projectId = project.data.id;
    for (const u of [pmUser, w1User, w2User]) {
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: u.userId, role: 'member' });
    }

    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm' });
    const pmKey = pm.data.api_key;
    const pmId = pm.data.id;
    const w1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, w1User.token, { name: 'w1' });
    const w1Key = w1.data.api_key;
    const w1Id = w1.data.id;
    const w2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, w2User.token, { name: 'w2' });
    const w2Key = w2.data.api_key;
    const w2Id = w2.data.id;
    for (const k of [pmKey, w1Key, w2Key]) {
      await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', k, {});
    }
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmId });

    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'claim concurrency orch', objective: 'test concurrent claim safety',
      main_agent_id: pmId, worker_agent_ids: [w1Id, w2Id],
    });
    const orchId = orch.data.id;

    // ── (i) Two workers race to claim the same unassigned task ──────────────
    // Create task without assigned_agent_id so both workers pass the auth check.
    const dispatched = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'Race task', goal: 'Two workers will try to claim this simultaneously.',
    });
    check('(i) task created → 201', dispatched.status, 201);
    const taskId = dispatched.data.id;

    // Fire both claims concurrently.
    const [resA, resB] = await Promise.all([
      apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/claim`, w1Key),
      apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/claim`, w2Key),
    ]);

    const winner = resA.status === 200 ? resA : resB;
    const loser = resA.status === 200 ? resB : resA;
    check('(i) exactly one claim succeeds (200)', winner.status, 200);
    check('(i) winner task status is running', winner.data.status, 'running');
    // On Postgres (true concurrency) the loser gets 409 from the FOR UPDATE
    // serialized claim.  On SQLite (serial) the loser may get 403 from the
    // auth guard since the task is already assigned when the second request
    // reads it.  Both are valid "losing" outcomes.
    const loserIs409 = loser.status === 409;
    const loserIs403 = loser.status === 403;
    check('(i) loser gets 409 or 403', loserIs409 || loserIs403, true);

    // Verify DB state: task is running, assigned to one of the workers.
    const dbTask = await AppDataSource.getRepository(ProjectOrchestrationTask).findOne({ where: { id: taskId } });
    assert(dbTask);
    check('(i) DB task status is running', dbTask.status, ProjectOrchestrationTaskStatus.RUNNING);
    check('(i) DB task assigned to winner agent', [w1Id, w2Id].includes(dbTask.assignedAgentId!), true);
    check('(i) claimedAt is set', dbTask.claimedAt instanceof Date, true);

    // ── (ii) Re-claim by same worker is idempotent (200) ───────────────────
    const reClaim = await apiWithKey(
      baseUrl, 'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/claim`,
      dbTask.assignedAgentId === w1Id ? w1Key : w2Key,
    );
    check('(ii) re-claim by winner → 200', reClaim.status, 200);
    check('(ii) re-claim returns running', reClaim.data.status, 'running');

    // ── (iii) Re-claim by the loser → 409 ──────────────────────────────────
    const loserKey = dbTask.assignedAgentId === w1Id ? w2Key : w1Key;
    const loserReClaim = await apiWithKey(
      baseUrl, 'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/claim`,
      loserKey,
    );
    check('(iii) loser re-claim → 403', loserReClaim.status, 403);

    // ── (iv) Claim a completed task by the same worker after re-dispatch ────
    // Complete the current task first.
    const winnerKey = dbTask.assignedAgentId === w1Id ? w1Key : w2Key;
    await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/complete`,
      winnerKey,
      { result_md: 'Done.', status: 'ready_for_review' },
    );

    // Dispatch a new task to w2 and claim it.
    const task2 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'Solo task', goal: 'Only w2 should claim.', assigned_agent_id: w2Id,
    });
    const task2Id = task2.data.id;
    const claim2 = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${task2Id}/claim`, w2Key);
    check('(iv) solo claim → 200', claim2.status, 200);
    check('(iv) solo claim status is running', claim2.data.status, 'running');

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
    password: 'ClaimConcurrency123!', display_name: prefix,
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

main().catch((err) => { console.error(err); process.exit(1); });
