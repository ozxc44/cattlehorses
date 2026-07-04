import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-dependency-gating-test-secret';

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
    const owner = await register(baseUrl, 'dependency-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Task Dependency Gating',
      description: 'Verify depends_on blocks task claims until dependencies are approved.',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Dependency Main Agent',
    });
    assert.equal(mainAgent.status, 201);
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Dependency Worker Agent',
    });
    assert.equal(workerAgent.status, 201);

    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);

    const orchestration = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations`,
      mainAgent.data.api_key,
      {
        title: 'Dependency Gate',
        objective: 'Task B must wait until Task A is approved.',
        main_agent_id: mainAgent.data.id,
        worker_agent_ids: [workerAgent.data.id],
      },
    );
    assert.equal(orchestration.status, 201);
    const orchestrationId = orchestration.data.id;

    const taskA = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Task A',
        goal: 'Dependency prerequisite.',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(taskA.status, 201);
    assert.equal(taskA.data.status, 'dispatched');

    const taskB = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Task B',
        goal: 'Depends on Task A approval.',
        assigned_agent_id: workerAgent.data.id,
        depends_on: [taskA.data.id],
      },
    );
    assert.equal(taskB.status, 201);
    assert.deepEqual(taskB.data.depends_on, [taskA.data.id]);

    const blockedClaim = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskB.data.id}/claim`,
      workerAgent.data.api_key,
    );
    assert.equal(blockedClaim.status, 409);
    assert.equal(blockedClaim.data.code, 'DEPENDENCIES_NOT_MET');
    assert.equal(blockedClaim.data.detail, 'Task has unmet dependencies');
    assert.deepEqual(blockedClaim.data.unmet, [
      { id: taskA.data.id, status: 'dispatched', title: 'Task A' },
    ]);

    const claimA = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskA.data.id}/claim`,
      workerAgent.data.api_key,
    );
    assert.equal(claimA.status, 200);
    assert.equal(claimA.data.status, 'running');

    const completeA = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskA.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nTask A is complete.',
        evidence: { files_changed: ['task-a.md'], dependency: 'satisfied' },
      },
    );
    assert.equal(completeA.status, 200);
    assert.equal(completeA.data.status, 'ready_for_review');

    const approveA = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskA.data.id}/review`,
      mainAgent.data.api_key,
      { decision: 'approved', auto_merge: false, notes: 'Task A accepted.' },
    );
    assert.equal(approveA.status, 200);
    assert.equal(approveA.data.status, 'approved');

    const claimBAfterApproval = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskB.data.id}/claim`,
      workerAgent.data.api_key,
    );
    assert.equal(claimBAfterApproval.status, 200);
    assert.equal(claimBAfterApproval.data.status, 'running');

    const taskC = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Task C',
        goal: 'Empty depends_on claims normally.',
        assigned_agent_id: workerAgent.data.id,
        depends_on: [],
      },
    );
    assert.equal(taskC.status, 201);
    assert.deepEqual(taskC.data.depends_on, []);

    const claimC = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskC.data.id}/claim`,
      workerAgent.data.api_key,
    );
    assert.equal(claimC.status, 200);
    assert.equal(claimC.data.status, 'running');

    console.log('task dependency gating tests passed');
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
    password: 'DependencyTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    metrics: { load: 0 },
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.equal(response.data.dispatchable, true);
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
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
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
