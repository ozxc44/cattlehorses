import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-parallel-dag-test-secret';
// Keep heartbeats fresh for the whole test run so presence is deterministic.
process.env.AGENT_ONLINE_TTL_MS = '300000';

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
    const owner = await register(baseUrl, 'pdag');
    const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Parallel DAG');

    // ── Register 3 healthy workers with distinct capabilities ────────────────
    const backendWorker = await createWorker(baseUrl, owner.token, projectId, 'BackendWorker', ['backend']);
    const pythonWorker = await createWorker(baseUrl, owner.token, projectId, 'PythonWorker', ['python']);
    const docsWorker = await createWorker(baseUrl, owner.token, projectId, 'DocsWorker', ['docs']);
    await heartbeat(baseUrl, backendWorker.apiKey, 'healthy');
    await heartbeat(baseUrl, pythonWorker.apiKey, 'healthy');
    await heartbeat(baseUrl, docsWorker.apiKey, 'healthy');

    const workers = new Map<string, { id: string; apiKey: string; name: string }>([
      [backendWorker.name, backendWorker],
      [pythonWorker.name, pythonWorker],
      [docsWorker.name, docsWorker],
    ]);

    // ── Create 5 tasks in a DAG ──────────────────────────────────────────────
    // task1: no deps
    // task2 + task3: depend on task1, different capabilities
    // task4: depends on task2
    // task5: depends on task3 + task4
    const task1 = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
      title: 'task1',
      goal: 'Root task with no dependencies.',
      dispatch: false,
    });
    const task2 = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
      title: 'task2',
      goal: 'Backend work that depends on task1.',
      depends_on: [task1.id],
      required_capability: 'backend',
      dispatch: false,
    });
    const task3 = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
      title: 'task3',
      goal: 'Python work that depends on task1.',
      depends_on: [task1.id],
      required_capability: 'python',
      dispatch: false,
    });
    const task4 = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
      title: 'task4',
      goal: 'Docs work that depends on task2.',
      depends_on: [task2.id],
      required_capability: 'docs',
      dispatch: false,
    });
    const task5 = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
      title: 'task5',
      goal: 'Final integration task that depends on task3 and task4.',
      depends_on: [task3.id, task4.id],
      dispatch: false,
    });

    // ── Step 1: dispatch-ready → only task1 is ready ─────────────────────────
    const dispatch1 = await dispatchReady(baseUrl, owner.token, projectId, orchestrationId);
    assert.equal(dispatch1.status, 200, `step 1 status: ${JSON.stringify(dispatch1.data)}`);
    assert.equal(dispatch1.data.dispatched.length, 1, 'only task1 should be dispatched');
    assert.equal(dispatch1.data.dispatched[0].task_id, task1.id, 'task1 is dispatched');
    assert.equal(dispatch1.data.dispatched[0].agent_name, backendWorker.name, 'task1 goes to best/least-loaded worker');
    assert.equal(dispatch1.data.skipped.length, 4, 'task2-task5 are skipped');
    for (const s of dispatch1.data.skipped) {
      assert.equal(s.reason, 'dependencies_not_met', 'downstream tasks are dependency-gated');
    }

    // ── Step 2: complete + approve task1 ─────────────────────────────────────
    await workerComplete(
      baseUrl,
      workers.get(dispatch1.data.dispatched[0].agent_name)!.apiKey,
      projectId,
      orchestrationId,
      task1.id,
      'task1 result: root task completed successfully.',
    );
    await reviewTask(baseUrl, owner.token, projectId, orchestrationId, task1.id, 'approved');

    // ── Step 3: dispatch-ready → task2 + task3 in parallel ───────────────────
    const dispatch2 = await dispatchReady(baseUrl, owner.token, projectId, orchestrationId);
    assert.equal(dispatch2.status, 200, `step 3 status: ${JSON.stringify(dispatch2.data)}`);
    assert.equal(dispatch2.data.dispatched.length, 2, 'task2 and task3 are dispatched in parallel');
    const dispatchedIds2 = dispatch2.data.dispatched.map((d: any) => d.task_id).sort();
    assert.deepEqual(dispatchedIds2, [task2.id, task3.id].sort(), 'dispatched tasks are task2 and task3');

    const task2Dispatch = dispatch2.data.dispatched.find((d: any) => d.task_id === task2.id);
    const task3Dispatch = dispatch2.data.dispatched.find((d: any) => d.task_id === task3.id);
    assert.equal(task2Dispatch.agent_name, backendWorker.name, 'task2 routed to backend worker');
    assert.equal(task3Dispatch.agent_name, pythonWorker.name, 'task3 routed to python worker');

    assert.equal(dispatch2.data.skipped.length, 2, 'task4 and task5 are still blocked');
    const skippedIds2 = dispatch2.data.skipped.map((s: any) => s.task_id).sort();
    assert.deepEqual(skippedIds2, [task4.id, task5.id].sort(), 'task4 and task5 skipped');
    for (const s of dispatch2.data.skipped) {
      assert.equal(s.reason, 'dependencies_not_met', 'task4/task5 still have unmet deps');
    }

    // ── Step 4: complete + approve task2 and task3 ───────────────────────────
    await workerComplete(
      baseUrl,
      workers.get(task2Dispatch.agent_name)!.apiKey,
      projectId,
      orchestrationId,
      task2.id,
      'task2 result: backend work completed.',
    );
    await reviewTask(baseUrl, owner.token, projectId, orchestrationId, task2.id, 'approved');

    await workerComplete(
      baseUrl,
      workers.get(task3Dispatch.agent_name)!.apiKey,
      projectId,
      orchestrationId,
      task3.id,
      'task3 result: python work completed.',
    );
    await reviewTask(baseUrl, owner.token, projectId, orchestrationId, task3.id, 'approved');

    // ── Step 5: dispatch-ready → task4 unblocked ─────────────────────────────
    const dispatch3 = await dispatchReady(baseUrl, owner.token, projectId, orchestrationId);
    assert.equal(dispatch3.status, 200, `step 5 status: ${JSON.stringify(dispatch3.data)}`);
    assert.equal(dispatch3.data.dispatched.length, 1, 'task4 is dispatched');
    assert.equal(dispatch3.data.dispatched[0].task_id, task4.id, 'dispatched task is task4');
    assert.equal(dispatch3.data.dispatched[0].agent_name, docsWorker.name, 'task4 routed to docs worker');
    assert.equal(dispatch3.data.skipped.length, 1, 'task5 still blocked');
    assert.equal(dispatch3.data.skipped[0].task_id, task5.id);
    assert.equal(dispatch3.data.skipped[0].reason, 'dependencies_not_met');

    // ── Step 6: complete + approve task4 ─────────────────────────────────────
    await workerComplete(
      baseUrl,
      workers.get(dispatch3.data.dispatched[0].agent_name)!.apiKey,
      projectId,
      orchestrationId,
      task4.id,
      'task4 result: docs work completed.',
    );
    await reviewTask(baseUrl, owner.token, projectId, orchestrationId, task4.id, 'approved');

    // ── Step 7: dispatch-ready → task5 unblocked ─────────────────────────────
    const dispatch4 = await dispatchReady(baseUrl, owner.token, projectId, orchestrationId);
    assert.equal(dispatch4.status, 200, `step 7 status: ${JSON.stringify(dispatch4.data)}`);
    assert.equal(dispatch4.data.dispatched.length, 1, 'task5 is dispatched');
    assert.equal(dispatch4.data.dispatched[0].task_id, task5.id, 'dispatched task is task5');
    assert.ok(
      [backendWorker.name, pythonWorker.name, docsWorker.name].includes(dispatch4.data.dispatched[0].agent_name),
      'task5 dispatched to an available worker',
    );
    assert.equal(dispatch4.data.skipped.length, 0, 'no tasks remain skipped');

    // ── Step 8: complete + approve task5 ─────────────────────────────────────
    await workerComplete(
      baseUrl,
      workers.get(dispatch4.data.dispatched[0].agent_name)!.apiKey,
      projectId,
      orchestrationId,
      task5.id,
      'task5 result: final integration completed.',
    );
    await reviewTask(baseUrl, owner.token, projectId, orchestrationId, task5.id, 'approved');

    // ── Step 9: complete orchestration ───────────────────────────────────────
    const completeOrch = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/complete`,
      owner.token,
      { summary: 'All DAG tasks approved.' },
    );
    assert.equal(completeOrch.status, 200, `complete orchestration status: ${JSON.stringify(completeOrch.data)}`);
    assert.equal(completeOrch.data.status, 'completed', 'orchestration is completed');

    // Verify all tasks are approved via orchestration fetch.
    const finalOrch = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}`,
      owner.token,
    );
    assert.equal(finalOrch.status, 200);
    assert.equal(finalOrch.data.status, 'completed');
    const statuses = finalOrch.data.tasks.map((t: any) => t.status);
    assert.equal(statuses.length, 5, 'all 5 tasks present');
    assert.ok(statuses.every((s: string) => s === 'approved'), 'every task is approved');

    console.log('integration-parallel-dag tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function setup(
  baseUrl: string,
  token: string,
  label: string,
): Promise<{ projectId: string; orchestrationId: string }> {
  const project = await api(baseUrl, 'POST', '/v1/projects', token, {
    name: `Integration Parallel DAG ${label}`,
    description: 'multi-worker parallel DAG dispatch integration test',
  });
  assert.equal(project.status, 201);
  const projectId = project.data.id;
  const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, token, {
    title: `Integration Parallel DAG ${label}`,
    objective: 'Validate full DAG parallel dispatch path across multiple workers.',
  });
  assert.equal(orch.status, 201);
  return { projectId, orchestrationId: orch.data.id };
}

