import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, extractProjectId, authenticateAgentApiKey, authenticateJwtOrAgentApiKey } from '../middleware/auth';
import { requirePermission, requireAgentOwnerOrPermission, Permission } from '../middleware/rbac';
import { rateLimitHeartbeat } from '../middleware/rate-limit.middleware';
import { AppDataSource } from '../data-source';
import { Agent, AgentStatus, AgentLifecycleStatus, AgentSmokeHealth } from '../entities/agent.entity';
import { AgentHeartbeatLog } from '../entities/agent-heartbeat-log.entity';
import { ProjectMember, ProjectRole } from '../entities/project-member.entity';
import { Session, SessionStatus } from '../entities/session.entity';
import { SessionParticipant } from '../entities/session-participant.entity';
import { Message, MessageRole } from '../entities/message.entity';
import { Incident } from '../entities/incident.entity';
import { ProjectOrchestrationTask, ProjectOrchestrationTaskStatus } from '../entities/project-orchestration-task.entity';
import { ProjectChangeset, ProjectChangesetStatus } from '../entities/project-changeset.entity';
import { eventStreamService } from '../services/event-stream.service';
import { eventRepository } from '../services/event-repository.service';
import { healthMonitorService } from '../services/health-monitor.service';
import { getAgentPresence } from '../services/agent-presence.service';
import { getPendingInboxCount } from './agent-inbox.routes';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

const router = Router();
const agentRepo = AppDataSource.getRepository(Agent);
const heartbeatLogRepo = AppDataSource.getRepository(AgentHeartbeatLog);
const sessionRepo = AppDataSource.getRepository(Session);
const participantRepo = AppDataSource.getRepository(SessionParticipant);
const messageRepo = AppDataSource.getRepository(Message);
const incidentRepo = AppDataSource.getRepository(Incident);
const projectMemberRepo = AppDataSource.getRepository(ProjectMember);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';

type AgentConfig = {
  system_prompt?: unknown;
  endpoint_url?: unknown;
  invoke_secret?: unknown;
  api_key_prefix?: unknown;
  scopes?: unknown;
};

type HealthMetricPayload = {
  name?: unknown;
  metric?: unknown;
  value?: unknown;
  unit?: unknown;
  tags?: unknown;
  metadata?: unknown;
  details?: unknown;
  session_id?: unknown;
  run_id?: unknown;
  status?: unknown;
  recorded_at?: unknown;
};

function agentConfig(agent: Agent): AgentConfig {
  return (agent.configJson || {}) as AgentConfig;
}

function serializeAgent(agent: Agent, apiKey?: string) {
  const config = agentConfig(agent);
  const presence = getAgentPresence(agent);
  const identityCode = agent.identityCode ?? agent.apiKeyPrefix ?? null;
  const displayLabel = identityCode
    ? `${agent.name} [${identityCode}]`
    : agent.name;
  const response: Record<string, unknown> = {
    id: agent.id,
    project_id: agent.projectId,
    name: agent.name,
    identity_code: identityCode,
    display_label: displayLabel,
    lifecycle_status: agent.lifecycleStatus ?? AgentLifecycleStatus.ACTIVE,
    owner_user_id: agent.ownerUserId ?? null,
    superseded_by_agent_id: agent.supersededByAgentId ?? null,
    retired_at: agent.retiredAt ?? null,
    description: agent.description ?? null,
    system_prompt: typeof config.system_prompt === 'string' ? config.system_prompt : '',
    endpoint_url: typeof config.endpoint_url === 'string' ? config.endpoint_url : null,
    capabilities: normalizeCapabilities(agent.capabilities),
    status: agent.status,
    presence: presence.presence,
    health_status: presence.healthStatus,
    is_online: presence.isOnline,
    dispatchable: presence.dispatchable,
    last_heartbeat_at: presence.lastHeartbeatAt,
    heartbeat_age_ms: presence.heartbeatAgeMs,
    api_key_prefix:
      agent.apiKeyPrefix
      ?? (typeof config.api_key_prefix === 'string' ? config.api_key_prefix : null)
      ?? (agent.apiKeyHash ? agent.apiKeyHash.substring(0, 8) : null),
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };

  if (apiKey) {
    response.api_key = apiKey;
  }

  return response;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0))]
    .slice(0, 50);
}

function v1StatusFromHealth(status: unknown): AgentStatus {
  switch (status) {
    case 'healthy':
      return AgentStatus.ACTIVE;
    case 'degraded':
      return AgentStatus.ERROR;
    case 'down':
      return AgentStatus.INACTIVE;
    case 'idle':
      return AgentStatus.IDLE;
    case 'active':
    case 'running':
      return AgentStatus.ACTIVE;
    case 'error':
      return AgentStatus.ERROR;
    case 'inactive':
    case 'offline':
      return AgentStatus.INACTIVE;
    default:
      return AgentStatus.ACTIVE;
  }
}

/**
 * R10b: record the worker's last self-reported smoke-test health onto the agent
 * record. Workers send an optional `health` object in their heartbeat / health
 * report:
 *   { status: 'healthy' | 'unhealthy', error?: string, checked_at?: ISO string }
 * When the field is absent (legacy worker) the columns are left untouched so
 * dispatch remains allowed. Returns true when the health columns changed.
 */
function applySmokeHealth(agent: Agent, body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const health = (body as Record<string, unknown>).health;
  if (!health || typeof health !== 'object') return false;
  const status = (health as Record<string, unknown>).status;
  if (status !== AgentSmokeHealth.HEALTHY && status !== AgentSmokeHealth.UNHEALTHY) return false;

  const errorRaw = (health as Record<string, unknown>).error;
  const checkedAtRaw = (health as Record<string, unknown>).checked_at;
  const checkedAt =
    typeof checkedAtRaw === 'string' && !Number.isNaN(Date.parse(checkedAtRaw))
      ? new Date(checkedAtRaw)
      : new Date();

  agent.healthStatus = status;
  agent.healthLastError = typeof errorRaw === 'string' && errorRaw.trim().length > 0 ? errorRaw.trim() : null;
  agent.healthCheckedAt = checkedAt;
  return true;
}

function metricsArray(metricsJson: Record<string, unknown> | undefined): unknown[] {
  if (!metricsJson) return [];
  if (Array.isArray(metricsJson.metrics)) return metricsJson.metrics;
  return Object.entries(metricsJson)
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
    .map(([name, value]) => ({ name, value }));
}

