import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'agent-inbox-test-secret';

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
    // Setup: register user, create project, register agents, heartbeat
    const owner = await register(baseUrl, 'inbox-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Inbox Test Project',
      description: 'Durable inbox and workload ledger testing',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Main Agent',
    });
    assert.equal(mainAgent.status, 201);

    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker Agent',
    });
    assert.equal(workerAgent.status, 201);

    // Heartbeat both agents to make them online
    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);

    // Bind mainAgent as owner's owner-agent for join request notifications
    const ownerBind = await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', owner.token, {
      agent_id: mainAgent.data.id,
    });
    assert.equal(ownerBind.status, 200);

    // ─── Test 1: GET /v1/agent/projects ─────────────────────────────────────
    console.log('Test 1: Agent project discovery');
    const projectDiscovery = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/projects', workerAgent.data.api_key,
    );
    assert.equal(projectDiscovery.status, 200);
    assert.equal(projectDiscovery.data.data.length, 1);
    assert.equal(projectDiscovery.data.data[0].project.id, projectId);
    assert.equal(projectDiscovery.data.data[0].agent.id, workerAgent.data.id);
    assert.equal(projectDiscovery.data.data[0].role, 'agent');

    // ─── Test 2: Heartbeat includes pending_inbox_count ─────────────────────
    console.log('Test 2: Heartbeat pending_inbox_count');
    const heartbeatBefore = await apiWithKey(
      baseUrl, 'POST', '/v1/agents/heartbeat', workerAgent.data.api_key,
      { status: 'healthy' },
    );
    assert.equal(heartbeatBefore.status, 200);
    assert.equal(heartbeatBefore.data.pending_inbox_count, 0);

    // ─── Join request inbox tests ─────────────────────────────────────────────
    console.log('Join request inbox tests');
    const applicant = await register(baseUrl, 'inbox-applicant');

    // Applicant creates join request
    const joinReq = await api(baseUrl, 'POST', `/v1/projects/${projectId}/join-requests`, applicant.token, {
      note: 'Please let me in',
    });
    assert.equal(joinReq.status, 201);

    // Main agent (bound to owner) should receive join_request_created
    const mainAgentInboxJoin = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?event_type=join_request_created', mainAgent.data.api_key,
    );
    assert.equal(mainAgentInboxJoin.status, 200);
    const joinCreatedItem = mainAgentInboxJoin.data.data.find(
      (item: any) => item.event_type === 'join_request_created',
    );
    assert.ok(joinCreatedItem, 'Main agent should have join_request_created inbox item');
    assert.equal(joinCreatedItem.payload.project_id, projectId);
    assert.equal(joinCreatedItem.payload.user_id, applicant.userId);

    // Applicant creates own project + agent and binds it
    const applicantProject = await api(baseUrl, 'POST', '/v1/projects', applicant.token, {
      name: 'Applicant Project',
      description: 'Personal project',
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

    // Owner approves join request
    const approveJoin = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/join-requests/${joinReq.data.id}`, owner.token, {
      status: 'approved',
    });
    assert.equal(approveJoin.status, 200);

    // Applicant's bound agent should receive join_request_approved
    const applicantAgentInboxJoin = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?event_type=join_request_approved', applicantAgent.data.api_key,
    );
    assert.equal(applicantAgentInboxJoin.status, 200);
    const joinApprovedItem = applicantAgentInboxJoin.data.data.find(
      (item: any) => item.event_type === 'join_request_approved',
    );
    assert.ok(joinApprovedItem, 'Applicant bound agent should have join_request_approved inbox item');
    assert.equal(joinApprovedItem.payload.project_id, projectId);
    assert.equal(joinApprovedItem.payload.user_id, applicant.userId);

    // ─── Test 3: Task dispatch creates inbox item for worker ────────────────
    console.log('Test 3: Task dispatch creates inbox item');
    const orchestration = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Inbox Orchestration',
      objective: 'Test durable inbox notifications',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id],
    });
    assert.equal(orchestration.status, 201);

    const task = await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Test task for inbox',
        goal: 'Verify inbox notifications are created',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(task.status, 201);

    // Worker should now have an inbox item
    const workerInbox = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox', workerAgent.data.api_key,
    );
    assert.equal(workerInbox.status, 200);
    assert.equal(workerInbox.data.data.length, 1);
    assert.equal(workerInbox.data.data[0].event_type, 'task_dispatched');
    assert.equal(workerInbox.data.data[0].orchestration_id, orchestration.data.id);
    assert.equal(workerInbox.data.data[0].task_id, task.data.id);
    assert.equal(workerInbox.data.data[0].status, 'unread');

    // ─── Test 4: Heartbeat now shows pending inbox ──────────────────────────
    console.log('Test 4: Heartbeat shows pending inbox count');
    const heartbeatAfter = await apiWithKey(
      baseUrl, 'POST', '/v1/agents/heartbeat', workerAgent.data.api_key,
      { status: 'healthy' },
    );
    assert.equal(heartbeatAfter.status, 200);
    assert.equal(heartbeatAfter.data.pending_inbox_count, 1);

    // ─── Test 5: Inbox ack marks item as acked ──────────────────────────────
    console.log('Test 5: Inbox ack');
    const inboxItemId = workerInbox.data.data[0].id;
    const ackResult = await apiWithKey(
      baseUrl, 'POST', `/v1/agent/inbox/${inboxItemId}/ack`, workerAgent.data.api_key,
    );
    assert.equal(ackResult.status, 200);
    assert.equal(ackResult.data.status, 'acked');
    assert.ok(ackResult.data.acked_at);
    assert.ok(ackResult.data.read_at);

    // Pending count should be 0 now
    const heartbeatAcked = await apiWithKey(
      baseUrl, 'POST', '/v1/agents/heartbeat', workerAgent.data.api_key,
      { status: 'healthy' },
    );
    assert.equal(heartbeatAcked.data.pending_inbox_count, 0);

    // ─── Test 6: Task complete creates inbox item for main agent ────────────
    console.log('Test 6: Task complete notifies main agent');
    await apiWithKey(
      baseUrl, 'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/claim`,
      workerAgent.data.api_key,
    );

    const completeResult = await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nTask completed successfully.',
        evidence: { files_changed: ['inbox-result.md'], verified: true },
        status: 'ready_for_review',
      },
    );
    assert.equal(completeResult.status, 200);

    // Main agent should have an inbox item about completion
    const mainInbox = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox', mainAgent.data.api_key,
    );
    assert.equal(mainInbox.status, 200);
    const completionItem = mainInbox.data.data.find(
      (item: any) => item.event_type === 'task_ready_for_review',
    );
    assert.ok(completionItem, 'Main agent should have task_ready_for_review inbox item');
    assert.equal(completionItem.task_id, task.data.id);

    // ─── Test 7: Review changes_requested creates worker inbox item ─────────
    console.log('Test 7: Review changes_requested notifies worker');
    const changesReview = await apiWithKey(
      baseUrl, 'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/review`,
      mainAgent.data.api_key,
      {
        decision: 'changes_requested',
        notes: 'Need more evidence',
        requested_changes: 'Add verification details',
      },
    );
    assert.equal(changesReview.status, 200);

    // Worker should have a changes_requested inbox item
    const workerInboxAfterReview = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox', workerAgent.data.api_key,
    );
    const changesItem = workerInboxAfterReview.data.data.find(
      (item: any) => item.event_type === 'task_changes_requested',
    );
    assert.ok(changesItem, 'Worker should have task_changes_requested inbox item');

    // ─── Test 8: Review approved creates worker inbox item ──────────────────
    console.log('Test 8: Review approved notifies worker');
    // Complete again after changes requested
    const secondComplete = await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nUpdated with verification details.',
        evidence: { files_changed: ['inbox-result.md'], verified: true, details: 'all checks pass' },
        status: 'ready_for_review',
      },
    );
    assert.equal(secondComplete.status, 200);

    const approveReview = await apiWithKey(
      baseUrl, 'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks/${task.data.id}/review`,
      mainAgent.data.api_key,
      { decision: 'approved', auto_merge: false, notes: 'Looks good' },
    );
    assert.equal(approveReview.status, 200);

    // Worker should have an approved inbox item
    const workerInboxApproved = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox', workerAgent.data.api_key,
    );
    const approvedItem = workerInboxApproved.data.data.find(
      (item: any) => item.event_type === 'task_approved',
    );
    assert.ok(approvedItem, 'Worker should have task_approved inbox item');

    // ─── Test 9: Workload ledger ────────────────────────────────────────────
    console.log('Test 9: Workload ledger');
    const workload = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/workload', workerAgent.data.api_key,
    );
    assert.equal(workload.status, 200);
    assert.ok(workload.data.summary);
    assert.ok(workload.data.summary.total_units >= 1);
    assert.ok(workload.data.recent.length >= 1);

    const workUnit = workload.data.recent.find(
      (wu: any) => wu.task_id === task.data.id,
    );
    assert.ok(workUnit, 'Workload ledger should have a work unit for the task');
    assert.equal(workUnit.review_decision, 'approved');
    assert.equal(workUnit.status, 'reviewed_approved');
    assert.ok(workUnit.completed_at);
    assert.ok(workUnit.reviewed_at);

    // ─── Test 10: Inbox unread filter ───────────────────────────────────────
    console.log('Test 10: Inbox filters');
    const unreadOnly = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?unread=true', workerAgent.data.api_key,
    );
    assert.equal(unreadOnly.status, 200);
    for (const item of unreadOnly.data.data) {
      assert.equal(item.status, 'unread');
    }

    // ─── Test 11: Inbox event_type filter ───────────────────────────────────
    console.log('Test 11: Inbox event_type filter');
    const filteredInbox = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?event_type=task_approved', workerAgent.data.api_key,
    );
    assert.equal(filteredInbox.status, 200);
    for (const item of filteredInbox.data.data) {
      assert.equal(item.event_type, 'task_approved');
    }

    // ─── Test 12: Inbox 404 on wrong agent ack ─────────────────────────────
    console.log('Test 12: Inbox ack wrong agent');
    const wrongAck = await apiWithKey(
      baseUrl, 'POST', `/v1/agent/inbox/${inboxItemId}`, mainAgent.data.api_key,
    );
    assert.equal(wrongAck.status, 404);

    // ─── Test 13: Main agent workload ledger ────────────────────────────────
    console.log('Test 13: Main agent workload');
    const mainWorkload = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/workload', mainAgent.data.api_key,
    );
    assert.equal(mainWorkload.status, 200);
    assert.ok(mainWorkload.data.summary);

    // ─── Test 14: Task blocked creates inbox for main agent ─────────────────
    console.log('Test 14: Task blocked notification');

    // Complete the orchestration first (required for all tasks to be approved)
    await apiWithKey(
      baseUrl, 'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/complete`,
      mainAgent.data.api_key,
      { summary: 'Done' },
    );

    // Worker should receive orchestration_completed inbox item
    const workerInboxComplete = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?event_type=orchestration_completed', workerAgent.data.api_key,
    );
    assert.equal(workerInboxComplete.status, 200);
    assert.ok(workerInboxComplete.data.data.length >= 1, 'Worker should have orchestration_completed inbox item');
    const orchCompletedItem = workerInboxComplete.data.data.find(
      (item: any) => item.event_type === 'orchestration_completed',
    );
    assert.ok(orchCompletedItem, 'Worker should have orchestration_completed inbox item');
    assert.equal(orchCompletedItem.payload.project_id, projectId);
    assert.equal(orchCompletedItem.payload.orchestration_id, orchestration.data.id);

    // Create a new orchestration with a blocked task
    const orch2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Blocked Task Test',
      objective: 'Test blocked task notification',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id],
    });
    assert.equal(orch2.status, 201);

    const task2 = await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orch2.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Blocked task',
        goal: 'Will be blocked',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(task2.status, 201);

    await apiWithKey(
      baseUrl, 'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orch2.data.id}/tasks/${task2.data.id}/claim`,
      workerAgent.data.api_key,
    );

    const blockedComplete = await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orch2.data.id}/tasks/${task2.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Blocked\n\nBlocked on dependency.',
        evidence: { files_changed: [], reason: 'dependency missing' },
        status: 'blocked',
      },
    );
    assert.equal(blockedComplete.status, 200);
    assert.equal(blockedComplete.data.status, 'blocked');

    // Main agent should have a task_blocked inbox item
    const mainInboxBlocked = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?event_type=task_blocked', mainAgent.data.api_key,
    );
    assert.equal(mainInboxBlocked.status, 200);
    assert.ok(mainInboxBlocked.data.data.length >= 1, 'Main agent should have task_blocked inbox item');

    console.log('All agent inbox tests passed');
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
    password: 'InboxTest123!',
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
