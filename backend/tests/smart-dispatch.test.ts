import assert from 'node:assert/strict';
import http from 'node:http';
import type { Repository } from 'typeorm';
import {
  ProjectOrchestrationTask,
  ProjectOrchestrationTaskStatus,
} from '../src/entities/project-orchestration-task.entity';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'smart-dispatch-test-secret';
// Keep heartbeats fresh for the whole test run so presence is deterministic.
process.env.AGENT_ONLINE_TTL_MS = '300000';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const {
    ProjectOrchestrationTask,
    ProjectOrchestrationTaskStatus,
  } = await import('../src/entities/project-orchestration-task.entity');

  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);

  try {
    const owner = await register(baseUrl, 'sd');

    // ── Scenario 1: picks the least-loaded worker ───────────────────────────
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Least-loaded');
      const lo = await createWorker(baseUrl, owner.token, projectId, 'WorkerLow', []);
      const hi = await createWorker(baseUrl, owner.token, projectId, 'WorkerHigh', []);
      await heartbeat(baseUrl, lo.apiKey, 'healthy');
      await heartbeat(baseUrl, hi.apiKey, 'healthy');
      // WorkerHigh carries 2 in-flight tasks; WorkerLow has none.
      await seedActiveTasks(taskRepo, projectId, orchestrationId, hi.id, 2);

      const res = await api(baseUrl, 'POST', smartPath(projectId, orchestrationId), owner.token, {
        title: 'Pick the idle worker',
        goal: 'Should go to WorkerLow because WorkerHigh is busier.',
      });
      assert.equal(res.status, 201, `smart-dispatch 1 status: ${JSON.stringify(res.data)}`);
      assert.equal(res.data.assigned_agent_id, lo.id, 'least-loaded worker is selected');
      assert.equal(res.data.assigned_agent_name, 'WorkerLow');
      assert.equal(typeof res.data.task_id, 'string');
      assert.ok(typeof res.data.selection_reason === 'string' && res.data.selection_reason.length > 0);
      assert.match(res.data.selection_reason, /fewest active tasks/);
      assert.match(res.data.selection_reason, /\(0\)/, 'reason reports the winning load');
    }

    // ── Scenario 2: filters by required_capability ──────────────────────────
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Capability filter');
      const coder = await createWorker(baseUrl, owner.token, projectId, 'Coder', ['code']);
      const reviewer = await createWorker(baseUrl, owner.token, projectId, 'Reviewer', ['review']);
      await heartbeat(baseUrl, coder.apiKey, 'healthy');
      await heartbeat(baseUrl, reviewer.apiKey, 'healthy');

      const res = await api(baseUrl, 'POST', smartPath(projectId, orchestrationId), owner.token, {
        title: 'Need a coder',
        goal: 'Only the coder advertises the code capability.',
        required_capability: 'code',
      });
      assert.equal(res.status, 201, `smart-dispatch 2 status: ${JSON.stringify(res.data)}`);
      assert.equal(res.data.assigned_agent_id, coder.id, 'capability-filtered worker is selected');

      // 409 when no agent has the requested capability.
      const none = await api(baseUrl, 'POST', smartPath(projectId, orchestrationId), owner.token, {
        title: 'Need rust',
        goal: 'Nobody advertises rust.',
        required_capability: 'rust',
      });
      assert.equal(none.status, 409, 'capability with no match → 409');
    }

    // ── Scenario 3: skips unhealthy workers (even when less loaded) ─────────
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Skip unhealthy');
      const healthy = await createWorker(baseUrl, owner.token, projectId, 'Healthy', []);
      const unhealthy = await createWorker(baseUrl, owner.token, projectId, 'Unhealthy', []);
      await heartbeat(baseUrl, healthy.apiKey, 'healthy');
      // Unhealthy worker is online but failed its smoke check, and has fewer tasks.
      await heartbeat(baseUrl, unhealthy.apiKey, 'unhealthy');
      await seedActiveTasks(taskRepo, projectId, orchestrationId, healthy.id, 1);

      const res = await api(baseUrl, 'POST', smartPath(projectId, orchestrationId), owner.token, {
        title: 'Avoid the sick worker',
        goal: 'Unhealthy has 0 tasks but must be skipped; Healthy has 1.',
      });
      assert.equal(res.status, 201, `smart-dispatch 3 status: ${JSON.stringify(res.data)}`);
      assert.equal(res.data.assigned_agent_id, healthy.id, 'unhealthy worker is skipped');
      assert.match(res.data.selection_reason, /among 1 online, healthy worker$/, 'only the healthy worker was eligible');
    }

    // ── Scenario 4: 409 when no eligible worker exists ──────────────────────
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'No eligible');
      // Agent exists but never heartbeats → offline → not eligible.
      await createWorker(baseUrl, owner.token, projectId, 'Offline', []);

      const res = await api(baseUrl, 'POST', smartPath(projectId, orchestrationId), owner.token, {
        title: 'Nobody home',
        goal: 'No online workers available.',
      });
      assert.equal(res.status, 409, 'no eligible worker → 409');
    }

    // ── Auth required ───────────────────────────────────────────────────────
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Auth guard');
      const noAuth = await api(baseUrl, 'POST', smartPath(projectId, orchestrationId), undefined, {
        title: 'No auth',
        goal: 'Should be rejected.',
      });
      assert.equal(noAuth.status, 401);
    }

    // ── Validation: missing title/goal ──────────────────────────────────────
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Validation');
      const lo = await createWorker(baseUrl, owner.token, projectId, 'VWorker', []);
      await heartbeat(baseUrl, lo.apiKey, 'healthy');
      const bad = await api(baseUrl, 'POST', smartPath(projectId, orchestrationId), owner.token, { title: 'no goal' });
      assert.equal(bad.status, 422);
    }

    console.log('smart-dispatch tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

function smartPath(projectId: string, orchestrationId: string): string {
  return `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/smart-dispatch`;
}

async function setup(
  baseUrl: string,
  token: string,
  label: string,
): Promise<{ projectId: string; orchestrationId: string }> {
  const project = await api(baseUrl, 'POST', '/v1/projects', token, {
    name: `Smart Dispatch ${label}`,
    description: 'smart-dispatch e2e',
  });
  assert.equal(project.status, 201);
  const projectId = project.data.id;
  const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, token, {
    title: `Smart Dispatch ${label}`,
    objective: 'Auto-select the best worker.',
  });
  assert.equal(orch.status, 201);
  return { projectId, orchestrationId: orch.data.id };
}

