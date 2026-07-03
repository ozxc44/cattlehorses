import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-verification-gate-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

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
    const owner = await register(baseUrl, 'verify-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Task Verification Gate Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Verification Main Agent',
    });
    assert.equal(mainAgent.status, 201);
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Verification Worker Agent',
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
        title: 'Verification Gate Orchestration',
        objective: 'Verify deterministic task completion gates.',
        main_agent_id: mainAgent.data.id,
        worker_agent_ids: [workerAgent.data.id],
      },
    );
    assert.equal(orchestration.status, 201);
    const orchestrationId = orchestration.data.id;

    const shortTask = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, {
      title: 'Short result task',
      goal: 'Reject a too-short result.',
    });
    const shortComplete = await completeTask(baseUrl, projectId, orchestrationId, shortTask.data.id, workerAgent.data.api_key, 'ok');
    assert.equal(shortComplete.status, 422);
    assert.equal(shortComplete.data.detail, 'Task verification failed');
    assert.equal(shortComplete.data.code, 'VERIFICATION_FAILED');
    assert.ok(Array.isArray(shortComplete.data.failures));

    const noCriteriaTask = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, {
      title: 'No criteria task',
      goal: 'Accept a long result when criteria are absent.',
    });
    const noCriteriaComplete = await completeTask(
      baseUrl,
      projectId,
      orchestrationId,
      noCriteriaTask.data.id,
      workerAgent.data.api_key,
      'This completion result is long enough.',
    );
    assert.equal(noCriteriaComplete.status, 200);
    assert.equal(noCriteriaComplete.data.status, 'ready_for_review');

    const criteriaMissingTask = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, {
      title: 'Criteria missing task',
      goal: 'Reject a result that omits the acceptance criterion.',
      acceptance_criteria: ['add login route'],
    });
    const missingCriterionComplete = await completeTask(
      baseUrl,
      projectId,
      orchestrationId,
      criteriaMissingTask.data.id,
      workerAgent.data.api_key,
      'This result is long enough but omits the requested behavior.',
    );
    assert.equal(missingCriterionComplete.status, 422);
    assert.equal(missingCriterionComplete.data.code, 'VERIFICATION_FAILED');
    assert.deepEqual(missingCriterionComplete.data.failures, [
      'Acceptance criterion not addressed: add login route',
    ]);

    const criteriaSatisfiedTask = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, {
      title: 'Criteria satisfied task',
      goal: 'Accept a result that addresses the acceptance criterion.',
      acceptance_criteria: ['add login route'],
    });
    const satisfiedCriterionComplete = await completeTask(
      baseUrl,
      projectId,
      orchestrationId,
      criteriaSatisfiedTask.data.id,
      workerAgent.data.api_key,
      'Implemented the add login route with request validation.',
    );
    assert.equal(satisfiedCriterionComplete.status, 200);
    assert.equal(satisfiedCriterionComplete.data.status, 'ready_for_review');

    console.log('task-verification-gate tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function createTask(
  baseUrl: string,
  projectId: string,
  orchestrationId: string,
  mainAgentKey: string,
  workerAgentId: string,
  body: Record<string, unknown>,
) {
  const response = await apiWithKey(
    baseUrl,
    'POST',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
    mainAgentKey,
    {
      assigned_agent_id: workerAgentId,
      ...body,
    },
  );
  assert.equal(response.status, 201);
  return response;
}

async function completeTask(
  baseUrl: string,
  projectId: string,
  orchestrationId: string,
  taskId: string,
  workerAgentKey: string,
  resultMd: string,
) {
  return apiWithKey(
    baseUrl,
    'POST',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/complete`,
    workerAgentKey,
    {
      result_md: resultMd,
      evidence: { verified: true },
      status: 'ready_for_review',
    },
  );
}

async function register(baseUrl: string, prefix: string) {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@x.invalid`,
    password: 'VerifyGate123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function heartbeatAgent(baseUrl: string, key: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', key, { status: 'healthy' });
  assert.equal(response.status, 200);
}

async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response);
}

async function apiWithKey(baseUrl: string, method: string, path: string, key: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response);
}

async function parseResponse(response: Response) {
  const text = await response.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
