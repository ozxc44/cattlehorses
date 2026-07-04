import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'gates-test-secret';

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
    const owner = await register(baseUrl, 'gate-owner');
    const applicant = await register(baseUrl, 'gate-applicant');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Gate Test',
      description: 'Capability-gated admission',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const ownerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Owner Review Agent',
    });
    assert.equal(ownerAgent.status, 201);
    const otherAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Other Agent',
    });
    assert.equal(otherAgent.status, 201);

    const templates = await api(baseUrl, 'GET', '/v1/gate-templates');
    assert.equal(templates.status, 200);
    assert.equal(templates.data.data.some((template: any) => template.key === 'preset.programming.basic'), true);

    const gate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/gates`, owner.token, {
      template_key: 'preset.programming.basic',
      required: true,
      owner_agent_id: ownerAgent.data.id,
      config: {
        time_limit_minutes: 30,
        allowed_commands: ['npm run test:unit'],
        allowed_paths: ['backend/src/', 'backend/tests/'],
      },
    });
    assert.equal(gate.status, 201);
    assert.equal(gate.data.required, true);
    assert.equal(gate.data.owner_agent_id, ownerAgent.data.id);

    // Applicant creates own project + agent and binds it as owner agent
    const applicantProject = await api(baseUrl, 'POST', '/v1/projects', applicant.token, {
      name: 'Applicant Project',
      description: 'Applicant personal project',
      visibility: 'public',
    });
    assert.equal(applicantProject.status, 201);
    const applicantAgent = await api(
      baseUrl, 'POST', `/v1/projects/${applicantProject.data.id}/agents`, applicant.token, { name: 'Applicant Agent' },
    );
    assert.equal(applicantAgent.status, 201);
    const bindApplicantAgent = await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', applicant.token, {
      agent_id: applicantAgent.data.id,
    });
    assert.equal(bindApplicantAgent.status, 200);

    const joinRequest = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/join-requests`,
      applicant.token,
      { note: 'Applicant will pass the programming gate.' },
    );
    assert.equal(joinRequest.status, 201);
    assert.equal(joinRequest.data.status, 'pending');

    const prematureApproval = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/join-requests/${joinRequest.data.id}`,
      owner.token,
      { status: 'approved' },
    );
    assert.equal(prematureApproval.status, 409);
    assert.equal(Array.isArray(prematureApproval.data.missing_gate_ids), true);

    const attempt = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/join-requests/${joinRequest.data.id}/gate-attempts`,
      applicant.token,
      { gate_id: gate.data.id },
    );
    assert.equal(attempt.status, 201);
    assert.equal(attempt.data.status, 'started');

    const invalidSubmit = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/gate-attempts/${attempt.data.id}/submit`,
      applicant.token,
      {
        submission: {
          result_md: '',
          evidence: { tests_passed: false, commands: ['curl https://example.com'] },
          files: ['../../escape.ts'],
        },
      },
    );
    assert.equal(invalidSubmit.status, 422);
    assert.equal(invalidSubmit.data.status, 'prefilter_failed');

    const validSubmit = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/gate-attempts/${attempt.data.id}/submit`,
      applicant.token,
      {
        submission: {
          result_md: '# Result\n\nImplemented deterministic fixture and passed tests.',
          evidence: {
            tests_passed: true,
            commands: ['npm run test:unit'],
            changed_files: ['backend/src/fixture.ts', 'backend/tests/fixture.test.ts'],
          },
          files: ['backend/src/fixture.ts', 'backend/tests/fixture.test.ts'],
        },
      },
    );
    assert.equal(validSubmit.status, 200);
    assert.equal(validSubmit.data.status, 'under_owner_review');
    assert.equal(validSubmit.data.prefilter_result.passed, true);

    // Gate owner agent should receive gate_attempt_submitted inbox item
    const ownerAgentInbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', ownerAgent.data.api_key);
    assert.equal(ownerAgentInbox.status, 200);
    const submittedItem = ownerAgentInbox.data.data.find((item: any) => item.event_type === 'gate_attempt_submitted');
    assert.ok(submittedItem, 'Owner agent should have gate_attempt_submitted inbox item');
    assert.equal(submittedItem.payload.gate_attempt_id, attempt.data.id);
    assert.equal(submittedItem.payload.gate_id, gate.data.id);

    const unauthorizedAgentReview = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/gate-attempts/${attempt.data.id}/review`,
      otherAgent.data.api_key,
      { decision: 'approved', auto_merge: false },
    );
    assert.equal(unauthorizedAgentReview.status, 403);

    const ownerAgentReview = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/gate-attempts/${attempt.data.id}/review`,
      ownerAgent.data.api_key,
      { decision: 'approved', auto_merge: false, notes: 'Prefilter evidence is sufficient.' },
    );
    assert.equal(ownerAgentReview.status, 200);
    assert.equal(ownerAgentReview.data.status, 'approved');
    assert.equal(ownerAgentReview.data.reviewed_by_agent_id, ownerAgent.data.id);

    // Applicant's bound agent should receive gate_attempt_approved inbox item
    const applicantAgentInbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', applicantAgent.data.api_key);
    assert.equal(applicantAgentInbox.status, 200);
    const approvedItem = applicantAgentInbox.data.data.find((item: any) => item.event_type === 'gate_attempt_approved');
    assert.ok(approvedItem, 'Applicant bound agent should have gate_attempt_approved inbox item');
    assert.equal(approvedItem.payload.gate_attempt_id, attempt.data.id);

    const terminalPrefilter = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/gate-attempts/${attempt.data.id}/prefilter`,
      owner.token,
    );
    assert.equal(terminalPrefilter.status, 409);

    const joinRequests = await api(baseUrl, 'GET', `/v1/projects/${projectId}/join-requests`, owner.token);
    assert.equal(joinRequests.status, 200);
    assert.equal(joinRequests.data.data[0].status, 'approved');

    const applicantProjectView = await api(baseUrl, 'GET', `/v1/projects/${projectId}`, applicant.token);
    assert.equal(applicantProjectView.status, 200);

    console.log('gates tests passed');
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
    password: 'GatesTest123!',
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

async function apiWithKey(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
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
