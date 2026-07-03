import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'orchestrations-test-secret';

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
    const owner = await register(baseUrl, 'orch-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Orchestration Test',
      description: 'PM/worker markdown collaboration',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Main PM Agent',
    });
    assert.equal(mainAgent.status, 201);
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker Agent',
    });
    assert.equal(workerAgent.status, 201);
    const intruderAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Unassigned Agent',
    });
    assert.equal(intruderAgent.status, 201);

    const offlineOrchestration = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Blocked Offline Dispatch',
      objective: 'This orchestration must not dispatch to agents without a fresh heartbeat.',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id],
    });
    assert.equal(offlineOrchestration.status, 409);
    assert.equal(offlineOrchestration.data.code, 'AGENT_NOT_ONLINE');
    assert.deepEqual(
      offlineOrchestration.data.offline_agent_ids.sort(),
      [mainAgent.data.id, workerAgent.data.id].sort(),
    );

    const initialAgents = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents`, owner.token);
    assert.equal(initialAgents.status, 200);
    const initialMainAgent = initialAgents.data.data.find((agent: any) => agent.id === mainAgent.data.id);
    assert.equal(initialMainAgent.is_online, false);
    assert.equal(initialMainAgent.presence, 'offline');

    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);

    const onlineAgents = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents`, owner.token);
    assert.equal(onlineAgents.status, 200);
    const onlineMainAgent = onlineAgents.data.data.find((agent: any) => agent.id === mainAgent.data.id);
    const onlineWorkerAgent = onlineAgents.data.data.find((agent: any) => agent.id === workerAgent.data.id);
    assert.equal(onlineMainAgent.is_online, true);
    assert.equal(onlineMainAgent.presence, 'online');
    assert.equal(onlineWorkerAgent.is_online, true);
    assert.equal(onlineWorkerAgent.presence, 'online');

    const orchestration = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Ship PM Loop',
      objective: 'Implement a markdown-driven PM/worker loop.',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id],
      acceptance_criteria: ['Worker evidence is reviewed', 'PM can request changes'],
      plan: '1. Dispatch a task\n2. Review the result\n3. Complete after approval',
    });
    assert.equal(orchestration.status, 201);
    assert.equal(orchestration.data.status, 'planning');
    assert.equal(orchestration.data.main_agent_id, mainAgent.data.id);
    assert.equal(typeof orchestration.data.session_id, 'string');

    const initialFiles = await listFiles(baseUrl, owner.token, projectId, orchestration.data.base_path);
    assert.deepEqual(
      initialFiles.map((file: any) => file.path).sort(),
      [
        `${orchestration.data.base_path}/goal.md`,
        `${orchestration.data.base_path}/plan.md`,
        `${orchestration.data.base_path}/pm-review.md`,
        `${orchestration.data.base_path}/tasks.json`,
      ].sort(),
    );

    const session = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/sessions/${orchestration.data.session_id}`,
      mainAgent.data.api_key,
    );
    assert.equal(session.status, 200);
    assert.deepEqual(
      session.data.agent_ids.sort(),
      [mainAgent.data.id, workerAgent.data.id].sort(),
    );

    const offlineTaskAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Offline Task Agent',
    });
    assert.equal(offlineTaskAgent.status, 201);
    const offlineTask = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Do not dispatch offline',
        goal: 'This task should be rejected until the target agent is online.',
        assigned_agent_id: offlineTaskAgent.data.id,
      },
    );
    assert.equal(offlineTask.status, 409);
    assert.equal(offlineTask.data.code, 'AGENT_NOT_ONLINE');
    assert.deepEqual(offlineTask.data.offline_agent_ids, [offlineTaskAgent.data.id]);

    const task = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Build closed-loop test',
        goal: 'Prove that worker completion and PM review can repeat until approval.',
        assigned_agent_id: workerAgent.data.id,
        acceptance_criteria: ['Result file exists', 'Evidence file exists'],
        context: 'Use the platform orchestration endpoints.',
      },
    );
    assert.equal(task.status, 201);
    assert.equal(task.data.status, 'dispatched');
    assert.equal(task.data.assigned_agent_id, workerAgent.data.id);
    assert.equal(task.data.created_by_agent_id, mainAgent.data.id);
    // Dispatch hands off the task but does not yet mark it claimed; the claim
    // phase is recorded only when the worker engages the task.
    assert.equal(task.data.dispatched_at !== null, true, 'dispatched task should have dispatched_at');
    assert.equal(task.data.claimed_at, null, 'dispatched task should not yet be claimed');

    const intruderComplete = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/complete`,
      intruderAgent.data.api_key,
      { result_md: 'Trying to submit another agent task.', evidence: { invalid: true } },
    );
    assert.equal(intruderComplete.status, 403);

    const claim = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/claim`,
      workerAgent.data.api_key,
    );
    assert.equal(claim.status, 200);
    assert.equal(claim.data.status, 'running');
    // The claim path records the worker claim phase timestamp.
    assert.equal(typeof claim.data.claimed_at, 'string', 'claim should set claimed_at');
    assert.ok(new Date(claim.data.claimed_at).getTime() > 0, 'claimed_at should be a valid date');
    assert.equal(claim.data.dispatched_at !== null, true, 'claimed task still has dispatched_at');

    const firstComplete = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nInitial implementation notes. Result file exists and Evidence file exists.',
        evidence: { checks: ['smoke'], result: 'needs review' },
      },
    );
    assert.equal(firstComplete.status, 200);
    assert.equal(firstComplete.data.status, 'ready_for_review');
    assert.equal(firstComplete.data.result_path.endsWith('.result.md'), true);
    assert.equal(firstComplete.data.evidence_path.endsWith('.evidence.json'), true);

    const changes = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/review`,
      mainAgent.data.api_key,
      {
        decision: 'changes_requested',
        notes: 'Evidence needs stronger acceptance proof.',
        requested_changes: 'Add final verification details.',
      },
    );
    assert.equal(changes.status, 200);
    assert.equal(changes.data.status, 'changes_requested');
    assert.equal(changes.data.requested_changes, 'Add final verification details.');

    const secondComplete = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nFinal implementation notes with acceptance coverage. Result file exists and Evidence file exists.',
        evidence: { checks: ['smoke', 'pm-loop'], result: 'pass' },
      },
    );
    assert.equal(secondComplete.status, 200);
    assert.equal(secondComplete.data.status, 'ready_for_review');

    const approved = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/review`,
      mainAgent.data.api_key,
      { decision: 'approved', notes: 'Accepted.' },
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.data.status, 'approved');
    // Reviewed/approved task exposes the complete TTFT phase chain.
    assert.equal(typeof approved.data.dispatched_at, 'string', 'approved task has dispatched_at');
    assert.equal(typeof approved.data.claimed_at, 'string', 'approved task has claimed_at');
    assert.equal(typeof approved.data.completed_at, 'string', 'approved task has completed_at');
    assert.equal(typeof approved.data.reviewed_at, 'string', 'approved task has reviewed_at');

    const ready = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}`, owner.token);
    assert.equal(ready.status, 200);
    assert.equal(ready.data.status, 'ready_for_acceptance');
    assert.equal(ready.data.tasks.length, 1);
    assert.equal(ready.data.tasks[0].status, 'approved');

    const completed = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/complete`,
      mainAgent.data.api_key,
      { summary: 'Closed-loop orchestration accepted.' },
    );
    assert.equal(completed.status, 200);
    assert.equal(completed.data.status, 'completed');

    const lateOverwrite = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nLate overwrite attempt after approval.',
        evidence: { invalid: true },
      },
    );
    assert.equal(lateOverwrite.status, 409);

    const files = await listFiles(baseUrl, owner.token, projectId, orchestration.data.base_path);
    const paths = files.map((file: any) => file.path);
    assert.equal(paths.includes(task.data.worker_task_path), true);
    assert.equal(paths.includes(task.data.worker_context_path), true);
    assert.equal(paths.includes(secondComplete.data.result_path), true);
    assert.equal(paths.includes(secondComplete.data.evidence_path), true);

    const tasksJsonSummary = files.find((file: any) => file.path.endsWith('/tasks.json'));
    const tasksJson = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${tasksJsonSummary.id}`, owner.token);
    assert.equal(tasksJson.status, 200);
    assert.equal(JSON.parse(tasksJson.data.content)[0].status, 'approved');

    const reviewSummary = files.find((file: any) => file.path.endsWith('/pm-review.md'));
    const reviewFile = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${reviewSummary.id}`, owner.token);
    assert.equal(reviewFile.status, 200);
    assert.equal(reviewFile.data.content.includes('changes_requested'), true);
    assert.equal(reviewFile.data.content.includes('completed'), true);

    const workerView = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}`,
      workerAgent.data.api_key,
    );
    assert.equal(workerView.status, 200);

    // ── Concurrent claim race test ─────────────────────────────────────────
    // Verify that multiple concurrent claims on an unassigned task produce
    // exactly one winner (200) and the rest are rejected (409).
    const raceOwner = await register(baseUrl, 'race-owner');
    const raceProject = await api(baseUrl, 'POST', '/v1/projects', raceOwner.token, {
      name: 'Race Test',
      description: 'Concurrent claim atomicity test',
    });
    assert.equal(raceProject.status, 201);
    const raceProjectId = raceProject.data.id;

    // Create four agents: one main PM, three workers
    const raceMain = await api(baseUrl, 'POST', `/v1/projects/${raceProjectId}/agents`, raceOwner.token, { name: 'Race Main' });
    assert.equal(raceMain.status, 201);
    const raceW1 = await api(baseUrl, 'POST', `/v1/projects/${raceProjectId}/agents`, raceOwner.token, { name: 'Race Worker A' });
    assert.equal(raceW1.status, 201);
    const raceW2 = await api(baseUrl, 'POST', `/v1/projects/${raceProjectId}/agents`, raceOwner.token, { name: 'Race Worker B' });
    assert.equal(raceW2.status, 201);
    const raceW3 = await api(baseUrl, 'POST', `/v1/projects/${raceProjectId}/agents`, raceOwner.token, { name: 'Race Worker C' });
    assert.equal(raceW3.status, 201);

    await heartbeatAgent(baseUrl, raceMain.data.api_key);
    await heartbeatAgent(baseUrl, raceW1.data.api_key);
    await heartbeatAgent(baseUrl, raceW2.data.api_key);
    await heartbeatAgent(baseUrl, raceW3.data.api_key);

    const raceOrch = await apiWithKey(baseUrl, 'POST', `/v1/projects/${raceProjectId}/orchestrations`, raceMain.data.api_key, {
      title: 'Claim Race',
      objective: 'Test atomic claim semantics.',
      main_agent_id: raceMain.data.id,
      worker_agent_ids: [raceW1.data.id, raceW2.data.id, raceW3.data.id],
    });
    assert.equal(raceOrch.status, 201);

    // Create an unassigned task so any agent can race to claim it.
    const raceTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks`, raceMain.data.api_key, {
      title: 'Race Target',
      goal: 'Multiple workers race to claim this task.',
      // No assigned_agent_id — first come first served.
    });
    assert.equal(raceTask.status, 201);
    assert.equal(raceTask.data.status, 'dispatched');
    assert.equal(raceTask.data.assigned_agent_id, null);

    // Fire three concurrent claims.
    const [cr1, cr2, cr3] = await Promise.all([
      apiWithKey(baseUrl, 'PATCH', `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks/${raceTask.data.id}/claim`, raceW1.data.api_key),
      apiWithKey(baseUrl, 'PATCH', `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks/${raceTask.data.id}/claim`, raceW2.data.api_key),
      apiWithKey(baseUrl, 'PATCH', `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks/${raceTask.data.id}/claim`, raceW3.data.api_key),
    ]);

    const statuses = [cr1.status, cr2.status, cr3.status].sort();
    const winners = statuses.filter((s) => s === 200).length;
    const losers = statuses.filter((s) => s === 403 || s === 409).length;
    assert.equal(winners, 1, "expected exactly one 200, got " + JSON.stringify(statuses));
    assert.equal(losers, 2, "expected exactly two 403/409, got " + JSON.stringify(statuses));
    // Losers may be 403 (assigned to another worker) or 409 (already claimed) —
    // both are correct denial codes depending on race timing.

    // The winner should have the running status and a claimed_at timestamp.
    const winnerResponse = [cr1, cr2, cr3].find((r) => r.status === 200);
    assert.ok(winnerResponse, 'should have one winner');
    assert.equal(winnerResponse!.data.status, 'running');
    assert.equal(typeof winnerResponse!.data.claimed_at, 'string', 'winner should have claimed_at');
    const winnerAgentId = winnerResponse!.data.assigned_agent_id;
    assert.equal(typeof winnerAgentId, 'string', 'winner should have an assigned_agent_id');

    // ── Idempotent re-claim boundary tests ──────────────────────────────────
    // 1. Same-agent re-claim → must return 200 (idempotent).
    const winnerKey = [raceW1, raceW2, raceW3].find((w) => w.data.id === winnerAgentId)!.data.api_key;
    const reClaimSame = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks/${raceTask.data.id}/claim`,
      winnerKey,
    );
    assert.equal(reClaimSame.status, 200, 'same-agent re-claim should be idempotent 200');
    assert.equal(reClaimSame.data.status, 'running', 'idempotent re-claim returns running');

    // 2. Loser (different agent) re-claim → must return 403.
    const loserResponse = [cr1, cr2, cr3].find((r) => r.status !== 200)!;
    const loserKey = [raceW1, raceW2, raceW3].find((w) => w.data.id !== winnerAgentId)!.data.api_key;
    const reClaimLoser = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks/${raceTask.data.id}/claim`,
      loserKey,
    );
    assert.equal(reClaimLoser.status, 403, 'different-agent re-claim should be 403');

    // 3. JWT/user re-claim on assigned task → must return 409.
    const userReClaim = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks/${raceTask.data.id}/claim`,
      raceOwner.token,
    );
    assert.equal(userReClaim.status, 409, 'JWT user re-claim on assigned task should be 409');

    // 4. User-claims-unassigned-task then re-claims → must return 409, proving
    //    that idempotency is NOT granted to non-agent principals.
    const userClaimTask = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks`,
      raceMain.data.api_key,
      { title: 'User Claim Target', goal: 'User claims this unassigned task.' },
    );
    assert.equal(userClaimTask.status, 201);
    assert.equal(userClaimTask.data.assigned_agent_id, null);

    // First claim by JWT user — succeeds (task is dispatched/claimable).
    const firstUserClaim = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks/${userClaimTask.data.id}/claim`,
      raceOwner.token,
    );
    assert.equal(firstUserClaim.status, 200, 'first JWT user claim should succeed');
    assert.equal(firstUserClaim.data.status, 'running');

    // Re-claim by same JWT user — with the old code this returned 200
    // (null === null match). With the fix it correctly returns 409.
    const secondUserClaim = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${raceProjectId}/orchestrations/${raceOrch.data.id}/tasks/${userClaimTask.data.id}/claim`,
      raceOwner.token,
    );
    assert.equal(secondUserClaim.status, 409, 'JWT user re-claim: expected 409, not idempotent 200');

    console.log('orchestrations tests passed');
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
    password: 'OrchestrationTest123!',
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
  assert.equal(response.data.presence, 'online');
  assert.equal(response.data.is_online, true);
  assert.equal(response.data.dispatchable, true);
  assert.equal(typeof response.data.next_heartbeat_at, 'string');
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
