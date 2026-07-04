import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-retry-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { AgentInboxItem } = await import('../src/entities/agent-inbox-item.entity');
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const owner = await register(baseUrl, 'retry-owner');
    const pmUser = await register(baseUrl, 'retry-pm');
    const workerUser = await register(baseUrl, 'retry-worker');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Task Retry Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    for (const user of [pmUser, workerUser]) {
      const member = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
        user_id: user.userId,
        role: 'member',
      });
      assert.equal(member.status, 201);
    }

    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'retry-pm' });
    assert.equal(pm.status, 201);
    const worker = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, workerUser.token, { name: 'retry-worker' });
    assert.equal(worker.status, 201);

    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', pm.data.api_key, {});
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', worker.data.api_key, {});

    const projectPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      main_agent_id: pm.data.id,
    });
    assert.equal(projectPatch.status, 200);

    const orchestration = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, pm.data.api_key, {
      title: 'Retry orchestration',
      objective: 'Verify task auto retry on worker failure.',
      main_agent_id: pm.data.id,
      worker_agent_ids: [worker.data.id],
    });
    assert.equal(orchestration.status, 201);
    const orchestrationId = orchestration.data.id;

    const task = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
      pm.data.api_key,
      {
        title: 'Retryable task',
        goal: 'Fail twice before final failure.',
        assigned_agent_id: worker.data.id,
        max_retries: 2,
      },
    );
    assert.equal(task.status, 201);
    assert.equal(task.data.status, 'dispatched');
    assert.equal(task.data.retry_count, 0);
    assert.equal(task.data.max_retries, 2);
    const taskId = task.data.id;

    const first = await completeFailed(baseUrl, projectId, orchestrationId, taskId, worker.data.api_key, 1);
    assert.equal(first.status, 200);
    assert.equal(first.data.status, 'dispatched');
    assert.equal(first.data.retry_count, 1);
    assert.equal(first.data.max_retries, 2);

    const second = await completeFailed(baseUrl, projectId, orchestrationId, taskId, worker.data.api_key, 2);
    assert.equal(second.status, 200);
    assert.equal(second.data.status, 'dispatched');
    assert.equal(second.data.retry_count, 2);
    assert.equal(second.data.max_retries, 2);

    const third = await completeFailed(baseUrl, projectId, orchestrationId, taskId, worker.data.api_key, 3);
    assert.equal(third.status, 200);
    assert.equal(third.data.status, 'failed');
    assert.equal(third.data.retry_count, 2);
    assert.equal(third.data.max_retries, 2);

    const inboxRows = await AppDataSource.getRepository(AgentInboxItem).find({
      where: {
        projectId,
        recipientAgentId: worker.data.id,
        taskId,
        eventType: 'task_dispatched',
      },
      order: { createdAt: 'ASC' },
    });
    assert.equal(inboxRows.length, 3, 'initial dispatch plus two retry dispatch inbox items');
    assert.equal(inboxRows.some((item) => item.payload?.retry_count === 1), true);
    assert.equal(inboxRows.some((item) => item.payload?.retry_count === 2), true);

    const refreshedTask = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}`, owner.token);
    assert.equal(refreshedTask.status, 200);
    assert.equal(refreshedTask.data.status, 'failed');
    assert.equal(refreshedTask.data.retry_count, 2);

    console.log('task-retry tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function completeFailed(
  baseUrl: string,
  projectId: string,
  orchestrationId: string,
  taskId: string,
  apiKey: string,
  attempt: number,
) {
  return apiWithKey(
    baseUrl,
    'POST',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/complete`,
    apiKey,
    {
      result_md: `# Failed attempt ${attempt}\n\nThe worker reports a reproducible failure for retry coverage.`,
      evidence: { files_changed: [], attempt, ok: false },
      status: 'failed',
    },
  );
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'TaskRetry123!',
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
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
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
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
