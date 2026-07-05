import { LessThanOrEqual, In } from 'typeorm';
import { AppDataSource } from '../data-source';
import { ScheduledDispatch } from '../entities/scheduled-dispatch.entity';
import {
  ProjectOrchestration,
  ProjectOrchestrationStatus,
} from '../entities/project-orchestration.entity';
import {
  ProjectOrchestrationTask,
  ProjectOrchestrationTaskStatus,
} from '../entities/project-orchestration-task.entity';
import { randomUUID } from 'crypto';

const SCHEDULER_INTERVAL_MS = 60_000;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    tick().catch((err) => {
      console.error('[scheduler] tick error:', err);
    });
  }, SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref();
  console.log('[scheduler] started, interval=' + SCHEDULER_INTERVAL_MS + 'ms');
}

export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

export async function tick(): Promise<void> {
  const now = new Date();
  const repo = AppDataSource.getRepository(ScheduledDispatch);
  const due = await repo.find({
    where: {
      enabled: true,
      nextRunAt: LessThanOrEqual(now),
    },
    order: { nextRunAt: 'ASC' },
  });

  for (const schedule of due) {
    try {
      await executeSchedule(schedule, now);
    } catch (err) {
      console.error(`[scheduler] failed to execute schedule ${schedule.id}:`, err);
    }
  }
}

async function executeSchedule(schedule: ScheduledDispatch, now: Date): Promise<void> {
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);

  const activeStatuses = [
    ProjectOrchestrationTaskStatus.DISPATCHED,
    ProjectOrchestrationTaskStatus.RUNNING,
  ];

  const allActiveTasks = await taskRepo.find({
    where: {
      projectId: schedule.projectId,
      status: In(activeStatuses),
    },
  });

  const activeCount = allActiveTasks.filter((t) => {
    const meta = t.metadata as Record<string, unknown> | null | undefined;
    return meta?.scheduled_dispatch_id === schedule.id;
  }).length;

  if (activeCount >= schedule.maxConcurrent) {
    advanceSchedule(schedule, now);
    await AppDataSource.getRepository(ScheduledDispatch).save(schedule);
    return;
  }

  const toDispatch = schedule.maxConcurrent - activeCount;
  const orchestration = await getOrCreateOrchestration(schedule);
  if (!orchestration) return;

  const { selectBestWorker } = await import('../routes/orchestrations.routes');

  for (let i = 0; i < toDispatch; i++) {
    const selection = await selectBestWorker(schedule.projectId, schedule.workerCapability ?? null);
    if (!selection) {
      console.log(`[scheduler] no eligible worker for schedule ${schedule.id}, skipping remaining dispatches`);
      break;
    }

    const taskId = randomUUID();
    const basePath = orchestration.basePath || `.agent/orchestrations/${orchestration.id}`;
    const task = taskRepo.create({
      id: taskId,
      projectId: schedule.projectId,
      orchestrationId: orchestration.id,
      title: `${schedule.title} [${now.toISOString().slice(0, 16)}]`,
      goal: schedule.goal,
      status: ProjectOrchestrationTaskStatus.DISPATCHED,
      assignedAgentId: selection.agentId,
      workerTaskPath: `${basePath}/workers/${taskId}.worker_task.md`,
      workerContextPath: `${basePath}/workers/${taskId}.worker_context.md`,
      requiredCapability: schedule.workerCapability ?? null,
      dispatchedAt: now,
      metadata: { scheduled_dispatch_id: schedule.id },
    });
    await taskRepo.save(task);
  }

  schedule.lastRunAt = now;
  advanceSchedule(schedule, now);
  await AppDataSource.getRepository(ScheduledDispatch).save(schedule);
}

function advanceSchedule(schedule: ScheduledDispatch, from: Date): void {
  const next = nextCronDate(schedule.cronPattern, from);
  if (next) {
    schedule.nextRunAt = next;
  } else {
    schedule.enabled = false;
    console.warn(`[scheduler] invalid cron_pattern for schedule ${schedule.id}, disabling`);
  }
}

async function getOrCreateOrchestration(schedule: ScheduledDispatch): Promise<ProjectOrchestration | null> {
  const orchRepo = AppDataSource.getRepository(ProjectOrchestration);
  let orch = await orchRepo.findOne({
    where: {
      projectId: schedule.projectId,
      title: `Scheduled: ${schedule.title}`,
      status: ProjectOrchestrationStatus.RUNNING,
    },
  });

  if (!orch) {
    orch = orchRepo.create({
      id: randomUUID(),
      projectId: schedule.projectId,
      title: `Scheduled: ${schedule.title}`,
      objective: `Auto-created orchestration for scheduled dispatch: ${schedule.title}`,
      status: ProjectOrchestrationStatus.RUNNING,
      basePath: `.agent/scheduled/${schedule.id}`,
    });
    await orchRepo.save(orch);
  }

  return orch;
}

export function nextCronDate(pattern: string, from: Date): Date | null {
  const parsed = parseCronPattern(pattern);
  if (!parsed) return null;

  const next = new Date(from.getTime() + 60_000);
  next.setSeconds(0, 0);

  for (let i = 0; i < 525_600; i++) {
    if (matchesCron(parsed, next)) {
      return next;
    }
    next.setTime(next.getTime() + 60_000);
  }
  return null;
}

interface CronParts {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseCronPattern(pattern: string): CronParts | null {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const daysOfMonth = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const daysOfWeek = parseCronField(parts[4], 0, 6);

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  return { minutes, hours, daysOfMonth, months, daysOfWeek } as CronParts;
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      if (step <= 0) return null;
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      if (lo < min || hi > max || lo > hi) return null;
      for (let i = lo; i <= hi; i++) values.add(i);
      continue;
    }

    const num = parseInt(part, 10);
    if (isNaN(num) || num < min || num > max) return null;
    values.add(num);
  }

  return values;
}

function matchesCron(cron: CronParts, date: Date): boolean {
  return (
    cron.minutes.has(date.getMinutes()) &&
    cron.hours.has(date.getHours()) &&
    cron.daysOfMonth.has(date.getDate()) &&
    cron.months.has(date.getMonth() + 1) &&
    cron.daysOfWeek.has(date.getDay())
  );
}
