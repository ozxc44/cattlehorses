import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'main-agent-changeset-merge-test-secret';
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
  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  try {
    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');
    const wkUser = await register(baseUrl, 'wk');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Changeset Merge Test', visibility: 'public',
    });
    const projectId = project.data.id;
    for (const u of [pmUser, wkUser]) {
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: u.userId, role: 'member' });
    }
    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm' });
    const pmKey = pm.data.api_key;
    const wk = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, wkUser.token, { name: 'wk' });
    const wkKey = wk.data.api_key;
    for (const k of [pmKey, wkKey]) await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', k, {});
    // pm = project-level main agent (Phase 1 PM).
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pm.data.id });

    // Orchestration whose orchestration-main is the WORKER (so we prove the
    // project-level main agent's merge power overrides it).
    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'merge orch', objective: 'changeset merge by project-pm',
      main_agent_id: wk.data.id, worker_agent_ids: [wk.data.id],
    });
    const orchId = orch.data.id;

    // Worker creates a changeset tied to the orchestration.
    const cs = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, wkKey, {
      title: 'worker deliverable', orchestration_id: orchId,
      file_ops: [{ op: 'upsert', path: 'deliverables/work.md', content: '# work\n' }],
    });
    check('worker creates changeset', cs.status, 201);
    const csId = cs.data.id;

    // ── 1. Project-main agent can REVIEW the changeset (Phase 1 unlock) ────
    const reviewByPm = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${csId}/review`, pmKey, {
      decision: 'approved', auto_merge: false, notes: 'accept deliverable',
    });
    check('project-main agent reviews changeset (Phase 1 unlock)', reviewByPm.status, 200);
    check('changeset merge_ready', reviewByPm.data.status, 'merge_ready');

    // ── 2. A JWT-authenticated user (owner) must execute the actual merge ──
    const mergeByPm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${csId}/merge`, owner.token);
    check('owner merges changeset via JWT', mergeByPm.status, 200);
    check('changeset merged', mergeByPm.data.changeset.status, 'merged');

    // ── 3. A non-main agent CANNOT review a changeset it doesn't own ─────
    const cs2 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, wkKey, {
      title: 'second deliverable', orchestration_id: orchId,
      file_ops: [{ op: 'upsert', path: 'deliverables/work2.md', content: '# more\n' }],
    });
    const strangerUser = await register(baseUrl, 'stranger');
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: strangerUser.userId, role: 'member' });
    const stranger = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, strangerUser.token, { name: 'stranger' });
    const strangerKey = stranger.data.api_key;
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', strangerKey, {});
    const reviewByStrangerDeny = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${cs2.data.id}/review`, strangerKey, {
      decision: 'approved', auto_merge: false,
    });
    check('non-main stranger denied reviewing changeset', reviewByStrangerDeny.status, 403);

    // ── 4. The task's related-changesets are discoverable ────────────────
    const task = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 't', goal: 'g', assigned_agent_id: wk.data.id, acceptance_criteria: ['x'],
    });
    const csTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, wkKey, {
      title: 'task deliverable', orchestration_id: orchId, task_id: task.data.id,
      file_ops: [{ op: 'upsert', path: 'deliverables/task.md', content: '# t\n' }],
    });
    check('worker creates task-linked changeset', csTask.status, 201);
    const taskDetail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks/${task.data.id}`, owner.token);
    check('task detail exposes related changesets', taskDetail.status, 200);

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
    password: 'ChangesetMerge123!', display_name: prefix,
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
