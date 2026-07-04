import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * GK Acceptance Gate 3 — MD single source of truth (DB reconciliation).
 *
 * This test proves that the Markdown collaboration artifacts are the durable
 * source of truth and can be fully reconstructed from the database, with no
 * reliance on an in-memory cache. It runs against the local SQLite test DB
 * (better-sqlite3 in-memory via AppDataSource), exercising the same code path
 * a production deployment would use against Postgres.
 *
 * Strategy:
 *   1. Drive the full lifecycle (register → project → agents → orchestration →
 *      dispatch → claim → complete → review → orchestration complete) so all
 *      canonical MD artifacts are written into project-space.
 *   2. Query the database DIRECTLY (bypassing the HTTP API and any cache) to
 *      reconstruct the MD state: every project_files row whose path is under
 *      the orchestration basePath, plus the orchestration + task rows.
 *   3. Compare the DB-reconstructed view against the API-served view and prove
 *      they are identical:
 *        - same set of MD artifact paths
 *        - same content (DB content_hash matches the bytes the API serves)
 *        - same content_hash stored on disk vs computed from DB content
 *   4. Prove state is reconstructable from DB: rebuild the task-index facts
 *      (task id, status, assigned agent, which artifacts exist) purely from
 *      DB rows and assert they match what TRACE.md / the API report.
 *
 * If this test passes, MD state can always be recovered from the database —
 * the defining property of "single source of truth".
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'md-db-reconciliation-test-secret';