async function createWorker(
  baseUrl: string,
  token: string,
  projectId: string,
  name: string,
  capabilities: string[],
): Promise<{ id: string; apiKey: string; name: string }> {
  const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, token, { name, capabilities });
  assert.equal(res.status, 201);
  return { id: res.data.id, apiKey: res.data.api_key, name };
}

async function createTask(
  baseUrl: string,
  token: string,
  projectId: string,
  orchestrationId: string,
  body: {
    title: string;
    goal: string;
    depends_on?: string[];
    required_capability?: string;
    dispatch?: boolean;
  },
): Promise<{ id: string; status: string }> {
  const res = await api(
    baseUrl,
    'POST',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
    token,
    body,
  );
  assert.equal(res.status, 201, `createTask ${body.title} failed: ${JSON.stringify(res.data)}`);
  return { id: res.data.id, status: res.data.status };
}

async function dispatchReady(
  baseUrl: string,
  token: string,
  projectId: string,
  orchestrationId: string,
): Promise<{ status: number; data: any }> {
  return api(
    baseUrl,
    'POST',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/dispatch-ready`,
    token,
    {},
  );
}

async function workerComplete(
  baseUrl: string,
  apiKey: string,
  projectId: string,
  orchestrationId: string,
  taskId: string,
  resultMd: string,
): Promise<void> {
  // Claim first so the worker is recorded as engaged.
  const claim = await apiWithKey(
    baseUrl,
    'PATCH',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/claim`,
    apiKey,
  );
  assert.equal(claim.status, 200, `claim ${taskId} failed: ${JSON.stringify(claim.data)}`);

  const complete = await apiWithKey(
    baseUrl,
    'POST',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/complete`,
    apiKey,
    {
      result_md: `# Result\n\n${resultMd}`,
      evidence: { files_changed: [`deliverables/${taskId}.md`], test_passed: true },
      status: 'ready_for_review',
    },
  );
  assert.equal(complete.status, 200, `complete ${taskId} failed: ${JSON.stringify(complete.data)}`);
  assert.equal(complete.data.status, 'ready_for_review');
}

async function reviewTask(
  baseUrl: string,
  token: string,
  projectId: string,
  orchestrationId: string,
  taskId: string,
  decision: 'approved' | 'changes_requested',
): Promise<void> {
  const res = await api(
    baseUrl,
    'PATCH',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/review`,
    token,
    { decision, notes: `${decision} by integration test.` },
  );
  assert.equal(res.status, 200, `review ${taskId} failed: ${JSON.stringify(res.data)}`);
  assert.equal(res.data.status, decision === 'approved' ? 'approved' : 'changes_requested');
}

async function heartbeat(baseUrl: string, apiKey: string, smoke: 'healthy' | 'unhealthy'): Promise<void> {
  const res = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    health: { status: smoke },
  });
  assert.equal(res.status, 200);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email,
    password: 'ParallelDag123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response);
}

async function apiWithKey(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response);
}

async function parseResponse(response: Response): Promise<{ status: number; data: any }> {
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
