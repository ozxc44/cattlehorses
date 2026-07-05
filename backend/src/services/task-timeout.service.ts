import { AppDataSource } from '../data-source';
import { ProjectOrchestration, ProjectOrchestrationStatus } from '../entities/project-orchestration.entity';
import { ProjectOrchestrationTask, ProjectOrchestrationTaskStatus } from '../entities/project-orchestration-task.entity';
import { createInboxItem } from '../routes/agent-inbox.routes';
import { upsertProjectFileContent } from './project-file.service';

/**
 * Task timeout enforcement sweep (R32c).
 *
 * Finds dispatched/running tasks that have been active longer than their
 * configured timeoutSeconds (default 1800s / 30min). Marks them FAILED with
 * metadata.timeout = { expired_at, duration, reason: 'timeout' } and then
 * applies the R6 auto-triage rule: retry if retries remain, otherwise create
 * an auto-triaged fix task (up to 3 per orchestration).
 *
 * The sweep is idempotent at the task level: once a task has transitioned out
 * of a live status it will not be selected again.
 */

const DEFAULT_TASK_TIMEOUT_SECONDS = positiveIntFromEnv('TASK_TIMEOUT_SECONDS', 1800);
const SWEEP_INTERVAL_MS = positiveIntFromEnv('TASK_TIMEOUT_SWEEP_MS', 300_000);
const SYSTEM_ACTOR_ID = 'system:task-timeout';
const MAX_AUTO_TRIAGED_FIX_TASKS = 3;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export type TaskTimeoutSweepResult = {
  scanned: number;
  timed_out: number;
  retried: number;
  fix_tasks_created: number;
};

