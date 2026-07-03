import { ProjectOrchestrationTask } from '../entities/project-orchestration-task.entity';

export type TaskVerificationResult = {
  passed: boolean;
  failures: string[];
};

/**
 * Lightweight, deterministic quality gate for task completion.
 *
 * Checks:
 *  - resultMd trimmed length >= 20 chars.
 *  - if task.acceptanceCriteria is a non-empty array, each non-empty criterion
 *    string (or its first 4 words) must appear in resultMd (case-insensitive).
 */
export async function verifyTaskCompletion(
  task: ProjectOrchestrationTask,
  resultMd: string,
): Promise<TaskVerificationResult> {
  const failures: string[] = [];

  const trimmedResult = resultMd.trim();
  if (trimmedResult.length < 20) {
    failures.push('result_md must be at least 20 characters');
  }

  const criteria = task.acceptanceCriteria;
  if (Array.isArray(criteria) && criteria.length > 0) {
    const lowerResult = trimmedResult.toLowerCase();
    for (const criterion of criteria) {
      if (criterion === null || criterion === undefined) {
        continue;
      }
      const trimmedCriterion = String(criterion).trim();
      if (trimmedCriterion.length === 0) {
        continue;
      }
      const lowerCriterion = trimmedCriterion.toLowerCase();
      if (lowerResult.includes(lowerCriterion)) {
        continue;
      }

      const words = lowerCriterion.split(/\s+/).filter((w) => w.length > 0);
      if (words.length >= 4) {
        const firstFour = words.slice(0, 4).join(' ');
        if (lowerResult.includes(firstFour)) {
          continue;
        }
      }

      failures.push(`Acceptance criterion not addressed: ${trimmedCriterion}`);
    }
  }

  return { passed: failures.length === 0, failures };
}
