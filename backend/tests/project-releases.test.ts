import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-releases-test-secret';

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
    const owner = await register(baseUrl, 'release-owner');
    const admin = await register(baseUrl, 'release-admin');
    const member = await register(baseUrl, 'release-member');
    const viewer = await register(baseUrl, 'release-viewer');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Release Test Project',
      description: 'Testing project releases',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: admin.userId, role: 'admin' })).status, 201);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: member.userId, role: 'member' })).status, 201);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: viewer.userId, role: 'viewer' })).status, 201);

    const seedChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Seed release target commit',
      status: 'submitted',
      file_ops: [
        { op: 'upsert', path: 'README.md', content: '# Release Test\n' },
      ],
    });
    assert.equal(seedChangeset.status, 201);
    const seedReview = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${seedChangeset.data.id}/review`, owner.token, {
      decision: 'approved', auto_merge: false,
    });
    assert.equal(seedReview.status, 200);
    const seedMerge = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${seedChangeset.data.id}/merge`, owner.token);
    assert.equal(seedMerge.status, 200);
    const targetCommitId = seedMerge.data.commit.id;

    console.log('Test 1: Owner can create release');
    const create = await api(baseUrl, 'POST', `/v1/projects/${projectId}/releases`, owner.token, {
      title: 'Version 1',
      tag_name: ' V1.0.0 ',
      body: '# Release\n\nInitial release.',
      draft: false,
      prerelease: false,
      target_commit_id: targetCommitId,
    });
    assert.equal(create.status, 201);
    assert.equal(create.data.tag_name, 'v1.0.0');
    assert.equal(create.data.title, 'Version 1');
    assert.equal(create.data.body, '# Release\n\nInitial release.');
    assert.equal(create.data.draft, false);
    assert.equal(create.data.prerelease, false);
    assert.equal(create.data.project_id, projectId);
    assert.ok(create.data.published_at, 'published_at should be set for non-draft release');
    const releaseId = create.data.id;

    console.log('Test 2: Admin can create release');
    const adminCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/releases`, admin.token, {
      title: 'Beta',
      tag_name: 'v1.1.0 beta',
      body: 'Beta release',
      draft: true,
      prerelease: true,
    });
    assert.equal(adminCreate.status, 201);
    assert.equal(adminCreate.data.tag_name, 'v1.1.0-beta');
    assert.equal(adminCreate.data.published_at, null);

    console.log('Test 3: Member/viewer cannot create');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/releases`, member.token, { title: 'No', tag_name: 'v2', body: '' })).status, 403);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/releases`, viewer.token, { title: 'No', tag_name: 'v3', body: '' })).status, 403);

    console.log('Test 4: Duplicate normalized tag returns 409');
    const dup = await api(baseUrl, 'POST', `/v1/projects/${projectId}/releases`, owner.token, {
      title: 'Duplicate',
      tag_name: 'V1.0.0!!!',
      body: 'duplicate',
    });
    assert.equal(dup.status, 409);

    console.log('Test 5: Owner/member/viewer can list and list omits body');
    for (const user of [owner, member, viewer]) {
      const list = await api(baseUrl, 'GET', `/v1/projects/${projectId}/releases`, user.token);
      assert.equal(list.status, 200);
      assert.equal(list.data.meta.total, 2);
      assert.equal(list.data.data.length, 2);
      assert.equal(list.data.data[0].body, undefined);
    }

    console.log('Test 6: Owner/member/viewer can list release-backed tags');
    for (const user of [owner, member, viewer]) {
      const tags = await api(baseUrl, 'GET', `/v1/projects/${projectId}/tags`, user.token);
      assert.equal(tags.status, 200);
      assert.equal(tags.data.meta.total, 2);
      assert.equal(tags.data.data.length, 2);
      const tag = tags.data.data.find((item: any) => item.tag_name === 'v1.0.0');
      assert.ok(tag, 'v1.0.0 tag should be listed');
      assert.equal(tag.release_id, releaseId);
      assert.equal(tag.release_title, 'Version 1');
      assert.equal(tag.target_commit_id, targetCommitId);
      assert.equal(tag.target_commit.id, targetCommitId);
      assert.equal(tag.target_commit.message, 'Seed release target commit');
      assert.equal(tag.draft, false);
      assert.equal(tag.prerelease, false);
    }
    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/tags`, undefined)).status, 401);

    console.log('Test 7: Owner/member/viewer can read release');
    for (const user of [owner, member, viewer]) {
      const read = await api(baseUrl, 'GET', `/v1/projects/${projectId}/releases/${releaseId}`, user.token);
      assert.equal(read.status, 200);
      assert.equal(read.data.id, releaseId);
      assert.equal(read.data.body, '# Release\n\nInitial release.');
    }

    console.log('Test 8: Missing release returns 404');
    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/releases/00000000-0000-4000-8000-000000000000`, owner.token)).status, 404);

    console.log('Test 9: Owner/admin can update; member/viewer cannot update');
    const update = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/releases/${releaseId}`, owner.token, {
      title: 'Version 1 Updated',
      body: 'Updated body',
      prerelease: true,
    });
    assert.equal(update.status, 200);
    assert.equal(update.data.title, 'Version 1 Updated');
    assert.equal(update.data.body, 'Updated body');
    assert.equal(update.data.prerelease, true);
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/releases/${releaseId}`, admin.token, { draft: true })).status, 200);
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/releases/${releaseId}`, member.token, { title: 'No' })).status, 403);
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/releases/${releaseId}`, viewer.token, { title: 'No' })).status, 403);

    console.log('Test 10: Bounds enforced');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/releases`, owner.token, { title: 'x'.repeat(256), tag_name: 'v9', body: '' })).status, 422);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/releases`, owner.token, { title: 'Oversized', tag_name: 'v9', body: 'x'.repeat(1_000_001) })).status, 422);
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/releases/${releaseId}`, owner.token, { body: 'x'.repeat(1_000_001) })).status, 422);

    console.log('Test 11: Mass-assignment fields are ignored');
    const before = await api(baseUrl, 'GET', `/v1/projects/${projectId}/releases/${releaseId}`, owner.token);
    const mass = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/releases/${releaseId}`, owner.token, {
      title: 'Mass Assignment Guard',
      project_id: 'pwned',
      created_by: member.userId,
      updated_by: member.userId,
      published_at: '1999-01-01T00:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000001',
    });
    assert.equal(mass.status, 200);
    assert.equal(mass.data.id, releaseId);
    assert.equal(mass.data.project_id, projectId);
    assert.equal(mass.data.created_by, before.data.created_by);
    assert.equal(mass.data.published_at, before.data.published_at);

    console.log('All project releases tests passed');
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
    password: 'ReleaseTestPassword123!',
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
