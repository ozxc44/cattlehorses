import 'reflect-metadata';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import authRoutes from './routes/auth.routes';
import projectsRoutes from './routes/projects.routes';
import agentsRoutes from './routes/agents.routes';
import sessionsRoutes from './routes/sessions.routes';
import projectSpaceRoutes from './routes/project-space.routes';
import projectSpaceFrozenRoutes from './routes/project-space-frozen.routes';
import orchestrationsRoutes from './routes/orchestrations.routes';
import versioningRoutes from './routes/versioning.routes';
import gatesRoutes from './routes/gates.routes';
import eventsRoutes from './routes/events.routes';
import healthRoutes from './routes/health.routes';
import incidentsRoutes from './routes/incidents.routes';
import mcpRoutes from './routes/mcp.routes';
import debugRoutes from './routes/debug.routes';
import usersRoutes from './routes/users.routes';
import agentInboxRoutes from './routes/agent-inbox.routes';
import collaborationRequestsRoutes from './routes/collaboration-requests.routes';
import wikiRoutes from './routes/wiki.routes';
import projectReleasesRoutes from './routes/project-releases.routes';
import projectPackagesRoutes from './routes/project-packages.routes';
import projectSecurityRoutes from './routes/project-security.routes';
import notificationMetricsRoutes from './routes/notification-metrics.routes';
import rewardPreviewRoutes from './routes/reward-preview.routes';
import workSavedQueriesRoutes from './routes/work-saved-queries.routes';
import auditLogRoutes from './routes/audit-log.routes';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { log as logger, requestLog } from './services/logger';

const app = express();
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX || '300', 10);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function allowedOrigins(): string[] {
  const configured = process.env.CORS_ORIGINS;
  if (configured) {
    return configured.split(',').map((origin) => origin.trim()).filter(Boolean);
  }
  return [
    'http://127.0.0.1:18080',
    'http://localhost:18080',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.1:8000',
    'http://localhost:8000',
  ];
}

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.method}:${req.path}`;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > rateLimitMax) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    res.status(429).json({ detail: 'Too many requests' });
    return;
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, rateLimitWindowMs).unref();

// Start the task-staleness sweep: marks dispatched/running tasks that exceed
// TASK_STALE_MINUTES without progress and notifies their orchestration's main
// agent so it can reassign. Notifies only — never auto-cancels.
import { startTaskStalenessSweep } from './services/task-staleness-sweep.service';
startTaskStalenessSweep();

// R15a: start the stale-heartbeat sweep. Marks workers whose heartbeat is older
// than the online TTL (default 90s) unhealthy so the R10b dispatch guard blocks
// them, and notifies each project's main agent (PM). Idempotent + unref'd.
import { startStaleHeartbeatSweep } from './services/health-monitor.service';
startStaleHeartbeatSweep();

import { startChangesetStalenessPing } from './services/changeset-staleness-ping.service';
startChangesetStalenessPing();

// ─── Middleware ──────────────────────────────────────────────────────────────

app.disable('x-powered-by');
app.set('trust proxy', 1);

// ─── Request-ID Middleware ─────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = uuidv4();
  (req as any).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

// ─── Access Log ────────────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    requestLog(req, res.statusCode, Date.now() - start);
  });
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // API responses are dynamic (agent lists, join-request status, inbox, heartbeat).
  // Never let browsers/proxies serve a stale copy: forbid caching entirely and drop
  // the default ETag so conditional GETs can't 304 to outdated data. Without this,
  // a newly-approved member's agent wouldn't appear in the dashboard until a hard
  // reload, because the browser served the prior list from its cache / 304'd.
  if (req.path.startsWith('/v1/') || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.removeHeader('ETag');
  }
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins().includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS origin not allowed'));
  },
}));
app.use(rateLimit);
app.use(express.json({ limit: '10mb' }));

// ─── Swagger UI / API Docs ────────────────────────────────────────────────────

const openapiSpec = YAML.load('../openapi-v2.yaml');
const publicBasePath = (() => {
  try {
    const configured = process.env.PUBLIC_BASE_URL;
    if (!configured) return '';
    const pathname = new URL(configured).pathname.replace(/\/+$/, '');
    return pathname === '/' ? '' : pathname;
  } catch {
    return '';
  }
})();

function resolvePublicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = req.headers['host'] || req.hostname;
  const prefix = (req.headers['x-forwarded-prefix'] as string) || publicBasePath || '';
  return `${proto}://${host}${prefix}`.replace(/\/+$/, '');
}

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'ZZ Agent Platform API Docs',
  swaggerUrl: `${publicBasePath}/api/openapi.json`,
}));

