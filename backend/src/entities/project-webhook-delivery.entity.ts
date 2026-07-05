import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Project } from './project.entity';

export enum WebhookDeliveryStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  RETRYING = 'retrying',
  DEAD_LETTER = 'dead_letter',
}

/**
 * Bounded delivery record for every project webhook delivery attempt.
 *
 * Security notes:
 * - The raw webhook URL is never stored; only a masked form is persisted.
 * - The webhook secret and raw response body are never stored.
 * - The signed request body (the event payload) IS retained on RETRYING
 *   records so the R29a retry sweep can faithfully re-deliver the same
 *   payload after a crash/restart. It is never exposed via the API
 *   (serializeWebhookDelivery omits it) and is not a secret — it is the
 *   same event data already persisted in the events table.
 * - The message field is sanitized before persistence to avoid leaking secrets
 *   that may be echoed by fetch errors.
 */
@Entity('project_webhook_deliveries')
@Index(['projectId', 'createdAt'])
@Index(['projectId', 'eventId', 'createdAt'])
// Sweep lookups: due records are RETRYING with next_retry_at <= now.
@Index(['status', 'nextRetryAt'])
export class ProjectWebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'event_id', type: 'varchar', length: 255 })
  eventId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 255 })
  eventType!: string;

  @Column({ type: 'integer' })
  attempt!: number;

  @Column({
    type: 'simple-enum',
    enum: WebhookDeliveryStatus,
  })
  status!: WebhookDeliveryStatus;

  @Column({ name: 'http_status_code', type: 'integer', nullable: true })
  httpStatusCode?: number | null;

  @Column({ type: 'text', nullable: true })
  message?: string | null;

  @Column({ name: 'masked_url', type: 'varchar', nullable: true })
  maskedUrl?: string | null;

  /**
   * The exact signed request body (JSON event payload) for this attempt. On
   * RETRYING records it is retained so the retry sweep can re-deliver the
   * same payload; success records may also carry it. Never exposed via the API.
   */
  @Column({ name: 'request_body', type: 'text', nullable: true })
  requestBody?: string | null;

  /**
   * Number of retries scheduled so far for this delivery attempt chain.
   * 0 on the initial attempt; increments on each scheduled retry. The
   * sweep uses this against RETRY_DELAYS.length to decide whether to
   * schedule another retry or permanently fail (dead-letter).
   */
  @Column({ name: 'retry_count', type: 'integer', default: 0 })
  retryCount!: number;

  /**
   * When the next retry attempt is due (status=RETRYING). null once the
   * delivery has reached a terminal state (success / dead_letter). The
   * retry sweep selects rows where status=RETRYING AND next_retry_at <= now.
   */
  @Column({ name: 'next_retry_at', nullable: true })
  nextRetryAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
