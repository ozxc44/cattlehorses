import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Project } from './project.entity';

@Entity('scheduled_dispatch')
@Index(['projectId', 'nextRunAt'])
export class ScheduledDispatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text' })
  goal!: string;

  @Column({ name: 'cron_pattern', type: 'varchar', length: 64 })
  cronPattern!: string;

  @Column({ name: 'worker_capability', type: 'varchar', length: 128, nullable: true })
  workerCapability?: string | null;

  @Column({ name: 'max_concurrent', type: 'integer', default: 1 })
  maxConcurrent!: number;

  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ name: 'last_run_at', nullable: true })
  lastRunAt?: Date | null;

  @Column({ name: 'next_run_at', nullable: true })
  nextRunAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
