import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'loop-status-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';
// Default 15-min stall threshold is fine; we seed a task dispatched 1h ago.
process.env.LOOP_STALL_MINUTES = '15';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { ProjectOrchestration, ProjectOrchestrationStatus } = await import(
    '../src/entities/project-orchestration.entity'
  );
  const {
    ProjectOrchestrationTask,
    ProjectOrchestrationTaskStatus,
  } = await import('../src/entities/project-orchestration-task.entity');
  const { ProjectChangeset, ProjectChangesetStatus } = await import(
    '../src/entities/project-changeset.entity'
  );

  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const owner = await register(baseUrl, 'loop-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Loop Status Test',
      description: 'Loop overview dashboard payload',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // ── Workers ─────────────────────────────────────────────────────────────
    const workerA = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker Online',
    });
    assert.equal(workerA.status, 201);
    const workerB = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker Offline',
    });
    assert.equal(workerB.status, 201);

    // Only workerA sends a heartbeat → online. workerB stays offline.
    await heartbeatAgent(baseUrl, workerA.data.api_key);

    // ── Orchestrations (one per bucket) ─────────────────────────────────────
    const orchRunning = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Running Orchestration',
      objective: 'In-flight orchestration.',
    });
    assert.equal(orchRunning.status, 201);
    const orchBlocked = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Blocked Orchestration',
      objective: 'Needs intervention.',
    });
    assert.equal(orchBlocked.status, 201);
    const orchCompleted = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Completed Orchestration',
      objective: 'Terminal.',
    });
    assert.equal(orchCompleted.status, 201);

    const orchRepo = AppDataSource.getRepository(ProjectOrchestration);
    await orchRepo.save([
      { id: orchRunning.data.id, status: ProjectOrchestrationStatus.RUNNING },
      { id: orchBlocked.data.id, status: ProjectOrchestrationStatus.BLOCKED },
      { id: orchCompleted.data.id, status: ProjectOrchestrationStatus.COMPLETED },
    ]);

    // ── Tasks (running, stalled, pending) ──────────────────────────────────
    const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
    const now = Date.now();
    const HOUR = 60 * 60_000;
    const runningTask = taskRepo.create({
      projectId,
      orchestrationId: orchRunning.data.id,
      title: 'Actively running task',
      goal: 'In progress, recent activity.',
      status: ProjectOrchestrationTaskStatus.RUNNING,
      workerTaskPath: `.agent/t/${orchRunning.data.id}/running.worker_task.md`,
      workerContextPath: `.agent/t/${orchRunning.data.id}/running.worker_context.md`,
      assignedAgentId: workerA.data.id,
      dispatchedAt: new Date(now - 60_000),
      claimedAt: new Date(now - 30_000),
    });
    const stalledTask = taskRepo.create({
      projectId,
      orchestrationId: orchRunning.data.id,
      title: 'Stalled dispatched task',
      goal: 'Dispatched long ago, never claimed.',
      status: ProjectOrchestrationTaskStatus.DISPATCHED,
      workerTaskPath: `.agent/t/${orchRunning.data.id}/stalled.worker_task.md`,
      workerContextPath: `.agent/t/${orchRunning.data.id}/stalled.worker_context.md`,
      assignedAgentId: workerB.data.id,
      dispatchedAt: new Date(now - HOUR), // 1h ago, well past the 15-min stall cutoff
    });
    const pendingTask = taskRepo.create({
      projectId,
      orchestrationId: orchRunning.data.id,
      title: 'Pending task',
      goal: 'Not yet dispatched.',
      status: ProjectOrchestrationTaskStatus.PENDING,
      workerTaskPath: `.agent/t/${orchRunning.data.id}/pending.worker_task.md`,
      workerContextPath: `.agent/t/${orchRunning.data.id}/pending.worker_context.md`,
    });
    await taskRepo.save([runningTask, stalledTask, pendingTask]);

    // ── Changesets (two pending, one terminal) ──────────────────────────────
    const branch = await api(baseUrl, 'GET', `/v1/projects/${projectId}/branches`, owner.token);
    assert.equal(branch.status, 200);
    assert.ok(branch.data.data.length > 0, 'project has a default branch');
    const branchId = branch.data.data[0].id;

    const csRepo = AppDataSource.getRepository(ProjectChangeset);
    const pendingCs1 = csRepo.create({
      projectId,
      branchId,
      title: 'Submitted changeset',
      status: ProjectChangesetStatus.SUBMITTED,
      fileOps: [],
      createdAt: new Date(now - 30 * 60_000),
      updatedAt: new Date(now - 30 * 60_000),
    });
    const pendingCs2 = csRepo.create({
      projectId,
      branchId,
      title: 'Ready-for-review changeset',
      status: ProjectChangesetStatus.READY_FOR_REVIEW,
      fileOps: [],
      createdAt: new Date(now - 5 * 60_000),
      updatedAt: new Date(now - 5 * 60_000),
    });
    const mergedCs = csRepo.create({
      projectId,
      branchId,
      title: 'Merged changeset (terminal)',
      status: ProjectChangesetStatus.MERGED,
      fileOps: [],
      createdAt: new Date(now - 120 * 60_000),
      updatedAt: new Date(now - 120 * 60_000),
    });
    await csRepo.save([pendingCs1, pendingCs2, mergedCs]);

    // ── Auth required (no credentials → 401) ───────────────────────────────
    const noAuth = await api(baseUrl, 'GET', `/v1/projects/${projectId}/loop-status`);
    assert.equal(noAuth.status, 401);

    // ── Owner JWT call ─────────────────────────────────────────────────────
    const res = await api(baseUrl, 'GET', `/v1/projects/${projectId}/loop-status`, owner.token);
    assert.equal(res.status, 200);
    const body = res.data;

    // ── Top-level shape ────────────────────────────────────────────────────
    assert.ok(Array.isArray(body.workers), 'workers is an array');
    assert.ok(Array.isArray(body.pending_changesets), 'pending_changesets is an array');
    assert.equal(typeof body.running_tasks, 'number');
    assert.ok(Array.isArray(body.stalled_tasks), 'stalled_tasks is an array');
    assert.ok(body.orchestrations && typeof body.orchestrations === 'object');

    // ── Workers: shape + presence ──────────────────────────────────────────
    assert.equal(body.workers.length, 2, 'both project agents appear');
    for (const w of body.workers) {
      assert.equal(typeof w.id, 'string');
      assert.equal(typeof w.name, 'string');
      assert.equal(typeof w.online, 'boolean');
      assert.equal(typeof w.health_status, 'string');
      assert.ok(w.last_heartbeat_age_seconds === null || typeof w.last_heartbeat_age_seconds === 'number');
    }
    const onlineWorker = body.workers.find((w: any) => w.id === workerA.data.id);
    const offlineWorker = body.workers.find((w: any) => w.id === workerB.data.id);
    assert.ok(onlineWorker, 'workerA present');
    assert.ok(offlineWorker, 'workerB present');
    assert.equal(onlineWorker.online, true, 'heartbeated worker is online');
    assert.equal(onlineWorker.health_status, 'healthy');
    assert.equal(typeof onlineWorker.last_heartbeat_age_seconds, 'number');
    assert.equal(offlineWorker.online, false, 'never-heartbeated worker is offline');
    assert.equal(offlineWorker.health_status, 'down');
    assert.equal(offlineWorker.last_heartbeat_age_seconds, null);

    // ── Orchestration counts match seeded data ─────────────────────────────
    assert.equal(body.orchestrations.running, 1, 'one running orchestration');
    assert.equal(body.orchestrations.blocked, 1, 'one blocked orchestration');
    assert.equal(body.orchestrations.completed, 1, 'one completed orchestration');

    // ── Running task count matches seeded data ─────────────────────────────
    assert.equal(body.running_tasks, 1, 'exactly one RUNNING task');

    // ── Stalled tasks: only the stale dispatched task ──────────────────────
    assert.equal(body.stalled_tasks.length, 1, 'only the stale task is stalled');
    const stalled = body.stalled_tasks[0];
    assert.equal(stalled.id, stalledTask.id);
    assert.equal(stalled.title, 'Stalled dispatched task');
    assert.equal(stalled.status, 'dispatched');
    assert.equal(typeof stalled.age_minutes, 'number');
    assert.ok(stalled.age_minutes >= 50 && stalled.age_minutes <= 70, `stalled age ~60min, got ${stalled.age_minutes}`);

    // ── Pending changesets: terminal (merged) excluded ─────────────────────
    assert.equal(body.pending_changesets.length, 2, 'two non-terminal changesets');
    const csIds = new Set(body.pending_changesets.map((c: any) => c.id));
    assert.equal(csIds.has(pendingCs1.id), true);
    assert.equal(csIds.has(pendingCs2.id), true);
    assert.equal(csIds.has(mergedCs.id), false, 'merged changeset is excluded');
    for (const c of body.pending_changesets) {
      assert.equal(typeof c.id, 'string');
      assert.equal(typeof c.title, 'string');
      assert.equal(typeof c.status, 'string');
      assert.equal(typeof c.age_minutes, 'number');
    }
    const cs1Row = body.pending_changesets.find((c: any) => c.id === pendingCs1.id);
    assert.ok(cs1Row.age_minutes >= 25 && cs1Row.age_minutes <= 35, `changeset age ~30min, got ${cs1Row.age_minutes}`);

    // ── Agent API key (ViewProject) also works ─────────────────────────────
    const agentRes = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/loop-status`, workerA.data.api_key);
    assert.equal(agentRes.status, 200);
    assert.equal(agentRes.data.orchestrations.running, 1);

    // ── Wrong project is rejected (agent belongs to a different project) ───
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, { name: 'Other Project' });
    assert.equal(otherProject.status, 201);
    const wrongProject = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${otherProject.data.id}/loop-status`,
      workerA.data.api_key,
    );
    assert.equal(wrongProject.status, 403, 'agent cannot view another project');

    console.log('loop-status tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email,
    password: 'LoopStatus123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    metrics: { load: 0 },
  });
  assert.equal(response.status, 200);
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
  return parseResponse(response);
}

async function apiWithKey(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response);
}

async function parseResponse(response: Response): Promise<{ status: number; data: any }> {
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