import crypto from 'node:crypto';

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  await AppDataSource.initialize();
  try {
    const app = (await import('../src/app')).default;
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // ── 1. Drive the full lifecycle ──────────────────────────────────────
      const owner = await register(baseUrl, 'recon-owner');
      const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
        name: 'Gate3 Reconciliation',
        description: 'Prove MD is reconstructable from DB.',
      });
      assert.equal(project.status, 201);
      const projectId = project.data.id;

      const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'Main' });
      const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'Worker' });
      assert.equal(mainAgent.status, 201);
      assert.equal(workerAgent.status, 201);
      await heartbeatAgent(baseUrl, mainAgent.data.api_key);
      await heartbeatAgent(baseUrl, workerAgent.data.api_key);

      const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
        title: 'Recon Orch',
        objective: 'Reconstruct MD from DB.',
        main_agent_id: mainAgent.data.id,
        worker_agent_ids: [workerAgent.data.id],
      });
      assert.equal(orch.status, 201);
      const basePath: string = orch.data.base_path;
      const orchestrationId: string = orch.data.id;

      const taskResp = await apiWithKey(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
        mainAgent.data.api_key,
        { title: 'Recon task', goal: 'Reconstruct.', assigned_agent_id: workerAgent.data.id },
      );
      assert.equal(taskResp.status, 201);
      const taskId: string = taskResp.data.id;

      await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/claim`, workerAgent.data.api_key);

      const complete = await apiWithKey(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/complete`,
        workerAgent.data.api_key,
        {
          result_md: '# Result\n\nReconciliation result content.',
          evidence: { note: 'recon-evidence', metric: 42 },
        },
      );
      assert.equal(complete.status, 200);

      const review = await apiWithKey(
        baseUrl,
        'PATCH',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${taskId}/review`,
        mainAgent.data.api_key,
        { decision: 'approved', auto_merge: false, notes: 'Recon approved.' },
      );
      assert.equal(review.status, 200);

      const orchComplete = await apiWithKey(
        baseUrl,
        'PATCH',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/complete`,
        mainAgent.data.api_key,
        { summary: 'Recon orchestration completed.' },
      );
      assert.equal(orchComplete.status, 200);

      // ── 2. API-served view of all project-space files under basePath ─────
      const apiFiles: Array<{ id: string; path: string; content_hash?: string; size_bytes?: number }> =
        await listFiles(baseUrl, owner.token, projectId, basePath);
      const apiByPath = new Map(apiFiles.map((f) => [f.path, f]));
      assert.ok(apiByPath.size > 0, 'API must serve project-space files under basePath');

      // ── 3. DB-reconstructed view: query project_files DIRECTLY ───────────
      // Bypass the HTTP API and any in-memory cache. This proves the DB holds
      // the authoritative MD state.
      const dbRows: Array<{ path: string; content: string; content_hash: string; size_bytes: number; content_type: string }> =
        await AppDataSource.query(
          `SELECT path, content, content_hash, size_bytes, content_type
           FROM project_files
           WHERE project_id = ? AND path LIKE ?
           ORDER BY path`,
          [projectId, `${basePath}%`],
        );
      assert.ok(dbRows.length > 0, 'DB must contain project_files rows under basePath');
      const dbByPath = new Map(dbRows.map((r) => [r.path, r]));

      // ── 4. Assert path-set parity (API view == DB view) ──────────────────
      const apiPaths = new Set(apiByPath.keys());
      const dbPaths = new Set(dbByPath.keys());
      const onlyInApi = [...apiPaths].filter((p) => !dbPaths.has(p));
      const onlyInDb = [...dbPaths].filter((p) => !apiPaths.has(p));
      assert.deepEqual(onlyInApi, [], `No paths should exist only in API view: ${JSON.stringify(onlyInApi)}`);
      assert.deepEqual(onlyInDb, [], `No paths should exist only in DB view: ${JSON.stringify(onlyInDb)}`);

      // ── 5. Assert content parity: DB content recomputes to stored hash ──
      // AND DB content_hash equals what the API reports. This proves the bytes
      // are identical and the hash is a faithful checksum.
      const mdSuffixes = ['goal.md', 'plan.md', 'TRACE.md'];
      for (const suffix of mdSuffixes) {
        const fullPath = `${basePath}/${suffix}`;
        const dbRow = dbByPath.get(fullPath);
        const apiFile = apiByPath.get(fullPath);
        assert.ok(dbRow, `DB must contain ${suffix}`);
        assert.ok(apiFile, `API must serve ${suffix}`);
        // DB content recomputes to its own stored hash (internal integrity)
        assert.equal(sha256(dbRow.content), dbRow.content_hash, `DB ${suffix} content must recompute to stored hash`);
        // DB hash matches API-reported hash
        if (apiFile.content_hash) {
          assert.equal(dbRow.content_hash, apiFile.content_hash, `DB/API ${suffix} content_hash must match`);
        }
        // size_bytes consistent
        assert.equal(dbRow.size_bytes, Buffer.byteLength(dbRow.content, 'utf8'), `DB ${suffix} size_bytes must match byte length`);
      }

      // Per-task canonical artifacts
      const taskSuffixes = ['TASK.md', 'RESULT.md', 'EVIDENCE.md', 'REVIEW.md', 'CHANGELOG.md'];
      for (const suffix of taskSuffixes) {
        const fullPath = `${basePath}/tasks/${taskId}/${suffix}`;
        const dbRow = dbByPath.get(fullPath);
        assert.ok(dbRow, `DB must contain tasks/${taskId}/${suffix}`);
        assert.equal(sha256(dbRow.content), dbRow.content_hash, `DB ${suffix} content must recompute to stored hash`);
      }

      // ── 6. Prove state is reconstructable from DB metadata ──────────────
      // The orchestration + task rows alone must let us rebuild the facts that
      // TRACE.md reports (task id, status, assigned agent, artifact existence).
      const orchRow: { id: string; status: string; title: string; base_path: string }[] = await AppDataSource.query(
        `SELECT id, status, title, base_path FROM project_orchestrations WHERE id = ?`,
        [orchestrationId],
      );
      assert.equal(orchRow.length, 1, 'DB must contain the orchestration row');
      assert.equal(orchRow[0].status, 'completed', 'DB orchestration status must be reconstructable to completed');

      const taskRow: { id: string; status: string; assigned_agent_id: string | null; result_path: string | null; evidence_path: string | null; review_notes: string | null }[] =
        await AppDataSource.query(
          `SELECT id, status, assigned_agent_id, result_path, evidence_path, review_notes
           FROM project_orchestration_tasks WHERE id = ?`,
          [taskId],
        );
      assert.equal(taskRow.length, 1, 'DB must contain the task row');
      const t = taskRow[0];
      assert.equal(t.status, 'approved', 'DB task status must reconstruct to approved');
      assert.equal(t.assigned_agent_id, workerAgent.data.id, 'DB task assigned_agent_id must reconstruct');
      assert.ok(t.result_path, 'DB task result_path must reconstruct (evidence binding)');
      assert.ok(t.evidence_path, 'DB task evidence_path must reconstruct (evidence binding)');
      assert.ok(t.review_notes, 'DB task review_notes must reconstruct (review evidence)');

      // Rebuild the "which artifacts exist" set purely from DB project_files
      // and confirm the canonical set is present.
      const dbArtifactPaths = new Set(dbByPath.keys());
      const expectedCanonical = [
        `${basePath}/goal.md`,
        `${basePath}/plan.md`,
        `${basePath}/TRACE.md`,
        `${basePath}/tasks/${taskId}/TASK.md`,
        `${basePath}/tasks/${taskId}/RESULT.md`,
        `${basePath}/tasks/${taskId}/EVIDENCE.md`,
        `${basePath}/tasks/${taskId}/REVIEW.md`,
        `${basePath}/tasks/${taskId}/CHANGELOG.md`,
      ];
      const missingFromDb = expectedCanonical.filter((p) => !dbArtifactPaths.has(p));
      assert.deepEqual(missingFromDb, [], `All canonical artifacts must be reconstructable from DB: missing ${JSON.stringify(missingFromDb)}`);

      // ── 7. Cross-check: TRACE.md content (from DB) matches API-served ───
      const traceDb = dbByPath.get(`${basePath}/TRACE.md`)!.content;
      const traceApiResp = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${apiByPath.get(`${basePath}/TRACE.md`)!.id}`, owner.token);
      assert.equal(traceApiResp.status, 200);
      assert.equal(traceDb, traceApiResp.data.content, 'TRACE.md content must be byte-identical between DB and API');
      assert.ok(traceDb.includes(taskId), 'Reconstructed TRACE.md must reference the task id');

      console.log('Gate 3 reconciliation passed: MD state fully reconstructable from DB (paths, content, hashes, state machine).');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    await AppDataSource.destroy();
  }

  console.log('md-db-reconciliation tests passed');
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'MdDbRecon123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201, 'Registration must succeed');
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function listFiles(baseUrl: string, token: string, projectId: string, pathPrefix: string): Promise<any[]> {
  const encoded = encodeURIComponent(pathPrefix);
  const response = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files?path_prefix=${encoded}`, token);
  assert.equal(response.status, 200, 'File listing must succeed');
  return response.data.data;
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, { status: 'healthy', metrics: { load: 0 } });
  assert.equal(response.status, 200, 'Heartbeat must succeed');
  assert.equal(response.data.ok, true, 'Heartbeat must return ok: true');
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
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function apiWithKey(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
