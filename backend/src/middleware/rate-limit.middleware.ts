import { Request, Response, NextFunction } from 'express';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

interface RateLimitConfig {
  tokensPerInterval: number;
  intervalMs: number;
  burst: number;
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function getConfig(route: string): RateLimitConfig {
  if (route === 'heartbeat') {
    return {
      tokensPerInterval: envFloat('RATE_LIMIT_HEARTBEAT_PER_S', 0.1),
      intervalMs: 10_000,
      burst: Math.round(envFloat('RATE_LIMIT_HEARTBEAT_BURST', 3)),
    };
  }
  if (route === 'changesets') {
    return {
      tokensPerInterval: envFloat('RATE_LIMIT_CHANGESETS_PER_MIN', 10),
      intervalMs: 60_000,
      burst: Math.round(envFloat('RATE_LIMIT_CHANGESETS_BURST', 10)),
    };
  }
  if (route === 'tasks') {
    return {
      tokensPerInterval: envFloat('RATE_LIMIT_TASKS_PER_MIN', 20),
      intervalMs: 60_000,
      burst: Math.round(envFloat('RATE_LIMIT_TASKS_BURST', 20)),
    };
  }
  return { tokensPerInterval: 1, intervalMs: 60_000, burst: 1 };
}

function extractAgentId(req: Request): string {
  if (req.agent?.id) return req.agent.id;
  if (req.user?.userId) return req.user.userId;
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function consumeToken(key: string, config: RateLimitConfig): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: config.burst, lastRefill: now };
    buckets.set(key, bucket);
  }

  const elapsed = now - bucket.lastRefill;
  const refillRate = config.tokensPerInterval / config.intervalMs;
  bucket.tokens = Math.min(config.burst, bucket.tokens + elapsed * refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  const deficitMs = (1 - bucket.tokens) / refillRate;
  return { allowed: false, retryAfterMs: deficitMs };
}

export function rateLimitHeartbeat(req: Request, res: Response, next: NextFunction): void {
  const agentId = extractAgentId(req);
  const key = `${agentId}:heartbeat`;
  const config = getConfig('heartbeat');
  const { allowed, retryAfterMs } = consumeToken(key, config);

  if (!allowed) {
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    res.status(429).json({ detail: 'Rate limit exceeded' });
    return;
  }
  next();
}

export function rateLimitChangesets(req: Request, res: Response, next: NextFunction): void {
  const agentId = extractAgentId(req);
  const key = `${agentId}:changesets`;
  const config = getConfig('changesets');
  const { allowed, retryAfterMs } = consumeToken(key, config);

  if (!allowed) {
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    res.status(429).json({ detail: 'Rate limit exceeded' });
    return;
  }
  next();
}

export function rateLimitTasks(req: Request, res: Response, next: NextFunction): void {
  const agentId = extractAgentId(req);
  const key = `${agentId}:tasks`;
  const config = getConfig('tasks');
  const { allowed, retryAfterMs } = consumeToken(key, config);

  if (!allowed) {
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    res.status(429).json({ detail: 'Rate limit exceeded' });
    return;
  }
  next();
}

export function _clearBuckets(): void {
  buckets.clear();
}
