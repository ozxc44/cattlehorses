import { Router, Request, Response } from 'express';
import { authenticate, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { alertService } from '../services/alert.service';

const router = Router();

/**
 * GET /v1/projects/:project_id/alerts
 * List active loop-health alerts for a project.
 */
router.get(
  '/v1/projects/:project_id/alerts',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewHealth),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const alerts = await alertService.listActive(projectId);

      res.json({
        data: alerts.map(formatAlert),
        meta: { total: alerts.length },
      });
    } catch (err) {
      console.error('List alerts error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/alerts/:id/ack
 * Acknowledge an active alert.
 */
router.post(
  '/v1/projects/:project_id/alerts/:id/ack',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewHealth),
  async (req: Request, res: Response) => {
    try {
      const alertId = req.params.id;
      const ackedBy = req.user?.userId || req.agent?.id || 'unknown';

      const alert = await alertService.acknowledge(alertId, ackedBy);
      if (!alert) {
        res.status(404).json({ detail: 'Alert not found' });
        return;
      }

      res.json({ data: formatAlert(alert) });
    } catch (err) {
      console.error('Acknowledge alert error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

function formatAlert(a: any) {
  return {
    id: a.id,
    project_id: a.projectId,
    level: a.level,
    type: a.type,
    status: a.status,
    detail: a.detail,
    meta: a.meta || {},
    acked_at: a.ackedAt || null,
    acked_by: a.ackedBy || null,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

export default router;
