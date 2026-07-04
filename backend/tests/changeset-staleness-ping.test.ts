import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'changeset-staleness-ping-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';
process.env.CHANGESET_STALE_MINUTES = '10';

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const http = await import('node:http');
  const { ProjectChangeset, ProjectChangesetStatus } = await import('../src/entities/project-changeset.entity');
  const { runChangesetStalenessPing } = await import('../src/services/changeset-staleness-ping.service');
  const { AgentInboxItem } = await import('../src/entities/agent-inbox-item.entity');
  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const owner = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
      email: `csp-${Date.now()}@x.invalid`, password: 'CspTest123!', display_name: 'csp',
    });
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.data.access_token, { name: 'CSP', visibility: 'public' });
    const projectId = project.data.id;
    const agent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.data.access_token, { name: 'pm' });
    const pmKey = agent.data.api_key;
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', pmKey, {});
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.data.access_token, { main_agent_id: agent.data.id });
    const mainAgentId = agent.data.id;

    const changesetRepo = AppDataSource.getRepository(ProjectChangeset);
    const inboxRepo = AppDataSource.getRepository(AgentInboxItem);

    // 1. Fresh submitted changeset (< 10 min) → no ping
    const freshCs = changesetRepo.create({
      projectId,
      branchId: (await ensureDefaultBranch(baseUrl, owner.data.access_token, projectId)).id,
      title: 'fresh changeset',
      status: ProjectChangesetStatus.SUBMITTED,
      fileOps: [],
      updatedAt: new Date(Date.now() - 5 * 60_000),
    });
    await changesetRepo.save(freshCs);

    let result = await runChangesetStalenessPing();
    check('fresh changeset → no ping', result.pinged, 0);

    // 2. Stale submitted changeset (> 10 min) → PM inbox item created
    const staleCs = changesetRepo.create({
      projectId,
      branchId: freshCs.branchId,
      title: 'stale changeset',
      status: ProjectChangesetStatus.SUBMITTED,
      fileOps: [],
      updatedAt: new Date(Date.now() - 25 * 60_000),
    });
    await changesetRepo.save(staleCs);

    result = await runChangesetStalenessPing();
    check('stale changeset → 1 ping', result.pinged, 1);

    const reloadedStale = await changesetRepo.findOneBy({ id: staleCs.id });
    check('stale changeset has staleNotifiedAt set', !!reloadedStale!.staleNotifiedAt, true);

    const inboxItems = await inboxRepo.find({ where: { recipientAgentId: mainAgentId, eventType: 'changeset_stale' } });
    check('inbox has 1 changeset_stale item', inboxItems.length, 1);
    check('inbox title contains changeset title', inboxItems[0].title.includes('stale changeset'), true);
    check('inbox event_type is changeset_stale', inboxItems[0].eventType, 'changeset_stale');

    // 3. Already-reviewed (approved) changeset → no ping
    const reviewedCs = changesetRepo.create({
      projectId,
      branchId: freshCs.branchId,
      title: 'already reviewed',
      status: ProjectChangesetStatus.APPROVED,
      fileOps: [],
      updatedAt: new Date(Date.now() - 25 * 60_000),
    });
    await changesetRepo.save(reviewedCs);

    result = await runChangesetStalenessPing();
    check('approved changeset → no ping (not in stale statuses)', result.pinged, 0);

    // 4. Stale merge_ready changeset (> 10 min) → PM inbox item created
    const staleMergeReadyCs = changesetRepo.create({
      projectId,
      branchId: freshCs.branchId,
      title: 'merge ready stale',
      status: ProjectChangesetStatus.MERGE_READY,
      fileOps: [],
      updatedAt: new Date(Date.now() - 20 * 60_000),
    });
    await changesetRepo.save(staleMergeReadyCs);

    result = await runChangesetStalenessPing();
    check('stale merge_ready → 1 more ping', result.pinged, 1);

    // 5. Idempotent: second sweep marks nothing new (already notified)
    result = await runChangesetStalenessPing();
    check('idempotent: second sweep → 0 pings', result.pinged, 0);

    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exit(1);
  } finally {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    await AppDataSource.destroy();
  }
}

async function ensureDefaultBranch(baseUrl: string, token: string, projectId: string): Promise<{ id: string }> {
  const r = await api(baseUrl, 'GET', `/v1/projects/${projectId}/branches`, token);
  return r.data.data[0];
}

async function api(baseUrl: string, method: string, path: string, token: string | undefined, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

async function apiWithKey(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

main().catch((e) => { console.error(e); process.exit(1); });
