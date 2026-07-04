import { EntityManager } from 'typeorm';
import { AuditLogEntry, AuditActorType } from '../entities/audit-log-entry.entity';

export async function recordAuditLog(
  manager: EntityManager,
  projectId: string,
  actorType: AuditActorType,
  actorId: string,
  action: string,
  targetType?: string | null,
  targetId?: string | null,
  detail?: Record<string, unknown> | null,
): Promise<AuditLogEntry> {
  const entry = manager.create(AuditLogEntry, {
    projectId,
    actorType,
    actorId,
    action,
    targetType: targetType ?? null,
    targetId: targetId ?? null,
    detail: detail ?? null,
  });
  return manager.save(AuditLogEntry, entry);
}
