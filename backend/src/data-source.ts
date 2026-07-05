import { DataSource, DataSourceOptions, getMetadataArgsStorage } from 'typeorm';
import {
  User,
  Project,
  ProjectMember,
  ProjectAuditEvent,
  Agent,
  Session,
  SessionParticipant,
  Message,
  Event,
  EventIdempotencyKey,
  AgentRun,
  HealthMetric,
  Incident,
  ProjectIncident,
  McpCapability,
  ProjectFile,
  ProjectFileRevision,
  ProjectMemory,
  ProjectJoinRequest,
  ProjectFileProposal,
  ProjectOrchestration,
  ProjectOrchestrationTask,
  ProjectBranch,
  ProjectCommit,
  ProjectChangeset,
  ProjectChangesetComment,
  ProjectGateTemplate,
  ProjectGate,
  ProjectGateAttempt,
  AgentInboxItem,
  AgentWorkUnit,
  CollaborationRequest,
  WikiPage,
  ProjectRelease,
  ProjectPackage,
  ProjectSecurityAdvisory,
  ProjectWorkSavedQuery,
  ProjectWebhookDelivery,
  AuditLogEntry,
  LoopAlert,
} from './entities';

const isTestEnv = process.env.NODE_ENV === 'test';

const entities = [
  User,
  Project,
  ProjectMember,
  ProjectAuditEvent,
  Agent,
  Session,
  SessionParticipant,
  Message,
  Event,
  EventIdempotencyKey,
  AgentRun,
  HealthMetric,
  Incident,
  ProjectIncident,
  McpCapability,
  ProjectFile,
  ProjectFileRevision,
  ProjectMemory,
  ProjectJoinRequest,
  ProjectFileProposal,
  ProjectOrchestration,
  ProjectOrchestrationTask,
  ProjectBranch,
  ProjectCommit,
  ProjectChangeset,
  ProjectChangesetComment,
  ProjectGateTemplate,
  ProjectGate,
  ProjectGateAttempt,
  AgentInboxItem,
  AgentWorkUnit,
  CollaborationRequest,
  WikiPage,
  ProjectRelease,
  ProjectPackage,
  ProjectSecurityAdvisory,
  ProjectWorkSavedQuery,
  ProjectWebhookDelivery,
  AuditLogEntry,
  LoopAlert,
];

const migrations = [`${__dirname}/migrations/*{.ts,.js}`];

function normalizeReflectedColumnTypes(): void {
  // Date | null reflects as Object, so pin the production column type here.
  const datePatchTargets: { target: Function; propertyName: string }[] = [
    ...[ProjectJoinRequest, ProjectFileProposal, ProjectChangeset, ProjectGateAttempt].map((t) => ({ target: t, propertyName: 'reviewedAt' })),
    { target: Agent, propertyName: 'retiredAt' },
    { target: Agent, propertyName: 'healthCheckedAt' },
    ...[AgentInboxItem].flatMap((t) => [
      { target: t, propertyName: 'readAt' },
      { target: t, propertyName: 'ackedAt' },
      { target: t, propertyName: 'leaseExpiresAt' },
      { target: t, propertyName: 'lastDeliveredAt' },
    ]),
    ...[AgentWorkUnit].flatMap((t) => [
      { target: t, propertyName: 'startedAt' },
      { target: t, propertyName: 'completedAt' },
      { target: t, propertyName: 'reviewedAt' },
      { target: t, propertyName: 'lockedAt' },
    ]),
    { target: ProjectOrchestrationTask, propertyName: 'dispatchedAt' },
    { target: ProjectOrchestrationTask, propertyName: 'claimedAt' },
    { target: ProjectOrchestrationTask, propertyName: 'progressAt' },
    { target: ProjectFile, propertyName: 'deletedAt' },
    ...[ProjectChangesetComment].flatMap((t) => [
      { target: t, propertyName: 'resolvedAt' },
      { target: t, propertyName: 'deletedAt' },
    ]),
    { target: ProjectRelease, propertyName: 'publishedAt' },
    { target: ProjectSecurityAdvisory, propertyName: 'publishedAt' },
    { target: ProjectWebhookDelivery, propertyName: 'nextRetryAt' },
  ];

  for (const { target, propertyName } of datePatchTargets) {
    const column = getMetadataArgsStorage().columns.find(
      (c) => c.target === target && c.propertyName === propertyName,
    );
    if (column && ((column.options.type as unknown) === Object || column.options.type === 'datetime')) {
      column.options.type = isTestEnv ? 'datetime' : 'timestamp';
    }
  }
}

normalizeReflectedColumnTypes();

const options: DataSourceOptions = isTestEnv
  ? {
      type: 'better-sqlite3',
      database: ':memory:',
      entities,
      synchronize: true,
      dropSchema: true,
    }
  : {
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_DATABASE || 'zz_agent',
      entities,
      synchronize: process.env.DB_SYNCHRONIZE === 'true',
      logging: process.env.DB_LOGGING === 'true',
      migrations,
    };

export const AppDataSource = new DataSource(options);

export async function initializeDatabase(): Promise<DataSource> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
  return AppDataSource;
}
