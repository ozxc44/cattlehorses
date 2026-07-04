import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-evidence-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { ProjectOrchestrationTask } = await import('../src/entities/project-orchestration-task.entity');
  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const owner = await register(baseUrl, 'task-evidence-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Task Evidence Test',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Evidence Main Agent',
    });
    assert.equal(mainAgent.status, 201);
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Evidence Worker Agent',
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
        title: 'Task Evidence Orchestration',
        objective: 'Verify structured task evidence behavior.',
        main_agent_id: mainAgent.data.id,
        worker_agent_ids: [workerAgent.data.id],
      },
    );
    assert.equal(orchestration.status, 201);
    const orchestrationId = orchestration.data.id;

    const storedTask = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, {
      title: 'Structured evidence task',
      goal: 'Store structured task evidence.',
    });
    const storedComplete = await completeTask(
      baseUrl,
      projectId,
      orchestrationId,
      storedTask.data.id,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nImplemented structured task evidence support.',
        evidence: { files_changed: ['a.ts'], test_passed: true },
      },
    );
    assert.equal(storedComplete.status, 200);
    assert.deepEqual(storedComplete.data.evidence, {
      files_changed: ['a.ts'],
      test_passed: true,
      diff_summary: null,
      risk_notes: null,
    });
    const storedRow = await AppDataSource.getRepository(ProjectOrchestrationTask).findOneByOrFail({ id: storedTask.data.id });
    assert.deepEqual(storedRow.evidenceJson, storedComplete.data.evidence);

    const emptyFilesTask = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, {
      title: 'Empty changed files task',
      goal: 'Reject changed-file claims without changed file evidence.',
    });
    const emptyFilesComplete = await completeTask(
      baseUrl,
      projectId,
      orchestrationId,
      emptyFilesTask.data.id,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nModified file behavior for structured evidence verification.',
        evidence: { files_changed: [], test_passed: true },
      },
    );
    assert.equal(emptyFilesComplete.status, 422);
    assert.equal(emptyFilesComplete.data.code, 'VERIFICATION_FAILED');
    assert.deepEqual(emptyFilesComplete.data.failures, [
      'Evidence files_changed cannot be empty when result mentions changed or modified files',
    ]);

    const noEvidenceTask = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, {
      title: 'No evidence task',
      goal: 'Keep result-only completion backward compatible.',
    });
    const noEvidenceComplete = await completeTask(
      baseUrl,
      projectId,
      orchestrationId,
      noEvidenceTask.data.id,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nCompletion without structured evidence still works.',
      },
    );
    assert.equal(noEvidenceComplete.status, 200);
    assert.equal(noEvidenceComplete.data.evidence, null);

    console.log('task-evidence tests passed');
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
  body: Record<string, unknown>,
) {
  return apiWithKey(
    baseUrl,
    'POST',
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/complete`,
    workerAgentKey,
    {
      status: 'ready_for_review',
      ...body,
    },
  );
}

async function register(baseUrl: string, prefix: string) {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@x.invalid`,
    password: 'TaskEvidence123!',
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
