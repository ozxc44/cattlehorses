import { AppDataSource } from '../data-source';
import { MoreThanOrEqual, LessThan } from 'typeorm';
import { Incident, AlertType, AlertSeverity } from '../entities/incident.entity';
import { Message, MessageRole } from '../entities/message.entity';

const incidentRepo = AppDataSource.getRepository(Incident);
const messageRepo = AppDataSource.getRepository(Message);

// ─── Thresholds ──────────────────────────────────────────────────────────────

const THRESHOLDS = {
  /** Same message repeated N times within the window → loop */
  LOOP_REPEAT_COUNT: 4,
  /** Window in minutes for loop detection */
  LOOP_WINDOW_MINUTES: 30,

  /** Failed requests within RETRY_WINDOW_MINUTES → retry storm */
  RETRY_STORM_COUNT: 10,
  RETRY_WINDOW_MINUTES: 10,

  /** Tokens per single message → token spike */
  TOKEN_SPIKE_LIMIT: 50_000,

  /** Rolling-average response latency in ms → latency drift */
  LATENCY_DRIFT_MS: 30_000,
  LATENCY_WINDOW_MINUTES: 30,
} as const;

// ─── Stale-heartbeat sweep (R15a) ────────────────────────────────────────────
//
// A worker whose heartbeat is older than the online TTL (default 90s) has
// stopped heartbeating — it is effectively dead. The presence layer already
// makes such a worker non-dispatchable, but we ALSO persist
// healthStatus=unhealthy + healthLastError='heartbeat stale' so the R10b
// dispatch guard surfaces an explicit, durable reason and the health endpoint
// explains WHY the worker is sick, and we notify the project's main agent (PM)
// so it can reassign in-flight work. The threshold reuses AGENT_ONLINE_TTL_MS
// so "heartbeat stale" trips exactly when presence flips online → stale.

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const HEARTBEAT_STALE_MS = positiveIntFromEnv('AGENT_ONLINE_TTL_MS', 90_000);
const HEARTBEAT_STALE_SWEEP_MS = positiveIntFromEnv('HEARTBEAT_STALE_SWEEP_MS', 60_000);
export const HEARTBEAT_STALE_REASON = 'heartbeat stale';

// ─── Public API ─────────────────────────────────────────────────────────────

export class HealthMonitorService {
  /**
   * Run all health checks for a given agent.
   * Returns any newly created incidents (empty array if healthy).
   */
  async checkAgent(agentId: string): Promise<Incident[]> {
    const incidents: Incident[] = [];

    const loop = await this.detectLoop(agentId);
    if (loop) incidents.push(loop);

    const retry = await this.detectRetryStorm(agentId);
    if (retry) incidents.push(retry);

    const token = await this.detectTokenSpike(agentId);
    if (token) incidents.push(token);

    const latency = await this.detectLatencyDrift(agentId);
    if (latency) incidents.push(latency);

    return incidents;
  }

  /**
   * Check all agents in a project.
   */
  async checkProject(projectId: string): Promise<Incident[]> {
    const { Agent } = await import('../entities/agent.entity');
    const agentRepo = AppDataSource.getRepository(Agent);
    const agents = await agentRepo.find({ where: { projectId } });

    const allIncidents: Incident[] = [];
    for (const agent of agents) {
      const incidents = await this.checkAgent(agent.id);
      allIncidents.push(...incidents);
    }
    return allIncidents;
  }

