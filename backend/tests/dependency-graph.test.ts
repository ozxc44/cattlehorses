import assert from 'node:assert/strict';
import crypto from 'crypto';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'dependency-graph-test-secret';

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
    const owner = await register(baseUrl, 'dependency-graph-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Dependency Graph Test',
      description: 'Visualize task ordering with depends_on.',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Graph Main Agent',
    });
    assert.equal(mainAgent.status, 201);
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Graph Worker Agent',
    });
    assert.equal(workerAgent.status, 201);
    const intruderAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Graph Intruder Agent',
    });
    assert.equal(intruderAgent.status, 201);

    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);

    const orchestration = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations`,
      mainAgent.data.api_key,
      {
        title: 'Graph Orchestration',
        objective: 'Build a DAG of tasks.',
        main_agent_id: mainAgent.data.id,
        worker_agent_ids: [workerAgent.data.id],
      },
    );
    assert.equal(orchestration.status, 201);
    const orchestrationId = orchestration.data.id;

    const taskA = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Task A',
        goal: 'First task with no dependencies.',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(taskA.status, 201);

    const taskB = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Task B',
        goal: 'Depends on Task A.',
        assigned_agent_id: workerAgent.data.id,
        depends_on: [taskA.data.id],
      },
    );
    assert.equal(taskB.status, 201);

    const taskC = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Task C',
        goal: 'Independent task.',
        assigned_agent_id: workerAgent.data.id,
        depends_on: [],
      },
    );
    assert.equal(taskC.status, 201);

    const graph = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/dependency-graph`,
      owner.token,
    );
    assert.equal(graph.status, 200);
    assert.ok(Array.isArray(graph.data.nodes));
    assert.ok(Array.isArray(graph.data.edges));
    assert.equal(graph.data.nodes.length, 3);
    assert.equal(typeof graph.data.blocked_count, 'number');
    assert.equal(typeof graph.data.ready_count, 'number');
    assert.equal(typeof graph.data.completed_count, 'number');

    const nodeIds = graph.data.nodes.map((node: any) => node.id).sort();
    assert.deepEqual(nodeIds, [taskA.data.id, taskB.data.id, taskC.data.id].sort());

    for (const node of graph.data.nodes) {
      assert.equal(typeof node.id, 'string');
      assert.equal(typeof node.title, 'string');
      assert.equal(typeof node.status, 'string');
      assert.ok(Array.isArray(node.depends_on));
      assert.ok(node.assigned_agent === null || typeof node.assigned_agent === 'string');
    }

    const nodeB = graph.data.nodes.find((node: any) => node.id === taskB.data.id);
    assert.deepEqual(nodeB.depends_on, [taskA.data.id]);

    const nodeA = graph.data.nodes.find((node: any) => node.id === taskA.data.id);
    assert.deepEqual(nodeA.depends_on, []);

    assert.deepEqual(graph.data.edges, [{ from: taskA.data.id, to: taskB.data.id }]);

    // A and C are ready; B is blocked because A is not approved.
    assert.equal(graph.data.blocked_count, 1);
    assert.equal(graph.data.ready_count, 2);
    assert.equal(graph.data.completed_count, 0);

    const notFound = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${crypto.randomUUID()}/dependency-graph`,
      owner.token,
    );
    assert.equal(notFound.status, 404);

    const intruderGraph = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/dependency-graph`,
      intruderAgent.data.api_key,
    );
    assert.equal(intruderGraph.status, 403);

    // Approve Task A so Task B becomes ready.
    const claimA = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskA.data.id}/claim`,
      workerAgent.data.api_key,
    );
    assert.equal(claimA.status, 200);

    const completeA = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskA.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nTask A is complete.',
        evidence: { files_changed: ['task-a.md'] },
      },
    );
    assert.equal(completeA.status, 200);

    const approveA = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskA.data.id}/review`,
      mainAgent.data.api_key,
      { decision: 'approved', notes: 'Task A accepted.' },
    );
    assert.equal(approveA.status, 200);

    const graphAfterA = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/dependency-graph`,
      owner.token,
    );
    assert.equal(graphAfterA.status, 200);
    assert.equal(graphAfterA.data.blocked_count, 0);
    assert.equal(graphAfterA.data.ready_count, 2);
    assert.equal(graphAfterA.data.completed_count, 1);

    // Complete and approve Task B; only Task C remains ready.
    const claimB = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskB.data.id}/claim`,
      workerAgent.data.api_key,
    );
    assert.equal(claimB.status, 200);

    const completeB = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskB.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nTask B is complete.',
        evidence: { files_changed: ['task-b.md'] },
      },
    );
    assert.equal(completeB.status, 200);

    const approveB = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskB.data.id}/review`,
      mainAgent.data.api_key,
      { decision: 'approved', notes: 'Task B accepted.' },
    );
    assert.equal(approveB.status, 200);

    const graphFinal = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations/${orchestrationId}/dependency-graph`,
      owner.token,
    );
    assert.equal(graphFinal.status, 200);
    assert.equal(graphFinal.data.blocked_count, 0);
    assert.equal(graphFinal.data.ready_count, 1);
    assert.equal(graphFinal.data.completed_count, 2);

    console.log('dependency graph tests passed');
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
    password: 'DependencyGraph123!',
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
