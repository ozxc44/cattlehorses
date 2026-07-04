import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'alert-test-secret';

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { Agent, AgentSmokeHealth, AgentStatus } = await import('../src/entities/agent.entity');
  const { ProjectChangeset, ProjectChangesetStatus } = await import('../src/entities/project-changeset.entity');
  const { LoopAlert } = await import('../src/entities/loop-alert.entity');
  const { alertService, stopAlertSweep } = await import('../src/services/alert.service');

  await AppDataSource.initialize();
  stopAlertSweep();

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const owner = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
      email: `alert-${Date.now()}@x.invalid`, password: 'AlertTest123!', display_name: 'alert-owner',
    });
    const token = owner.data.access_token;

    const project = await api(baseUrl, 'POST', '/v1/projects', token, { name: 'AlertTest', visibility: 'public' });
    const projectId = project.data.id;

    const alertRepo = AppDataSource.getRepository(LoopAlert);
    const agentRepo = AppDataSource.getRepository(Agent);
    const changesetRepo = AppDataSource.getRepository(ProjectChangeset);

    // ── 1. GET /v1/projects/:pid/alerts returns empty initially ──
    const emptyList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/alerts`, token);
    check('GET alerts returns 200', emptyList.status, 200);
    check('GET alerts returns empty list', emptyList.data.data.length, 0);

    // ── 2. Worker unhealthy for >5min → alert created ──
    const agent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, token, { name: 'unhealthy-worker' });
    const agentId = agent.data.id;

    await agentRepo.update(agentId, {
      healthStatus: AgentSmokeHealth.UNHEALTHY,
      healthLastError: 'heartbeat stale',
      healthCheckedAt: new Date(Date.now() - 10 * 60_000),
    });

    const sweep1 = await alertService.runSweep(projectId);
    check('worker_unhealthy alert created', sweep1.length >= 1, true);
    const workerAlert = sweep1.find((a) => a.type === 'worker_unhealthy');
    check('worker_unhealthy alert exists', !!workerAlert, true);
    check('worker_unhealthy level is warning', workerAlert!.level, 'warning');
    check('worker_unhealthy status is active', workerAlert!.status, 'active');

    // Idempotent: second sweep doesn't duplicate
    const sweep1b = await alertService.runSweep(projectId);
    const workerAlerts = sweep1b.filter((a) => a.type === 'worker_unhealthy');
    check('idempotent: no duplicate worker_unhealthy', workerAlerts.length, 0);

    // ── 3. Changeset stuck >30min → alert created ──
    const branch = await ensureDefaultBranch(baseUrl, token, projectId);
    const staleCs = changesetRepo.create({
      projectId,
      branchId: branch.id,
      title: 'stuck-changeset',
      status: ProjectChangesetStatus.SUBMITTED,
      fileOps: [],
      updatedAt: new Date(Date.now() - 45 * 60_000),
    });
    await changesetRepo.save(staleCs);

    const sweep2 = await alertService.runSweep(projectId);
    const csAlert = sweep2.find((a) => a.type === 'changeset_stuck');
    check('changeset_stuck alert created', !!csAlert, true);
    check('changeset_stuck level is warning', csAlert!.level, 'warning');
    check('changeset_stuck detail mentions changeset', csAlert!.detail.includes('stuck-changeset'), true);

    // ── 4. CI failed → alert created ──
    const failedCs = changesetRepo.create({
      projectId,
      branchId: branch.id,
      title: 'ci-fail-changeset',
      status: ProjectChangesetStatus.REJECTED,
      fileOps: [],
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    await changesetRepo.save(failedCs);

    const sweep3 = await alertService.runSweep(projectId);
    const ciAlert = sweep3.find((a) => a.type === 'ci_failed');
    check('ci_failed alert created', !!ciAlert, true);
    check('ci_failed level is critical', ciAlert!.level, 'critical');

    // ── 5. GET /v1/projects/:pid/alerts lists all active alerts ──
    const listResult = await api(baseUrl, 'GET', `/v1/projects/${projectId}/alerts`, token);
    check('GET alerts returns all active alerts', listResult.data.data.length >= 3, true);
    const types = listResult.data.data.map((a: any) => a.type).sort();
    check('alerts include worker_unhealthy', types.includes('worker_unhealthy'), true);
    check('alerts include changeset_stuck', types.includes('changeset_stuck'), true);
    check('alerts include ci_failed', types.includes('ci_failed'), true);

    // ── 6. POST /v1/projects/:pid/alerts/:id/ack ──
    const alertToAck = listResult.data.data.find((a: any) => a.type === 'worker_unhealthy');
    const ackResult = await api(baseUrl, 'POST', `/v1/projects/${projectId}/alerts/${alertToAck.id}/ack`, token);
    check('ack returns 200', ackResult.status, 200);
    check('ack sets status to acknowledged', ackResult.data.data.status, 'acknowledged');
    check('ack sets acked_by', !!ackResult.data.data.acked_by, true);
    check('ack sets acked_at', !!ackResult.data.data.acked_at, true);

    // Acknowledged alert no longer appears in active list
    const afterAck = await api(baseUrl, 'GET', `/v1/projects/${projectId}/alerts`, token);
    const ackedStillThere = afterAck.data.data.find((a: any) => a.id === alertToAck.id);
    check('acknowledged alert removed from active list', ackedStillThere, undefined);

    // ── 7. Ack non-existent alert → 404 ──
    const badAck = await api(baseUrl, 'POST', `/v1/projects/${projectId}/alerts/00000000-0000-0000-0000-000000000000/ack`, token);
    check('ack non-existent alert → 404', badAck.status, 404);

    // ── 8. Alerts scoped to project (other project has none) ──
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', token, { name: 'OtherProject', visibility: 'public' });
    const otherList = await api(baseUrl, 'GET', `/v1/projects/${otherProject.data.id}/alerts`, token);
    check('other project has no alerts', otherList.data.data.length, 0);

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

main().catch((e) => { console.error(e); process.exit(1); });
