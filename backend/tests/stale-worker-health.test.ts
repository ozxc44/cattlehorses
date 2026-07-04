/**
 * R15a: stale heartbeat auto-marks a worker unhealthy + notifies the PM.
 *
 * Covers the three required cases for the stale-heartbeat sweep:
 *   (i)   fresh heartbeat  → worker stays healthy (sweep marks nothing),
 *   (ii)  stale heartbeat  → worker marked unhealthy + PM inbox notified,
 *   (iii) dispatch blocked (409) after the worker goes stale/unhealthy.
 *
 * Also exercises sweep idempotency (no re-notify on the second tick) and
 * proves the persisted 'heartbeat stale' mark — not just the live presence
 * calc — is what blocks dispatch via the R10b guard.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'stale-worker-health-test-secret';
// Default AGENT_ONLINE_TTL_MS (90s) is used; the stale fixture rewinds the
// heartbeat to 120s ago so it is unambiguously past the TTL.

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { Agent } = await import('../src/entities/agent.entity');
  const { AgentInboxItem } = await import('../src/entities/agent-inbox-item.entity');
  const { healthMonitorService, stopStaleHeartbeatSweep } = await import('../src/services/health-monitor.service');

  await AppDataSource.initialize();
  // Disable the periodic timer so only our explicit sweepStaleHeartbeats() calls
  // run — otherwise the 60s interval could race ahead and pre-mark the fixture.
  stopStaleHeartbeatSweep();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const agentRepo = AppDataSource.getRepository(Agent);
  const inboxRepo = AppDataSource.getRepository(AgentInboxItem);

  try {
    // ── Scaffold: owner, project with a PM, a healthy seed worker, orchestration.
    const owner = await register(baseUrl, 'stale-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Stale Worker Health',
      description: 'R15a stale-heartbeat sweep',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const pm = await createAgent(baseUrl, owner.token, projectId, 'PM Agent');
    const seedWorker = await createAgent(baseUrl, owner.token, projectId, 'Seed Worker');
    await heartbeat(baseUrl, pm.apiKey, { status: 'healthy', health: { status: 'healthy' } });
    await heartbeat(baseUrl, seedWorker.apiKey, { status: 'healthy', health: { status: 'healthy' } });

    // Designate the PM as the project's main agent (the inbox recipient).
    const setPm = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      main_agent_id: pm.id,
    });
    assert.equal(setPm.status, 200);

    const orchestration = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations`,
      owner.token,
      {
        title: 'Stale-Heartbeat Loop',
        objective: 'Prove stale heartbeats are marked unhealthy and blocked.',
        main_agent_id: pm.id,
        worker_agent_ids: [seedWorker.id],
      },
    );
    assert.equal(orchestration.status, 201);
    const orchestrationId = orchestration.data.id;

    // ------------------------------------------------------------------
    // (i) Fresh heartbeat → sweep marks nothing, worker stays healthy.
    // ------------------------------------------------------------------
    const freshWorker = await createAgent(baseUrl, owner.token, projectId, 'Fresh Worker');
    const freshHb = await heartbeat(baseUrl, freshWorker.apiKey, {
      status: 'healthy',
      health: { status: 'healthy' },
    });
    assert.equal(freshHb.status, 200);

    const freshSweep = await healthMonitorService.sweepStaleHeartbeats();
    assert.equal(freshSweep.marked, 0, 'fresh worker must not be marked stale');

    const freshRow = await agentRepo.findOneBy({ id: freshWorker.id });
    assert.notEqual(freshRow!.healthStatus, 'unhealthy', 'fresh worker must stay healthy');

    const freshHealth = await api(baseUrl, 'GET', `/v1/agents/${freshWorker.id}/health`, owner.token);
    assert.equal(freshHealth.status, 200);
    assert.notEqual(freshHealth.data.smoke_test.status, 'unhealthy');

    // ------------------------------------------------------------------
    // (ii) Stale heartbeat → marked unhealthy + PM inbox notified.
    // ------------------------------------------------------------------
    const staleWorker = await createAgent(baseUrl, owner.token, projectId, 'Stale Worker');
    // Starts healthy (fresh heartbeat + healthy smoke test)…
    const staleHb = await heartbeat(baseUrl, staleWorker.apiKey, {
      status: 'healthy',
      health: { status: 'healthy' },
    });
    assert.equal(staleHb.status, 200);
    const healthyRow = await agentRepo.findOneBy({ id: staleWorker.id });
    assert.equal(healthyRow!.healthStatus, 'healthy', 'worker starts healthy before going silent');
    // …then goes silent: rewind lastHeartbeatAt to 120s ago (past the 90s TTL).
    await agentRepo.update(staleWorker.id, { lastHeartbeatAt: new Date(Date.now() - 120_000) });

    const staleSweep = await healthMonitorService.sweepStaleHeartbeats();
    assert.equal(staleSweep.marked, 1, 'stale worker must be marked');

    const staleRow = await agentRepo.findOneBy({ id: staleWorker.id });
    assert.equal(staleRow!.healthStatus, 'unhealthy');
    assert.equal(staleRow!.healthLastError, 'heartbeat stale');

    // The health endpoint surfaces the persisted reason.
    const staleHealth = await api(baseUrl, 'GET', `/v1/agents/${staleWorker.id}/health`, owner.token);
    assert.equal(staleHealth.status, 200);
    assert.equal(staleHealth.data.smoke_test.status, 'unhealthy');
    assert.equal(staleHealth.data.smoke_test.last_error, 'heartbeat stale');

    // PM was notified which worker went stale.
    const pmInbox = await inboxRepo.find({
      where: { recipientAgentId: pm.id, eventType: 'worker_stale' },
    });
    assert.equal(pmInbox.length, 1, 'PM should receive exactly one worker_stale inbox item');
    assert.ok(pmInbox[0].title.includes('Stale Worker'), 'inbox title should name the stale worker');

    // Idempotent: a second tick marks nothing new and doesn't re-notify.
    const idleSweep = await healthMonitorService.sweepStaleHeartbeats();
    assert.equal(idleSweep.marked, 0, 'already-flagged worker must not be re-marked');
    const pmInboxCount = await inboxRepo.count({
      where: { recipientAgentId: pm.id, eventType: 'worker_stale' },
    });
    assert.equal(pmInboxCount, 1, 'PM must not be re-notified on the second tick');

    // ------------------------------------------------------------------
    // (iii) Dispatch blocked (409) after the worker went stale/unhealthy.
    // ------------------------------------------------------------------
    const blockedDispatch = await dispatchTask(
      baseUrl,
      pm.apiKey,
      projectId,
      orchestrationId,
      staleWorker.id,
      'Stale worker must not receive new work',
    );
    assert.equal(blockedDispatch.status, 409, 'dispatch to a stale/unhealthy worker must be blocked');

    // Even if the worker's heartbeat momentarily freshens (presence=online),
    // the persisted 'heartbeat stale' unhealthy mark still blocks dispatch via
    // the R10b guard until the worker reports a healthy smoke test. This proves
    // the sweep's marking — not just the live presence calc — blocks the worker.
    await agentRepo.update(staleWorker.id, { lastHeartbeatAt: new Date() });
    const stillBlocked = await dispatchTask(
      baseUrl,
      pm.apiKey,
      projectId,
      orchestrationId,
      staleWorker.id,
      'Still-unhealthy worker must stay blocked',
    );
    assert.equal(stillBlocked.status, 409);
    assert.equal(stillBlocked.data.code, 'AGENT_UNHEALTHY');
    assert.deepEqual(stillBlocked.data.unhealthy_agent_ids, [staleWorker.id]);
    assert.equal(stillBlocked.data.unhealthy_agents[0].last_error, 'heartbeat stale');

    // Contrast: a fresh, healthy worker is still dispatchable.
    const okDispatch = await dispatchTask(
      baseUrl,
      pm.apiKey,
      projectId,
      orchestrationId,
      freshWorker.id,
      'Fresh worker should receive the task',
    );
    assert.equal(okDispatch.status, 201, 'dispatch to a fresh healthy worker should succeed');

    console.log('stale-worker-health.test.ts: all assertions passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
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
    password: 'StaleWorkerHealth123!',
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
