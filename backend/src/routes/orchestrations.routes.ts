import crypto, { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { EntityManager, In, Brackets, SelectQueryBuilder, IsNull, FindOptionsWhere } from 'typeorm';
import { AppDataSource } from '../data-source';
import { authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import {
  Agent,
  AgentLifecycleStatus,
  AgentSmokeHealth,
  Project,
  ProjectBranch,
  ProjectFile,
  ProjectFileRevision,
  ProjectChangeset,
  ProjectChangesetStatus,
  ProjectCommit,
  ProjectOrchestration,
  ProjectOrchestrationStatus,
  ProjectOrchestrationTask,
  ProjectOrchestrationTaskEvidence,
  ProjectOrchestrationTaskStatus,
  ScheduledDispatch,
  Session,
  SessionParticipant,
  SessionStatus,
} from '../entities';
import { MessageVisibility } from '../entities/message.entity';
import { getAgentPresence } from '../services/agent-presence.service';
import { SessionDispatchService } from '../services/session-dispatch.service';
import { checkDependenciesMet } from '../services/task-graph.service';
import { verifyTaskCompletion } from '../services/task-verification.service';
import {
  writeTaskMd,
  writeResultMd,
  writeEvidenceMd,
  writeReviewMd,
  writeChangelogMd,
  writeTraceMd,
  setMdArtifactPaths,
  taskMdDir,
  redactMarkdown,
  redactValue,
} from '../services/md-artifact.service';
import { createInboxItem, upsertWorkUnit, updateWorkUnitOnReview, ackInboxItemsForTask } from './agent-inbox.routes';
import { serializeChangeset } from './versioning.routes';
import { eventStreamService } from '../services/event-stream.service';
import { nextCronDate } from '../services/scheduler.service';

const router = Router();
const dispatchService = new SessionDispatchService();
const MAX_FILE_BYTES = 1024 * 1024;

type ProjectFileUpsertInput = {
  projectId: string;
  path: string;
  content: string;
  contentType?: string;
  actorId: string;
  message?: string | null;
};

router.post(
  '/v1/projects/:project_id/orchestrations',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const title = normalizeRequiredString(req.body.title, 'title', 255);
      const objective = normalizeRequiredString(req.body.objective, 'objective', 20_000);
      if (!title.ok) {
        res.status(422).json({ detail: title.error });
        return;
      }
      if (!objective.ok) {
        res.status(422).json({ detail: objective.error });
        return;
      }

      const orchestrationId = randomUUID();
      const basePathInput = typeof req.body.base_path === 'string'
        ? req.body.base_path
        : `.agent/orchestrations/${orchestrationId}`;
      const basePath = validateProjectPath(trimTrailingSlash(basePathInput));
      if (!basePath.ok) {
        res.status(422).json({ detail: `base_path: ${basePath.error}` });
        return;
      }

      let mainAgentId = typeof req.body.main_agent_id === 'string' ? req.body.main_agent_id.trim() : null;
      if (req.agent) {
        if (mainAgentId && mainAgentId !== req.agent.id) {
          res.status(403).json({ detail: 'Agent cannot create orchestration for another main_agent_id' });
          return;
        }
        mainAgentId = req.agent.id;
      }

      const workerAgentIds = normalizeStringArray(req.body.worker_agent_ids ?? req.body.agent_ids);
      const agentIds = normalizeStringArray([mainAgentId, ...workerAgentIds].filter(Boolean));
      if (!await ensureAgentsExistAndDispatchable(res, projectId, agentIds)) return;

      const acceptanceCriteria = normalizeStringArray(req.body.acceptance_criteria);
      const plan = typeof req.body.plan === 'string' ? req.body.plan.trim() : '';
      const createSession = req.body.create_session !== false;

      const orchestration = await AppDataSource.transaction(async (manager) => {
        let session: Session | null = null;
        if (createSession && agentIds.length > 0) {
          session = await createOrchestrationSession(manager, {
            projectId,
            title: `Orchestration: ${title.value}`,
            createdBy: actor.actorId,
            agentIds,
          });
        }

        const created = manager.create(ProjectOrchestration, {
          id: orchestrationId,
          projectId,
          title: title.value,
          objective: objective.value,
          status: ProjectOrchestrationStatus.PLANNING,
          basePath: basePath.value,
          sessionId: session?.id ?? null,
          mainAgentId,
          createdByUserId: actor.userId,
          createdByAgentId: actor.agentId,
          acceptanceCriteria,
          metadata: isPlainObject(req.body.metadata) ? req.body.metadata : null,
        });
        await manager.save(ProjectOrchestration, created);

        await upsertProjectFile(manager, {
          projectId,
          path: `${basePath.value}/goal.md`,
          content: renderGoalMd(created),
          actorId: actor.actorId,
          message: 'Create orchestration goal',
        });
        await upsertProjectFile(manager, {
          projectId,
          path: `${basePath.value}/plan.md`,
          content: renderPlanMd(plan),
          actorId: actor.actorId,
          message: 'Create orchestration plan',
        });
        await upsertProjectFile(manager, {
          projectId,
          path: `${basePath.value}/tasks.json`,
          content: '[]\n',
          contentType: 'application/json',
          actorId: actor.actorId,
          message: 'Initialize orchestration task ledger',
        });
        await upsertProjectFile(manager, {
          projectId,
          path: `${basePath.value}/pm-review.md`,
          content: '# PM Review\n\nNo reviews yet.\n',
          actorId: actor.actorId,
          message: 'Initialize PM review log',
        });

        return created;
      });

      res.status(201).json(serializeOrchestration(orchestration));
    } catch (err) {
      console.error('Create orchestration error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/orchestrations',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const qb = AppDataSource.getRepository(ProjectOrchestration)
        .createQueryBuilder('orchestration')
        .where('orchestration.projectId = :projectId', { projectId })
        .orderBy('orchestration.createdAt', 'DESC');

      if (status && Object.values(ProjectOrchestrationStatus).includes(status as ProjectOrchestrationStatus)) {
        qb.andWhere('orchestration.status = :status', { status });
      }
      if (req.agent) {
        qb.andWhere(
          '(orchestration.mainAgentId = :agentId OR orchestration.id IN ' +
            qb.subQuery()
              .select('task.orchestrationId')
              .from(ProjectOrchestrationTask, 'task')
              .where('task.assignedAgentId = :agentId')
              .getQuery() +
            ')',
          { agentId: req.agent.id },
        );
      }

      const orchestrations = await qb.getMany();
      res.json({ data: orchestrations.map((orchestration) => serializeOrchestration(orchestration)) });
    } catch (err) {
      console.error('List orchestrations error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/:project_id/loop-status
 *
 * Operational overview for the autonomous loop — a single dashboard payload the
 * PM / main agent polls to monitor loop health: which workers are online,
 * which changesets are awaiting review, how many tasks are running, which
 * tasks have stalled (dispatched/running but quiet for too long), and how the
 * project's orchestrations break down by status.
 *
 * Auth: JWT user OR agent API key, both requiring the ViewProject permission.
 * Agents are already verified (by requirePermission) to belong to this project,
 * so the payload is project-wide — this is an operational overview, not a
 * per-worker scoped view.
 *
 * Response shape:
 *   {
 *     workers: [{ id, name, online, health_status, last_heartbeat_age_seconds }],
 *     pending_changesets: [{ id, title, status, age_minutes }],
 *     running_tasks: number,
 *     stalled_tasks: [{ id, title, status, age_minutes }],
 *     orchestrations: { running, blocked, completed }
 *   }
 */
router.get(
  '/v1/projects/:project_id/loop-status',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const status = await buildLoopStatus(projectId);
      res.json(status);
    } catch (err) {
      console.error('Loop status error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ── R19c: per-worker current load ───────────────────────────────────────────
router.get(
  '/v1/projects/:project_id/worker-load',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const workers = await buildWorkerLoad(projectId);
      res.json({ data: workers });
    } catch (err) {
      console.error('Get worker load error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/:project_id/dashboard
 *
 * Single-call aggregation so the frontend dashboard can render with one request
 * instead of fanning out to five endpoints. Combines loop-status + metrics +
 * worker-load + the 5 most-recent changesets + the 5 most-recent tasks, all
 * produced by the same functions the dedicated endpoints use, so every sub-
 * payload is byte-identical to calling that endpoint directly.
 *
 * Auth: JWT user OR agent API key, ViewProject (same as the underlying views).
 *
 * Response shape:
 *   {
 *     loop_status,         // GET /loop-status payload
 *     metrics,             // GET /metrics payload
 *     worker_load,         // GET /worker-load payload ({ data: [...] })
 *     recent_changesets,   // last 5 by updatedAt, full serializeChangeset shape
 *     recent_tasks,        // last 5 by updatedAt, full serializeTask shape
 *     generated_at         // ISO timestamp of this aggregation
 *   }
 */
router.get(
  '/v1/projects/:project_id/dashboard',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const dashboard = await buildDashboard(projectId);
      res.json(dashboard);
    } catch (err) {
      console.error('Dashboard aggregation error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ── R16c: project loop throughput summary ───────────────────────────────────
router.get(
  '/v1/projects/:project_id/metrics',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      res.json(await buildProjectMetrics(projectId));
    } catch (err) {
      console.error('Get project metrics error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * Build the project loop throughput summary returned by both
 * GET /v1/projects/:project_id/metrics and the aggregated
 * GET /v1/projects/:project_id/dashboard. Pure function over `projectId` so the
 * dashboard reuses the exact same logic as the dedicated metrics endpoint.
 */
async function buildProjectMetrics(projectId: string) {
  const orchestrationRepo = AppDataSource.getRepository(ProjectOrchestration);
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
  const changesetRepo = AppDataSource.getRepository(ProjectChangeset);
  const agentRepo = AppDataSource.getRepository(Agent);

  const [totalOrchestrations, completedOrchestrations, tasks, changesets] = await Promise.all([
    orchestrationRepo.count({ where: { projectId } }),
    orchestrationRepo.count({ where: { projectId, status: ProjectOrchestrationStatus.COMPLETED } }),
    taskRepo.find({ where: { projectId }, relations: ['assignedAgent'] }),
    changesetRepo.find({ where: { projectId } }),
  ]);

  const completedTasks = tasks.filter(
    (task) => task.status === ProjectOrchestrationTaskStatus.APPROVED,
  );

  const autoMergedChangesets = changesets.filter(
    (changeset) => changeset.status === ProjectChangesetStatus.MERGED,
  ).length;
  const rejectedChangesets = changesets.filter(
    (changeset) => changeset.status === ProjectChangesetStatus.REJECTED,
  ).length;

  const avgTaskDurationMinutes = computeAverageDurationMinutes(
    completedTasks.map((task) => ({ start: task.createdAt, end: task.completedAt })),
  );

  const reviewedChangesets = changesets.filter((changeset) => changeset.reviewedAt !== null);
  const avgChangesetReviewTimeMinutes = computeAverageDurationMinutes(
    reviewedChangesets.map((changeset) => ({ start: changeset.createdAt, end: changeset.reviewedAt! })),
  );

  const completedTasksByAgent = groupByAgentId(completedTasks, (task) => task.assignedAgentId);
  const mergedChangesetsByAgent = groupByAgentId(
    changesets.filter((changeset) => changeset.status === ProjectChangesetStatus.MERGED),
    (changeset) => changeset.createdByAgentId,
  );

  const workerAgentIds = new Set<string>([
    ...Object.keys(completedTasksByAgent),
    ...Object.keys(mergedChangesetsByAgent),
  ]);
  const workerAgents = workerAgentIds.size > 0
    ? await agentRepo.findBy({ id: In(Array.from(workerAgentIds)) })
    : [];
  const agentNameById = new Map(workerAgents.map((agent) => [agent.id, agent.name]));

  const workerStats = Array.from(workerAgentIds)
    .map((agentId) => {
      const agentTasks = completedTasksByAgent[agentId] ?? [];
      const agentChangesets = mergedChangesetsByAgent[agentId] ?? [];
      return {
        agent_name: agentNameById.get(agentId) ?? null,
        tasks_completed: agentTasks.length,
        changesets_merged: agentChangesets.length,
        avg_duration_minutes: computeAverageDurationMinutes(
          agentTasks.map((task) => ({ start: task.createdAt, end: task.completedAt })),
        ),
      };
    })
    .sort((a, b) => (a.agent_name ?? '').localeCompare(b.agent_name ?? ''));

  return {
    total_orchestrations: totalOrchestrations,
    completed_orchestrations: completedOrchestrations,
    total_tasks: tasks.length,
    completed_tasks: completedTasks.length,
    auto_merged_changesets: autoMergedChangesets,
    rejected_changesets: rejectedChangesets,
    avg_task_duration_minutes: avgTaskDurationMinutes,
    avg_changeset_review_time_minutes: avgChangesetReviewTimeMinutes,
    worker_stats: workerStats,
  };
}

router.get(
  '/v1/projects/:project_id/orchestrations/:orchestration_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const loaded = await loadOrchestrationWithTasks(req.params.project_id, req.params.orchestration_id);
      if (!loaded) {
        res.status(404).json({ detail: 'Orchestration not found' });
        return;
      }
      if (!canViewOrchestration(req, loaded.orchestration, loaded.tasks)) {
        res.status(403).json({ detail: 'Agent is not part of this orchestration' });
        return;
      }
      res.json(serializeOrchestration(loaded.orchestration, loaded.tasks));
    } catch (err) {
      console.error('Get orchestration error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/timeline',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const orchestrationId = req.params.orchestration_id;

      const orchestration = await loadOrchestration(projectId, orchestrationId);
      if (!orchestration) {
        res.status(404).json({ detail: 'Orchestration not found' });
        return;
      }

      const tasks = await AppDataSource.getRepository(ProjectOrchestrationTask).find({
        where: { projectId, orchestrationId },
        relations: ['assignedAgent'],
        order: { createdAt: 'ASC' },
      });

      if (!canViewOrchestration(req, orchestration, tasks)) {
        res.status(403).json({ detail: 'Agent is not part of this orchestration' });
        return;
      }

      const [changesets] = await Promise.all([
        AppDataSource.getRepository(ProjectChangeset).find({
          where: { projectId, orchestrationId },
          order: { createdAt: 'ASC' },
        }),
      ]);

      const events: Array<{
        timestamp: string;
        event_type: string;
        task_id: string | null;
        task_title: string | null;
        agent_name: string | null;
        from_status: string | null;
        to_status: string | null;
        detail: Record<string, unknown> | null;
      }> = [];

      for (const task of tasks) {
        const agentName = task.assignedAgent?.name ?? null;

        events.push({
          timestamp: task.createdAt.toISOString(),
          event_type: 'task_created',
          task_id: task.id,
          task_title: task.title,
          agent_name: agentName,
          from_status: null,
          to_status: ProjectOrchestrationTaskStatus.PENDING,
          detail: null,
        });

        if (task.dispatchedAt) {
          events.push({
            timestamp: task.dispatchedAt.toISOString(),
            event_type: 'task_dispatched',
            task_id: task.id,
            task_title: task.title,
            agent_name: agentName,
            from_status: ProjectOrchestrationTaskStatus.PENDING,
            to_status: ProjectOrchestrationTaskStatus.DISPATCHED,
            detail: null,
          });
        }

        if (task.claimedAt) {
          events.push({
            timestamp: task.claimedAt.toISOString(),
            event_type: 'task_claimed',
            task_id: task.id,
            task_title: task.title,
            agent_name: agentName,
            from_status: ProjectOrchestrationTaskStatus.DISPATCHED,
            to_status: ProjectOrchestrationTaskStatus.RUNNING,
            detail: null,
          });
        }

        if (task.completedAt) {
          events.push({
            timestamp: task.completedAt.toISOString(),
            event_type: 'task_completed',
            task_id: task.id,
            task_title: task.title,
            agent_name: agentName,
            from_status: ProjectOrchestrationTaskStatus.RUNNING,
            to_status: task.status,
            detail: null,
          });
        }

        if (task.reviewedAt) {
          const reviewDecision = task.status === ProjectOrchestrationTaskStatus.APPROVED
            ? 'approved'
            : task.status === ProjectOrchestrationTaskStatus.CHANGES_REQUESTED
              ? 'changes_requested'
              : null;
          events.push({
            timestamp: task.reviewedAt.toISOString(),
            event_type: 'pm_reviewed',
            task_id: task.id,
            task_title: task.title,
            agent_name: agentName,
            from_status: ProjectOrchestrationTaskStatus.READY_FOR_REVIEW,
            to_status: task.status,
            detail: reviewDecision ? { decision: reviewDecision } : null,
          });
        }
      }

      for (const changeset of changesets) {
        events.push({
          timestamp: changeset.createdAt.toISOString(),
          event_type: 'changeset_submitted',
          task_id: changeset.taskId ?? null,
          task_title: null,
          agent_name: null,
          from_status: null,
          to_status: changeset.status,
          detail: { changeset_id: changeset.id, title: changeset.title },
        });

        if (changeset.mergedAt) {
          events.push({
            timestamp: changeset.mergedAt.toISOString(),
            event_type: 'changeset_merged',
            task_id: changeset.taskId ?? null,
            task_title: null,
            agent_name: null,
            from_status: changeset.status,
            to_status: ProjectChangesetStatus.MERGED,
            detail: { changeset_id: changeset.id, merged_commit_id: changeset.mergedCommitId ?? null },
          });
        }
      }

      events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      res.json({ data: events });
    } catch (err) {
      console.error('Get orchestration timeline error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const orchestration = await loadOrchestration(projectId, req.params.orchestration_id);
      if (!orchestration) {
        res.status(404).json({ detail: 'Orchestration not found' });
        return;
      }
      if (!await ensureMainAgentOrUser(req, res, orchestration)) return;

      const title = normalizeRequiredString(req.body.title, 'title', 255);
      const goal = normalizeRequiredString(req.body.goal, 'goal', 20_000);
      if (!title.ok) {
        res.status(422).json({ detail: title.error });
        return;
      }
      if (!goal.ok) {
        res.status(422).json({ detail: goal.error });
        return;
      }

      const assignedAgentId = typeof req.body.assigned_agent_id === 'string'
        ? req.body.assigned_agent_id.trim()
        : null;
      if (assignedAgentId && !await ensureAgentsExistAndDispatchable(res, projectId, [assignedAgentId])) return;

      // ── R18a: idempotent dispatch — reject duplicate active task ──────────
      // A duplicate = same dedup_hash (normalized title+goal) for the same agent
      // in this orchestration, while the prior task is still in an active status
      // (dispatched/running/changes_requested). Terminal or review-state tasks
      // free up the slot so the same logical task can be dispatched again.
      const dedupHash = computeDedupHash(title.value, goal.value);
      const dedupWhere: FindOptionsWhere<ProjectOrchestrationTask> = {
        orchestrationId: orchestration.id,
        status: In(TASK_DEDUP_ACTIVE_STATUSES),
        assignedAgentId: assignedAgentId ? assignedAgentId : IsNull(),
      };
      const activeForAgent = await AppDataSource.getRepository(ProjectOrchestrationTask).find({ where: dedupWhere });
      const duplicate = activeForAgent.find(
        (t) => (t.metadata as Record<string, unknown> | null | undefined)?.dedup_hash === dedupHash,
      );
      if (duplicate) {
        res.status(409).json({ detail: 'duplicate active task', existing_task_id: duplicate.id });
        return;
      }

      const task = await createAndDispatchOrchestrationTask({
        projectId,
        orchestration,
        actor,
        title: title.value,
        goal: goal.value,
        assignedAgentId,
        requiredCapability: normalizeCapability(req.body.required_capability),
        scope: req.body.scope,
        context: req.body.context,
        acceptanceCriteria: normalizeStringArray(req.body.acceptance_criteria),
        dependsOn: normalizeStringArray(req.body.depends_on),
        priority: normalizeTaskPriority(req.body.priority),
        maxRetries: normalizeTaskRetryLimit(req.body.max_retries),
        dispatch: req.body.dispatch !== false,
      });

      res.status(201).json(serializeTask(task));
    } catch (err) {
      console.error('Create orchestration task error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/orchestrations/:orchestration_id/tasks/smart-dispatch
 *
 * Auto-select the best available worker and dispatch a task to it in a single
 * call. Selection pipeline:
 *   (1) project agents that are online (fresh heartbeat) and not smoke-unhealthy,
 *   (2) when `required_capability` is given, keep only agents whose capabilities
 *       contain it,
 *   (3) pick the agent with the fewest in-flight (active) tasks — tie-break by
 *       agent name for determinism.
 * Then create + dispatch the task to the chosen agent.
 *
 * Body: { title, goal, required_capability? }
 * Auth: project-level / orchestration main agent or any user (SendMessage).
 * 201 → { task_id, assigned_agent_id, assigned_agent_name, selection_reason }
 * 409 when no eligible worker is available.
 */
router.post(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks/smart-dispatch',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const orchestration = await loadOrchestration(projectId, req.params.orchestration_id);
      if (!orchestration) {
        res.status(404).json({ detail: 'Orchestration not found' });
        return;
      }
      if (!await ensureMainAgentOrUser(req, res, orchestration)) return;

      const title = normalizeRequiredString(req.body.title, 'title', 255);
      const goal = normalizeRequiredString(req.body.goal, 'goal', 20_000);
      if (!title.ok) {
        res.status(422).json({ detail: title.error });
        return;
      }
      if (!goal.ok) {
        res.status(422).json({ detail: goal.error });
        return;
      }
      const requiredCapability = normalizeCapability(req.body.required_capability);

      const selection = await selectBestWorker(projectId, requiredCapability);
      if (!selection) {
        res.status(409).json({
          detail: 'No eligible worker available for smart dispatch',
          code: 'NO_ELIGIBLE_WORKER',
          required_capability: requiredCapability,
        });
        return;
      }

      const task = await createAndDispatchOrchestrationTask({
        projectId,
        orchestration,
        actor,
        title: title.value,
        goal: goal.value,
        assignedAgentId: selection.agentId,
        requiredCapability,
        dispatch: true,
      });

      res.status(201).json({
        task_id: task.id,
        assigned_agent_id: selection.agentId,
        assigned_agent_name: selection.agentName,
        selection_reason: selection.reason,
      });
    } catch (err) {
      console.error('Smart dispatch task error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const loaded = await loadOrchestrationWithTasks(req.params.project_id, req.params.orchestration_id);
      if (!loaded) {
        res.status(404).json({ detail: 'Orchestration not found' });
        return;
      }
      if (!canViewOrchestration(req, loaded.orchestration, loaded.tasks)) {
        res.status(403).json({ detail: 'Agent is not part of this orchestration' });
        return;
      }
      res.json({ data: loaded.tasks.map(serializeTask) });
    } catch (err) {
      console.error('List orchestration tasks error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id/capable-agents',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const task = await loadTask(req.params.project_id, req.params.orchestration_id, req.params.task_id);
      if (!task) {
        res.status(404).json({ detail: 'Task not found' });
        return;
      }
      if (req.agent && task.assignedAgentId !== req.agent.id && task.orchestration.mainAgentId !== req.agent.id) {
        res.status(403).json({ detail: 'Agent is not part of this task' });
        return;
      }

      const requiredCapability = normalizeCapability(task.requiredCapability);
      const agentRepo = AppDataSource.getRepository(Agent);
      const qb = agentRepo
        .createQueryBuilder('agent')
        .where('agent.projectId = :projectId', { projectId: task.projectId })
        .andWhere('agent.lifecycleStatus = :lifecycleStatus', { lifecycleStatus: AgentLifecycleStatus.ACTIVE });

      if (requiredCapability) {
        qb.andWhere('agent.capabilities LIKE :capability ESCAPE \'!\'', {
          capability: `%${escapeLikePattern(requiredCapability)}%`,
        });
      }

      const agents = await qb
        .orderBy('agent.name', 'ASC')
        .getMany();

      const capableAgents = agents.filter((agent) => {
        const presence = getAgentPresence(agent);
        if (!presence.dispatchable) return false;
        if (!requiredCapability) return true;
        return normalizeCapabilities(agent.capabilities).includes(requiredCapability);
      });

      res.json({
        data: capableAgents.map(serializeCapableAgent),
        required_capability: requiredCapability,
      });
    } catch (err) {
      console.error('List capable agents error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const task = await loadTask(req.params.project_id, req.params.orchestration_id, req.params.task_id);
      if (!task) {
        res.status(404).json({ detail: 'Task not found' });
        return;
      }
      if (req.agent && task.assignedAgentId !== req.agent.id && task.orchestration.mainAgentId !== req.agent.id) {
        res.status(403).json({ detail: 'Agent is not part of this task' });
        return;
      }
      res.json(serializeTask(task));
    } catch (err) {
      console.error('Get orchestration task error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/orchestration-tasks',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const {
        status: statusFilter,
        q,
        assigned_agent_id: assignedAgentId,
        limit: limitParam,
        offset: offsetParam,
        sort: sortParam,
      } = req.query;

      // Agent callers cannot use assigned_agent_id to view another agent's tasks.
      if (req.agent && assignedAgentId && typeof assignedAgentId === 'string' && assignedAgentId !== req.agent.id) {
        res.status(403).json({ detail: 'Agent cannot filter by another agent' });
        return;
      }

      const statuses = parseStatusFilter(statusFilter);
      const invalidStatuses = statuses.filter(
        (s) => !Object.values(ProjectOrchestrationTaskStatus).includes(s as ProjectOrchestrationTaskStatus),
      );
      if (invalidStatuses.length > 0) {
        res.status(422).json({ detail: `Invalid status values: ${invalidStatuses.join(', ')}` });
        return;
      }

      const { limit, offset } = parsePagination(limitParam, offsetParam);
      const sort = parseSort(sortParam);

      const baseQb = AppDataSource.getRepository(ProjectOrchestrationTask)
        .createQueryBuilder('task')
        .innerJoinAndSelect('task.orchestration', 'orchestration')
        .where('task.projectId = :projectId', { projectId });

      if (statuses.length > 0) {
        baseQb.andWhere('task.status IN (:...statuses)', { statuses });
      }

      if (q && typeof q === 'string' && q.trim()) {
        const pattern = `%${escapeLikePattern(q.trim())}%`;
        baseQb.andWhere(
          new Brackets((subQb) => {
            subQb
              .where('task.title LIKE :q ESCAPE \'!\'', { q: pattern })
              .orWhere('task.goal LIKE :q ESCAPE \'!\'', { q: pattern })
              .orWhere('orchestration.title LIKE :q ESCAPE \'!\'', { q: pattern });
          }),
        );
      }

      if (assignedAgentId && typeof assignedAgentId === 'string') {
        baseQb.andWhere('task.assignedAgentId = :assignedAgentId', { assignedAgentId });
      }

      // Agent callers see only tasks in their visible scope: assigned to them,
      // or in orchestrations where they are the main agent / an assigned worker.
      if (req.agent) {
        const agentId = req.agent.id;
        baseQb.andWhere(
          new Brackets((subQb) => {
            subQb
              .where('task.assignedAgentId = :agentId', { agentId })
              .orWhere('orchestration.mainAgentId = :agentId', { agentId })
              .orWhere(
                'EXISTS (SELECT 1 FROM project_orchestration_tasks t2 WHERE t2.orchestration_id = task.orchestrationId AND t2.assigned_agent_id = :agentId)',
                { agentId },
              );
          }),
        );
      }

      const countQb = baseQb.clone();
      const total = await countQb.getCount();

      const dataQb = baseQb.clone();
      applyTaskSort(dataQb, sort);
      dataQb.skip(offset).take(limit);
      const tasks = await dataQb.getMany();

      const summaryQb = baseQb.clone();
      summaryQb
        .select('task.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('task.status');
      const statusCountRows = (await summaryQb.getRawMany()) as { status: ProjectOrchestrationTaskStatus; count: string }[];
      const statusSummary = buildSummary(statusCountRows);

      const [assignees, orchestrations, batches, timeline] = await Promise.all([
        buildAssigneeSummary(baseQb),
        buildOrchestrationSummary(baseQb),
        buildBatchSummary(baseQb),
        buildTimelineSummary(baseQb),
      ]);

      res.json({
        data: tasks.map((task) => serializeProjectTaskRow(task)),
        total,
        limit,
        offset,
        summary: {
          ...statusSummary,
          assignees,
          orchestrations,
          batches,
          timeline,
        },
      });
    } catch (err) {
      console.error('List project orchestration tasks error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/orchestration-tasks/:task_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const taskId = req.params.task_id;
      const task = await loadProjectTask(projectId, taskId);
      if (!task) {
        res.status(404).json({ detail: 'Task not found' });
        return;
      }
      if (req.agent && !(await canViewProjectTask(task, req.agent.id))) {
        res.status(403).json({ detail: 'Agent is not part of this task' });
        return;
      }
      const related = await loadProjectTaskRelatedChanges(projectId, taskId);
      res.json(serializeProjectTaskRow(task, related));
    } catch (err) {
      console.error('Get project orchestration task error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id/claim',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const task = await loadTask(req.params.project_id, req.params.orchestration_id, req.params.task_id);
      if (!task) {
        res.status(404).json({ detail: 'Task not found' });
        return;
      }
      if (!ensureAssignedWorkerOrUser(req, res, task)) return;

      // ── Pessimistic-lock claim ─────────────────────────────────────────────
      // Use SELECT ... FOR UPDATE inside a transaction so that concurrent
      // workers are serialised at the DB level — the second worker blocks until
      // the first commits, then sees the already-running status and gets 409.
      const claimableStatuses = [
        ProjectOrchestrationTaskStatus.PENDING,
        ProjectOrchestrationTaskStatus.DISPATCHED,
        ProjectOrchestrationTaskStatus.READY_FOR_REVIEW,
        ProjectOrchestrationTaskStatus.CHANGES_REQUESTED,
        ProjectOrchestrationTaskStatus.BLOCKED,
        ProjectOrchestrationTaskStatus.FAILED,
      ];

      const queryRunner = AppDataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      let claimedTask: ProjectOrchestrationTask | null = null;
      let previousStatus: ProjectOrchestrationTaskStatus | undefined;
      try {
        // WHY no leftJoin here: PostgreSQL rejects `FOR UPDATE` applied to the
        // nullable side of an OUTER JOIN. `task.orchestration` is nullable, so
        // joining it under setLock('pessimistic_write') throws
        // "FOR UPDATE cannot be applied to the nullable side of an outer join"
        // → claim returns 500 → no worker can claim any task. We therefore lock
        // ONLY the task row here, and re-fetch orchestration separately below
        // (the `claimedTask` re-load uses `relations: ['orchestration']`).
        // See tests/claim-no-nullable-join.test.ts — this exact shape is asserted.
        const lockQb = queryRunner.manager
          .createQueryBuilder(ProjectOrchestrationTask, 'task')
          .where('task.id = :id', { id: task.id });
        if (AppDataSource.options.type === 'postgres') {
          lockQb.setLock('pessimistic_write');
        }
        const lockedTask = await lockQb.getOne();

        if (!lockedTask) {
          await queryRunner.rollbackTransaction();
          res.status(404).json({ detail: 'Task not found' });
          return;
        }

        previousStatus = lockedTask.status;

        // Allow re-claim by the same worker (idempotent).
        if (
          lockedTask.status === ProjectOrchestrationTaskStatus.RUNNING &&
          req.agent && lockedTask.assignedAgentId === req.agent.id
        ) {
          await queryRunner.rollbackTransaction();
          res.json(serializeTask(lockedTask));
          return;
        }

        if (claimableStatuses.includes(lockedTask.status)) {
          const dependencyCheck = await checkDependenciesMet(lockedTask);
          if (!dependencyCheck.met) {
            await queryRunner.rollbackTransaction();
            res.status(409).json({
              detail: 'Task has unmet dependencies',
              code: 'DEPENDENCIES_NOT_MET',
              unmet: dependencyCheck.unmet,
            });
            return;
          }
        }

        const updateFields: Record<string, unknown> = {
          status: ProjectOrchestrationTaskStatus.RUNNING,
        };
        if (req.agent && !lockedTask.assignedAgentId) {
          updateFields.assignedAgentId = req.agent.id;
        }

        const claimResult = await queryRunner.manager
          .createQueryBuilder()
          .update(ProjectOrchestrationTask)
          .set(updateFields)
          .where('id = :id', { id: lockedTask.id })
          .andWhere('status IN (:...claimableStatuses)', { claimableStatuses })
          .execute();

        if (claimResult.affected === 0) {
          await queryRunner.rollbackTransaction();
          res.status(409).json({ detail: `Task cannot be claimed from status ${lockedTask.status}` });
          return;
        }

        claimedTask = await queryRunner.manager.findOne(ProjectOrchestrationTask, {
          where: { id: lockedTask.id },
          relations: ['orchestration'],
        });
        if (!claimedTask) {
          await queryRunner.rollbackTransaction();
          res.status(404).json({ detail: 'Task not found after claim' });
          return;
        }
        claimedTask.claimedAt = claimedTask.claimedAt ?? new Date();
        await queryRunner.manager.save(claimedTask);
        await refreshTaskLedger(queryRunner.manager, claimedTask.orchestration, actor.actorId);
        await queryRunner.commitTransaction();
      } catch (txErr) {
        await queryRunner.rollbackTransaction();
        throw txErr;
      } finally {
        await queryRunner.release();
      }

      publishTaskStatusChanged(
        claimedTask.orchestration.sessionId,
        claimedTask.orchestration.projectId,
        claimedTask,
        previousStatus,
      );

      try {
        if (claimedTask.orchestration.sessionId) {
          eventStreamService.publish(claimedTask.orchestration.sessionId, {
            projectId: claimedTask.orchestration.projectId,
            sessionId: claimedTask.orchestration.sessionId,
            agentId: req.agent?.id ?? claimedTask.assignedAgentId ?? undefined,
            type: 'task_claimed',
            payload: {
              taskId: claimedTask.id,
              agentId: req.agent?.id ?? claimedTask.assignedAgentId ?? undefined,
            },
          });
        }
      } catch (streamErr) {
        console.warn('Failed to publish task_claimed event:', streamErr);
      }

      res.json(serializeTask(claimedTask));
    } catch (err) {
      console.error('Claim orchestration task error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id/progress',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const task = await loadTask(req.params.project_id, req.params.orchestration_id, req.params.task_id);
      if (!task) {
        res.status(404).json({ detail: 'Task not found' });
        return;
      }
      if (!ensureAssignedWorkerAgent(req, res, task)) return;

      if (req.body.progress_note !== undefined && typeof req.body.progress_note !== 'string') {
        res.status(422).json({ detail: 'progress_note must be a string' });
        return;
      }
      const progressPercent = normalizeProgressPercent(req.body.progress_percent);
      if (!progressPercent.ok) {
        res.status(422).json({ detail: progressPercent.error });
        return;
      }

      if (req.body.progress_note !== undefined) {
        const note = req.body.progress_note.trim().slice(0, 20_000);
        task.progressNote = note || null;
      }
      if (progressPercent.present) {
        task.progressPercent = progressPercent.value;
      }
      task.progressAt = new Date();

      const updated = await AppDataSource.getRepository(ProjectOrchestrationTask).save(task);
      res.json(serializeTask(updated));
    } catch (err) {
      console.error('Update orchestration task progress error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id/complete',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const task = await loadTask(projectId, req.params.orchestration_id, req.params.task_id);
      if (!task) {
        res.status(404).json({ detail: 'Task not found' });
        return;
      }
      if (!ensureAssignedWorkerOrUser(req, res, task)) return;
      if (task.status === ProjectOrchestrationTaskStatus.APPROVED || task.status === ProjectOrchestrationTaskStatus.CANCELLED) {
        res.status(409).json({ detail: `Task cannot be completed from status ${task.status}` });
        return;
      }

      const resultMd = typeof req.body.result_md === 'string' ? req.body.result_md.trim() : '';
      if (!resultMd) {
        res.status(422).json({ detail: 'result_md is required' });
        return;
      }
      const evidenceInput = normalizeTaskEvidence(req.body.evidence);
      if (!evidenceInput.ok) {
        res.status(422).json({ detail: evidenceInput.error });
        return;
      }
      const verification = await verifyTaskCompletion(task, resultMd, evidenceInput.value);
      if (!verification.passed) {
        res.status(422).json({
          detail: 'Task verification failed',
          code: 'VERIFICATION_FAILED',
          failures: verification.failures,
        });
        return;
      }
      const evidence = normalizeEvidence(req.body.evidence);
      const nextStatus = normalizeCompletionStatus(req.body.status);
      if (!nextStatus) {
        res.status(422).json({ detail: 'status must be ready_for_review, blocked, or failed' });
        return;
      }

      const safeResultMd = redactMarkdown(resultMd);
      const safeEvidence = redactValue(evidence) as Record<string, unknown>;

      const completion = await AppDataSource.transaction(async (manager) => {
        const resultPath = `${task.orchestration.basePath}/workers/${task.id}.result.md`;
        const evidencePath = `${task.orchestration.basePath}/workers/${task.id}.evidence.json`;

        await upsertProjectFile(manager, {
          projectId,
          path: resultPath,
          content: safeResultMd.endsWith('\n') ? safeResultMd : `${safeResultMd}\n`,
          actorId: actor.actorId,
          message: `Worker result for ${task.id}`,
        });
        await upsertProjectFile(manager, {
          projectId,
          path: evidencePath,
          content: JSON.stringify(safeEvidence, null, 2) + '\n',
          contentType: 'application/json',
          actorId: actor.actorId,
          message: `Worker evidence for ${task.id}`,
        });

        task.resultPath = resultPath;
        task.evidencePath = evidencePath;
        task.evidenceJson = evidenceInput.value;
        task.status = nextStatus;
        task.completedAt = new Date();
        // A worker submitting completion has engaged the task; backfill the claim
        // phase if the explicit /claim step was skipped (dispatched -> complete).
        task.claimedAt = task.claimedAt ?? new Date();
        task.reviewNotes = null;
        task.requestedChanges = null;
        (task as any).reviewedAt = null;

        // ── MD artifacts: RESULT.md, EVIDENCE.md, CHANGELOG.md ─────────
        const resultMdPath = await writeResultMd(manager, task, safeResultMd);
        const evMdPath = await writeEvidenceMd(manager, task, safeEvidence);
        const chgMdPath = await writeChangelogMd(manager, task, safeResultMd, safeEvidence);

        const taskDir = taskMdDir(task.orchestration.basePath, task.id);
        setMdArtifactPaths(task, {
          task_dir: taskDir,
          task: `${taskDir}/TASK.md`,
          result: resultMdPath,
          evidence: evMdPath,
          changelog: chgMdPath,
        });

        if (
          nextStatus === ProjectOrchestrationTaskStatus.FAILED &&
          (task.retryCount ?? 0) < (task.maxRetries ?? 2)
        ) {
          task.retryCount = (task.retryCount ?? 0) + 1;
          task.status = ProjectOrchestrationTaskStatus.DISPATCHED;
          task.completedAt = undefined;
          task.reviewNotes = null;
          task.requestedChanges = null;
          task.reviewedAt = undefined;
          task.progressNote = null;
          task.progressPercent = null;
          task.progressAt = null;
          task.dispatchedAt = new Date();
          task.metadata = {
            ...(task.metadata ?? {}),
            last_retry_at: task.dispatchedAt.toISOString(),
            last_retry_reason: 'worker reported failed',
          };
          await manager.save(ProjectOrchestrationTask, task);

          if (
            task.orchestration.status === ProjectOrchestrationStatus.PLANNING ||
            task.orchestration.status === ProjectOrchestrationStatus.BLOCKED ||
            task.orchestration.status === ProjectOrchestrationStatus.FAILED
          ) {
            task.orchestration.status = ProjectOrchestrationStatus.RUNNING;
            await manager.save(ProjectOrchestration, task.orchestration);
          }
          await refreshTaskLedger(manager, task.orchestration, actor.actorId);
          console.log(
            `Retrying failed task ${task.id}: retry_count=${task.retryCount}, max_retries=${task.maxRetries ?? 2}`,
          );
          return { task, retried: true };
        }

        await manager.save(ProjectOrchestrationTask, task);

        if (nextStatus === ProjectOrchestrationTaskStatus.BLOCKED) {
          task.orchestration.status = ProjectOrchestrationStatus.BLOCKED;
        } else if (nextStatus === ProjectOrchestrationTaskStatus.FAILED) {
          task.orchestration.status = ProjectOrchestrationStatus.FAILED;
          // Auto-Triage: create a fix task when retries exhausted (gk Pro R6)
          // Loop Guard: max 3 auto-triaged fix tasks per orchestration (gk Pro R7)
          if ((task.retryCount ?? 0) >= (task.maxRetries ?? 2)) {
            const existingFixTasks = await manager.getRepository(ProjectOrchestrationTask).count({
              where: { orchestrationId: task.orchestrationId },
            });
            const autoFixCount = await manager
              .createQueryBuilder(ProjectOrchestrationTask, 't')
              .where('t.orchestrationId = :oid', { oid: task.orchestrationId })
              .andWhere("t.metadata LIKE '%auto_triaged%'")
              .getCount();
            if (autoFixCount < 3) {
              const fixTask = manager.create(ProjectOrchestrationTask, {
                projectId: task.projectId,
                orchestrationId: task.orchestrationId,
                title: `Fix: ${(task.title || '').slice(0, 180)}`,
                goal: `Previous task failed after ${task.retryCount ?? 0} retries. Original goal: ${(task.goal || '').slice(0, 300)} Review the failure and provide a corrected implementation.`,
                status: ProjectOrchestrationTaskStatus.DISPATCHED,
                assignedAgentId: task.assignedAgentId,
                workerTaskPath: `.agent/orchestrations/${task.orchestrationId}/workers/auto-fix-${Date.now()}.worker_task.md`,
                workerContextPath: `.agent/orchestrations/${task.orchestrationId}/workers/auto-fix-${Date.now()}.worker_context.md`,
                dispatchedAt: new Date(),
                metadata: { auto_triaged: true, source_task: task.id, fix_round: autoFixCount + 1 },
              });
              await manager.save(ProjectOrchestrationTask, fixTask);
              console.log(`[auto-triage] created fix task ${autoFixCount + 1}/3 for failed task ${task.id}`);
            } else {
              console.log(`[auto-triage] loop guard: max 3 fix tasks reached for orchestration ${task.orchestrationId}, stopping`);
            }
          }
        } else if (
          task.orchestration.status === ProjectOrchestrationStatus.PLANNING ||
          task.orchestration.status === ProjectOrchestrationStatus.BLOCKED ||
          task.orchestration.status === ProjectOrchestrationStatus.FAILED
        ) {
          task.orchestration.status = ProjectOrchestrationStatus.RUNNING;
        }
        await manager.save(ProjectOrchestration, task.orchestration);
        await refreshTaskLedger(manager, task.orchestration, actor.actorId);

        // ── Auto-create a changeset so the main agent can review+merge the
        // worker's deliverable. Only when the worker actually produced a
        // ready_for_review result (not for blocked/failed). The changeset is
        // declarative: it references the RESULT.md already written above, with
        // base_revision_id pointing at that revision so merge won't conflict.
        if (nextStatus === ProjectOrchestrationTaskStatus.READY_FOR_REVIEW) {
          try {
            await createTaskCompletionChangeset(manager, {
              projectId,
              task,
              actor,
              resultMdPath,
              resultMdContent: safeResultMd,
              legacyResultPath: resultPath,
              legacyEvidencePath: evidencePath,
            });
          } catch (csErr) {
            // Best-effort: never fail the completion on a changeset error.
            console.error('Auto-create changeset on complete failed:', csErr);
          }
        }

        return { task, retried: false };
      });

      const updated = completion.task;
      publishTaskStatusChanged(
        updated.orchestration.sessionId,
        projectId,
        updated,
        ProjectOrchestrationTaskStatus.RUNNING,
      );

      if (completion.retried) {
        await dispatchTaskToAssignedAgent({
          projectId,
          orchestration: updated.orchestration,
          task: updated,
          actorId: actor.actorId,
          retry: true,
        });

        try {
          if (updated.orchestration.sessionId) {
            eventStreamService.publish(updated.orchestration.sessionId, {
              projectId,
              sessionId: updated.orchestration.sessionId,
              agentId: req.agent?.id ?? updated.assignedAgentId ?? undefined,
              type: 'task_completed',
              payload: {
                taskId: updated.id,
                agentId: req.agent?.id ?? updated.assignedAgentId ?? undefined,
                status: updated.status,
              },
            });
          }
        } catch (streamErr) {
          console.warn('Failed to publish task_completed event:', streamErr);
        }

        res.json(serializeTask(updated));
        return;
      }

      await notifyAgentInSession({
        projectId,
        sessionId: updated.orchestration.sessionId ?? null,
        actorId: actor.actorId,
        recipientAgentId: updated.orchestration.mainAgentId ?? null,
        content: [
          `Task ${updated.status}: ${updated.title}`,
          '',
          `Task ID: ${updated.id}`,
          updated.resultPath ? `Result file: ${updated.resultPath}` : null,
          updated.evidencePath ? `Evidence file: ${updated.evidencePath}` : null,
          '',
          'PM should review this task and either approve or request changes.',
        ].filter(Boolean).join('\n'),
        idempotencyKey: `orchestration:${updated.orchestrationId}:task:${updated.id}:complete:${Date.now()}`,
      });

      // Durable inbox: notify main agent(s) of task completion.
      // Notify BOTH orchestration-level mainAgent AND project-level mainAgent,
      // so whoever is the current project PM always receives review notifications
      // without needing to switch every orchestration individually.
      const reviewBody = [
        `Task ID: ${updated.id}`,
        `Status: ${updated.status}`,
        updated.resultPath ? `Result: ${updated.resultPath}` : '',
        '',
        '## Review Actions (execute now)',
        '',
        '1. Check auto-changeset: GET /v1/projects/<pid>/changesets?task_id=<task_id>',
        '2. Approve + merge: zz changesets approve-and-merge <cs_id> -p <pid>',
        '3. Approve task: zz tasks review -p <pid> -o <oid> <tid> --decision approved',
        '',
        'Or via API:',
        '   PATCH /v1/projects/<pid>/changesets/<cs_id>/review {"decision":"approved"}',
        '   POST /v1/projects/<pid>/changesets/<cs_id>/merge',
        '   PATCH /v1/projects/<pid>/orchestrations/<oid>/tasks/<tid>/review {"decision":"approved"}',
        '',
        'If changes needed: decision "changes_requested" + requested_changes field.',
      ].filter(Boolean).join('\n');

      const reviewRecipients = new Set<string>();
      if (updated.orchestration.mainAgentId) reviewRecipients.add(updated.orchestration.mainAgentId);

      // Also notify the project-level main agent (may differ from orchestration PM).
      try {
        const projMain = await AppDataSource.getRepository(Project).findOne({
          where: { id: projectId },
          select: ['id', 'mainAgentId'],
        });
        if (projMain?.mainAgentId) reviewRecipients.add(projMain.mainAgentId);
      } catch {}

      for (const pmAgentId of reviewRecipients) {
        await createInboxItem({
          projectId,
          recipientAgentId: pmAgentId,
          eventType: `task_${updated.status}`,
          title: `Task ${updated.status}: ${updated.title}`,
          body: reviewBody,
          orchestrationId: updated.orchestrationId,
          taskId: updated.id,
        }).catch(() => {});

        // Also push a nudge so PM sees it on next heartbeat.
        try {
          await createInboxItem({
            projectId,
            recipientAgentId: pmAgentId,
            eventType: 'execution_nudge' as any,
            title: `🔔 Review needed: ${updated.title} (${updated.status})`,
            body: [
              'A worker submitted work for your review.',
              '',
              'Quick action:',
              '  zz changesets approve-and-merge <cs_id> -p <pid>',
              '  zz tasks review -p <pid> -o <oid> <tid> --decision approved',
            ].join('\n'),
          }).catch(() => {});
        } catch {}
      }

      // Workload ledger: create/update work unit for worker
      if (updated.assignedAgentId) {
        await upsertWorkUnit({
          projectId,
          agentId: updated.assignedAgentId,
          sourceEvent: `task_${updated.status}`,
          orchestrationId: updated.orchestrationId,
          taskId: updated.id,
          status: updated.status === 'ready_for_review' ? 'completed'
            : updated.status === 'blocked' ? 'blocked'
            : 'failed',
          completedAt: new Date(),
          sourceType: 'orchestration_task',
          provisionalWorkUnits: 1.0,
          idempotencyKey: `wu:${updated.orchestrationId}:${updated.id}:${updated.assignedAgentId}`,
        });
      }

      try {
        if (updated.orchestration.sessionId) {
          eventStreamService.publish(updated.orchestration.sessionId, {
            projectId,
            sessionId: updated.orchestration.sessionId,
            agentId: req.agent?.id ?? updated.assignedAgentId ?? undefined,
            type: 'task_completed',
            payload: {
              taskId: updated.id,
              agentId: req.agent?.id ?? updated.assignedAgentId ?? undefined,
              status: updated.status,
            },
          });
        }
      } catch (streamErr) {
        console.warn('Failed to publish task_completed event:', streamErr);
      }

      res.json(serializeTask(updated));
    } catch (err) {
      console.error('Complete orchestration task error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id/review',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const task = await loadTask(req.params.project_id, req.params.orchestration_id, req.params.task_id);
      if (!task) {
        res.status(404).json({ detail: 'Task not found' });
        return;
      }
      if (!await ensureMainAgentOrUser(req, res, task.orchestration)) return;
      if (task.status !== ProjectOrchestrationTaskStatus.READY_FOR_REVIEW) {
        res.status(409).json({ detail: `Task must be ready_for_review before review, current status is ${task.status}` });
        return;
      }

      const decision = req.body.decision;
      if (decision !== 'approved' && decision !== 'changes_requested') {
        res.status(422).json({ detail: 'decision must be approved or changes_requested' });
        return;
      }
      const notes = typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 20_000) : '';
      const requestedChanges = typeof req.body.requested_changes === 'string'
        ? req.body.requested_changes.trim().slice(0, 20_000)
        : '';
      if (decision === 'changes_requested' && !requestedChanges) {
        res.status(422).json({ detail: 'requested_changes is required when decision is changes_requested' });
        return;
      }

      const updated = await AppDataSource.transaction(async (manager) => {
        task.status = decision === 'approved'
          ? ProjectOrchestrationTaskStatus.APPROVED
          : ProjectOrchestrationTaskStatus.CHANGES_REQUESTED;
        task.reviewNotes = notes || null;
        task.requestedChanges = decision === 'changes_requested' ? requestedChanges : null;
        task.reviewedAt = new Date();
        await manager.save(ProjectOrchestrationTask, task);

        await appendPmReview(manager, task.orchestration, task, {
          decision,
          notes,
          requestedChanges,
          actorId: actor.actorId,
        });

        // ── MD artifact: REVIEW.md ─────────────────────────────────────
        const reviewPath = await writeReviewMd(manager, task.orchestration, task, {
          decision,
          notes,
          requestedChanges,
          actorId: actor.actorId,
        });

        const taskDir = taskMdDir(task.orchestration.basePath, task.id);
        setMdArtifactPaths(task, { review: reviewPath });
        await manager.save(ProjectOrchestrationTask, task);

        const allTasks = await manager.find(ProjectOrchestrationTask, {
          where: { orchestrationId: task.orchestrationId },
          order: { createdAt: 'ASC' },
        });
        if (decision === 'approved' && allTasks.length > 0 && allTasks.every((item) => item.status === ProjectOrchestrationTaskStatus.APPROVED)) {
          task.orchestration.status = ProjectOrchestrationStatus.READY_FOR_ACCEPTANCE;
        } else if (decision === 'changes_requested') {
          task.orchestration.status = ProjectOrchestrationStatus.RUNNING;
        }
        await manager.save(ProjectOrchestration, task.orchestration);
        await refreshTaskLedger(manager, task.orchestration, actor.actorId);

        return task;
      });

      if (decision === 'changes_requested') {
        await notifyAgentInSession({
          projectId: updated.projectId,
          sessionId: updated.orchestration.sessionId ?? null,
          actorId: actor.actorId,
          recipientAgentId: updated.assignedAgentId ?? null,
          content: [
            `Changes requested: ${updated.title}`,
            '',
            `Task ID: ${updated.id}`,
            requestedChanges,
            '',
            'Please revise the result and call the complete endpoint again.',
          ].join('\n'),
          idempotencyKey: `orchestration:${updated.orchestrationId}:task:${updated.id}:changes:${Date.now()}`,
        });

        // Durable inbox: notify worker of changes requested
        if (updated.assignedAgentId) {
          await createInboxItem({
            projectId: updated.projectId,
            recipientAgentId: updated.assignedAgentId,
            eventType: 'task_changes_requested',
            title: `Changes requested: ${updated.title}`,
            body: `Task ID: ${updated.id}. ${requestedChanges}`,
            orchestrationId: updated.orchestrationId,
            taskId: updated.id,
          });
        }
      }

      if (decision === 'approved') {
        // Clear the worker's original task_dispatched / task_ready_for_review
        // notifications now that the task reached a terminal state — otherwise
        // they linger as "ghost" notifications pointing at a finished task.
        if (updated.assignedAgentId) {
          await ackInboxItemsForTask(updated.assignedAgentId, updated.id).catch((e: any) =>
            console.error('Failed to ack worker inbox on approval:', e));
        }
        // Also clear any PM-facing review notifications for this task.
        const reviewRecipients = new Set<string>();
        if (updated.orchestration.mainAgentId) reviewRecipients.add(updated.orchestration.mainAgentId);
        for (const rid of reviewRecipients) {
          await ackInboxItemsForTask(rid, updated.id).catch(() => {});
        }
        // Durable inbox: informational approval notification to worker
        if (updated.assignedAgentId) {
          await createInboxItem({
            projectId: updated.projectId,
            recipientAgentId: updated.assignedAgentId,
            eventType: 'task_approved',
            title: `Task approved: ${updated.title}`,
            body: `Task ID: ${updated.id}. Your work has been approved.`,
            orchestrationId: updated.orchestrationId,
            taskId: updated.id,
          });
        }
      }

      publishTaskStatusChanged(
        updated.orchestration.sessionId,
        updated.projectId,
        updated,
        ProjectOrchestrationTaskStatus.READY_FOR_REVIEW,
      );

      // Workload ledger: update work unit with review decision
      if (updated.assignedAgentId) {
        await updateWorkUnitOnReview(updated.id, updated.assignedAgentId, decision);
      }

      try {
        if (updated.orchestration.sessionId) {
          eventStreamService.publish(updated.orchestration.sessionId, {
            projectId: updated.projectId,
            sessionId: updated.orchestration.sessionId,
            agentId: req.agent?.id ?? undefined,
            type: 'task_reviewed',
            payload: {
              taskId: updated.id,
              agentId: req.agent?.id ?? undefined,
              decision,
            },
          });
        }
      } catch (streamErr) {
        console.warn('Failed to publish task_reviewed event:', streamErr);
      }

      res.json(serializeTask(updated));
    } catch (err) {
      console.error('Review orchestration task error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/complete',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const loaded = await loadOrchestrationWithTasks(req.params.project_id, req.params.orchestration_id);
      if (!loaded) {
        res.status(404).json({ detail: 'Orchestration not found' });
        return;
      }
      if (!await ensureMainAgentOrUser(req, res, loaded.orchestration)) return;
      if (loaded.tasks.length === 0 || !loaded.tasks.every((task) => task.status === ProjectOrchestrationTaskStatus.APPROVED)) {
        res.status(409).json({ detail: 'All orchestration tasks must be approved before completion' });
        return;
      }

      loaded.orchestration.status = ProjectOrchestrationStatus.COMPLETED;
      loaded.orchestration.completedAt = new Date();

      // ── MD artifact: TRACE.md ──────────────────────────────────────────
      const summary = typeof req.body.summary === 'string' && req.body.summary.trim()
        ? req.body.summary.trim()
        : 'All worker tasks were approved by PM review.';
      await AppDataSource.transaction(async (manager) => {
        const tracePath = await writeTraceMd(manager, loaded.orchestration, loaded.tasks, summary);
        setMdArtifactPaths(loaded.orchestration, { trace: tracePath });
        await manager.getRepository(ProjectOrchestration).save(loaded.orchestration);

        await appendCompletionReview(manager, loaded.orchestration, loaded.tasks, actor.actorId, summary);
      });

      // Notify participating worker agents of completion (before response, but non-fatal)
      try {
        for (const task of loaded.tasks) {
          if (task.assignedAgentId && task.assignedAgentId !== loaded.orchestration.mainAgentId) {
            await createInboxItem({
              projectId: loaded.orchestration.projectId,
              recipientAgentId: task.assignedAgentId,
              eventType: 'orchestration_completed',
              title: `Orchestration completed: ${loaded.orchestration.title}`,
              body: 'The orchestration has been completed.',
              payload: {
                project_id: loaded.orchestration.projectId,
                orchestration_id: loaded.orchestration.id,
                task_id: task.id,
              },
            });
          }
        }
      } catch (e) {
        // ignore inbox failures
      }

      res.json(serializeOrchestration(loaded.orchestration, loaded.tasks));
    } catch (err) {
      console.error('Complete orchestration error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id/reassign
 * Main agent redirects a stalled task to a different worker. Cancels the old
 * task and creates a fresh one (same goal/acceptance criteria) assigned to the
 * new agent, then notifies the new worker and the PM. Enables "no-response
 * reassignment" of unresponsive workers.
 * Body: { new_agent_id: "<id>", reason?: "..." }
 * RBAC: project-level main agent OR orchestration main agent (ensureMainAgentOrUser).
 */
router.post(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id/reassign',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const orchestrationId = req.params.orchestration_id;
      const taskId = req.params.task_id;
      const newAgentId = typeof req.body.new_agent_id === 'string' ? req.body.new_agent_id.trim() : '';
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : null;
      if (!newAgentId) {
        res.status(422).json({ detail: 'new_agent_id is required' });
        return;
      }

      const task = await loadTask(projectId, orchestrationId, taskId);
      if (!task) {
        res.status(404).json({ detail: 'Task not found' });
        return;
      }
      if (!await ensureMainAgentOrUser(req, res, task.orchestration)) return;

      const orchestration = task.orchestration;
      // Cannot reassign a task that is already finished.
      if (task.status === ProjectOrchestrationTaskStatus.APPROVED ||
          task.status === ProjectOrchestrationTaskStatus.CANCELLED) {
        res.status(409).json({ detail: `Cannot reassign a task in terminal status ${task.status}` });
        return;
      }
      if (task.assignedAgentId === newAgentId) {
        res.status(409).json({ detail: 'Task is already assigned to that agent' });
        return;
      }
      // New worker must exist and be dispatchable (fresh heartbeat).
      if (!await ensureAgentsExistAndDispatchable(res, projectId, [newAgentId])) return;

      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const newTaskId = randomUUID();
      const previousStatus = task.status;

      const result = await AppDataSource.transaction(async (manager) => {
        // 1. Cancel the old task.
        task.status = ProjectOrchestrationTaskStatus.CANCELLED;
        task.metadata = { ...(task.metadata || {}), reassigned_to: newAgentId, reassign_reason: reason, reassigned_at: new Date().toISOString() };
        await manager.save(ProjectOrchestrationTask, task);

        // 2. Clone into a fresh dispatched task for the new worker.
        const created = manager.create(ProjectOrchestrationTask, {
          id: newTaskId,
          projectId,
          orchestrationId,
          title: task.title,
          goal: task.goal,
          status: ProjectOrchestrationTaskStatus.DISPATCHED,
          assignedAgentId: newAgentId,
          workerTaskPath: `${orchestration.basePath}/workers/${newTaskId}.worker_task.md`,
          workerContextPath: `${orchestration.basePath}/workers/${newTaskId}.worker_context.md`,
          acceptanceCriteria: task.acceptanceCriteria ?? [],
          dependsOn: task.dependsOn ?? [],
          requiredCapability: task.requiredCapability ?? null,
          priority: task.priority ?? 0,
          createdByUserId: actor.userId,
          createdByAgentId: actor.agentId,
          dispatchedAt: new Date(),
          metadata: { reassigned_from: task.id },
        });
        await manager.save(ProjectOrchestrationTask, created);
        await refreshTaskLedger(manager, orchestration, actor.actorId);
        return created;
      });

      // 3. Notify the new worker (session + durable inbox).
      await notifyAgentInSession({
        projectId,
        sessionId: orchestration.sessionId ?? null,
        actorId: actor.actorId,
        recipientAgentId: newAgentId,
        content: [
          `Task reassigned to you: ${result.title}`,
          '',
          `Task ID: ${result.id}`,
          `Task file: ${result.workerTaskPath}`,
          `Context file: ${result.workerContextPath}`,
          reason ? `Reason: ${reason}` : '',
          '',
          'Read the task/context markdown, complete the work, then call the complete endpoint.',
        ].filter(Boolean).join('\n'),
        idempotencyKey: `orchestration:${orchestrationId}:task:${newTaskId}:reassign`,
      });
      await createInboxItem({
        projectId,
        recipientAgentId: newAgentId,
        eventType: 'task_dispatched',
        title: `Task reassigned to you: ${result.title}`,
        body: [
          `Task ID: ${result.id}${reason ? `. Reason: ${reason}` : ''}`,
          `Goal: ${result.goal}`,
          '',
          '## Execution Steps',
          '1. Ack: POST /v1/agent/inbox/<inbox_id>/ack',
          '2. Claim: PATCH /v1/projects/<pid>/orchestrations/<oid>/tasks/<tid>/claim',
          '3. Read context + do the work',
          '4. Submit: POST .../tasks/<tid>/complete {"result_md":"...","evidence":{"files_changed":[]},"status":"ready_for_review"}',
          '5. If changes_requested, fix and re-submit',
          '',
          'CLI: zz tasks claim → zz agent submit --result @result.md',
          'Full guide: GET /v1/agent/execution-guide',
        ].join('\n'),
        orchestrationId,
        taskId: newTaskId,
      });
      // 3b. Notify the OLD worker that their task was reassigned away.
      if (task.assignedAgentId && task.assignedAgentId !== newAgentId) {
        // Clear the original task_dispatched notification pointing at the now-
        // cancelled task, so the old worker doesn't see a "ghost" dispatch that
        // leads to claiming a dead task. (the "ghost notification" bug)
        await ackInboxItemsForTask(task.assignedAgentId, task.id).catch((e: any) =>
          console.error('Failed to ack old worker inbox on reassign:', e));
        await createInboxItem({
          projectId,
          recipientAgentId: task.assignedAgentId,
          eventType: 'task_cancelled',
          title: `Task reassigned away: ${task.title}`,
          body: `Task ${task.id} was reassigned to another agent${reason ? ` (reason: ${reason})` : ''}. No further action needed from you on this task.`,
          orchestrationId,
          taskId: task.id,
        }).catch((e: any) => console.error('Failed to notify old worker of reassignment:', e));
      }
      // 4. Notify the PM that the reassignment landed.
      if (orchestration.mainAgentId && orchestration.mainAgentId !== newAgentId) {
        await createInboxItem({
          projectId,
          recipientAgentId: orchestration.mainAgentId,
          eventType: 'task_reassigned',
          title: `Task reassigned: ${result.title}`,
          body: `Old task ${task.id} cancelled; new task ${result.id} assigned to ${newAgentId}.`,
          orchestrationId,
          taskId: newTaskId,
        });
      }

      publishTaskStatusChanged(orchestration.sessionId, projectId, task, previousStatus);
      publishTaskStatusChanged(orchestration.sessionId, projectId, result, null);

      try {
        if (orchestration.sessionId) {
          eventStreamService.publish(orchestration.sessionId, {
            projectId,
            sessionId: orchestration.sessionId,
            agentId: task.assignedAgentId ?? undefined,
            type: 'task_cancelled',
            payload: {
              taskId: task.id,
              agentId: task.assignedAgentId ?? undefined,
              status: task.status,
              reassigned_to: newAgentId,
            },
          });
          eventStreamService.publish(orchestration.sessionId, {
            projectId,
            sessionId: orchestration.sessionId,
            agentId: newAgentId,
            type: 'task_dispatched',
            payload: {
              taskId: result.id,
              agentId: newAgentId,
              status: result.status,
              reassigned_from: task.id,
            },
          });
        }
      } catch (streamErr) {
        console.warn('Failed to publish reassignment events:', streamErr);
      }

      res.status(201).json(serializeTask(result));
    } catch (err) {
      console.error('Reassign task error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id/cancel
 *
 * Cancel a task that has not yet reached a terminal status. Allowed from
 * dispatched, running, pending, changes_requested, and blocked. Not allowed
 * from terminal statuses (approved, cancelled).
 *
 * Body: { reason?: "..." }
 * Auth: main agent or JWT user.
 * 200 → updated task
 * 409 when task is already terminal
 */
router.post(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/tasks/:task_id/cancel',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const orchestrationId = req.params.orchestration_id;
      const taskId = req.params.task_id;
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const task = await loadTask(projectId, orchestrationId, taskId);
      if (!task) {
        res.status(404).json({ detail: 'Task not found' });
        return;
      }
      if (!await ensureMainAgentOrUser(req, res, task.orchestration)) return;

      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 2000) : null;
      const cancellableStatuses = [
        ProjectOrchestrationTaskStatus.PENDING,
        ProjectOrchestrationTaskStatus.DISPATCHED,
        ProjectOrchestrationTaskStatus.RUNNING,
        ProjectOrchestrationTaskStatus.CHANGES_REQUESTED,
        ProjectOrchestrationTaskStatus.BLOCKED,
      ];

      if (!cancellableStatuses.includes(task.status)) {
        res.status(409).json({ detail: `Task cannot be cancelled from status ${task.status}` });
        return;
      }

      const previousStatus = task.status;
      const cancelledAt = new Date();
      task.status = ProjectOrchestrationTaskStatus.CANCELLED;
      task.cancelledAt = cancelledAt;
      task.metadata = {
        ...(task.metadata ?? {}),
        cancellation: {
          reason,
          cancelled_at: cancelledAt.toISOString(),
          cancelled_by_agent_id: actor.agentId,
          cancelled_by_user_id: actor.userId,
        },
      };

      const updated = await AppDataSource.transaction(async (manager) => {
        await manager.save(ProjectOrchestrationTask, task);
        await refreshTaskLedger(manager, task.orchestration, actor.actorId);
        return task;
      });

      // Durable inbox: notify the assigned worker that the task was cancelled.
      if (updated.assignedAgentId) {
        await createInboxItem({
          projectId,
          recipientAgentId: updated.assignedAgentId,
          eventType: 'task_cancelled',
          title: `Task cancelled: ${updated.title}`,
          body: [
            `Task ID: ${updated.id}`,
            reason ? `Reason: ${reason}` : '',
            '',
            'No further action is needed on this task.',
          ].filter(Boolean).join('\n'),
          orchestrationId,
          taskId: updated.id,
        }).catch((e: any) => console.error('Failed to notify worker of task cancellation:', e));
      }

      publishTaskStatusChanged(updated.orchestration.sessionId, projectId, updated, previousStatus);

      try {
        if (updated.orchestration.sessionId) {
          eventStreamService.publish(updated.orchestration.sessionId, {
            projectId,
            sessionId: updated.orchestration.sessionId,
            agentId: req.agent?.id ?? updated.assignedAgentId ?? undefined,
            type: 'task_cancelled',
            payload: {
              taskId: updated.id,
              agentId: req.agent?.id ?? updated.assignedAgentId ?? undefined,
              status: updated.status,
              reason,
            },
          });
        }
      } catch (streamErr) {
        console.warn('Failed to publish task_cancelled event:', streamErr);
      }

      res.json(serializeTask(updated));
    } catch (err) {
      console.error('Cancel orchestration task error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * PATCH /v1/projects/:project_id/orchestrations/:orchestration_id/main-agent
 * Switch the main agent for an orchestration.
 * Validates the new main agent is in the project, active, and dispatchable.
 * Body: { main_agent_id: "<new_main_agent_id>" }
 */
router.patch(
  '/v1/projects/:project_id/orchestrations/:orchestration_id/main-agent',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const { main_agent_id } = req.body;
      if (!main_agent_id || typeof main_agent_id !== 'string') {
        res.status(422).json({ detail: 'main_agent_id is required' });
        return;
      }

      const loaded = await loadOrchestrationWithTasks(req.params.project_id, req.params.orchestration_id);
      if (!loaded) {
        res.status(404).json({ detail: 'Orchestration not found' });
        return;
      }

      // Only current main agent or user can switch
      if (!await ensureMainAgentOrUser(req, res, loaded.orchestration)) return;

      // Completed orchestrations cannot switch main agent
      if (loaded.orchestration.status === ProjectOrchestrationStatus.COMPLETED) {
        res.status(409).json({ detail: 'Cannot switch main agent on a completed orchestration' });
        return;
      }

      // Validate new main agent
      const agentRepo = AppDataSource.getRepository(Agent);
      const newMainAgent = await agentRepo.findOne({
        where: { id: main_agent_id, projectId: req.params.project_id },
      });
      if (!newMainAgent) {
        res.status(404).json({ detail: 'Agent not found in this project' });
        return;
      }

      // Check lifecycle active
      if (newMainAgent.lifecycleStatus !== AgentLifecycleStatus.ACTIVE) {
        res.status(409).json({ detail: 'Agent must have active lifecycle status' });
        return;
      }

      // Check dispatchable (online)
      if (!getAgentPresence(newMainAgent).dispatchable) {
        res.status(409).json({ detail: 'AGENT_NOT_ONLINE', agent_id: main_agent_id });
        return;
      }

      loaded.orchestration.mainAgentId = main_agent_id;
      await AppDataSource.getRepository(ProjectOrchestration).save(loaded.orchestration);

      res.json(serializeOrchestration(loaded.orchestration, loaded.tasks));
    } catch (err) {
      console.error('Switch main agent error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

async function createOrchestrationSession(
  manager: EntityManager,
  input: { projectId: string; title: string; createdBy: string; agentIds: string[] },
): Promise<Session> {
  const session = manager.create(Session, {
    projectId: input.projectId,
    title: input.title,
    status: SessionStatus.ACTIVE,
    createdBy: input.createdBy,
  });
  await manager.save(Session, session);

  for (const agentId of input.agentIds) {
    await manager.save(SessionParticipant, manager.create(SessionParticipant, {
      sessionId: session.id,
      agentId,
    }));
  }

  return session;
}

async function upsertProjectFile(manager: EntityManager, input: ProjectFileUpsertInput): Promise<ProjectFile> {
  // Delegate to the shared write core (single place for the future git `add`).
  const { upsertProjectFileContent } = await import('../services/project-file.service');
  const { file } = await upsertProjectFileContent(manager, {
    projectId: input.projectId,
    path: input.path,
    content: input.content,
    contentType: input.contentType,
    message: input.message?.slice(0, 512) ?? null,
    actorId: input.actorId,
    maxFileBytes: MAX_FILE_BYTES,
  });
  return file;
}

async function dispatchTaskToAssignedAgent(input: {
  projectId: string;
  orchestration: ProjectOrchestration;
  task: ProjectOrchestrationTask;
  actorId: string;
  retry: boolean;
}): Promise<void> {
  const { projectId, orchestration, task, actorId, retry } = input;

  // Ensure the assigned worker is a session participant so the platform can
  // invoke its endpoint; dispatchService only invokes participant agents.
  if (task.assignedAgentId && orchestration.sessionId) {
    const partRepo = AppDataSource.getRepository(SessionParticipant);
    const existing = await partRepo.findOne({
      where: { sessionId: orchestration.sessionId, agentId: task.assignedAgentId },
    });
    if (!existing) {
      await partRepo.save(partRepo.create({
        sessionId: orchestration.sessionId,
        agentId: task.assignedAgentId,
      }));
    }
  }

  const retrySuffix = retry ? ` (retry ${task.retryCount ?? 0}/${task.maxRetries ?? 2})` : '';
  await notifyAgentInSession({
    projectId,
    sessionId: orchestration.sessionId ?? null,
    actorId,
    recipientAgentId: task.assignedAgentId ?? null,
    content: [
      retry ? `Task retry dispatched: ${task.title}` : `Task dispatched: ${task.title}`,
      '',
      `Task ID: ${task.id}`,
      `Task file: ${task.workerTaskPath}`,
      `Context file: ${task.workerContextPath}`,
      retry ? `Retry: ${task.retryCount ?? 0}/${task.maxRetries ?? 2}` : null,
      '',
      'Read the task/context markdown, complete the work, then call the complete endpoint with result_md and evidence.',
    ].filter(Boolean).join('\n'),
    idempotencyKey: retry
      ? `orchestration:${orchestration.id}:task:${task.id}:retry:${task.retryCount ?? 0}`
      : `orchestration:${orchestration.id}:task:${task.id}:dispatch`,
  });

  if (!task.assignedAgentId) return;
  await createInboxItem({
    projectId,
    recipientAgentId: task.assignedAgentId,
    eventType: 'task_dispatched',
    title: `${retry ? 'Task retry dispatched' : 'Task dispatched'}: ${task.title}`,
    body: [
      `Task ID: ${task.id}${retrySuffix}`,
      `Goal: ${task.goal}`,
      '',
      '## Execution Steps (follow these to complete this task)',
      '',
      '1. **Acknowledge**: POST /v1/agent/inbox/<this_inbox_id>/ack',
      '2. **Claim**: PATCH /v1/projects/<project_id>/orchestrations/<orch_id>/tasks/<task_id>/claim',
      '3. **Read context**: GET /v1/projects/<project_id>/orchestrations/<orch_id>/tasks/<task_id> (read goal, acceptance_criteria, worker_context_path)',
      '4. **Understand the codebase**: If .agent/code-map.md exists, it is already in your context. Use GET /v1/projects/<project_id>/repository/search?q=<keywords> to find relevant code.',
      '5. **Do the work**: Implement the goal. Use your own capabilities (LLM, code generation, analysis, etc.).',
      '6. **Submit result**: POST /v1/projects/<project_id>/orchestrations/<orch_id>/tasks/<task_id>/complete with body: {"result_md": "# Your result\\n...", "evidence": {"files_changed": ["path/to/file.ts"], "test_passed": true}, "status": "ready_for_review"}',
      '7. **If changes requested**: You will receive a task_changes_requested notification. Fix the issues and re-submit via the same complete endpoint.',
      '',
      '## Quick CLI Commands',
      '```bash',
      `zz agent inbox           # see this task`,
      `zz tasks claim -p <project_id> -o <orch_id> <task_id>`,
      `zz agent submit --result @./result.md   # submit when done`,
      '```',
      '',
      '## Full Guide',
      'GET /v1/agent/execution-guide for the complete agent execution workflow.',
    ].join('\n'),
    orchestrationId: orchestration.id,
    taskId: task.id,
    payload: retry
      ? { retry_count: task.retryCount ?? 0, max_retries: task.maxRetries ?? 2 }
      : null,
  });
}

/**
 * Shared create+dispatch core for orchestration tasks. Used by both the explicit
 * POST .../tasks route (PM picks the worker) and the smart-dispatch route (the
 * platform auto-selects the worker). Creates the task row inside a transaction,
 * writes the worker_task / worker_context / TASK.md artifacts, refreshes the
 * task ledger, then dispatches to the assigned agent + emits task_dispatched.
 *
 * Caller is responsible for any pre-dispatch validation (auth, dedup, agent
 * dispatchability). Returns the created (and possibly dispatched) task.
 */
async function createAndDispatchOrchestrationTask(input: {
  projectId: string;
  orchestration: ProjectOrchestration;
  actor: { userId: string | null; agentId: string | null; actorId: string };
  title: string;
  goal: string;
  assignedAgentId: string | null;
  requiredCapability: string | null;
  scope?: unknown;
  context?: unknown;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  priority?: number;
  maxRetries?: number;
  dispatch: boolean;
}): Promise<ProjectOrchestrationTask> {
  const { projectId, orchestration, actor, title, goal, assignedAgentId, dispatch } = input;
  const requiredCapability = input.requiredCapability ?? null;
  const acceptanceCriteria = input.acceptanceCriteria ?? [];
  const dependsOn = input.dependsOn ?? [];
  const priority = input.priority ?? 0;
  const maxRetries = input.maxRetries ?? 2;
  const dedupHash = computeDedupHash(title, goal);

  const task = await AppDataSource.transaction(async (manager) => {
    const taskId = randomUUID();
    const created = manager.create(ProjectOrchestrationTask, {
      id: taskId,
      projectId,
      orchestrationId: orchestration.id,
      title,
      goal,
      status: dispatch
        ? ProjectOrchestrationTaskStatus.DISPATCHED
        : ProjectOrchestrationTaskStatus.PENDING,
      assignedAgentId,
      workerTaskPath: `${orchestration.basePath}/workers/${taskId}.worker_task.md`,
      workerContextPath: `${orchestration.basePath}/workers/${taskId}.worker_context.md`,
      acceptanceCriteria,
      dependsOn,
      requiredCapability,
      priority,
      maxRetries,
      createdByUserId: actor.userId,
      createdByAgentId: actor.agentId,
      dispatchedAt: dispatch ? new Date() : undefined,
      metadata: { dedup_hash: dedupHash },
    });
    await manager.save(ProjectOrchestrationTask, created);

    if (orchestration.status === ProjectOrchestrationStatus.PLANNING) {
      orchestration.status = ProjectOrchestrationStatus.RUNNING;
      await manager.save(ProjectOrchestration, orchestration);
    }

    await upsertProjectFile(manager, {
      projectId,
      path: created.workerTaskPath,
      content: renderWorkerTaskMd(orchestration, created, input.scope),
      actorId: actor.actorId,
      message: `Dispatch worker task ${created.id}`,
    });
    // Inject the project's current git HEAD SHA so the worker knows the
    // codebase baseline (best-effort; null when git backend isn't populated).
    let workerGitHead: string | null = null;
    try {
      const { gitHeadSha } = await import('../services/project-git.service');
      workerGitHead = await gitHeadSha(projectId);
    } catch { /* git not initialized yet */ }
    await upsertProjectFile(manager, {
      projectId,
      path: created.workerContextPath,
      content: renderWorkerContextMd(orchestration, created, input.context, workerGitHead),
      actorId: actor.actorId,
      message: `Create worker context ${created.id}`,
    });

    // ── MD artifact: TASK.md ──────────────────────────────────────────
    const scopeText = typeof input.scope === 'string' && (input.scope as string).trim()
      ? (input.scope as string).trim()
      : 'Use the task goal and context. Keep changes scoped.';
    await writeTaskMd(manager, orchestration, created, scopeText);

    // Store task artifact paths in metadata
    const taskDir = taskMdDir(orchestration.basePath, created.id);
    setMdArtifactPaths(created, {
      task_dir: taskDir,
      task: `${taskDir}/TASK.md`,
    });
    await manager.save(ProjectOrchestrationTask, created);

    await refreshTaskLedger(manager, orchestration, actor.actorId);

    return created;
  });

  publishTaskStatusChanged(orchestration.sessionId, projectId, task, null);

  if (task.status === ProjectOrchestrationTaskStatus.DISPATCHED) {
    await dispatchTaskToAssignedAgent({
      projectId,
      orchestration,
      task,
      actorId: actor.actorId,
      retry: false,
    });

    try {
      if (orchestration.sessionId) {
        eventStreamService.publish(orchestration.sessionId, {
          projectId,
          sessionId: orchestration.sessionId,
          agentId: task.assignedAgentId ?? undefined,
          type: 'task_dispatched',
          payload: {
            taskId: task.id,
            agentId: task.assignedAgentId ?? undefined,
            status: task.status,
          },
        });
      }
    } catch (streamErr) {
      console.warn('Failed to publish task_dispatched event:', streamErr);
    }
  }

  return task;
}

async function refreshTaskLedger(
  manager: EntityManager,
  orchestration: ProjectOrchestration,
  actorId: string,
): Promise<void> {
  const tasks = await manager.find(ProjectOrchestrationTask, {
    where: { orchestrationId: orchestration.id },
    order: { createdAt: 'ASC' },
  });
  await upsertProjectFile(manager, {
    projectId: orchestration.projectId,
    path: `${orchestration.basePath}/tasks.json`,
    content: JSON.stringify(tasks.map(serializeTaskLedgerItem), null, 2) + '\n',
    contentType: 'application/json',
    actorId,
    message: 'Refresh orchestration task ledger',
  });
}

async function appendPmReview(
  manager: EntityManager,
  orchestration: ProjectOrchestration,
  task: ProjectOrchestrationTask,
  review: { decision: 'approved' | 'changes_requested'; notes: string; requestedChanges: string; actorId: string },
): Promise<void> {
  const path = `${orchestration.basePath}/pm-review.md`;
  const existing = await manager.findOne(ProjectFile, { where: { projectId: orchestration.projectId, path } });
  const previous = existing?.content && existing.content.trim() !== '# PM Review\n\nNo reviews yet.'
    ? existing.content.trimEnd()
    : '# PM Review';
  const entry = [
    '',
    `## ${new Date().toISOString()} - ${review.decision}`,
    '',
    `- Task: ${task.title} (${task.id})`,
    `- Status: ${task.status}`,
    review.notes ? `- Notes: ${review.notes}` : null,
    review.requestedChanges ? `- Requested changes: ${review.requestedChanges}` : null,
    '',
  ].filter((line) => line !== null).join('\n');

  await upsertProjectFile(manager, {
    projectId: orchestration.projectId,
    path,
    content: `${previous}\n${entry}`,
    actorId: review.actorId,
    message: `PM review ${task.id}`,
  });
}

async function appendCompletionReview(
  manager: EntityManager,
  orchestration: ProjectOrchestration,
  tasks: ProjectOrchestrationTask[],
  actorId: string,
  summary: unknown,
): Promise<void> {
  const path = `${orchestration.basePath}/pm-review.md`;
  const existing = await manager.findOne(ProjectFile, { where: { projectId: orchestration.projectId, path } });
  const previous = existing?.content && existing.content.trim() !== '# PM Review\n\nNo reviews yet.'
    ? existing.content.trimEnd()
    : '# PM Review';
  const summaryText = typeof summary === 'string' && summary.trim()
    ? summary.trim()
    : 'All worker tasks were approved by PM review.';
  const entry = [
    '',
    `## ${new Date().toISOString()} - completed`,
    '',
    `- Orchestration: ${orchestration.id}`,
    `- Summary: ${summaryText}`,
    '',
    '### Approved Tasks',
    '',
    ...tasks.map((task) => `- ${task.title} (${task.id})`),
    '',
  ].join('\n');

  await upsertProjectFile(manager, {
    projectId: orchestration.projectId,
    path,
    content: `${previous}\n${entry}`,
    actorId,
    message: 'Complete orchestration',
  });
}

function publishTaskStatusChanged(
  sessionId: string | null | undefined,
  projectId: string,
  task: ProjectOrchestrationTask,
  previousStatus: ProjectOrchestrationTaskStatus | null,
): void {
  if (!sessionId) return;
  try {
    eventStreamService.publish(sessionId, {
      projectId,
      sessionId,
      agentId: task.assignedAgentId ?? undefined,
      type: 'task_status_changed',
      payload: {
        taskId: task.id,
        previousStatus,
        status: task.status,
        agentId: task.assignedAgentId ?? undefined,
      },
    });
  } catch (streamErr) {
    console.warn('Failed to publish task_status_changed event:', streamErr);
  }
}

async function notifyAgentInSession(input: {
  projectId: string;
  sessionId: string | null;
  actorId: string;
  recipientAgentId: string | null;
  content: string;
  idempotencyKey: string;
}): Promise<void> {
  if (!input.sessionId) return;

  let recipientParticipantIds: string[] | undefined;
  let visibility: MessageVisibility | undefined;
  if (input.recipientAgentId) {
    const participant = await AppDataSource.getRepository(SessionParticipant).findOne({
      where: { sessionId: input.sessionId, agentId: input.recipientAgentId },
    });
    if (participant) {
      recipientParticipantIds = [participant.id];
      visibility = MessageVisibility.DIRECT;
    }
  }

  await dispatchService.createUserMessage({
    projectId: input.projectId,
    sessionId: input.sessionId,
    userId: input.actorId,
    content: input.content,
    contentType: 'text/markdown',
    recipientParticipantIds,
    visibility,
    dispatchTtl: 1,
    idempotencyKey: input.idempotencyKey,
  });
}

async function ensureAgentsExistAndDispatchable(
  res: Response,
  projectId: string,
  agentIds: string[],
): Promise<boolean> {
  const uniqueAgentIds = [...new Set(agentIds)];
  if (uniqueAgentIds.length === 0) return true;
  const agents = await AppDataSource.getRepository(Agent).find({
    where: { projectId, id: In(uniqueAgentIds) },
  });
  const foundIds = new Set(agents.map((agent) => agent.id));
  const missingAgentIds = uniqueAgentIds.filter((agentId) => !foundIds.has(agentId));
  if (missingAgentIds.length > 0) {
    res.status(404).json({
      detail: 'One or more agents were not found in this project',
      code: 'AGENT_NOT_FOUND',
      missing_agent_ids: missingAgentIds,
    });
    return false;
  }

  const presenceByAgent = agents.map((agent) => ({ agent, presence: getAgentPresence(agent) }));
  const offlineAgentIds = presenceByAgent
    .filter((item) => !item.presence.dispatchable)
    .map((item) => item.agent.id);
  if (offlineAgentIds.length > 0) {
    res.status(409).json({
      detail: 'One or more agents are offline or stale. Dispatch requires a fresh heartbeat.',
      code: 'AGENT_NOT_ONLINE',
      offline_agent_ids: offlineAgentIds,
      heartbeat_ttl_seconds: Math.floor((presenceByAgent[0]?.presence.onlineTtlMs ?? 90_000) / 1000),
    });
    return false;
  }

  // R10b: a fresh heartbeat is not enough — the worker must also be healthy.
  // Workers report a smoke-test result via heartbeat; we store it on the agent
  // record. `unhealthy` blocks dispatch. No health field (null/legacy worker)
  // is allowed through to preserve backward compatibility.
  const unhealthyAgents = presenceByAgent
    .filter((item) => item.agent.healthStatus === AgentSmokeHealth.UNHEALTHY)
    .map((item) => ({ id: item.agent.id, last_error: item.agent.healthLastError ?? null }));
  if (unhealthyAgents.length > 0) {
    res.status(409).json({
      detail: 'One or more agents failed their last health (smoke) check. Dispatch requires a healthy worker.',
      code: 'AGENT_UNHEALTHY',
      unhealthy_agent_ids: unhealthyAgents.map((item) => item.id),
      unhealthy_agents: unhealthyAgents,
    });
    return false;
  }

  return true;
}

async function loadOrchestration(projectId: string, orchestrationId: string): Promise<ProjectOrchestration | null> {
  return AppDataSource.getRepository(ProjectOrchestration).findOne({
    where: { id: orchestrationId, projectId },
  });
}

async function loadOrchestrationWithTasks(
  projectId: string,
  orchestrationId: string,
): Promise<{ orchestration: ProjectOrchestration; tasks: ProjectOrchestrationTask[] } | null> {
  const orchestration = await loadOrchestration(projectId, orchestrationId);
  if (!orchestration) return null;
  const tasks = await AppDataSource.getRepository(ProjectOrchestrationTask).find({
    where: { projectId, orchestrationId },
    order: { createdAt: 'ASC' },
  });
  return { orchestration, tasks };
}

async function loadTask(
  projectId: string,
  orchestrationId: string,
  taskId: string,
): Promise<ProjectOrchestrationTask | null> {
  return AppDataSource.getRepository(ProjectOrchestrationTask).findOne({
    where: { id: taskId, projectId, orchestrationId },
    relations: ['orchestration'],
  });
}

async function loadProjectTask(
  projectId: string,
  taskId: string,
): Promise<ProjectOrchestrationTask | null> {
  return AppDataSource.getRepository(ProjectOrchestrationTask).findOne({
    where: { id: taskId, projectId },
    relations: ['orchestration'],
  });
}

async function canViewProjectTask(task: ProjectOrchestrationTask, agentId: string): Promise<boolean> {
  if (task.assignedAgentId === agentId) return true;
  if (task.orchestration.mainAgentId === agentId) return true;
  const assignedTaskCount = await AppDataSource.getRepository(ProjectOrchestrationTask).count({
    where: { orchestrationId: task.orchestrationId, assignedAgentId: agentId },
  });
  return assignedTaskCount > 0;
}

function canViewOrchestration(
  req: Request,
  orchestration: ProjectOrchestration,
  tasks: ProjectOrchestrationTask[],
): boolean {
  if (!req.agent) return true;
  return orchestration.mainAgentId === req.agent.id || tasks.some((task) => task.assignedAgentId === req.agent?.id);
}

/**
 * Is the calling agent the project-level main agent?
 * Project-level main agent (projects.main_agent_id) acts as PM across ALL
 * orchestrations in the project, in addition to per-orchestration main agents.
 * Cached on req for the request lifetime to avoid repeated DB hits.
 */
async function isProjectMainAgent(req: Request, projectId: string): Promise<boolean> {
  if (!req.agent) return false;
  const cache = (req as any)._projectMainAgentCache as Map<string, boolean> | undefined;
  if (cache && cache.has(projectId)) return cache.get(projectId)!;
  const project = await AppDataSource.getRepository(Project).findOne({
    where: { id: projectId },
    select: ['id', 'mainAgentId'],
  });
  const result = !!project && project.mainAgentId === req.agent!.id;
  const map = cache ?? new Map<string, boolean>();
  map.set(projectId, result);
  (req as any)._projectMainAgentCache = map;
  return result;
}

/**
 * PM gate: passes for JWT users, the orchestration's main agent, OR the
 * project-level main agent. (Project-level was added so a single "set main
 * agent" makes one agent PM across the whole project, not per-orchestration.)
 */
async function ensureMainAgentOrUser(
  req: Request,
  res: Response,
  orchestration: ProjectOrchestration,
): Promise<boolean> {
  if (!req.agent) return true;
  if (orchestration.mainAgentId === req.agent.id) return true;
  if (await isProjectMainAgent(req, orchestration.projectId)) return true;
  res.status(403).json({ detail: 'Only the main agent can perform PM review or dispatch tasks' });
  return false;
}

function ensureAssignedWorkerOrUser(req: Request, res: Response, task: ProjectOrchestrationTask): boolean {
  if (!req.agent) return true;
  if (task.assignedAgentId && task.assignedAgentId !== req.agent.id) {
    res.status(403).json({ detail: 'Only the assigned worker agent can perform this task action' });
    return false;
  }
  if (!task.assignedAgentId && task.orchestration.mainAgentId === req.agent.id) {
    res.status(403).json({ detail: 'Main agent cannot claim an unassigned worker task' });
    return false;
  }
  return true;
}

function ensureAssignedWorkerAgent(req: Request, res: Response, task: ProjectOrchestrationTask): boolean {
  if (!req.agent) {
    res.status(403).json({ detail: 'Only the assigned worker agent can perform this task action' });
    return false;
  }
  if (!task.assignedAgentId || task.assignedAgentId !== req.agent.id) {
    res.status(403).json({ detail: 'Only the assigned worker agent can perform this task action' });
    return false;
  }
  return true;
}

/**
 * Create a changeset representing a worker's task completion, so the project/orchestration
 * main agent can review + merge the deliverable via the standard changeset flow.
 *
 * Minimal/declarative: the actual file (RESULT.md) was already written by the complete
 * handler before this is called; here we record a changeset row that references it
 * (with base_revision_id so merge's conflict check passes) plus result_path/evidence_path,
 * and link it to orchestration+task so `canReviewChangeset` admits the main agent.
 *
 * Best-effort by design — failures are logged, not thrown (the completion already succeeded).
 */
async function createTaskCompletionChangeset(
  manager: EntityManager,
  input: {
    projectId: string;
    task: ProjectOrchestrationTask;
    actor: { userId: string | null; agentId: string | null; actorId: string };
    resultMdPath: string;
    resultMdContent: string;
    legacyResultPath: string;
    legacyEvidencePath: string;
  },
): Promise<ProjectChangeset | null> {
  const { projectId, task, actor, resultMdPath, resultMdContent, legacyResultPath, legacyEvidencePath } = input;

  // Resolve (or lazily create) the default branch. A fresh project may have no
  // branch yet (branches are created on first versioning op); create a 'main'
  // default here so the deliverable changeset has a merge target. Mirrors
  // versioning's ensureDefaultBranchInTransaction.
  const branchRepo = manager.getRepository(ProjectBranch);
  let branch = await branchRepo.findOne({ where: { projectId, isDefault: true } });
  if (!branch) {
    branch = await branchRepo.findOne({ where: { projectId, name: 'main' } });
    if (branch) {
      branch.isDefault = true;
      branch = await branchRepo.save(branch);
    } else {
      branch = await branchRepo.save(branchRepo.create({
        projectId,
        name: 'main',
        isDefault: true,
        createdByUserId: actor.userId,
        createdByAgentId: actor.agentId,
      }));
    }
  }

  // base_revision_id for the RESULT.md file (already written above) so merge sees no conflict.
  const resultFile = await manager.getRepository(ProjectFile).findOne({
    where: { projectId, path: resultMdPath },
  });
  const baseRevisionId = resultFile?.currentRevisionId ?? null;

  const changeset = manager.create(ProjectChangeset, {
    projectId,
    branchId: branch.id,
    baseCommitId: branch.headCommitId ?? null,
    title: `Task deliverable: ${task.title}`,
    description: `Auto-created on task ${task.id} completion. Review and merge to accept the worker's deliverable.`,
    status: ProjectChangesetStatus.SUBMITTED,
    fileOps: [
      {
        op: 'upsert',
        path: resultMdPath,
        content: resultMdContent.endsWith('\n') ? resultMdContent : `${resultMdContent}\n`,
        base_revision_id: baseRevisionId,
      },
    ],
    resultPath: legacyResultPath,
    evidencePath: legacyEvidencePath,
    createdByUserId: actor.userId,
    createdByAgentId: actor.agentId ?? task.assignedAgentId ?? null,
    orchestrationId: task.orchestrationId,
    taskId: task.id,
  });
  return manager.save(ProjectChangeset, changeset);
}

function getActor(req: Request): { userId: string | null; agentId: string | null; actorId: string } | null {
  if (req.user?.userId) {
    return { userId: req.user.userId, agentId: null, actorId: req.user.userId };
  }
  if (req.agent?.id) {
    return { userId: null, agentId: req.agent.id, actorId: req.agent.id };
  }
  return null;
}

function renderGoalMd(orchestration: ProjectOrchestration): string {
  return [
    `# ${orchestration.title}`,
    '',
    '## Objective',
    '',
    orchestration.objective,
    '',
    '## Acceptance Criteria',
    '',
    ...(orchestration.acceptanceCriteria?.length
      ? orchestration.acceptanceCriteria.map((item) => `- ${item}`)
      : ['- PM review approves all worker tasks.']),
    '',
    '## Protocol',
    '',
    '- PM/main agent owns analysis, planning, dispatch, review, and final acceptance.',
    '- Worker agents read `.worker_task.md` and `.worker_context.md`, then submit `result.md` and `evidence.json` through the task complete API.',
    '- PM requests changes until every task is approved, then completes the orchestration.',
    '',
  ].join('\n');
}

function renderPlanMd(plan: string): string {
  return plan
    ? `# Plan\n\n${plan}\n`
    : '# Plan\n\nPending PM breakdown.\n';
}

function renderWorkerTaskMd(
  orchestration: ProjectOrchestration,
  task: ProjectOrchestrationTask,
  scope: unknown,
): string {
  const scopeText = typeof scope === 'string' && scope.trim() ? scope.trim() : 'Use the task goal and context. Keep changes scoped.';
  return [
    `# Worker Task: ${task.title}`,
    '',
    `- Orchestration: ${orchestration.id}`,
    `- Task ID: ${task.id}`,
    task.assignedAgentId ? `- Assigned Agent: ${task.assignedAgentId}` : '- Assigned Agent: unassigned',
    '',
    '## Goal',
    '',
    task.goal,
    '',
    '## Scope',
    '',
    scopeText,
    '',
    '## Acceptance Criteria',
    '',
    ...(task.acceptanceCriteria?.length ? task.acceptanceCriteria.map((item) => `- ${item}`) : ['- Result satisfies the task goal.', '- Evidence explains how it was verified.']),
    '',
    '## Completion Contract',
    '',
    '- Submit `result_md` with concise implementation notes and changed artifacts.',
    '- Submit `evidence` as JSON with files_changed plus commands, outputs, links, or review notes.',
    '- If blocked, submit status `blocked` with evidence.files_changed and evidence.reason.',
    '',
  ].join('\n');
}

function renderWorkerContextMd(
  orchestration: ProjectOrchestration,
  task: ProjectOrchestrationTask,
  context: unknown,
  gitHead?: string | null,
): string {
  const contextText = typeof context === 'string' && context.trim()
    ? context.trim()
    : 'No extra context was supplied. Use project files, memories, and session messages as source of truth.';
  return [
    `# Worker Context: ${task.title}`,
    '',
    `- Project ID: ${task.projectId}`,
    `- Orchestration ID: ${orchestration.id}`,
    `- Goal file: ${orchestration.basePath}/goal.md`,
    `- Plan file: ${orchestration.basePath}/plan.md`,
    `- Task ledger: ${orchestration.basePath}/tasks.json`,
    gitHead ? `- **Git HEAD (baseline):** \`${gitHead}\` — the project is at this real git commit when this task was dispatched. Reference it in your work for provenance.` : '',
    '',
    '## Context',
    '',
    contextText,
    '',
    '## Delivery Contract',
    '',
    'Deliver your work through these channels:',
    '',
    '- **成品文件 (finished artifacts):** `zz agent deliver <local-file>` uploads a file to `deliverables/<your-agent-name>/`. Use this for documents, code, reports.',
    '- **进展更新 (progress notes):** `zz agent progress ' + task.id + ' --note "..."` appends a progress entry. Use this to log what you did.',
    '- **提交任务结果 (submit task result):** `zz agent submit --result @./result.md` submits the task. `--result` can reference a local file with `@`.',
    '- **正式变更 (reviewed changes):** `zz changesets create --file-ops @ops.json --task ' + task.id + '` proposes file changes that the PM/main agent must review and merge. Use this for changes to shared project files.',
    '',
    '## Git & Versioning',
    '',
    'This project is a **real git repository**. Your changeset merges become true git commits:',
    '',
    '- When the PM merges your changeset, the platform creates a real git commit (40-hex SHA). This is real git history, not a simulation.',
    '- Verify your contribution landed: `zz git log --project ' + task.projectId + '` (shows real commits) or `zz git head --project ' + task.projectId + '` (current HEAD SHA).',
    '- **deliver ≠ changeset:** `deliver` puts files in `deliverables/` (your reports/artifacts). `changesets` proposes edits to shared/core files → reviewed → merged → real git commit. Use the right one.',
    '- If a Git gateway is enabled, `GET /v1/projects/' + task.projectId + '/git/remote` returns a `clone_url` you can `git clone` and `git push`.',
    '',
    '> Files you deliver land in `deliverables/<your-agent-name>/` and are visible in the project workspace. Changes to shared/core files MUST go through changesets (merge → git commit). Do not write outside `deliverables/` directly.',
    '',
  ].join('\n');
}

function serializeOrchestration(orchestration: ProjectOrchestration, tasks?: ProjectOrchestrationTask[]) {
  const artifacts = orchestration.metadata
    ? (orchestration.metadata as Record<string, unknown>).md_artifacts as Record<string, string> | undefined
    : undefined;
  return {
    id: orchestration.id,
    project_id: orchestration.projectId,
    title: orchestration.title,
    objective: orchestration.objective,
    status: orchestration.status,
    base_path: orchestration.basePath,
    session_id: orchestration.sessionId ?? null,
    main_agent_id: orchestration.mainAgentId ?? null,
    created_by_user_id: orchestration.createdByUserId ?? null,
    created_by_agent_id: orchestration.createdByAgentId ?? null,
    acceptance_criteria: orchestration.acceptanceCriteria ?? [],
    metadata: orchestration.metadata ?? {},
    paths: {
      goal: `${orchestration.basePath}/goal.md`,
      plan: `${orchestration.basePath}/plan.md`,
      tasks: `${orchestration.basePath}/tasks.json`,
      pm_review: `${orchestration.basePath}/pm-review.md`,
      workers: `${orchestration.basePath}/workers/`,
      trace: artifacts?.trace ?? null,
    },
    completed_at: orchestration.completedAt ?? null,
    created_at: orchestration.createdAt,
    updated_at: orchestration.updatedAt,
    tasks: tasks ? tasks.map(serializeTask) : undefined,
  };
}

function serializeTask(task: ProjectOrchestrationTask) {
  const artifacts = task.metadata
    ? (task.metadata as Record<string, unknown>).md_artifacts as Record<string, string> | undefined
    : undefined;
  return {
    id: task.id,
    project_id: task.projectId,
    orchestration_id: task.orchestrationId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    assigned_agent_id: task.assignedAgentId ?? null,
    worker_task_path: task.workerTaskPath,
    worker_context_path: task.workerContextPath,
    result_path: task.resultPath ?? null,
    evidence_path: task.evidencePath ?? null,
    evidence: task.evidenceJson ?? null,
    acceptance_criteria: task.acceptanceCriteria ?? [],
    depends_on: task.dependsOn ?? [],
    required_capability: task.requiredCapability ?? null,
    priority: task.priority ?? 0,
    retry_count: task.retryCount ?? 0,
    max_retries: task.maxRetries ?? 2,
    progress_note: task.progressNote ?? null,
    progress_percent: task.progressPercent ?? null,
    progress_at: task.progressAt ?? null,
    review_notes: task.reviewNotes ?? null,
    requested_changes: task.requestedChanges ?? null,
    created_by_user_id: task.createdByUserId ?? null,
    created_by_agent_id: task.createdByAgentId ?? null,
    dispatched_at: task.dispatchedAt ?? null,
    claimed_at: task.claimedAt ?? null,
    completed_at: task.completedAt ?? null,
    reviewed_at: task.reviewedAt ?? null,
    cancelled_at: task.cancelledAt ?? null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    md_artifacts: artifacts ?? null,
  };
}

function serializeTaskLedgerItem(task: ProjectOrchestrationTask) {
  const artifacts = task.metadata
    ? (task.metadata as Record<string, unknown>).md_artifacts as Record<string, string> | undefined
    : undefined;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assigned_agent_id: task.assignedAgentId ?? null,
    worker_task_path: task.workerTaskPath,
    worker_context_path: task.workerContextPath,
    result_path: task.resultPath ?? null,
    evidence_path: task.evidencePath ?? null,
    evidence: task.evidenceJson ?? null,
    acceptance_criteria: task.acceptanceCriteria ?? [],
    depends_on: task.dependsOn ?? [],
    required_capability: task.requiredCapability ?? null,
    priority: task.priority ?? 0,
    retry_count: task.retryCount ?? 0,
    max_retries: task.maxRetries ?? 2,
    progress_note: task.progressNote ?? null,
    progress_percent: task.progressPercent ?? null,
    progress_at: task.progressAt ?? null,
    review_notes: task.reviewNotes ?? null,
    requested_changes: task.requestedChanges ?? null,
    dispatched_at: task.dispatchedAt ?? null,
    claimed_at: task.claimedAt ?? null,
    completed_at: task.completedAt ?? null,
    reviewed_at: task.reviewedAt ?? null,
    cancelled_at: task.cancelledAt ?? null,
    md_artifacts: artifacts ?? null,
  };
}

function serializeCapableAgent(agent: Agent) {
  const presence = getAgentPresence(agent);
  return {
    id: agent.id,
    project_id: agent.projectId,
    name: agent.name,
    description: agent.description ?? null,
    capabilities: normalizeCapabilities(agent.capabilities),
    status: agent.status,
    presence: presence.presence,
    health_status: presence.healthStatus,
    is_online: presence.isOnline,
    dispatchable: presence.dispatchable,
    last_heartbeat_at: presence.lastHeartbeatAt,
    heartbeat_age_ms: presence.heartbeatAgeMs,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
}

type ProjectTaskRelatedChanges = {
  relatedChangesets: ProjectChangeset[];
  relatedCommits: ProjectCommit[];
};

type TaskLabel = {
  key: string;
  value: string | boolean;
};

type TaskTimelineEvent = {
  type: string;
  at: string;
  actor_id?: string | null;
  detail?: Record<string, unknown>;
};

function getTaskStatusGroup(status: ProjectOrchestrationTaskStatus): string {
  if (
    status === ProjectOrchestrationTaskStatus.PENDING ||
    status === ProjectOrchestrationTaskStatus.DISPATCHED ||
    status === ProjectOrchestrationTaskStatus.RUNNING ||
    status === ProjectOrchestrationTaskStatus.CHANGES_REQUESTED
  ) {
    return 'open';
  }
  if (status === ProjectOrchestrationTaskStatus.READY_FOR_REVIEW) {
    return 'ready_for_review';
  }
  if (status === ProjectOrchestrationTaskStatus.BLOCKED || status === ProjectOrchestrationTaskStatus.FAILED) {
    return 'blocked_failed';
  }
  if (status === ProjectOrchestrationTaskStatus.APPROVED || status === ProjectOrchestrationTaskStatus.CANCELLED) {
    return 'completed';
  }
  return 'unknown';
}

function getTaskReviewState(status: ProjectOrchestrationTaskStatus): string | null {
  if (status === ProjectOrchestrationTaskStatus.APPROVED) return 'approved';
  if (status === ProjectOrchestrationTaskStatus.CHANGES_REQUESTED) return 'changes_requested';
  if (status === ProjectOrchestrationTaskStatus.READY_FOR_REVIEW) return 'under_review';
  return null;
}

function deriveTaskLabels(task: ProjectOrchestrationTask, related?: ProjectTaskRelatedChanges): TaskLabel[] {
  const labels: TaskLabel[] = [
    { key: 'status', value: task.status },
    { key: 'status_group', value: getTaskStatusGroup(task.status) },
  ];

  if (task.assignedAgentId) {
    labels.push({ key: 'assigned_agent', value: task.assignedAgentId });
  } else {
    labels.push({ key: 'assignment', value: 'unassigned' });
  }

  if (task.orchestration) {
    labels.push({ key: 'batch', value: task.orchestration.id });
    labels.push({ key: 'batch_label', value: task.orchestration.title });
  }

  const reviewState = getTaskReviewState(task.status);
  if (reviewState) {
    labels.push({ key: 'review_state', value: reviewState });
  }

  labels.push({ key: 'has_dependencies', value: (task.dependsOn?.length ?? 0) > 0 });
  labels.push({ key: 'has_acceptance_criteria', value: (task.acceptanceCriteria?.length ?? 0) > 0 });
  labels.push({ key: 'has_result', value: Boolean(task.resultPath) });
  labels.push({ key: 'has_evidence', value: Boolean(task.evidencePath) });
  labels.push({ key: 'has_review_notes', value: Boolean(task.reviewNotes) });
  labels.push({ key: 'has_requested_changes', value: Boolean(task.requestedChanges) });

  if (related) {
    labels.push({ key: 'has_related_changesets', value: related.relatedChangesets.length > 0 });
    labels.push({ key: 'has_related_commits', value: related.relatedCommits.length > 0 });
  }

  return labels;
}

function deriveTaskTimeline(task: ProjectOrchestrationTask, related?: ProjectTaskRelatedChanges): TaskTimelineEvent[] {
  const events: TaskTimelineEvent[] = [
    {
      type: 'created',
      at: task.createdAt.toISOString(),
      actor_id: task.createdByAgentId ?? task.createdByUserId ?? null,
    },
  ];

  if (task.dispatchedAt) {
    events.push({ type: 'dispatched', at: task.dispatchedAt.toISOString() });
  }
  if (task.claimedAt) {
    events.push({ type: 'claimed', at: task.claimedAt.toISOString(), actor_id: task.assignedAgentId ?? null });
  }
  if (task.completedAt) {
    events.push({ type: 'completed', at: task.completedAt.toISOString(), actor_id: task.assignedAgentId ?? null });
  }
  if (task.reviewedAt) {
    const decision = getTaskReviewState(task.status);
    events.push({
      type: 'reviewed',
      at: task.reviewedAt.toISOString(),
      detail: decision ? { decision } : undefined,
    });
  }

  if (related) {
    for (const changeset of related.relatedChangesets) {
      if (changeset.reviewedAt) {
        events.push({
          type: 'review_linked',
          at: changeset.reviewedAt.toISOString(),
          actor_id: changeset.reviewedByAgentId ?? changeset.reviewedByUserId ?? null,
          detail: { changeset_id: changeset.id, status: changeset.status },
        });
      } else {
        events.push({
          type: 'changeset_linked',
          at: changeset.createdAt.toISOString(),
          actor_id: changeset.createdByAgentId ?? changeset.createdByUserId ?? null,
          detail: { changeset_id: changeset.id, status: changeset.status },
        });
      }
    }
    for (const commit of related.relatedCommits) {
      events.push({
        type: 'commit_linked',
        at: commit.createdAt.toISOString(),
        actor_id: commit.createdByAgentId ?? commit.createdByUserId ?? null,
        detail: { commit_id: commit.id, changeset_id: commit.changesetId ?? null },
      });
    }
  }

  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return events;
}

async function loadProjectTaskRelatedChanges(projectId: string, taskId: string): Promise<ProjectTaskRelatedChanges> {
  const [relatedChangesets, relatedCommits] = await Promise.all([
    AppDataSource.getRepository(ProjectChangeset).find({
      where: { projectId, taskId },
      order: { updatedAt: 'DESC' },
      take: 20,
    }),
    AppDataSource.getRepository(ProjectCommit).find({
      where: { projectId, taskId },
      order: { createdAt: 'DESC' },
      take: 20,
    }),
  ]);
  return { relatedChangesets, relatedCommits };
}

function serializeProjectTaskRow(task: ProjectOrchestrationTask, related?: ProjectTaskRelatedChanges) {
  return {
    ...serializeTask(task),
    orchestration_title: task.orchestration.title,
    orchestration_status: task.orchestration.status,
    orchestration_base_path: task.orchestration.basePath,
    orchestration_main_agent_id: task.orchestration.mainAgentId ?? null,
    labels: deriveTaskLabels(task, related),
    timeline: deriveTaskTimeline(task, related),
    ...(related ? {
      related_changesets: related.relatedChangesets.map(serializeRelatedChangeset),
      related_commits: related.relatedCommits.map(serializeRelatedCommit),
    } : {}),
  };
}

function serializeRelatedChangeset(changeset: ProjectChangeset) {
  return {
    id: changeset.id,
    project_id: changeset.projectId,
    branch_id: changeset.branchId,
    title: changeset.title,
    status: changeset.status,
    file_count: Array.isArray(changeset.fileOps) ? changeset.fileOps.length : 0,
    merged_commit_id: changeset.mergedCommitId ?? null,
    orchestration_id: changeset.orchestrationId ?? null,
    task_id: changeset.taskId ?? null,
    reviewed_at: changeset.reviewedAt ?? null,
    merged_at: changeset.mergedAt ?? null,
    created_at: changeset.createdAt,
    updated_at: changeset.updatedAt,
  };
}

function serializeRelatedCommit(commit: ProjectCommit) {
  return {
    id: commit.id,
    project_id: commit.projectId,
    branch_id: commit.branchId,
    parent_commit_id: commit.parentCommitId ?? null,
    message: commit.message,
    changed_files: commit.changedFiles,
    changeset_id: commit.changesetId ?? null,
    orchestration_id: commit.orchestrationId ?? null,
    task_id: commit.taskId ?? null,
    created_at: commit.createdAt,
  };
}

function parseStatusFilter(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function parsePagination(limitParam: unknown, offsetParam: unknown): { limit: number; offset: number } {
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;
  let limit = DEFAULT_LIMIT;
  let offset = 0;

  if (typeof limitParam === 'string') {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isNaN(parsed)) {
      limit = Math.max(1, Math.min(MAX_LIMIT, parsed));
    }
  }
  if (typeof offsetParam === 'string') {
    const parsed = parseInt(offsetParam, 10);
    if (!Number.isNaN(parsed)) {
      offset = Math.max(0, parsed);
    }
  }

  return { limit, offset };
}

const ALLOWED_SORTS = ['updated', 'created', 'status'] as const;
type TaskSort = (typeof ALLOWED_SORTS)[number];

function parseSort(value: unknown): TaskSort {
  if (typeof value === 'string' && ALLOWED_SORTS.includes(value as TaskSort)) {
    return value as TaskSort;
  }
  return 'updated';
}

function applyTaskSort(qb: SelectQueryBuilder<ProjectOrchestrationTask>, sort: TaskSort) {
  if (sort === 'created') {
    qb.orderBy('task.createdAt', 'DESC');
  } else if (sort === 'status') {
    qb.orderBy('task.status', 'ASC').addOrderBy('task.updatedAt', 'DESC');
  } else {
    qb.orderBy('task.updatedAt', 'DESC');
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

function buildSummary(statusCountRows: { status: ProjectOrchestrationTaskStatus; count: string }[]) {
  const statusCounts: Record<string, number> = {};
  let open = 0;
  let readyForReview = 0;
  let blockedFailed = 0;
  let completed = 0;

  for (const row of statusCountRows) {
    const count = parseInt(row.count, 10);
    statusCounts[row.status] = count;

    if (
      row.status === ProjectOrchestrationTaskStatus.PENDING ||
      row.status === ProjectOrchestrationTaskStatus.DISPATCHED ||
      row.status === ProjectOrchestrationTaskStatus.RUNNING ||
      row.status === ProjectOrchestrationTaskStatus.CHANGES_REQUESTED
    ) {
      open += count;
    } else if (row.status === ProjectOrchestrationTaskStatus.READY_FOR_REVIEW) {
      readyForReview += count;
    } else if (
      row.status === ProjectOrchestrationTaskStatus.BLOCKED ||
      row.status === ProjectOrchestrationTaskStatus.FAILED
    ) {
      blockedFailed += count;
    } else if (
      row.status === ProjectOrchestrationTaskStatus.APPROVED ||
      row.status === ProjectOrchestrationTaskStatus.CANCELLED
    ) {
      completed += count;
    }
  }

  return {
    status_counts: statusCounts,
    tabs: {
      open,
      ready_for_review: readyForReview,
      blocked_failed: blockedFailed,
      completed,
    },
    total: Object.values(statusCounts).reduce((sum, c) => sum + c, 0),
  };
}

const MAX_ASSIGNEE_SUMMARY = 20;
const MAX_ORCHESTRATION_SUMMARY = 20;

async function buildAssigneeSummary(
  baseQb: SelectQueryBuilder<ProjectOrchestrationTask>,
): Promise<
  Array<{
    assigned_agent_id: string | null;
    display_name: string;
    total: number;
    open: number;
    review: number;
    done: number;
  }>
> {
  const openStatuses = [
    ProjectOrchestrationTaskStatus.PENDING,
    ProjectOrchestrationTaskStatus.DISPATCHED,
    ProjectOrchestrationTaskStatus.RUNNING,
    ProjectOrchestrationTaskStatus.CHANGES_REQUESTED,
  ];
  const reviewStatus = ProjectOrchestrationTaskStatus.READY_FOR_REVIEW;
  const doneStatuses = [ProjectOrchestrationTaskStatus.APPROVED, ProjectOrchestrationTaskStatus.CANCELLED];

  const qb = baseQb.clone();
  qb.leftJoin('agents', 'agent', 'agent.id = task.assignedAgentId')
    .select('task.assignedAgentId', 'assigned_agent_id')
    .addSelect("COALESCE(MAX(agent.name), 'Unassigned')", 'display_name')
    .addSelect('COUNT(*)', 'total')
    .addSelect(
      'SUM(CASE WHEN task.status IN (:...openStatuses) THEN 1 ELSE 0 END)',
      'open',
    )
    .addSelect(
      'SUM(CASE WHEN task.status = :reviewStatus THEN 1 ELSE 0 END)',
      'review',
    )
    .addSelect(
      'SUM(CASE WHEN task.status IN (:...doneStatuses) THEN 1 ELSE 0 END)',
      'done',
    )
    .setParameter('openStatuses', openStatuses)
    .setParameter('reviewStatus', reviewStatus)
    .setParameter('doneStatuses', doneStatuses)
    .groupBy('task.assignedAgentId')
    .orderBy('total', 'DESC')
    .addOrderBy('task.assignedAgentId', 'ASC')
    .take(MAX_ASSIGNEE_SUMMARY);

  const rows = (await qb.getRawMany()) as Array<{
    assigned_agent_id: string | null;
    display_name: string;
    total: string;
    open: string;
    review: string;
    done: string;
  }>;

  return rows.map((row) => ({
    assigned_agent_id: row.assigned_agent_id ?? null,
    display_name: row.display_name,
    total: parseInt(row.total, 10),
    open: parseInt(row.open, 10),
    review: parseInt(row.review, 10),
    done: parseInt(row.done, 10),
  }));
}

async function buildOrchestrationSummary(
  baseQb: SelectQueryBuilder<ProjectOrchestrationTask>,
): Promise<
  Array<{
    orchestration_id: string;
    title: string;
    total: number;
  }>
> {
  const qb = baseQb.clone();
  qb.select('task.orchestrationId', 'orchestration_id')
    .addSelect('MAX(orchestration.title)', 'title')
    .addSelect('COUNT(*)', 'total')
    .groupBy('task.orchestrationId')
    .orderBy('total', 'DESC')
    .addOrderBy('task.orchestrationId', 'ASC')
    .take(MAX_ORCHESTRATION_SUMMARY);

  const rows = (await qb.getRawMany()) as Array<{
    orchestration_id: string;
    title: string;
    total: string;
  }>;

  return rows.map((row) => ({
    orchestration_id: row.orchestration_id,
    title: row.title,
    total: parseInt(row.total, 10),
  }));
}

const MAX_BATCH_SUMMARY = 50;
const MAX_TIMELINE_BUCKETS = 30;

async function buildBatchSummary(
  baseQb: SelectQueryBuilder<ProjectOrchestrationTask>,
): Promise<
  Array<{
    batch_key: string;
    batch_label: string;
    orchestration_id: string;
    total: number;
    open: number;
    review: number;
    blocked_failed: number;
    completed: number;
    first_created_at: string;
    last_updated_at: string;
  }>
> {
  const openStatuses = [
    ProjectOrchestrationTaskStatus.PENDING,
    ProjectOrchestrationTaskStatus.DISPATCHED,
    ProjectOrchestrationTaskStatus.RUNNING,
    ProjectOrchestrationTaskStatus.CHANGES_REQUESTED,
  ];
  const reviewStatus = ProjectOrchestrationTaskStatus.READY_FOR_REVIEW;
  const blockedFailedStatuses = [ProjectOrchestrationTaskStatus.BLOCKED, ProjectOrchestrationTaskStatus.FAILED];
  const completedStatuses = [ProjectOrchestrationTaskStatus.APPROVED, ProjectOrchestrationTaskStatus.CANCELLED];

  const qb = baseQb.clone();
  qb.select('task.orchestrationId', 'orchestration_id')
    .addSelect('MAX(orchestration.title)', 'batch_label')
    .addSelect('COUNT(*)', 'total')
    .addSelect(
      'SUM(CASE WHEN task.status IN (:...openStatuses) THEN 1 ELSE 0 END)',
      'open',
    )
    .addSelect(
      'SUM(CASE WHEN task.status = :reviewStatus THEN 1 ELSE 0 END)',
      'review',
    )
    .addSelect(
      'SUM(CASE WHEN task.status IN (:...blockedFailedStatuses) THEN 1 ELSE 0 END)',
      'blocked_failed',
    )
    .addSelect(
      'SUM(CASE WHEN task.status IN (:...completedStatuses) THEN 1 ELSE 0 END)',
      'completed',
    )
    .addSelect('MIN(task.createdAt)', 'first_created_at')
    .addSelect('MAX(task.updatedAt)', 'last_updated_at')
    .setParameter('openStatuses', openStatuses)
    .setParameter('reviewStatus', reviewStatus)
    .setParameter('blockedFailedStatuses', blockedFailedStatuses)
    .setParameter('completedStatuses', completedStatuses)
    .groupBy('task.orchestrationId')
    .orderBy('MAX(task.updatedAt)', 'DESC')
    .addOrderBy('task.orchestrationId', 'ASC')
    .take(MAX_BATCH_SUMMARY);

  const rows = (await qb.getRawMany()) as Array<{
    orchestration_id: string;
    batch_label: string;
    total: string;
    open: string;
    review: string;
    blocked_failed: string;
    completed: string;
    first_created_at: string | Date;
    last_updated_at: string | Date;
  }>;

  return rows.map((row) => ({
    batch_key: `orchestration:${row.orchestration_id}`,
    batch_label: row.batch_label,
    orchestration_id: row.orchestration_id,
    total: parseInt(row.total, 10),
    open: parseInt(row.open, 10),
    review: parseInt(row.review, 10),
    blocked_failed: parseInt(row.blocked_failed, 10),
    completed: parseInt(row.completed, 10),
    first_created_at: parseDateValue(row.first_created_at).toISOString(),
    last_updated_at: parseDateValue(row.last_updated_at).toISOString(),
  }));
}

async function buildTimelineSummary(
  baseQb: SelectQueryBuilder<ProjectOrchestrationTask>,
): Promise<
  Array<{
    date: string;
    created: number;
    updated: number;
    completed: number;
    review_ready: number;
  }>
> {
  const qb = baseQb.clone();
  qb.select('task.createdAt', 'created_at')
    .addSelect('task.updatedAt', 'updated_at')
    .addSelect('task.completedAt', 'completed_at')
    .addSelect('task.status', 'status');

  const rows = (await qb.getRawMany()) as Array<{
    created_at: string | Date | null;
    updated_at: string | Date | null;
    completed_at: string | Date | null;
    status: ProjectOrchestrationTaskStatus;
  }>;

  const buckets = new Map<
    string,
    { created: number; updated: number; completed: number; review_ready: number }
  >();

  for (const row of rows) {
    const createdDate = row.created_at ? toISODate(row.created_at) : null;
    const updatedDate = row.updated_at ? toISODate(row.updated_at) : null;
    const completedDate = row.completed_at ? toISODate(row.completed_at) : null;

    if (createdDate) {
      const bucket = buckets.get(createdDate) ?? { created: 0, updated: 0, completed: 0, review_ready: 0 };
      bucket.created += 1;
      buckets.set(createdDate, bucket);
    }
    if (updatedDate) {
      const bucket = buckets.get(updatedDate) ?? { created: 0, updated: 0, completed: 0, review_ready: 0 };
      bucket.updated += 1;
      buckets.set(updatedDate, bucket);
    }
    if (completedDate) {
      const bucket = buckets.get(completedDate) ?? { created: 0, updated: 0, completed: 0, review_ready: 0 };
      bucket.completed += 1;
      if (row.status === ProjectOrchestrationTaskStatus.READY_FOR_REVIEW) {
        bucket.review_ready += 1;
      }
      buckets.set(completedDate, bucket);
    }
  }

  const result = Array.from(buckets.entries())
    .map(([date, counts]) => ({
      date,
      created: counts.created,
      updated: counts.updated,
      completed: counts.completed,
      review_ready: counts.review_ready,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return result.slice(0, MAX_TIMELINE_BUCKETS);
}

function toISODate(date: string | Date): string {
  return parseDateValue(date).toISOString().slice(0, 10);
}

function parseDateValue(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function normalizeRequiredString(
  value: unknown,
  field: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `${field} is required` };
  }
  return { ok: true, value: value.trim().slice(0, maxLength) };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
    .map((item) => item.trim());
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0))]
    .slice(0, 50);
}

function normalizeCapability(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized.slice(0, 128) : null;
}

function normalizeTaskPriority(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : 0;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function normalizeTaskRetryLimit(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : 2;
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(0, Math.trunc(parsed));
}

function normalizeProgressPercent(
  value: unknown,
): { ok: true; present: false } | { ok: true; present: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, present: false };
  if (value === null || value === '') return { ok: true, present: true, value: null };
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(parsed)) {
    return { ok: false, error: 'progress_percent must be an integer from 0 to 100' };
  }
  if (parsed < 0 || parsed > 100) {
    return { ok: false, error: 'progress_percent must be between 0 and 100' };
  }
  return { ok: true, present: true, value: parsed };
}

function normalizeEvidence(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string' && value.trim()) return { summary: value.trim() };
  return {};
}

function normalizeTaskEvidence(
  value: unknown,
): { ok: true; value: ProjectOrchestrationTaskEvidence | null } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (!isPlainObject(value)) {
    return { ok: false, error: 'evidence must be an object with files_changed array' };
  }
  if (!Array.isArray(value.files_changed)) {
    return { ok: false, error: 'evidence.files_changed must be an array' };
  }
  const filesChanged: string[] = [];
  for (const item of value.files_changed) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'evidence.files_changed must contain only strings' };
    }
    const file = item.trim();
    if (file) filesChanged.push(file);
  }

  const testPassed = value.test_passed;
  if (testPassed !== undefined && testPassed !== null && typeof testPassed !== 'boolean') {
    return { ok: false, error: 'evidence.test_passed must be boolean or null' };
  }

  const diffSummary = nullableEvidenceString(value.diff_summary, 'evidence.diff_summary');
  if (!diffSummary.ok) return diffSummary;
  const riskNotes = nullableEvidenceString(value.risk_notes, 'evidence.risk_notes');
  if (!riskNotes.ok) return riskNotes;

  return {
    ok: true,
    value: {
      files_changed: filesChanged,
      test_passed: testPassed === undefined ? null : testPassed,
      diff_summary: diffSummary.value,
      risk_notes: riskNotes.value,
    },
  };
}

function nullableEvidenceString(
  value: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string or null` };
  }
  const trimmed = value.trim();
  return { ok: true, value: trimmed || null };
}

function normalizeCompletionStatus(value: unknown): ProjectOrchestrationTaskStatus | null {
  if (value === undefined || value === null || value === '') {
    return ProjectOrchestrationTaskStatus.READY_FOR_REVIEW;
  }
  if (
    value === ProjectOrchestrationTaskStatus.READY_FOR_REVIEW ||
    value === ProjectOrchestrationTaskStatus.BLOCKED ||
    value === ProjectOrchestrationTaskStatus.FAILED
  ) {
    return value;
  }
  return null;
}

function validateProjectPath(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: 'path is required and must be a string' };
  }
  const path = value.trim().replace(/\\/g, '/');
  if (!path || path.length > 1024) {
    return { ok: false, error: 'path must be 1-1024 characters' };
  }
  if (path.startsWith('/') || path.includes('//') || path.split('/').includes('..')) {
    return { ok: false, error: 'path must be relative and cannot contain .. or empty segments' };
  }
  return { ok: true, value: path };
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/g, '');
}

function normalizeContentType(value: unknown): string {
  if (value === 'text/plain' || value === 'application/json' || value === 'text/markdown') {
    return value;
  }
  return 'text/markdown';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ── R18a: idempotent task dispatch (dedup on title+goal hash) ────────────────
//
// When the PM dispatches a task whose normalized (title, goal) matches an
// already-active task for the same agent in the same orchestration, we reject
// the duplicate with 409 instead of creating a second in-flight task. "Active"
// = dispatched | running | changes_requested — once a task reaches a review or
// terminal state the same logical task may be dispatched again (e.g. a fresh
// iteration after the previous one was approved).
const TASK_DEDUP_ACTIVE_STATUSES: ProjectOrchestrationTaskStatus[] = [
  ProjectOrchestrationTaskStatus.DISPATCHED,
  ProjectOrchestrationTaskStatus.RUNNING,
  ProjectOrchestrationTaskStatus.CHANGES_REQUESTED,
];

/** Normalize free text for dedup: trim, lowercase, collapse whitespace runs. */
function normalizeForDedup(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Stable dedup hash over the normalized (title, goal) pair. Two dispatches
 *  with the same logical title+goal produce the same hash regardless of
 *  capitalization or incidental whitespace. */
function computeDedupHash(title: string, goal: string): string {
  return sha256(`${normalizeForDedup(title)}\n${normalizeForDedup(goal)}`);
}

// ── Loop status helpers (GET /v1/projects/:project_id/loop-status) ───────────

/** A task is "stalled" when it is dispatched/running but has been quiet for at
 *  least this long. Configurable via LOOP_STALL_MINUTES for tests. */
const DEFAULT_LOOP_STALL_MINUTES = 15;

function loopStallMs(): number {
  const raw = process.env.LOOP_STALL_MINUTES;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 60_000;
  }
  return DEFAULT_LOOP_STALL_MINUTES * 60_000;
}

/** Whole-minutes difference between a past date and a "now" epoch ms, floored at 0. */
function minutesBetween(from: Date | string | null | undefined, nowMs: number): number {
  if (!from) return 0;
  const fromMs = from instanceof Date ? from.getTime() : new Date(from).getTime();
  if (!Number.isFinite(fromMs)) return 0;
  return Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
}

/** Latest non-null date among the given values (null when all are absent). */
function latestOf(...dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (d && (best === null || d.getTime() > best.getTime())) best = d;
  }
  return best;
}

/**
 * Build the project loop-status overview. Project-wide by design (agents calling
 * are already verified project members via requirePermission).
 *
 * Orchestration buckets cover every status so nothing is invisible:
 *   running   = planning | running | ready_for_acceptance (in-flight)
 *   blocked   = blocked | failed (needs intervention)
 *   completed = completed | cancelled (terminal)
 */
export async function buildLoopStatus(projectId: string) {
  const now = Date.now();
  const stallCutoff = new Date(now - loopStallMs());

  const [agents, changesets, tasks, orchestrations] = await Promise.all([
    AppDataSource.getRepository(Agent).find({
      where: { projectId },
      order: { name: 'ASC' },
    }),
    AppDataSource.getRepository(ProjectChangeset).find({
      where: { projectId },
      order: { updatedAt: 'DESC' },
    }),
    AppDataSource.getRepository(ProjectOrchestrationTask).find({
      where: { projectId },
    }),
    AppDataSource.getRepository(ProjectOrchestration).find({
      where: { projectId },
    }),
  ]);

  const workers = agents.map((agent) => {
    const presence = getAgentPresence(agent, now);
    return {
      id: agent.id,
      name: agent.name,
      online: presence.isOnline,
      health_status: presence.healthStatus,
      last_heartbeat_age_seconds:
        presence.heartbeatAgeMs !== null ? Math.floor(presence.heartbeatAgeMs / 1000) : null,
    };
  });

  const terminalChangesetStatuses = [
    ProjectChangesetStatus.MERGED,
    ProjectChangesetStatus.REJECTED,
    ProjectChangesetStatus.CANCELLED,
  ];
  const pending_changesets = changesets
    .filter((cs) => !terminalChangesetStatuses.includes(cs.status))
    .map((cs) => ({
      id: cs.id,
      title: cs.title,
      status: cs.status,
      age_minutes: minutesBetween(cs.createdAt, now),
    }));

  const stalledTaskStatuses = [
    ProjectOrchestrationTaskStatus.DISPATCHED,
    ProjectOrchestrationTaskStatus.RUNNING,
  ];
  const stalled_tasks = tasks
    .filter((task) => stalledTaskStatuses.includes(task.status))
    .map((task) => ({
      task,
      // Stall = worker inactivity. Anchor on worker-activity timestamps, NOT
      // createdAt (that is when the PM created the row, which would mask a
      // freshly-inserted-but-long-dispatched task). A task lacking all three
      // has no dispatch footprint yet and is treated as not stalled.
      lastActivityAt: latestOf(task.progressAt, task.claimedAt, task.dispatchedAt),
    }))
    .filter((entry) => entry.lastActivityAt !== null && entry.lastActivityAt.getTime() < stallCutoff.getTime())
    .map((entry) => ({
      id: entry.task.id,
      title: entry.task.title,
      status: entry.task.status,
      age_minutes: minutesBetween(entry.lastActivityAt, now),
    }))
    .sort((a, b) => b.age_minutes - a.age_minutes);

  const running_tasks = tasks.filter(
    (task) => task.status === ProjectOrchestrationTaskStatus.RUNNING,
  ).length;

  const runningOrchestrationStatuses = [
    ProjectOrchestrationStatus.PLANNING,
    ProjectOrchestrationStatus.RUNNING,
    ProjectOrchestrationStatus.READY_FOR_ACCEPTANCE,
  ];
  const blockedOrchestrationStatuses = [
    ProjectOrchestrationStatus.BLOCKED,
    ProjectOrchestrationStatus.FAILED,
  ];
  const completedOrchestrationStatuses = [
    ProjectOrchestrationStatus.COMPLETED,
    ProjectOrchestrationStatus.CANCELLED,
  ];

  return {
    workers,
    pending_changesets,
    running_tasks,
    stalled_tasks,
    orchestrations: {
      running: orchestrations.filter((o) => runningOrchestrationStatuses.includes(o.status)).length,
      blocked: orchestrations.filter((o) => blockedOrchestrationStatuses.includes(o.status)).length,
      completed: orchestrations.filter((o) => completedOrchestrationStatuses.includes(o.status)).length,
    },
  };
}

/**
 * Build per-worker load payload for GET /v1/projects/:project_id/worker-load.
 *
 * Each project agent gets a row with its presence/health, current running task
 * count, pending (non-terminal) changeset count, the last time it completed a
 * task, and a utilization score based on its configured max_concurrent
 * capacity (default 3).
 */
async function buildWorkerLoad(projectId: string) {
  const now = Date.now();

  const [agents, tasks, changesets] = await Promise.all([
    AppDataSource.getRepository(Agent).find({
      where: { projectId },
      order: { name: 'ASC' },
    }),
    AppDataSource.getRepository(ProjectOrchestrationTask).find({
      where: { projectId },
    }),
    AppDataSource.getRepository(ProjectChangeset).find({
      where: { projectId },
    }),
  ]);

  const terminalChangesetStatuses = [
    ProjectChangesetStatus.MERGED,
    ProjectChangesetStatus.REJECTED,
    ProjectChangesetStatus.CANCELLED,
  ];

  return agents.map((agent) => {
    const presence = getAgentPresence(agent, now);
    const agentTasks = tasks.filter((task) => task.assignedAgentId === agent.id);
    const runningTasks = agentTasks.filter(
      (task) => task.status === ProjectOrchestrationTaskStatus.RUNNING,
    ).length;
    const pendingChangesets = changesets.filter(
      (cs) => cs.createdByAgentId === agent.id && !terminalChangesetStatuses.includes(cs.status),
    ).length;
    const lastCompletedTask = agentTasks
      .filter((task) => task.completedAt !== null && task.completedAt !== undefined)
      .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())[0];
    const maxConcurrent = getAgentMaxConcurrent(agent);
    const utilizationScore = maxConcurrent > 0 ? Math.round((runningTasks / maxConcurrent) * 100) / 100 : 0;

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      online: presence.isOnline,
      health_status: presence.healthStatus,
      running_tasks: runningTasks,
      pending_changesets: pendingChangesets,
      last_task_completed_at: lastCompletedTask?.completedAt?.toISOString() ?? null,
      utilization_score: utilizationScore,
    };
  });
}

/** Cap for the recent-activity slices surfaced on the dashboard. */
const DASHBOARD_RECENT_LIMIT = 5;

/**
 * Build the aggregated dashboard payload for GET /v1/projects/:project_id/dashboard.
 *
 * Each section reuses the same builder/serializer as its dedicated endpoint so the
 * dashboard is a strict superset of calling them individually:
 *   loop_status       = buildLoopStatus(projectId)               // GET /loop-status
 *   metrics           = buildProjectMetrics(projectId)           // GET /metrics
 *   worker_load       = { data: buildWorkerLoad(projectId) }     // GET /worker-load
 *   recent_changesets = last DASHBOARD_RECENT_LIMIT by updatedAt // GET /changesets ordering + serializeChangeset
 *   recent_tasks      = last DASHBOARD_RECENT_LIMIT by updatedAt // serializeTask
 *
 * The independent sections are fetched concurrently; the timestamp is captured
 * once, after the data resolves, so generated_at reflects the snapshot.
 */
async function buildDashboard(projectId: string) {
  const [loop_status, metrics, workers, recentChangesets, recentTasks] = await Promise.all([
    buildLoopStatus(projectId),
    buildProjectMetrics(projectId),
    buildWorkerLoad(projectId),
    AppDataSource.getRepository(ProjectChangeset).find({
      where: { projectId },
      order: { updatedAt: 'DESC' },
      take: DASHBOARD_RECENT_LIMIT,
    }),
    AppDataSource.getRepository(ProjectOrchestrationTask).find({
      where: { projectId },
      order: { updatedAt: 'DESC' },
      take: DASHBOARD_RECENT_LIMIT,
    }),
  ]);

  return {
    loop_status,
    metrics,
    worker_load: { data: workers },
    recent_changesets: recentChangesets.map(serializeChangeset),
    recent_tasks: recentTasks.map(serializeTask),
    generated_at: new Date().toISOString(),
  };
}

function getAgentMaxConcurrent(agent: Agent): number {
  const configValue = agent.configJson?.max_concurrent;
  if (typeof configValue === 'number' && Number.isFinite(configValue) && configValue > 0) {
    return configValue;
  }
  if (typeof configValue === 'string') {
    const parsed = Number(configValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 3;
}

/**
 * Pick the best available worker for smart-dispatch.
 *
 * Eligibility: project agents with an active lifecycle, currently online (fresh
 * heartbeat), and not smoke-unhealthy (null/legacy health is allowed). When a
 * required capability is given, the agent must declare it. Among the eligible
 * agents, the one with the fewest in-flight (active: dispatched/running/
 * changes_requested) tasks wins; ties break by agent name for determinism.
 *
 * Returns null when no agent is eligible (caller emits 409).
 */
export async function selectBestWorker(
  projectId: string,
  requiredCapability: string | null,
): Promise<{ agentId: string; agentName: string; reason: string } | null> {
  const agents = await AppDataSource.getRepository(Agent).find({
    where: { projectId, lifecycleStatus: AgentLifecycleStatus.ACTIVE },
  });

  // (1) online + healthy, (2) capability filter
  const eligible = agents.filter((agent) => {
    const presence = getAgentPresence(agent);
    if (!presence.isOnline) return false;
    if (agent.healthStatus === AgentSmokeHealth.UNHEALTHY) return false;
    if (requiredCapability && !normalizeCapabilities(agent.capabilities).includes(requiredCapability)) {
      return false;
    }
    return true;
  });

  if (eligible.length === 0) return null;

  // (3) fewest in-flight (active) tasks
  const activeTasks = await AppDataSource.getRepository(ProjectOrchestrationTask).find({
    where: { projectId, status: In(TASK_DEDUP_ACTIVE_STATUSES) },
  });
  const activeCountByAgent = new Map<string, number>();
  for (const t of activeTasks) {
    if (!t.assignedAgentId) continue;
    activeCountByAgent.set(t.assignedAgentId, (activeCountByAgent.get(t.assignedAgentId) ?? 0) + 1);
  }

  const ranked = eligible
    .map((agent) => ({ agent, load: activeCountByAgent.get(agent.id) ?? 0 }))
    .sort((a, b) => {
      if (a.load !== b.load) return a.load - b.load;     // fewest in-flight first
      return a.agent.name.localeCompare(b.agent.name);   // deterministic tie-break
    });

  const best = ranked[0];
  const capabilityClause = requiredCapability ? `, ${requiredCapability}-capable` : '';
  const reason =
    `fewest active tasks (${best.load}) among ${eligible.length} online, healthy` +
    `${capabilityClause} worker${eligible.length === 1 ? '' : 's'}`;

  return { agentId: best.agent.id, agentName: best.agent.name, reason };
}

function computeAverageDurationMinutes(
  intervals: Array<{ start: Date | string | null | undefined; end: Date | string | null | undefined }>,
): number | null {
  if (intervals.length === 0) return null;
  let totalMs = 0;
  let count = 0;
  for (const { start, end } of intervals) {
    const startDate = start ? new Date(start) : null;
    const endDate = end ? new Date(end) : null;
    if (startDate && endDate && !Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime())) {
      totalMs += endDate.getTime() - startDate.getTime();
      count += 1;
    }
  }
  if (count === 0) return null;
  const minutes = totalMs / count / 60_000;
  return Math.round(minutes * 100) / 100;
}

function groupByAgentId<T>(items: T[], getAgentId: (item: T) => string | null | undefined): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const agentId = getAgentId(item);
    if (!agentId) continue;
    const list = groups[agentId] ?? [];
    list.push(item);
    groups[agentId] = list;
  }
  return groups;
}

// ── R30b: Scheduled Dispatch ────────────────────────────────────────────────

router.post(
  '/v1/projects/:project_id/scheduled-dispatch',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const actor = getActor(req);
      if (!actor) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const title = normalizeRequiredString(req.body.title, 'title', 255);
      const goal = normalizeRequiredString(req.body.goal, 'goal', 20_000);
      const cronPattern = normalizeRequiredString(req.body.cron_pattern, 'cron_pattern', 64);

      if (!title.ok) {
        res.status(422).json({ detail: title.error });
        return;
      }
      if (!goal.ok) {
        res.status(422).json({ detail: goal.error });
        return;
      }
      if (!cronPattern.ok) {
        res.status(422).json({ detail: cronPattern.error });
        return;
      }

      const nextRunAt = nextCronDate(cronPattern.value, new Date());
      if (!nextRunAt) {
        res.status(422).json({ detail: 'Invalid cron_pattern. Expected 5-field cron expression (minute hour day-of-month month day-of-week)' });
        return;
      }

      const maxConcurrent = typeof req.body.max_concurrent === 'number' && req.body.max_concurrent > 0
        ? Math.min(Math.floor(req.body.max_concurrent), 10)
        : 1;

      const workerCapability = typeof req.body.worker_capability === 'string' && req.body.worker_capability.trim()
        ? req.body.worker_capability.trim()
        : null;

      const repo = AppDataSource.getRepository(ScheduledDispatch);
      const schedule = repo.create({
        id: randomUUID(),
        projectId,
        title: title.value,
        goal: goal.value,
        cronPattern: cronPattern.value,
        workerCapability,
        maxConcurrent,
        enabled: true,
        nextRunAt,
      });
      await repo.save(schedule);

      res.status(201).json(serializeSchedule(schedule));
    } catch (err) {
      console.error('Create scheduled-dispatch error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/schedules',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const repo = AppDataSource.getRepository(ScheduledDispatch);
      const schedules = await repo.find({
        where: { projectId },
        order: { createdAt: 'DESC' },
      });
      res.json({ data: schedules.map(serializeSchedule) });
    } catch (err) {
      console.error('List schedules error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.delete(
  '/v1/projects/:project_id/schedules/:schedule_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const scheduleId = req.params.schedule_id;
      const repo = AppDataSource.getRepository(ScheduledDispatch);
      const schedule = await repo.findOne({
        where: { id: scheduleId, projectId },
      });
      if (!schedule) {
        res.status(404).json({ detail: 'Schedule not found' });
        return;
      }
      await repo.remove(schedule);
      res.status(204).send();
    } catch (err) {
      console.error('Delete schedule error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

function serializeSchedule(schedule: ScheduledDispatch): Record<string, unknown> {
  return {
    id: schedule.id,
    project_id: schedule.projectId,
    title: schedule.title,
    goal: schedule.goal,
    cron_pattern: schedule.cronPattern,
    worker_capability: schedule.workerCapability ?? null,
    max_concurrent: schedule.maxConcurrent,
    enabled: schedule.enabled,
    last_run_at: schedule.lastRunAt?.toISOString() ?? null,
    next_run_at: schedule.nextRunAt?.toISOString() ?? null,
    created_at: schedule.createdAt.toISOString(),
    updated_at: schedule.updatedAt.toISOString(),
  };
}

export default router;
