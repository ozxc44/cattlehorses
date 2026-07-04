import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'reward-preview-test-secret';

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
    // Setup: register owner, create project, register agents
    const owner = await register(baseUrl, 'rp-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Reward Preview Project',
      description: 'P1 reward preview testing',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const admin = await register(baseUrl, 'rp-admin');
    // Add admin as admin
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: admin.userId,
      role: 'admin',
    });

    const member = await register(baseUrl, 'rp-member');
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: member.userId,
      role: 'member',
    });

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'RP Main Agent',
    });
    assert.equal(mainAgent.status, 201);

    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'RP Worker Agent',
    });
    assert.equal(workerAgent.status, 201);

    // Heartbeat
    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);

    // Bind mainAgent as owner-agent
    await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', owner.token, {
      agent_id: mainAgent.data.id,
    });

    // Create orchestration and task
    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Reward Preview Orchestration',
      objective: 'Test reward preview',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id],
    });
    assert.equal(orch.status, 201);

    const task = await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orch.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Reward preview test task',
        goal: 'Verify reward preview',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(task.status, 201);

    // Claim and complete
    await apiWithKey(
      baseUrl, 'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orch.data.id}/tasks/${task.data.id}/claim`,
      workerAgent.data.api_key,
    );

    await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orch.data.id}/tasks/${task.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nTask completed.',
        evidence: { files_changed: ['reward-preview.md'], verified: true },
        status: 'ready_for_review',
      },
    );

    // Approve review
    await apiWithKey(
      baseUrl, 'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orch.data.id}/tasks/${task.data.id}/review`,
      mainAgent.data.api_key,
      { decision: 'approved', auto_merge: false, notes: 'Good work' },
    );

    // ─── Test 1: Reward preview returns deterministic output ──────────────────
    console.log('Test 1: Reward preview deterministic output');
    const preview1 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/reward-preview`, owner.token);
    assert.equal(preview1.status, 200);
    assert.equal(preview1.data.project_id, projectId);
    assert.equal(preview1.data.rule_version, 'v1');
    assert.ok(preview1.data.summary);
    assert.ok(preview1.data.contributions);
    assert.ok(Array.isArray(preview1.data.contributions));
    assert.ok(preview1.data.contributions.length >= 1);

    const workerRow = preview1.data.contributions.find(
      (c: any) => c.agent_id === workerAgent.data.id,
    );
    assert.ok(workerRow, 'Should have worker contribution');
    assert.equal(workerRow.agent_name, 'RP Worker Agent');
    assert.equal(workerRow.total_tasks, 1);
    assert.equal(workerRow.reviewed_tasks, 1);
    assert.equal(workerRow.provisional_units, 1);
    assert.equal(workerRow.final_units, 1);
    assert.equal(workerRow.adjusted_final_units, 1);
    assert.equal(workerRow.estimated_share_percent, 100);

    // Same request should yield same values
    const preview2 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/reward-preview`, owner.token);
    assert.deepStrictEqual(preview1.data.contributions, preview2.data.contributions);

    // ─── Test 2: Recalculate stores rule version and snapshot ─────────────────
    console.log('Test 2: Recalculate stores rule version and snapshot');
    const recalc = await api(baseUrl, 'POST', `/v1/projects/${projectId}/reward-preview/recalculate`, owner.token);
    assert.equal(recalc.status, 200);
    assert.equal(recalc.data.recalculated, 1);
    assert.ok(recalc.data.rule_version.startsWith('v1-'));
    assert.ok(recalc.data.preview);

    const previewAfterRecalc = await api(baseUrl, 'GET', `/v1/projects/${projectId}/reward-preview`, owner.token);
    assert.equal(previewAfterRecalc.data.rule_version, recalc.data.rule_version);

    // ─── Test 3: Admin can access reward preview ──────────────────────────────
    console.log('Test 3: Admin can access reward preview');
    const adminPreview = await api(baseUrl, 'GET', `/v1/projects/${projectId}/reward-preview`, admin.token);
    assert.equal(adminPreview.status, 200);
    assert.ok(adminPreview.data.contributions.length >= 1);

    // ─── Test 4: Member cannot access reward preview ──────────────────────────
    console.log('Test 4: Member cannot access reward preview');
    const memberPreview = await api(baseUrl, 'GET', `/v1/projects/${projectId}/reward-preview`, member.token);
    assert.equal(memberPreview.status, 403, 'Member should be denied');

    // ─── Test 5: Stranger cannot access reward preview ────────────────────────
    console.log('Test 5: Stranger cannot access reward preview');
    const stranger = await register(baseUrl, 'rp-stranger');
    const strangerPreview = await api(baseUrl, 'GET', `/v1/projects/${projectId}/reward-preview`, stranger.token);
    assert.equal(strangerPreview.status, 403, 'Stranger should be denied');

    // ─── Test 6: Agent cannot access reward preview ───────────────────────────
    console.log('Test 6: Agent cannot access reward preview');
    const agentPreview = await apiWithKey(
      baseUrl, 'GET',
      `/v1/projects/${projectId}/reward-preview`,
      workerAgent.data.api_key,
    );
    assert.equal(agentPreview.status, 401, 'Agent API key should be denied (JWT required)');

    // ─── Test 7: Manual adjustment requires reason and changes preview ────────
    console.log('Test 7: Manual adjustment requires reason and changes preview');
    const workload = await apiWithKey(baseUrl, 'GET', '/v1/agent/workload', workerAgent.data.api_key);
    const workUnit = workload.data.recent.find((wu: any) => wu.task_id === task.data.id);
    assert.ok(workUnit);

    // Missing reason
    const noReason = await api(baseUrl, 'POST', `/v1/work-units/${workUnit.id}/adjust`, owner.token, {
      adjustment_value: 0.5,
    });
    assert.equal(noReason.status, 422, 'Missing reason should fail');

    // Empty reason
    const emptyReason = await api(baseUrl, 'POST', `/v1/work-units/${workUnit.id}/adjust`, owner.token, {
      adjustment_value: 0.5,
      reason: '   ',
    });
    assert.equal(emptyReason.status, 422, 'Empty reason should fail');

    // Valid adjustment
    const adjust = await api(baseUrl, 'POST', `/v1/work-units/${workUnit.id}/adjust`, owner.token, {
      adjustment_value: 0.5,
      reason: 'Bonus for exceptional quality',
    });
    assert.equal(adjust.status, 200);
    assert.equal(adjust.data.adjustment_value, 0.5);
    assert.equal(adjust.data.adjustment_reason, 'Bonus for exceptional quality');
    assert.equal(adjust.data.adjusted_by_user_id, owner.userId);
    assert.ok(adjust.data.locked_at);

    // Preview reflects adjustment
    const previewAfterAdjust = await api(baseUrl, 'GET', `/v1/projects/${projectId}/reward-preview`, owner.token);
    const adjustedRow = previewAfterAdjust.data.contributions.find(
      (c: any) => c.agent_id === workerAgent.data.id,
    );
    assert.equal(adjustedRow.adjustment_total, 0.5);
    assert.equal(adjustedRow.adjusted_final_units, 1.5);
    assert.equal(adjustedRow.adjustment_reason, 'Bonus for exceptional quality');
    assert.ok(adjustedRow.estimated_share_percent > 0);

    // Admin can also adjust
    const adminAdjust = await api(baseUrl, 'POST', `/v1/work-units/${workUnit.id}/adjust`, admin.token, {
      adjustment_value: -0.2,
      reason: 'Correction by admin',
    });
    assert.equal(adminAdjust.status, 200);

    // Member cannot adjust
    const memberAdjust = await api(baseUrl, 'POST', `/v1/work-units/${workUnit.id}/adjust`, member.token, {
      adjustment_value: 1.0,
      reason: 'Unauthorized',
    });
    assert.equal(memberAdjust.status, 403, 'Member should not adjust');

    // ─── Test 8: Unauthorized user cannot adjust ──────────────────────────────
    console.log('Test 8: Unauthorized user cannot adjust');
    const strangerAdjust = await api(baseUrl, 'POST', `/v1/work-units/${workUnit.id}/adjust`, stranger.token, {
      adjustment_value: 1.0,
      reason: 'Unauthorized',
    });
    assert.equal(strangerAdjust.status, 403, 'Stranger should not adjust');

    // ─── Test 9: Adjustment to nonexistent work unit returns 404 ──────────────
    console.log('Test 9: Adjustment to nonexistent work unit');
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const fakeAdjust = await api(baseUrl, 'POST', `/v1/work-units/${fakeId}/adjust`, owner.token, {
      adjustment_value: 1.0,
      reason: 'Test',
    });
    assert.equal(fakeAdjust.status, 404);

    // ─── Test 10: CSV export works ────────────────────────────────────────────
    console.log('Test 10: CSV export');
    const csvResponse = await apiRaw(
      baseUrl, 'GET',
      `/v1/projects/${projectId}/reward-preview?format=csv`,
      owner.token,
    );
    assert.equal(csvResponse.status, 200);
    assert.ok(csvResponse.contentType?.includes('text/csv'));
    assert.ok(csvResponse.text.includes('agent_id,agent_name'));
    assert.ok(csvResponse.text.includes(workerAgent.data.id));
    assert.ok(csvResponse.text.includes('RP Worker Agent'));

    // ─── Test 11: Private project not visible to strangers ────────────────────
    console.log('Test 11: Private project visibility');
    assert.equal(strangerPreview.status, 403);

    console.log('All reward-preview tests passed');
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
    password: 'RewardPreviewTest!',
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

async function apiRaw(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
): Promise<{ status: number; text: string; contentType: string | null }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers });
  const text = await response.text();
  return {
    status: response.status,
    text,
    contentType: response.headers.get('content-type'),
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