  /**
   * R15a: sweep every agent whose heartbeat is older than the online TTL
   * (default 90s) and mark it unhealthy with healthLastError='heartbeat stale',
   * then notify each project's main agent (PM) which worker went stale.
   *
   * Marking (not just the live presence calc) makes the "dead worker" reason
   * durable on the agent row so the R10b dispatch guard — which reads
   * healthStatus — and the health endpoint surface it explicitly. Idempotent:
   * agents already flagged 'heartbeat stale' are skipped so the PM isn't
   * spammed every tick. A worker clears the mark by resuming heartbeats and
   * reporting a healthy smoke-test result (applySmokeHealth on the next beat).
   *
   * Returns the count of agents newly marked.
   */
  async sweepStaleHeartbeats(now = new Date()): Promise<{ marked: number }> {
    const { Agent, AgentStatus, AgentSmokeHealth } = await import('../entities/agent.entity');
    const { Project } = await import('../entities/project.entity');
    const { createInboxItem } = await import('../routes/agent-inbox.routes');
    const agentRepo = AppDataSource.getRepository(Agent);
    const projectRepo = AppDataSource.getRepository(Project);

    const threshold = new Date(now.getTime() - HEARTBEAT_STALE_MS);
    // Active workers whose last heartbeat predates the online TTL. A null
    // lastHeartbeatAt means the agent never came online — excluded (null < x
    // is false in SQL), matching "older than 90s since lastHeartbeatAt".
    const candidates = await agentRepo.find({
      where: { status: AgentStatus.ACTIVE, lastHeartbeatAt: LessThan(threshold) },
    });

    let marked = 0;
    for (const agent of candidates) {
      // Idempotent: don't re-mark / re-notify agents already flagged heartbeat-stale.
      if (
        agent.healthStatus === AgentSmokeHealth.UNHEALTHY &&
        agent.healthLastError === HEARTBEAT_STALE_REASON
      ) {
        continue;
      }

      agent.healthStatus = AgentSmokeHealth.UNHEALTHY;
      agent.healthLastError = HEARTBEAT_STALE_REASON;
      agent.healthCheckedAt = now;
      await agentRepo.save(agent);
      marked++;

      // Notify the project's main agent (PM) which worker went stale.
      const project = await projectRepo.findOne({
        where: { id: agent.projectId },
        select: ['id', 'mainAgentId'],
      });
      const mainAgentId = project?.mainAgentId;
      if (!mainAgentId || mainAgentId === agent.id) continue;

      const lastMs = agent.lastHeartbeatAt ? agent.lastHeartbeatAt.getTime() : now.getTime();
      const ageSeconds = Math.max(0, Math.round((now.getTime() - lastMs) / 1000));
      await createInboxItem({
        projectId: agent.projectId,
        recipientAgentId: mainAgentId,
        eventType: 'worker_stale',
        title: `Worker may be down: ${agent.name}`,
        body:
          `Worker "${agent.name}" (id: ${agent.id}) has not sent a heartbeat for ${ageSeconds}s ` +
          `(threshold ${Math.round(HEARTBEAT_STALE_MS / 1000)}s). It has been marked unhealthy and ` +
          `task dispatch is blocked until it resumes heartbeating and reports a healthy smoke test. ` +
          `Reassign any in-flight tasks: zz tasks reassign <task-id> --to <agent>.`,
        payload: {
          agent_id: agent.id,
          agent_name: agent.name,
          last_heartbeat_at: agent.lastHeartbeatAt ? agent.lastHeartbeatAt.toISOString() : null,
          heartbeat_age_seconds: ageSeconds,
          threshold_seconds: Math.round(HEARTBEAT_STALE_MS / 1000),
          reason: HEARTBEAT_STALE_REASON,
        },
      }).catch((err) => console.error('stale-heartbeat notify error:', err));
    }
    return { marked };
  }

  // ─── Detection Methods ────────────────────────────────────────────────────

  /**
   * Loop detection — same (or near-identical) assistant message repeated
   * LOOP_REPEAT_COUNT times within LOOP_WINDOW_MINUTES.
   */
  private async detectLoop(agentId: string): Promise<Incident | null> {
    const since = new Date(Date.now() - THRESHOLDS.LOOP_WINDOW_MINUTES * 60_000);

    const messages = await messageRepo.find({
      where: { agentId, role: MessageRole.AGENT, createdAt: MoreThanOrEqual(since) },
      order: { createdAt: 'DESC' },
      take: THRESHOLDS.LOOP_REPEAT_COUNT + 1,
    });

    if (messages.length < THRESHOLDS.LOOP_REPEAT_COUNT) return null;

    // Check if the most recent N messages are near-identical (normalized content)
    const contents = messages.slice(0, THRESHOLDS.LOOP_REPEAT_COUNT).map((m) =>
      m.content.trim().toLowerCase(),
    );

    const unique = new Set(contents);
    if (unique.size >= Math.ceil(THRESHOLDS.LOOP_REPEAT_COUNT * 0.75)) return null;

    // Deduplicate: don't create duplicate open incidents of the same type
    const existing = await this.findOpenIncident(agentId, 'loop');
    if (existing) return null;

    return this.createIncident(agentId, 'loop', 'warning',
      `Agent ${agentId} appears to be looping — ${THRESHOLDS.LOOP_REPEAT_COUNT} near-identical messages in the last ${THRESHOLDS.LOOP_WINDOW_MINUTES} minutes`,
      { repeat_count: contents.length, unique_count: unique.size, window_minutes: THRESHOLDS.LOOP_WINDOW_MINUTES },
    );
  }

