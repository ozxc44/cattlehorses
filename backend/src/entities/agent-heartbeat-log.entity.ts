import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('agent_heartbeat_log')
@Index('IDX_heartbeat_log_agent_created', ['agentId', 'createdAt'])
export class AgentHeartbeatLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: string;

  @Column({ name: 'health_status', type: 'varchar', length: 32, nullable: true })
  healthStatus?: string | null;

  @Column({ name: 'response_time_ms', type: 'integer', nullable: true })
  responseTimeMs?: number | null;

  @Column({ type: 'boolean', default: true })
  online!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
