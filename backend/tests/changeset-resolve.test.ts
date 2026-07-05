import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'changeset-resolve-test-secret';

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
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const owner = await register(baseUrl, 'resolve-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Resolve Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const file1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: '# Hello\n\nline1\nline2\nline3',
      message: 'Initial',
    });
    assert.equal(file1.status, 201);
    const baseRevisionId = file1.data.current_revision_id;

    const cs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Update README',
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Hello\n\nline1-modified\nline2\nline3',
          base_revision_id: baseRevisionId,
        },
      ],
    });
    assert.equal(cs.status, 201);
    const changesetId = cs.data.id;

    // Out-of-band edit modifies the SAME line → produces true conflict on merge
    const oob = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: '# Hello\n\nline1-OOB\nline2\nline3',
      base_revision_id: baseRevisionId,
      message: 'Out of band same line',
    });
    assert.equal(oob.status, 200);

    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${changesetId}/review`, owner.token, {
      decision: 'approved',
      auto_merge: false,
    });
    const mergeAttempt = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${changesetId}/merge`, owner.token);
    assert.equal(mergeAttempt.status, 409);
    check('changeset is in conflict state', mergeAttempt.data.changeset.status, 'conflict');

    // ── Test 1: GET-like (no resolutions) → 3-way merge view ──
    const view = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${changesetId}/resolve-conflict`, owner.token, {});
    check('resolve view returns 200', view.status, 200);
    check('resolve view has files array', Array.isArray(view.data.files), true);
    check('resolve view has 1 file entry', view.data.files.length, 1);

    const entry = view.data.files[0];
    check('entry path is README.md', entry.path, 'README.md');
    check('entry has base content', entry.base, '# Hello\n\nline1\nline2\nline3');
    check('entry has head content', entry.head, '# Hello\n\nline1-OOB\nline2\nline3');
    check('entry has proposed content', entry.proposed, '# Hello\n\nline1-modified\nline2\nline3');
    check('entry has merge_suggestion', typeof entry.merge_suggestion, 'string');
    check('entry conflict is true (overlapping changes)', entry.conflict, true);

    // ── Test 2: POST with resolutions → updates changeset ──
    const resolved = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${changesetId}/resolve-conflict`, owner.token, {
      resolutions: [
        {
          path: 'README.md',
          content: '# Hello\n\nline1-resolved\nline2\nline3',
        },
      ],
    });
    check('resolve returns 200', resolved.status, 200);
    check('changeset status reset to submitted', resolved.data.status, 'submitted');
    check('conflicts cleared', resolved.data.conflicts, null);
    check('merge_status reset to clean', resolved.data.merge_status, 'clean');
    check('file_ops updated', resolved.data.file_ops.length, 1);
    check('file_ops content is resolved', resolved.data.file_ops[0].content, '# Hello\n\nline1-resolved\nline2\nline3');
    check('base_revision_id updated to current', resolved.data.file_ops[0].base_revision_id, oob.data.current_revision_id);

    // ── Test 3: Resolved changeset can now merge ──
    const reapproved = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${changesetId}/review`, owner.token, {
      decision: 'approved',
      auto_merge: false,
    });
    check('re-approved after resolve', reapproved.status, 200);
    const mergeAfterResolve = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${changesetId}/merge`, owner.token);
    check('merge succeeds after resolve', mergeAfterResolve.status, 200);
    check('merged status', mergeAfterResolve.data.changeset.status, 'merged');

    // ── Test 4: Cannot resolve non-conflict changeset ──
    const cs2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Fresh changeset',
      file_ops: [{ op: 'upsert', path: 'new-file.md', content: '# New' }],
    });
    assert.equal(cs2.status, 201);
    const viewNonConflict = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${cs2.data.id}/resolve-conflict`, owner.token, {});
    check('non-conflict changeset returns 409', viewNonConflict.status, 409);

    // ── Test 5: 404 for missing changeset ──
    const missing = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/00000000-0000-0000-0000-000000000000/resolve-conflict`, owner.token, {});
    check('missing changeset returns 404', missing.status, 404);

    // ── Test 6: Stale changeset (base_revision_id behind HEAD) ──
    // Create a file, then a changeset, then edit the file out-of-band so the
    // changeset's base_revision_id becomes stale (but don't attempt merge, so
    // status stays SUBMITTED, not CONFLICT).
    const staleFile = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'stale-test.md',
      content: '# Stale v1',
      message: 'Create stale test file',
    });
    assert.equal(staleFile.status, 201);
    const staleBaseRev = staleFile.data.current_revision_id;

    const staleCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Stale test changeset',
      file_ops: [{
        op: 'upsert',
        path: 'stale-test.md',
        content: '# Stale proposed',
        base_revision_id: staleBaseRev,
      }],
    });
    assert.equal(staleCs.status, 201);

    // Edit file out-of-band to make the changeset's base stale
    const staleOob = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'stale-test.md',
      content: '# Stale v2 (oob)',
      base_revision_id: staleBaseRev,
      message: 'Out of band stale',
    });
    assert.equal(staleOob.status, 200);

    const staleView = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${staleCs.data.id}/resolve-conflict`, owner.token, {});
    check('stale changeset returns 200', staleView.status, 200);
    check('stale view has files', staleView.data.files.length, 1);
    check('stale entry base is v1', staleView.data.files[0].base, '# Stale v1');
    check('stale entry head is v2', staleView.data.files[0].head, '# Stale v2 (oob)');
    check('stale entry proposed', staleView.data.files[0].proposed, '# Stale proposed');

    // Resolve the stale changeset
    const staleResolved = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${staleCs.data.id}/resolve-conflict`, owner.token, {
      resolutions: [{ path: 'stale-test.md', content: '# Stale resolved' }],
    });
    check('stale resolve returns 200', staleResolved.status, 200);
    check('stale resolve resets to submitted', staleResolved.data.status, 'submitted');

    console.log(`\nchangeset-resolve tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.close();
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ResolveTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

main().catch((err) => { console.error(err); process.exit(1); });
