import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-dispatch-dedup-test-secret';
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
  const { ProjectOrchestrationTask } = await import('../src/entities');
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
      name: 'Dispatch Dedup Test', visibility: 'public',
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
    // pm is the project-level main agent (acts as PM across orchestrations).
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmId });

    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'dedup orch', objective: 'idempotent task dispatch',
      main_agent_id: pmId, worker_agent_ids: [w1Id, w2Id],
    });
    const orchId = orch.data.id;

    const TITLE = 'Build the widget';
    const GOAL = 'Implement the widget feature end to end with tests.';

    // ── (i) First dispatch creates the task ────────────────────────────────
    const first = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: TITLE, goal: GOAL, assigned_agent_id: w1Id,
    });
    check('(i) first dispatch → 201', first.status, 201);
    const firstTaskId = first.data.id;
    check('(i) first dispatch assigned to w1', first.data.assigned_agent_id, w1Id);

    // dedup_hash is stored on the task record as metadata.dedup_hash.
    const stored = await AppDataSource.getRepository(ProjectOrchestrationTask).findOne({ where: { id: firstTaskId } });
    const storedHash = (stored?.metadata as Record<string, unknown> | null | undefined)?.dedup_hash;
    check('(i) metadata.dedup_hash stored', typeof storedHash === 'string' && /^[a-f0-9]{64}$/.test(storedHash as string), true);

    // ── (ii) Duplicate dispatch → 409 with existing_task_id ────────────────
    const dup = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: TITLE, goal: GOAL, assigned_agent_id: w1Id,
    });
    check('(ii) duplicate dispatch → 409', dup.status, 409);
    check('(ii) 409 detail', dup.data.detail, 'duplicate active task');
    check('(ii) 409 points at existing task', dup.data.existing_task_id, firstTaskId);

    // Normalization: different casing + extra whitespace still matches the
    // same logical (title, goal) → same dedup_hash → 409.
    const normalizedDup = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: '  BUILD   the   widget  ',
      goal: '  Implement\tthe\nwidget   feature  end  to  end  WITH tests. ',
      assigned_agent_id: w1Id,
    });
    check('(ii) whitespace/case-normalized duplicate → 409', normalizedDup.status, 409);
    check('(ii) normalized dup points at existing task', normalizedDup.data.existing_task_id, firstTaskId);

    // Agent scoping: same title+goal but a DIFFERENT agent is allowed (the
    // dedup slot is per-agent).
    const otherAgent = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: TITLE, goal: GOAL, assigned_agent_id: w2Id,
    });
    check('(ii) same task for different agent → 201', otherAgent.status, 201);

    // Different goal → different dedup_hash → allowed.
    const otherGoal = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: TITLE, goal: 'A completely different goal description.', assigned_agent_id: w1Id,
    });
    check('(ii) different goal → 201', otherGoal.status, 201);

    // ── (iii) After the first task completes, same dispatch allowed again ──
    // Worker w1 completes the task → ready_for_review (no longer in an active
    // dedup status), which frees the slot.
    const complete = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${firstTaskId}/complete`, w1Key, {
      result_md: 'Implemented the widget feature with full unit test coverage and docs.',
      evidence: { files_changed: ['src/widget.ts'], test_passed: true },
      status: 'ready_for_review',
    });
    check('(iii) worker completes first task', complete.status, 200);
    check('(iii) first task → ready_for_review', complete.data.status, 'ready_for_review');

    const redispatch = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: TITLE, goal: GOAL, assigned_agent_id: w1Id,
    });
    check('(iii) re-dispatch after completion → 201', redispatch.status, 201);
    check('(iii) re-dispatch created a NEW task', redispatch.data.id !== firstTaskId, true);

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
    password: 'DedupDispatch123!', display_name: prefix,
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
