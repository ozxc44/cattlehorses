/**
 * Conflict Guard v1 — detect file-level write conflicts between active tasks.
 *
 * When a worker claims a task, it can declare a write_set (files it intends to
 * modify). The platform tracks active write_sets; if two tasks target the same
 * file, the later one gets flagged conflict_risk so the PM can serialize them
 * before changeset conflicts actually occur.
 *
 * gk-recommended design (R10): preemptive warning > auto-resolve.
 */
import { AppDataSource } from '../data-source';
import { ProjectOrchestrationTask, ProjectOrchestrationTaskStatus } from '../entities/project-orchestration-task.entity';

export type ConflictRisk = {
  taskId: string;
  conflictingTaskId: string;
  conflictingFiles: string[];
  severity: 'high' | 'medium';
};

/**
 * Check a candidate write_set against all currently-running tasks' write_sets.
 * Returns conflicts if any file overlaps with an active task.
 */
export async function checkWriteConflicts(
  projectId: string,
  candidateWriteSet: string[],
  excludeTaskId?: string,
): Promise<ConflictRisk[]> {
  if (!candidateWriteSet.length) return [];

  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
  // Active tasks = claimed/running, excluding the caller itself.
  const activeTasks = await taskRepo
    .createQueryBuilder('task')
    .innerJoin('task.orchestration', 'orch')
    .where('orch.projectId = :projectId', { projectId })
    .andWhere('task.status IN (:...active)', {
      active: [ProjectOrchestrationTaskStatus.RUNNING, ProjectOrchestrationTaskStatus.DISPATCHED],
    })
    .andWhere(excludeTaskId ? 'task.id != :exclude' : '1=1', { exclude: excludeTaskId })
    .getMany();

  const conflicts: ConflictRisk[] = [];
  for (const activeTask of activeTasks) {
    // Extract write_set from task metadata (workers declare via progress or evidence).
    const activeWriteSet = extractWriteSet(activeTask);
    if (!activeWriteSet.length) continue;

    const overlap = candidateWriteSet.filter((f) =>
      activeWriteSet.some((af) => f === af || f.startsWith(af.split('/').slice(0, -1).join('/') + '/')),
    );
    if (overlap.length > 0) {
      conflicts.push({
        taskId: excludeTaskId || '(candidate)',
        conflictingTaskId: activeTask.id,
        conflictingFiles: overlap,
        severity: overlap.length > 2 ? 'high' : 'medium',
      });
    }
  }
  return conflicts;
}

/**
 * Extract the write_set from a task's metadata.
 * Workers declare intended files via task metadata.write_set or evidence.files_changed.
 */
function extractWriteSet(task: ProjectOrchestrationTask): string[] {
  const meta = task.metadata as Record<string, unknown> | null;
  if (meta && Array.isArray(meta.write_set)) {
    return meta.write_set.filter((f): f is string => typeof f === 'string');
  }
  // Fall back to evidence.files_changed if task has evidence.
  const evidence = task.evidenceJson as Record<string, unknown> | null;
  if (evidence && Array.isArray(evidence.files_changed)) {
    return evidence.files_changed.filter((f): f is string => typeof f === 'string');
  }
  return [];
}

/**
 * Record a write_set on a task (called when worker declares intended files).
 */
export async function declareWriteSet(taskId: string, writeSet: string[]): Promise<void> {
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
  await taskRepo.update(taskId, { metadata: JSON.stringify({ write_set: writeSet }) } as any);
}
