import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'changeset-diff-test-secret';

// R28a: GET /v1/projects/:pid/changesets/:cid/diff — unified diff preview.
// Each file_op must surface { path, diff, lines_added, lines_removed,
// total_changes } where the diff is a line-level LCS unified diff. New files
// are all-additions, deletes are all-removals, and ViewProject gates access.
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
    const owner = await register(baseUrl, 'diff-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Changeset Diff Test',
      description: 'R28a unified diff preview',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // ── (1) Upsert on an existing file: mixed add/remove ──────────────────
    const baseFile = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'doc.md',
      content: 'line1\nline2\nline3',
      message: 'seed',
    });
    assert.equal(baseFile.status, 201);

    const upsertCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Modify doc',
      file_ops: [{
        op: 'upsert',
        path: 'doc.md',
        content: 'line1\nline2-modified\nline3\nline4',
        base_revision_id: baseFile.data.current_revision_id,
      }],
    });
    assert.equal(upsertCs.status, 201);

    const upsertDiff = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${upsertCs.data.id}/diff`,
      owner.token,
    );
    assert.equal(upsertDiff.status, 200);
    assert.equal(upsertDiff.data.changeset.id, upsertCs.data.id);
    assert.equal(upsertDiff.data.files.length, 1);

    const upsertEntry = upsertDiff.data.files[0];
    assert.equal(upsertEntry.path, 'doc.md');
    // New unified-diff fields are present.
    assert.equal(typeof upsertEntry.diff, 'string');
    assert.equal(upsertEntry.lines_added, 2, 'line2-modified + line4 added');
    assert.equal(upsertEntry.lines_removed, 1, 'line2 removed');
    assert.equal(upsertEntry.total_changes, 3);
    assert.equal(upsertEntry.total_changes, upsertEntry.lines_added + upsertEntry.lines_removed);
    // Backward-compatible fields survive.
    assert.equal(upsertEntry.op, 'upsert');
    assert.equal(upsertEntry.old_content, 'line1\nline2\nline3');
    assert.equal(upsertEntry.new_content, 'line1\nline2-modified\nline3\nline4');

    const upsertBody = upsertEntry.diff.split('\n');
    assert.ok(upsertEntry.diff.includes('@@'), 'diff has a hunk header');
    assert.ok(upsertBody.includes(' line1'), 'context line preserved');
    assert.ok(upsertBody.includes(' line3'), 'context line preserved');
    assert.ok(upsertBody.includes('-line2'), 'removed line marked');
    assert.ok(upsertBody.includes('+line2-modified'), 'added line marked');
    assert.ok(upsertBody.includes('+line4'), 'appended line marked');
    // No spurious whole-file rewrite: unchanged lines are context, not +/- .
    assert.ok(!upsertBody.includes('+line1'), 'unchanged line not shown as add');
    assert.ok(!upsertBody.includes('-line1'), 'unchanged line not shown as delete');

    // ── (2) New file (upsert, no base): all additions ─────────────────────
    const newFileCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Add new file',
      file_ops: [{
        op: 'upsert',
        path: 'new.md',
        content: 'new1\nnew2',
      }],
    });
    assert.equal(newFileCs.status, 201);

    const newFileDiff = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${newFileCs.data.id}/diff`,
      owner.token,
    );
    assert.equal(newFileDiff.status, 200);
    const newEntry = newFileDiff.data.files[0];
    assert.equal(newEntry.path, 'new.md');
    assert.equal(newEntry.lines_added, 2);
    assert.equal(newEntry.lines_removed, 0, 'new file is all-additions');
    assert.equal(newEntry.total_changes, 2);
    assert.ok(newEntry.diff.includes('@@ -0,0 +1,2 @@'), 'pure-addition hunk header');
    const newBody = newEntry.diff.split('\n');
    assert.ok(newBody.includes('+new1'));
    assert.ok(newBody.includes('+new2'));
    assert.ok(!newBody.some((l: string) => l.startsWith('-')), 'no removed lines for a new file');

    // ── (3) Delete: all removals ──────────────────────────────────────────
    const deleteSeed = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'gone.md',
      content: 'del1\ndel2\ndel3',
      message: 'seed delete target',
    });
    assert.equal(deleteSeed.status, 201);
    const deleteCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Delete file',
      file_ops: [{ op: 'delete', path: 'gone.md', base_revision_id: deleteSeed.data.current_revision_id }],
    });
    assert.equal(deleteCs.status, 201);

    const deleteDiff = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${deleteCs.data.id}/diff`,
      owner.token,
    );
    assert.equal(deleteDiff.status, 200);
    const deleteEntry = deleteDiff.data.files[0];
    assert.equal(deleteEntry.path, 'gone.md');
    assert.equal(deleteEntry.lines_added, 0, 'delete is all-removals');
    assert.equal(deleteEntry.lines_removed, 3);
    assert.equal(deleteEntry.total_changes, 3);
    assert.ok(deleteEntry.diff.includes('@@ -1,3 +0,0 @@'), 'pure-removal hunk header');
    const delBody = deleteEntry.diff.split('\n');
    assert.ok(delBody.includes('-del1'));
    assert.ok(delBody.includes('-del2'));
    assert.ok(delBody.includes('-del3'));
    assert.ok(!delBody.some((l: string) => l.startsWith('+')), 'no added lines for a delete');

    // ── (4) Multi-op changeset: one entry per file_op, order preserved ─────
    const multiCs = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Multi op',
      file_ops: [
        { op: 'upsert', path: 'a.md', content: 'aaa' },
        { op: 'upsert', path: 'b.md', content: 'bbb' },
      ],
    });
    assert.equal(multiCs.status, 201);
    const multiDiff = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${multiCs.data.id}/diff`,
      owner.token,
    );
    assert.equal(multiDiff.status, 200);
    assert.equal(multiDiff.data.files.length, 2);
    assert.equal(multiDiff.data.files[0].path, 'a.md');
    assert.equal(multiDiff.data.files[1].path, 'b.md');

    // ── (5) Auth: ViewProject required ────────────────────────────────────
    const noToken = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets/${upsertCs.data.id}/diff`);
    assert.equal(noToken.status, 401, 'missing auth → 401');

    const stranger = await register(baseUrl, 'diff-stranger');
    const forbidden = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${upsertCs.data.id}/diff`,
      stranger.token,
    );
    assert.equal(forbidden.status, 403, 'non-member → 403');

    // ── (6) Unknown changeset → 404 ───────────────────────────────────────
    const missing = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/00000000-0000-0000-0000-000000000000/diff`,
      owner.token,
    );
    assert.equal(missing.status, 404);

    console.log('changeset-diff tests passed');
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
    password: 'ChangesetDiffTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
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
  let data: any = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
