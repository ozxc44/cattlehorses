import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'notify-test-secret';

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
    const owner = await register(baseUrl, 'notify-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Notify Test Project',
      description: 'Testing notification fan-out',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Register two worker agents
    const agent1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker Alpha',
    });
    assert.equal(agent1.status, 201);

    const agent2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker Beta',
    });
    assert.equal(agent2.status, 201);

    await heartbeatAgent(baseUrl, agent1.data.api_key);
    await heartbeatAgent(baseUrl, agent2.data.api_key);

    // ─── Test 1: POST /v1/projects/:pid/notify — inbox created ──────────────
    console.log('Test 1: notify creates inbox items for recipients');
    const notifyResp = await api(baseUrl, 'POST', `/v1/projects/${projectId}/notify`, owner.token, {
      event_type: 'task_dispatched',
      recipients: [agent1.data.id, agent2.data.id],
      payload: { task_id: 't-001', title: 'Build feature X' },
    });
    assert.equal(notifyResp.status, 200);
    assert.equal(notifyResp.data.inbox_created, 2);
    assert.equal(notifyResp.data.audit_logged, true);

    // Verify inbox items exist for both agents
    const inbox1 = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', agent1.data.api_key);
    assert.equal(inbox1.status, 200);
    const taskItems1 = inbox1.data.data.filter((i: any) => i.event_type === 'task_dispatched');
    assert.ok(taskItems1.length >= 1, 'Agent1 should have task_dispatched inbox item');
    assert.equal(taskItems1[0].project_id, projectId);

    const inbox2 = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', agent2.data.api_key);
    assert.equal(inbox2.status, 200);
    const taskItems2 = inbox2.data.data.filter((i: any) => i.event_type === 'task_dispatched');
    assert.ok(taskItems2.length >= 1, 'Agent2 should have task_dispatched inbox item');

    // ─── Test 2: Webhook not triggered when no webhook configured ───────────
    console.log('Test 2: webhook_triggered is false when project has no webhook');
    assert.equal(notifyResp.data.webhook_triggered, false);

    // ─── Test 3: Webhook triggered when project has webhook configured ──────
    console.log('Test 3: webhook triggered when project has webhook URL');
    const { AppDataSource: DS } = await import('../src/data-source');
    const { Project } = await import('../src/entities/project.entity');
    await DS.getRepository(Project).update(projectId, {
      webhookUrl: 'http://127.0.0.1:1/webhook-test',
      webhookSecret: 'test-secret',
      webhookEnabledEvents: ['task_dispatched'],
    });

    const notifyWithWebhook = await api(baseUrl, 'POST', `/v1/projects/${projectId}/notify`, owner.token, {
      event_type: 'task_dispatched',
      recipients: [agent1.data.id],
      payload: { task_id: 't-002' },
    });
    assert.equal(notifyWithWebhook.status, 200);
    assert.equal(notifyWithWebhook.data.webhook_triggered, true);

    // ─── Test 4: Audit log recorded ─────────────────────────────────────────
    console.log('Test 4: audit log entry created');
    const { AuditLogEntry } = await import('../src/entities/audit-log-entry.entity');
    const auditEntries = await DS.getRepository(AuditLogEntry).find({
      where: { projectId, action: 'notify.task_dispatched' },
    });
    assert.ok(auditEntries.length >= 1, 'Audit log should have notify entries');
    assert.equal(auditEntries[0].actorId, 'notify-service');

    // ─── Test 5: Validation — missing event_type ────────────────────────────
    console.log('Test 5: validation — missing event_type returns 400');
    const badResp1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/notify`, owner.token, {
      recipients: [agent1.data.id],
    });
    assert.equal(badResp1.status, 400);

    // ─── Test 6: Validation — empty recipients ──────────────────────────────
    console.log('Test 6: validation — empty recipients returns 400');
    const badResp2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/notify`, owner.token, {
      event_type: 'some_event',
      recipients: [],
    });
    assert.equal(badResp2.status, 400);

    // ─── Test 7: Unauthorized user cannot trigger notify ────────────────────
    console.log('Test 7: non-member cannot trigger notify');
    const outsider = await register(baseUrl, 'notify-outsider');
    const outsiderResp = await api(baseUrl, 'POST', `/v1/projects/${projectId}/notify`, outsider.token, {
      event_type: 'test',
      recipients: [agent1.data.id],
    });
    assert.equal(outsiderResp.status, 403);

    console.log('\n✅ All notify tests passed');
  } finally {
    server.close();
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'NotifyTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
  });
  assert.equal(response.status, 200);
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

async function apiWithKey(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
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
