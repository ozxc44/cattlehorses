import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type LoopAlertLevel = 'warning' | 'critical';
export type LoopAlertType = 'worker_unhealthy' | 'changeset_stuck' | 'ci_failed';
export type LoopAlertStatus = 'active' | 'acknowledged';

@Entity('loop_alerts')
@Index(['projectId', 'status'])
@Index(['projectId', 'type', 'status'])
export class LoopAlert {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 16 })
  level!: LoopAlertLevel;

  @Column({ type: 'varchar', length: 32 })
  type!: LoopAlertType;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: LoopAlertStatus;

  @Column({ type: 'text' })
  detail!: string;

  @Column({ type: 'simple-json', default: '{}' })
  meta!: Record<string, unknown>;

  @Column({ name: 'acked_at', nullable: true })
  ackedAt?: Date;

  @Column({ name: 'acked_by', type: 'varchar', length: 64, nullable: true })
  ackedBy?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