app.get('/api/openapi.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(openapiSpec);
});

// ─── Routes ─────────────────────────────────────────────────────────────────

// Serve executor.py and install.sh for agent bootstrap (public, no auth).
// Read from multiple possible locations (dev repo, container, standalone).
import fs from 'fs';
function findCliFile(filename: string): string | null {
  const candidates = [
    path.resolve(__dirname, '../../cli', filename),
    path.resolve(__dirname, '../../../cli', filename),
    '/app/cli/' + filename,
    path.resolve(__dirname, '../cli', filename),
    path.resolve(process.cwd(), 'cli', filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
app.get('/v1/agent/bootstrap/executor.py', (_req, res) => {
  // executor.py is in cli/zz_cli/
  const candidates = [
    path.resolve(__dirname, '../../cli/zz_cli/executor.py'),
    path.resolve(__dirname, '../../../cli/zz_cli/executor.py'),
    '/app/cli/zz_cli/executor.py',
    path.resolve(process.cwd(), 'cli/zz_cli/executor.py'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) { res.setHeader('Content-Type', 'text/x-python'); res.sendFile(f); return; }
  }
  res.status(404).json({ detail: 'executor.py not found. Tried: ' + candidates.join(', ') });
});
// SHA256 of the served executor.py — used by the executor's self-update loop.
// Agents poll this cheaply each cycle; if the hash changes they re-download.
app.get('/v1/agent/bootstrap/executor.py.sha256', (_req, res) => {
  const candidates = [
    path.resolve(__dirname, '../../cli/zz_cli/executor.py'),
    path.resolve(__dirname, '../../../cli/zz_cli/executor.py'),
    '/app/cli/zz_cli/executor.py',
    path.resolve(process.cwd(), 'cli/zz_cli/executor.py'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      try {
        const crypto = require('crypto');
        const data = fs.readFileSync(f);
        const sha = crypto.createHash('sha256').update(data).digest('hex');
        res.setHeader('Content-Type', 'text/plain');
        res.send(sha);
        return;
      } catch (e) {
        res.status(500).json({ detail: 'hash failed' });
        return;
      }
    }
  }
  res.status(404).json({ detail: 'executor.py not found' });
});
// Serve invoke_server.py — the HTTP endpoint an agent exposes so the platform
// can POST invokes to it (runtime.v1). This is the agent's "brain endpoint".
app.get('/v1/agent/bootstrap/invoke-server.py', (_req, res) => {
  const candidates = [
    path.resolve(__dirname, '../../cli/zz_cli/invoke_server.py'),
    path.resolve(__dirname, '../../../cli/zz_cli/invoke_server.py'),
    '/app/cli/zz_cli/invoke_server.py',
    path.resolve(process.cwd(), 'cli/zz_cli/invoke_server.py'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) { res.setHeader('Content-Type', 'text/x-python'); res.sendFile(f); return; }
  }
  res.status(404).json({ detail: 'invoke_server.py not found' });
});

// SHA256 of invoke_server.py (for the agent to verify its download).
app.get('/v1/agent/bootstrap/invoke-server.py.sha256', (_req, res) => {
  const candidates = [
    path.resolve(__dirname, '../../cli/zz_cli/invoke_server.py'),
    path.resolve(__dirname, '../../../cli/zz_cli/invoke_server.py'),
    '/app/cli/zz_cli/invoke_server.py',
    path.resolve(process.cwd(), 'cli/zz_cli/invoke_server.py'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      try {
        const crypto = require('crypto');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        res.setHeader('Content-Type', 'text/plain');
        res.send(sha);
        return;
      } catch (e) {
        res.status(500).json({ detail: 'hash failed' });
        return;
      }
    }
  }
  res.status(404).json({ detail: 'invoke_server.py not found' });
});
// Serve invoke_handler.py — the standard brain handler. Agents adapt this
// instead of writing their own (which is how mimo/kimi got their handlers wrong).
app.get('/v1/agent/bootstrap/invoke-handler.py', (_req, res) => {
  const candidates = [
    path.resolve(__dirname, '../../cli/zz_cli/invoke_handler.py'),
    path.resolve(__dirname, '../../../cli/zz_cli/invoke_handler.py'),
    '/app/cli/zz_cli/invoke_handler.py',
    path.resolve(process.cwd(), 'cli/zz_cli/invoke_handler.py'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) { res.setHeader('Content-Type', 'text/x-python'); res.sendFile(f); return; }
  }
  res.status(404).json({ detail: 'invoke_handler.py not found' });
});

// SHA256 of invoke_handler.py.
app.get('/v1/agent/bootstrap/invoke-handler.py.sha256', (_req, res) => {
  const candidates = [
    path.resolve(__dirname, '../../cli/zz_cli/invoke_handler.py'),
    path.resolve(__dirname, '../../../cli/zz_cli/invoke_handler.py'),
    '/app/cli/zz_cli/invoke_handler.py',
    path.resolve(process.cwd(), 'cli/zz_cli/invoke_handler.py'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      try {
        const crypto = require('crypto');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        res.setHeader('Content-Type', 'text/plain');
        res.send(sha);
        return;
      } catch (e) {
        res.status(500).json({ detail: 'hash failed' });
        return;
      }
    }
  }
  res.status(404).json({ detail: 'invoke_handler.py not found' });
});
// Serve runtime.py — the unified local-model runtime. One process per host
// serves ALL agents, routes by agent_id to the right local model (kimi/mimo/
// codex/deepseek-API/...), on-demand instantiation, warm cache, autostart.
app.get('/v1/agent/bootstrap/runtime.py', (_req, res) => {
  const candidates = [
    path.resolve(__dirname, '../../cli/zz_cli/runtime.py'),
    path.resolve(__dirname, '../../../cli/zz_cli/runtime.py'),
    '/app/cli/zz_cli/runtime.py',
    path.resolve(process.cwd(), 'cli/zz_cli/runtime.py'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) { res.setHeader('Content-Type', 'text/x-python'); res.sendFile(f); return; }
  }
  res.status(404).json({ detail: 'runtime.py not found' });
});

// Sample agents.json — the routing table mapping agent_id -> model backend.
// Agents copy this and edit per their host's installed models.
app.get('/v1/agent/bootstrap/agents.example.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({
    agents: {
      'kimi-agent': {
        secret: 'REPLACE_WITH_YOUR_SECRET',
        backend: 'cli:kimi',
        comment: 'uses kimi -p (path auto-detected)',
      },
      'mimocode-agent': {
        secret: 'REPLACE_WITH_YOUR_SECRET',
        backend: 'cli:mimo',
      },
      'codex-agent': {
        secret: 'REPLACE_WITH_YOUR_SECRET',
        backend: 'cli:codex',
      },
      'deepseek-worker': {
        secret: 'REPLACE_WITH_YOUR_SECRET',
        backend: 'api',
        api_base: 'https://api.deepseek.com',
        api_key: 'REPLACE_WITH_DEEPSEEK_KEY',
        model: 'deepseek-chat',
        comment: 'OpenAI-compatible API: deepseek, moonshot, GLM, OpenAI, ...',
      },
      'echo-agent': {
        secret: 'REPLACE_WITH_YOUR_SECRET',
        backend: 'echo',
        comment: 'test mode, no model — confirms routing works',
      },
    },
  }, null, 2));
});