async function createWorker(
  baseUrl: string,
  token: string,
  projectId: string,
  name: string,
  capabilities: string[],
): Promise<{ id: string; apiKey: string; name: string }> {
  const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, token, { name, capabilities });
  assert.equal(res.status, 201);
  return { id: res.data.id, apiKey: res.data.api_key, name };
}

async function heartbeat(baseUrl: string, apiKey: string, smoke: 'healthy' | 'unhealthy'): Promise<void> {
  const res = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    health: { status: smoke },
  });
  assert.equal(res.status, 200);
}

async function seedActiveTasks(
  repo: Repository<ProjectOrchestrationTask>,
  projectId: string,
  orchestrationId: string,
  agentId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await repo.save(
      repo.create({
        projectId,
        orchestrationId,
        title: `seed-${agentId}-${i}`,
        goal: 'pre-existing in-flight work',
        status: ProjectOrchestrationTaskStatus.DISPATCHED,
        assignedAgentId: agentId,
        workerTaskPath: `.agent/seed/${agentId}-${i}.worker_task.md`,
        workerContextPath: `.agent/seed/${agentId}-${i}.worker_context.md`,
      }),
    );
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email,
    password: 'SmartDispatch123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
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
  return parseResponse(response);
}

async function apiWithKey(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response);
}

async function parseResponse(response: Response): Promise<{ status: number; data: any }> {
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