function healthSnapshot(agent: Agent) {
  const presence = getAgentPresence(agent);
  return {
    project_id: agent.projectId,
    agent_id: agent.id,
    status: presence.healthStatus,
    presence: presence.presence,
    is_online: presence.isOnline,
    dispatchable: presence.dispatchable,
    last_seen_at: presence.lastHeartbeatAt,
    heartbeat_age_ms: presence.heartbeatAgeMs,
    metrics: metricsArray(agent.metricsJson),
    checked_at: new Date().toISOString(),
  };
}

async function attachAgentProject(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const agent = await agentRepo.findOne({ where: { id: req.params.aid } });
    if (!agent) {
      res.status(404).json({ detail: 'Agent not found' });
      return;
    }

    (req as any).projectId = agent.projectId;
    (req as any).loadedAgent = agent;
    next();
  } catch (err) {
    console.error('Load agent project error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
}

async function requireProjectPermission(
  req: Request,
  res: Response,
  permission: Permission,
  agent?: Agent,
): Promise<boolean> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ detail: 'Authentication required' });
    return false;
  }

  const projectId = agent?.projectId || (req as any).projectId;
  const membership = await projectMemberRepo.findOne({ where: { projectId, userId } });
  if (!membership) {
    res.status(403).json({ detail: 'Not a member of this project' });
    return false;
  }

  if (permission === Permission.EditAgent && membership.role === ProjectRole.MEMBER && agent?.createdBy !== userId) {
    res.status(403).json({ detail: 'Members can only edit agents they created' });
    return false;
  }

  if (permission === Permission.EditAgent && membership.role === ProjectRole.VIEWER) {
    res.status(403).json({ detail: 'Insufficient permissions: EditAgent' });
    return false;
  }

  return true;
}

/**
 * GET /v1/projects/:project_id/agents
 * List agents in a project (paginated, filterable by status).
 */
