import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'orchestration-timeline-test-secret';

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
    const owner = await register(baseUrl, 'tl-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Timeline Test',
      description: 'Orchestration timeline endpoint test',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Timeline PM Agent',
    });
    assert.equal(mainAgent.status, 201);
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Timeline Worker Agent',
    });
    assert.equal(workerAgent.status, 201);

    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);

    const orchestration = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations`,
      mainAgent.data.api_key,
      {
        title: 'Timeline Ship',
        objective: 'Produce a chronological event timeline.',
        main_agent_id: mainAgent.data.id,
        worker_agent_ids: [workerAgent.data.id],
      },
    );
    assert.equal(orchestration.status, 201);
    const orchestrationId = orchestration.data.id;

    const task = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Build timeline feature',
        goal: 'Add timeline endpoint and verify chronological ordering.',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(task.status, 201);
    assert.equal(task.data.status, 'dispatched');
    const taskId = task.data.id;

    const claim = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/claim`,
      workerAgent.data.api_key,
    );
    assert.equal(claim.status, 200);
    assert.equal(claim.data.status, 'running');

    const complete = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nTimeline endpoint implemented.',
        evidence: { files_changed: ['src/routes/orchestrations.routes.ts'] },
      },
    );
    assert.equal(complete.status, 200);
    assert.equal(complete.data.status, 'ready_for_review');

    const review = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/review`,
      mainAgent.data.api_key,
      { decision: 'approved', notes: 'Looks good.' },
    );
    assert.equal(review.status, 200);
    assert.equal(review.data.status, 'approved');

    const timeline = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/timeline`,
      owner.token,
    );
    assert.equal(timeline.status, 200);
    assert.ok(Array.isArray(timeline.data.data), 'timeline should return data array');

    const events = timeline.data.data;
    assert.ok(events.length >= 5, `expected at least 5 events, got ${events.length}`);

    for (let i = 1; i < events.length; i++) {
      const prev = new Date(events[i - 1].timestamp).getTime();
      const curr = new Date(events[i].timestamp).getTime();
      assert.ok(curr >= prev, `events should be chronological: ${events[i - 1].event_type} > ${events[i].event_type}`);
    }

    const eventTypes = events.map((e: any) => e.event_type);
    assert.ok(eventTypes.includes('task_created'), 'should have task_created');
    assert.ok(eventTypes.includes('task_dispatched'), 'should have task_dispatched');
    assert.ok(eventTypes.includes('task_claimed'), 'should have task_claimed');
    assert.ok(eventTypes.includes('task_completed'), 'should have task_completed');
    assert.ok(eventTypes.includes('pm_reviewed'), 'should have pm_reviewed');

    const dispatchedEvent = events.find((e: any) => e.event_type === 'task_dispatched');
    assert.equal(dispatchedEvent.task_id, taskId);
    assert.equal(dispatchedEvent.task_title, 'Build timeline feature');
    assert.equal(dispatchedEvent.from_status, 'pending');
    assert.equal(dispatchedEvent.to_status, 'dispatched');

    const claimedEvent = events.find((e: any) => e.event_type === 'task_claimed');
    assert.equal(claimedEvent.task_id, taskId);
    assert.equal(claimedEvent.agent_name, 'Timeline Worker Agent');

    const completedEvent = events.find((e: any) => e.event_type === 'task_completed');
    assert.equal(completedEvent.task_id, taskId);
    assert.equal(completedEvent.from_status, 'running');

    const reviewedEvent = events.find((e: any) => e.event_type === 'pm_reviewed');
    assert.equal(reviewedEvent.task_id, taskId);
    assert.equal(reviewedEvent.to_status, 'approved');
    assert.equal(reviewedEvent.detail.decision, 'approved');

    const notFound = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/nonexistent-id/timeline`,
      owner.token,
    );
    assert.equal(notFound.status, 404);

    const intruder = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Intruder Agent',
    });
    assert.equal(intruder.status, 201);
    await heartbeatAgent(baseUrl, intruder.data.api_key);

    const intruderTimeline = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/timeline`,
      intruder.data.api_key,
    );
    assert.equal(intruderTimeline.status, 403);

    console.log('orchestration-timeline tests passed');
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
    password: 'TimelineTest123!',
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
    metrics: { load: 0 },
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.equal(response.data.is_online, true);
  assert.equal(response.data.dispatchable, true);
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
