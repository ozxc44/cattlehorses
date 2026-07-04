import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-merge-queue-test-secret';

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
    const owner = await register(baseUrl, 'merge-queue-owner');
    const viewer = await register(baseUrl, 'merge-queue-viewer');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Merge Queue Test',
      description: 'Local merge queue',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const addViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(addViewer.status, 201);

    const branches = await api(baseUrl, 'GET', `/v1/projects/${projectId}/branches`, owner.token);
    assert.equal(branches.status, 200);
    const main = branches.data.data.find((branch: any) => branch.name === 'main');
    assert.ok(main);

    const viewerCannotEnable = await updateRules(baseUrl, projectId, main.id, viewer.token, {
      block_direct_writes: false,
      merge_queue_enabled: true,
    });
    assert.equal(viewerCannotEnable.status, 403);

    const enableQueue = await updateRules(baseUrl, projectId, main.id, owner.token, {
      block_direct_writes: false,
      merge_queue_enabled: true,
    });
    assert.equal(enableQueue.status, 200);
    assert.equal(enableQueue.data.protection.rules.merge_queue_enabled, true);
    assert.deepEqual(enableQueue.data.protection.rules.required_status_checks, []);

    const first = await createApprovedChangeset(baseUrl, projectId, owner.token, 'Queue first', 'queue-first.md', 'first');
    const second = await createApprovedChangeset(baseUrl, projectId, owner.token, 'Queue second', 'queue-second.md', 'second');

    const queueListInitial = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets/merge-queue`, owner.token);
    assert.equal(queueListInitial.status, 200);
    assert.equal(queueListInitial.data.total, 2);
    assert.ok(queueListInitial.data.data.every((c: any) => c.status === 'merge_ready'));

    const unqueuedMerge = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${first.id}/merge`, owner.token);
    assert.equal(unqueuedMerge.status, 409);
    assert.equal(unqueuedMerge.data.rule, 'merge_queue');
    assert.equal(unqueuedMerge.data.queued, false);

    const viewerCannotEnqueue = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${first.id}/merge-queue`, viewer.token);
    assert.equal(viewerCannotEnqueue.status, 403);

    const firstQueued = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${first.id}/merge-queue`, owner.token);
    assert.equal(firstQueued.status, 200);
    assert.equal(firstQueued.data.merge_queue.queued, true);
    assert.equal(firstQueued.data.merge_queue.position, 1);

    const secondQueued = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${second.id}/merge-queue`, owner.token);
    assert.equal(secondQueued.status, 200);
    assert.equal(secondQueued.data.merge_queue.queued, true);
    assert.equal(secondQueued.data.merge_queue.position, 2);

    const secondBeforeHead = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${second.id}/merge`, owner.token);
    assert.equal(secondBeforeHead.status, 409);
    assert.equal(secondBeforeHead.data.rule, 'merge_queue');
    assert.equal(secondBeforeHead.data.queue_head_changeset_id, first.id);

    const firstMerge = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${first.id}/merge`, owner.token);
    assert.equal(firstMerge.status, 200);
    assert.equal(firstMerge.data.changeset.merge_queue.queued, false);

    const queueListAfterFirst = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets/merge-queue`, owner.token);
    assert.equal(queueListAfterFirst.status, 200);
    assert.equal(queueListAfterFirst.data.total, 1);
    assert.equal(queueListAfterFirst.data.data[0].id, second.id);

    const secondAfterFirst = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets/${second.id}`, owner.token);
    assert.equal(secondAfterFirst.status, 200);
    assert.equal(secondAfterFirst.data.merge_queue.position, 1);

    const rebaseSecond = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${second.id}/rebase`, owner.token);
    assert.equal(rebaseSecond.status, 200);
    assert.equal(rebaseSecond.data.status, 'submitted');
    assert.equal(rebaseSecond.data.merge_queue.position, 1);

    const approveSecond = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${second.id}/review`, owner.token, {
      decision: 'approved', auto_merge: false,
    });
    assert.equal(approveSecond.status, 200);
    assert.equal(approveSecond.data.merge_queue.position, 1);

    const requireCheck = await updateRules(baseUrl, projectId, main.id, owner.token, {
      block_direct_writes: false,
      merge_queue_enabled: true,
      required_status_checks: ['lint'],
    });
    assert.equal(requireCheck.status, 200);
    assert.equal(requireCheck.data.protection.rules.merge_queue_enabled, true);
    assert.deepEqual(requireCheck.data.protection.rules.required_status_checks, ['lint']);

    const blockedByCheck = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${second.id}/merge`, owner.token);
    assert.equal(blockedByCheck.status, 409);
    assert.equal(blockedByCheck.data.rule, 'required_status_checks');
    assert.deepEqual(blockedByCheck.data.missing_status_checks, ['lint']);

    const passLint = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${second.id}/status-checks`, owner.token, {
      name: 'lint',
      status: 'passed',
      summary: 'local lint passed',
    });
    assert.equal(passLint.status, 200);

    const secondMerge = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${second.id}/merge`, owner.token);
    assert.equal(secondMerge.status, 200);
    assert.equal(secondMerge.data.changeset.merge_queue.queued, false);

    const queueListAfterSecond = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets/merge-queue`, owner.token);
    assert.equal(queueListAfterSecond.status, 200);
    assert.equal(queueListAfterSecond.data.total, 0);

    const third = await createApprovedChangeset(baseUrl, projectId, owner.token, 'Queue third', 'queue-third.md', 'third');
    const fourth = await createApprovedChangeset(baseUrl, projectId, owner.token, 'Queue fourth', 'queue-fourth.md', 'fourth');
    const thirdQueued = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${third.id}/merge-queue`, owner.token);
    assert.equal(thirdQueued.data.merge_queue.position, 1);
    const fourthQueued = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${fourth.id}/merge-queue`, owner.token);
    assert.equal(fourthQueued.data.merge_queue.position, 2);
    const dequeueThird = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/changesets/${third.id}/merge-queue`, owner.token);
    assert.equal(dequeueThird.status, 200);
    assert.equal(dequeueThird.data.merge_queue.queued, false);
    const fourthAfterDequeue = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets/${fourth.id}`, owner.token);
    assert.equal(fourthAfterDequeue.data.merge_queue.position, 1);

    console.log('project-merge-queue tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function createApprovedChangeset(
  baseUrl: string,
  projectId: string,
  token: string,
  title: string,
  path: string,
  content: string,
): Promise<{ id: string }> {
  const changeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, token, {
    title,
    file_ops: [{ op: 'upsert', path, content }],
  });
  assert.equal(changeset.status, 201);
  const review = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${changeset.data.id}/review`, token, {
    decision: 'approved', auto_merge: false,
  });
  assert.equal(review.status, 200);
  assert.equal(review.data.status, 'merge_ready');
  return { id: changeset.data.id };
}

async function updateRules(
  baseUrl: string,
  projectId: string,
  branchId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'PATCH', `/v1/projects/${projectId}/branches/${branchId}/protection-rules`, token, {
    direct_write_bypass_roles: [],
    direct_write_bypass_user_ids: [],
    required_approvals: 0,
    required_status_checks: [],
    protected_branch_patterns: [],
    ...body,
  });
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'MergeQueuePassword123!',
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
