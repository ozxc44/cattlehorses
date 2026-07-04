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

export type AuditActorType = 'user' | 'agent';

@Entity('audit_log_entries')
@Index(['projectId', 'createdAt'])
@Index(['projectId', 'action', 'createdAt'])
export class AuditLogEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'actor_type', type: 'varchar', length: 16 })
  actorType!: AuditActorType;

  @Column({ name: 'actor_id', type: 'varchar', length: 255 })
  actorId!: string;

  @Column({ type: 'varchar', length: 128 })
  action!: string;

  @Column({ name: 'target_type', type: 'varchar', length: 64, nullable: true })
  targetType?: string | null;

  @Column({ name: 'target_id', type: 'varchar', length: 255, nullable: true })
  targetId?: string | null;

  @Column({ type: 'simple-json', nullable: true })
  detail?: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
