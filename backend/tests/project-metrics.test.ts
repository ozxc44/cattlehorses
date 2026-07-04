import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-metrics-test-secret';

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
    const owner = await register(baseUrl, 'pm-owner');
    const viewer = await register(baseUrl, 'pm-viewer');
    const otherUser = await register(baseUrl, 'pm-other');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Metrics Test',
      description: 'Loop throughput summary testing',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });

    const otherProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Other Project Metrics Test',
      description: 'Should not appear in metrics',
    });
    assert.equal(otherProject.status, 201);

    // ── Test 1: Empty project metrics shape ─────────────────────────────────
    console.log('\n── Test 1: Empty project metrics shape ──');
    const emptyRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/metrics`, owner.token);
    assert.equal(emptyRes.status, 200);
    assertMetricsShape(emptyRes.data);
    assert.equal(emptyRes.data.total_orchestrations, 0);
    assert.equal(emptyRes.data.completed_orchestrations, 0);
    assert.equal(emptyRes.data.total_tasks, 0);
    assert.equal(emptyRes.data.completed_tasks, 0);
    assert.equal(emptyRes.data.auto_merged_changesets, 0);
    assert.equal(emptyRes.data.rejected_changesets, 0);
    assert.equal(emptyRes.data.avg_task_duration_minutes, null);
    assert.equal(emptyRes.data.avg_changeset_review_time_minutes, null);
    assert.deepEqual(emptyRes.data.worker_stats, []);
    console.log('  ✅ Empty project returns correct zero/null shape');

    // ── Test 2: Seeded counts match ─────────────────────────────────────────
    console.log('\n── Test 2: Seeded counts match ──');
    const {
      Agent,
      ProjectBranch,
      ProjectOrchestration,
      ProjectOrchestrationStatus,
      ProjectOrchestrationTask,
      ProjectOrchestrationTaskStatus,
      ProjectChangeset,
      ProjectChangesetStatus,
    } = await import('../src/entities');

    const workerAlpha = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Alpha Worker',
    });
    assert.equal(workerAlpha.status, 201);
    const workerBeta = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Beta Worker',
    });
    assert.equal(workerBeta.status, 201);

    const now = Date.now();
    const orchRepo = AppDataSource.getRepository(ProjectOrchestration);
    const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
    const branchRepo = AppDataSource.getRepository(ProjectBranch);
    const changesetRepo = AppDataSource.getRepository(ProjectChangeset);

    const branch = await branchRepo.save(branchRepo.create({
      projectId,
      name: 'main',
      isDefault: true,
      createdByUserId: owner.userId,
    }));

    // Orchestrations: 2 total, 1 completed
    const orch1 = await orchRepo.save(orchRepo.create({
      projectId,
      title: 'First Orchestration',
      objective: 'First loop.',
      status: ProjectOrchestrationStatus.COMPLETED,
      basePath: 'orch1',
      createdByUserId: owner.userId,
      completedAt: new Date(now - 50_000),
    }));
    const orch2 = await orchRepo.save(orchRepo.create({
      projectId,
      title: 'Second Orchestration',
      objective: 'Second loop.',
      status: ProjectOrchestrationStatus.RUNNING,
      basePath: 'orch2',
      createdByUserId: owner.userId,
    }));

    // Tasks: 4 total, 2 completed (approved), both by Alpha
    const alphaTask1 = await taskRepo.save(taskRepo.create({
      projectId,
      orchestrationId: orch1.id,
      title: 'Alpha task one',
      goal: 'First completed task.',
      status: ProjectOrchestrationTaskStatus.APPROVED,
      assignedAgentId: workerAlpha.data.id,
      workerTaskPath: 'orch1/alpha1.task.md',
      workerContextPath: 'orch1/alpha1.context.md',
      createdAt: new Date(now - 120_000),
      completedAt: new Date(now - 60_000),
    }));
    const alphaTask2 = await taskRepo.save(taskRepo.create({
      projectId,
      orchestrationId: orch1.id,
      title: 'Alpha task two',
      goal: 'Second completed task.',
      status: ProjectOrchestrationTaskStatus.APPROVED,
      assignedAgentId: workerAlpha.data.id,
      workerTaskPath: 'orch1/alpha2.task.md',
      workerContextPath: 'orch1/alpha2.context.md',
      createdAt: new Date(now - 300_000),
      completedAt: new Date(now - 200_000),
    }));
    await taskRepo.save(taskRepo.create({
      projectId,
      orchestrationId: orch2.id,
      title: 'Beta dispatched task',
      goal: 'Incomplete task.',
      status: ProjectOrchestrationTaskStatus.DISPATCHED,
      assignedAgentId: workerBeta.data.id,
      workerTaskPath: 'orch2/beta.task.md',
      workerContextPath: 'orch2/beta.context.md',
      dispatchedAt: new Date(now - 10_000),
    }));
    await taskRepo.save(taskRepo.create({
      projectId,
      orchestrationId: orch2.id,
      title: 'Unassigned pending task',
      goal: 'Pending task with no agent.',
      status: ProjectOrchestrationTaskStatus.PENDING,
      workerTaskPath: 'orch2/pending.task.md',
      workerContextPath: 'orch2/pending.context.md',
    }));

    // Changesets: 2 merged (auto-merged), 1 rejected, 1 draft
    await changesetRepo.save(changesetRepo.create({
      projectId,
      branchId: branch.id,
      title: 'Merged changeset Alpha',
      status: ProjectChangesetStatus.MERGED,
      fileOps: [{ op: 'upsert', path: 'a.md', content: 'a' }],
      createdByAgentId: workerAlpha.data.id,
      taskId: alphaTask1.id,
      orchestrationId: orch1.id,
      createdAt: new Date(now - 120_000),
      reviewedAt: new Date(now - 90_000),
    }));
    await changesetRepo.save(changesetRepo.create({
      projectId,
      branchId: branch.id,
      title: 'Merged changeset Beta',
      status: ProjectChangesetStatus.MERGED,
      fileOps: [{ op: 'upsert', path: 'b.md', content: 'b' }],
      createdByAgentId: workerBeta.data.id,
      createdAt: new Date(now - 200_000),
      reviewedAt: new Date(now - 100_000),
    }));
    await changesetRepo.save(changesetRepo.create({
      projectId,
      branchId: branch.id,
      title: 'Rejected changeset Alpha',
      status: ProjectChangesetStatus.REJECTED,
      fileOps: [{ op: 'upsert', path: 'c.md', content: 'c' }],
      createdByAgentId: workerAlpha.data.id,
      createdAt: new Date(now - 150_000),
      reviewedAt: new Date(now - 80_000),
    }));
    await changesetRepo.save(changesetRepo.create({
      projectId,
      branchId: branch.id,
      title: 'Draft changeset',
      status: ProjectChangesetStatus.DRAFT,
      fileOps: [{ op: 'upsert', path: 'd.md', content: 'd' }],
      createdByUserId: owner.userId,
      createdAt: new Date(now - 50_000),
    }));

    // Seed data in the unrelated project to confirm scoping
    const otherBranch = await branchRepo.save(branchRepo.create({
      projectId: otherProject.data.id,
      name: 'main',
      isDefault: true,
      createdByUserId: owner.userId,
    }));
    const otherOrch = await orchRepo.save(orchRepo.create({
      projectId: otherProject.data.id,
      title: 'Other Orchestration',
      objective: 'Should not be counted.',
      status: ProjectOrchestrationStatus.COMPLETED,
      basePath: 'other-orch',
      createdByUserId: owner.userId,
      completedAt: new Date(now - 10_000),
    }));
    await taskRepo.save(taskRepo.create({
      projectId: otherProject.data.id,
      orchestrationId: otherOrch.id,
      title: 'Other completed task',
      goal: 'Should not be counted.',
      status: ProjectOrchestrationTaskStatus.APPROVED,
      workerTaskPath: 'other-orch/task.md',
      workerContextPath: 'other-orch/context.md',
      createdAt: new Date(now - 50_000),
      completedAt: new Date(now - 10_000),
    }));
    await changesetRepo.save(changesetRepo.create({
      projectId: otherProject.data.id,
      branchId: otherBranch.id,
      title: 'Other merged changeset',
      status: ProjectChangesetStatus.MERGED,
      fileOps: [{ op: 'upsert', path: 'other.md', content: 'other' }],
      createdByUserId: owner.userId,
      createdAt: new Date(now - 50_000),
      reviewedAt: new Date(now - 20_000),
    }));

    const metrics = await api(baseUrl, 'GET', `/v1/projects/${projectId}/metrics`, owner.token);
    assert.equal(metrics.status, 200);
    assertMetricsShape(metrics.data);
    assert.equal(metrics.data.total_orchestrations, 2, 'total_orchestrations');
    assert.equal(metrics.data.completed_orchestrations, 1, 'completed_orchestrations');
    assert.equal(metrics.data.total_tasks, 4, 'total_tasks');
    assert.equal(metrics.data.completed_tasks, 2, 'completed_tasks');
    assert.equal(metrics.data.auto_merged_changesets, 2, 'auto_merged_changesets');
    assert.equal(metrics.data.rejected_changesets, 1, 'rejected_changesets');

    // Task durations: (60s + 100s) / 2 = 80s -> 1.33 minutes
    assertNumberNear(metrics.data.avg_task_duration_minutes, 80 / 60, 0.01, 'avg_task_duration_minutes');
    // Changeset review times: (30s + 100s + 70s) / 3 = 200s / 3 -> 1.11 minutes
    assertNumberNear(metrics.data.avg_changeset_review_time_minutes, 200 / 3 / 60, 0.01, 'avg_changeset_review_time_minutes');

    assert.equal(metrics.data.worker_stats.length, 2, 'worker_stats length');
    const alphaStat = metrics.data.worker_stats.find((s: any) => s.agent_name === 'Alpha Worker');
    const betaStat = metrics.data.worker_stats.find((s: any) => s.agent_name === 'Beta Worker');
    assert.ok(alphaStat, 'Alpha Worker stat');
    assert.ok(betaStat, 'Beta Worker stat');
    assert.equal(alphaStat.tasks_completed, 2);
    assert.equal(alphaStat.changesets_merged, 1);
    assertNumberNear(alphaStat.avg_duration_minutes, 80 / 60, 0.01, 'alpha avg_duration_minutes');
    assert.equal(betaStat.tasks_completed, 0);
    assert.equal(betaStat.changesets_merged, 1);
    assert.equal(betaStat.avg_duration_minutes, null);
    console.log('  ✅ Seeded counts, durations, and worker stats match');

    // ── Test 3: Viewer with ViewProject can read ────────────────────────────
    console.log('\n── Test 3: Viewer access ──');
    const viewerRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/metrics`, viewer.token);
    assert.equal(viewerRes.status, 200);
    assert.equal(viewerRes.data.total_orchestrations, 2);
    console.log('  ✅ Viewer gets metrics');

    // ── Test 4: Unrelated user denied ───────────────────────────────────────
    console.log('\n── Test 4: Unrelated user denied ──');
    const otherRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/metrics`, otherUser.token);
    assert.equal(otherRes.status, 403);
    console.log('  ✅ Unrelated user gets 403');

    // ── Test 5: Unauthenticated denied ──────────────────────────────────────
    console.log('\n── Test 5: Unauthenticated denied ──');
    const unauthRes = await fetch(`${baseUrl}/v1/projects/${projectId}/metrics`);
    assert.equal(unauthRes.status, 401);
    console.log('  ✅ Unauthenticated gets 401');

    console.log('\n✅ All project-metrics tests passed.');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const email = `${prefix}+test@example.com`;
  const res = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpassword123', display_name: prefix }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Register ${prefix} failed: ${res.status} ${JSON.stringify(data)}`);
  return { token: data.access_token, userId: data.user.id };
}

async function api(
  baseUrl: string, method: string, path: string, token: string, body?: any,
): Promise<{ status: number; data: any }> {
  const options: any = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, options);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
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
  for (const stat of data.worker_stats) {
    assert.ok('agent_name' in stat);
    assert.equal(typeof stat.tasks_completed, 'number');
    assert.equal(typeof stat.changesets_merged, 'number');
    assert.ok(stat.avg_duration_minutes === null || typeof stat.avg_duration_minutes === 'number');
  }
}

function assertNumberNear(actual: unknown, expected: number, tolerance: number, label: string): void {
  assert.equal(typeof actual, 'number', `${label} should be a number`);
  const value = actual as number;
  assert.ok(
    Math.abs(value - expected) <= tolerance,
    `${label} expected ${expected} +/- ${tolerance}, got ${value}`,
  );
}
