import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'main-agent-rbac-test-secret';
// Force agents online (fresh heartbeat) for dispatch checks.
process.env.AGENT_ONLINE_TTL_MS = '90000';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { Agent, AgentStatus, AgentLifecycleStatus, AgentRuntime } = await import('../src/entities/agent.entity');
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // ── Setup: owner, project-level main agent (pm), worker agent (worker),
    //    and a SEPARATE orchestration-level main agent (orchPm) to prove both
    //    identities work. ─────────────────────────────────────────────────
    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');      // owner of the project-level main agent
    const workerUser = await register(baseUrl, 'wk');  // owner of a worker agent

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Main Agent RBAC Test',
      description: 'Project-level main agent PM privileges',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    // Add pm + worker as members so they can register agents + heartbeat.
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: pmUser.userId, role: 'member' });
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: workerUser.userId, role: 'member' });

    const pmAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, {
      name: 'project-pm', description: 'project-level main agent',
    });
    const pmAgentId = pmAgent.data.id;
    const pmKey = pmAgent.data.api_key;

    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, workerUser.token, {
      name: 'worker-01', description: 'a worker',
    });
    const workerId = workerAgent.data.id;
    const workerKey = workerAgent.data.api_key;

    // Heartbeat both so they are dispatchable.
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', pmKey, {});
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', workerKey, {});

    // ── 1. Promote pmAgent to PROJECT-LEVEL main agent via owner JWT ──────
    const setMain = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmAgentId });
    check('set project-level main agent', setMain.status, 200);
    check('project.main_agent_id persisted', setMain.data.main_agent_id, pmAgentId);

    // ── 2. Promotion inbox notification delivered to the promoted agent ──
    const pmInbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox?unread=true', pmKey);
    const promo = (pmInbox.data.data || []).find((i: any) => i.event_type === 'promoted_to_main_agent');
    check('promotion inbox delivered', !!promo, true);

    // ── 3. pmAgent (project-level, NOT orchestration main) can create an
    //    orchestration. When an agent creates one it becomes that orchestration's
    //    main agent — but here we also create one via owner JWT with pmAgent as
    //    a worker, then prove pmAgent still passes the PM gate via project-level
    //    identity. ─────────────────────────────────────────────────────────
    // Create an orchestration owned (orchestration-main) by the WORKER, so we
    // can prove pmAgent's project-level role overrides the orchestration-level one.
    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'PM RBAC orch',
      objective: 'prove project-level main agent PM powers',
      main_agent_id: workerId,   // worker is the orchestration-level main
      worker_agent_ids: [workerId],
    });
    check('create orchestration (orch-main = worker)', orch.status, 201);
    const orchId = orch.data.id;

    // ── 4. pmAgent (project-level main) can DISPATCH a task even though the
    //    orchestration's main_agent_id is the worker. This is the core RBAC win. ─
    const dispatchByPm = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'task from project-pm',
      goal: 'should succeed because pm is project-level main',
      assigned_agent_id: workerId,
      acceptance_criteria: ['done'],
    });
    check('project-level main agent dispatches task (was 403 before fix)', dispatchByPm.status, 201);
    const taskId = dispatchByPm.data.id;

    // ── 5. A random non-main agent CANNOT dispatch ───────────────────────
    const strangerUser = await register(baseUrl, 'stranger');
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: strangerUser.userId, role: 'member' });
    const strangerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, strangerUser.token, { name: 'stranger-agent' });
    const strangerKey = strangerAgent.data.api_key;
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', strangerKey, {});

    const dispatchByStranger = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, strangerKey, {
      title: 'should be denied', goal: 'no PM role', assigned_agent_id: workerId, acceptance_criteria: ['x'],
    });
    check('non-main agent denied dispatch', dispatchByStranger.status, 403);

    // ── 6. worker completes the task, then project-pm can REVIEW it ──────
    const completeByWorker = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/complete`, workerKey, {
    result_md: '# Done\nwork complete', evidence: { files_changed: ['rbac.md'], ok: true }, status: 'ready_for_review',
    });
    check('worker completes task', completeByWorker.status, 200);

    const reviewByPm = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/review`, pmKey, {
      decision: 'approved', notes: 'lgtm',
    });
    check('project-level main agent reviews task (orch-main is worker)', reviewByPm.status, 200);
    check('review approved', reviewByPm.data.status, 'approved');

    // ── 7. Unsetting main_agent_id revokes PM powers ─────────────────────
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: null });
    const dispatchAfterRevoke = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'after revoke', goal: 'should fail now', assigned_agent_id: workerId, acceptance_criteria: ['x'],
    });
    check('revoked project-main agent denied dispatch', dispatchAfterRevoke.status, 403);

    // ── Summary ───────────────────────────────────────────────────────────
    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exit(1);
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
    password: 'MainAgentRbac123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(
  baseUrl: string, method: string, path: string, token?: string, body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function apiWithKey(
  baseUrl: string, method: string, path: string, apiKey: string, body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

main().catch((err) => { console.error(err); process.exit(1); });
