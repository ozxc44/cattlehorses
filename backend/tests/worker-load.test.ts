import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'worker-load-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { Agent } = await import('../src/entities/agent.entity');
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
    const owner = await register(baseUrl, 'worker-load-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Worker Load Test',
      description: 'Per-worker load dashboard payload',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // ── Workers ─────────────────────────────────────────────────────────────
    const workerA = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker A',
    });
    assert.equal(workerA.status, 201);
    const workerB = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker B',
    });
    assert.equal(workerB.status, 201);
    const workerC = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker C',
    });
    assert.equal(workerC.status, 201);

    // workerA is online and healthy; workerB is offline; workerC is online with custom capacity.
    await heartbeatAgent(baseUrl, workerA.data.api_key);
    await heartbeatAgent(baseUrl, workerC.data.api_key);

    // Give workerC a higher max_concurrent capacity via config_json.
    const agentRepo = AppDataSource.getRepository(Agent);
    const workerCRecord = await agentRepo.findOne({ where: { id: workerC.data.id } });
    assert.ok(workerCRecord);
    workerCRecord.configJson = {
      ...(workerCRecord.configJson || {}),
      max_concurrent: 6,
    };
    await agentRepo.save(workerCRecord);

    // ── Orchestration ───────────────────────────────────────────────────────
    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Load Test Orchestration',
      objective: 'Exercise worker-load counts.',
    });
    assert.equal(orch.status, 201);

    const now = Date.now();
    const HOUR = 60 * 60_000;
    const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
    const runningTaskA = taskRepo.create({
      projectId,
      orchestrationId: orch.data.id,
      title: 'Running task A',
      goal: 'Worker A is running this.',
      status: ProjectOrchestrationTaskStatus.RUNNING,
      workerTaskPath: `.agent/t/${orch.data.id}/a.worker_task.md`,
      workerContextPath: `.agent/t/${orch.data.id}/a.worker_context.md`,
      assignedAgentId: workerA.data.id,
      dispatchedAt: new Date(now - 60_000),
      claimedAt: new Date(now - 30_000),
    });
    const runningTaskA2 = taskRepo.create({
      projectId,
      orchestrationId: orch.data.id,
      title: 'Running task A2',
      goal: 'Worker A is running this too.',
      status: ProjectOrchestrationTaskStatus.RUNNING,
      workerTaskPath: `.agent/t/${orch.data.id}/a2.worker_task.md`,
      workerContextPath: `.agent/t/${orch.data.id}/a2.worker_context.md`,
      assignedAgentId: workerA.data.id,
      dispatchedAt: new Date(now - 60_000),
      claimedAt: new Date(now - 30_000),
    });
    const runningTaskC = taskRepo.create({
      projectId,
      orchestrationId: orch.data.id,
      title: 'Running task C',
      goal: 'Worker C is running this.',
      status: ProjectOrchestrationTaskStatus.RUNNING,
      workerTaskPath: `.agent/t/${orch.data.id}/c.worker_task.md`,
      workerContextPath: `.agent/t/${orch.data.id}/c.worker_context.md`,
      assignedAgentId: workerC.data.id,
      dispatchedAt: new Date(now - 60_000),
      claimedAt: new Date(now - 30_000),
    });
    const completedTaskA = taskRepo.create({
      projectId,
      orchestrationId: orch.data.id,
      title: 'Completed task A',
      goal: 'Worker A completed this recently.',
      status: ProjectOrchestrationTaskStatus.APPROVED,
      workerTaskPath: `.agent/t/${orch.data.id}/done.worker_task.md`,
      workerContextPath: `.agent/t/${orch.data.id}/done.worker_context.md`,
      assignedAgentId: workerA.data.id,
      dispatchedAt: new Date(now - HOUR),
      claimedAt: new Date(now - HOUR + 60_000),
      completedAt: new Date(now - 5 * 60_000),
    });
    const olderCompletedTaskA = taskRepo.create({
      projectId,
      orchestrationId: orch.data.id,
      title: 'Older completed task A',
      goal: 'Worker A completed this earlier.',
      status: ProjectOrchestrationTaskStatus.APPROVED,
      workerTaskPath: `.agent/t/${orch.data.id}/old.worker_task.md`,
      workerContextPath: `.agent/t/${orch.data.id}/old.worker_context.md`,
      assignedAgentId: workerA.data.id,
      dispatchedAt: new Date(now - 2 * HOUR),
      claimedAt: new Date(now - 2 * HOUR + 60_000),
      completedAt: new Date(now - 30 * 60_000),
    });
    const pendingTask = taskRepo.create({
      projectId,
      orchestrationId: orch.data.id,
      title: 'Pending task',
      goal: 'Not yet assigned.',
      status: ProjectOrchestrationTaskStatus.PENDING,
      workerTaskPath: `.agent/t/${orch.data.id}/pending.worker_task.md`,
      workerContextPath: `.agent/t/${orch.data.id}/pending.worker_context.md`,
    });
    await taskRepo.save([
      runningTaskA,
      runningTaskA2,
      runningTaskC,
      completedTaskA,
      olderCompletedTaskA,
      pendingTask,
    ]);

    // ── Changesets ──────────────────────────────────────────────────────────
    const branch = await api(baseUrl, 'GET', `/v1/projects/${projectId}/branches`, owner.token);
    assert.equal(branch.status, 200);
    assert.ok(branch.data.data.length > 0, 'project has a default branch');
    const branchId = branch.data.data[0].id;

    const csRepo = AppDataSource.getRepository(ProjectChangeset);
    const pendingCsA = csRepo.create({
      projectId,
      branchId,
      title: 'Pending changeset A',
      status: ProjectChangesetStatus.SUBMITTED,
      fileOps: [],
      createdByAgentId: workerA.data.id,
    });
    const pendingCsA2 = csRepo.create({
      projectId,
      branchId,
      title: 'Pending changeset A2',
      status: ProjectChangesetStatus.READY_FOR_REVIEW,
      fileOps: [],
      createdByAgentId: workerA.data.id,
    });
    const mergedCsA = csRepo.create({
      projectId,
      branchId,
      title: 'Merged changeset A',
      status: ProjectChangesetStatus.MERGED,
      fileOps: [],
      createdByAgentId: workerA.data.id,
    });
    const pendingCsB = csRepo.create({
      projectId,
      branchId,
      title: 'Pending changeset B',
      status: ProjectChangesetStatus.SUBMITTED,
      fileOps: [],
      createdByAgentId: workerB.data.id,
    });
    await csRepo.save([pendingCsA, pendingCsA2, mergedCsA, pendingCsB]);

    // ── Auth required (no credentials → 401) ────────────────────────────────
    const noAuth = await api(baseUrl, 'GET', `/v1/projects/${projectId}/worker-load`);
    assert.equal(noAuth.status, 401);

    // ── Owner JWT call ─────────────────────────────────────────────────────
    const res = await api(baseUrl, 'GET', `/v1/projects/${projectId}/worker-load`, owner.token);
    assert.equal(res.status, 200);
    const body = res.data;
    assert.ok(Array.isArray(body.data), 'data is an array');
    assert.equal(body.data.length, 3, 'one row per project agent');

    // ── Shape ───────────────────────────────────────────────────────────────
    for (const w of body.data) {
      assert.equal(typeof w.agent_id, 'string');
      assert.equal(typeof w.agent_name, 'string');
      assert.equal(typeof w.online, 'boolean');
      assert.equal(typeof w.health_status, 'string');
      assert.equal(typeof w.running_tasks, 'number');
      assert.equal(typeof w.pending_changesets, 'number');
      assert.ok(w.last_task_completed_at === null || typeof w.last_task_completed_at === 'string');
      assert.equal(typeof w.utilization_score, 'number');
    }

    // ── Counts and utilization ─────────────────────────────────────────────
    const rowA = body.data.find((w: any) => w.agent_id === workerA.data.id);
    const rowB = body.data.find((w: any) => w.agent_id === workerB.data.id);
    const rowC = body.data.find((w: any) => w.agent_id === workerC.data.id);
    assert.ok(rowA);
    assert.ok(rowB);
    assert.ok(rowC);

    assert.equal(rowA.online, true);
    assert.equal(rowA.health_status, 'healthy');
    assert.equal(rowA.running_tasks, 2, 'worker A has two running tasks');
    assert.equal(rowA.pending_changesets, 2, 'worker A has two pending changesets');
    assert.equal(rowA.last_task_completed_at, completedTaskA.completedAt?.toISOString());
    assert.equal(rowA.utilization_score, 0.67, '2 / default 3 rounded to 2 decimals');

    assert.equal(rowB.online, false);
    assert.equal(rowB.health_status, 'down');
    assert.equal(rowB.running_tasks, 0);
    assert.equal(rowB.pending_changesets, 1);
    assert.equal(rowB.last_task_completed_at, null);
    assert.equal(rowB.utilization_score, 0);

    assert.equal(rowC.online, true);
    assert.equal(rowC.running_tasks, 1);
    assert.equal(rowC.pending_changesets, 0);
    assert.equal(rowC.last_task_completed_at, null);
    assert.equal(rowC.utilization_score, 0.17, '1 / custom 6 rounded to 2 decimals');

    // ── Agent API key (ViewProject) also works ─────────────────────────────
    const agentRes = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/worker-load`, workerA.data.api_key);
    assert.equal(agentRes.status, 200);
    assert.equal(agentRes.data.data.length, 3);

    // ── Wrong project is rejected ──────────────────────────────────────────
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, { name: 'Other Project' });
    assert.equal(otherProject.status, 201);
    const wrongProject = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${otherProject.data.id}/worker-load`,
      workerA.data.api_key,
    );
    assert.equal(wrongProject.status, 403, 'agent cannot view another project');

    console.log('worker-load tests passed');
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
    password: 'WorkerLoad123!',
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
