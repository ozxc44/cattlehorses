import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'agent-capabilities-test-secret';
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
    const owner = await register(baseUrl, 'capabilities-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Agent Capabilities Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const codeAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Agent Code',
      capabilities: ['code'],
    });
    assert.equal(codeAgent.status, 201);
    assert.deepEqual(codeAgent.data.capabilities, ['code']);

    const docsAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Agent Docs',
      capabilities: ['chat', 'docs'],
    });
    assert.equal(docsAgent.status, 201);
    assert.deepEqual(docsAgent.data.capabilities, ['chat', 'docs']);

    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', codeAgent.data.api_key, {});
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', docsAgent.data.api_key, {});

    const orchestration = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Capability Matching',
      objective: 'Verify task required capabilities select matching online workers.',
      worker_agent_ids: [codeAgent.data.id, docsAgent.data.id],
    });
    assert.equal(orchestration.status, 201);

    const docsTask = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`, owner.token, {
      title: 'Write docs',
      goal: 'Draft documentation.',
      required_capability: 'docs',
      dispatch: false,
    });
    assert.equal(docsTask.status, 201);
    assert.equal(docsTask.data.required_capability, 'docs');

    const docsCapable = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${docsTask.data.id}/capable-agents`,
      owner.token,
    );
    assert.equal(docsCapable.status, 200);
    assert.deepEqual(docsCapable.data.data.map((agent: any) => agent.id), [docsAgent.data.id]);

    const codeTask = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`, owner.token, {
      title: 'Implement code',
      goal: 'Make a code change.',
      required_capability: 'code',
      dispatch: false,
    });
    assert.equal(codeTask.status, 201);
    assert.equal(codeTask.data.required_capability, 'code');

    const codeCapable = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${codeTask.data.id}/capable-agents`,
      owner.token,
    );
    assert.equal(codeCapable.status, 200);
    assert.deepEqual(codeCapable.data.data.map((agent: any) => agent.id), [codeAgent.data.id]);

    const anyTask = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`, owner.token, {
      title: 'Any online worker',
      goal: 'No fine-grained capability required.',
      dispatch: false,
    });
    assert.equal(anyTask.status, 201);
    assert.equal(anyTask.data.required_capability, null);

    const anyCapable = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${anyTask.data.id}/capable-agents`,
      owner.token,
    );
    assert.equal(anyCapable.status, 200);
    assert.deepEqual(
      anyCapable.data.data.map((agent: any) => agent.id).sort(),
      [codeAgent.data.id, docsAgent.data.id].sort(),
    );
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
    password: 'AgentCapabilities123!',
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
