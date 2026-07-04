import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'agent-capabilities-crud-test-secret';

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
    // Setup: register user, create project, create agent
    const owner = await register(baseUrl, 'caps-crud');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Capabilities CRUD Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const agentRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker Agent',
      capabilities: ['code'],
    });
    assert.equal(agentRes.status, 201);
    const agentId = agentRes.data.id;
    const agentKey = agentRes.data.api_key;

    // (i) Add capability
    const addRes = await api(baseUrl, 'PATCH', `/v1/agents/${agentId}/capabilities`, owner.token, {
      add: ['review'],
    });
    assert.equal(addRes.status, 200);
    assert.deepEqual(addRes.data.capabilities.sort(), ['code', 'review']);

    // (ii) Remove capability
    const removeRes = await api(baseUrl, 'PATCH', `/v1/agents/${agentId}/capabilities`, owner.token, {
      remove: ['code'],
    });
    assert.equal(removeRes.status, 200);
    assert.deepEqual(removeRes.data.capabilities, ['review']);

    // (iii) Idempotent add — adding existing capability is a no-op
    const idempotentRes = await api(baseUrl, 'PATCH', `/v1/agents/${agentId}/capabilities`, owner.token, {
      add: ['review'],
    });
    assert.equal(idempotentRes.status, 200);
    assert.deepEqual(idempotentRes.data.capabilities, ['review']);

    // (iv) Auth required — unauthenticated request should fail
    const noAuthRes = await api(baseUrl, 'PATCH', `/v1/agents/${agentId}/capabilities`);
    assert.equal(noAuthRes.status, 401);

    // Agent can modify its own capabilities via API key
    const selfRes = await apiWithKey(baseUrl, 'PATCH', `/v1/agents/${agentId}/capabilities`, agentKey, {
      add: ['deploy'],
    });
    assert.equal(selfRes.status, 200);
    assert.deepEqual(selfRes.data.capabilities.sort(), ['deploy', 'review']);

    console.log('All agent-capabilities-crud tests passed.');
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
    password: 'AgentCapsCrud123!',
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
