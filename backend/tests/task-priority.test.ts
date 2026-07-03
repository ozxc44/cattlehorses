import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-priority-test-secret';
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
    const owner = await register(baseUrl, 'priority-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Task Priority Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Priority Main',
    });
    assert.equal(mainAgent.status, 201);
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Priority Worker',
    });
    assert.equal(workerAgent.status, 201);

    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', mainAgent.data.api_key, {});
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', workerAgent.data.api_key, {});

    const orchestration = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Priority Orchestration',
      objective: 'Verify priority-based worker task ordering.',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id],
    });
    assert.equal(orchestration.status, 201);

    const taskA = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'taskA',
        goal: 'lower priority task',
        assigned_agent_id: workerAgent.data.id,
        priority: 1,
      },
    );
    assert.equal(taskA.status, 201);
    assert.equal(taskA.data.priority, 1);

    const taskB = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'taskB',
        goal: 'higher priority task',
        assigned_agent_id: workerAgent.data.id,
        priority: 5,
      },
    );
    assert.equal(taskB.status, 201);
    assert.equal(taskB.data.priority, 5);

    const assigned = await apiWithKey(baseUrl, 'GET', '/v1/agent/assigned-tasks', workerAgent.data.api_key);
    assert.equal(assigned.status, 200);
    const tasks = assigned.data.data;
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, taskB.data.id);
    assert.equal(tasks[0].priority, 5);
    assert.equal(tasks[1].id, taskA.data.id);
    assert.equal(tasks[1].priority, 1);
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
    password: 'TaskPriority123!',
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
