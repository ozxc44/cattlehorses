import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'reassign-history-test-secret';
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
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // ── Setup: project, agents, orchestration ────────────────────────────
    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');
    const w1User = await register(baseUrl, 'w1');
    const w2User = await register(baseUrl, 'w2');
    const w3User = await register(baseUrl, 'w3');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Reassign History Test', visibility: 'public',
    });
    const projectId = project.data.id;
    for (const u of [pmUser, w1User, w2User, w3User]) {
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: u.userId, role: 'member' });
    }

    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm' });
    const pmKey = pm.data.api_key;
    const pmId = pm.data.id;
    const w1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, w1User.token, { name: 'w1' });
    const w1Key = w1.data.api_key;
    const w1Id = w1.data.id;
    const w2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, w2User.token, { name: 'w2' });
    const w2Key = w2.data.api_key;
    const w2Id = w2.data.id;
    const w3 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, w3User.token, { name: 'w3' });
    const w3Key = w3.data.api_key;
    const w3Id = w3.data.id;

    for (const k of [pmKey, w1Key, w2Key, w3Key]) {
      await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', k, {});
    }
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmId });

    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'history orch', objective: 'test reassignment history chain',
      main_agent_id: pmId, worker_agent_ids: [w1Id, w2Id, w3Id],
    });
    const orchId = orch.data.id;

    // ── Phase 1: original task dispatched to w1 ──────────────────────────
    const t1 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'chain-task', goal: 'build feature X', assigned_agent_id: w1Id, acceptance_criteria: ['done'],
    });
    check('original task created', t1.status, 201);
    const t1Id = t1.data.id;

    // ── Phase 2: reassign t1 from w1 → w2 ───────────────────────────────
    const r1 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t1Id}/reassign`, pmKey, {
      new_agent_id: w2Id, reason: 'w1 too slow',
    });
    check('first reassign succeeds', r1.status, 201);
    const t2Id = r1.data.id;

    // Old task should be cancelled with cancelledAt set.
    const oldTask1 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t1Id}`, owner.token);
    check('old task cancelled', oldTask1.data.status, 'cancelled');
    check('old task has cancelled_at', oldTask1.data.cancelled_at !== null, true);

    // ── Phase 3: reassign t2 from w2 → w3 ───────────────────────────────
    const r2 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t2Id}/reassign`, pmKey, {
      new_agent_id: w3Id, reason: 'w2 also slow',
    });
    check('second reassign succeeds', r2.status, 201);
    const t3Id = r2.data.id;

    // ── Phase 4: history on the latest task (t3) ────────────────────────
    const hist3 = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t3Id}/history`, w3Key);
    check('history 200 on latest', hist3.status, 200);
    check('lineage has 3 entries', hist3.data.data.length, 3);
    check('lineage[0] is t1', hist3.data.data[0].task_id, t1Id);
    check('lineage[0] status cancelled', hist3.data.data[0].status, 'cancelled');
    check('lineage[0] assigned w1', hist3.data.data[0].assigned_agent, w1Id);
    check('lineage[0] cancel_reason', hist3.data.data[0].cancel_reason, 'w1 too slow');
    check('lineage[0] cancelled_at set', hist3.data.data[0].cancelled_at !== null, true);
    check('lineage[1] is t2', hist3.data.data[1].task_id, t2Id);
    check('lineage[1] status cancelled', hist3.data.data[1].status, 'cancelled');
    check('lineage[1] assigned w2', hist3.data.data[1].assigned_agent, w2Id);
    check('lineage[1] cancel_reason', hist3.data.data[1].cancel_reason, 'w2 also slow');
    check('lineage[2] is t3', hist3.data.data[2].task_id, t3Id);
    check('lineage[2] status dispatched', hist3.data.data[2].status, 'dispatched');
    check('lineage[2] assigned w3', hist3.data.data[2].assigned_agent, w3Id);
    check('lineage[2] cancel_reason null', hist3.data.data[2].cancel_reason, null);
    check('lineage[2] cancelled_at null', hist3.data.data[2].cancelled_at, null);

    // ── Phase 5: history on the middle task (t2) ────────────────────────
    const hist2 = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t2Id}/history`, w2Key);
    check('history on middle task also returns 3', hist2.data.data.length, 3);
    check('middle history starts with t1', hist2.data.data[0].task_id, t1Id);
    check('middle history ends with t3', hist2.data.data[2].task_id, t3Id);

    // ── Phase 6: history on the original task (t1) ──────────────────────
    const hist1 = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t1Id}/history`, w1Key);
    check('history on original also returns 3', hist1.data.data.length, 3);
    check('original history starts with t1', hist1.data.data[0].task_id, t1Id);
    check('original history ends with t3', hist1.data.data[2].task_id, t3Id);

    // ── Phase 7: history on a task with no reassignments ────────────────
    const solo = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'solo-task', goal: 'standalone', assigned_agent_id: w1Id, acceptance_criteria: ['ok'],
    });
    const soloHist = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${solo.data.id}/history`, pmKey);
    check('solo task history 200', soloHist.status, 200);
    check('solo task history has 1 entry', soloHist.data.data.length, 1);
    check('solo task id matches', soloHist.data.data[0].task_id, solo.data.id);
    check('solo task cancel_reason null', soloHist.data.data[0].cancel_reason, null);

    // ── Phase 8: RBAC — unrelated agent cannot view ─────────────────────
    // w1 is part of the orchestration (as original assignee), so it CAN view.
    // Create a totally separate agent that is NOT in the orchestration.
    const outsiderUser = await register(baseUrl, 'outsider');
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: outsiderUser.userId, role: 'member' });
    const outsider = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, outsiderUser.token, { name: 'outsider' });
    const outsiderKey = outsider.data.api_key;
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', outsiderKey, {});
    const outsiderHist = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t3Id}/history`, outsiderKey);
    check('outsider denied history', outsiderHist.status, 403);

    // ── Phase 9: 404 for non-existent task ──────────────────────────────
    const notFound = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/00000000-0000-0000-0000-000000000000/history`, pmKey);
    check('non-existent task 404', notFound.status, 404);

    // ── Phase 10: verify metadata links ─────────────────────────────────
    const t1Detail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t1Id}`, owner.token);
    const t1Meta = t1Detail.data.metadata ?? {};
    check('t1 metadata.reassigned_to is w2 agent', t1Meta.reassigned_to, w2Id);
    check('t1 metadata.reassigned_to_task_id is t2', t1Meta.reassigned_to_task_id, t2Id);

    const t2Detail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t2Id}`, owner.token);
    const t2Meta = t2Detail.data.metadata ?? {};
    check('t2 metadata.reassigned_to is w3 agent', t2Meta.reassigned_to, w3Id);
    check('t2 metadata.reassigned_to_task_id is t3', t2Meta.reassigned_to_task_id, t3Id);

    const t3Detail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t3Id}`, owner.token);
    const t3Meta = t3Detail.data.metadata ?? {};
    check('t3 metadata.reassigned_from is t2', t3Meta.reassigned_from, t2Id);

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
    password: 'ReassignHist123!', display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function apiWithKey(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

main().catch((err) => { console.error(err); process.exit(1); });
