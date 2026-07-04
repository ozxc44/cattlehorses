import { Router, Request, Response } from 'express';
import { authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { AppDataSource } from '../data-source';
import { AuditLogEntry } from '../entities/audit-log-entry.entity';

const router = Router();
const auditLogRepo = AppDataSource.getRepository(AuditLogEntry);

router.get(
  '/v1/projects/:project_id/audit-log',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const action = typeof req.query.action === 'string' ? req.query.action : undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);

      const qb = auditLogRepo.createQueryBuilder('entry')
        .where('entry.projectId = :projectId', { projectId })
        .orderBy('entry.createdAt', 'DESC')
        .limit(limit);

      if (action) {
        qb.andWhere('entry.action = :action', { action });
      }

      const entries = await qb.getMany();
      res.json(entries.map(serializeAuditLogEntry));
    } catch (err) {
      console.error('List audit log error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

function serializeAuditLogEntry(entry: AuditLogEntry): Record<string, unknown> {
  return {
    id: entry.id,
    project_id: entry.projectId,
    actor_type: entry.actorType,
    actor_id: entry.actorId,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    detail: entry.detail ?? null,
    created_at: entry.createdAt,
  };
}

export default router;
