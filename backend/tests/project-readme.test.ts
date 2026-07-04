import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-readme-test-secret';

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
    const owner = await register(baseUrl, 'readme-owner');
    const other = await register(baseUrl, 'readme-other');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'README API Test',
      description: 'Testing repository README endpoint',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // ─── Happy path: root README.md ───────────────────────────────────────────
    const readmeContent = '# README API Test\n\nThis is the project README.';
    const seedReadme = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: readmeContent,
    });
    assert.equal(seedReadme.status, 201);

    const readme = await api(baseUrl, 'GET', `/v1/projects/${projectId}/readme`, owner.token);
    assert.equal(readme.status, 200);
    assert.equal(readme.data.path, 'README.md');
    assert.equal(readme.data.file_id, seedReadme.data.id);
    assert.equal(readme.data.content, readmeContent);
    assert.equal(readme.data.content_type, 'text/markdown');
    assert.equal(readme.data.branch, null);
    assert.ok(readme.data.updated_at, 'updated_at should be present');

    // ─── Case-insensitive detection with root preference ──────────────────────
    const caseProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'README Case Test',
    });
    assert.equal(caseProject.status, 201);
    const caseProjectId = caseProject.data.id;

    const nestedReadme = await api(baseUrl, 'POST', `/v1/projects/${caseProjectId}/files`, owner.token, {
      path: 'docs/readme.md',
      content: '# Nested README',
    });
    assert.equal(nestedReadme.status, 201);
    const rootReadme = await api(baseUrl, 'POST', `/v1/projects/${caseProjectId}/files`, owner.token, {
      path: 'ReadMe.Md',
      content: '# Root README',
    });
    assert.equal(rootReadme.status, 201);

    const caseReadme = await api(baseUrl, 'GET', `/v1/projects/${caseProjectId}/readme`, owner.token);
    assert.equal(caseReadme.status, 200);
    assert.equal(caseReadme.data.path, 'ReadMe.Md', 'root README should be preferred');
    assert.equal(caseReadme.data.content, '# Root README');

    // ─── Missing README returns deterministic 404 ─────────────────────────────
    const emptyProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'README Empty Test',
    });
    assert.equal(emptyProject.status, 201);
    const emptyReadme = await api(
      baseUrl,
      'GET',
      `/v1/projects/${emptyProject.data.id}/readme`,
      owner.token,
    );
    assert.equal(emptyReadme.status, 404);
    assert.equal(emptyReadme.data.detail, 'README not found');

    // ─── Auth and membership gates ────────────────────────────────────────────
    const noAuth = await api(baseUrl, 'GET', `/v1/projects/${projectId}/readme`);
    assert.equal(noAuth.status, 401);

    const badToken = await api(baseUrl, 'GET', `/v1/projects/${projectId}/readme`, 'invalid-token');
    assert.equal(badToken.status, 401);

    const privateProject = await api(baseUrl, 'POST', '/v1/projects', other.token, {
      name: 'Other Private README Project',
      visibility: 'private',
    });
    assert.equal(privateProject.status, 201);
    const otherReadme = await api(
      baseUrl,
      'POST',
      `/v1/projects/${privateProject.data.id}/files`,
      other.token,
      { path: 'README.md', content: 'Private readme' },
    );
    assert.equal(otherReadme.status, 201);

    const crossReadme = await api(
      baseUrl,
      'GET',
      `/v1/projects/${privateProject.data.id}/readme`,
      owner.token,
    );
    assert.equal(crossReadme.status, 403);

    // ─── Branch context resolves through commit snapshot ──────────────────────
    const branchProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'README Branch Test',
    });
    assert.equal(branchProject.status, 201);
    const branchProjectId = branchProject.data.id;

    const mainChangeset = await api(
      baseUrl,
      'POST',
      `/v1/projects/${branchProjectId}/changesets`,
      owner.token,
      {
        title: 'Add main README',
        file_ops: [{ op: 'upsert', path: 'README.md', content: 'main branch README' }],
      },
    );
    assert.equal(mainChangeset.status, 201);
    const approveMain = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${branchProjectId}/changesets/${mainChangeset.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveMain.status, 200);
    const mergeMain = await api(
      baseUrl,
      'POST',
      `/v1/projects/${branchProjectId}/changesets/${mainChangeset.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeMain.status, 200);

    const branchMainReadme = await api(
      baseUrl,
      'GET',
      `/v1/projects/${branchProjectId}/readme?branch=main`,
      owner.token,
    );
    assert.equal(branchMainReadme.status, 200);
    assert.equal(branchMainReadme.data.content, 'main branch README');
    assert.equal(branchMainReadme.data.branch?.name, 'main');
    assert.ok(branchMainReadme.data.branch?.id, 'branch id should be present');

    // No branch falls back to the default working tree (same content here).
    const noBranchReadme = await api(
      baseUrl,
      'GET',
      `/v1/projects/${branchProjectId}/readme`,
      owner.token,
    );
    assert.equal(noBranchReadme.status, 200);
    assert.equal(noBranchReadme.data.content, 'main branch README');
    assert.equal(noBranchReadme.data.branch, null);

    // Non-existent branch returns 404 consistent with file APIs.
    const missingBranchReadme = await api(
      baseUrl,
      'GET',
      `/v1/projects/${branchProjectId}/readme?branch=does-not-exist`,
      owner.token,
    );
    assert.equal(missingBranchReadme.status, 404);
    assert.equal(missingBranchReadme.data.detail, 'Branch not found: does-not-exist');

    // ─── Branch scoping: feature branch points to older commit snapshot ───────
    const mainCommitId = mergeMain.data.commit.id;
    const featureBranch = await api(
      baseUrl,
      'POST',
      `/v1/projects/${branchProjectId}/branches`,
      owner.token,
      { name: 'feature/readme', source_commit_id: mainCommitId },
    );
    assert.equal(featureBranch.status, 201);

    const updateChangeset = await api(
      baseUrl,
      'POST',
      `/v1/projects/${branchProjectId}/changesets`,
      owner.token,
      {
        title: 'Update main README',
        file_ops: [{
          op: 'upsert',
          path: 'README.md',
          content: 'updated main README',
          base_revision_id: mergeMain.data.commit.snapshot['README.md'].revision_id,
        }],
      },
    );
    assert.equal(updateChangeset.status, 201);
    const approveUpdate = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${branchProjectId}/changesets/${updateChangeset.data.id}/review`,
      owner.token,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(approveUpdate.status, 200);
    const mergeUpdate = await api(
      baseUrl,
      'POST',
      `/v1/projects/${branchProjectId}/changesets/${updateChangeset.data.id}/merge`,
      owner.token,
    );
    assert.equal(mergeUpdate.status, 200);

    const mainAfterUpdate = await api(
      baseUrl,
      'GET',
      `/v1/projects/${branchProjectId}/readme?branch=main`,
      owner.token,
    );
    assert.equal(mainAfterUpdate.status, 200);
    assert.equal(mainAfterUpdate.data.content, 'updated main README');

    const featureReadme = await api(
      baseUrl,
      'GET',
      `/v1/projects/${branchProjectId}/readme?branch=feature%2Freadme`,
      owner.token,
    );
    assert.equal(featureReadme.status, 200);
    assert.equal(featureReadme.data.content, 'main branch README');
    assert.equal(featureReadme.data.branch?.name, 'feature/readme');

    console.log('project-readme tests passed');
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
    password: 'ProjectReadmeTest123!',
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
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
