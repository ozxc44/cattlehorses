import { AppDataSource } from '../data-source';
import { LessThan } from 'typeorm';
import { LoopAlert, LoopAlertType, LoopAlertLevel, LoopAlertStatus } from '../entities/loop-alert.entity';
import { Agent, AgentSmokeHealth, AgentStatus } from '../entities/agent.entity';
import { ProjectChangeset, ProjectChangesetStatus } from '../entities/project-changeset.entity';

const alertRepo = AppDataSource.getRepository(LoopAlert);
const agentRepo = AppDataSource.getRepository(Agent);
const changesetRepo = AppDataSource.getRepository(ProjectChangeset);

const WORKER_UNHEALTHY_MINUTES = parseInt(process.env.ALERT_WORKER_UNHEALTHY_MINUTES || '5', 10);
const CHANGESET_STUCK_MINUTES = parseInt(process.env.ALERT_CHANGESET_STUCK_MINUTES || '30', 10);
const CI_FAIL_STATUSES: ProjectChangesetStatus[] = [
  ProjectChangesetStatus.REJECTED,
  ProjectChangesetStatus.CONFLICT,
];

export class AlertService {
  async runSweep(projectId: string, now = new Date()): Promise<LoopAlert[]> {
    const created: LoopAlert[] = [];

    const workerAlert = await this.checkWorkerUnhealthy(projectId, now);
    if (workerAlert) created.push(workerAlert);

    const changesetAlert = await this.checkChangesetStuck(projectId, now);
    if (changesetAlert) created.push(changesetAlert);

    const ciAlert = await this.checkCiFailed(projectId, now);
    if (ciAlert) created.push(ciAlert);

    return created;
  }

  async checkWorkerUnhealthy(projectId: string, now: Date): Promise<LoopAlert | null> {
    const threshold = new Date(now.getTime() - WORKER_UNHEALTHY_MINUTES * 60_000);

    const unhealthyAgents = await agentRepo
      .createQueryBuilder('a')
      .where('a.project_id = :projectId', { projectId })
      .andWhere('a.status = :status', { status: AgentStatus.ACTIVE })
      .andWhere('a.health_status = :hs', { hs: AgentSmokeHealth.UNHEALTHY })
      .andWhere('a.health_checked_at < :threshold', { threshold })
      .getMany();

    if (unhealthyAgents.length === 0) return null;

    const existing = await alertRepo.findOne({
      where: { projectId, type: 'worker_unhealthy', status: 'active' },
    });
    if (existing) return null;

    const names = unhealthyAgents.map((a) => a.name).join(', ');
    const detail =
      `Worker(s) unhealthy for >${WORKER_UNHEALTHY_MINUTES}min: ${names}. ` +
      `Check worker health and reassign tasks if needed.`;

    return this.createAlert(projectId, 'warning', 'worker_unhealthy', detail, {
      agent_ids: unhealthyAgents.map((a) => a.id),
      agent_names: unhealthyAgents.map((a) => a.name),
      threshold_minutes: WORKER_UNHEALTHY_MINUTES,
    });
  }

  async checkChangesetStuck(projectId: string, now: Date): Promise<LoopAlert | null> {
    const threshold = new Date(now.getTime() - CHANGESET_STUCK_MINUTES * 60_000);

    const stuckStatuses = [
      ProjectChangesetStatus.SUBMITTED,
      ProjectChangesetStatus.READY_FOR_REVIEW,
      ProjectChangesetStatus.MERGE_READY,
    ];

    const stuck = await changesetRepo
      .createQueryBuilder('cs')
      .where('cs.project_id = :projectId', { projectId })
      .andWhere('cs.status IN (:...statuses)', { statuses: stuckStatuses })
      .andWhere('cs.updated_at < :threshold', { threshold })
      .getMany();

    if (stuck.length === 0) return null;

    const existing = await alertRepo.findOne({
      where: { projectId, type: 'changeset_stuck', status: 'active' },
    });
    if (existing) return null;

    const titles = stuck.map((c) => c.title).join(', ');
    const detail =
      `${stuck.length} changeset(s) stuck for >${CHANGESET_STUCK_MINUTES}min: ${titles}. ` +
      `Review and merge or reject.`;

    return this.createAlert(projectId, 'warning', 'changeset_stuck', detail, {
      changeset_ids: stuck.map((c) => c.id),
      changeset_titles: stuck.map((c) => c.title),
      threshold_minutes: CHANGESET_STUCK_MINUTES,
    });
  }

  async checkCiFailed(projectId: string, now: Date): Promise<LoopAlert | null> {
    const oneHourAgo = new Date(now.getTime() - 60 * 60_000);

    const failed = await changesetRepo
      .createQueryBuilder('cs')
      .where('cs.project_id = :projectId', { projectId })
      .andWhere('cs.status IN (:...statuses)', { statuses: CI_FAIL_STATUSES })
      .andWhere('cs.updated_at > :since', { since: oneHourAgo })
      .getMany();

    if (failed.length === 0) return null;

    const existing = await alertRepo.findOne({
      where: { projectId, type: 'ci_failed', status: 'active' },
    });
    if (existing) return null;

    const titles = failed.map((c) => c.title).join(', ');
    const detail = `CI failed on recent changesets: ${titles}. Fix and re-push.`;

    return this.createAlert(projectId, 'critical', 'ci_failed', detail, {
      changeset_ids: failed.map((c) => c.id),
      changeset_titles: failed.map((c) => c.title),
      statuses: failed.map((c) => c.status),
    });
  }

  async listActive(projectId: string): Promise<LoopAlert[]> {
    return alertRepo.find({
      where: { projectId, status: 'active' },
      order: { createdAt: 'DESC' },
    });
  }

  async acknowledge(alertId: string, ackedBy: string): Promise<LoopAlert | null> {
    const alert = await alertRepo.findOne({ where: { id: alertId } });
    if (!alert) return null;
    if (alert.status !== 'active') return alert;

    alert.status = 'acknowledged' as LoopAlertStatus;
    alert.ackedAt = new Date();
    alert.ackedBy = ackedBy;
    return alertRepo.save(alert);
  }

  private async createAlert(
    projectId: string,
    level: LoopAlertLevel,
    type: LoopAlertType,
    detail: string,
    meta: Record<string, unknown>,
  ): Promise<LoopAlert> {
    const alert = alertRepo.create({ projectId, level, type, detail, meta });
    return alertRepo.save(alert);
  }
}

export const alertService = new AlertService();

let sweepTimer: ReturnType<typeof setInterval> | null = null;
const SWEEP_INTERVAL_MS = parseInt(process.env.ALERT_SWEEP_INTERVAL_MS || '60000', 10);

export function startAlertSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(async () => {
    try {
      const { Project } = await import('../entities/project.entity');
      const projectRepo = AppDataSource.getRepository(Project);
      const projects = await projectRepo.find({ select: ['id'] });
      for (const p of projects) {
        await alertService.runSweep(p.id);
      }
    } catch (err) {
      console.error('Alert sweep error:', err);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopAlertSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
