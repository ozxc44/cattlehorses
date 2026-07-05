import dotenv from 'dotenv';
dotenv.config();

import 'reflect-metadata';
import http from 'http';
import app from './app';
import { initializeDatabase } from './data-source';
import { healthMonitorService } from './services/health-monitor.service';
import { alertRoutingService } from './services/alert-routing.service';
import { AppDataSource } from './data-source';
import { Agent } from './entities/agent.entity';
import { getAgentPresence } from './services/agent-presence.service';
import { log as logger } from './services/logger';
import { attachRealtimeWebSocket } from './routes/realtime.routes';

const PORT = parseInt(process.env.PORT || '3000', 10);
const DEV_JWT_SECRET = 'dev-jwt-secret-change-in-production';
const DEV_WEBHOOK_SECRET = 'dev-webhook-secret';

/** How often to run automated health checks (in ms). Default: 5 minutes. */
const HEALTH_CHECK_INTERVAL_MS = parseInt(
  process.env.HEALTH_CHECK_INTERVAL_MINUTES || '5',
  10,
) * 60_000;

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

function assertProductionSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret || jwtSecret === DEV_JWT_SECRET || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set to a non-default value of at least 32 characters in production.');
  }

  const webhookSecret = process.env.WEBHOOK_SECRET || '';
  if (webhookSecret === DEV_WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET must not use the development default in production.');
  }
}

async function runHealthChecks(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    logger.debug('HealthMonitor skipped — DB not initialized');
    return;
  }

  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agents = await agentRepo.find();

    if (agents.length === 0) {
      logger.debug('HealthMonitor skipped — no agents registered');
      return;
    }

    const presenceCounts = agents.reduce(
      (counts, agent) => {
        counts[getAgentPresence(agent).presence]++;
        return counts;
      },
      { online: 0, stale: 0, offline: 0 },
    );

    logger.info('HealthMonitor cycle starting', { agent_count: agents.length, ...presenceCounts });

    let newIncidentCount = 0;
    for (const agent of agents) {
      try {
        const incidents = await healthMonitorService.checkAgent(agent.id);
        for (const incident of incidents) {
          await alertRoutingService.route(incident);
          newIncidentCount++;
        }
      } catch (err) {
        logger.error('HealthMonitor agent check error', { agent_id: agent.id, err: String(err) });
      }
    }

    if (newIncidentCount > 0) {
      logger.info('HealthMonitor created incidents', { count: newIncidentCount });
    } else {
      logger.info('HealthMonitor — no new incidents', { agent_count: agents.length, ...presenceCounts });
    }
  } catch (err) {
    logger.error('HealthMonitor cycle failed', { err: String(err) });
  }
}

async function main() {
  assertProductionSecrets();

  try {
    // Initialize database connection
    await initializeDatabase();
    logger.info('Database connected successfully');
  } catch (err) {
    logger.error('Database connection failed', { err: String(err) });
  }

  const server = http.createServer(app);

  // Attach the /ws/loop real-time WebSocket endpoint (snapshot + delta push).
  attachRealtimeWebSocket(server);

  server.listen(PORT, () => {
    logger.info('Server started', { port: PORT, health: `http://localhost:${PORT}/v1/health` });
  });

  // ─── Scheduled Health Checks ─────────────────────────────────────────────
  // Start periodic health monitoring after a brief delay (let the server warm up).
  if (AppDataSource.isInitialized) {
    // Run first check after 30 seconds, then every HEALTH_CHECK_INTERVAL_MS
    healthCheckTimer = setTimeout(() => {
      runHealthChecks();
      healthCheckTimer = setInterval(runHealthChecks, HEALTH_CHECK_INTERVAL_MS);
    }, 30_000);
  } else {
    logger.warn('HealthMonitor disabled — database not connected');
  }

  // ─── Graceful Shutdown ────────────────────────────────────────────────────

  const shutdown = async (signal: string) => {
    logger.info('Shutdown requested', { signal });

    // Stop health check timer
    if (healthCheckTimer) {
      clearTimeout(healthCheckTimer);
      clearInterval(healthCheckTimer);
      logger.info('Health check timer stopped');
    }

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Server startup failed', { err: String(err) });
  process.exit(1);
});
