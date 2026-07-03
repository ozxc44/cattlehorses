import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-verification-test-secret';
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

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, { name: 'Verification Gate Test', visibility: 'public' });
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
      title: 'verification orch', objective: 'verify task completion gate',
      main_agent_id: pm.data.id, worker_agent_ids: [wk.data.id],
    });
    const orchId = orch.data.id;

    // ── (a) result_md too short (<20 chars) should be rejected ───────────
    const shortTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'short result task', goal: 'submit a short result', assigned_agent_id: wk.data.id,
    });
    check('dispatch short-result task', shortTask.status, 201);
    const shortComplete = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${shortTask.data.id}/complete`, wkKey, {
      result_md: 'ok', evidence: { ok: true }, status: 'ready_for_review',
    });
    check('short result rejected status', shortComplete.status, 422);
    check('short result rejected code', shortComplete.data.code, 'VERIFICATION_FAILED');
    check('short result failure count', Array.isArray(shortComplete.data.failures) && shortComplete.data.failures.length > 0, true);

    // ── (b) result_md >=20 chars, no criteria -> success ─────────────────
    const noCriteriaTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'no criteria task', goal: 'submit a valid result with no criteria', assigned_agent_id: wk.data.id,
    });
    check('dispatch no-criteria task', noCriteriaTask.status, 201);
    const noCriteriaComplete = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${noCriteriaTask.data.id}/complete`, wkKey, {
      result_md: 'This is a complete result.', evidence: { ok: true }, status: 'ready_for_review',
    });
    check('no-criteria result accepted status', noCriteriaComplete.status, 200);
    check('no-criteria result accepted status field', noCriteriaComplete.data.status, 'ready_for_review');

    // ── (c) acceptance criteria enforcement ──────────────────────────────
    const criteriaTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'criteria task', goal: 'satisfy the acceptance criteria', assigned_agent_id: wk.data.id,
      acceptance_criteria: ['add login route'],
    });
    check('dispatch criteria task', criteriaTask.status, 201);

    // Missing the criterion -> 422
    const missingCriteriaComplete = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${criteriaTask.data.id}/complete`, wkKey, {
      result_md: 'This result is long enough but does not mention the required topic.',
      evidence: { ok: true }, status: 'ready_for_review',
    });
    check('missing criterion rejected status', missingCriteriaComplete.status, 422);
    check('missing criterion rejected code', missingCriteriaComplete.data.code, 'VERIFICATION_FAILED');
    check('missing criterion failure includes criterion',
      Array.isArray(missingCriteriaComplete.data.failures) && missingCriteriaComplete.data.failures.some((f: string) => f.includes('add login route')),
      true);

    // Includes the criterion -> success
    const satisfiedComplete = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${criteriaTask.data.id}/complete`, wkKey, {
      result_md: 'I have implemented the add login route endpoint with tests.',
      evidence: { ok: true }, status: 'ready_for_review',
    });
    check('satisfied criterion accepted status', satisfiedComplete.status, 200);
    check('satisfied criterion accepted status field', satisfiedComplete.data.status, 'ready_for_review');

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
    password: 'Verify123!', display_name: prefix,
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
