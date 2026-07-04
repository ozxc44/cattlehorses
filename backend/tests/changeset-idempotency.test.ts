import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'changeset-idempotency-test-secret';

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
    const owner = await register(baseUrl, 'idempotency-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Idempotency Test',
      description: 'Test changeset idempotency keys',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const baseFile = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: '# Idempotency Test\n\nv1',
      message: 'Initial file',
    });
    assert.equal(baseFile.status, 201);

    // (i) No key → always creates new changeset
    const noKey1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'No key changeset 1',
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Idempotency Test\n\nv2',
          base_revision_id: baseFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(noKey1.status, 201);

    const noKey2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'No key changeset 2',
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Idempotency Test\n\nv2',
          base_revision_id: baseFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(noKey2.status, 201);
    assert.notEqual(noKey1.data.id, noKey2.data.id, 'no key should create separate changesets');

    // (ii) Same key twice → returns existing (HTTP 200)
    const idemKey = `test-key-${Date.now()}`;
    const withKey1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Idempotent changeset',
      idempotency_key: idemKey,
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Idempotency Test\n\nv3',
          base_revision_id: baseFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(withKey1.status, 201);
    assert.equal(withKey1.data.idempotency_key, idemKey);

    const withKey2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Idempotent changeset duplicate',
      idempotency_key: idemKey,
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Idempotency Test\n\nv4',
          base_revision_id: baseFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(withKey2.status, 200, 'same key should return 200');
    assert.equal(withKey2.data.id, withKey1.data.id, 'same key should return same changeset');
    assert.equal(withKey2.data.title, 'Idempotent changeset', 'should return original title');

    // (iii) Different keys → creates separate changesets
    const diffKey1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Different key 1',
      idempotency_key: `key-a-${Date.now()}`,
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Idempotency Test\n\nv5',
          base_revision_id: baseFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(diffKey1.status, 201);

    const diffKey2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Different key 2',
      idempotency_key: `key-b-${Date.now()}`,
      file_ops: [
        {
          op: 'upsert',
          path: 'README.md',
          content: '# Idempotency Test\n\nv6',
          base_revision_id: baseFile.data.current_revision_id,
        },
      ],
    });
    assert.equal(diffKey2.status, 201);
    assert.notEqual(diffKey1.data.id, diffKey2.data.id, 'different keys should create separate changesets');

    console.log('changeset-idempotency tests passed');
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
    password: 'IdempotencyTest123!',
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