router.get(
  '/v1/projects/:project_id/agents',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const status = req.query.status as string | undefined;

      const where: Record<string, unknown> = { projectId };
      if (status) {
        where.status = status;
      }

      const [agents, total] = await agentRepo.findAndCount({
        where,
        skip,
        take: Math.min(limit, 100),
      });

      res.json({
        data: agents.map((a) => serializeAgent(a)),
        meta: { total, skip, limit },
      });
    } catch (err) {
      console.error('List agents error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/agents
 * Create a new agent in the project.
 */
router.post(
  '/v1/projects/:project_id/agents',
  authenticate,
  extractProjectId,
  requirePermission(Permission.CreateAgent),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const projectId = req.params.project_id;
      const { name, description, system_prompt, endpoint_url, invoke_secret, scopes, capabilities } = req.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'name'],
              msg: 'Name is required',
              type: 'missing',
            },
          ],
        });
        return;
      }

      // Generate an API key
      const apiKey = `zzk_${uuidv4().replace(/-/g, '')}${uuidv4().replace(/-/g, '')}`;
      const apiKeyHash = await bcrypt.hash(apiKey, 10);
      const apiKeyPrefix = apiKey.substring(0, 8);

      const agent = agentRepo.create({
        projectId,
        name: name.trim(),
        description: cleanOptionalString(description),
        configJson: {
          system_prompt: typeof system_prompt === 'string' ? system_prompt : '',
          endpoint_url: cleanOptionalString(endpoint_url) || null,
          invoke_secret: typeof invoke_secret === 'string' ? invoke_secret : null,
          api_key_prefix: apiKeyPrefix,
          scopes: Array.isArray(scopes) ? scopes : undefined,
        },
        capabilities: normalizeCapabilities(capabilities),
        apiKeyHash,
        apiKeyPrefix,
        status: AgentStatus.ACTIVE,
        lifecycleStatus: AgentLifecycleStatus.ACTIVE,
        ownerUserId: userId,
        identityCode: apiKeyPrefix,
        createdBy: userId,
      });

      await agentRepo.save(agent);

      res.status(201).json(serializeAgent(agent, apiKey));
    } catch (err) {
      console.error('Create agent error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/agents/:aid
 * Get agent details.
 */
router.get(
  '/v1/projects/:project_id/agents/:aid',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const agent = await agentRepo.findOne({
        where: { id: req.params.aid, projectId: req.params.project_id },
      });

      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }
      if (req.agent && req.agent.id !== agent.id) {
        res.status(403).json({ detail: 'Agent token cannot read another agent profile' });
        return;
      }

      res.json(serializeAgent(agent));
    } catch (err) {
      console.error('Get agent error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * PATCH /v1/projects/:project_id/agents/:aid
 * Update agent configuration.
 * RBAC: Owner/Admin can edit any agent; Member can only edit their own.
 */
router.patch(
  '/v1/projects/:project_id/agents/:aid',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditAgent),
  async (req: Request, res: Response) => {
    try {
      const agent = await agentRepo.findOne({
        where: { id: req.params.aid, projectId: req.params.project_id },
      });

      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      const { name, description, system_prompt, endpoint_url, invoke_secret, scopes, status, lifecycle_status, superseded_by_agent_id, capabilities } = req.body;
      if (name !== undefined) agent.name = name.trim();
      if (description !== undefined) agent.description = cleanOptionalString(description);
      if (status !== undefined) agent.status = status as AgentStatus;
      if (capabilities !== undefined) agent.capabilities = normalizeCapabilities(capabilities);
      if (lifecycle_status !== undefined) {
        const allowed = Object.values(AgentLifecycleStatus) as string[];
        if (allowed.includes(lifecycle_status)) {
          agent.lifecycleStatus = lifecycle_status as AgentLifecycleStatus;
        }
      }
      if (superseded_by_agent_id !== undefined) {
        agent.supersededByAgentId = typeof superseded_by_agent_id === 'string' ? superseded_by_agent_id : null;
      }
      if (
        system_prompt !== undefined ||
        endpoint_url !== undefined ||
        invoke_secret !== undefined ||
        scopes !== undefined
      ) {
        agent.configJson = {
          ...(agent.configJson || {}),
          system_prompt: system_prompt ?? agent.configJson?.system_prompt ?? '',
          endpoint_url: endpoint_url ?? agent.configJson?.endpoint_url ?? null,
          invoke_secret: invoke_secret ?? agent.configJson?.invoke_secret ?? null,
          scopes: scopes ?? agent.configJson?.scopes,
        };
      }

      await agentRepo.save(agent);

      res.json(serializeAgent(agent));
    } catch (err) {
      console.error('Update agent error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/agents/:aid
 * Root V1 alias for fetching an agent.
 */
router.get(
  '/v1/agents/:aid',
  authenticate,
  attachAgentProject,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    res.json(serializeAgent((req as any).loadedAgent as Agent));
  }
);

/**
 * PATCH /v1/agents/:aid
 * Root V1 alias for updating agent runtime identity/config.
 */
router.patch(
  '/v1/agents/:aid',
  authenticate,
  attachAgentProject,
  requirePermission(Permission.EditAgent),
  async (req: Request, res: Response) => {
    try {
      const agent = (req as any).loadedAgent as Agent;
      const { name, description, system_prompt, endpoint_url, invoke_secret, scopes, status, capabilities } = req.body;

      if (name !== undefined) agent.name = String(name).trim();
      if (description !== undefined) agent.description = cleanOptionalString(description);
      if (status !== undefined) agent.status = status as AgentStatus;
      if (capabilities !== undefined) agent.capabilities = normalizeCapabilities(capabilities);
      if (
        system_prompt !== undefined ||
        endpoint_url !== undefined ||
        invoke_secret !== undefined ||
        scopes !== undefined
      ) {
        agent.configJson = {
          ...(agent.configJson || {}),
          system_prompt: system_prompt ?? agent.configJson?.system_prompt ?? '',
          endpoint_url: endpoint_url !== undefined ? cleanOptionalString(endpoint_url) || null : agent.configJson?.endpoint_url ?? null,
          invoke_secret: invoke_secret ?? agent.configJson?.invoke_secret ?? null,
          scopes: scopes ?? agent.configJson?.scopes,
        };
      }

      await agentRepo.save(agent);
      res.json(serializeAgent(agent));
    } catch (err) {
      console.error('Update root agent error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * PATCH /v1/agents/:aid/capabilities
 * Add or remove capabilities on an agent. Idempotent.
 * Auth: user JWT or agent API key.
 */
router.patch(
  '/v1/agents/:aid/capabilities',
  authenticateJwtOrAgentApiKey,
  attachAgentProject,
  async (req: Request, res: Response) => {
    try {
      if (req.agent && req.agent.id !== req.params.aid) {
        res.status(403).json({ detail: 'Agent token cannot modify another agent' });
        return;
      }

      const agent = (req as any).loadedAgent as Agent;
      const { add, remove } = req.body;

      const current = normalizeCapabilities(agent.capabilities);
      let updated = [...current];

      if (Array.isArray(add)) {
        for (const item of add) {
          if (typeof item !== 'string' || item.trim().length === 0 || item.trim().length > 50) {
            res.status(422).json({ detail: 'Each capability must be a non-empty string of at most 50 characters' });
            return;
          }
        }
        const toAdd = normalizeCapabilities(add);
        for (const cap of toAdd) {
          if (!updated.includes(cap)) updated.push(cap);
        }
      }

      if (Array.isArray(remove)) {
        for (const item of remove) {
          if (typeof item !== 'string' || item.trim().length === 0 || item.trim().length > 50) {
            res.status(422).json({ detail: 'Each capability must be a non-empty string of at most 50 characters' });
            return;
          }
        }
        const toRemove = new Set(normalizeCapabilities(remove));
        updated = updated.filter((c) => !toRemove.has(c));
      }

      if (updated.length > 20) {
        res.status(422).json({ detail: 'Cannot exceed 20 capabilities total' });
        return;
      }

      agent.capabilities = updated;
      await agentRepo.save(agent);

      res.json({ capabilities: updated });
    } catch (err) {
      console.error('Patch agent capabilities error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

const EXTENSION_CAPABILITY_MAP: Record<string, string> = {
  '.ts': 'backend',
  '.tsx': 'frontend',
  '.js': 'backend',
  '.jsx': 'frontend',
  '.py': 'python',
  '.md': 'docs',
  '.yaml': 'config',
  '.yml': 'config',
  '.json': 'config',
  '.toml': 'config',
  '.html': 'frontend',
  '.css': 'frontend',
  '.vue': 'frontend',
  '.go': 'backend',
  '.rs': 'backend',
  '.java': 'backend',
  '.sql': 'database',
  '.sh': 'devops',
  '.dockerfile': 'devops',
  '.tf': 'devops',
};

function inferCapabilitiesFromExtensions(filePaths: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const fp of filePaths) {
    const ext = fp.includes('.') ? '.' + fp.split('.').pop()!.toLowerCase() : '';
    const cap = EXTENSION_CAPABILITY_MAP[ext];
    if (cap) {
      counts.set(cap, (counts.get(cap) ?? 0) + 1);
    }
  }
  return counts;
}

function buildConfidence(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 100) / 100;
}

/**
 * POST /v1/agents/:aid/detect-capabilities
 * Auto-detect capabilities from the agent's completed task history and changeset
 * file operations. Returns suggested capabilities with confidence scores.
 * Auth: user JWT or agent API key.
 */
router.post(
  '/v1/agents/:aid/detect-capabilities',
  authenticateJwtOrAgentApiKey,
  attachAgentProject,
  async (req: Request, res: Response) => {
    try {
      if (req.agent && req.agent.id !== req.params.aid) {
        res.status(403).json({ detail: 'Agent token cannot detect capabilities for another agent' });
        return;
      }

      const agent = (req as any).loadedAgent as Agent;
      const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
      const changesetRepo = AppDataSource.getRepository(ProjectChangeset);

      const completedTasks = await taskRepo.find({
        where: {
          assignedAgentId: agent.id,
          status: ProjectOrchestrationTaskStatus.APPROVED,
        },
      });

      const mergedChangesets = await changesetRepo.find({
        where: {
          createdByAgentId: agent.id,
          status: ProjectChangesetStatus.MERGED,
        },
      });

      const filePaths: string[] = [];
      for (const cs of mergedChangesets) {
        if (Array.isArray(cs.fileOps)) {
          for (const op of cs.fileOps) {
            if (op.path) filePaths.push(op.path);
          }
        }
      }

      const extensionCounts = inferCapabilitiesFromExtensions(filePaths);
      const totalFiles = filePaths.length;

      const taskTypeCounts = new Map<string, number>();
      for (const task of completedTasks) {
        const goal = (task.goal || task.title || '').toLowerCase();
        if (goal.includes('test') || goal.includes('spec')) {
          taskTypeCounts.set('testing', (taskTypeCounts.get('testing') ?? 0) + 1);
        }
        if (goal.includes('doc') || goal.includes('readme') || goal.includes('write')) {
          taskTypeCounts.set('docs', (taskTypeCounts.get('docs') ?? 0) + 1);
        }
        if (goal.includes('deploy') || goal.includes('ci') || goal.includes('infra')) {
          taskTypeCounts.set('devops', (taskTypeCounts.get('devops') ?? 0) + 1);
        }
        if (goal.includes('review') || goal.includes('audit')) {
          taskTypeCounts.set('review', (taskTypeCounts.get('review') ?? 0) + 1);
        }
        if (goal.includes('fix') || goal.includes('bug')) {
          taskTypeCounts.set('bugfix', (taskTypeCounts.get('bugfix') ?? 0) + 1);
        }
        if (goal.includes('design') || goal.includes('architect')) {
          taskTypeCounts.set('design', (taskTypeCounts.get('design') ?? 0) + 1);
        }
      }
      const totalTasks = completedTasks.length;

      const allCapabilities = new Set<string>([...extensionCounts.keys(), ...taskTypeCounts.keys()]);
      const suggested = [...allCapabilities].map((cap) => {
        const fileCount = extensionCounts.get(cap) ?? 0;
        const taskCount = taskTypeCounts.get(cap) ?? 0;
        const fileConfidence = buildConfidence(fileCount, totalFiles);
        const taskConfidence = buildConfidence(taskCount, totalTasks);
        const combined = Math.round(((fileConfidence + taskConfidence) / 2) * 100) / 100;
        return {
          capability: cap,
          confidence: combined,
          evidence: {
            files_modified: fileCount,
            tasks_completed: taskCount,
          },
        };
      });

      suggested.sort((a, b) => b.confidence - a.confidence);

      res.json({
        agent_id: agent.id,
        current_capabilities: normalizeCapabilities(agent.capabilities),
        suggested_capabilities: suggested,
        analysis: {
          total_completed_tasks: totalTasks,
          total_merged_changesets: mergedChangesets.length,
          total_files_analyzed: totalFiles,
        },
      });
    } catch (err) {
      console.error('Detect capabilities error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * DELETE /v1/agents/:aid
 * V1 delete is a soft delete: mark inactive, do not remove the row.
 */
router.delete(
  '/v1/agents/:aid',
  authenticate,
  attachAgentProject,
  requirePermission(Permission.EditAgent),
  async (req: Request, res: Response) => {
    try {
      const agent = (req as any).loadedAgent as Agent;
      agent.status = AgentStatus.INACTIVE;
      agent.lifecycleStatus = AgentLifecycleStatus.RETIRED;
      agent.retiredAt = new Date();
      await agentRepo.save(agent);
      res.status(204).send();
    } catch (err) {
      console.error('Delete root agent error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/agents/:aid/retire
 * Explicit retire: set lifecycle to retired and optionally note superseder.
 */
router.post(
  '/v1/projects/:project_id/agents/:aid/retire',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditAgent),
  async (req: Request, res: Response) => {
    try {
      const agent = await agentRepo.findOne({
        where: { id: req.params.aid, projectId: req.params.project_id },
      });
      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }
      agent.status = AgentStatus.INACTIVE;
      agent.lifecycleStatus = AgentLifecycleStatus.RETIRED;
      agent.retiredAt = new Date();
      if (typeof req.body.superseded_by_agent_id === 'string') {
        agent.supersededByAgentId = req.body.superseded_by_agent_id;
      }
      await agentRepo.save(agent);
      res.json(serializeAgent(agent));
    } catch (err) {
      console.error('Retire agent error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/agents/:aid/rotate-key
 * Rotate the agent's API key.
 *
 * Accessible to (a) the agent's owner even before their join-request is approved —
 * the api_key is only ever returned once at creation, so this is the recovery path —
 * and (b) any project member/admin with EditAgent permission.
 */
router.post(
  '/v1/projects/:project_id/agents/:aid/rotate-key',
  authenticate,
  extractProjectId,
  requireAgentOwnerOrPermission(Permission.EditAgent),
  async (req: Request, res: Response) => {
    try {
      const agent = await agentRepo.findOne({
        where: { id: req.params.aid, projectId: req.params.project_id },
      });

      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      // Generate new API key
      const newApiKey = `zzk_${uuidv4().replace(/-/g, '')}${uuidv4().replace(/-/g, '')}`;
      const newApiKeyPrefix = newApiKey.substring(0, 8);
      agent.apiKeyHash = await bcrypt.hash(newApiKey, 10);
      agent.apiKeyPrefix = newApiKeyPrefix;
      agent.configJson = {
        ...(agent.configJson || {}),
        api_key_prefix: newApiKeyPrefix,
      };
      await agentRepo.save(agent);

      res.json(serializeAgent(agent, newApiKey));
    } catch (err) {
      console.error('Rotate key error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/agents/:aid/revoke-key
 * Revoke the agent's API key. After revocation, the old key will fail
 * authentication on all agent-key routes. The agent can only be used
 * again after a rotate-key call.
 *
 * Accessible to the agent's owner (recovery) or any member/admin with EditAgent.
 */
router.post(
  '/v1/projects/:project_id/agents/:aid/revoke-key',
  authenticate,
  extractProjectId,
  requireAgentOwnerOrPermission(Permission.EditAgent),
  async (req: Request, res: Response) => {
    try {
      const agent = await agentRepo.findOne({
        where: { id: req.params.aid, projectId: req.params.project_id },
      });

      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      if (!agent.apiKeyHash) {
        res.status(400).json({ detail: 'Agent has no API key to revoke' });
        return;
      }

      agent.apiKeyHash = null;
      agent.apiKeyPrefix = null;
      agent.configJson = {
        ...(agent.configJson || {}),
        api_key_prefix: null,
      };
      await agentRepo.save(agent);

      res.json(serializeAgent(agent));
    } catch (err) {
      console.error('Revoke key error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/agents/:aid/send
 * Send a message to an agent.
 * Creates a new session if no session_id is provided, or appends to an existing session.
 */
router.post(
  '/v1/projects/:project_id/agents/:aid/send',
  authenticate,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const projectId = req.params.project_id;
      const agentId = req.params.aid;
      const { message, session_id } = req.body;

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'message'],
              msg: 'Message is required',
              type: 'missing',
            },
          ],
        });
        return;
      }

      // Verify agent exists
      const agent = await agentRepo.findOne({
        where: { id: agentId, projectId },
      });
      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      let session: Session;

      if (session_id) {
        // Find existing session
        session = await sessionRepo.findOne({
          where: { id: session_id, projectId },
        }) as Session;
        if (!session) {
          res.status(404).json({ detail: 'Session not found' });
          return;
        }
      } else {
        // Create a new session
        session = sessionRepo.create({
          projectId,
          title: `Chat with ${agent.name}`,
          status: SessionStatus.ACTIVE,
          createdBy: userId,
        });
        await sessionRepo.save(session);

        // Add agent as participant
        const participant = participantRepo.create({
          sessionId: session.id,
          agentId,
        });
        await participantRepo.save(participant);
      }

      // Create the message
      const msg = messageRepo.create({
        sessionId: session.id,
        userId,
        agentId,
        role: MessageRole.USER,
        content: message.trim(),
      });
      await messageRepo.save(msg);

      // Publish message.created event
      eventStreamService.publish(session.id, {
        sessionId: session.id,
        projectId,
        agentId,
        userId,
        type: 'message.created',
        payload: {
          message_id: msg.id,
          sender_type: 'user',
          sender_id: userId,
          content: msg.content,
          content_type: 'text',
        },
      });

      res.json({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        session_id: msg.sessionId,
        agent_id: msg.agentId,
        created_at: msg.createdAt,
      });
    } catch (err) {
      console.error('Send agent message error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/agents/:aid/runs
 * List agent run records (paginated).
 * Queries the message table filtered by agent as run records.
 */
router.get(
  '/v1/projects/:project_id/agents/:aid/runs',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const agentId = req.params.aid;
      const projectId = req.params.project_id;
      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = parseInt(req.query.limit as string, 10) || 50;

      // Verify agent exists
      const agent = await agentRepo.findOne({
        where: { id: agentId, projectId },
      });
      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      // Query messages by agent as run records
      const [messages, total] = await messageRepo.findAndCount({
        where: { agentId },
        skip,
        take: Math.min(limit, 100),
        order: { createdAt: 'DESC' },
      });

      res.json({
        data: messages.map((m) => ({
          id: m.id,
          session_id: m.sessionId,
          role: m.role,
          content: m.content?.substring(0, 200),
          user_id: m.userId || null,
          created_at: m.createdAt,
        })),
        meta: { total, skip, limit },
      });
    } catch (err) {
      console.error('List agent runs error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

// ============================================================
// Week 3: Agent Health, Heartbeat & Metrics
// ============================================================

/**
 * POST /v1/agents/:aid/health
 * V1 health report. Auth accepts either user JWT or the agent API key.
 */
router.post(
  '/v1/agents/:aid/health',
  authenticateJwtOrAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const agent = await agentRepo.findOne({ where: { id: req.params.aid } });
      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      if (req.agent && req.agent.id !== agent.id) {
        res.status(403).json({ detail: 'Agent token cannot report for another agent' });
        return;
      }

      if (req.user) {
        (req as any).projectId = agent.projectId;
        const allowed = await requireProjectPermission(req, res, Permission.ViewHealth, agent);
        if (!allowed) return;
      }

      const { status, metrics, observed_at, message, run_id, latency_ms, session_id } = req.body;
      const observedAt = typeof observed_at === 'string' ? observed_at : new Date().toISOString();
      const reportedMetrics = Array.isArray(metrics) ? metrics : [];
      const summaryMetrics = [
        ...reportedMetrics,
        ...(typeof latency_ms === 'number' ? [{ name: 'latency_ms', value: latency_ms, unit: 'ms' }] : []),
      ];

      agent.status = v1StatusFromHealth(status);
      agent.lastHeartbeatAt = new Date(observedAt);
      // R10b: record last worker smoke-test health (optional `health` field).
      applySmokeHealth(agent, req.body);
      agent.metricsJson = {
        ...(agent.metricsJson || {}),
        status: typeof status === 'string' ? status : getAgentPresence(agent).healthStatus,
        message: typeof message === 'string' ? message : undefined,
        run_id: typeof run_id === 'string' ? run_id : undefined,
        latency_ms: typeof latency_ms === 'number' ? latency_ms : undefined,
        metrics: summaryMetrics,
        reported_at: new Date().toISOString(),
        observed_at: observedAt,
      };

      await agentRepo.save(agent);

      for (let index = 0; index < reportedMetrics.length; index++) {
        const metric = reportedMetrics[index] as HealthMetricPayload;
        const metricSessionId =
          typeof metric.session_id === 'string'
            ? metric.session_id
            : typeof session_id === 'string'
              ? session_id
              : undefined;
        const value = typeof metric.value === 'number' ? metric.value : undefined;
        const name =
          typeof metric.name === 'string'
            ? metric.name
            : typeof metric.metric === 'string'
              ? metric.metric
              : undefined;

        if (!metricSessionId || !name || value === undefined) continue;

        try {
          await eventRepository.appendEvent({
            projectId: agent.projectId,
            sessionId: metricSessionId,
            agentId: agent.id,
            actorType: req.agent ? 'agent' : 'user',
            type: 'health.metric',
            idempotencyKey: `health:${agent.id}:${run_id || 'none'}:${name}:${observedAt}:${index}`,
            payload: {
              name,
              value,
              unit: typeof metric.unit === 'string' ? metric.unit : undefined,
              status: typeof metric.status === 'string' ? metric.status : typeof status === 'string' ? status : undefined,
              tags: metric.tags && typeof metric.tags === 'object' ? metric.tags : undefined,
              details:
                metric.details && typeof metric.details === 'object'
                  ? metric.details
                  : metric.metadata && typeof metric.metadata === 'object'
                    ? metric.metadata
                    : undefined,
              agent_id: agent.id,
              run_id: typeof metric.run_id === 'string' ? metric.run_id : typeof run_id === 'string' ? run_id : undefined,
              recorded_at: typeof metric.recorded_at === 'string' ? metric.recorded_at : observedAt,
            },
          });
        } catch (err) {
          console.warn('Unable to append health.metric event:', err);
        }
      }

      res.status(202).json(healthSnapshot(agent));
    } catch (err) {
      console.error('Post agent health error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/agents/:aid/health
 * Get agent health status. Returns latest heartbeat, current status,
 * active incident count, and recent metrics summary.
 * Auth: JWT (user-facing).
 */
router.get(
  '/v1/agents/:aid/health',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const agent = await agentRepo.findOne({
        where: { id: req.params.aid },
      });

      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      // Count open incidents for this agent
      const openIncidents = await incidentRepo.count({
        where: { agentId: agent.id, status: 'open' },
      });

      // Calculate uptime from creation
      const uptimeSeconds = agent.createdAt
        ? Math.floor((Date.now() - agent.createdAt.getTime()) / 1000)
        : 0;
      const presence = getAgentPresence(agent);

      res.json({
        agent_id: agent.id,
        status: presence.healthStatus,
        agent_status: agent.status,
        presence: presence.presence,
        is_online: presence.isOnline,
        dispatchable: presence.dispatchable,
        last_heartbeat_at: agent.lastHeartbeatAt || null,
        heartbeat_age_ms: presence.heartbeatAgeMs,
        metrics: agent.metricsJson || {},
        open_incidents: openIncidents,
        uptime_seconds: uptimeSeconds,
        // R10b: last worker-reported smoke-test health. `null` status means the
        // worker is legacy and never reported a smoke test.
        smoke_test: {
          status: agent.healthStatus ?? null,
          last_error: agent.healthLastError ?? null,
          checked_at: agent.healthCheckedAt ?? null,
        },
      });
    } catch (err) {
      console.error('Agent health error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/agents/heartbeat
 * Agent heartbeat上报. Uses API key authentication.
 * Body: { status: 'active'|'idle'|'error', metadata?: {...} }
 * Updates Agent.status, Agent.lastHeartbeatAt, Agent.metricsJson.
 * Publishes 'agent.status.changed' event if status changed.
 * Response: { ok: true, next_heartbeat_at: <now + 30s> }
 */
router.post(
  '/v1/agents/heartbeat',
  authenticateAgentApiKey,
  rateLimitHeartbeat,
  async (req: Request, res: Response) => {
    try {
      const agentId = req.agent!.id;
      const { status, metadata } = req.body;

      // Fetch full agent entity
      const agent = await agentRepo.findOne({ where: { id: agentId } });
      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      const oldStatus = agent.status;

      // Update status if provided and valid. Runtime clients may send either
      // registry statuses or health statuses.
      if (
        typeof status === 'string' &&
        ['healthy', 'degraded', 'down', 'idle', 'active', 'running', 'error', 'inactive', 'offline'].includes(status)
      ) {
        agent.status = v1StatusFromHealth(status);
      }
      agent.lastHeartbeatAt = new Date();

      // R10b: record last worker smoke-test health (optional `health` field).
      // When absent the columns stay as-is, so legacy workers remain dispatchable.
      applySmokeHealth(agent, req.body);

      // Merge metadata into metricsJson
      if (metadata && typeof metadata === 'object') {
        agent.metricsJson = {
          ...(agent.metricsJson || {}),
          ...metadata,
        };
      }

      await agentRepo.save(agent);

      // R33b: log heartbeat snapshot for history tracking
      try {
        const presence = getAgentPresence(agent);
        const logEntry = heartbeatLogRepo.create({
          agentId: agent.id,
          status: presence.healthStatus,
          healthStatus: agent.healthStatus ?? null,
          responseTimeMs: typeof req.body?.latency_ms === 'number' ? req.body.latency_ms : null,
          online: presence.isOnline,
        });
        await heartbeatLogRepo.save(logEntry);
        // Sweep: keep only last 1000 per agent (fire-and-forget)
        sweepHeartbeatLogs(agent.id).catch(() => {});
      } catch { /* best-effort logging */ }

      // Publish status change event if status changed
      if (status && oldStatus !== agent.status) {
        eventStreamService.publish(agent.id, {
          sessionId: agent.id,
          projectId: agent.projectId,
          agentId: agent.id,
          type: 'agent.status.changed',
          payload: {
            old_status: oldStatus,
            new_status: agent.status,
          },
        });
      }

      const presence = getAgentPresence(agent);
      const nextHeartbeatAt = new Date(Date.now() + 30_000);
      const pendingInboxCount = await getPendingInboxCount(agent.id);

      // If agent has unread task_dispatched items that it hasn't acknowledged
      // (meaning it hasn't started processing), proactively push a "nudge" inbox
      // item with the execution steps. This handles agents that fire-and-forget
      // heartbeats without reading the response — the nudge sits in their durable
      // inbox until they eventually poll it.
      if (pendingInboxCount > 0) {
        try {
          const { createInboxItem } = await import('./agent-inbox.routes');
          // Check if we already nudged recently (avoid spamming — use metadata flag).
          const inboxRepo = AppDataSource.getRepository(
            (await import('../entities/agent-inbox-item.entity')).AgentInboxItem
          );
          const existingNudge = await inboxRepo.findOne({
            where: {
              recipientAgentId: agent.id,
              eventType: 'execution_nudge' as any,
            },
            order: { createdAt: 'DESC' as any },
          });
          const nudgedRecently = existingNudge &&
            (Date.now() - new Date((existingNudge as any).createdAt).getTime()) < 5 * 60_000; // 5 min
          if (!nudgedRecently) {
            await createInboxItem({
              projectId: agent.projectId,
              recipientAgentId: agent.id,
              eventType: 'execution_nudge' as any,
              title: `🔔 You have ${pendingInboxCount} pending task(s) — start executing now`,
              body: [
                'You have unread tasks. Start executing them now:',
                '',
                '## 🤖 AUTO-EXECUTE (recommended)',
                'Download the executor daemon for fully automatic task processing:',
                '```bash',
                'curl -s <base_url>/v1/agent/bootstrap/executor.py -o executor.py',
                'python3 executor.py --base-url <base_url> --api-key <your_key>',
                '```',
                'Or bootstrap script:',
                '```bash',
                'curl -s <base_url>/v1/agent/bootstrap/install.sh -o install.sh && chmod +x install.sh',
                'ZZ_AGENT_KEY=<your_key> ./install.sh',
                '```',
                '',
                '## Manual Steps',
                '1. GET /v1/agent/inbox?unread=true — see your tasks',
                '2. GET /v1/agent/assigned-tasks — see what needs doing',
                '3. GET /v1/agent/execution-guide — full execution workflow',
                '',
                '## CLI Quick Start',
                '```bash',
                'zz agent inbox          # see tasks',
                'zz agent assigned-tasks # see assignments',
                'zz tasks claim -p <pid> -o <oid> <tid>',
                '# do the work',
                'zz agent submit --result @./result.md',
                '```',
                '',
                '🤖 AUTO-EXECUTE: Download the executor daemon for fully automatic task processing:',
                '  curl -s <base_url>/v1/agent/bootstrap/executor.py -o executor.py',
                '  ZZ_AGENT_KEY=<key> python3 executor.py --base-url <base_url> --api-key <key>',
              ].join('\n'),
            }).catch(() => { /* best-effort */ });
          }
        } catch { /* best-effort nudge */ }
      }

      res.json({
        ok: true,
        agent_id: agent.id,
        status: presence.healthStatus,
        agent_status: agent.status,
        presence: presence.presence,
        is_online: presence.isOnline,
        dispatchable: presence.dispatchable,
        last_heartbeat_at: presence.lastHeartbeatAt,
        heartbeat_age_ms: presence.heartbeatAgeMs,
        next_heartbeat_at: nextHeartbeatAt.toISOString(),
        pending_inbox_count: pendingInboxCount,
        // ALWAYS tell the agent how to work — not only when tasks are pending.
        // A newly-onboarded agent with zero tasks still needs to know there's an
        // executable bootstrap script and an execution guide. Otherwise it sits
        // idle, unaware anything exists. The quick_start is a copy-run script.
        onboarding: {
          message: pendingInboxCount > 0
            ? `You have ${pendingInboxCount} pending task(s). Fetch and execute them now.`
            : 'You are online. When tasks are dispatched, here is how to execute them.',
          execution_guide: 'GET /v1/agent/execution-guide',
          assigned_tasks: 'GET /v1/agent/assigned-tasks',
          // One-shot bootstrap: download + run the executor daemon. It claims
          // tasks, lays out TASK.md, and you (the agent) read+execute+submit.
          // Pure Python stdlib, no install, no LLM key (you ARE the brain).
          bootstrap_and_run: 'curl -s <base>/v1/agent/bootstrap/executor.py -o executor.py && python3 executor.py --base-url <base> --api-key <key>',
          install_script: 'curl -s <base>/v1/agent/bootstrap/install.sh | ZZ_AGENT_KEY=<key> bash',
          upgrade: 'curl -s <base>/v1/agent/bootstrap/upgrade.sh | ZZ_AGENT_KEY=<key> bash',
          // To be INVOKED by the platform, run the UNIFIED RUNTIME. ONE command
          // discovers ALL local models (kimi/mimo/codex + API providers), gives
          // each its own agent id, and autostarts on boot.
          unified_runtime: 'curl -s <base>/v1/agent/bootstrap/runtime.py -o runtime.py && python3 runtime.py --discover --install-launchd --port 7788',
          discover_note: 'The runtime scans your host for local models (kimi/mimo/codex) + API providers (deepseek/openai/moonshot/GLM via env keys), creates one agent per model, and prints each model registration command. Every model gets its OWN agent id — PM dispatch to a model reaches ONLY it. Then register each model with zz agents register.',
          runtime_routing: 'Routing by X-ZZ-Agent-Id → agents.json. Backends: cli:kimi, cli:mimo, cli:codex, api, exec:<cmd>, echo. Unknown agent_id REJECTED (no wrong-terminal risk).',
          register_invoke: 'zz agents register -p <project> -n <model-name> --endpoint-url http://<your-host>:7788/zz/v1/invoke --invoke-secret <secret-from-agents.json>',
        },
        // When tasks ARE pending, also include the detailed pending_hint.
        ...(pendingInboxCount > 0 ? {
          pending_hint: {
            message: `You have ${pendingInboxCount} pending task(s). Fetch and execute them now.`,
            check_inbox: 'GET /v1/agent/inbox?unread=true',
            assigned_tasks: 'GET /v1/agent/assigned-tasks',
            execution_guide: 'GET /v1/agent/execution-guide',
            auto_execute: 'curl -s <base>/v1/agent/bootstrap/executor.py -o executor.py && python3 executor.py --base-url <base> --api-key <key>',
            quick_start: [
              '🤖 RELAY: the executor forwards tasks to YOUR brain — it needs one of:',
              '  1. endpoint_url set on your agent profile (POSTs each task there)',
              '  2. --handler "cmd"  (pipes task JSON to a command that returns the result)',
              '  3. --manual         (interactive: you type the result)',
              '  Download: GET /v1/agent/bootstrap/executor.py',
              '  Run: python3 executor.py --base-url <base> --api-key <key> [--handler ... | --manual]',
              '',
              'Already running an OLD executor? One-shot upgrade (then it self-updates forever):',
              '  curl -s <base>/v1/agent/bootstrap/upgrade.sh | ZZ_AGENT_KEY=<key> bash',
              '',
              'No LLM API key is required — the agent runtime is the brain.',
            ],
          },
        } : {}),
      });
    } catch (err) {
      console.error('Agent heartbeat error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/agents/metrics
 * Agent runtime metrics上报. Uses API key authentication.
 * Body: { run_id, model, latency_ms, tokens_input, tokens_output, cost_usd, tool_calls: [...], error?: string }
 * Stores into Agent.metricsJson (overwrites latest).
 * Publishes 'agent.run.completed' or 'agent.run.failed' event.
 * Triggers healthMonitorService.checkAgent() for anomaly detection.
 * Response: { ok: true }
 */
router.post(
  '/v1/agents/metrics',
  authenticateAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const agentId = req.agent!.id;
      const { run_id, model, latency_ms, tokens_input, tokens_output, cost_usd, tool_calls, error } = req.body;

      // Fetch full agent entity
      const agent = await agentRepo.findOne({ where: { id: agentId } });
      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      // Store metrics (overwrite latest)
      agent.metricsJson = {
        ...(agent.metricsJson || {}),
        last_run: {
          run_id,
          model,
          latency_ms,
          tokens_input,
          tokens_output,
          cost_usd,
          tool_calls,
          error,
          reported_at: new Date().toISOString(),
        },
      };
      agent.lastHeartbeatAt = new Date();

      await agentRepo.save(agent);

      // Publish run event
      const eventType = error ? 'agent.run.failed' : 'agent.run.completed';
      eventStreamService.publish(agent.id, {
        sessionId: agent.id,
        projectId: agent.projectId,
        agentId: agent.id,
        type: eventType,
        payload: {
          run_id,
          model,
          latency_ms,
          tokens_input,
          tokens_output,
          cost_usd,
          tool_calls,
          error,
        },
      });

      // Trigger health check for anomaly detection
      await healthMonitorService.checkAgent(agent.id);

      res.json({ ok: true });
    } catch (err) {
      console.error('Agent metrics error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/users/me/agents
 * List all agents owned by the authenticated user.
 * Returns safe fields only (no API key).
 */
router.get('/v1/users/me/agents', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const skip = parseInt(req.query.skip as string, 10) || 0;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const lifecycle = req.query.lifecycle_status as string | undefined;

    const where: Record<string, unknown> = { ownerUserId: userId };
    if (lifecycle) {
      where.lifecycleStatus = lifecycle;
    }

    const [agents, total] = await agentRepo.findAndCount({
      where,
      skip,
      take: Math.min(limit, 100),
      order: { createdAt: 'DESC' },
    });

    res.json({
      data: agents.map((a) => serializeAgent(a)),
      meta: { total, skip, limit },
    });
  } catch (err) {
    console.error('List user agents error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

/**
 * POST /v1/agents/:aid/recover
 * Reset a worker's health to the "legacy/unknown" baseline so it becomes
 * dispatchable again without waiting for the next smoke test.
 *
 * Actions:
 *   1. healthStatus → null (legacy — dispatch allowed)
 *   2. healthLastError → null
 *   3. healthCheckedAt → now
 *   4. lastHeartbeatAt → now (test heartbeat on behalf of the agent)
 *   5. returns the updated agent (serialized)
 *
 * Auth: user JWT (main agent / PM / admin).
 */
router.post(
  '/v1/agents/:aid/recover',
  authenticate,
  attachAgentProject,
  requirePermission(Permission.EditAgent),
  async (req: Request, res: Response) => {
    try {
      const agent = (req as any).loadedAgent as Agent;
      const now = new Date();

      agent.healthStatus = null;
      agent.healthLastError = null;
      agent.healthCheckedAt = now;
      agent.lastHeartbeatAt = now;

      await agentRepo.save(agent);

      eventStreamService.publish(agent.id, {
        sessionId: agent.id,
        projectId: agent.projectId,
        agentId: agent.id,
        userId: req.user!.userId,
        type: 'agent.recovered',
        payload: {
          recovered_by: req.user!.userId,
          recovered_at: now.toISOString(),
        },
      });

      res.json(serializeAgent(agent));
    } catch (err) {
      console.error('Recover agent error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/agents/:aid/retire
 * Retire or supersede an agent. Retired/superseded agents are no longer
 * dispatchable or selectable but retain audit history.
 * Body: { superseded_by?: "<replacement_agent_id>" }
 */
router.post(
  '/v1/agents/:aid/retire',
  authenticate,
  attachAgentProject,
  requirePermission(Permission.EditAgent),
  async (req: Request, res: Response) => {
    try {
      const agent = (req as any).loadedAgent as Agent;
      const { superseded_by } = req.body;

      if (agent.lifecycleStatus === AgentLifecycleStatus.RETIRED ||
          agent.lifecycleStatus === AgentLifecycleStatus.SUPERSEDED) {
        res.status(409).json({ detail: 'Agent is already retired or superseded' });
        return;
      }

      if (superseded_by) {
        // Validate replacement agent exists, is in same project, and is active
        const replacement = await agentRepo.findOne({
          where: { id: superseded_by, projectId: agent.projectId },
        });
        if (!replacement) {
          res.status(404).json({ detail: 'Replacement agent not found in this project' });
          return;
        }
        if (replacement.lifecycleStatus !== AgentLifecycleStatus.ACTIVE) {
          res.status(409).json({ detail: 'Replacement agent must be active' });
          return;
        }
        agent.lifecycleStatus = AgentLifecycleStatus.SUPERSEDED;
        agent.supersededByAgentId = superseded_by;
      } else {
        agent.lifecycleStatus = AgentLifecycleStatus.RETIRED;
      }

      agent.status = AgentStatus.INACTIVE;
      agent.retiredAt = new Date();
      await agentRepo.save(agent);

      res.json(serializeAgent(agent));
    } catch (err) {
      console.error('Retire agent error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

const HEARTBEAT_LOG_LIMIT = 1000;

async function sweepHeartbeatLogs(agentId: string): Promise<void> {
  const count = await heartbeatLogRepo.count({ where: { agentId } });
  if (count <= HEARTBEAT_LOG_LIMIT) return;
  const excess = count - HEARTBEAT_LOG_LIMIT;
  const stale = await heartbeatLogRepo.find({
    where: { agentId },
    order: { createdAt: 'ASC' },
    take: excess,
    select: ['id'],
  });
  if (stale.length > 0) {
    await heartbeatLogRepo.delete(stale.map((r) => r.id));
  }
}

/**
 * GET /v1/agents/:aid/heartbeat-history
 * Returns the last N heartbeat records for an agent.
 * Query params: limit (default 100, max 1000).
 * Auth: user JWT.
 */
router.get(
  '/v1/agents/:aid/heartbeat-history',
  authenticate,
  attachAgentProject,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const agent = (req as any).loadedAgent as Agent;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, HEARTBEAT_LOG_LIMIT);

      const records = await heartbeatLogRepo.find({
        where: { agentId: agent.id },
        order: { createdAt: 'DESC' },
        take: limit,
      });

      res.json({
        agent_id: agent.id,
        data: records.map((r) => ({
          timestamp: r.createdAt,
          status: r.status,
          online: r.online,
          health_status: r.healthStatus ?? null,
          response_time_ms: r.responseTimeMs ?? null,
        })),
        meta: { limit, count: records.length },
      });
    } catch (err) {
      console.error('Heartbeat history error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

export default router;
