import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-commit-verification-test-secret';

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
    const owner = await register(baseUrl, 'commit-verify-owner');
    const viewer = await register(baseUrl, 'commit-verify-viewer');
    const outsider = await register(baseUrl, 'commit-verify-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Commit Verification Test',
      description: 'Local verified commits',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const addViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(addViewer.status, 201);

    const firstMerge = await createApprovedMerge(baseUrl, projectId, owner.token, 'Verified reviewed merge', 'verified.md', 'reviewed provenance');
    assert.equal(firstMerge.status, 200);
    assert.equal(firstMerge.data.commit.verification.status, 'verified');
    assert.equal(firstMerge.data.commit.verification.verified, true);
    assert.equal(firstMerge.data.commit.verification.local_only, true);
    assert.equal(firstMerge.data.commit.verification.cryptographic, false);
    assert.equal(firstMerge.data.commit.verification.source, 'local_reviewed_changeset');
    assert.equal(firstMerge.data.commit.verification.actor_type, 'user');
    assert.equal(firstMerge.data.commit.verification.actor_id, owner.userId);
    assert.ok(firstMerge.data.commit.verification.verified_at);
    assert.match(firstMerge.data.commit.verification.description, /not GPG\/SSH/i);
    const verifiedCommitId = firstMerge.data.commit.id;

    const secondMerge = await createApprovedMerge(baseUrl, projectId, owner.token, 'Second reviewed merge', 'second.md', 'second');
    assert.equal(secondMerge.status, 200);
    const secondCommitId = secondMerge.data.commit.id;

    const rollback = await api(baseUrl, 'POST', `/v1/projects/${projectId}/rollback`, owner.token, {
      target_commit_id: verifiedCommitId,
      message: 'Rollback to first verified commit',
    });
    assert.equal(rollback.status, 200);
    assert.equal(rollback.data.commit.verification.status, 'unverified');
    assert.equal(rollback.data.commit.verification.verified, false);
    assert.equal(rollback.data.commit.verification.local_only, true);
    assert.equal(rollback.data.commit.verification.cryptographic, false);
    assert.equal(rollback.data.commit.verification.source, 'local_rollback');
    assert.equal(rollback.data.commit.verification.verified_at, null);
    assert.notEqual(rollback.data.commit.id, secondCommitId);

    const ownerList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/commits`, owner.token);
    assert.equal(ownerList.status, 200);
    assert.ok(ownerList.data.data.some((commit: any) => commit.id === verifiedCommitId && commit.verification?.status === 'verified'));
    assert.ok(ownerList.data.data.some((commit: any) => commit.id === rollback.data.commit.id && commit.verification?.status === 'unverified'));

    const ownerDetail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/commits/${verifiedCommitId}`, owner.token);
    assert.equal(ownerDetail.status, 200);
    assert.equal(ownerDetail.data.verification.status, 'verified');
    assert.equal(ownerDetail.data.verification.cryptographic, false);

    const viewerDetail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/commits/${verifiedCommitId}`, viewer.token);
    assert.equal(viewerDetail.status, 200);
    assert.equal(viewerDetail.data.verification.status, 'verified');

    const outsiderList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/commits`, outsider.token);
    assert.equal(outsiderList.status, 403);

    const anonymousDetail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/commits/${verifiedCommitId}`);
    assert.equal(anonymousDetail.status, 401);

    console.log('All project commit verification tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function createApprovedMerge(
  baseUrl: string,
  projectId: string,
  token: string,
  title: string,
  path: string,
  content: string,
): Promise<{ status: number; data: any }> {
  const changeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, token, {
    title,
    file_ops: [{ op: 'upsert', path, content }],
  });
  assert.equal(changeset.status, 201);

  const review = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${changeset.data.id}/review`, token, {
    decision: 'approved', auto_merge: false,
  });
  assert.equal(review.status, 200);

  return api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${changeset.data.id}/merge`, token);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'CommitVerifyPassword123!',
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
