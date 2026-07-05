import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Check,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Project } from './project.entity';
import { Agent } from './agent.entity';
import { ProjectOrchestration } from './project-orchestration.entity';

export enum ProjectOrchestrationTaskStatus {
  PENDING = 'pending',
  DISPATCHED = 'dispatched',
  RUNNING = 'running',
  READY_FOR_REVIEW = 'ready_for_review',
  APPROVED = 'approved',
  CHANGES_REQUESTED = 'changes_requested',
  BLOCKED = 'blocked',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export type ProjectOrchestrationTaskEvidence = {
  files_changed: string[];
  test_passed: boolean | null;
  diff_summary: string | null;
  risk_notes: string | null;
};

@Entity('project_orchestration_tasks')
@Index(['projectId', 'status'])
@Index(['orchestrationId', 'status'])
@Index(['assignedAgentId', 'status'])
@Check(
  'CHK_project_orchestration_tasks_progress_percent',
  '"progress_percent" IS NULL OR ("progress_percent" >= 0 AND "progress_percent" <= 100)',
)
export class ProjectOrchestrationTask {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'orchestration_id', type: 'uuid' })
  orchestrationId!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text' })
  goal!: string;

  @Column({
    type: 'simple-enum',
    enum: ProjectOrchestrationTaskStatus,
    default: ProjectOrchestrationTaskStatus.PENDING,
  })
  status!: ProjectOrchestrationTaskStatus;

  @Column({ name: 'assigned_agent_id', type: 'uuid', nullable: true })
  assignedAgentId?: string | null;

  @Column({ name: 'worker_task_path', type: 'varchar', length: 1024 })
  workerTaskPath!: string;

  @Column({ name: 'worker_context_path', type: 'varchar', length: 1024 })
  workerContextPath!: string;

  @Column({ name: 'result_path', type: 'varchar', length: 1024, nullable: true })
  resultPath?: string | null;

  @Column({ name: 'evidence_path', type: 'varchar', length: 1024, nullable: true })
  evidencePath?: string | null;

  @Column({ name: 'evidence_json', type: 'simple-json', nullable: true })
  evidenceJson?: ProjectOrchestrationTaskEvidence | null;

  @Column({ name: 'metadata', type: 'simple-json', nullable: true })
  metadata?: Record<string, unknown> | null;

  @Column({ name: 'acceptance_criteria', type: 'simple-json', nullable: true })
  acceptanceCriteria?: string[] | null;

  @Column({ name: 'depends_on', type: 'simple-json', nullable: true })
  dependsOn?: string[] | null;

  @Column({ name: 'required_capability', type: 'varchar', length: 128, nullable: true })
  requiredCapability?: string | null;

  @Column({ type: 'integer', default: 0 })
  priority!: number;

  @Column({ name: 'retry_count', type: 'integer', default: 0 })
  retryCount!: number;

  @Column({ name: 'max_retries', type: 'integer', default: 2 })
  maxRetries!: number;

  @Column({ name: 'timeout_seconds', type: 'integer', default: 1800 })
  timeoutSeconds!: number;

  @Column({ name: 'progress_note', type: 'text', nullable: true })
  progressNote?: string | null;

  @Column({ name: 'progress_percent', type: 'integer', nullable: true })
  progressPercent?: number | null;

  @Column({ name: 'progress_at', nullable: true })
  progressAt?: Date | null;

  @Column({ name: 'review_notes', type: 'text', nullable: true })
  reviewNotes?: string | null;

  @Column({ name: 'requested_changes', type: 'text', nullable: true })
  requestedChanges?: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @Column({ name: 'created_by_agent_id', type: 'uuid', nullable: true })
  createdByAgentId?: string | null;

  @Column({ name: 'dispatched_at', nullable: true })
  dispatchedAt?: Date;

  @Column({ name: 'claimed_at', nullable: true })
  claimedAt?: Date;

  @Column({ name: 'completed_at', nullable: true })
  completedAt?: Date;

  @Column({ name: 'reviewed_at', nullable: true })
  reviewedAt?: Date;

  @Column({ name: 'cancelled_at', nullable: true })
  cancelledAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => ProjectOrchestration, (orchestration) => orchestration.tasks)
  @JoinColumn({ name: 'orchestration_id' })
  orchestration!: ProjectOrchestration;

  @ManyToOne(() => Agent, { nullable: true })
  @JoinColumn({ name: 'assigned_agent_id' })
  assignedAgent?: Agent | null;
}
