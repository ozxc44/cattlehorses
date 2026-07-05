/**
 * R33b: GET /agents/:aid/heartbeat-history — worker uptime tracking.
 *
 * Covers:
 *   (i)   heartbeat records are logged on each heartbeat
 *   (ii)  GET /v1/agents/:aid/heartbeat-history returns records
 *   (iii) limit query param works
 *   (iv)  sweep prunes old records beyond 1000
 */
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'heartbeat-history-test-secret';

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
    const owner = await register(baseUrl, 'hb-history-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Heartbeat History',
      description: 'R33b heartbeat log tests',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const agent = await createAgent(baseUrl, owner.token, projectId, 'HB Agent');

    // (i) Send several heartbeats and verify they get logged
    for (let i = 0; i < 5; i++) {
      const hb = await heartbeat(baseUrl, agent.apiKey, {
        status: 'healthy',
        health: { status: 'healthy' },
        latency_ms: 100 + i * 10,
      });
      assert.equal(hb.status, 200);
    }

    // (ii) GET heartbeat-history returns the records
    const history = await api(baseUrl, 'GET', `/v1/agents/${agent.id}/heartbeat-history`, owner.token);
    assert.equal(history.status, 200);
    assert.equal(history.data.agent_id, agent.id);
    assert.equal(history.data.data.length, 5, `expected 5 records, got ${history.data.data.length}`);

    // Verify record shape
    const first = history.data.data[0];
    assert.ok(first.timestamp, 'record should have timestamp');
    assert.ok(first.status, 'record should have status');
    assert.equal(typeof first.online, 'boolean', 'online should be boolean');
    // health_status may be null or string
    assert.ok('health_status' in first, 'record should have health_status');
    // response_time_ms may be null or number
    assert.ok('response_time_ms' in first, 'record should have response_time_ms');

    // Records are DESC ordered (newest first)
    const ts0 = new Date(history.data.data[0].timestamp).getTime();
    const ts4 = new Date(history.data.data[4].timestamp).getTime();
    assert.ok(ts0 >= ts4, 'records should be DESC ordered');

    // (iii) limit query param
    const limited = await api(baseUrl, 'GET', `/v1/agents/${agent.id}/heartbeat-history?limit=2`, owner.token);
    assert.equal(limited.status, 200);
    assert.equal(limited.data.data.length, 2, `expected 2 records with limit=2, got ${limited.data.data.length}`);
    assert.equal(limited.data.meta.limit, 2);

    // (iv) sweep prunes old records (insert 1005, expect only 1000 kept)
    const sweepAgent = await createAgent(baseUrl, owner.token, projectId, 'Sweep Agent');
    const { AgentHeartbeatLog } = await import('../src/entities/agent-heartbeat-log.entity');
    const logRepo = AppDataSource.getRepository(AgentHeartbeatLog);

    // Bulk insert 1005 records
    const now = Date.now();
    const bulkRecords = [];
    for (let i = 0; i < 1005; i++) {
      bulkRecords.push(
        logRepo.create({
          agentId: sweepAgent.id,
          status: 'healthy',
          healthStatus: 'healthy',
          responseTimeMs: 50,
          online: true,
        }),
      );
    }
    await logRepo.save(bulkRecords);

    const countBefore = await logRepo.count({ where: { agentId: sweepAgent.id } });
    assert.equal(countBefore, 1005, `expected 1005 before sweep, got ${countBefore}`);

    // Trigger a heartbeat which triggers the sweep
    const sweepHb = await heartbeat(baseUrl, sweepAgent.apiKey, {
      status: 'healthy',
      health: { status: 'healthy' },
    });
    assert.equal(sweepHb.status, 200);

    // Give sweep a moment to complete (it's fire-and-forget)
    await new Promise((r) => setTimeout(r, 500));

    const countAfter = await logRepo.count({ where: { agentId: sweepAgent.id } });
    assert.ok(countAfter <= 1001, `expected <= 1001 after sweep (1000 + 1 from this heartbeat), got ${countAfter}`);

    // GET respects max limit of 1000
    const bigLimit = await api(baseUrl, 'GET', `/v1/agents/${sweepAgent.id}/heartbeat-history?limit=2000`, owner.token);
    assert.equal(bigLimit.status, 200);
    assert.ok(bigLimit.data.data.length <= 1000, 'limit should be capped at 1000');

    // Non-owner with no project membership gets 403
    const other = await register(baseUrl, 'hb-other');
    const forbidden = await api(baseUrl, 'GET', `/v1/agents/${agent.id}/heartbeat-history`, other.token);
    assert.equal(forbidden.status, 403);

    // Agent not found returns 404
    const notFound = await api(baseUrl, 'GET', `/v1/agents/00000000-0000-0000-0000-000000000000/heartbeat-history`, owner.token);
    assert.equal(notFound.status, 404);

    console.log('heartbeat-history.test.ts: all assertions passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

interface AgentCreds {
  id: string;
  apiKey: string;
}

async function createAgent(
  baseUrl: string,
  token: string,
  projectId: string,
  name: string,
): Promise<AgentCreds> {
  const response = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, token, { name });
  assert.equal(response.status, 201);
  return { id: response.data.id, apiKey: response.data.api_key };
}

async function heartbeat(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  return apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, body);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'HeartbeatHistoryTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
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
