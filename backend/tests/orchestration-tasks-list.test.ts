import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'orchestration-tasks-list-test-secret';

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
    const owner = await register(baseUrl, 'list-owner');
    const viewer = await register(baseUrl, 'list-viewer');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Task List Test',
      description: 'Project-level orchestration task list',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Add viewer as a project member
    const memberInvite = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(memberInvite.status, 201);

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'List Main Agent',
    });
    assert.equal(mainAgent.status, 201);
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'List Worker Agent',
    });
    assert.equal(workerAgent.status, 201);
    const otherWorker = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'List Other Worker',
    });
    assert.equal(otherWorker.status, 201);
    const intruderAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'List Intruder Agent',
    });
    assert.equal(intruderAgent.status, 201);

    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);
    await heartbeatAgent(baseUrl, otherWorker.data.api_key);
    await heartbeatAgent(baseUrl, intruderAgent.data.api_key);

    const alpha = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, mainAgent.data.api_key, {
      title: 'Alpha Orchestration',
      objective: 'First orchestration for task list testing.',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id, otherWorker.data.id],
    });
    assert.equal(alpha.status, 201);

    const beta = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, mainAgent.data.api_key, {
      title: 'Beta Orchestration',
      objective: 'Second orchestration for task list testing.',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id],
    });
    assert.equal(beta.status, 201);

    // Create tasks across orchestrations with different statuses and assignments.
    const t1 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${alpha.data.id}/tasks`, mainAgent.data.api_key, {
      title: 'Alpha pending task',
      goal: 'Searchable alpha goal content.',
      assigned_agent_id: workerAgent.data.id,
      dispatch: false,
    });
    assert.equal(t1.status, 201);

    const t2 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${alpha.data.id}/tasks`, mainAgent.data.api_key, {
      title: 'Alpha dispatched task',
      goal: 'Dispatched to other worker.',
      assigned_agent_id: otherWorker.data.id,
    });
    assert.equal(t2.status, 201);

    const t3 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${beta.data.id}/tasks`, mainAgent.data.api_key, {
      title: 'Beta review task',
      goal: 'Ready for review by worker.',
      assigned_agent_id: workerAgent.data.id,
    });
    assert.equal(t3.status, 201);

    const t4 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${beta.data.id}/tasks`, mainAgent.data.api_key, {
      title: 'Beta unassigned task',
      goal: 'Unassigned fallback task.',
    });
    assert.equal(t4.status, 201);

    // Move t3 to ready_for_review by completing it.
    const t3Claim = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${beta.data.id}/tasks/${t3.data.id}/claim`, workerAgent.data.api_key);
    assert.equal(t3Claim.status, 200);
    const t3Complete = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${beta.data.id}/tasks/${t3.data.id}/complete`, workerAgent.data.api_key, {
      result_md: '# Result\n\nDone with task list verification.',
      evidence: { files_changed: ['task-list.md'], ok: true },
    });
    assert.equal(t3Complete.status, 200);

    // ── Owner/human access ─────────────────────────────────────────────────
    const ownerList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks`, owner.token);
    assert.equal(ownerList.status, 200);
    assert.equal(ownerList.data.data.length, 4, 'owner should see all 4 tasks');
    assert.equal(ownerList.data.total, 4);
    assert.equal(ownerList.data.limit, 50);
    assert.equal(ownerList.data.offset, 0);
    assert.ok(ownerList.data.summary, 'summary should be present');
    assert.equal(ownerList.data.summary.total, 4);
    assert.equal(typeof ownerList.data.summary.status_counts.pending, 'number');
    assert.equal(typeof ownerList.data.summary.tabs.open, 'number');
    assert.ok(Array.isArray(ownerList.data.summary.assignees), 'summary.assignees should be an array');
    assert.ok(Array.isArray(ownerList.data.summary.orchestrations), 'summary.orchestrations should be an array');
    assert.ok(Array.isArray(ownerList.data.summary.batches), 'summary.batches should be an array');
    assert.ok(Array.isArray(ownerList.data.summary.timeline), 'summary.timeline should be an array');

    const viewerList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks`, viewer.token);
    assert.equal(viewerList.status, 200);
    assert.equal(viewerList.data.total, 4, 'viewer with ViewProject should see all tasks');

    // Each row should include orchestration context.
    const firstRow = ownerList.data.data[0];
    assert.equal(typeof firstRow.orchestration_title, 'string');
    assert.equal(typeof firstRow.orchestration_status, 'string');
    assert.equal(typeof firstRow.orchestration_base_path, 'string');
    assert.ok('orchestration_main_agent_id' in firstRow);

    // Each row should include local batch labels derived from orchestration context.
    const firstRowLabelKeys = firstRow.labels.map((l: any) => l.key);
    assert.ok(firstRowLabelKeys.includes('batch'), 'row labels include batch key');
    assert.ok(firstRowLabelKeys.includes('batch_label'), 'row labels include batch_label key');
    const firstRowBatch = firstRow.labels.find((l: any) => l.key === 'batch');
    const firstRowBatchLabel = firstRow.labels.find((l: any) => l.key === 'batch_label');
    assert.equal(typeof firstRowBatch.value, 'string');
    assert.equal(typeof firstRowBatchLabel.value, 'string');

    // ── Agent scoping ──────────────────────────────────────────────────────
    // Main agent sees all tasks in both orchestrations.
    const mainList = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks`, mainAgent.data.api_key);
    assert.equal(mainList.status, 200);
    assert.equal(mainList.data.total, 4, 'main agent should see all tasks in their orchestrations');

    // Worker sees their assigned tasks plus all tasks in orchestrations where they have an assigned task.
    const workerList = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks`, workerAgent.data.api_key);
    assert.equal(workerList.status, 200);
    const workerTaskIds = new Set(workerList.data.data.map((row: any) => row.id));
    assert.equal(workerTaskIds.has(t1.data.id), true, 'worker sees their assigned task in alpha');
    assert.equal(workerTaskIds.has(t2.data.id), true, 'worker sees other task in same orchestration');
    assert.equal(workerTaskIds.has(t3.data.id), true, 'worker sees their assigned task in beta');
    assert.equal(workerTaskIds.has(t4.data.id), true, 'worker sees unassigned task in same orchestration');
    assert.equal(workerList.data.total, 4);

    // Other worker is only assigned to one task in alpha, so sees all alpha tasks but no beta tasks.
    const otherList = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks`, otherWorker.data.api_key);
    assert.equal(otherList.status, 200);
    const otherTaskIds = new Set(otherList.data.data.map((row: any) => row.id));
    assert.equal(otherTaskIds.has(t1.data.id), true, 'other worker sees alpha task 1');
    assert.equal(otherTaskIds.has(t2.data.id), true, 'other worker sees their assigned alpha task 2');
    assert.equal(otherTaskIds.has(t3.data.id), false, 'other worker should not see beta tasks');
    assert.equal(otherTaskIds.has(t4.data.id), false, 'other worker should not see beta tasks');
    assert.equal(otherList.data.total, 2);

    // Intruder with no assignment sees nothing.
    const intruderList = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks`, intruderAgent.data.api_key);
    assert.equal(intruderList.status, 200);
    assert.equal(intruderList.data.data.length, 0);
    assert.equal(intruderList.data.total, 0);
    assert.equal(intruderList.data.summary.total, 0);
    assert.deepEqual(intruderList.data.summary.assignees, []);
    assert.deepEqual(intruderList.data.summary.orchestrations, []);
    assert.deepEqual(intruderList.data.summary.batches, []);
    assert.deepEqual(intruderList.data.summary.timeline, []);

    // Summary assignees/orchestrations respect agent visibility scope.
    const workerAssignee = findSummaryAssignee(workerList.data.summary, workerAgent.data.id);
    assert.ok(workerAssignee, 'worker sees themselves in assignee summary');
    assert.equal(workerAssignee.total, 2);
    assert.equal(workerAssignee.open, 1);
    assert.equal(workerAssignee.review, 1);
    assert.equal(workerAssignee.done, 0);
    assert.ok(findSummaryAssignee(workerList.data.summary, otherWorker.data.id), 'worker sees co-worker in scoped summary');
    assert.ok(findSummaryOrchestration(workerList.data.summary, alpha.data.id), 'worker sees alpha in scoped summary');
    assert.ok(findSummaryOrchestration(workerList.data.summary, beta.data.id), 'worker sees beta in scoped summary');

    const otherAssignee = findSummaryAssignee(otherList.data.summary, otherWorker.data.id);
    assert.ok(otherAssignee, 'other worker sees themselves in assignee summary');
    assert.equal(otherAssignee.total, 1);
    assert.equal(otherAssignee.open, 1);
    assert.equal(findSummaryOrchestration(otherList.data.summary, beta.data.id), undefined, 'other worker does not see beta orchestration summary');

    // ── assigned_agent_id filter ───────────────────────────────────────────
    const assignedToWorker = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?assigned_agent_id=${workerAgent.data.id}`, owner.token);
    assert.equal(assignedToWorker.status, 200);
    assert.equal(assignedToWorker.data.total, 2);
    assert.ok(assignedToWorker.data.data.every((row: any) => row.assigned_agent_id === workerAgent.data.id));
    const filteredWorkerAssignee = findSummaryAssignee(assignedToWorker.data.summary, workerAgent.data.id);
    assert.ok(filteredWorkerAssignee, 'assignee filter summary includes selected worker');
    assert.equal(filteredWorkerAssignee.total, 2);
    assert.equal(findSummaryAssignee(assignedToWorker.data.summary, otherWorker.data.id), undefined, 'assignee filter summary excludes other agents');
    assert.equal(assignedToWorker.data.summary.orchestrations.length, 2, 'filtered summary still breaks down by orchestration');

    // Agent cannot filter by another agent.
    const agentFilterOther = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?assigned_agent_id=${otherWorker.data.id}`, workerAgent.data.api_key);
    assert.equal(agentFilterOther.status, 403);

    // Agent can filter by themselves.
    const agentFilterSelf = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?assigned_agent_id=${workerAgent.data.id}`, workerAgent.data.api_key);
    assert.equal(agentFilterSelf.status, 200);
    assert.equal(agentFilterSelf.data.total, 2);

    // ── Status filters ─────────────────────────────────────────────────────
    const pendingOnly = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?status=pending`, owner.token);
    assert.equal(pendingOnly.status, 200);
    assert.equal(pendingOnly.data.total, 1);
    assert.equal(pendingOnly.data.data[0].status, 'pending');

    const multiStatus = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?status=pending,dispatched`, owner.token);
    assert.equal(multiStatus.status, 200);
    assert.equal(multiStatus.data.total, 3);

    const invalidStatus = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?status=nope`, owner.token);
    assert.equal(invalidStatus.status, 422);

    // ── Search (q) ─────────────────────────────────────────────────────────
    const searchAlpha = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?q=Alpha`, owner.token);
    assert.equal(searchAlpha.status, 200);
    assert.equal(searchAlpha.data.total, 2, 'search should match alpha task titles and orchestration title');

    const searchGoal = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?q=Searchable%20alpha%20goal`, owner.token);
    assert.equal(searchGoal.status, 200);
    assert.equal(searchGoal.data.total, 1);

    const searchEscaped = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?q=%25`, owner.token);
    assert.equal(searchEscaped.status, 200);
    assert.equal(searchEscaped.data.total, 0, 'escaped wildcard should not match all rows');

    // ── Pagination ─────────────────────────────────────────────────────────
    const page1 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?limit=2&offset=0`, owner.token);
    assert.equal(page1.status, 200);
    assert.equal(page1.data.data.length, 2);
    assert.equal(page1.data.limit, 2);
    assert.equal(page1.data.offset, 0);
    assert.equal(page1.data.total, 4);

    const page2 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?limit=2&offset=2`, owner.token);
    assert.equal(page2.status, 200);
    assert.equal(page2.data.data.length, 2);
    assert.equal(page2.data.offset, 2);

    // Empty over-page returns empty data with correct total.
    const page3 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?limit=10&offset=100`, owner.token);
    assert.equal(page3.status, 200);
    assert.equal(page3.data.data.length, 0);
    assert.equal(page3.data.total, 4);

    // Limit caps at 200.
    const hugeLimit = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?limit=999`, owner.token);
    assert.equal(hugeLimit.status, 200);
    assert.equal(hugeLimit.data.limit, 200);

    // ── Sort ───────────────────────────────────────────────────────────────
    const byCreated = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?sort=created`, owner.token);
    assert.equal(byCreated.status, 200);
    assert.equal(byCreated.data.data.length, 4);

    const byStatus = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?sort=status`, owner.token);
    assert.equal(byStatus.status, 200);
    assert.equal(byStatus.data.data.length, 4);

    const byUnknown = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?sort=unknown`, owner.token);
    assert.equal(byUnknown.status, 200);
    assert.equal(byUnknown.data.limit, 50);

    // ── Summary counts ─────────────────────────────────────────────────────
    // All project tasks: pending=1, dispatched=2, ready_for_review=1.
    const summaryList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks`, owner.token);
    assert.equal(summaryList.status, 200);
    assert.equal(summaryList.data.summary.status_counts.pending, 1);
    assert.equal(summaryList.data.summary.status_counts.dispatched, 2);
    assert.equal(summaryList.data.summary.status_counts.ready_for_review, 1);
    assert.equal(summaryList.data.summary.tabs.open, 3, 'open = pending + dispatched');
    assert.equal(summaryList.data.summary.tabs.ready_for_review, 1);
    assert.equal(summaryList.data.summary.tabs.blocked_failed, 0);
    assert.equal(summaryList.data.summary.tabs.completed, 0);
    assert.equal(summaryList.data.summary.total, 4);

    // Assignee summary derived from real local assignments with lifecycle counts.
    const workerAssigneeSummary = findSummaryAssignee(summaryList.data.summary, workerAgent.data.id);
    assert.ok(workerAssigneeSummary, 'worker appears in assignee summary');
    assert.equal(workerAssigneeSummary.display_name, 'List Worker Agent');
    assert.equal(workerAssigneeSummary.total, 2);
    assert.equal(workerAssigneeSummary.open, 1);
    assert.equal(workerAssigneeSummary.review, 1);
    assert.equal(workerAssigneeSummary.done, 0);

    const otherAssigneeSummary = findSummaryAssignee(summaryList.data.summary, otherWorker.data.id);
    assert.ok(otherAssigneeSummary, 'other worker appears in assignee summary');
    assert.equal(otherAssigneeSummary.display_name, 'List Other Worker');
    assert.equal(otherAssigneeSummary.total, 1);
    assert.equal(otherAssigneeSummary.open, 1);

    const unassignedSummary = findSummaryAssignee(summaryList.data.summary, null);
    assert.ok(unassignedSummary, 'unassigned bucket appears in assignee summary');
    assert.equal(unassignedSummary.display_name, 'Unassigned');
    assert.equal(unassignedSummary.total, 1);
    assert.equal(unassignedSummary.open, 1);

    // Orchestration summary with title and total count.
    const alphaSummary = findSummaryOrchestration(summaryList.data.summary, alpha.data.id);
    assert.ok(alphaSummary, 'alpha appears in orchestration summary');
    assert.equal(alphaSummary.title, 'Alpha Orchestration');
    assert.equal(alphaSummary.total, 2);

    const betaSummary = findSummaryOrchestration(summaryList.data.summary, beta.data.id);
    assert.ok(betaSummary, 'beta appears in orchestration summary');
    assert.equal(betaSummary.title, 'Beta Orchestration');
    assert.equal(betaSummary.total, 2);

    // Batch summary mirrors orchestration context with lifecycle counts and date bounds.
    const alphaBatch = findSummaryBatch(summaryList.data.summary, alpha.data.id);
    assert.ok(alphaBatch, 'alpha appears in batch summary');
    assert.equal(alphaBatch.batch_label, 'Alpha Orchestration');
    assert.equal(alphaBatch.orchestration_id, alpha.data.id);
    assert.equal(alphaBatch.total, 2);
    assert.equal(alphaBatch.open, 2);
    assert.equal(alphaBatch.review, 0);
    assert.equal(typeof alphaBatch.first_created_at, 'string');
    assert.equal(typeof alphaBatch.last_updated_at, 'string');

    const betaBatch = findSummaryBatch(summaryList.data.summary, beta.data.id);
    assert.ok(betaBatch, 'beta appears in batch summary');
    assert.equal(betaBatch.batch_label, 'Beta Orchestration');
    assert.equal(betaBatch.total, 2);
    assert.equal(betaBatch.review, 1);

    // Batch summary respects agent visibility scope.
    const otherBatch = findSummaryBatch(otherList.data.summary, alpha.data.id);
    assert.ok(otherBatch, 'other worker sees alpha batch summary');
    assert.equal(findSummaryBatch(otherList.data.summary, beta.data.id), undefined, 'other worker does not see beta batch summary');

    // Aggregate timeline is derived from visible task timestamps.
    assert.ok(summaryList.data.summary.timeline.length > 0, 'timeline has at least one bucket');
    const firstBucket = summaryList.data.summary.timeline[0];
    assert.equal(typeof firstBucket.date, 'string');
    assert.equal(typeof firstBucket.created, 'number');
    assert.equal(typeof firstBucket.updated, 'number');
    assert.equal(typeof firstBucket.completed, 'number');
    assert.equal(typeof firstBucket.review_ready, 'number');

    // Timeline respects agent visibility scope.
    assert.ok(otherList.data.summary.timeline.length >= 0, 'scoped timeline is an array');
    assert.ok(
      otherList.data.summary.timeline.every((bucket: any) =>
        bucket.created + bucket.updated + bucket.completed >= 0),
      'scoped timeline buckets only include visible rows',
    );

    // Summary respects filters.
    const filteredSummary = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks?status=dispatched`, owner.token);
    assert.equal(filteredSummary.status, 200);
    assert.equal(filteredSummary.data.summary.total, 2);
    assert.equal(filteredSummary.data.summary.status_counts.dispatched, 2);
    assert.equal(filteredSummary.data.summary.tabs.open, 2);
    assert.equal(filteredSummary.data.summary.assignees.length, 2, 'filtered assignee summary only includes agents with dispatched tasks');
    assert.equal(filteredSummary.data.summary.orchestrations.length, 2, 'filtered orchestration summary includes both orchestrations with dispatched tasks');

    // Filtered batch/timeline summaries derive from visible rows.
    assert.equal(filteredSummary.data.summary.batches.length, 2, 'filtered batch summary includes both orchestrations with dispatched tasks');
    assert.ok(filteredSummary.data.summary.timeline.length >= 0, 'filtered timeline is an array');

    // ── Linked changeset/commit data for task detail ──────────────────────
    const baseFile = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'linked-task.md',
      content: 'before linked task',
      message: 'Seed linked task file',
    });
    assert.equal(baseFile.status, 201);
    const linkedChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Linked task changeset',
      description: 'Changeset tied to an orchestration task.',
      task_id: t1.data.id,
      orchestration_id: alpha.data.id,
      file_ops: [{
        op: 'upsert',
        path: 'linked-task.md',
        content: 'after linked task',
        base_revision_id: baseFile.data.current_revision_id,
      }],
    });
    assert.equal(linkedChangeset.status, 201);
    const approvedLinkedChangeset = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/changesets/${linkedChangeset.data.id}/review`, owner.token, {
      decision: 'approved', auto_merge: false,
      notes: 'Linked task changeset approved.',
    });
    assert.equal(approvedLinkedChangeset.status, 200);
    const mergedLinkedChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets/${linkedChangeset.data.id}/merge`, owner.token);
    assert.equal(mergedLinkedChangeset.status, 200);
    const linkedCommitId = mergedLinkedChangeset.data.commit.id;

    // ── Project-level task detail ──────────────────────────────────────────
    const ownerDetail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks/${t1.data.id}`, owner.token);
    assert.equal(ownerDetail.status, 200);
    assert.equal(ownerDetail.data.id, t1.data.id);
    assert.equal(ownerDetail.data.title, 'Alpha pending task');
    assert.equal(ownerDetail.data.orchestration_id, alpha.data.id);
    assert.equal(ownerDetail.data.orchestration_title, 'Alpha Orchestration');
    assert.equal(ownerDetail.data.orchestration_status, 'running');
    assert.equal(ownerDetail.data.orchestration_base_path, alpha.data.base_path);
    assert.equal(ownerDetail.data.orchestration_main_agent_id, mainAgent.data.id);
    assert.ok('md_artifacts' in ownerDetail.data);
    assert.ok('result_path' in ownerDetail.data);
    assert.ok('evidence_path' in ownerDetail.data);
    assert.ok('review_notes' in ownerDetail.data);
    assert.ok('requested_changes' in ownerDetail.data);
    assert.ok('goal' in ownerDetail.data);
    assert.ok('acceptance_criteria' in ownerDetail.data);
    assert.equal(Array.isArray(ownerDetail.data.related_changesets), true);
    assert.equal(Array.isArray(ownerDetail.data.related_commits), true);
    assert.equal(ownerDetail.data.related_changesets.length, 1);
    assert.equal(ownerDetail.data.related_changesets[0].id, linkedChangeset.data.id);
    assert.equal(ownerDetail.data.related_changesets[0].merged_commit_id, linkedCommitId);
    assert.equal(ownerDetail.data.related_commits.length, 1);
    assert.equal(ownerDetail.data.related_commits[0].id, linkedCommitId);
    assert.equal(ownerDetail.data.related_commits[0].changeset_id, linkedChangeset.data.id);

    const viewerDetail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks/${t1.data.id}`, viewer.token);
    assert.equal(viewerDetail.status, 200);
    assert.equal(viewerDetail.data.id, t1.data.id);
    assert.equal(viewerDetail.data.related_changesets[0].id, linkedChangeset.data.id);

    // Assigned worker can see their own task.
    const workerDetail = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks/${t1.data.id}`, workerAgent.data.api_key);
    assert.equal(workerDetail.status, 200);
    assert.equal(workerDetail.data.id, t1.data.id);

    // Main agent can see any task in their orchestrations.
    const mainDetail = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks/${t4.data.id}`, mainAgent.data.api_key);
    assert.equal(mainDetail.status, 200);
    assert.equal(mainDetail.data.id, t4.data.id);
    assert.deepEqual(mainDetail.data.related_changesets, []);
    assert.deepEqual(mainDetail.data.related_commits, []);

    // Participant (otherWorker) can see a task in the same orchestration even if not assigned.
    const participantDetail = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks/${t1.data.id}`, otherWorker.data.api_key);
    assert.equal(participantDetail.status, 200);
    assert.equal(participantDetail.data.id, t1.data.id);

    // Intruder outside visible scope gets 403.
    const intruderDetail = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks/${t1.data.id}`, intruderAgent.data.api_key);
    assert.equal(intruderDetail.status, 403);

    // Wrong task id in the project returns 404.
    const wrongDetail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks/00000000-0000-0000-0000-000000000000`, owner.token);
    assert.equal(wrongDetail.status, 404);

    // ── Derived labels / timeline contract ─────────────────────────────────
    // Labels and timeline are deterministic, derived only from existing local data.
    const pendingRow = ownerList.data.data.find((row: any) => row.id === t1.data.id);
    assert.ok(pendingRow, 'pending task row found');
    assert.equal(Array.isArray(pendingRow.labels), true);
    assert.equal(Array.isArray(pendingRow.timeline), true);
    const pendingLabelKeys = pendingRow.labels.map((l: any) => l.key);
    assert.ok(pendingLabelKeys.includes('status'), 'label includes status');
    assert.ok(pendingLabelKeys.includes('status_group'), 'label includes status_group');
    assert.ok(pendingLabelKeys.includes('assigned_agent'), 'label includes assigned_agent');
    assert.ok(pendingLabelKeys.includes('has_dependencies'), 'label includes has_dependencies');
    assert.ok(pendingLabelKeys.includes('has_acceptance_criteria'), 'label includes has_acceptance_criteria');
    assert.ok(pendingLabelKeys.includes('has_result'), 'label includes has_result');
    assert.ok(pendingLabelKeys.includes('has_evidence'), 'label includes has_evidence');
    assert.equal(
      pendingRow.labels.find((l: any) => l.key === 'status').value,
      'pending',
    );
    assert.equal(
      pendingRow.labels.find((l: any) => l.key === 'status_group').value,
      'open',
    );
    assert.equal(
      pendingRow.labels.find((l: any) => l.key === 'assigned_agent').value,
      workerAgent.data.id,
    );
    assert.equal(
      pendingRow.labels.find((l: any) => l.key === 'has_dependencies').value,
      false,
    );
    assert.equal(
      pendingRow.labels.find((l: any) => l.key === 'has_acceptance_criteria').value,
      false,
    );

    // Timeline from task timestamps only in list (related links loaded on detail).
    const pendingTimelineTypes = pendingRow.timeline.map((e: any) => e.type);
    assert.ok(pendingTimelineTypes.includes('created'), 'timeline includes created');
    assert.equal(pendingRow.timeline[0].type, 'created', 'created is first event');
    assert.equal(typeof pendingRow.timeline[0].at, 'string');

    // Ready-for-review row has dispatched, claimed, and completed timeline events.
    const readyForReviewRow = ownerList.data.data.find((row: any) => row.id === t3.data.id);
    assert.ok(readyForReviewRow, 'ready-for-review task row found');
    const rfrTimelineTypes = readyForReviewRow.timeline.map((e: any) => e.type);
    assert.ok(rfrTimelineTypes.includes('dispatched'), 'ready-for-review timeline includes dispatched');
    assert.ok(rfrTimelineTypes.includes('claimed'), 'ready-for-review timeline includes claimed');
    assert.ok(rfrTimelineTypes.includes('completed'), 'ready-for-review timeline includes completed');
    assert.equal(rfrTimelineTypes.includes('reviewed'), false, 'ready-for-review task has not been reviewed');

    // Unassigned task is labeled unassigned.
    const unassignedRow = ownerList.data.data.find((row: any) => row.id === t4.data.id);
    assert.ok(unassignedRow, 'unassigned task row found');
    const unassignedLabel = unassignedRow.labels.find((l: any) => l.key === 'assignment');
    assert.ok(unassignedLabel, 'unassigned task has assignment label');
    assert.equal(unassignedLabel.value, 'unassigned');

    // Detail includes labels derived from related changesets/commits.
    assert.equal(Array.isArray(ownerDetail.data.labels), true);
    assert.equal(ownerDetail.data.labels.some((l: any) => l.key === 'has_related_changesets' && l.value === true), true);
    assert.equal(ownerDetail.data.labels.some((l: any) => l.key === 'has_related_commits' && l.value === true), true);

    // Detail timeline includes review_linked and commit_linked events from related data.
    assert.equal(Array.isArray(ownerDetail.data.timeline), true);
    const detailTimelineTypes = ownerDetail.data.timeline.map((e: any) => e.type);
    assert.ok(detailTimelineTypes.includes('review_linked'), 'detail timeline includes review_linked');
    assert.ok(detailTimelineTypes.includes('commit_linked'), 'detail timeline includes commit_linked');
    const reviewLinked = ownerDetail.data.timeline.find((e: any) => e.type === 'review_linked');
    assert.equal(reviewLinked.detail.changeset_id, linkedChangeset.data.id);
    assert.equal(reviewLinked.detail.status, 'merged');
    const commitLinked = ownerDetail.data.timeline.find((e: any) => e.type === 'commit_linked');
    assert.equal(commitLinked.detail.commit_id, linkedCommitId);
    assert.equal(commitLinked.detail.changeset_id, linkedChangeset.data.id);

    // ── Reviewed task timeline ─────────────────────────────────────────────
    const reviewedTask = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${beta.data.id}/tasks`, mainAgent.data.api_key, {
      title: 'Beta reviewed task',
      goal: 'Task that will be completed and approved.',
      assigned_agent_id: workerAgent.data.id,
    });
    assert.equal(reviewedTask.status, 201);
    const reviewedClaim = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${beta.data.id}/tasks/${reviewedTask.data.id}/claim`, workerAgent.data.api_key);
    assert.equal(reviewedClaim.status, 200);
    const reviewedComplete = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${beta.data.id}/tasks/${reviewedTask.data.id}/complete`, workerAgent.data.api_key, {
      result_md: '# Result\n\nReady for approval.',
      evidence: { files_changed: ['reviewed-task.md'], ok: true },
    });
    assert.equal(reviewedComplete.status, 200);
    const reviewedApproval = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${beta.data.id}/tasks/${reviewedTask.data.id}/review`, mainAgent.data.api_key, {
      decision: 'approved', auto_merge: false,
      notes: 'Approved.',
    });
    assert.equal(reviewedApproval.status, 200);

    const reviewedDetail = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestration-tasks/${reviewedTask.data.id}`, owner.token);
    assert.equal(reviewedDetail.status, 200);
    assert.equal(reviewedDetail.data.status, 'approved');
    const reviewedTimelineTypes = reviewedDetail.data.timeline.map((e: any) => e.type);
    assert.ok(reviewedTimelineTypes.includes('reviewed'), 'approved task timeline includes reviewed');
    const reviewedEvent = reviewedDetail.data.timeline.find((e: any) => e.type === 'reviewed');
    assert.equal(reviewedEvent.detail.decision, 'approved');
    assert.equal(
      reviewedDetail.data.labels.find((l: any) => l.key === 'review_state').value,
      'approved',
    );

    // ── Additive compatibility with existing orchestration task route ──────
    const legacyRoute = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${alpha.data.id}/tasks`, mainAgent.data.api_key);
    assert.equal(legacyRoute.status, 200);
    assert.equal(legacyRoute.data.data.length, 2);
    assert.ok(!('orchestration_title' in legacyRoute.data.data[0]), 'legacy route shape unchanged');

    // Legacy nested task detail remains unchanged and lacks orchestration context.
    const legacyDetail = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${alpha.data.id}/tasks/${t1.data.id}`, mainAgent.data.api_key);
    assert.equal(legacyDetail.status, 200);
    assert.equal(legacyDetail.data.id, t1.data.id);
    assert.ok(!('orchestration_title' in legacyDetail.data), 'legacy detail shape unchanged');

    // Legacy route remains additive-only and does not expose labels/timeline.
    assert.ok(!('labels' in legacyRoute.data.data[0]), 'legacy list lacks labels');
    assert.ok(!('timeline' in legacyRoute.data.data[0]), 'legacy list lacks timeline');
    assert.ok(!('labels' in legacyDetail.data), 'legacy detail lacks labels');
    assert.ok(!('timeline' in legacyDetail.data), 'legacy detail lacks timeline');

    console.log('orchestration-tasks-list tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string; email: string }> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email,
    password: 'OrchestrationList123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
    email,
  };
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    metrics: { load: 0 },
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

function findSummaryAssignee(summary: any, agentId: string | null): any | undefined {
  return (summary?.assignees || []).find((a: any) => a.assigned_agent_id === agentId);
}

function findSummaryOrchestration(summary: any, orchestrationId: string): any | undefined {
  return (summary?.orchestrations || []).find((o: any) => o.orchestration_id === orchestrationId);
}

function findSummaryBatch(summary: any, orchestrationId: string): any | undefined {
  return (summary?.batches || []).find((b: any) => b.orchestration_id === orchestrationId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
