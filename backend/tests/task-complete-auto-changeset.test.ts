import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-auto-changeset-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { ProjectChangeset } = await import('../src/entities/project-changeset.entity');
  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  try {
    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');
    const wkUser = await register(baseUrl, 'wk');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, { name: 'Auto CS Test', visibility: 'public' });
    const projectId = project.data.id;
    for (const u of [pmUser, wkUser]) {
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: u.userId, role: 'member' });
    }
    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm' });
    const pmKey = pm.data.api_key;
    const wk = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, wkUser.token, { name: 'wk' });
    const wkKey = wk.data.api_key;
    for (const k of [pmKey, wkKey]) await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', k, {});
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pm.data.id });

    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'auto-cs orch', objective: 'auto changeset on complete',
      main_agent_id: pm.data.id, worker_agent_ids: [wk.data.id],
    });
    const orchId = orch.data.id;

    // pm dispatches a task to wk.
    const task = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'auto-cs task', goal: 'produce a deliverable', assigned_agent_id: wk.data.id, acceptance_criteria: ['done'],
    });
    check('dispatch task', task.status, 201);
    const taskId = task.data.id;

    // worker completes the task (ready_for_review).
    const complete = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/complete`, wkKey, {
      result_md: '# Deliverable\nThe work is done.', evidence: { files_changed: ['deliverables/wk/result.md'], ok: true }, status: 'ready_for_review',
    });
    check('worker completes task', complete.status, 200);
    check('task ready_for_review', complete.data.status, 'ready_for_review');

    // ── 1. A changeset was auto-created, linked to the task ──────────────
    const csRows = await AppDataSource.getRepository(ProjectChangeset).find({
      where: { projectId, taskId },
    });
    check('auto-changeset created for task', csRows.length, 1);
    const cs = csRows[0];
    check('changeset status submitted', cs.status, 'submitted');
    check('changeset linked to orchestration', cs.orchestrationId, orchId);
    check('changeset author = worker', cs.createdByAgentId, wk.data.id);

    // ── 2. pm reviews + merges it (Phase 1 unlock + auto-cs integration) ─
    const review = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${cs.id}/review`, pmKey, {
      decision: 'approved', auto_merge: false, notes: 'accepted',
    });
    check('pm reviews auto-changeset', review.status, 200);
    check('changeset merge_ready', review.data.status, 'merge_ready');

    const merge = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${cs.id}/merge`, owner.token);
    check('owner merges auto-changeset via JWT', merge.status, 200);
    check('changeset merged', merge.data.changeset.status, 'merged');

    // ── 3. pm approves the task itself (full acceptance loop) ────────────
    const taskReview = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/review`, pmKey, {
      decision: 'approved', auto_merge: false, notes: 'shipped',
    });
    check('pm approves task', taskReview.status, 200);
    check('task approved', taskReview.data.status, 'approved');

    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exit(1);
  } finally {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string) {
  const r = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@x.invalid`,
    password: 'AutoCS123!', display_name: prefix,
  });
  assert.equal(r.status, 201);
  return { token: r.data.access_token, userId: r.data.user.id };
}
async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}
async function apiWithKey(baseUrl: string, method: string, path: string, key: string, body?: unknown) {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': key };
  const r = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}
main().catch((e) => { console.error(e); process.exit(1); });