// SHA256 of runtime.py.
app.get('/v1/agent/bootstrap/runtime.py.sha256', (_req, res) => {
  const candidates = [
    path.resolve(__dirname, '../../cli/zz_cli/runtime.py'),
    path.resolve(__dirname, '../../../cli/zz_cli/runtime.py'),
    '/app/cli/zz_cli/runtime.py',
    path.resolve(process.cwd(), 'cli/zz_cli/runtime.py'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      try {
        const crypto = require('crypto');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        res.setHeader('Content-Type', 'text/plain');
        res.send(sha);
        return;
      } catch (e) {
        res.status(500).json({ detail: 'hash failed' });
        return;
      }
    }
  }
  res.status(404).json({ detail: 'runtime.py not found' });
});
app.get('/v1/agent/bootstrap/install.sh', (_req, res) => {
  const f = findCliFile('install.sh');
  if (f) { res.setHeader('Content-Type', 'text/x-shellscript'); res.sendFile(f); }
  else { res.status(404).json({ detail: 'install.sh not found' }); }
});
// One-shot upgrade script for OLD agents still running a stale executor.py
// without the self-update loop. Downloads the latest executor.py, verifies its
// SHA against the platform, and relaunches it in place. After this one run, the
// agent has the self-update loop and never needs poking again.
app.get('/v1/agent/bootstrap/upgrade.sh', (req, res) => {
  const base = resolvePublicBaseUrl(req);
  const script = `#!/usr/bin/env bash
# One-shot executor.py upgrade. Replaces the running daemon with the latest
# version, verified by SHA256. Safe to run repeatedly.
set -e
BASE="\${ZZ_BASE_URL:-${base}}"
KEY="\${ZZ_AGENT_KEY:-}"
if [ -z "\$KEY" ]; then echo "Set ZZ_AGENT_KEY first"; exit 1; fi
DEST="\${ZZ_EXECUTOR_PATH:-$(pwd)/executor.py}"
echo "Upgrading executor.py from \$BASE"
echo "  -> \$DEST"
# Download new version + its expected SHA
curl -fsSL "\$BASE/v1/agent/bootstrap/executor.py" -o "\$DEST.new"
EXPECTED=$(curl -fsSL "\$BASE/v1/agent/bootstrap/executor.py.sha256")
GOT=$(shasum -a 256 "\$DEST.new" | cut -d' ' -f1)
if [ "\$EXPECTED" != "\$GOT" ]; then
  echo "SHA mismatch: expected \$EXPECTED got \$GOT — refusing to install"
  rm -f "\$DEST.new"; exit 1
fi
echo "SHA verified: \$GOT"
chmod +x "\$DEST.new"
mv -f "\$DEST.new" "\$DEST"
# Restart any running executor (best effort). From now on it self-updates.
if [ -n "\${ZZ_RESTART_CMD:-}" ]; then
  echo "Restarting via ZZ_RESTART_CMD..."
  eval "\$ZZ_RESTART_CMD"
else
  echo "Installed. (Re)launch with: ZZ_AGENT_KEY=<key> python3 \$DEST --base-url \$BASE"
fi
echo "Done."
`;
  res.setHeader('Content-Type', 'text/x-shellscript');
  res.send(script);
});

