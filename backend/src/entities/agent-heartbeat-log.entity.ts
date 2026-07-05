import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Append-only heartbeat log row written on each agent heartbeat / health check.
 *
 * Captures a point-in-time snapshot of the worker's self-reported status and
 * smoke-test health alongside the measured response time, so the platform has a
 * durable history (the `agents` row only keeps the *latest* values). Mirrored by
 * migration `1783400000000-CreateAgentHeartbeatLog`.
 */
@Entity('agent_heartbeat_log')
@Index(['agentId', 'createdAt'])
export class AgentHeartbeatLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId!: string;

  /** Agent registry/health status as reported in the heartbeat payload. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  status?: string | null;

  /** Last worker self-reported smoke-test health (e.g. healthy / unhealthy). */
  @Column({ name: 'health_status', type: 'varchar', length: 32, nullable: true })
  healthStatus?: string | null;

  /** Round-trip time of the heartbeat request in milliseconds, if measured. */
  @Column({ name: 'response_time_ms', type: 'integer', nullable: true })
  responseTimeMs?: number | null;

  @Column({ type: "boolean", nullable: true })
  online?: boolean | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
