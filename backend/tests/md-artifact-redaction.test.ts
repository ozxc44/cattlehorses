import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'md-artifact-redaction-test-secret';

async function main(): Promise<void> {
  const {
    renderEvidenceMd,
    renderResultMd,
    renderChangelogMd,
    redactValue,
    redactMarkdown,
  } = await import('../src/services/md-artifact.service');

  const task = { id: 'task-redact-1', title: 'Secret redaction test', status: 'ready_for_review' } as any;

  const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMe';
  const bearerLine = 'Authorization: Bearer super-secret-token';
  const colonSecret = 'hunter2-PM-Secret';

  const evidence = {
    config: {
      OPENAI_API_KEY: secret,
      auth_header: `Bearer ${jwt}`,
      password: 'P@ssw0rd!',
      safe_field: 'hello world',
    },
    log: bearerLine,
    adversarial_log: `evidence log password: ${colonSecret}`,
    command: 'curl -H "Authorization: Bearer token123" https://api.example.com',
    mixed: `Token=leaked-value and ${jwt}`,
  };

  const rendered = renderEvidenceMd(task, evidence);

  assert(!rendered.includes(secret), 'EVIDENCE.md must not contain the OpenAI key');
  assert(!rendered.includes(jwt), 'EVIDENCE.md must not contain the JWT');
  assert(!rendered.includes('super-secret-token'), 'EVIDENCE.md must not contain the bearer token');
  assert(!rendered.includes('P@ssw0rd!'), 'EVIDENCE.md must not contain the password');
  assert(!rendered.includes('leaked-value'), 'EVIDENCE.md must not contain assigned secret value');
  assert(!rendered.includes('token123'), 'EVIDENCE.md must not contain inline bearer token');
  assert(!rendered.includes(colonSecret), 'EVIDENCE.md must not contain colon-style password values');
  assert(rendered.includes(REDACTED), 'EVIDENCE.md should include redaction marker');
  assert(rendered.includes('hello world'), 'EVIDENCE.md should preserve non-secret values');
  assert(rendered.includes('```json'), 'EVIDENCE.md should keep the raw JSON block');

  const resultMd = `# Result\n\nUsed key ${secret}.\n\n\`\`\`json\n{"api_key":"${secret}"}\n\`\`\`\n`;
  const resultRendered = renderResultMd(task, resultMd);
  assert(!resultRendered.includes(secret), 'RESULT.md must not contain the secret');
  assert(resultRendered.includes(REDACTED), 'RESULT.md should include redaction marker');

  const pmReviewLeakResultMd = [
    '# Result',
    '',
    `password: ${colonSecret}`,
    '',
    '```',
    `{"password":"${colonSecret}"}`,
    '```',
    '',
    '```JSON',
    `{"password":"${colonSecret}"}`,
    '```',
    '',
  ].join('\n');
  const pmReviewLeakResultRendered = renderResultMd(task, pmReviewLeakResultMd);
  assert(!redactMarkdown(`password: ${colonSecret}`).includes(colonSecret), 'redactMarkdown must redact password: values');
  assert(!pmReviewLeakResultRendered.includes(colonSecret), 'RESULT.md must redact PM-review password/JSON leak cases');
  assert(
    pmReviewLeakResultRendered.includes(`"password": "${REDACTED}"`),
    'RESULT.md should structurally redact unlabeled and uppercase JSON fences',
  );

  const pmReviewLeakEvidenceRendered = renderEvidenceMd(task, {
    log: `worker stdout password: ${colonSecret}`,
  });
  assert(!pmReviewLeakEvidenceRendered.includes(colonSecret), 'EVIDENCE.md must redact evidence log password: values');

  const colonLabelCases = [
    'password: lower-case-password',
    'TOKEN: upper-case-token',
    'Secret: mixed-case-secret',
    'api_key: snake-case-api-key',
    'Authorization: bearer-like-value',
  ];
  for (const sample of colonLabelCases) {
    const redacted = redactMarkdown(sample);
    assert(!redacted.includes(sample.split(': ')[1]), `redactMarkdown must redact colon label: ${sample}`);
    assert(redacted.includes(REDACTED), `redactMarkdown should mark colon label redaction: ${sample}`);
  }

  // Regression: multi-token unquoted colon-style secrets. The unquoted regex
  // previously split on whitespace, so trailing tokens of multi-word secrets
  // leaked (e.g. the base64 credential in "Authorization: Basic <b64>").
  // The whole colon-label value must be redacted up to the line/structural end.
  const colonMultiTokenCases = [
    'Authorization: Basic dXNlcjpwYXNz',
    'password: hunter2 PM-Secret',
    'token: abc def ghi',
    'Authorization: Basic abc.def.ghi',
  ];
  for (const sample of colonMultiTokenCases) {
    const value = sample.slice(sample.indexOf(': ') + 2);
    const redacted = redactMarkdown(sample);
    assert(!redacted.includes(value), `redactMarkdown must redact full multi-token colon value: ${sample}`);
    assert(redacted.includes(REDACTED), `redactMarkdown should mark multi-token colon redaction: ${sample}`);
    // Ensure no trailing token of the secret survives.
    for (const tok of value.split(/\s+/)) {
      assert(!redacted.includes(tok), `redactMarkdown must not leak trailing token "${tok}" of: ${sample}`);
    }
  }

  const changelogRendered = renderChangelogMd(task, resultMd, {});
  assert(!changelogRendered.includes(secret), 'CHANGELOG.md must not contain the secret');

  assert.equal((redactValue({ api_key: secret }) as any).api_key, REDACTED, 'redactValue redacts sensitive keys');
  assert.equal(redactValue('Bearer abc123'), 'Bearer <REDACTED>', 'redactValue redacts inline bearer token');
  assert.equal(
    redactMarkdown(`Token=leaked and ${secret}`),
    `Token=<REDACTED> and <REDACTED>`,
    'redactMarkdown redacts inline patterns',
  );

  const { AppDataSource } = await import('../src/data-source');
  await AppDataSource.initialize();
  try {
    const columns: Array<{ name: string; type: string }> = await AppDataSource.query(
      `PRAGMA table_info("project_orchestration_tasks")`,
    );
    assert.ok(
      columns.some((c) => c.name === 'metadata'),
      'project_orchestration_tasks.metadata column must exist',
    );

    const app = (await import('../src/app')).default;
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const owner = await register(baseUrl, 'md-redact-owner');
      const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
        name: 'MD Redaction Test',
        description: 'Verify secrets do not leak into Markdown artifacts.',
      });
      assert.equal(project.status, 201);
      const projectId = project.data.id;

      const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'Main' });
      const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'Worker' });
      assert.equal(mainAgent.status, 201);
      assert.equal(workerAgent.status, 201);

      await heartbeatAgent(baseUrl, mainAgent.data.api_key);
      await heartbeatAgent(baseUrl, workerAgent.data.api_key);

      const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
        title: 'Redaction test',
        objective: 'Verify secret redaction.',
        main_agent_id: mainAgent.data.id,
        worker_agent_ids: [workerAgent.data.id],
      });
      assert.equal(orch.status, 201);

      const taskResp = await apiWithKey(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/orchestrations/${orch.data.id}/tasks`,
        mainAgent.data.api_key,
        {
          title: 'Leak test',
          goal: 'Submit secrets and verify redaction.',
          assigned_agent_id: workerAgent.data.id,
        },
      );
      assert.equal(taskResp.status, 201);

      const claim = await apiWithKey(
        baseUrl,
        'PATCH',
        `/v1/projects/${projectId}/orchestrations/${orch.data.id}/tasks/${taskResp.data.id}/claim`,
        workerAgent.data.api_key,
      );
      assert.equal(claim.status, 200);

      const complete = await apiWithKey(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/orchestrations/${orch.data.id}/tasks/${taskResp.data.id}/complete`,
        workerAgent.data.api_key,
        {
          result_md: [
            '# Result',
            '',
            `Key: ${secret}`,
            `password: ${colonSecret}`,
            '',
            '```',
            `{"password":"${colonSecret}"}`,
            '```',
            '',
            '```JSON',
            `{"password":"${colonSecret}"}`,
            '```',
          ].join('\n'),
          evidence: { files_changed: ['redaction.md'], api_key: secret, note: 'safe', log: `evidence log password: ${colonSecret}` },
        },
      );
      assert.equal(complete.status, 200);

      const files = await listFiles(baseUrl, owner.token, projectId, orch.data.base_path);

      const evidenceFile = files.find((f: any) => f.path.endsWith('/EVIDENCE.md'));
      assert.ok(evidenceFile, 'EVIDENCE.md file must exist');
      const evidenceContentResp = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${evidenceFile.id}`, owner.token);
      assert.equal(evidenceContentResp.status, 200);
      const evidenceContent = evidenceContentResp.data.content as string;
      assert(!evidenceContent.includes(secret), 'Stored EVIDENCE.md must not contain the secret');
      assert(!evidenceContent.includes(colonSecret), 'Stored EVIDENCE.md must not contain colon-style password values');
      assert(evidenceContent.includes(REDACTED), 'Stored EVIDENCE.md must include redaction marker');
      assert(evidenceContent.includes('safe'), 'Stored EVIDENCE.md must preserve non-secret values');

      const resultFile = files.find((f: any) => f.path.endsWith('/RESULT.md'));
      assert.ok(resultFile, 'RESULT.md file must exist');
      const resultContentResp = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${resultFile.id}`, owner.token);
      assert.equal(resultContentResp.status, 200);
      assert(
        !(resultContentResp.data.content as string).includes(secret),
        'Stored RESULT.md must not contain the secret',
      );
      assert(
        !(resultContentResp.data.content as string).includes(colonSecret),
        'Stored RESULT.md must not contain PM-review password/JSON leak cases',
      );

      const rawEvidenceFile = files.find((f: any) => f.path.endsWith('/workers/' + taskResp.data.id + '.evidence.json'));
      assert.ok(rawEvidenceFile, 'Raw evidence JSON file must exist');
      const rawEvidenceResp = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${rawEvidenceFile.id}`, owner.token);
      assert.equal(rawEvidenceResp.status, 200);
      const rawEvidence = JSON.parse(rawEvidenceResp.data.content);
      assert.notEqual(rawEvidence.api_key, secret, 'Raw evidence JSON must not contain the secret');
      assert.equal(rawEvidence.api_key, REDACTED, 'Raw evidence JSON must redact the secret');
      assert.equal(rawEvidence.note, 'safe', 'Raw evidence JSON must preserve non-secret values');
      assert(!rawEvidence.log.includes(colonSecret), 'Raw evidence JSON must redact colon-style password log values');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    await AppDataSource.destroy();
  }

  console.log('md-artifact-redaction tests passed');
}

const REDACTED = '<REDACTED>';

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'MdArtifactRedaction123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function listFiles(baseUrl: string, token: string, projectId: string, pathPrefix: string): Promise<any[]> {
  const encoded = encodeURIComponent(pathPrefix);
  const response = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files?path_prefix=${encoded}`, token);
  assert.equal(response.status, 200);
  return response.data.data;
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    metrics: { load: 0 },
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
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