app.use(authRoutes);
app.use(projectsRoutes);
app.use(agentsRoutes);
app.use(sessionsRoutes);
app.use(projectSpaceRoutes);
app.use(projectSpaceFrozenRoutes);
app.use(orchestrationsRoutes);
app.use(versioningRoutes);
app.use(gatesRoutes);
app.use(eventsRoutes);
app.use(healthRoutes);
app.use(incidentsRoutes);
app.use(mcpRoutes);
app.use(debugRoutes);
app.use(usersRoutes);
app.use(agentInboxRoutes);
app.use(collaborationRequestsRoutes);
app.use(wikiRoutes);
app.use(projectReleasesRoutes);
app.use(projectPackagesRoutes);
app.use(projectSecurityRoutes);
app.use(notificationMetricsRoutes);
app.use(rewardPreviewRoutes);
app.use(workSavedQueriesRoutes);
app.use(auditLogRoutes);

// ─── Static dashboard (local E2E convenience) ────────────────────────────────
// When SERVE_DASHBOARD=1, serve the dashboard/ directory at / so that
// Playwright E2E tests can hit the same origin as the API.
if (process.env.SERVE_DASHBOARD === '1') {
  const dashboardDir = path.resolve(__dirname, '..', '..', '..', 'dashboard');
  app.use(express.static(dashboardDir));
}

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ detail: 'Not found' });
});

// ─── Error Handler ───────────────────────────────────────────────────────────
// Catches errors thrown or passed via next(err)

app.use((err: Error & { statusCode?: number }, req: Request, res: Response, _next: NextFunction) => {
  const requestId = (req as any).requestId;
  logger.error('Unhandled error', {
    request_id: requestId,
    method: req.method,
    path: req.path,
    err: err.message,
    status: err.statusCode || 500,
  });
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    detail: err.message || 'Internal server error',
    status: statusCode,
    request_id: requestId,
  });
});

export default app;
