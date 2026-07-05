import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'detect-capabilities-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

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
    const owner = await register(baseUrl, 'detect-caps');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Detect Capabilities Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Main PM Agent',
    });
    assert.equal(mainAgent.status, 201);
    const mainAgentKey = mainAgent.data.api_key;

    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker Agent',
      capabilities: ['code'],
    });
    assert.equal(workerAgent.status, 201);
    const workerAgentId = workerAgent.data.id;
    const workerAgentKey = workerAgent.data.api_key;

    await heartbeatAgent(baseUrl, mainAgentKey);
    await heartbeatAgent(baseUrl, workerAgentKey);

    const orchRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Detect Test Orchestration',
      objective: 'Test capability detection',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgentId],
    });
    assert.equal(orchRes.status, 201);
    const orchId = orchRes.data.id;

    const task1 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, mainAgentKey, {
      title: 'Implement backend feature',
      goal: 'Add a new backend endpoint in TypeScript',
      assigned_agent_id: workerAgentId,
    });
    assert.equal(task1.status, 201);
    assert.equal(task1.data.status, 'dispatched');

    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${task1.data.id}/claim`, workerAgentKey);
    const complete1 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${task1.data.id}/complete`, workerAgentKey, {
      result_md: '# Result\n\nImplemented the backend feature successfully. All tests pass and the endpoint works correctly.',
      evidence: { files_changed: ['src/routes/users.ts'] },
    });
    assert.equal(complete1.status, 200);
    const approve1 = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${task1.data.id}/review`, mainAgentKey, {
      decision: 'approved',
      notes: 'Good work.',
    });
    assert.equal(approve1.status, 200);
    assert.equal(approve1.data.status, 'approved');

    const task2 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, mainAgentKey, {
      title: 'Write documentation',
      goal: 'Draft the README docs for the project',
      assigned_agent_id: workerAgentId,
    });
    assert.equal(task2.status, 201);

    await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${task2.data.id}/claim`, workerAgentKey);
    const complete2 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${task2.data.id}/complete`, workerAgentKey, {
      result_md: '# Result\n\nDocumentation has been written and reviewed. README is complete with all sections.',
      evidence: { files_changed: ['README.md'] },
    });
    assert.equal(complete2.status, 200);
    const approve2 = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${task2.data.id}/review`, mainAgentKey, {
      decision: 'approved',
    });
    assert.equal(approve2.status, 200);

    const detectRes = await api(baseUrl, 'POST', `/v1/agents/${workerAgentId}/detect-capabilities`, owner.token);
    assert.equal(detectRes.status, 200);
    assert.equal(detectRes.data.agent_id, workerAgentId);
    assert.ok(Array.isArray(detectRes.data.suggested_capabilities));
    assert.ok(detectRes.data.analysis.total_completed_tasks >= 2);
    assert.ok(Array.isArray(detectRes.data.current_capabilities));

    const caps = detectRes.data.suggested_capabilities as Array<{
      capability: string;
      confidence: number;
      evidence: { files_modified: number; tasks_completed: number };
    }>;

    const docsCap = caps.find((c) => c.capability === 'docs');
    assert.ok(docsCap, 'Should detect docs capability from task goal keywords');
    assert.ok(docsCap.confidence > 0, 'Docs confidence should be positive');
    assert.ok(docsCap.evidence.tasks_completed >= 1, 'Should count docs tasks');

    for (const cap of caps) {
      assert.ok(typeof cap.capability === 'string');
      assert.ok(typeof cap.confidence === 'number');
      assert.ok(cap.confidence >= 0 && cap.confidence <= 1);
      assert.ok(typeof cap.evidence.files_modified === 'number');
      assert.ok(typeof cap.evidence.tasks_completed === 'number');
    }

    const selfDetect = await apiWithKey(baseUrl, 'POST', `/v1/agents/${workerAgentId}/detect-capabilities`, workerAgentKey);
    assert.equal(selfDetect.status, 200);

    const noAuthRes = await api(baseUrl, 'POST', `/v1/agents/${workerAgentId}/detect-capabilities`);
    assert.equal(noAuthRes.status, 401);

    const otherAgentRes = await apiWithKey(baseUrl, 'POST', `/v1/agents/${workerAgentId}/detect-capabilities`, mainAgentKey);
    assert.equal(otherAgentRes.status, 403);

    const notFoundRes = await api(baseUrl, 'POST', '/v1/agents/00000000-0000-0000-0000-000000000000/detect-capabilities', owner.token);
    assert.equal(notFoundRes.status, 404);

    console.log('All detect-capabilities tests passed.');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const res = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, { status: 'active' });
  assert.equal(res.status, 200);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'DetectCapabilities123!',
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
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
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
