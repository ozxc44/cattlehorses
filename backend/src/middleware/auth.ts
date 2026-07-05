import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';

export interface AuthPayload {
  userId: string;
  iat?: number;
  exp?: number;
}

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';

/**
 * Authenticate middleware — extracts and verifies JWT from Authorization header.
 * Expects: `Authorization: Bearer <token>`
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ detail: 'Missing Authorization header' });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.status(401).json({ detail: 'Authorization header must be: Bearer <token>' });
    return;
  }

  const token = parts[1];

  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ detail: 'Token expired' });
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ detail: 'Invalid token' });
      return;
    }
    res.status(500).json({ detail: 'Authentication error' });
  }
}

/**
 * Extract project_id from URL params and attach to request for downstream middleware.
 * Supports both `/v1/projects/{project_id}/...` and `/v1/projects/{pid}` param naming.
 */
export function extractProjectId(req: Request, _res: Response, next: NextFunction): void {
  const projectId = req.params.project_id || req.params.pid;
  if (projectId) {
    (req as any).projectId = projectId;
  }
  next();
}

// Extend Express Request for agent API key auth
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      agent?: { id: string; projectId: string; name: string };
    }
  }
}

/**
 * Authenticate via JWT or agent API key.
 * Tries JWT first (Bearer non-zzk_ token), then falls back to agent API key.
 * Sets req.user (JWT) or req.agent (API key).
 */
export async function authenticateJwtOrAgentApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

  // Try JWT first for non-API-key Bearer tokens
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (!token.startsWith('zzk_')) {
      try {
        const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
        req.user = payload;
        next();
        return;
      } catch (err) {
        if (!apiKeyHeader) {
          if (err instanceof jwt.TokenExpiredError) {
            res.status(401).json({ detail: 'Token expired' });
            return;
          }
          res.status(401).json({ detail: 'Invalid token' });
          return;
        }
        // Fall through only when an explicit X-API-Key was also supplied.
      }
    }
  }

  // Fall through to agent API key auth
  if (apiKeyHeader || authHeader?.startsWith('Bearer ')) {
    await authenticateAgentApiKey(req, res, next);
    return;
  }

  res.status(401).json({ detail: 'Missing Authorization header or X-API-Key' });
}

/**
 * Verify a JWT access token. Returns the decoded payload, or null when the
 * token is malformed, expired, or signed with the wrong secret.
 *
 * Shared by the Express auth middleware and the WebSocket handshake (which
 * cannot go through Express middleware because the upgrade event bypasses it).
 */
export function verifyAccessToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthPayload;
  } catch {
    return null;
  }
}

/**
 * Resolve an agent API key (`zzk_…`) to its owning agent.
 *
 * Shared by the Express API-key middleware and the WebSocket handshake so the
 * prefix-scoped bcrypt lookup lives in exactly one place. Returns the agent
 * identity, or null when the key is unknown / malformed / revoked.
 *
 * NOTE: this does not touch the agent's heartbeat. Callers that represent a
 * live agent request (the HTTP middleware) bump `lastHeartbeatAt` themselves;
 * transport-only callers (the WS handshake) must not, since opening a socket
 * is not agent activity.
 */
export async function resolveAgentByApiKey(
  apiKey: string,
): Promise<{ id: string; projectId: string; name: string } | null> {
  if (!apiKey || !apiKey.startsWith('zzk_') || apiKey.length < 20) {
    return null;
  }

  const bcrypt = await import('bcryptjs');
  const { AppDataSource } = await import('../data-source');
  const { Agent, AgentStatus, AgentLifecycleStatus } = await import('../entities/agent.entity');
  const { Not, IsNull, In } = await import('typeorm');
  const agentRepo = AppDataSource.getRepository(Agent);
  const apiKeyPrefix = apiKey.substring(0, 8);

  // Primary path: query only prefix-matching, non-revoked, active agents.
  // This avoids loading all agents and eliminates bcrypt work against
  // unrelated prefix rows.
  let candidates = await agentRepo.find({
    where: {
      apiKeyPrefix,
      apiKeyHash: Not(IsNull()),
      status: Not(AgentStatus.INACTIVE),
      lifecycleStatus: Not(In([AgentLifecycleStatus.RETIRED, AgentLifecycleStatus.SUPERSEDED])),
    },
    select: ['id', 'projectId', 'name', 'apiKeyHash'],
  });

  let matched: InstanceType<typeof Agent> | null = null;

  for (const agent of candidates) {
    if (!agent.apiKeyHash) continue;
    if (await bcrypt.compare(apiKey, agent.apiKeyHash)) {
      matched = agent;
      break;
    }
  }

  // Legacy fallback: only when primary finds no match, check rows that
  // predate the dedicated api_key_prefix column (apiKeyPrefix IS NULL).
  // These still use configJson.api_key_prefix for prefix matching.
  if (!matched) {
    const legacyCandidates = await agentRepo.find({
      where: {
        apiKeyPrefix: IsNull(),
        apiKeyHash: Not(IsNull()),
        status: Not(AgentStatus.INACTIVE),
        lifecycleStatus: Not(In([AgentLifecycleStatus.RETIRED, AgentLifecycleStatus.SUPERSEDED])),
      },
      select: ['id', 'projectId', 'name', 'apiKeyHash', 'configJson'],
    });

    for (const agent of legacyCandidates) {
      if (!agent.apiKeyHash) continue;
      const config = (agent as any).configJson || {};
      const storedPrefix = typeof config.api_key_prefix === 'string' ? config.api_key_prefix : null;
      if (storedPrefix && storedPrefix !== apiKeyPrefix) {
        continue;
      }
      if (await bcrypt.compare(apiKey, agent.apiKeyHash)) {
        matched = agent;
        break;
      }
    }
  }

  if (!matched) {
    return null;
  }

  return { id: matched.id, projectId: matched.projectId, name: matched.name };
}

/**
 * Authenticate agent via API key.
 * Accepts `Authorization: Bearer zzk_xxx` or `X-API-Key: zzk_xxx`.
 * Verifies the key against stored bcrypt hash, sets req.agent.
 */
export async function authenticateAgentApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  let apiKey = req.headers['x-api-key'] as string | undefined;

  if (!apiKey) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      apiKey = authHeader.slice(7);
    }
  }

  if (!apiKey) {
    res.status(401).json({ detail: 'Missing API key. Provide X-API-Key header or Authorization: Bearer <key>' });
    return;
  }

  try {
    const matched = await resolveAgentByApiKey(apiKey);
    if (!matched) {
      res.status(401).json({ detail: 'Invalid API key' });
      return;
    }

    req.agent = { id: matched.id, projectId: matched.projectId, name: matched.name };

    // Update last heartbeat — this route represents live agent activity.
    const { AppDataSource } = await import('../data-source');
    const { Agent } = await import('../entities/agent.entity');
    await AppDataSource.getRepository(Agent).update(matched.id, { lastHeartbeatAt: new Date() });

    next();
  } catch (err) {
    console.error('Agent API key auth error:', err);
    res.status(500).json({ detail: 'Authentication error' });
  }
}