  /**
   * Retry storm — many failed / error messages in a short window.
   */
  private async detectRetryStorm(agentId: string): Promise<Incident | null> {
    const since = new Date(Date.now() - THRESHOLDS.RETRY_WINDOW_MINUTES * 60_000);

    const errorCount = await messageRepo.count({
      where: {
        agentId,
        role: MessageRole.AGENT,
        createdAt: MoreThanOrEqual(since),
      },
    });

    // Heuristic: if more than RETRY_STORM_COUNT messages, likely retry storm
    // (In production, you'd filter by error-specific fields or content patterns)
    if (errorCount < THRESHOLDS.RETRY_STORM_COUNT) return null;

    const existing = await this.findOpenIncident(agentId, 'retry_storm');
    if (existing) return null;

    return this.createIncident(agentId, 'retry_storm', 'warning',
      `Agent ${agentId} possible retry storm — ${errorCount} messages in the last ${THRESHOLDS.RETRY_WINDOW_MINUTES} minutes`,
      { message_count: errorCount, window_minutes: THRESHOLDS.RETRY_WINDOW_MINUTES },
    );
  }

  /**
   * Token spike — a single message consuming an abnormally high number of tokens.
   */
  private async detectTokenSpike(agentId: string): Promise<Incident | null> {
    // Find recent messages with token counts (if stored in details/metadata)
    const recentMessages = await messageRepo.find({
      where: { agentId },
      order: { createdAt: 'DESC' },
      take: 5,
    });

    for (const msg of recentMessages) {
      // Tokens may be stored in message details or a separate field
      const tokenCount = (msg.details as any)?.token_count
        || (msg.details as any)?.tokens
        || 0;

      if (tokenCount > THRESHOLDS.TOKEN_SPIKE_LIMIT) {
        const existing = await this.findOpenIncident(agentId, 'token_spike');
        if (existing) return null;

        return this.createIncident(agentId, 'token_spike', 'critical',
          `Agent ${agentId} token spike — ${tokenCount} tokens in a single message (limit: ${THRESHOLDS.TOKEN_SPIKE_LIMIT})`,
          { token_count: tokenCount, message_id: msg.id, limit: THRESHOLDS.TOKEN_SPIKE_LIMIT },
        );
      }
    }

    return null;
  }

  /**
   * Latency drift — average response latency exceeds threshold.
   */
  private async detectLatencyDrift(agentId: string): Promise<Incident | null> {
    const since = new Date(Date.now() - THRESHOLDS.LATENCY_WINDOW_MINUTES * 60_000);

    const recentMessages = await messageRepo.find({
      where: { agentId, role: MessageRole.AGENT, createdAt: MoreThanOrEqual(since) },
      order: { createdAt: 'ASC' },
    });

    if (recentMessages.length < 3) return null;

    // Calculate inter-message latency from consecutive assistant messages
    const latencies: number[] = [];
    for (let i = 1; i < recentMessages.length; i++) {
      const delta = recentMessages[i].createdAt.getTime() - recentMessages[i - 1].createdAt.getTime();
      if (delta > 0) latencies.push(delta);
    }

    if (latencies.length === 0) return null;

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    if (avgLatency < THRESHOLDS.LATENCY_DRIFT_MS) return null;

    const existing = await this.findOpenIncident(agentId, 'latency_drift');
    if (existing) return null;

    return this.createIncident(agentId, 'latency_drift', 'warning',
      `Agent ${agentId} latency drift — avg ${Math.round(avgLatency)}ms between messages (threshold: ${THRESHOLDS.LATENCY_DRIFT_MS}ms)`,
      {
        avg_latency_ms: Math.round(avgLatency),
        sample_count: latencies.length,
        window_minutes: THRESHOLDS.LATENCY_WINDOW_MINUTES,
      },
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async findOpenIncident(agentId: string, type: AlertType): Promise<Incident | null> {
    return incidentRepo.findOne({
      where: { agentId, type, status: 'open' },
    });
  }

  private async createIncident(
    agentId: string,
    type: AlertType,
    severity: AlertSeverity,
    message: string,
    details: Record<string, unknown>,
  ): Promise<Incident> {
    const incident = incidentRepo.create({
      agentId,
      type,
      severity,
      status: 'open',
      message,
      details,
    });
    return incidentRepo.save(incident);
  }
}

// Singleton export
export const healthMonitorService = new HealthMonitorService();

// ─── Stale-heartbeat sweep timer (R15a) ──────────────────────────────────────

let heartbeatSweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic stale-heartbeat sweep (idempotent). */
export function startStaleHeartbeatSweep(): void {
  if (heartbeatSweepTimer) return;
  heartbeatSweepTimer = setInterval(() => {
    healthMonitorService
      .sweepStaleHeartbeats()
      .catch((err) => console.error('stale-heartbeat sweep error:', err));
  }, HEARTBEAT_STALE_SWEEP_MS);
  heartbeatSweepTimer.unref();
}

/** Stop the sweep (tests). */
export function stopStaleHeartbeatSweep(): void {
  if (heartbeatSweepTimer) {
    clearInterval(heartbeatSweepTimer);
    heartbeatSweepTimer = null;
  }
}
