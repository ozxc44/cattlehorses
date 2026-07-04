import { AppDataSource } from '../data-source';
import { Project } from '../entities/project.entity';
import { createInboxItem } from '../routes/agent-inbox.routes';
import { recordAuditLog } from './audit-log.service';
import { webhookService } from './webhook.service';
import { v4 as uuidv4 } from 'uuid';

export interface NotifyResult {
  inbox_created: number;
  webhook_triggered: boolean;
  audit_logged: boolean;
}

export async function notify(
  projectId: string,
  eventType: string,
  recipients: string[],
  payload: Record<string, unknown>,
): Promise<NotifyResult> {
  const result: NotifyResult = {
    inbox_created: 0,
    webhook_triggered: false,
    audit_logged: false,
  };

  const project = await AppDataSource.getRepository(Project).findOne({
    where: { id: projectId },
  });

  await Promise.all([
    // 1. Agent inbox fan-out
    ...recipients.map(async (agentId) => {
      await createInboxItem({
        projectId,
        recipientAgentId: agentId,
        eventType,
        title: eventType.replace(/_/g, ' '),
        body: null,
        payload,
      });
      result.inbox_created++;
    }),
    // 2. Webhook delivery (if project has webhooks configured)
    (async () => {
      if (!project?.webhookUrl) return;
      const envelope = {
        id: `evt_${uuidv4().replace(/-/g, '')}`,
        seq: 0,
        projectId,
        sessionId: projectId,
        type: eventType,
        payload,
        createdAt: new Date().toISOString(),
      };
      try {
        await webhookService.sendWebhook(projectId, envelope);
        result.webhook_triggered = true;
      } catch {
        // webhook delivery is best-effort
      }
    })(),
    // 3. Audit log
    (async () => {
      await AppDataSource.transaction(async (manager) => {
        await recordAuditLog(
          manager,
          projectId,
          'agent',
          'notify-service',
          `notify.${eventType}`,
          'notification',
          null,
          { recipients, ...payload },
        );
      });
      result.audit_logged = true;
    })(),
  ]);

  return result;
}
