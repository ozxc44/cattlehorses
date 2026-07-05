import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'scheduled-dispatch-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '300000';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { ScheduledDispatch } = await import('../src/entities/scheduled-dispatch.entity');
  const { nextCronDate } = await import('../src/services/scheduler.service');

  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const schedRepo = AppDataSource.getRepository(ScheduledDispatch);

  try {
    const owner = await register(baseUrl, 'sd');

    // ── nextCronDate unit tests ──────────────────────────────────────────────
    {
      const from = new Date(2025, 0, 1, 0, 0, 0, 0);
      const next = nextCronDate('*/5 * * * *', from);
      assert(next !== null, '*/5 should produce a next date');
      assert.equal(next!.getMinutes(), 5, '*/5 from :00 should be :05');

      const nextHour = nextCronDate('0 * * * *', from);
      assert(nextHour !== null);
      assert.equal(nextHour!.getMinutes(), 0, '0 * * * * should fire at :00');
      assert.equal(nextHour!.getHours(), 1, '0 * * * * from 00:00 should be 01:00');

      const nextDaily = nextCronDate('0 9 * * *', from);
      assert(nextDaily !== null);
      assert.equal(nextDaily!.getHours(), 9);
      assert.equal(nextDaily!.getMinutes(), 0);

      const bad = nextCronDate('invalid', from);
      assert.equal(bad, null, 'invalid pattern returns null');

      const bad2 = nextCronDate('99 * * * *', from);
      assert.equal(bad2, null, 'minute > 59 returns null');
    }

    // ── POST: create schedule ────────────────────────────────────────────────
    let scheduleId: string;
    {
      const { projectId } = await setup(baseUrl, owner.token, 'Create');
      const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'Hourly code review',
        goal: 'Review open PRs and provide feedback',
        cron_pattern: '0 * * * *',
        max_concurrent: 2,
      });
      assert.equal(res.status, 201, `create schedule: ${JSON.stringify(res.data)}`);
      assert.equal(typeof res.data.id, 'string');
      assert.equal(res.data.title, 'Hourly code review');
      assert.equal(res.data.goal, 'Review open PRs and provide feedback');
      assert.equal(res.data.cron_pattern, '0 * * * *');
      assert.equal(res.data.max_concurrent, 2);
      assert.equal(res.data.enabled, true);
      assert.equal(res.data.worker_capability, null);
      assert.equal(typeof res.data.next_run_at, 'string');
      assert.equal(typeof res.data.created_at, 'string');
      scheduleId = res.data.id;
    }

    // ── POST: with worker_capability ─────────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'Capability');
      const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'Code task',
        goal: 'Write tests',
        cron_pattern: '*/15 * * * *',
        worker_capability: 'code',
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.worker_capability, 'code');
    }

    // ── POST: invalid cron_pattern → 422 ─────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'Bad cron');
      const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'Bad',
        goal: 'Bad cron',
        cron_pattern: 'not-a-cron',
      });
      assert.equal(res.status, 422, 'invalid cron pattern should be 422');
    }

    // ── POST: missing title → 422 ────────────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'No title');
      const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        goal: 'No title here',
        cron_pattern: '* * * * *',
      });
      assert.equal(res.status, 422);
    }

    // ── POST: missing goal → 422 ─────────────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'No goal');
      const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'No goal',
        cron_pattern: '* * * * *',
      });
      assert.equal(res.status, 422);
    }

    // ── POST: missing cron_pattern → 422 ─────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'No cron');
      const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'No cron',
        goal: 'Missing pattern',
      });
      assert.equal(res.status, 422);
    }

    // ── POST: no auth → 401 ──────────────────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'No auth');
      const res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, undefined, {
        title: 'No auth',
        goal: 'Should fail',
        cron_pattern: '* * * * *',
      });
      assert.equal(res.status, 401);
    }

    // ── GET: list schedules ──────────────────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'List');
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'Schedule A',
        goal: 'Goal A',
        cron_pattern: '0 * * * *',
      });
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'Schedule B',
        goal: 'Goal B',
        cron_pattern: '*/30 * * * *',
      });

      const res = await api(baseUrl, 'GET', `/v1/projects/${projectId}/schedules`, owner.token);
      assert.equal(res.status, 200);
      assert.equal(Array.isArray(res.data.data), true);
      assert.equal(res.data.data.length, 2);
      assert.equal(res.data.data[0].title, 'Schedule B');
      assert.equal(res.data.data[1].title, 'Schedule A');
    }

    // ── GET: no auth → 401 ──────────────────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'List no auth');
      const res = await api(baseUrl, 'GET', `/v1/projects/${projectId}/schedules`, undefined);
      assert.equal(res.status, 401);
    }

    // ── DELETE: remove schedule ──────────────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'Delete');
      const created = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'To Delete',
        goal: 'Will be removed',
        cron_pattern: '0 * * * *',
      });
      assert.equal(created.status, 201);
      const sid = created.data.id;

      const list1 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/schedules`, owner.token);
      assert.equal(list1.data.data.length, 1);

      const del = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/schedules/${sid}`, owner.token);
      assert.equal(del.status, 204);

      const list2 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/schedules`, owner.token);
      assert.equal(list2.data.data.length, 0);
    }

    // ── DELETE: not found → 404 ──────────────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'Delete 404');
      const res = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/schedules/nonexistent-id`, owner.token);
      assert.equal(res.status, 404);
    }

    // ── DELETE: no auth → 401 ────────────────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'Delete no auth');
      const res = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/schedules/fake-id`, undefined);
      assert.equal(res.status, 401);
    }

    // ── max_concurrent defaults/clamps ───────────────────────────────────────
    {
      const { projectId } = await setup(baseUrl, owner.token, 'Max concurrent');
      const r1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'Default max',
        goal: 'Should be 1',
        cron_pattern: '0 * * * *',
      });
      assert.equal(r1.data.max_concurrent, 1, 'default max_concurrent is 1');

      const r2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/scheduled-dispatch`, owner.token, {
        title: 'Clamped max',
        goal: 'Should be clamped to 10',
        cron_pattern: '0 * * * *',
        max_concurrent: 100,
      });
      assert.equal(r2.data.max_concurrent, 10, 'max_concurrent clamped to 10');
    }

    console.log('scheduled-dispatch tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function setup(
  baseUrl: string,
  token: string,
  label: string,
): Promise<{ projectId: string }> {
  const project = await api(baseUrl, 'POST', '/v1/projects', token, {
    name: `Scheduled Dispatch ${label}`,
    description: 'scheduled-dispatch e2e',
  });
  assert.equal(project.status, 201);
  return { projectId: project.data.id };
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email,
    password: 'ScheduledDispatch123!',
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
