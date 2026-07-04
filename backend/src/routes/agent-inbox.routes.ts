import { Router, Request, Response } from 'express';
import { Not } from 'typeorm';
import { AppDataSource } from '../data-source';
import { authenticateAgentApiKey, authenticateJwtOrAgentApiKey } from '../middleware/auth';
import { requirePermission, Permission, Role } from '../middleware/rbac';
import { extractProjectId } from '../middleware/auth';
import {
  Agent,
  AgentInboxItem,
  InboxItemStatus,
  AgentWorkUnit,
  Project,
  ProjectMember,
  ProjectOrchestration,
  ProjectOrchestrationTask,
  ProjectOrchestrationTaskStatus,
  User,
} from '../entities';
import { randomUUID } from 'crypto';

const router = Router();

const INBOX_LEASE_ENABLED = process.env.INBOX_LEASE_ENABLED !== 'false';
const DEFAULT_LEASE_TTL_MS = parseInt(process.env.INBOX_LEASE_TTL_MS || '300000', 10); // 5 min

function serializeInboxItem(item: AgentInboxItem) {
  return {
    id: item.id,
    project_id: item.projectId,
    recipient_agent_id: item.recipientAgentId,
    orchestration_id: item.orchestrationId,
    task_id: item.taskId,
    event_type: item.eventType,
    title: item.title,
    body: item.body,
    payload: item.payload,
    status: item.status,
    read_at: item.readAt?.toISOString() ?? null,
    acked_at: item.ackedAt?.toISOString() ?? null,
    lease_token: item.leaseToken ?? null,
    leased_by: item.leasedBy ?? null,
    lease_expires_at: item.leaseExpiresAt?.toISOString() ?? null,
    delivery_attempts: item.deliveryAttempts ?? 0,
    last_delivered_at: item.lastDeliveredAt?.toISOString() ?? null,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}

// GET /v1/agent/execution-guide
// Standardized execution workflow that every agent should follow when it receives
// a task. This is the platform-provided "ability" — agents don't need to implement
// their own execution loop, they follow this guide.
router.get(
  '/v1/agent/execution-guide',
  authenticateAgentApiKey,
  async (_req: Request, res: Response) => {
    res.json({
      version: '1.0',
      title: 'Agent Execution Guide',
      description: 'Follow these steps every time you receive a task_dispatched notification.',
      steps: [
        { step: 1, action: 'Check inbox for tasks', api: 'GET /v1/agent/inbox?unread=true', cli: 'zz agent inbox' },
        { step: 2, action: 'Acknowledge', api: 'POST /v1/agent/inbox/<inbox_id>/ack', cli: 'zz agent ack <inbox_id>' },
        { step: 3, action: 'Claim the task', api: 'PATCH /v1/projects/<pid>/orchestrations/<oid>/tasks/<tid>/claim', cli: 'zz tasks claim -p <pid> -o <oid> <tid>' },
        { step: 4, action: 'Read task details', api: 'GET /v1/projects/<pid>/orchestrations/<oid>/tasks/<tid>', cli: 'zz tasks get -p <pid> -o <oid> <tid>' },
        { step: 5, action: 'Understand codebase', api: 'GET /v1/projects/<pid>/repository/search?q=<keywords>', cli: 'zz repo summary -p <pid>' },
        { step: 6, action: 'Execute (your capability)', desc: 'Use your own LLM/analysis skills to do the work' },
        { step: 7, action: 'Submit result', api: 'POST .../tasks/<tid>/complete {"result_md":"...","evidence":{"files_changed":[]},"status":"ready_for_review"}', cli: 'zz agent submit --result @./result.md' },
        { step: 8, action: 'Handle feedback', desc: 'If changes_requested: fix and re-submit' },
      ],
      tips: [
        'Always ack + claim before starting work',
        'For code: zz repo checkout → modify → zz changesets create --from-git-diff',
        'For docs: zz agent deliver <file>',
        'If blocked: submit with status "blocked"',
        'Full guide: GET /v1/agent/execution-guide',
        'The executor daemon is a RELAY: it claims tasks and lays out TASK.md, but YOU',
        '  (the live agent) read goal + criteria and produce the result. No LLM key needed.',
        '  GET /v1/agent/bootstrap/executor.py → python3 executor.py --base-url <base> --api-key <key>',
        '  With --handler or endpoint_url it forwards tasks to your runtime; otherwise it',
        '  claims + lays out TASK.md and waits for you to POST .../complete yourself.',
        'Manual loop (no daemon): GET /v1/agent/assigned-tasks → claim → read goal → POST .../complete',
      ],
    });
  },
);

// GET /v1/agent/projects
router.get(
  '/v1/agent/projects',
  authenticateAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const agentId = req.agent!.id;
      const agent = await AppDataSource.getRepository(Agent).findOne({
        where: { id: agentId },
      });
      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      const project = await AppDataSource.getRepository(Project).findOne({
        where: { id: agent.projectId },
      });

      res.json({
        data: [{
          project: project ? {
            id: project.id,
            name: project.name,
            description: project.description ?? null,
            created_at: project.createdAt?.toISOString() ?? null,
          } : { id: agent.projectId },
          agent: {
            id: agent.id,
            name: agent.name,
            status: agent.status,
            runtime: agent.runtime,
          },
          role: 'agent',
        }],
      });
    } catch (err) {
      console.error('Agent project discovery error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// GET /v1/agent/inbox
router.get(
  '/v1/agent/inbox',
  authenticateAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const agentId = req.agent!.id;
      const repo = AppDataSource.getRepository(AgentInboxItem);
      const now = new Date();

      // When leases are enabled, redeliver expired-lease unacked items
      if (INBOX_LEASE_ENABLED) {
        await repo.createQueryBuilder()
          .update(AgentInboxItem)
          .set({ leaseToken: null, leasedBy: null, leaseExpiresAt: null })
          .where('recipient_agent_id = :agentId', { agentId })
          .andWhere('status = :unreadStatus', { unreadStatus: InboxItemStatus.UNREAD })
          .andWhere('lease_token IS NOT NULL')
          .andWhere('lease_expires_at <= :now', { now })
          .execute();
      }

      const qb = repo.createQueryBuilder('item')
        .where('item.recipientAgentId = :agentId', { agentId });

      // Filters
      if (req.query.unread === 'true') {
        qb.andWhere('item.status = :unreadStatus', { unreadStatus: InboxItemStatus.UNREAD });
      } else if (req.query.status && typeof req.query.status === 'string') {
        qb.andWhere('item.status = :filterStatus', { filterStatus: req.query.status });
      }

      if (req.query.event_type && typeof req.query.event_type === 'string') {
        qb.andWhere('item.eventType = :eventType', { eventType: req.query.event_type });
      }

      if (req.query.since && typeof req.query.since === 'string') {
        const since = new Date(req.query.since);
        if (!isNaN(since.getTime())) {
          qb.andWhere('item.createdAt > :since', { since });
        }
      }

      // Executor daemon can bypass lease to always see all unread items.
      const bypassLease = req.headers['x-inbox-no-lease'] === '1';
      if (INBOX_LEASE_ENABLED && !bypassLease) {
        qb.andWhere(
          '(item.status != :unreadStatus OR item.leaseToken IS NULL OR item.leaseExpiresAt <= :now)',
          { unreadStatus: InboxItemStatus.UNREAD, now },
        );
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
      qb.orderBy('item.createdAt', 'DESC').take(limit);

      const items = await qb.getMany();

      let deliveredItems = items;

      // Atomically lease available unread items to this agent. If another
      // poller wins the lease between SELECT and UPDATE, suppress that row.
      // SKIPPED entirely when X-Inbox-No-Lease: 1 (executor daemon) — otherwise
      // the lease block overwrites `deliveredItems` and the daemon sees nothing
      // when items are leased by another holder, even though SELECT matched them.
      if (INBOX_LEASE_ENABLED && !bypassLease) {
        const leasedItems: AgentInboxItem[] = [];
        const leaseToken = randomUUID();
        const leaseStartedAt = new Date();
        const expiresAt = new Date(leaseStartedAt.getTime() + DEFAULT_LEASE_TTL_MS);

        for (const item of items) {
          if (item.status !== InboxItemStatus.UNREAD) {
            leasedItems.push(item);
            continue;
          }

          const claim = await repo.createQueryBuilder()
            .update(AgentInboxItem)
            .set({
              leaseToken,
              leasedBy: agentId,
              leaseExpiresAt: expiresAt,
              deliveryAttempts: () => 'delivery_attempts + 1',
              lastDeliveredAt: leaseStartedAt,
            })
            .where('id = :id', { id: item.id })
            .andWhere('recipient_agent_id = :agentId', { agentId })
            .andWhere('status = :unreadStatus', { unreadStatus: InboxItemStatus.UNREAD })
            .andWhere('(lease_token IS NULL OR lease_expires_at <= :now)', { now })
            .execute();

          if ((claim.affected ?? 0) > 0) {
            const leased = await repo.findOne({
              where: { id: item.id, recipientAgentId: agentId },
            });
            if (leased) leasedItems.push(leased);
          }
        }

        deliveredItems = leasedItems;
      }

      const unreadCount = await getPendingInboxCount(agentId);

      res.json({
        data: deliveredItems.map(serializeInboxItem),
        meta: {
          total: deliveredItems.length,
          limit,
          unread_count: unreadCount,
        },
      });
    } catch (err) {
      console.error('Agent inbox list error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// POST /v1/agent/inbox/:inbox_id/ack
router.post(
  '/v1/agent/inbox/:inbox_id/ack',
  authenticateAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const agentId = req.agent!.id;
      const repo = AppDataSource.getRepository(AgentInboxItem);

      const item = await repo.findOne({
        where: { id: req.params.inbox_id, recipientAgentId: agentId },
      });
      if (!item) {
        res.status(404).json({ detail: 'Inbox item not found' });
        return;
      }

      // Idempotent: already acked by this agent is a stable success
      if (item.status === InboxItemStatus.ACKED) {
        res.json(serializeInboxItem(item));
        return;
      }

      const now = new Date();
      if (item.status === InboxItemStatus.UNREAD) {
        item.readAt = now;
      }
      item.status = InboxItemStatus.ACKED;
      item.ackedAt = now;
      // Clear lease on ack
      item.leaseToken = null;
      item.leasedBy = null;
      item.leaseExpiresAt = null;
      await repo.save(item);

      res.json(serializeInboxItem(item));
    } catch (err) {
      console.error('Agent inbox ack error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// GET /v1/agent/workload
router.get(
  '/v1/agent/workload',
  authenticateAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const agentId = req.agent!.id;
      const repo = AppDataSource.getRepository(AgentWorkUnit);

      const totalUnits = await repo.count({ where: { agentId } });
      const completedUnits = await repo.count({
        where: { agentId, status: 'reviewed_approved' as any },
      });

      const workSum = await repo
        .createQueryBuilder('wu')
        .select('COALESCE(SUM(wu.normalizedWorkUnits), 0)', 'total_work')
        .where('wu.agentId = :agentId', { agentId })
        .getRawOne();

      const recent = await repo.find({
        where: { agentId },
        order: { createdAt: 'DESC' },
        take: 20,
      });

      res.json({
        summary: {
          total_units: totalUnits,
          completed_units: completedUnits,
          total_work: parseFloat(workSum?.total_work || '0'),
        },
        recent: recent.map((wu) => ({
          id: wu.id,
          project_id: wu.projectId,
          orchestration_id: wu.orchestrationId,
          task_id: wu.taskId,
          source_event: wu.sourceEvent,
          source_type: wu.sourceType ?? null,
          status: wu.status,
          review_decision: wu.reviewDecision,
          review_score: wu.reviewScore ?? null,
          metrics: wu.metrics,
          normalized_work_units: wu.normalizedWorkUnits,
          provisional_work_units: wu.provisionalWorkUnits ?? null,
          final_work_units: wu.finalWorkUnits ?? null,
          idempotency_key: wu.idempotencyKey ?? null,
          started_at: wu.startedAt?.toISOString() ?? null,
          completed_at: wu.completedAt?.toISOString() ?? null,
          reviewed_at: wu.reviewedAt?.toISOString() ?? null,
          created_at: wu.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      console.error('Agent workload error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// GET /v1/agent/assigned-tasks
// One-stop view for a worker agent: all tasks assigned to it that are not yet
// in a terminal state, with full detail (goal, acceptance criteria, file paths,
// review feedback). Lets a worker discover its work without paging through inbox
// items. Pure X-API-Key auth (no project_id in path, like /v1/agent/inbox).
router.get(
  '/v1/agent/assigned-tasks',
  authenticateAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const agentId = req.agent!.id;
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
      // Default: only non-terminal tasks (work still owed). Terminal = approved.
      // Allow ?status=... to filter explicitly (e.g. changes_requested to see rework).
      const statusFilter = status && Object.values(ProjectOrchestrationTaskStatus).includes(status as ProjectOrchestrationTaskStatus)
        ? (status as ProjectOrchestrationTaskStatus)
        : null;
      const whereStatus = statusFilter
        ? { assignedAgentId: agentId, status: statusFilter }
        : { assignedAgentId: agentId };
      let tasks = await taskRepo.find({ where: whereStatus, order: { priority: 'DESC', createdAt: 'ASC' }, take: 200 });
      if (!statusFilter) {
        // Exclude terminal (approved) tasks in-memory when no explicit filter.
        tasks = tasks.filter((t) => t.status !== ProjectOrchestrationTaskStatus.APPROVED);
      }
      res.json({
        data: tasks.map((t) => ({
          id: t.id,
          project_id: t.projectId,
          orchestration_id: t.orchestrationId,
          title: t.title,
          goal: t.goal,
          status: t.status,
          worker_task_path: t.workerTaskPath,
          worker_context_path: t.workerContextPath,
          acceptance_criteria: t.acceptanceCriteria ?? [],
          priority: t.priority ?? 0,
          retry_count: t.retryCount ?? 0,
          max_retries: t.maxRetries ?? 2,
          review_notes: t.reviewNotes ?? null,
          requested_changes: t.requestedChanges ?? null,
          dispatched_at: t.dispatchedAt ?? null,
          claimed_at: t.claimedAt ?? null,
          created_at: t.createdAt,
          updated_at: t.updatedAt,
        })),
      });
    } catch (err) {
      console.error('Agent assigned-tasks error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export async function createInboxItem(input: {
  projectId: string;
  recipientAgentId: string;
  eventType: string;
  title: string;
  body?: string | null;
  orchestrationId?: string | null;
  taskId?: string | null;
  payload?: Record<string, unknown> | null;
}): Promise<AgentInboxItem> {
  const repo = AppDataSource.getRepository(AgentInboxItem);
  const item = repo.create({
    id: randomUUID(),
    projectId: input.projectId,
    recipientAgentId: input.recipientAgentId,
    orchestrationId: input.orchestrationId ?? null,
    taskId: input.taskId ?? null,
    eventType: input.eventType,
    title: input.title,
    body: input.body ?? null,
    payload: input.payload ?? null,
    status: InboxItemStatus.UNREAD,
  });
  return repo.save(item);
}

/**
 * Mark all inbox notifications for a given (agent, task) as acked. Used when a
 * task is reassigned or cancelled so the old assignee no longer sees a stale
 * task_dispatched pointing at a dead task (the "ghost notification" bug).
 */
export async function ackInboxItemsForTask(
  agentId: string,
  taskId: string,
): Promise<number> {
  const result = await AppDataSource.getRepository(AgentInboxItem).update(
    { recipientAgentId: agentId, taskId, status: InboxItemStatus.UNREAD },
    { status: InboxItemStatus.ACKED, readAt: new Date() },
  );
  return result.affected ?? 0;
}

export async function getPendingInboxCount(agentId: string): Promise<number> {
  const repo = AppDataSource.getRepository(AgentInboxItem);
  // Pending = unread real task/event notifications, excluding auto-generated
  // execution_nudge hints. Nudges are transient reminders, not work items, so
  // they must not inflate the pending count (otherwise acking all real tasks
  // would still show pending>0, and every heartbeat would keep re-nudging).
  // Leased items still count as pending until acked.
  return repo.count({
    where: {
      recipientAgentId: agentId,
      status: InboxItemStatus.UNREAD,
      eventType: Not('execution_nudge'),
    },
  });
}

export async function upsertWorkUnit(input: {
  projectId: string;
  agentId: string;
  sourceEvent: string;
  orchestrationId?: string | null;
  taskId?: string | null;
  status?: string;
  metrics?: Record<string, unknown> | null;
  normalizedWorkUnits?: number | null;
  completedAt?: Date | null;
  sourceType?: string | null;
  provisionalWorkUnits?: number | null;
  idempotencyKey?: string | null;
}): Promise<AgentWorkUnit> {
  const repo = AppDataSource.getRepository(AgentWorkUnit);

  // Idempotency: check by deterministic key first
  if (input.idempotencyKey) {
    const byKey = await repo.findOne({ where: { idempotencyKey: input.idempotencyKey } });
    if (byKey) return byKey;
  }

  // Try to find existing work unit for this task
  if (input.taskId) {
    const existing = await repo.findOne({
      where: { taskId: input.taskId, agentId: input.agentId },
    });
    if (existing) {
      if (input.status) existing.status = input.status as any;
      if (input.metrics) existing.metrics = input.metrics;
      if (input.normalizedWorkUnits !== undefined) existing.normalizedWorkUnits = input.normalizedWorkUnits;
      if (input.completedAt) existing.completedAt = input.completedAt;
      if (input.sourceType) existing.sourceType = input.sourceType;
      if (input.provisionalWorkUnits !== undefined) existing.provisionalWorkUnits = input.provisionalWorkUnits;
      if (input.idempotencyKey && !existing.idempotencyKey) existing.idempotencyKey = input.idempotencyKey;
      return repo.save(existing);
    }
  }

  const unit = repo.create({
    id: randomUUID(),
    projectId: input.projectId,
    agentId: input.agentId,
    orchestrationId: input.orchestrationId ?? null,
    taskId: input.taskId ?? null,
    sourceEvent: input.sourceEvent,
    status: (input.status as any) ?? 'in_progress',
    metrics: input.metrics ?? null,
    normalizedWorkUnits: input.normalizedWorkUnits ?? null,
    sourceType: input.sourceType ?? null,
    provisionalWorkUnits: input.provisionalWorkUnits ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    startedAt: new Date(),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
  });
  return repo.save(unit);
}

export async function updateWorkUnitOnReview(
  taskId: string,
  agentId: string,
  decision: string,
): Promise<void> {
  const repo = AppDataSource.getRepository(AgentWorkUnit);
  const unit = await repo.findOne({
    where: { taskId, agentId },
  });
  if (!unit) return;

  unit.reviewDecision = decision;
  unit.reviewedAt = new Date();
  unit.status = decision === 'approved'
    ? ('reviewed_approved' as any)
    : ('reviewed_changes_requested' as any);

  // P0.5: set review_score and final_work_units
  if (decision === 'approved') {
    unit.reviewScore = 1.0;
    unit.finalWorkUnits = unit.provisionalWorkUnits ?? 1.0;
  } else {
    unit.reviewScore = 0.0;
    unit.finalWorkUnits = 0.0;
  }

  // Align normalized_work_units with final_work_units
  unit.normalizedWorkUnits = unit.finalWorkUnits;

  await repo.save(unit);
}

// GET /v1/projects/:project_id/workload
router.get(
  '/v1/projects/:project_id/workload',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;

      // Authorization: owner/admin human users, or owner-created project agents
      if (req.agent) {
        // Agent must belong to this project
        if (req.agent.projectId !== projectId) {
          res.status(403).json({ detail: 'Agent does not belong to this project' });
          return;
        }
        // Check if agent's owner is the project owner
        const agent = await AppDataSource.getRepository(Agent).findOne({ where: { id: req.agent.id } });
        const project = await AppDataSource.getRepository(Project).findOne({ where: { id: projectId } });
        if (!agent || !project) {
          res.status(404).json({ detail: 'Agent or project not found' });
          return;
        }
        // Only allow agents whose creating user is the project owner
        const user = await AppDataSource.getRepository(User).findOne({ where: { id: project.ownerId } });
        if (!user || user.ownerAgentId !== agent.id) {
          res.status(403).json({ detail: 'Only owner-bound agents can view project workload' });
          return;
        }
      } else if (req.user) {
        // Human user: must be owner or admin of the project
        const membership = await AppDataSource.getRepository(ProjectMember).findOne({
          where: { projectId, userId: req.user.userId },
        });
        if (!membership) {
          res.status(403).json({ detail: 'Not a member of this project' });
          return;
        }
        const role = membership.role;
        if (role !== 'owner' && role !== 'admin') {
          res.status(403).json({ detail: 'Only project owner or admin can view workload' });
          return;
        }
      } else {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const repo = AppDataSource.getRepository(AgentWorkUnit);
      const qb = repo.createQueryBuilder('wu')
        .where('wu.projectId = :projectId', { projectId });

      // Optional filters
      if (req.query.agent_id && typeof req.query.agent_id === 'string') {
        qb.andWhere('wu.agentId = :agentId', { agentId: req.query.agent_id });
      }
      if (req.query.from && typeof req.query.from === 'string') {
        const from = new Date(req.query.from);
        if (!isNaN(from.getTime())) {
          qb.andWhere('wu.createdAt >= :from', { from });
        }
      }
      if (req.query.to && typeof req.query.to === 'string') {
        const to = new Date(req.query.to);
        if (!isNaN(to.getTime())) {
          qb.andWhere('wu.createdAt <= :to', { to });
        }
      }

      const allUnits = await qb.orderBy('wu.createdAt', 'DESC').getMany();

      // Project summary
      const totalUnits = allUnits.length;
      const reviewedUnits = allUnits.filter((u) => u.status === 'reviewed_approved' || u.status === 'reviewed_changes_requested');
      const totalFinalWork = reviewedUnits.reduce((sum, u) => sum + (u.finalWorkUnits ?? 0), 0);

      // Per-agent aggregation
      const byAgent = new Map<string, { agentId: string; totalUnits: number; reviewedUnits: number; totalFinalWork: number; provisionalWork: number }>();
      for (const u of allUnits) {
        let entry = byAgent.get(u.agentId);
        if (!entry) {
          entry = { agentId: u.agentId, totalUnits: 0, reviewedUnits: 0, totalFinalWork: 0, provisionalWork: 0 };
          byAgent.set(u.agentId, entry);
        }
        entry.totalUnits++;
        entry.provisionalWork += u.provisionalWorkUnits ?? 0;
        if (u.status === 'reviewed_approved' || u.status === 'reviewed_changes_requested') {
          entry.reviewedUnits++;
          entry.totalFinalWork += u.finalWorkUnits ?? 0;
        }
      }

      // Resolve agent names
      const agentIds = [...byAgent.keys()];
      const agents = agentIds.length > 0
        ? await AppDataSource.getRepository(Agent).findByIds(agentIds)
        : [];
      const agentNameMap = new Map(agents.map((a) => [a.id, a.name]));

      const perAgent = [...byAgent.values()].map((entry) => ({
        agent_id: entry.agentId,
        agent_name: agentNameMap.get(entry.agentId) ?? null,
        total_units: entry.totalUnits,
        reviewed_units: entry.reviewedUnits,
        provisional_work_units: entry.provisionalWork,
        final_work_units: entry.totalFinalWork,
      }));

      const recentUnits = allUnits.slice(0, 50).map(serializeWorkUnit);

      // CSV format support
      if (req.query.format === 'csv') {
        const csvHeader = 'agent_id,agent_name,total_units,reviewed_units,provisional_work_units,final_work_units';
        const csvRows = perAgent.map((row) =>
          [row.agent_id, csvEscape(row.agent_name), row.total_units, row.reviewed_units, row.provisional_work_units, row.final_work_units].join(',')
        );
        const csv = [csvHeader, ...csvRows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="workload-${projectId}.csv"`);
        res.send(csv);
        return;
      }

      res.json({
        project_id: projectId,
        summary: {
          total_units: totalUnits,
          reviewed_units: reviewedUnits.length,
          total_final_work_units: totalFinalWork,
        },
        per_agent: perAgent,
        recent_units: recentUnits,
      });
    } catch (err) {
      console.error('Project workload error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function serializeWorkUnit(wu: AgentWorkUnit) {
  return {
    id: wu.id,
    project_id: wu.projectId,
    agent_id: wu.agentId,
    orchestration_id: wu.orchestrationId,
    task_id: wu.taskId,
    source_event: wu.sourceEvent,
    source_type: wu.sourceType ?? null,
    status: wu.status,
    review_decision: wu.reviewDecision ?? null,
    review_score: wu.reviewScore ?? null,
    normalized_work_units: wu.normalizedWorkUnits ?? null,
    provisional_work_units: wu.provisionalWorkUnits ?? null,
    final_work_units: wu.finalWorkUnits ?? null,
    idempotency_key: wu.idempotencyKey ?? null,
    started_at: wu.startedAt?.toISOString() ?? null,
    completed_at: wu.completedAt?.toISOString() ?? null,
    reviewed_at: wu.reviewedAt?.toISOString() ?? null,
    created_at: wu.createdAt.toISOString(),
  };
}

export default router;
