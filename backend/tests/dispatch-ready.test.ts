import assert from 'node:assert/strict';
import http from 'node:http';
import type { Repository } from 'typeorm';
import {
  ProjectOrchestrationTask,
  ProjectOrchestrationTaskStatus,
} from '../src/entities/project-orchestration-task.entity';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'dispatch-ready-test-secret';
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
    const owner = await register(baseUrl, 'dr');

    // ── Scenario 1: DAG walk — only the dependency-free root flies out ───────
    // A has no deps → dispatched. B (deps A) and C (deps B) are still blocked
    // because their depends_on are pending, not approved → skipped.
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'DAG gate');
      const worker = await createWorker(baseUrl, owner.token, projectId, 'DagWorker', []);
      await heartbeat(baseUrl, worker.apiKey, 'healthy');

      const a = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
        title: 'A root', goal: 'no dependencies', dispatch: false,
      });
      const b = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
        title: 'B child', goal: 'depends on A', depends_on: [a.id], dispatch: false,
      });
      const c = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
        title: 'C grandchild', goal: 'depends on B', depends_on: [b.id], dispatch: false,
      });

      const res = await dispatchReady(baseUrl, owner.token, projectId, orchestrationId);
      assert.equal(res.status, 200, `DAG gate status: ${JSON.stringify(res.data)}`);

      assert.equal(res.data.dispatched.length, 1, 'only the dep-free root is dispatched');
      assert.equal(res.data.dispatched[0].task_id, a.id, 'dispatched task is A');
      assert.equal(res.data.dispatched[0].agent_name, 'DagWorker', 'dispatched to the healthy worker');

      assert.equal(res.data.skipped.length, 2, 'B and C are skipped');
      const skippedIds = res.data.skipped.map((s: any) => s.task_id).sort();
      assert.deepEqual(skippedIds, [b.id, c.id].sort(), 'skipped tasks are B and C');
      for (const s of res.data.skipped) {
        assert.equal(s.reason, 'dependencies_not_met', 'skip reason is deps not met');
      }

      // Dispatch actually persisted: A is now dispatched + assigned to the worker.
      const aAfter = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${a.id}`, owner.token);
      assert.equal(aAfter.status, 200);
      assert.equal(aAfter.data.status, 'dispatched', 'A row flipped to dispatched');
      assert.equal(aAfter.data.assigned_agent_id, worker.id, 'A assigned to the worker');
    }

    // ── Scenario 2: parallel — one task per available healthy worker ─────────
    // 3 ready tasks, 2 workers → 2 dispatched (one each), 1 skipped for capacity.
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Parallel');
      const wa = await createWorker(baseUrl, owner.token, projectId, 'WorkerA', []);
      const wb = await createWorker(baseUrl, owner.token, projectId, 'WorkerB', []);
      await heartbeat(baseUrl, wa.apiKey, 'healthy');
      await heartbeat(baseUrl, wb.apiKey, 'healthy');

      // Distinct priorities force a deterministic claim order (T1 > T2 > T3).
      const t1 = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
        title: 'T1', goal: 'highest priority', dispatch: false, priority: 30,
      });
      const t2 = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
        title: 'T2', goal: 'mid priority', dispatch: false, priority: 20,
      });
      const t3 = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
        title: 'T3', goal: 'lowest priority', dispatch: false, priority: 10,
      });

      const res = await dispatchReady(baseUrl, owner.token, projectId, orchestrationId);
      assert.equal(res.status, 200, `parallel status: ${JSON.stringify(res.data)}`);

      assert.equal(res.data.dispatched.length, 2, 'one task per worker → 2 dispatched');
      assert.equal(res.data.dispatched[0].task_id, t1.id, 'highest priority claims first');
      assert.equal(res.data.dispatched[0].agent_name, 'WorkerA', 'least-loaded tie → WorkerA');
      assert.equal(res.data.dispatched[1].task_id, t2.id, 'second priority claims next');
      assert.equal(res.data.dispatched[1].agent_name, 'WorkerB', 'second distinct worker');
      // No worker handed more than one task.
      const names = res.data.dispatched.map((d: any) => d.agent_name);
      assert.equal(new Set(names).size, names.length, 'each dispatched worker is distinct');

      assert.equal(res.data.skipped.length, 1, 'third task has no free worker');
      assert.equal(res.data.skipped[0].task_id, t3.id);
      assert.equal(res.data.skipped[0].reason, 'no_available_worker');
    }

    // ── Scenario 3: required_capability filters the worker pool ─────────────
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Capability');
      const coder = await createWorker(baseUrl, owner.token, projectId, 'Coder', ['code']);
      const reviewer = await createWorker(baseUrl, owner.token, projectId, 'Reviewer', ['review']);
      await heartbeat(baseUrl, coder.apiKey, 'healthy');
      await heartbeat(baseUrl, reviewer.apiKey, 'healthy');

      const need = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
        title: 'Need code', goal: 'only the coder qualifies', required_capability: 'code', dispatch: false,
      });

      const res = await dispatchReady(baseUrl, owner.token, projectId, orchestrationId);
      assert.equal(res.status, 200, `capability status: ${JSON.stringify(res.data)}`);
      assert.equal(res.data.dispatched.length, 1, 'capability-matched task is dispatched');
      assert.equal(res.data.dispatched[0].task_id, need.id);
      assert.equal(res.data.dispatched[0].agent_name, 'Coder', 'routed to the capable worker');
      assert.equal(res.data.skipped.length, 0);
    }

    // ── Scenario 4: dependency resolves → previously-blocked task flies out ──
    // A is approved directly (simulating PM sign-off), so B (depends_on A) is
    // now unblocked and gets dispatched on the next dispatch-ready call.
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Dep resolved');
      const worker = await createWorker(baseUrl, owner.token, projectId, 'DepWorker', []);
      await heartbeat(baseUrl, worker.apiKey, 'healthy');

      const a = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
        title: 'A', goal: 'will be approved', dispatch: false,
      });
      await forceTaskStatus(taskRepo, a.id, ProjectOrchestrationTaskStatus.APPROVED);
      const b = await createTask(baseUrl, owner.token, projectId, orchestrationId, {
        title: 'B', goal: 'depends on A', depends_on: [a.id], dispatch: false,
      });

      const res = await dispatchReady(baseUrl, owner.token, projectId, orchestrationId);
      assert.equal(res.status, 200, `dep-resolved status: ${JSON.stringify(res.data)}`);
      assert.equal(res.data.dispatched.length, 1, 'newly-unblocked B is dispatched');
      assert.equal(res.data.dispatched[0].task_id, b.id, 'B is the dispatched task');
      assert.equal(res.data.skipped.length, 0, 'A is approved (not a candidate), nothing skipped');
    }

    // ── Scenario 5: 404 for a missing orchestration ─────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'Missing orch');
      const res = await dispatchReady(baseUrl, owner.token, projectId, '00000000-0000-0000-0000-000000000000');
      assert.equal(res.status, 404, 'unknown orchestration → 404');
    }

    // ── Scenario 6: auth required ───────────────────────────────────────────
    {
      const { projectId, orchestrationId } = await setup(baseUrl, owner.token, 'Auth guard');
      const noAuth = await dispatchReady(baseUrl, undefined, projectId, orchestrationId);
      assert.equal(noAuth.status, 401, 'no token → 401');
    }

    console.log('dispatch-ready tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

function dispatchReadyPath(projectId: string, orchestrationId: string): string {
  return `/v1/projects/${projectId}/orchestrations/${orchestrationId}/dispatch-ready`;
}

async function dispatchReady(
  baseUrl: string,
  token: string | undefined,
  projectId: string,
  orchestrationId: string,
): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'POST', dispatchReadyPath(projectId, orchestrationId), token, {});
}

async function forceTaskStatus(
  repo: Repository<ProjectOrchestrationTask>,
  taskId: string,
  status: ProjectOrchestrationTaskStatus,
): Promise<void> {
  const task = await repo.findOneByOrFail({ id: taskId });
  task.status = status;
  if (status === ProjectOrchestrationTaskStatus.APPROVED) {
    task.reviewedAt = task.reviewedAt ?? new Date();
    task.completedAt = task.completedAt ?? new Date();
  }
  await repo.save(task);
}

async function setup(
  baseUrl: string,
  token: string,
  label: string,
): Promise<{ projectId: string; orchestrationId: string }> {
  const project = await api(baseUrl, 'POST', '/v1/projects', token, {
    name: `Dispatch Ready ${label}`,
    description: 'dispatch-ready e2e',
  });
  assert.equal(project.status, 201);
  const projectId = project.data.id;
  const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, token, {
    title: `Dispatch Ready ${label}`,
    objective: 'Auto-dispatch all unblocked tasks.',
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

async function createTask(
  baseUrl: string,
  token: string,
  projectId: string,
  orchestrationId: string,
  body: {
    title: string;
    goal: string;
    depends_on?: string[];
    required_capability?: string;
    dispatch?: boolean;
    priority?: number;
  },
): Promise<{ id: string; status: string }> {
  const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`, token, body);
  assert.equal(res.status, 201, `createTask ${body.title} failed: ${JSON.stringify(res.data)}`);
  return { id: res.data.id, status: res.data.status };
}

async function heartbeat(baseUrl: string, apiKey: string, smoke: 'healthy' | 'unhealthy'): Promise<void> {
  const res = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    health: { status: smoke },
  });
  assert.equal(res.status, 200);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email,
    password: 'DispatchReady123!',
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
