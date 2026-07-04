import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'md-trace-e2e-test-secret';

const REDACTED = '<REDACTED>';

async function main(): Promise<void> {
  const { redactValue, redactMarkdown } = await import('../src/services/md-artifact.service');

  const { AppDataSource } = await import('../src/data-source');
  await AppDataSource.initialize();
  try {
    const app = (await import('../src/app')).default;
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // ── 1. Register owner ────────────────────────────────────────────────
      const owner = await register(baseUrl, 'md-trace-owner');

      // ── 2. Create project ─────────────────────────────────────────────────
      const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
        name: 'MD Trace E2E Test',
        description: 'End-to-end traceability test across multi-agent collaboration.',
      });
      assert.equal(project.status, 201, 'Project must be created');
      const projectId = project.data.id;

      // ── 3. Register main + worker agents ──────────────────────────────────
      const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'Main' });
      const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'Worker' });
      assert.equal(mainAgent.status, 201, 'Main agent must be created');
      assert.equal(workerAgent.status, 201, 'Worker agent must be created');
      assert.ok(mainAgent.data.api_key, 'Main agent must have an API key');
      assert.ok(workerAgent.data.api_key, 'Worker agent must have an API key');

      // ── 4. Heartbeat both agents ──────────────────────────────────────────
      await heartbeatAgent(baseUrl, mainAgent.data.api_key);
      await heartbeatAgent(baseUrl, workerAgent.data.api_key);

      // ── 5. Create orchestration (writes goal.md, plan.md) ─────────────────
      const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
        title: 'MD Trace E2E',
        objective: 'Verify full MD traceability chain.',
        main_agent_id: mainAgent.data.id,
        worker_agent_ids: [workerAgent.data.id],
      });
      assert.equal(orch.status, 201, 'Orchestration must be created');
      const basePath: string = orch.data.base_path;
      assert.ok(basePath, 'Orchestration must have a base_path');
      const orchestrationId: string = orch.data.id;

      // ── 6. Dispatch a task (writes TASK.md) ──────────────────────────────
      const taskResp = await apiWithKey(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
        mainAgent.data.api_key,
        {
          title: 'Traceability test task',
          goal: 'Produce result and evidence for trace verification.',
          assigned_agent_id: workerAgent.data.id,
        },
      );
      assert.equal(taskResp.status, 201, 'Task must be created (dispatched)');
      const taskId: string = taskResp.data.id;
      assert.ok(taskId, 'Task must have an id');

      // ── 7. Worker claims the task ─────────────────────────────────────────
      const claim = await apiWithKey(
        baseUrl,
        'PATCH',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/claim`,
        workerAgent.data.api_key,
      );
      assert.equal(claim.status, 200, 'Task must be claimed');

      // ── 8. Worker completes with result_md and evidence (writes RESULT.md,
      //       EVIDENCE.md, CHANGELOG.md) ─────────────────────────────────────
      const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
      const colonSecret = 'hunter2-PM-Secret';
      const complete = await apiWithKey(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/complete`,
        workerAgent.data.api_key,
        {
          result_md: [
            '# Result',
            '',
            '## Changes',
            '',
            '- Fixed authentication flow.',
            '',
            '## Configuration',
            '',
            `Key: ${secret}`,
            `password: ${colonSecret}`,
            '',
            '```',
            `{"password":"${colonSecret}"}`,
            '```',
          ].join('\n'),
          evidence: { api_key: secret, note: 'safe', log: `evidence log password: ${colonSecret}` },
        },
      );
      assert.equal(complete.status, 200, 'Task must be completed');

      // ── 9. Main agent reviews (approved) (writes REVIEW.md) ──────────────
      const review = await apiWithKey(
        baseUrl,
        'PATCH',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/review`,
        mainAgent.data.api_key,
        {
          decision: 'approved', auto_merge: false,
          notes: 'All good — traceability verified.',
        },
      );
      assert.equal(review.status, 200, 'Task must be reviewed and approved');

      // ── 10. Complete orchestration (writes TRACE.md) ──────────────────────
      const orchComplete = await apiWithKey(
        baseUrl,
        'PATCH',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/complete`,
        mainAgent.data.api_key,
        {
          summary: 'E2E trace test completed successfully.',
        },
      );
      assert.equal(orchComplete.status, 200, 'Orchestration must be completed');

      // ── 11. List project-space files under basePath ───────────────────────
      const files: Array<{ id: string; path: string }> = await listFiles(baseUrl, owner.token, projectId, basePath);

      // ── 12. Assert all canonical artifacts exist at their paths ───────────
      const canonicalPaths = [
        'goal.md',
        'plan.md',
        'TRACE.md',
        `tasks/${taskId}/TASK.md`,
        `tasks/${taskId}/RESULT.md`,
        `tasks/${taskId}/EVIDENCE.md`,
        `tasks/${taskId}/REVIEW.md`,
        `tasks/${taskId}/CHANGELOG.md`,
      ];

      const missing: string[] = [];
      const found: Map<string, string> = new Map(); // relPath -> fileId
      for (const relPath of canonicalPaths) {
        const fullPath = `${basePath}/${relPath}`;
        const file = files.find((f) => f.path === fullPath);
        if (file) {
          found.set(relPath, file.id);
        } else {
          missing.push(fullPath);
        }
      }

      if (missing.length > 0) {
        // Log all existing paths to help debug
        const existingPaths = files.map((f) => f.path).sort();
        console.log('Existing files under basePath:');
        existingPaths.forEach((p) => console.log(`  ${p}`));
        assert.fail(
          `Missing canonical artifact(s):\n${missing.map((p) => `  ${p}`).join('\n')}\n` +
            `Gap found: these artifacts are not produced by the current lifecycle.`,
        );
      }

      // ── 13. Fetch TRACE.md content and assert task-index linkage ──────────
      const traceFileId = found.get('TRACE.md')!;
      const traceResp = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${traceFileId}`, owner.token);
      assert.equal(traceResp.status, 200);
      const traceContent = traceResp.data.content as string;

      // The task-index table must reference the task id
      assert(traceContent.includes(taskId), `TRACE.md task-index must reference task id "${taskId}"`);

      // The task-index table must reference the per-task artifact paths
      const taskDir = `tasks/${taskId}`;
      assert(traceContent.includes(taskDir), `TRACE.md must reference task directory "${taskDir}"`);
      assert(traceContent.includes('TASK.md'), 'TRACE.md must include TASK.md reference in task index');
      assert(traceContent.includes('RESULT.md'), 'TRACE.md must include RESULT.md reference in task index');
      assert(traceContent.includes('REVIEW.md'), 'TRACE.md must include REVIEW.md reference in task index');
      assert(traceContent.includes('CHANGELOG.md'), 'TRACE.md must include CHANGELOG.md reference in task index');

      // TRACE.md must have an Artifact References section referencing goal.md and plan.md
      assert(traceContent.includes('Artifact References'), 'TRACE.md must have an Artifact References section');
      assert(traceContent.includes('goal.md'), 'TRACE.md must reference goal.md');
      assert(traceContent.includes('plan.md'), 'TRACE.md must reference plan.md');

      // ── 14. Assert redaction of secrets in RESULT.md ──────────────────────
      const resultFileId = found.get(`tasks/${taskId}/RESULT.md`)!;
      const resultResp = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${resultFileId}`, owner.token);
      assert.equal(resultResp.status, 200);
      const resultContent = resultResp.data.content as string;
      assert(!resultContent.includes(secret), 'Stored RESULT.md must not contain the secret API key');
      assert(!resultContent.includes(colonSecret), 'Stored RESULT.md must not contain colon-style password values');
      assert(resultContent.includes(REDACTED), 'Stored RESULT.md must include the <REDACTED> marker');

      // ── 15. Assert redaction of secrets in EVIDENCE.md ─────────────────────
      const evidenceFileId = found.get(`tasks/${taskId}/EVIDENCE.md`)!;
      const evidenceResp = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${evidenceFileId}`, owner.token);
      assert.equal(evidenceResp.status, 200);
      const evidenceContent = evidenceResp.data.content as string;
      assert(!evidenceContent.includes(secret), 'Stored EVIDENCE.md must not contain the secret API key');
      assert(!evidenceContent.includes(colonSecret), 'Stored EVIDENCE.md must not contain colon-style password values');
      assert(evidenceContent.includes(REDACTED), 'Stored EVIDENCE.md must include the <REDACTED> marker');
      assert(evidenceContent.includes('safe'), 'Stored EVIDENCE.md must preserve non-secret values');

      console.log('All canonical artifact existence, TRACE.md linkage, and redaction assertions passed');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    await AppDataSource.destroy();
  }

  console.log('md-trace-e2e tests passed');
}

/* ─── Helper functions (pattern from md-artifact-redaction.test.ts) ──── */

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'MdTraceE2eTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201, 'Registration must succeed');
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function listFiles(baseUrl: string, token: string, projectId: string, pathPrefix: string): Promise<any[]> {
  const encoded = encodeURIComponent(pathPrefix);
  const response = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files?path_prefix=${encoded}`, token);
  assert.equal(response.status, 200, 'File listing must succeed');
  return response.data.data;
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    metrics: { load: 0 },
  });
  assert.equal(response.status, 200, 'Heartbeat must succeed');
  assert.equal(response.data.ok, true, 'Heartbeat must return ok: true');
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
