import { AppDataSource } from '../data-source';
import { ProjectChangeset, ProjectChangesetStatus } from '../entities/project-changeset.entity';
import { Project } from '../entities/project.entity';
import { createInboxItem } from '../routes/agent-inbox.routes';

const CHANGESET_STALE_MINUTES = positiveIntFromEnv('CHANGESET_STALE_MINUTES', 10);
const SWEEP_INTERVAL_MS = positiveIntFromEnv('CHANGESET_STALE_SWEEP_MS', 60_000);

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const staleThresholdMs = CHANGESET_STALE_MINUTES * 60_000;

const STALE_STATUSES = [
  ProjectChangesetStatus.SUBMITTED,
  ProjectChangesetStatus.MERGE_READY,
];

export async function runChangesetStalenessPing(now = new Date()): Promise<{ pinged: number }> {
  const changesetRepo = AppDataSource.getRepository(ProjectChangeset);
  const projectRepo = AppDataSource.getRepository(Project);
  const threshold = now.getTime() - staleThresholdMs;

  const candidates = await changesetRepo
    .createQueryBuilder('cs')
    .where('cs.status IN (:...statuses)', { statuses: STALE_STATUSES })
    .andWhere('cs.stale_notified_at IS NULL')
    .getMany();

  let pinged = 0;
  for (const cs of candidates) {
    const reference = cs.updatedAt ?? cs.createdAt;
    if (!reference || reference.getTime() > threshold) continue;

    const project = await projectRepo.findOne({ where: { id: cs.projectId }, select: ['id', 'mainAgentId'] });
    const mainAgentId = project?.mainAgentId;
    if (!mainAgentId) continue;

    const ts = now.toISOString();
    cs.staleNotifiedAt = now;
    await changesetRepo.save(cs);
    pinged++;

    const deepLink = `changesets/${cs.id}`;
    const body = `Changeset "${cs.title}" has been in ${cs.status} status since ${reference.toISOString()} (${CHANGESET_STALE_MINUTES}+ min) without PM action. Review it: ${deepLink}`;

    await createInboxItem({
      projectId: cs.projectId,
      recipientAgentId: mainAgentId,
      eventType: 'changeset_stale',
      title: `Changeset needs review: ${cs.title}`,
      body,
      orchestrationId: cs.orchestrationId ?? null,
      taskId: cs.taskId ?? null,
      payload: { changeset_id: cs.id, status: cs.status, deep_link: deepLink },
    }).catch((err) => console.error('changeset-staleness notify error:', err));
  }
  return { pinged };
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startChangesetStalenessPing(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runChangesetStalenessPing().catch((err) => console.error('changeset-staleness sweep error:', err));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopChangesetStalenessPing(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
