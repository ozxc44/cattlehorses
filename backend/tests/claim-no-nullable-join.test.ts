/**
 * R24a — claim-no-nullable-join regression test.
 *
 * Guards against re-introducing a LEFT JOIN on `task.orchestration` inside the
 * pessimistic-lock (SELECT ... FOR UPDATE) claim query.
 *
 * WHY the leftJoin must be omitted:
 *   PostgreSQL raises   ERROR: FOR UPDATE cannot be applied to the nullable
 *   side of an outer join   when `setLock('pessimistic_write')` is combined
 *   with a join to a nullable relation. `ProjectOrchestrationTask.orchestration`
 *   is nullable (a task may briefly exist without its parent row loaded), so a
 *   LEFT JOIN here turns every claim into a 500 and workers can never claim.
 *
 * This bug was fixed in 29b1f2c, accidentally re-introduced in de9d977, and this
 * test exists to prevent a third occurrence.
 *
 * The test has two complementary layers:
 *
 *   (1) STATIC SOURCE CHECK — the real regression guard. It reads the route
 *       source, isolates the claim lock-query block (createQueryBuilder →
 *       setLock), and asserts NO leftJoin appears inside it. This is necessary
 *       because the bug is PostgreSQL-specific:
 *
 *         - On SQLite (what `npm test` uses) `setLock` is never called — the
 *           join is a harmless eager load, so a behavioral claim → 200 PASSES
 *           even when the bug is present.
 *         - Only on PostgreSQL does the join + FOR UPDATE actually throw 500.
 *
 *       So the behavioral test alone could never catch the regression in CI;
 *       the source-level assertion is what makes this a real guard.
 *
 *   (2) BEHAVIORAL CHECK — seeds a project + orchestration + agent + task and
 *       claims it end-to-end, asserting 200 (not 500). This pins the happy path
 *       so a future refactor that breaks claiming is caught regardless of DB.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'claim-no-nullable-join-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(
      `  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function main(): Promise<void> {
  // ── (1) STATIC SOURCE CHECK ───────────────────────────────────────────────
  // The compiled test runs from dist/tests/, so __dirname/../../src points at
  // backend/src — the canonical source the regression was introduced in.
  const srcPath = path.resolve(
    __dirname,
    '..',
    '..',
    'src',
    'routes',
    'orchestrations.routes.ts',
  );
  const src = fs.readFileSync(srcPath, 'utf8');

  // Anchor on the real lock call. `lockQb.setLock(...)` is unique to the claim
  // handler's pessimistic-lock query (the variable `lockQb` is not reused
  // anywhere else). The `lockQb.` prefix also avoids matching the explanatory
  // comment, which mentions setLock('pessimistic_write') in prose.
  const lockIdx = src.indexOf("lockQb.setLock('pessimistic_write')");
  assert.notEqual(lockIdx, -1, 'could not find lockQb.setLock(pessimistic_write) in source');

  // Walk back to the start of THIS query-builder chain (the createQueryBuilder
  // immediately preceding the lock). lastIndexOf finds the nearest one above.
  const qbStart = src.lastIndexOf(
    'createQueryBuilder(ProjectOrchestrationTask',
    lockIdx,
  );
  assert.notEqual(qbStart, -1, 'could not find claim lock createQueryBuilder');

  const lockBlock = src.slice(qbStart, lockIdx);

  const hasLeftJoin = /leftJoin/i.test(lockBlock);
  check('(1) claim lock query contains NO leftJoin', hasLeftJoin, false);
  if (hasLeftJoin) {
    console.error(
      '    REGRESSION DETECTED: the claim lock query re-introduced a LEFT JOIN.\n' +
        '    Remove `.leftJoinAndSelect(\'task.orchestration\', ...)` from the\n' +
        '    pessimistic-lock query — PostgreSQL rejects FOR UPDATE on the\n' +
        '    nullable side of an outer join and every claim will 500.',
    );
  }

  // Belt-and-braces: the explanatory comment must remain so the next editor
  // understands why the join is intentionally absent.
  check(
    '(1) source explains why leftJoin is omitted',
    /FOR UPDATE cannot be applied to the nullable side/i.test(src) ||
      /nullable side of an outer join/i.test(src),
    true,
  );

  // ── (2) BEHAVIORAL CHECK ──────────────────────────────────────────────────
  const { AppDataSource } = await import('../src/data-source');
  const { ProjectOrchestrationTask, ProjectOrchestrationTaskStatus } = await import(
    '../src/entities'
  );
  const app = (await import('../src/app')).default;
  await AppDataSource.initialize();
  const server = http.createServer(app);

  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');
    const wUser = await register(baseUrl, 'w');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Claim No Nullable Join Test',
      visibility: 'public',
    });
    const projectId = project.data.id;
    for (const u of [pmUser, wUser]) {
      await api(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/members`,
        owner.token,
        { user_id: u.userId, role: 'member' },
      );
    }

    const pm = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/agents`,
      pmUser.token,
      { name: 'pm' },
    );
    const pmId = pm.data.id;
    const pmKey = pm.data.api_key;
    const w = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/agents`,
      wUser.token,
      { name: 'w' },
    );
    const wId = w.data.id;
    const wKey = w.data.api_key;
    for (const k of [pmKey, wKey]) {
      await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', k, {});
    }
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      main_agent_id: pmId,
    });

    const orch = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations`,
      owner.token,
      {
        title: 'no-nullable-join orch',
        objective: 'verify claim does not 500',
        main_agent_id: pmId,
        worker_agent_ids: [wId],
      },
    );
    const orchId = orch.data.id;

    // Seed a task targeted at worker w, then claim it.
    const dispatched = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`,
      pmKey,
      { title: 'claim me', goal: 'claim must return 200', assigned_agent_id: wId },
    );
    check('(2) task created → 201', dispatched.status, 201);
    const taskId = dispatched.data.id;

    // THE regression assertion: claim must succeed (200), not blow up with 500.
    // On PostgreSQL, a leftJoin+FOR UPDATE here would surface as a 500; on
    // SQLite the static check above is what catches the bug, but this pins the
    // happy path so neither DB silently breaks.
    const claim = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${taskId}/claim`,
      wKey,
    );
    check('(2) claim returns 200 (not 500)', claim.status, 200);
    check('(2) claimed task status is running', claim.data.status, 'running');

    // Verify DB state — the row is locked-then-updated, not lost.
    const dbTask = await AppDataSource.getRepository(
      ProjectOrchestrationTask,
    ).findOne({ where: { id: taskId } });
    assert(dbTask);
    check('(2) DB task status is running', dbTask.status, ProjectOrchestrationTaskStatus.RUNNING);
    check('(2) DB task assigned to claiming agent', dbTask.assignedAgentId, wId);
    check('(2) claimedAt is set', dbTask.claimedAt instanceof Date, true);

    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exit(1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function register(
  baseUrl: string,
  prefix: string,
): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ClaimNoNullableJoin123!',
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
) {
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
) {
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
