import type { ProjectOrchestrationTask } from '../entities';

export type TaskCompletionVerificationResult = {
  passed: boolean;
  failures: string[];
};

export async function verifyTaskCompletion(
  task: ProjectOrchestrationTask,
  resultMd: string,
): Promise<TaskCompletionVerificationResult> {
  const failures: string[] = [];
  const trimmedResult = resultMd.trim();

  if (trimmedResult.length < 20) {
    failures.push('Result markdown must be at least 20 characters');
  }

  if (Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0) {
    const normalizedResult = normalizeText(trimmedResult);

    for (const rawCriterion of task.acceptanceCriteria) {
      if (typeof rawCriterion !== 'string') continue;
      const criterion = rawCriterion.trim();
      if (!criterion) continue;

      const normalizedCriterion = normalizeText(criterion);
      const firstFourWords = normalizedCriterion.split(/\s+/).slice(0, 4).join(' ');
      const criterionAddressed =
        normalizedResult.includes(normalizedCriterion) ||
        (!!firstFourWords && normalizedResult.includes(firstFourWords));

      if (!criterionAddressed) {
        failures.push(`Acceptance criterion not addressed: ${criterion}`);
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}
