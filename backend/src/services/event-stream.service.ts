import { v4 as uuidv4 } from 'uuid';
import { Response } from 'express';
import { webhookService } from './webhook.service';

export interface EventEnvelope {
  id: string;
  seq: number;
  projectId: string;
  sessionId: string;
  agentId?: string;
  userId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  traceId?: string;
}

export interface PersistedEventLike {
  id: string;
  seq: number;
  projectId: string;
  sessionId: string;
  agentId?: string | null;
  userId?: string | null;
  type: string;
  payloadJson?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  createdAt: Date | string;
  traceId?: string | null;
}

interface Subscriber {
  sessionId: string;
  lastSeq: number;
  res: Response;
  heartbeatTimer: NodeJS.Timeout;
}

/**
 * A project-scoped realtime subscriber (e.g. a /ws/loop WebSocket). Unlike the
 * session-scoped SSE Subscriber above, this is a plain delivery callback rather
 * than an Express Response, so it works equally well over WebSocket frames.
 * Filtering by event type is the caller's responsibility.
 */
export interface ProjectSubscriber {
  send: (envelope: EventEnvelope) => void;
}

/**
 * EventStreamService manages all active SSE connections.
 *
 * - `subscribe(sessionId, res)` — registers a new SSE subscriber
 * - `publish(sessionId, event)` — publishes an event to all subscribers of a session
 * - Events are stored in-memory, grouped by session_id
 * - Heartbeat (every 30s) auto-cleans disconnected clients
 */
export class EventStreamService {
  private subscribers: Map<string, Subscriber[]> = new Map();
  private eventStore: Map<string, EventEnvelope[]> = new Map();
  private seqCounters: Map<string, number> = new Map();
  // Project-scoped realtime subscribers (WebSocket /ws/loop clients), keyed by
  // projectId. Fan-out is driven by each envelope's projectId, so a loop
  // subscriber sees every event published for its project regardless of which
  // session the event was emitted under.
  private projectSubscribers: Map<string, Set<ProjectSubscriber>> = new Map();
  private readonly HEARTBEAT_INTERVAL_MS = 30000;
  private readonly MAX_EVENTS_PER_SESSION = 10000;

  /**
   * Subscribe to events for a given session.
   * Sends stored events (after lastSeq) and keeps the connection open for future events.
   * Returns an unsubscribe function.
   */
  subscribe(sessionId: string, res: Response, afterSeq = 0, initialEvents: EventEnvelope[] = []): () => void {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send persisted catch-up events first. If the caller did not provide
    // persisted events, fall back to the process-local buffer for legacy flows.
    const storedEvents = initialEvents.length > 0 ? initialEvents : this.eventStore.get(sessionId) || [];
    const missedEvents = storedEvents.filter((e) => e.seq > afterSeq);

    for (const event of missedEvents) {
      this.sendSSEEvent(res, event);
    }

    // Create subscriber
    const subscriber: Subscriber = {
      sessionId,
      lastSeq: afterSeq,
      res,
      heartbeatTimer: setInterval(() => {
        try {
          // SSE keepalive comment (':' is a comment in SSE spec)
          res.write(': heartbeat\n\n');
        } catch {
          // Connection likely dead; cleanup will handle it
          this.removeSubscriber(sessionId, res);
        }
      }, this.HEARTBEAT_INTERVAL_MS),
    };

    // Register subscriber
    const subs = this.subscribers.get(sessionId) || [];
    subs.push(subscriber);
    this.subscribers.set(sessionId, subs);

    // Cleanup on client disconnect
    res.on('close', () => {
      this.removeSubscriber(sessionId, res);
    });

    // Return unsubscribe function
    return () => {
      this.removeSubscriber(sessionId, res);
    };
  }

  /**
   * Publish an event to all subscribers of a session.
   * The event is stored in memory and sent to all active subscribers.
   */
  publish(sessionId: string, event: Omit<EventEnvelope, 'id' | 'seq' | 'createdAt'>): EventEnvelope {
    // Get and increment sequence counter
    const currentSeq = (this.seqCounters.get(sessionId) || 0) + 1;
    this.seqCounters.set(sessionId, currentSeq);

    const envelope: EventEnvelope = {
      id: `evt_${uuidv4().replace(/-/g, '')}`,
      seq: currentSeq,
      projectId: event.projectId,
      sessionId: event.sessionId,
      agentId: event.agentId,
      userId: event.userId,
      type: event.type,
      payload: event.payload,
      createdAt: new Date().toISOString(),
      traceId: event.traceId,
    };

    // Store event in memory
    const storedEvents = this.eventStore.get(sessionId) || [];
    storedEvents.push(envelope);

    // Enforce max events (remove oldest)
    if (storedEvents.length > this.MAX_EVENTS_PER_SESSION) {
      storedEvents.splice(0, storedEvents.length - this.MAX_EVENTS_PER_SESSION);
    }
    this.eventStore.set(sessionId, storedEvents);

    // Send to all active subscribers
    const subs = this.subscribers.get(sessionId) || [];
    for (const sub of subs) {
      this.sendSSEEvent(sub.res, envelope);
    }

    // Fan out to project-scoped realtime subscribers (e.g. /ws/loop).
    this.broadcastToProject(envelope);

    // Trigger webhook delivery (fire-and-forget)
    webhookService.sendWebhook(event.projectId, envelope).catch((err) => {
      console.error('[event-stream] Webhook trigger error:', err);
    });

    return envelope;
  }

