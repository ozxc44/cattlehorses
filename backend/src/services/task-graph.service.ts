import { AppDataSource } from '../data-source';
import {
  ProjectOrchestrationTask,
  ProjectOrchestrationTaskStatus,
} from '../entities/project-orchestration-task.entity';

export type UnmetTaskDependency = {
  id: string;
  status: ProjectOrchestrationTaskStatus | 'missing';
  title: string | null;
};

export type TaskDependencyCheck = {
  met: boolean;
  unmet: UnmetTaskDependency[];
};

export async function checkDependenciesMet(
  task: Pick<ProjectOrchestrationTask, 'dependsOn'>,
): Promise<TaskDependencyCheck> {
  const dependencyIds = task.dependsOn ?? [];
  if (dependencyIds.length === 0) {
    return { met: true, unmet: [] };
  }

  const repo = AppDataSource.getRepository(ProjectOrchestrationTask);
  const dependencies = await repo
    .createQueryBuilder('task')
    .where('task.id IN (:...ids)', { ids: dependencyIds })
    .getMany();
  const byId = new Map(dependencies.map((dependency) => [dependency.id, dependency]));
  const unmet = dependencyIds.flatMap((id): UnmetTaskDependency[] => {
    const dependency = byId.get(id);
    if (!dependency) {
      return [{ id, status: 'missing', title: null }];
    }
    if (dependency.status !== ProjectOrchestrationTaskStatus.APPROVED) {
      return [{ id, status: dependency.status, title: dependency.title }];
    }
    return [];
  });

  return { met: unmet.length === 0, unmet };
}
