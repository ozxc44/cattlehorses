import { Router, Request, Response } from 'express';
import { authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { notify } from '../services/notify.service';

const router = Router();

router.post(
  '/v1/projects/:pid/notify',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.pid;
      const { event_type, recipients, payload } = req.body;

      if (!event_type || typeof event_type !== 'string') {
        res.status(400).json({ detail: 'event_type is required' });
        return;
      }
      if (!Array.isArray(recipients) || recipients.length === 0) {
        res.status(400).json({ detail: 'recipients[] is required and must not be empty' });
        return;
      }

      const result = await notify(
        projectId,
        event_type,
        recipients,
        payload && typeof payload === 'object' ? payload : {},
      );

      res.status(200).json(result);
    } catch (err) {
      console.error('Notify endpoint error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
