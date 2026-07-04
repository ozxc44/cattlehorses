/**
 * R10b: backend dispatch rejects unhealthy workers.
 *
 * Covers the three required cases for the dispatch health guard:
 *   (i)   dispatch ALLOWED when the worker last reported healthy,
 *   (ii)  dispatch BLOCKED with 409 when the worker last reported unhealthy,
 *   (iii) dispatch ALLOWED when no health field is present (legacy worker).
 *
 * Also exercises the reassign path (same shared guard) and the
 * GET /v1/agents/:aid/health smoke-test status surface.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'worker-health-dispatch-test-secret';

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
    const owner = await register(baseUrl, 'health-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Worker Health Dispatch',
      description: 'R10b dispatch health guard',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Main PM agent + one healthy worker so we can stand up an orchestration
    // (orchestration creation itself runs the dispatch guard on main + workers).
    const mainAgent = await createAgent(baseUrl, owner.token, projectId, 'PM Agent');
    const seedWorker = await createAgent(baseUrl, owner.token, projectId, 'Seed Worker');
    await heartbeat(baseUrl, mainAgent.apiKey, { health: { status: 'healthy' } });
    await heartbeat(baseUrl, seedWorker.apiKey, { health: { status: 'healthy' } });

    const orchestration = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations`,
      owner.token,
      {
        title: 'Health-Guarded Loop',
        objective: 'Prove dispatch respects worker smoke-test health.',
        main_agent_id: mainAgent.id,
        worker_agent_ids: [seedWorker.id],
      },
    );
    assert.equal(orchestration.status, 201);
    const orchestrationId = orchestration.data.id;

    // ------------------------------------------------------------------
    // (i) Dispatch ALLOWED when the worker last reported healthy.
    // ------------------------------------------------------------------
    const healthyWorker = await createAgent(baseUrl, owner.token, projectId, 'Healthy Worker');
    const healthyHb = await heartbeat(baseUrl, healthyWorker.apiKey, {
      status: 'healthy',
      health: { status: 'healthy' },
    });
    assert.equal(healthyHb.status, 200);
    assert.equal(healthyHb.data.is_online, true);

    const healthyDispatch = await dispatchTask(
      baseUrl,
      mainAgent.apiKey,
      projectId,
      orchestrationId,
      healthyWorker.id,
      'Healthy worker should receive the task',
    );
    assert.equal(healthyDispatch.status, 201, `healthy dispatch should succeed, got ${JSON.stringify(healthyDispatch.data)}`);
    assert.equal(healthyDispatch.data.assigned_agent_id, healthyWorker.id);

    const healthyStatus = await api(baseUrl, 'GET', `/v1/agents/${healthyWorker.id}/health`, owner.token);
    assert.equal(healthyStatus.status, 200);
    assert.equal(healthyStatus.data.smoke_test.status, 'healthy');
    assert.equal(healthyStatus.data.smoke_test.last_error, null);
    assert.ok(healthyStatus.data.smoke_test.checked_at, 'checked_at should be populated');

    // ------------------------------------------------------------------
    // (ii) Dispatch BLOCKED with 409 when the worker last reported unhealthy.
    //      The worker is ONLINE (fresh heartbeat) but its smoke test failed —
    //      online is no longer enough.
    // ------------------------------------------------------------------
    const unhealthyWorker = await createAgent(baseUrl, owner.token, projectId, 'Unhealthy Worker');
    const unhealthyHb = await heartbeat(baseUrl, unhealthyWorker.apiKey, {
      status: 'healthy', // process is alive & heartbeating...
      health: { status: 'unhealthy', error: 'smoke test: executor self-check failed' }, // ...but smoke failed
    });
    assert.equal(unhealthyHb.status, 200);
    assert.equal(unhealthyHb.data.is_online, true); // presence still says online
    assert.equal(unhealthyHb.data.dispatchable, true); // presence doesn't know about smoke health

    const unhealthyDispatch = await dispatchTask(
      baseUrl,
      mainAgent.apiKey,
      projectId,
      orchestrationId,
      unhealthyWorker.id,
      'Unhealthy worker must be rejected',
    );
    assert.equal(unhealthyDispatch.status, 409);
    assert.equal(unhealthyDispatch.data.code, 'AGENT_UNHEALTHY');
    assert.deepEqual(unhealthyDispatch.data.unhealthy_agent_ids, [unhealthyWorker.id]);
    assert.equal(
      unhealthyDispatch.data.unhealthy_agents[0].last_error,
      'smoke test: executor self-check failed',
    );

    const unhealthyStatus = await api(baseUrl, 'GET', `/v1/agents/${unhealthyWorker.id}/health`, owner.token);
    assert.equal(unhealthyStatus.status, 200);
    assert.equal(unhealthyStatus.data.smoke_test.status, 'unhealthy');
    assert.equal(unhealthyStatus.data.smoke_test.last_error, 'smoke test: executor self-check failed');

    // ------------------------------------------------------------------
    // (iii) Dispatch ALLOWED when no health field is present (legacy worker).
    // ------------------------------------------------------------------
    const legacyWorker = await createAgent(baseUrl, owner.token, projectId, 'Legacy Worker');
    const legacyHb = await heartbeat(baseUrl, legacyWorker.apiKey, {
      status: 'healthy',
      // intentionally NO `health` field — mimics a pre-R10b worker
    });
    assert.equal(legacyHb.status, 200);
    assert.equal(legacyHb.data.is_online, true);

    const legacyStatus = await api(baseUrl, 'GET', `/v1/agents/${legacyWorker.id}/health`, owner.token);
    assert.equal(legacyStatus.status, 200);
    assert.equal(legacyStatus.data.smoke_test.status, null, 'legacy worker has no smoke-test status');

    const legacyDispatch = await dispatchTask(
      baseUrl,
      mainAgent.apiKey,
      projectId,
      orchestrationId,
      legacyWorker.id,
      'Legacy worker should still be dispatchable',
    );
    assert.equal(legacyDispatch.status, 201, `legacy dispatch should succeed, got ${JSON.stringify(legacyDispatch.data)}`);
    assert.equal(legacyDispatch.data.assigned_agent_id, legacyWorker.id);

    // ------------------------------------------------------------------
    // Bonus: the reassign path shares the same guard — reassigning an
    // already-dispatched task to an unhealthy worker is also rejected 409.
    // ------------------------------------------------------------------
    const reassign = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${healthyDispatch.data.id}/reassign`,
      mainAgent.apiKey,
      { new_agent_id: unhealthyWorker.id, reason: 'trying to move to a sick worker' },
    );
    assert.equal(reassign.status, 409);
    assert.equal(reassign.data.code, 'AGENT_UNHEALTHY');

    console.log('worker-health-dispatch.test.ts: all assertions passed');
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

async function dispatchTask(
  baseUrl: string,
  mainAgentApiKey: string,
  projectId: string,
  orchestrationId: string,
  assignedAgentId: string,
  goal: string,
): Promise<{ status: number; data: any }> {
  return apiWithKey(
    baseUrl,
    'POST',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
    mainAgentApiKey,
    {
      title: goal,
      goal,
      assigned_agent_id: assignedAgentId,
    },
  );
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'WorkerHealthTest123!',
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
