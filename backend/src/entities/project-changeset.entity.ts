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
import { ProjectBranch } from './project-branch.entity';
import { ProjectCommit } from './project-commit.entity';
import { User } from './user.entity';
import { Agent } from './agent.entity';
import { ProjectOrchestration } from './project-orchestration.entity';
import { ProjectOrchestrationTask } from './project-orchestration-task.entity';

export enum ProjectChangesetStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  READY_FOR_REVIEW = 'ready_for_review',
  CHANGES_REQUESTED = 'changes_requested',
  APPROVED = 'approved',
  MERGE_READY = 'merge_ready',
  MERGED = 'merged',
  CONFLICT = 'conflict',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

export type ProjectChangesetFileOp = {
  op: 'upsert' | 'delete' | 'rename';
  path: string;
  to_path?: string;
  content?: string;
  content_type?: string;
  base_revision_id?: string | null;
};

export type ProjectChangesetReviewDecision = 'approved' | 'changes_requested' | 'rejected';

export type ProjectChangesetReviewRecord = {
  reviewer_type: 'user' | 'agent';
  reviewer_id: string;
  decision: ProjectChangesetReviewDecision;
  notes?: string | null;
  reviewed_at: string;
};

export type ProjectChangesetStatusCheckState = 'passed' | 'failed' | 'pending';

export type ProjectChangesetStatusCheckRecord = {
  name: string;
  status: ProjectChangesetStatusCheckState;
  summary?: string | null;
  actor_type: 'user' | 'agent';
  actor_id: string;
  checked_at: string;
};

export type ProjectChangesetRequestedReviewerRecord = {
  reviewer_type: 'user';
  reviewer_id: string;
  requested_by_user_id?: string | null;
  requested_by_agent_id?: string | null;
  requested_at: string;
};

export type ProjectChangesetMergeQueueState = {
  queued: boolean;
  position: number | null;
  queued_at: string | null;
  queued_by_user_id: string | null;
  queued_by_agent_id: string | null;
};

@Entity('project_changesets')
@Index(['projectId', 'status'])
@Index(['projectId', 'branchId', 'status'])
@Index(['projectId', 'taskId'])
export class ProjectChangeset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'base_commit_id', type: 'uuid', nullable: true })
  baseCommitId?: string | null;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({
    type: 'simple-enum',
    enum: ProjectChangesetStatus,
    default: ProjectChangesetStatus.SUBMITTED,
  })
  status!: ProjectChangesetStatus;

  @Column({ name: 'file_ops', type: 'simple-json' })
  fileOps!: ProjectChangesetFileOp[];

  @Column({ type: 'simple-json', nullable: true })
  conflicts?: Array<Record<string, unknown>> | null;

  @Column({ name: 'result_path', type: 'varchar', length: 1024, nullable: true })
  resultPath?: string | null;

  @Column({ name: 'evidence_path', type: 'varchar', length: 1024, nullable: true })
  evidencePath?: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @Column({ name: 'created_by_agent_id', type: 'uuid', nullable: true })
  createdByAgentId?: string | null;

  @Column({ name: 'reviewed_by_user_id', type: 'uuid', nullable: true })
  reviewedByUserId?: string | null;

  @Column({ name: 'reviewed_by_agent_id', type: 'uuid', nullable: true })
  reviewedByAgentId?: string | null;

  @Column({ name: 'review_notes', type: 'text', nullable: true })
  reviewNotes?: string | null;

  @Column({ type: 'simple-json', nullable: true })
  reviews?: ProjectChangesetReviewRecord[] | null;

  @Column({ name: 'status_checks', type: 'simple-json', nullable: true })
  statusChecks?: ProjectChangesetStatusCheckRecord[] | null;

  @Column({ name: 'requested_reviewers', type: 'simple-json', nullable: true })
  requestedReviewers?: ProjectChangesetRequestedReviewerRecord[] | null;

  @Column({ name: 'merge_queue_position', type: 'integer', nullable: true })
  mergeQueuePosition?: number | null;

  @Column({ name: 'queued_at', nullable: true })
  queuedAt?: Date;

  @Column({ name: 'queued_by_user_id', type: 'uuid', nullable: true })
  queuedByUserId?: string | null;

  @Column({ name: 'queued_by_agent_id', type: 'uuid', nullable: true })
  queuedByAgentId?: string | null;

  @Column({ name: 'merged_commit_id', type: 'uuid', nullable: true })
  mergedCommitId?: string | null;

  @Column({ name: 'orchestration_id', type: 'uuid', nullable: true })
  orchestrationId?: string | null;

  @Column({ name: 'task_id', type: 'uuid', nullable: true })
  taskId?: string | null;

  @Column({ name: 'reviewed_at', nullable: true })
  reviewedAt?: Date;

  @Column({ name: 'merged_at', nullable: true })

  @Column({ name: 'merge_status', type: 'varchar', nullable: true })

  @Column({ name: 'post_merge_status', type: 'varchar', nullable: true })
  postMergeStatus?: ProjectChangesetPostMergeStatus | null;
  mergeStatus?: ProjectChangesetMergeStatus | null;
  mergedAt?: Date;

  @Column({ name: 'stale_notified_at', nullable: true })
  staleNotifiedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => ProjectBranch)
  @JoinColumn({ name: 'branch_id' })
  branch!: ProjectBranch;

  @ManyToOne(() => ProjectCommit, { nullable: true })
  @JoinColumn({ name: 'base_commit_id' })
  baseCommit?: ProjectCommit | null;

  @ManyToOne(() => ProjectCommit, { nullable: true })
  @JoinColumn({ name: 'merged_commit_id' })
  mergedCommit?: ProjectCommit | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser?: User | null;

  @ManyToOne(() => Agent, { nullable: true })
  @JoinColumn({ name: 'created_by_agent_id' })
  createdByAgent?: Agent | null;

  @ManyToOne(() => ProjectOrchestration, { nullable: true })
  @JoinColumn({ name: 'orchestration_id' })
  orchestration?: ProjectOrchestration | null;

  @ManyToOne(() => ProjectOrchestrationTask, { nullable: true })
  @JoinColumn({ name: 'task_id' })
  task?: ProjectOrchestrationTask | null;
}

export enum ProjectChangesetMergeStatus {
  CLEAN = 'clean',
  STALE = 'stale',
  CONFLICT = 'conflict',
  NEEDS_REBASE = 'needs_rebase',
}

export enum ProjectChangesetPostMergeStatus {
  PENDING = 'pending',
  PASSED = 'passed',
  FAILED = 'failed',
}
