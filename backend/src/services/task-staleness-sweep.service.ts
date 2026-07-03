import { AppDataSource } from '../data-source';
import { ProjectOrchestration, ProjectOrchestrationStatus } from '../entities/project-orchestration.entity';
import { ProjectOrchestrationTask, ProjectOrchestrationTaskStatus } from '../entities/project-orchestration-task.entity';
import { createInboxItem } from '../routes/agent-inbox.routes';

/**
 * Task staleness sweep.
 *
 * Detects tasks that have been dispatched but never claimed (or claimed but
 * stalled) beyond a configurable timeout, marks them stale in metadata, and
 * notifies the orchestration's main agent so it can reassign (or wait).
 *
 * The sweep only NOTIFIES — it never auto-cancels or reassigns. The decision to
 * reassign stays with the main agent (human-in-the-loop), per the design. This
 * avoids killing work that is legitimately in progress on a slow worker.
 *
 * Idempotent: once metadata.stale_notified_at is set it won't notify again for
 * the same stall.
 */

const TASK_STALE_MINUTES = positiveIntFromEnv('TASK_STALE_MINUTES', 10);
const SWEEP_INTERVAL_MS = positiveIntFromEnv('TASK_STALE_SWEEP_MS', 60_000);

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const staleThresholdMs = TASK_STALE_MINUTES * 60_000;

export async function runTaskStalenessSweep(now = new Date()): Promise<{ marked: number }> {
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
  const threshold = now.getTime() - staleThresholdMs;

  // Candidates: dispatched-but-unclaimed OR running-but-stalled, in a non-terminal
  // orchestration, not already marked stale.
  // JSON access is dialect-specific: Postgres uses `col::jsonb ->> 'key'`,
  // SQLite uses `json_extract(col, '$.key')`. Tests run on SQLite, prod on Postgres.
  const isSqlite = AppDataSource.options.type === 'better-sqlite3';
  const staleNotifiedNull = isSqlite
    ? "(task.metadata IS NULL OR json_extract(task.metadata, '$.stale_notified_at') IS NULL)"
    : "(task.metadata IS NULL OR (task.metadata::jsonb ->> 'stale_notified_at') IS NULL)";
  const candidates = await taskRepo
    .createQueryBuilder('task')
    .innerJoinAndSelect('task.orchestration', 'orch')
    .where('task.status IN (:...live)', { live: [ProjectOrchestrationTaskStatus.DISPATCHED, ProjectOrchestrationTaskStatus.RUNNING, ProjectOrchestrationTaskStatus.READY_FOR_REVIEW] })
    .andWhere('orch.status IN (:...running)', { running: [ProjectOrchestrationStatus.RUNNING, ProjectOrchestrationStatus.PLANNING] })
    .andWhere(staleNotifiedNull)
    .getMany();

  let marked = 0;
  for (const task of candidates) {
    const reference = task.claimedAt ?? task.dispatchedAt;
    if (!reference) continue;
    if (reference.getTime() <= threshold) {
      // Stale. Mark + notify the main agent.
      const isReview = task.status === ProjectOrchestrationTaskStatus.READY_FOR_REVIEW;
      const ts = now.toISOString();
      task.metadata = {
        ...(task.metadata || {}),
        stale: true,
        stale_reason: task.status === ProjectOrchestrationTaskStatus.DISPATCHED ? 'unclaimed'
          : isReview ? 'review_overdue'
          : 'running_no_progress',
        stale_threshold_minutes: TASK_STALE_MINUTES,
        stale_notified_at: ts,
      };
      await taskRepo.save(task);
      marked++;

      const mainAgentId = task.orchestration?.mainAgentId;
      if (mainAgentId) {
        const body = isReview
          ? `Task ${task.id} has been waiting for your review since ${reference.toISOString()} (${TASK_STALE_MINUTES}+ min). Run: zz changesets approve-and-merge <id> or request changes.`
          : `Task ${task.id} has been ${task.status} since ${reference.toISOString()} (${TASK_STALE_MINUTES}+ min). Reassign via zz tasks reassign ${task.id} --to <agent> or wait.`;
        await createInboxItem({
          projectId: task.projectId,
          recipientAgentId: mainAgentId,
          eventType: 'task_stale',
          title: isReview ? `Review overdue: ${task.title}` : `Task may be stalled: ${task.title}`,
          body,
          orchestrationId: task.orchestrationId,
          taskId: task.id,
        }).catch((err) => console.error('task-staleness notify error:', err));
      }
    }
  }
  return { marked };
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic staleness sweep (idempotent). */
export function startTaskStalenessSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runTaskStalenessSweep().catch((err) => console.error('task-staleness sweep error:', err));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/** Stop the sweep (tests). */
export function stopTaskStalenessSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
