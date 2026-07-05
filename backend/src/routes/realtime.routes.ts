import { Router, Request, Response } from 'express';
import http from 'http';
import net from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { AppDataSource } from '../data-source';
import { ProjectMember } from '../entities/project-member.entity';
import { eventStreamService, EventEnvelope } from '../services/event-stream.service';
import { verifyAccessToken, resolveAgentByApiKey } from '../middleware/auth';
import { buildLoopStatus } from './orchestrations.routes';

const router = Router();

/**
 * Loop event types forwarded to /ws/loop subscribers. Everything else emitted
 * on the event stream (message.created, agent.run.*, health.metric, …) stays
 * session-scoped and is NOT pushed to loop subscribers, so the dashboard only
 * receives the high-signal loop transitions.
 */
export const LOOP_EVENT_TYPES: readonly string[] = [
  'task_dispatched',
  'task_claimed',
  'task_completed',
  'changeset_submitted',
  'changeset_merged',
  'worker_health_changed',
  'alert_raised',
];

const LOOP_EVENT_TYPE_SET = new Set<string>(LOOP_EVENT_TYPES);

const PING_INTERVAL_MS = 30_000;

type LoopIdentity =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string };

type AuthResult =
  | { ok: true; identity: LoopIdentity }
  | { ok: false; status: number; detail: string };

/** Shape of every frame pushed over /ws/loop. */
interface LoopFrame {
  type: string;
  // loop-status frames carry the loop overview; event frames carry the envelope.
  payload?: unknown;
  data?: unknown;
}

/**
 * GET /v1/realtime
 *
 * Describes the /ws/loop WebSocket endpoint for API discovery (the upgrade
 * itself can't be documented by an HTTP handler). Returns the path, the query
 * params it expects, and the event types it pushes.
 */
router.get('/v1/realtime', (_req: Request, res: Response) => {
  res.json({
    websocket: '/ws/loop',
    query_params: {
      project_id: 'project to subscribe to (required)',
      token: 'JWT access token or zzk_ agent API key (required)',
    },
    snapshot: 'on connect a { type: "loop-status", payload } frame is pushed',
    events: LOOP_EVENT_TYPES,
  });
});

export const realtimeRouter = router;

/**
 * Verify the query `token` (JWT or zzk_ agent key) AND that the bearer is
 * allowed to see `projectId`. Mirrors the loop-status HTTP route's auth:
 * JWT users must be a project member; agents must belong to the project.
 */
async function authorizeLoopAccess(projectId: string, token: string): Promise<AuthResult> {
  if (!token) {
    return { ok: false, status: 401, detail: 'Missing token' };
  }

  // JWT path — anything that is not an agent key is treated as a JWT.
  if (!token.startsWith('zzk_')) {
    const payload = verifyAccessToken(token);
    if (!payload || !payload.userId) {
      return { ok: false, status: 401, detail: 'Invalid token' };
    }
    const memberRepo = AppDataSource.getRepository(ProjectMember);
    const membership = await memberRepo.findOne({
      where: { projectId, userId: payload.userId },
    });
    if (!membership) {
      return { ok: false, status: 403, detail: 'Not a member of this project' };
    }
    return { ok: true, identity: { kind: 'user', userId: payload.userId } };
  }

  // Agent API-key path.
  const agent = await resolveAgentByApiKey(token);
  if (!agent) {
    return { ok: false, status: 401, detail: 'Invalid token' };
  }
  if (agent.projectId !== projectId) {
    return { ok: false, status: 403, detail: 'Agent is not a member of this project' };
  }
  return { ok: true, identity: { kind: 'agent', agentId: agent.id } };
}

/** Write a short HTTP error response on a raw upgrade socket, then destroy it. */
function rejectUpgrade(socket: net.Socket, status: number, detail: string): void {
  const body = JSON.stringify({ detail });
  try {
    socket.write(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body,
    );
  } catch {
    // Socket already torn down — nothing to do.
  }
  socket.destroy();
}

/** Render a persisted/live event envelope as a client-facing loop frame. */
function eventToFrame(envelope: EventEnvelope): LoopFrame {
  return {
    type: envelope.type,
    data: {
      id: envelope.id,
      seq: envelope.seq,
      type: envelope.type,
      project_id: envelope.projectId,
      session_id: envelope.sessionId,
      agent_id: envelope.agentId,
      user_id: envelope.userId,
      payload: envelope.payload,
      created_at: envelope.createdAt,
      trace_id: envelope.traceId,
    },
  };
}

/**
 * Per-connection handler. Sends the loop-status snapshot, subscribes to project
 * events (filtered to LOOP_EVENT_TYPES), and keeps the connection alive with
 * periodic pings until the client disconnects.
 */
function setupLoopConnection(ws: WebSocket, projectId: string, identity: LoopIdentity): void {
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let pingTimer: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  // Snapshot first — the dashboard renders from this before any deltas land.
  buildLoopStatus(projectId)
    .then((status) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'loop-status', payload: status } satisfies LoopFrame));
    })
    .catch((err) => {
      console.error('[realtime] loop-status snapshot failed:', err);
      if (!closed && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'error',
            payload: { detail: 'Failed to build loop-status snapshot' },
          } satisfies LoopFrame),
        );
      }
    });

  // Push deltas: forward only the high-signal loop event types.
  unsubscribe = eventStreamService.subscribeProject(projectId, {
    send: (envelope: EventEnvelope) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (!LOOP_EVENT_TYPE_SET.has(envelope.type)) return;
      try {
        ws.send(JSON.stringify(eventToFrame(envelope)));
      } catch (err) {
        console.error('[realtime] ws send failed:', err);
        cleanup();
        try {
          ws.close();
        } catch {
          // already gone
        }
      }
    },
  });

  // Liveness ping. If a pong hasn't revived isAlive since the last interval,
  // the client is gone — terminate so the subscriber set doesn't leak.
  let isAlive = true;
  ws.on('pong', () => {
    isAlive = true;
  });
  pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!isAlive) {
      cleanup();
      try {
        ws.terminate();
      } catch {
        // already gone
      }
      return;
    }
    isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore — next tick will clean up
    }
  }, PING_INTERVAL_MS);

  // Identity is currently used only for auth; surfaced here for future per-
  // subscriber filtering without changing the signature.
  void identity;
}

/**
 * Attach the /ws/loop WebSocket endpoint to an existing HTTP server. Call once
 * after `http.createServer(app)`. Returns the WebSocketServer so the caller can
 * close it on shutdown.
 */
export function attachRealtimeWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const url = new URL(req.url || '', 'http://localhost');
    if (url.pathname !== '/ws/loop') {
      // Not our endpoint — leave it to any other upgrade handler. There are
      // none today, so the socket simply won't be upgraded.
      return;
    }

    const projectId = url.searchParams.get('project_id');
    const token = url.searchParams.get('token') || '';

    if (!projectId) {
      rejectUpgrade(socket, 400, 'Missing project_id query parameter');
      return;
    }

    authorizeLoopAccess(projectId, token)
      .then((auth) => {
        if (!auth.ok) {
          rejectUpgrade(socket, auth.status, auth.detail);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          setupLoopConnection(ws as WebSocket, projectId, auth.identity);
        });
      })
      .catch((err) => {
        console.error('[realtime] upgrade authorization failed:', err);
        rejectUpgrade(socket, 500, 'Authorization error');
      });
  });

  return wss;
}
