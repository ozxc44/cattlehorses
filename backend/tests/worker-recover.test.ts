/**
 * R29b: POST /v1/agents/:aid/recover — reset worker to healthy.
 *
 * Covers:
 *   (i)   recover clears unhealthy status → dispatchable again
 *   (ii)  recover sets health fields to null/now correctly
 *   (iii) agent heartbeat is sent on behalf (lastHeartbeatAt refreshed)
 *   (iv)  recovered agent can receive dispatched tasks
 *   (v)   404 for non-existent agent
 *   (vi)  agent API key cannot call recover (user-only)
 */
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'worker-recover-test-secret';

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
    const owner = await register(baseUrl, 'recover-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Worker Recover',
      description: 'R29b recover endpoint',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Main PM agent for dispatch tests
    const pm = await createAgent(baseUrl, owner.token, projectId, 'PM Agent');
    await heartbeat(baseUrl, pm.apiKey, { status: 'healthy', health: { status: 'healthy' } });

    // ------------------------------------------------------------------
    // (i) Recover clears unhealthy status → dispatchable again.
    // ------------------------------------------------------------------
    const unhealthyWorker = await createAgent(baseUrl, owner.token, projectId, 'Unhealthy Worker');
    // Mark the worker as unhealthy.
    await heartbeat(baseUrl, unhealthyWorker.apiKey, {
      status: 'healthy',
      health: { status: 'unhealthy', error: 'smoke test: connection refused' },
    });

    const unhealthyHealth = await api(baseUrl, 'GET', `/v1/agents/${unhealthyWorker.id}/health`, owner.token);
    assert.equal(unhealthyHealth.status, 200);
    assert.equal(unhealthyHealth.data.smoke_test.status, 'unhealthy');
    assert.equal(unhealthyHealth.data.smoke_test.last_error, 'smoke test: connection refused');

    // Recover the worker.
    const recoverRes = await api(baseUrl, 'POST', `/v1/agents/${unhealthyWorker.id}/recover`, owner.token);
    assert.equal(recoverRes.status, 200);

    // ------------------------------------------------------------------
    // (ii) Health fields are correctly reset.
    // ------------------------------------------------------------------
    // health_status in serializeAgent comes from presence (heartbeat age),
    // not the smoke-test healthStatus. Smoke-test fields are exposed via
    // GET /v1/agents/:aid/health → smoke_test.*.
    assert.equal(recoverRes.data.is_online, true, 'agent must be online after recover');
    assert.equal(recoverRes.data.dispatchable, true, 'agent must be dispatchable after recover');

    const recoveredHealth = await api(baseUrl, 'GET', `/v1/agents/${unhealthyWorker.id}/health`, owner.token);
    assert.equal(recoveredHealth.status, 200);
    assert.equal(recoveredHealth.data.smoke_test.status, null, 'smoke_test.status must be null after recover');
    assert.equal(recoveredHealth.data.smoke_test.last_error, null, 'smoke_test.last_error must be null after recover');
    assert.ok(recoveredHealth.data.smoke_test.checked_at, 'checked_at must be populated after recover');

    // ------------------------------------------------------------------
    // (iii) Agent heartbeat is sent on behalf (lastHeartbeatAt refreshed).
    // ------------------------------------------------------------------
    assert.ok(recoveredHealth.data.last_heartbeat_at, 'last_heartbeat_at must be set after recover');
    assert.ok(recoveredHealth.data.heartbeat_age_ms !== null, 'heartbeat_age_ms must be set');
    assert.ok(recoveredHealth.data.heartbeat_age_ms < 5000, 'heartbeat must be fresh (< 5s)');

    // ------------------------------------------------------------------
    // (iv) Recovered agent can receive dispatched tasks.
    // ------------------------------------------------------------------
    const orchestration = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations`,
      owner.token,
      {
        title: 'Recover Loop',
        objective: 'Prove recovered workers can be dispatched.',
        main_agent_id: pm.id,
        worker_agent_ids: [unhealthyWorker.id],
      },
    );
    assert.equal(orchestration.status, 201);

    const dispatch = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`,
      pm.apiKey,
      {
        title: 'Task for recovered worker',
        goal: 'Task for recovered worker',
        assigned_agent_id: unhealthyWorker.id,
      },
    );
    assert.equal(dispatch.status, 201, `dispatch to recovered worker should succeed, got ${JSON.stringify(dispatch.data)}`);
    assert.equal(dispatch.data.assigned_agent_id, unhealthyWorker.id);

    // ------------------------------------------------------------------
    // (v) 404 for non-existent agent.
    // ------------------------------------------------------------------
    const notFound = await api(
      baseUrl,
      'POST',
      '/v1/agents/00000000-0000-0000-0000-000000000000/recover',
      owner.token,
    );
    assert.equal(notFound.status, 404);

    // ------------------------------------------------------------------
    // (vi) Agent API key cannot call recover (user-only).
    //      The route uses `authenticate` (JWT-only), so an agent key
    //      sent via X-API-Key gets rejected with 401 (no Authorization).
    // ------------------------------------------------------------------
    const agentAuth = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/agents/${unhealthyWorker.id}/recover`,
      unhealthyWorker.apiKey,
    );
    assert.equal(agentAuth.status, 401, `agent key should be rejected, got ${agentAuth.status}`);

    // ------------------------------------------------------------------
    // Bonus: recover is idempotent — recovering an already-healthy agent
    // succeeds and leaves health fields in the same null/now state.
    // ------------------------------------------------------------------
    const idempotentRes = await api(baseUrl, 'POST', `/v1/agents/${unhealthyWorker.id}/recover`, owner.token);
    assert.equal(idempotentRes.status, 200);
    assert.equal(idempotentRes.data.dispatchable, true);

    console.log('worker-recover.test.ts: all assertions passed');
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
    password: 'WorkerRecoverTest123!',
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