  /**
   * Broadcast an event that has already been committed to the append-only DB log.
   * This keeps SSE sequence numbers identical to persisted `events.seq`.
   */
  publishPersisted(event: PersistedEventLike): EventEnvelope {
    const envelope = eventToEnvelope(event);
    this.storeEnvelope(envelope);
    this.broadcast(envelope);

    webhookService.sendWebhook(envelope.projectId, envelope).catch((err) => {
      console.error('[event-stream] Webhook trigger error:', err);
    });

    return envelope;
  }

  /**
   * Get stored events for a session (for catch-up after reconnection).
   */
  getEvents(sessionId: string, afterSeq = 0): EventEnvelope[] {
    const storedEvents = this.eventStore.get(sessionId) || [];
    return storedEvents.filter((e) => e.seq > afterSeq);
  }

  toEnvelope(event: PersistedEventLike): EventEnvelope {
    return eventToEnvelope(event);
  }

  /**
   * Subscribe a project-scoped realtime listener (e.g. a /ws/loop WebSocket).
   * Returns an unsubscribe function. The caller owns type filtering — every
   * envelope published for this projectId is forwarded to `subscriber.send`.
   */
  subscribeProject(projectId: string, subscriber: ProjectSubscriber): () => void {
    const subs = this.projectSubscribers.get(projectId) || new Set<ProjectSubscriber>();
    subs.add(subscriber);
    this.projectSubscribers.set(projectId, subs);

    return () => {
      this.removeProjectSubscriber(projectId, subscriber);
    };
  }

  private removeProjectSubscriber(projectId: string, subscriber: ProjectSubscriber): void {
    const subs = this.projectSubscribers.get(projectId);
    if (!subs) return;
    subs.delete(subscriber);
    if (subs.size === 0) {
      this.projectSubscribers.delete(projectId);
    }
  }

  private storeEnvelope(envelope: EventEnvelope): void {
    const storedEvents = this.eventStore.get(envelope.sessionId) || [];
    const existingIndex = storedEvents.findIndex((item) => item.id === envelope.id);
    if (existingIndex === -1) {
      storedEvents.push(envelope);
    } else {
      storedEvents[existingIndex] = envelope;
    }

    storedEvents.sort((a, b) => a.seq - b.seq);
    if (storedEvents.length > this.MAX_EVENTS_PER_SESSION) {
      storedEvents.splice(0, storedEvents.length - this.MAX_EVENTS_PER_SESSION);
    }
    this.eventStore.set(envelope.sessionId, storedEvents);
    this.seqCounters.set(envelope.sessionId, Math.max(this.seqCounters.get(envelope.sessionId) || 0, envelope.seq));
  }

  private broadcast(envelope: EventEnvelope): void {
    const subs = this.subscribers.get(envelope.sessionId) || [];
    for (const sub of subs) {
      this.sendSSEEvent(sub.res, envelope);
    }
    // Fan out to project-scoped realtime subscribers (e.g. /ws/loop).
    this.broadcastToProject(envelope);
  }

  private broadcastToProject(envelope: EventEnvelope): void {
    const subs = this.projectSubscribers.get(envelope.projectId);
    if (!subs || subs.size === 0) return;
    for (const sub of subs) {
      try {
        sub.send(envelope);
      } catch (err) {
        // Delivery callback threw (likely a dead socket) — drop silently; the
        // WS layer cleans up via its own close/error handlers.
        console.error('[event-stream] Project subscriber delivery error:', err);
      }
    }
  }

  private sendSSEEvent(res: Response, event: EventEnvelope): void {
    try {
      const data = JSON.stringify({
        id: event.id,
        seq: event.seq,
        type: event.type,
        session_id: event.sessionId,
        project_id: event.projectId,
        agent_id: event.agentId,
        user_id: event.userId,
        payload: event.payload,
        created_at: event.createdAt,
        trace_id: event.traceId,
      });

      res.write(`id: ${event.seq}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${data}\n\n`);
    } catch {
      // Connection dead, will be cleaned up by heartbeat or close event
    }
  }

  private removeSubscriber(sessionId: string, res: Response): void {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;

    const index = subs.findIndex((s) => s.res === res);
    if (index !== -1) {
      clearInterval(subs[index].heartbeatTimer);
      subs.splice(index, 1);
    }

    if (subs.length === 0) {
      this.subscribers.delete(sessionId);
    } else {
      this.subscribers.set(sessionId, subs);
    }
  }
}

export const eventStreamService = new EventStreamService();

function eventToEnvelope(event: PersistedEventLike): EventEnvelope {
  return {
    id: event.id,
    seq: event.seq,
    projectId: event.projectId,
    sessionId: event.sessionId,
    agentId: event.agentId ?? undefined,
    userId: event.userId ?? undefined,
    type: event.type,
    payload: event.payloadJson ?? event.payload ?? {},
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
    traceId: event.traceId ?? undefined,
  };
}
