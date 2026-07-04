import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'changeset-preflight-test-secret';

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
    const owner = await register(baseUrl, 'preflight-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Changeset Preflight Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Create the base file and capture its revision id.
    const baseFile = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: '# Preflight\n\nv1',
      message: 'Initial README',
    });
    assert.equal(baseFile.status, 201);
    const baseRevisionId = baseFile.data.current_revision_id;

    // Clean changeset built on the current file revision.
    const cleanCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Clean update',
      file_ops: [{ op: 'upsert', path: 'README.md', content: '# Preflight\n\nv2', base_revision_id: baseRevisionId }],
    });
    check('create clean changeset', cleanCs.status, 201);

    const cleanPreflight = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${cleanCs.data.id}/preflight`, owner.token);
    check('clean preflight status', cleanPreflight.status, 200);
    check('clean merge_status', cleanPreflight.data.merge_status, 'clean');
    check('clean issues empty', Array.isArray(cleanPreflight.data.issues) && cleanPreflight.data.issues.length === 0, true);
    check('clean changeset serialization includes merge_status', cleanPreflight.data.changeset.merge_status, 'clean');

    // Stale changeset: edit the file out-of-band so the base revision id ages.
    const staleCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Stale update',
      file_ops: [{ op: 'upsert', path: 'README.md', content: '# Preflight\n\nstale', base_revision_id: baseRevisionId }],
    });
    check('create stale changeset', staleCs.status, 201);

    const directEdit = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: '# Preflight\n\nout-of-band',
      base_revision_id: baseRevisionId,
      message: 'Out of band edit',
    });
    check('out-of-band edit', directEdit.status, 200);

    const stalePreflight = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${staleCs.data.id}/preflight`, owner.token);
    check('stale preflight status', stalePreflight.status, 200);
    check('stale merge_status', stalePreflight.data.merge_status, 'stale');
    check('stale issues non-empty', Array.isArray(stalePreflight.data.issues) && stalePreflight.data.issues.length > 0, true);
    check('stale issue reason', stalePreflight.data.issues[0]?.reason, 'base_revision_id is stale');
    check('stale changeset serialization updated', stalePreflight.data.changeset.merge_status, 'stale');

    // Conflict: a rename operation whose target path already exists.
    const renameFrom = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'rename-from.md',
      content: 'rename me',
      message: 'Seed rename source',
    });
    check('create rename source', renameFrom.status, 201);
    const renameTarget = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'rename-target.md',
      content: 'target exists',
      message: 'Seed rename target',
    });
    check('create rename target', renameTarget.status, 201);

    const conflictCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Rename to existing path',
      file_ops: [{ op: 'rename', path: 'rename-from.md', to_path: 'rename-target.md', base_revision_id: renameFrom.data.current_revision_id }],
    });
    check('create conflict changeset', conflictCs.status, 201);

    const conflictPreflight = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${conflictCs.data.id}/preflight`, owner.token);
    check('conflict preflight status', conflictPreflight.status, 200);
    check('conflict merge_status', conflictPreflight.data.merge_status, 'conflict');
    check('conflict issues non-empty', Array.isArray(conflictPreflight.data.issues) && conflictPreflight.data.issues.length > 0, true);
    check('conflict issue reason', conflictPreflight.data.issues[0]?.reason, 'rename target already exists');

    // needs_rebase: advance branch head via a second merge so the changeset base commit is behind.
    const currentReadme = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${baseFile.data.id}`, owner.token);
    check('get current readme', currentReadme.status, 200);

    const rebaseCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Needs rebase update',
      file_ops: [{ op: 'upsert', path: 'README.md', content: '# Preflight\n\nrebase', base_revision_id: currentReadme.data.current_revision_id }],
    });
    check('create rebase changeset', rebaseCs.status, 201);

    const advanceCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Advance branch head',
      file_ops: [{ op: 'upsert', path: 'advance.md', content: 'advance' }],
    });
    check('create advance changeset', advanceCs.status, 201);

    const advanceReview = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${advanceCs.data.id}/review`, owner.token, { decision: 'approved', auto_merge: false });
    check('approve advance changeset', advanceReview.status, 200);

    const advanceMerge = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${advanceCs.data.id}/merge`, owner.token);
    check('merge advance changeset', advanceMerge.status, 200);

    const rebasePreflight = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${rebaseCs.data.id}/preflight`, owner.token);
    check('needs_rebase preflight status', rebasePreflight.status, 200);
    check('needs_rebase merge_status', rebasePreflight.data.merge_status, 'needs_rebase');
    check('needs_rebase issue reason', rebasePreflight.data.issues[0]?.reason, 'branch head has advanced; rebase before merge');

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
    password: 'Preflight123!', display_name: prefix,
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
main().catch((e) => { console.error(e); process.exit(1); });