export async function runTaskTimeoutSweep(now = new Date()): Promise<TaskTimeoutSweepResult> {
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);

  const liveStatuses = [ProjectOrchestrationTaskStatus.DISPATCHED, ProjectOrchestrationTaskStatus.RUNNING];
  const runningOrchestrationStatuses = [
    ProjectOrchestrationStatus.PLANNING,
    ProjectOrchestrationStatus.RUNNING,
    ProjectOrchestrationStatus.BLOCKED,
    ProjectOrchestrationStatus.FAILED,
  ];

  const candidates = await taskRepo
    .createQueryBuilder('task')
    .innerJoinAndSelect('task.orchestration', 'orch')
    .where('task.status IN (:...liveStatuses)', { liveStatuses })
    .andWhere('orch.status IN (:...runningOrchestrationStatuses)', { runningOrchestrationStatuses })
    .getMany();

  const result: TaskTimeoutSweepResult = {
    scanned: candidates.length,
    timed_out: 0,
    retried: 0,
    fix_tasks_created: 0,
  };

  for (const task of candidates) {
    const timeoutSeconds = task.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
    const referenceAt = task.claimedAt ?? task.dispatchedAt ?? task.createdAt;
    if (!referenceAt) continue;

    const elapsedMs = now.getTime() - referenceAt.getTime();
    if (elapsedMs <= timeoutSeconds * 1000) continue;

    await AppDataSource.transaction(async (manager) => {
      const expiredAt = now;
      const durationSeconds = Math.round(elapsedMs / 1000);

      // Auto-fail: status=FAILED with timeout metadata.
      task.status = ProjectOrchestrationTaskStatus.FAILED;
      task.completedAt = expiredAt;
      task.metadata = {
        ...(task.metadata ?? {}),
        timeout: {
          expired_at: expiredAt.toISOString(),
          duration: durationSeconds,
          reason: 'timeout',
        },
      };
      await manager.save(ProjectOrchestrationTask, task);
      result.timed_out += 1;

      // R6 auto-triage: retry if possible, otherwise create a fix task.
      const retryCount = task.retryCount ?? 0;
      const maxRetries = task.maxRetries ?? 2;

      if (retryCount < maxRetries) {
        task.retryCount = retryCount + 1;
        task.status = ProjectOrchestrationTaskStatus.DISPATCHED;
        task.completedAt = undefined;
        task.reviewedAt = undefined;
        task.reviewNotes = null;
        task.requestedChanges = null;
        task.progressNote = null;
        task.progressPercent = null;
        task.progressAt = null;
        task.dispatchedAt = expiredAt;
        task.metadata = {
          ...task.metadata,
          last_retry_at: expiredAt.toISOString(),
          last_retry_reason: 'timeout',
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

        await refreshTaskLedger(manager, task.orchestration);

        if (task.assignedAgentId) {
          await createInboxItem({
            projectId: task.projectId,
            recipientAgentId: task.assignedAgentId,
            eventType: 'task_dispatched',
            title: `Task retry dispatched (timeout): ${task.title}`,
            body: [
              `Task ID: ${task.id}`,
              `Retry: ${task.retryCount}/${task.maxRetries ?? 2}`,
              `Reason: previous attempt timed out after ${durationSeconds}s`,
              '',
              'Claim the task and complete it before the timeout elapses again.',
            ].join('\n'),
            orchestrationId: task.orchestrationId,
            taskId: task.id,
            payload: {
              retry_count: task.retryCount,
              max_retries: task.maxRetries ?? 2,
              reason: 'timeout',
            },
          }).catch((err) => console.error('task-timeout retry notify error:', err));
        }

        result.retried += 1;
      } else {
        // Retries exhausted: mark orchestration FAILED and auto-triage a fix task.
        task.orchestration.status = ProjectOrchestrationStatus.FAILED;
        await manager.save(ProjectOrchestration, task.orchestration);

        const siblingTasks = await manager.getRepository(ProjectOrchestrationTask).find({
          where: { orchestrationId: task.orchestrationId },
        });
        const autoFixCount = siblingTasks.filter(
          (t) => (t.metadata as Record<string, unknown> | null)?.auto_triaged === true,
        ).length;

        if (autoFixCount < MAX_AUTO_TRIAGED_FIX_TASKS) {
          const fixTask = manager.create(ProjectOrchestrationTask, {
            projectId: task.projectId,
            orchestrationId: task.orchestrationId,
            title: `Fix: ${(task.title || '').slice(0, 180)}`,
            goal: `Previous task timed out after ${durationSeconds}s and failed after ${retryCount} retries. Original goal: ${(task.goal || '').slice(0, 300)} Review the failure and provide a corrected implementation.`,
            status: ProjectOrchestrationTaskStatus.DISPATCHED,
            assignedAgentId: task.assignedAgentId,
            workerTaskPath: `.agent/orchestrations/${task.orchestrationId}/workers/auto-fix-${Date.now()}.worker_task.md`,
            workerContextPath: `.agent/orchestrations/${task.orchestrationId}/workers/auto-fix-${Date.now()}.worker_context.md`,
            dispatchedAt: new Date(),
            metadata: { auto_triaged: true, source_task: task.id, fix_round: autoFixCount + 1, reason: 'timeout' },
          });
          await manager.save(ProjectOrchestrationTask, fixTask);
          result.fix_tasks_created += 1;
          console.log(`[auto-triage] created fix task ${autoFixCount + 1}/${MAX_AUTO_TRIAGED_FIX_TASKS} for timed-out task ${task.id}`);
        } else {
          console.log(`[auto-triage] loop guard: max ${MAX_AUTO_TRIAGED_FIX_TASKS} fix tasks reached for orchestration ${task.orchestrationId}`);
        }

        await refreshTaskLedger(manager, task.orchestration);
      }
    });
  }

  return result;
}

async function refreshTaskLedger(manager: typeof AppDataSource.manager, orchestration: ProjectOrchestration): Promise<void> {
  const tasks = await manager.find(ProjectOrchestrationTask, {
    where: { orchestrationId: orchestration.id },
    order: { createdAt: 'ASC' },
  });

  await upsertProjectFileContent(manager, {
    projectId: orchestration.projectId,
    path: `${orchestration.basePath}/tasks.json`,
    content: JSON.stringify(tasks.map(serializeTaskLedgerItem), null, 2) + '\n',
    contentType: 'application/json',
    actorId: SYSTEM_ACTOR_ID,
    message: 'Refresh orchestration task ledger after timeout sweep',
  });
}

function serializeTaskLedgerItem(task: ProjectOrchestrationTask): Record<string, unknown> {
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
    timeout_seconds: task.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS,
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
    metadata: task.metadata ?? null,
  };
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic timeout sweep (idempotent). */
export function startTaskTimeoutSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runTaskTimeoutSweep().catch((err) => console.error('task-timeout sweep error:', err));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/** Stop the sweep (tests). */
export function stopTaskTimeoutSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
