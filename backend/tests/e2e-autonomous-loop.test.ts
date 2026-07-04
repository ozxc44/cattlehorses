/**
 * R20b: E2E test — full autonomous loop
 *
 * Exercises the complete loop:
 *   1. Register 2 workers with health=healthy
 *   2. Create orchestration
 *   3. Smart-dispatch a task
 *   4. Simulate worker claim+complete with a file_op
 *   5. PM approve with auto_merge=true
 *   6. Assert changeset status=merged + commit created + file in repo
 *
 * This is the regression guard for the entire R8-R19 chain.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'e2e-autonomous-loop-test-secret';
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
  const { ProjectChangeset } = await import('../src/entities/project-changeset.entity');
  const { ProjectCommit } = await import('../src/entities/project-commit.entity');
  const { ProjectFile } = await import('../src/entities/project-file.entity');
  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  try {
    // ── Step 0: Setup users, project, agents ──────────────────────────────
    console.log('\n── Step 0: Setup ──');
    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');
    const wk1User = await register(baseUrl, 'wk1');
    const wk2User = await register(baseUrl, 'wk2');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'E2E Autonomous Loop', visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    for (const u of [pmUser, wk1User, wk2User]) {
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
        user_id: u.userId, role: 'member',
      });
    }

    // ── Step 1: Register 2 workers with health=healthy ────────────────────
    console.log('\n── Step 1: Register 2 healthy workers ──');
    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm' });
    check('create PM agent', pm.status, 201);
    const pmKey = pm.data.api_key;
    const pmId = pm.data.id;

    const wk1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, wk1User.token, { name: 'worker-1' });
    check('create worker-1', wk1.status, 201);
    const wk1Key = wk1.data.api_key;
    const wk1Id = wk1.data.id;

    const wk2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, wk2User.token, { name: 'worker-2' });
    check('create worker-2', wk2.status, 201);
    const wk2Key = wk2.data.api_key;
    const wk2Id = wk2.data.id;

    // Heartbeat with health=healthy for all agents
    const hbPm = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', pmKey, {
      status: 'active', health: { status: 'healthy' },
    });
    check('PM heartbeat healthy', hbPm.status, 200);

    const hbWk1 = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', wk1Key, {
      status: 'active', health: { status: 'healthy' },
    });
    check('worker-1 heartbeat healthy', hbWk1.status, 200);
    check('worker-1 is_online', hbWk1.data.is_online, true);

    const hbWk2 = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', wk2Key, {
      status: 'active', health: { status: 'healthy' },
    });
    check('worker-2 heartbeat healthy', hbWk2.status, 200);
    check('worker-2 is_online', hbWk2.data.is_online, true);

    // Set PM as project main agent
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmId });

    // ── Step 2: Create orchestration ──────────────────────────────────────
    console.log('\n── Step 2: Create orchestration ──');
    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'E2E autonomous orch',
      objective: 'Full autonomous loop regression test',
      main_agent_id: pmId,
      worker_agent_ids: [wk1Id, wk2Id],
    });
    check('create orchestration', orch.status, 201);
    const orchId = orch.data.id;

    // ── Step 3: PM dispatches a task to worker-1 ──────────────────────────
    console.log('\n── Step 3: Dispatch task ──');
    const task = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`,
      pmKey,
      {
        title: 'Implement feature X',
        goal: 'Write the feature X implementation',
        assigned_agent_id: wk1Id,
        acceptance_criteria: ['feature compiles', 'tests pass'],
      },
    );
    check('dispatch task to worker-1', task.status, 201);
    check('task assigned to worker-1', task.data.assigned_agent_id, wk1Id);
    const taskId = task.data.id;

    // Worker-1 discovers its task via assigned-tasks
    const assignedTasks = await apiWithKey(baseUrl, 'GET', '/v1/agent/assigned-tasks', wk1Key);
    check('worker-1 assigned-tasks 200', assignedTasks.status, 200);
    const workerTaskIds = (assignedTasks.data.data || []).map((t: any) => t.id);
    check('worker-1 sees dispatched task', workerTaskIds.includes(taskId), true);

    // ── Step 4: Worker-1 completes the task with evidence ─────────────────
    console.log('\n── Step 4: Worker completes task ──');
    const complete = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/complete`,
      wk1Key,
      {
        result_md: '# Feature X\n\nImplementation complete.\n\n## Changes\n- Added feature X module\n- Updated tests\n\n## Verification\n- feature compiles successfully with no errors\n- tests pass with all green results',
        evidence: {
          files_changed: ['src/feature-x.ts', 'tests/feature-x.test.ts'],
        },
        status: 'ready_for_review',
      },
    );
    check('worker-1 completes task', complete.status, 200);
    check('task status ready_for_review', complete.data.status, 'ready_for_review');

    // ── Step 4b: Verify auto-changeset was created ────────────────────────
    console.log('\n── Step 4b: Verify auto-changeset ──');
    const csRows = await AppDataSource.getRepository(ProjectChangeset).find({
      where: { projectId, taskId },
    });
    check('auto-changeset created for task', csRows.length >= 1, true);
    const cs = csRows[0];
    check('changeset status is submitted', cs.status, 'submitted');
    check('changeset linked to orchestration', cs.orchestrationId, orchId);
    check('changeset author = worker-1', cs.createdByAgentId, wk1Id);
    check('changeset has file_ops', Array.isArray(cs.fileOps) && cs.fileOps.length > 0, true);
    const csId = cs.id;

    // ── Step 5: PM approves with auto_merge=true ──────────────────────────
    console.log('\n── Step 5: PM approve with auto_merge=true ──');
    const review = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${csId}/review`,
      pmKey,
      {
        decision: 'approved',
        auto_merge: true,
        notes: 'LGTM, auto-merge',
      },
    );
    check('PM reviews changeset (auto_merge=true)', review.status, 200);

    // ── Step 6: Assert changeset is merged ────────────────────────────────
    console.log('\n── Step 6: Assert merged + commit + file in repo ──');

    // Re-read changeset from DB to verify final state
    const mergedCs = await AppDataSource.getRepository(ProjectChangeset).findOne({
      where: { id: csId },
    });
    assert(mergedCs, 'changeset should exist');
    check('changeset status=merged', mergedCs!.status, 'merged');
    check('changeset has mergedCommitId', !!mergedCs!.mergedCommitId, true);

    // Verify the commit was created
    if (mergedCs!.mergedCommitId) {
      const commit = await AppDataSource.getRepository(ProjectCommit).findOne({
        where: { id: mergedCs!.mergedCommitId },
      });
      assert(commit, 'merged commit should exist');
      check('commit exists for merged changeset', !!commit, true);
      check('commit linked to project', commit!.projectId, projectId);
      check('commit has snapshot', typeof commit!.snapshot === 'object' && commit!.snapshot !== null, true);
      check('commit has changedFiles', Array.isArray(commit!.changedFiles), true);
    }

    // Verify file exists in the project repo
    const filesRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files`, owner.token);
    check('list project files', filesRes.status, 200);
    const filePaths = (filesRes.data.data || []).map((f: any) => f.path);

    // The auto-changeset should have written the result file into the repo.
    // Also verify the result MD file from the task completion was persisted.
    const hasResultFile = filePaths.some((p: string) => p.includes('.result.md') || p.includes('feature'));
    check('result file exists in repo', hasResultFile, true);

    // Verify the auto_merged flag in the review response
    if (review.data.auto_merged !== undefined) {
      check('review response has auto_merged=true', review.data.auto_merged, true);
    }
    if (review.data.commit) {
      check('review response includes commit', !!review.data.commit.id, true);
    }

    // ── Bonus: PM approves the task itself ────────────────────────────────
    console.log('\n── Bonus: PM approves task ──');
    const taskReview = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/review`,
      pmKey,
      { decision: 'approved', notes: 'shipped' },
    );
    check('PM approves task', taskReview.status, 200);
    check('task approved', taskReview.data.status, 'approved');

    // Verify orchestration status
    const orchDetail = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchId}`,
      owner.token,
    );
    check('orchestration detail', orchDetail.status, 200);

    // ── Summary ───────────────────────────────────────────────────────────
    console.log(`\n══ Results: ${passed} passed, ${failed} failed ══`);
    if (failed > 0) process.exit(1);
  } finally {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string) {
  const r = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@x.invalid`,
    password: 'E2ELoopTest123!', display_name: prefix,
  });
  assert.equal(r.status, 201);
  return { token: r.data.access_token, userId: r.data.user.id };
}

async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let d: any = t;
  try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

async function apiWithKey(baseUrl: string, method: string, path: string, key: string, body?: unknown) {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': key };
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let d: any = t;
  try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

main().catch((e) => { console.error(e); process.exit(1); });
