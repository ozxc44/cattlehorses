import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Project } from './project.entity';
import { User } from './user.entity';

export enum AgentRuntime {
  PYTHON = 'python',
  NODEJS = 'nodejs',
  DOCKER = 'docker',
}

export enum AgentStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  IDLE = 'idle',
  ERROR = 'error',
}

export enum AgentLifecycleStatus {
  ACTIVE = 'active',
  RECOVERY_PENDING = 'recovery_pending',
  RETIRED = 'retired',
  SUPERSEDED = 'superseded',
}

/**
 * Last self-reported worker smoke-test health, stored from the heartbeat.
 * `null` means the worker is legacy / has never reported a smoke test —
 * dispatch is allowed in that case. `unhealthy` blocks dispatch (HTTP 409).
 */
export enum AgentSmokeHealth {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
}

@Entity('agents')
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'simple-enum',
    enum: AgentRuntime,
    default: AgentRuntime.PYTHON,
  })
  runtime!: AgentRuntime;

  @Column({ name: 'config_json', type: 'simple-json', nullable: true })
  configJson?: Record<string, unknown>;

  @Column({ type: 'simple-array', nullable: true, default: '' })
  capabilities?: string[];

  @Column({ name: 'api_key_prefix', type: 'varchar', length: 8, nullable: true })
  apiKeyPrefix?: string | null;

  @Column({ name: 'api_key_hash', type: 'varchar', length: 255, nullable: true })
  apiKeyHash?: string | null;

  @Column({
    type: 'simple-enum',
    enum: AgentStatus,
    default: AgentStatus.ACTIVE,
  })
  status!: AgentStatus;

  @Column({ name: 'last_heartbeat_at', nullable: true })
  lastHeartbeatAt?: Date;

  // Last worker self-reported smoke-test health (from heartbeat).
  // null = legacy worker that never reported a smoke test → dispatch allowed.
  @Column({ name: 'health_status', type: 'varchar', length: 32, nullable: true })
  healthStatus?: string | null;

  @Column({ name: 'health_last_error', type: 'text', nullable: true })
  healthLastError?: string | null;

  @Column({ name: 'health_checked_at', nullable: true })
  healthCheckedAt?: Date | null;

  @Column({ name: 'metrics_json', type: 'simple-json', nullable: true, default: '{}' })
  metricsJson?: Record<string, unknown>;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null;

  @Column({ name: 'identity_code', type: 'varchar', length: 32, nullable: true, unique: true })
  identityCode?: string | null;

  @Column({
    name: 'lifecycle_status',
    type: 'simple-enum',
    enum: AgentLifecycleStatus,
    default: AgentLifecycleStatus.ACTIVE,
  })
  lifecycleStatus!: AgentLifecycleStatus;

  @Column({ name: 'superseded_by_agent_id', type: 'uuid', nullable: true })
  supersededByAgentId?: string | null;

  @Column({ name: 'retired_at', nullable: true })
  retiredAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  // Relations
  @ManyToOne(() => Project, (project) => project.agents)
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
