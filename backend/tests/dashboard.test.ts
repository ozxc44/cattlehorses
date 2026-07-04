import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'dashboard-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';
// Default 15-min stall threshold is fine; we seed one task dispatched 1h ago.
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
    const owner = await register(baseUrl, 'dashboard-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Dashboard Aggregation Test',
      description: 'Single-call dashboard payload',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // ── Workers (one online, one offline) ───────────────────────────────────
    const workerA = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Dashboard Worker A',
    });
    assert.equal(workerA.status, 201);
    const workerB = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Dashboard Worker B',
    });
    assert.equal(workerB.status, 201);
    await heartbeatAgent(baseUrl, workerA.data.api_key); // A online, B offline

    // ── One orchestration (running bucket) ──────────────────────────────────
    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Dashboard Orchestration',
      objective: 'Drive dashboard aggregation.',
    });
    assert.equal(orch.status, 201);
    const orchRepo = AppDataSource.getRepository(ProjectOrchestration);
    await orchRepo.save({ id: orch.data.id, status: ProjectOrchestrationStatus.RUNNING });

    // ── Six tasks with distinct, monotonically increasing updatedAt so the
    //    "recent tasks" slice is deterministic. Statuses vary so metrics +
    //    loop_status have something to count (1 running, 1 stalled, rest done).
    const now = Date.now();
    const HOUR = 60 * 60_000;
    const DAY = 24 * HOUR;
    const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
    const taskSeed = [
      {
        title: 'Task oldest',
        status: ProjectOrchestrationTaskStatus.APPROVED,
        completedAt: new Date(now - 6 * DAY),
        updatedAt: new Date(now - 6 * DAY),
      },
      {
        title: 'Task stalled',
        status: ProjectOrchestrationTaskStatus.DISPATCHED,
        dispatchedAt: new Date(now - HOUR), // > 15-min stall cutoff
        updatedAt: new Date(now - 5 * DAY),
      },
      {
        title: 'Task pending',
        status: ProjectOrchestrationTaskStatus.PENDING,
        updatedAt: new Date(now - 4 * DAY),
      },
      {
        title: 'Task completed mid',
        status: ProjectOrchestrationTaskStatus.APPROVED,
        completedAt: new Date(now - 3 * DAY),
        updatedAt: new Date(now - 3 * DAY),
      },
      {
        title: 'Task running',
        status: ProjectOrchestrationTaskStatus.RUNNING,
        assignedAgentId: workerA.data.id,
        dispatchedAt: new Date(now - 60_000),
        claimedAt: new Date(now - 30_000),
        updatedAt: new Date(now - 2 * DAY),
      },
      {
        title: 'Task newest',
        status: ProjectOrchestrationTaskStatus.APPROVED,
        completedAt: new Date(now - DAY),
        updatedAt: new Date(now - DAY),
      },
    ];
    const seededTasks = taskSeed.map((seed) => taskRepo.create({
      projectId,
      orchestrationId: orch.data.id,
      goal: `Goal for ${seed.title}`,
      workerTaskPath: `.agent/t/${orch.data.id}/${seed.title.replace(/\s+/g, '-')}.worker_task.md`,
      workerContextPath: `.agent/t/${orch.data.id}/${seed.title.replace(/\s+/g, '-')}.worker_context.md`,
      createdAt: new Date(seed.updatedAt.getTime() - DAY),
      ...seed,
    }));
    await taskRepo.save(seededTasks);

    // ── Six changesets with distinct updatedAt; two are non-terminal so they
    //    surface in loop_status.pending_changesets.
    const branch = await api(baseUrl, 'GET', `/v1/projects/${projectId}/branches`, owner.token);
    assert.equal(branch.status, 200);
    assert.ok(branch.data.data.length > 0, 'project has a default branch');
    const branchId = branch.data.data[0].id;

    const csRepo = AppDataSource.getRepository(ProjectChangeset);
    const csSeed = [
      { title: 'Changeset oldest', status: ProjectChangesetStatus.MERGED, updatedAt: new Date(now - 6 * DAY) },
      { title: 'Changeset rejected', status: ProjectChangesetStatus.REJECTED, updatedAt: new Date(now - 5 * DAY) },
      { title: 'Changeset pending A', status: ProjectChangesetStatus.SUBMITTED, updatedAt: new Date(now - 4 * DAY) },
      { title: 'Changeset mid merged', status: ProjectChangesetStatus.MERGED, updatedAt: new Date(now - 3 * DAY) },
      { title: 'Changeset pending B', status: ProjectChangesetStatus.READY_FOR_REVIEW, updatedAt: new Date(now - 2 * DAY) },
      { title: 'Changeset newest', status: ProjectChangesetStatus.MERGED, updatedAt: new Date(now - DAY) },
    ];
    const seededChangesets = csSeed.map((seed) => csRepo.create({
      projectId,
      branchId,
      fileOps: [],
      createdByAgentId: workerA.data.id,
      createdAt: new Date(seed.updatedAt.getTime() - DAY),
      ...seed,
    }));
    await csRepo.save(seededChangesets);

    // ── Auth required (no credentials → 401) ───────────────────────────────
    const noAuth = await api(baseUrl, 'GET', `/v1/projects/${projectId}/dashboard`);
    assert.equal(noAuth.status, 401);

    // ── Owner JWT call ─────────────────────────────────────────────────────
    const res = await api(baseUrl, 'GET', `/v1/projects/${projectId}/dashboard`, owner.token);
    assert.equal(res.status, 200);
    const body = res.data;

    // ── Top-level shape: exactly the six documented keys ───────────────────
    assert.ok(body && typeof body === 'object', 'body is an object');
    const expectedKeys = [
      'loop_status',
      'metrics',
      'worker_load',
      'recent_changesets',
      'recent_tasks',
      'generated_at',
    ];
    assert.deepEqual(Object.keys(body).sort(), expectedKeys.sort(), 'top-level keys match');

    // generated_at is a parseable ISO timestamp at/before now.
    assert.equal(typeof body.generated_at, 'string');
    const generatedAt = new Date(body.generated_at).getTime();
    assert.ok(Number.isFinite(generatedAt), 'generated_at is a valid date');
    assert.ok(generatedAt <= Date.now(), 'generated_at is not in the future');

    // ── loop_status shape ──────────────────────────────────────────────────
    const loopStatus = body.loop_status;
    assert.ok(Array.isArray(loopStatus.workers));
    assert.ok(Array.isArray(loopStatus.pending_changesets));
    assert.equal(typeof loopStatus.running_tasks, 'number');
    assert.ok(Array.isArray(loopStatus.stalled_tasks));
    assert.ok(loopStatus.orchestrations && typeof loopStatus.orchestrations === 'object');

    // ── metrics shape ──────────────────────────────────────────────────────
    assertMetricsShape(body.metrics);

    // ── worker_load shape ({ data: [...] }, one row per project agent) ──────
    assert.ok(Array.isArray(body.worker_load.data), 'worker_load.data is an array');
    assert.equal(body.worker_load.data.length, 2, 'one row per project agent');
    for (const w of body.worker_load.data) {
      assert.equal(typeof w.agent_id, 'string');
      assert.equal(typeof w.agent_name, 'string');
      assert.equal(typeof w.online, 'boolean');
      assert.equal(typeof w.running_tasks, 'number');
      assert.equal(typeof w.utilization_score, 'number');
    }

    // ── recent_changesets: capped at 5, ordered updatedAt DESC, each row has
    //    the full serializeChangeset shape. ─────────────────────────────────
    assert.ok(Array.isArray(body.recent_changesets));
    assert.equal(body.recent_changesets.length, 5, 'recent_changesets respects the 5-item cap');
    for (const cs of body.recent_changesets) {
      assert.equal(typeof cs.id, 'string');
      assert.equal(typeof cs.title, 'string');
      assert.equal(typeof cs.status, 'string');
      assert.ok(Array.isArray(cs.file_ops));
      assert.ok(cs.updated_at, 'serializeChangeset exposes updated_at');
    }
    assertOrderedDescByUpdatedAt(body.recent_changesets, 'recent_changesets');

    // ── recent_tasks: capped at 5, ordered updatedAt DESC, serializeTask shape.
    assert.ok(Array.isArray(body.recent_tasks));
    assert.equal(body.recent_tasks.length, 5, 'recent_tasks respects the 5-item cap');
    for (const t of body.recent_tasks) {
      assert.equal(typeof t.id, 'string');
      assert.equal(typeof t.title, 'string');
      assert.equal(typeof t.status, 'string');
      assert.ok(t.updated_at, 'serializeTask exposes updated_at');
    }
    assertOrderedDescByUpdatedAt(body.recent_tasks, 'recent_tasks');

    // ══ DATA CONSISTENCY: dashboard reuses the same functions as the
    //    dedicated endpoints, so each sub-payload must match what those
    //    endpoints return when called separately. ════════════════════════════

    // metrics: pure counts/durations → exact deepEqual.
    const metricsRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/metrics`, owner.token);
    assert.equal(metricsRes.status, 200);
    assert.deepEqual(body.metrics, metricsRes.data, 'dashboard.metrics === GET /metrics');

    // worker_load: same builder → exact deepEqual of the data array.
    const workerLoadRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/worker-load`, owner.token);
    assert.equal(workerLoadRes.status, 200);
    assert.deepEqual(
      body.worker_load.data,
      workerLoadRes.data.data,
      'dashboard.worker_load.data === GET /worker-load .data',
    );

    // loop_status: re-derive and compare the deterministic structural fields
    // (skip age_minutes, which is whole-minute floored and could differ if the
    // two calls straddle a minute boundary).
    const loopStatusRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/loop-status`, owner.token);
    assert.equal(loopStatusRes.status, 200);
    assert.deepEqual(
      loopStatus.workers.map((w: any) => w.id),
      loopStatusRes.data.workers.map((w: any) => w.id),
      'loop_status worker ids match dedicated endpoint',
    );
    assert.equal(loopStatus.running_tasks, loopStatusRes.data.running_tasks);
    assert.equal(loopStatus.stalled_tasks.length, loopStatusRes.data.stalled_tasks.length);
    assert.equal(loopStatus.pending_changesets.length, loopStatusRes.data.pending_changesets.length);
    assert.deepEqual(loopStatus.orchestrations, loopStatusRes.data.orchestrations);

    // recent_changesets: GET /changesets uses the same updatedAt-DESC ordering
    // and the same serializeChangeset, so the dashboard slice must equal the
    // first 5 rows of the dedicated listing.
    const changesetsRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets`, owner.token);
    assert.equal(changesetsRes.status, 200);
    assert.ok(changesetsRes.data.data.length >= 5);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(
        body.recent_changesets[i],
        changesetsRes.data.data[i],
        `recent_changesets[${i}] === GET /changesets data[${i}]`,
      );
    }

    // recent_tasks: no project-wide tasks endpoint exists, so compare against
    // the identical TypeORM query the dashboard uses (updatedAt DESC, take 5).
    const expectedRecentTaskIds = (await taskRepo.find({
      where: { projectId },
      order: { updatedAt: 'DESC' },
      take: 5,
    })).map((t) => t.id);
    assert.deepEqual(
      body.recent_tasks.map((t: any) => t.id),
      expectedRecentTaskIds,
      'recent_tasks ids match the updatedAt-DESC take-5 query',
    );

    // ── Cross-check: dashboard counts agree with the underlying data ────────
    assert.equal(body.metrics.total_orchestrations, 1, 'one orchestration seeded');
    assert.equal(body.metrics.total_tasks, 6, 'six tasks seeded');
    assert.equal(body.metrics.completed_tasks, 3, 'three APPROVED tasks');
    assert.equal(body.metrics.auto_merged_changesets, 3, 'three MERGED changesets');
    assert.equal(body.loop_status.running_tasks, 1, 'one RUNNING task');
    assert.equal(body.loop_status.stalled_tasks.length, 1, 'one stalled dispatched task');
    assert.equal(body.loop_status.pending_changesets.length, 2, 'two non-terminal changesets');

    // ── Agent API key (ViewProject) also works ─────────────────────────────
    const agentRes = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/dashboard`,
      workerA.data.api_key,
    );
    assert.equal(agentRes.status, 200);
    assert.deepEqual(
      Object.keys(agentRes.data).sort(),
      expectedKeys.sort(),
      'agent-key call returns the same shape',
    );

    // ── Wrong project is rejected (agent belongs to a different project) ───
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, { name: 'Other Dashboard Project' });
    assert.equal(otherProject.status, 201);
    const wrongProject = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${otherProject.data.id}/dashboard`,
      workerA.data.api_key,
    );
    assert.equal(wrongProject.status, 403, 'agent cannot view another project');

    // ── Empty project: shape still correct, slices empty ───────────────────
    const emptyProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, { name: 'Empty Dashboard Project' });
    assert.equal(emptyProject.status, 201);
    const emptyRes = await api(baseUrl, 'GET', `/v1/projects/${emptyProject.data.id}/dashboard`, owner.token);
    assert.equal(emptyRes.status, 200);
    assert.deepEqual(Object.keys(emptyRes.data).sort(), expectedKeys.sort());
    assert.deepEqual(emptyRes.data.recent_changesets, []);
    assert.deepEqual(emptyRes.data.recent_tasks, []);
    assert.deepEqual(emptyRes.data.worker_load.data, []);
    assert.equal(emptyRes.data.metrics.total_tasks, 0);
    assert.equal(emptyRes.data.loop_status.running_tasks, 0);

    console.log('dashboard tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

function assertMetricsShape(data: any): void {
  assert.equal(typeof data.total_orchestrations, 'number');
  assert.equal(typeof data.completed_orchestrations, 'number');
  assert.equal(typeof data.total_tasks, 'number');
  assert.equal(typeof data.completed_tasks, 'number');
  assert.equal(typeof data.auto_merged_changesets, 'number');
  assert.equal(typeof data.rejected_changesets, 'number');
  assert.ok(data.avg_task_duration_minutes === null || typeof data.avg_task_duration_minutes === 'number');
  assert.ok(data.avg_changeset_review_time_minutes === null || typeof data.avg_changeset_review_time_minutes === 'number');
  assert.ok(Array.isArray(data.worker_stats));
}

function assertOrderedDescByUpdatedAt(rows: any[], label: string): void {
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1].updated_at).getTime();
    const cur = new Date(rows[i].updated_at).getTime();
    assert.ok(
      prev >= cur,
      `${label} ordered by updated_at DESC (index ${i - 1}=${prev} >= ${i}=${cur})`,
    );
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email,
    password: 'Dashboard123!',
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
