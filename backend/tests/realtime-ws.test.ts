/**
 * R25a: WebSocket /ws/loop — real-time loop events
 *
 * Boots the app in-process, attaches the /ws/loop WebSocket endpoint, then uses
 * a real `ws` client to verify:
 *   1. Auth via the `token` query param (JWT) succeeds and the server pushes a
 *      `loop-status` snapshot on connect.
 *   2. A published loop event (`task_dispatched`) is forwarded to the
 *      project-scoped subscriber as a delta frame.
 *   3. An invalid token is rejected at the upgrade handshake (no `open`).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'realtime-ws-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function checkTrue(label: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

/** Resolve on the next WebSocket message, rejecting after `ms` with no message. */
function nextMessage(ws: WebSocket, ms = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no message within ${ms}ms`)), ms);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe the HTTP health endpoint until the server is accepting requests. The
 * `listening` callback only guarantees the socket is bound — in CI the Express
 * stack / WS upgrade handler can still need a tick before the first WS upgrade
 * lands cleanly, so we wait for a real 200 here.
 */
async function waitForServer(baseUrl: string, retries = 50, delayMs = 100): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${baseUrl}/v1/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(delayMs);
  }
  throw new Error(`server at ${baseUrl} did not become ready within ${retries * delayMs}ms`);
}

/**
 * Open a WebSocket with retries. CI runners can drop or delay the initial
 * upgrade handshake; on any error/close-before-open we back off and try again
 * instead of failing the whole suite.
 */
async function connectWithRetry(url: string, retries = 5, delayMs = 500): Promise<WebSocket> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    const ws = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (err) => reject(err));
        ws.once('unexpected-response', (_req: any, res: any) =>
          reject(new Error(`unexpected upgrade response ${res?.statusCode}`)));
      });
      return ws; // opened cleanly
    } catch (err) {
      lastErr = err;
      try { ws.close(); } catch { /* already closed */ }
      await sleep(delayMs);
    }
  }
  throw new Error(`WS connect to ${url} failed after ${retries} attempts: ${String(lastErr)}`);
}

function register(baseUrl: string, prefix: string) {
  return api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@x.invalid`,
    password: 'RealtimeWsTest123!', display_name: prefix,
  });
}

async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let d: any = t;
  try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { attachRealtimeWebSocket } = await import('../src/routes/realtime.routes');
  const { eventStreamService } = await import('../src/services/event-stream.service');

  await AppDataSource.initialize();
  const server = http.createServer(app);
  attachRealtimeWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  // Ensure the HTTP server (and WS upgrade handler) is fully ready before any
  // client connects — the bound-socket callback alone isn't enough in CI.
  await waitForServer(baseUrl);

  try {
    console.log('\n── Setup: owner + project ──');
    const owner = await register(baseUrl, 'rt-owner');
    assert.equal(owner.status, 201);
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.data.access_token, {
      name: 'Realtime WS Test', visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;
    const token = owner.data.access_token;

    // ── 1. Authenticated connect → loop-status snapshot ──────────────────
    console.log('\n── Test 1: authenticated connect yields loop-status snapshot ──');
    const ws = await connectWithRetry(`${wsBase}/ws/loop?project_id=${projectId}&token=${token}`);

    const snapshot = await nextMessage(ws);
    check('snapshot frame type', snapshot.type, 'loop-status');
    check('snapshot has workers array', Array.isArray(snapshot.payload?.workers), true);
    check('snapshot has pending_changesets array', Array.isArray(snapshot.payload?.pending_changesets), true);
    check('snapshot running_tasks is number', typeof snapshot.payload?.running_tasks, 'number');
    check('snapshot has stalled_tasks array', Array.isArray(snapshot.payload?.stalled_tasks), true);
    check(
      'snapshot has orchestrations breakdown',
      snapshot.payload?.orchestrations && typeof snapshot.payload.orchestrations === 'object',
      true,
    );

    // ── 2. Published loop event → delta frame ────────────────────────────
    console.log('\n── Test 2: published task_dispatched is forwarded ──');
    eventStreamService.publish('sess-rt-test', {
      projectId,
      sessionId: 'sess-rt-test',
      type: 'task_dispatched',
      payload: { taskId: 'task-rt-1', agentId: 'agent-rt-1' },
    });

    const eventFrame = await nextMessage(ws);
    check('event frame type', eventFrame.type, 'task_dispatched');
    check('event data.type', eventFrame.data?.type, 'task_dispatched');
    check('event data.project_id', eventFrame.data?.project_id, projectId);
    check('event payload.taskId', eventFrame.data?.payload?.taskId, 'task-rt-1');

    // A non-loop event type published for the same project must NOT be forwarded.
    console.log('\n── Test 3: non-loop events are filtered out ──');
    let gotFiltered = false;
    const filteredWait = new Promise<void>((resolve) => {
      ws.once('message', () => {
        gotFiltered = true;
        resolve();
      });
      setTimeout(() => resolve(), 500); // quiet window → filtered as expected
    });
    eventStreamService.publish('sess-rt-test', {
      projectId,
      sessionId: 'sess-rt-test',
      type: 'message.created',
      payload: { content: 'should not be pushed to loop subscribers' },
    });
    await filteredWait;
    check('non-loop event filtered (no frame)', gotFiltered, false);

    ws.close();

    // ── 4. Invalid token rejected at upgrade ────────────────────────────
    console.log('\n── Test 4: invalid token rejected at upgrade ──');
    const bad = new WebSocket(`${wsBase}/ws/loop?project_id=${projectId}&token=not-a-real-jwt`);
    let opened = false;
    let rejectedStatus: number | null = null;
    await new Promise<void>((resolve) => {
      bad.once('open', () => {
        opened = true;
        resolve();
      });
      // `ws` surfaces a non-101 upgrade response as 'unexpected-response'.
      bad.once('unexpected-response', (_req: any, res: any) => {
        rejectedStatus = res?.statusCode ?? null;
        resolve();
      });
      bad.once('error', () => resolve());
      bad.once('close', () => resolve());
      setTimeout(resolve, 2000);
    });
    checkTrue('invalid token did not open', !opened);
    if (rejectedStatus !== null) {
      check('invalid token upgrade status', rejectedStatus, 401);
    } else {
      // Some transports surface this as 'error'/'close' rather than
      // 'unexpected-response'; the important invariant is "did not open".
      checkTrue('invalid token rejected (no open)', !opened);
    }
    try { bad.close(); } catch { /* already closed */ }

    // ── 5. Missing project_id rejected ──────────────────────────────────
    console.log('\n── Test 5: missing project_id rejected at upgrade ──');
    const noPid = new WebSocket(`${wsBase}/ws/loop?token=${token}`);
    let pidOpened = false;
    let pidStatus: number | null = null;
    await new Promise<void>((resolve) => {
      noPid.once('open', () => { pidOpened = true; resolve(); });
      noPid.once('unexpected-response', (_req: any, res: any) => {
        pidStatus = res?.statusCode ?? null;
        resolve();
      });
      noPid.once('error', () => resolve());
      noPid.once('close', () => resolve());
      setTimeout(resolve, 2000);
    });
    checkTrue('missing project_id did not open', !pidOpened);
    if (pidStatus !== null) {
      check('missing project_id upgrade status', pidStatus, 400);
    }
    try { noPid.close(); } catch { /* already closed */ }

    console.log(`\n────────\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
  } finally {
    server.close();
    await AppDataSource.destroy().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
