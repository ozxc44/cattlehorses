import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Use a temp git dir per test run so we exercise the real git backend.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'git-backend-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';
process.env.PROJECT_GIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-git-test-'));

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { gitLog, gitHeadSha, gitReadBlob } = await import('../src/services/project-git.service');
  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  try {
    const owner = await register(baseUrl, 'owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, { name: 'Git Backend Test', visibility: 'public' });
    const projectId = project.data.id;

    // 1. Worker creates a changeset with a deliverable file, merges it.
    const agent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'wk' });
    const key = agent.data.api_key;
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', key, {});

    const content = '# Real Feature\nShipped via real git merge.\n';
    const cs = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, key, {
      title: 'feature deliverable',
      file_ops: [{ op: 'upsert', path: 'deliverables/feature.md', content }],
    });
    check('changeset created', cs.status, 201);
    const csId = cs.data.id;

    const review = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${csId}/review`, owner.token, { decision: 'approved', auto_merge: false });
    check('changeset approved', review.status, 200);
    const merge = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${csId}/merge`, owner.token, {});
    check('changeset merged', merge.status, 200);

    // 2. The commit row carries a real git SHA.
    const gitSha = merge.data.commit?.git_sha ?? null;
    check('commit has real git SHA (40 hex)', typeof gitSha === 'string' && /^[0-9a-f]{40}$/.test(gitSha), true);

    // 3. Real git log has exactly one commit, message matches.
    const log = await gitLog(projectId, 10);
    check('git log has 1 commit', log.length, 1);
    check('git log sha matches commit.gitSha', log[0].oid, gitSha);
    check('git log message includes changeset', (log[0].commit.message || '').includes(csId) || (log[0].commit.message || '').includes('Merge changeset'), true);

    // 4. The file content is retrievable via real git readBlob at HEAD.
    const blob = await gitReadBlob(projectId, 'deliverables/feature.md');
    check('git blob content matches deliverable', blob, content);

    // 5. head sha is stable and equals the log sha.
    check('gitHeadSha matches', await gitHeadSha(projectId), gitSha);

    // 6. The HTTP git-log endpoint exposes the real history.
    const gitLogHttp = await api(baseUrl, 'GET', `/v1/projects/${projectId}/git/log`, owner.token);
    check('GET /git/log 200', gitLogHttp.status, 200);
    check('git/log backend is isomorphic-git', gitLogHttp.data.backend, 'isomorphic-git');
    check('git/log head sha matches', gitLogHttp.data.head, gitSha);
    check('git/log data has 1 entry', (gitLogHttp.data.data || []).length, 1);

    // 7. Second merge appends a real git commit (parent = first).
    const cs2 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, key, {
      title: 'second feature', file_ops: [{ op: 'upsert', path: 'deliverables/feature2.md', content: '# second\n' }],
    });
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${cs2.data.id}/review`, owner.token, { decision: 'approved', auto_merge: false });
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${cs2.data.id}/merge`, owner.token, {});
    const log2 = await gitLog(projectId, 10);
    check('git log has 2 commits after second merge', log2.length, 2);
    check('second commit parent is first sha', log2[0].commit.parent?.[0], gitSha);

    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exit(1);
  } finally {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    await AppDataSource.destroy();
    // cleanup temp git dir
    try { fs.rmSync(process.env.PROJECT_GIT_DIR!, { recursive: true, force: true }); } catch {}
  }
}

async function register(baseUrl: string, prefix: string) {
  const r = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@x.invalid`,
    password: 'GitBackend123!', display_name: prefix,
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
