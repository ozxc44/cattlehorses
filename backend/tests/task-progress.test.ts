import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-progress-test-secret';
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
    const owner = await register(baseUrl, 'progress-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Task Progress Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Progress Main',
    });
    assert.equal(mainAgent.status, 201);
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Progress Worker',
    });
    assert.equal(workerAgent.status, 201);
    const otherAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Progress Other',
    });
    assert.equal(otherAgent.status, 201);

    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);
    await heartbeatAgent(baseUrl, otherAgent.data.api_key);

    const orchestration = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Progress Orchestration',
      objective: 'Verify workers can report progress.',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id, otherAgent.data.id],
    });
    assert.equal(orchestration.status, 201);
    const orchestrationId = orchestration.data.id;

    const task = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Progress task',
        goal: 'Report halfway progress.',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(task.status, 201);

    const claim = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${task.data.id}/claim`,
      workerAgent.data.api_key,
    );
    assert.equal(claim.status, 200);
    assert.equal(claim.data.status, 'running');

    const progress = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${task.data.id}/progress`,
      workerAgent.data.api_key,
      { progress_percent: 50, progress_note: 'half done' },
    );
    assert.equal(progress.status, 200);
    assert.equal(progress.data.progress_percent, 50);
    assert.equal(progress.data.progress_note, 'half done');
    assert.equal(typeof progress.data.progress_at, 'string');

    const fetched = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${task.data.id}`,
      owner.token,
    );
    assert.equal(fetched.status, 200);
    assert.equal(fetched.data.progress_percent, 50);
    assert.equal(fetched.data.progress_note, 'half done');
    assert.equal(typeof fetched.data.progress_at, 'string');
    assert.ok(Date.parse(fetched.data.progress_at) > 0);

    const wrongAgent = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${task.data.id}/progress`,
      otherAgent.data.api_key,
      { progress_percent: 75, progress_note: 'wrong worker' },
    );
    assert.equal(wrongAgent.status, 403);

    console.log('task-progress tests passed');
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
    password: 'TaskProgress123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function heartbeatAgent(baseUrl: string, key: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', key, { status: 'healthy' });
  assert.equal(response.status, 200);
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
