import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPerformanceIndexes1782900000000 implements MigrationInterface {
  name = 'AddPerformanceIndexes1782900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PM changeset list filtering by project + status
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_project_changesets_project_id_status" ON "project_changesets" ("project_id", "status")',
    );

    // Orchestration task list filtering by orchestration + status
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_project_orchestration_tasks_orchestration_id_status" ON "project_orchestration_tasks" ("orchestration_id", "status")',
    );

    // Worker assigned-task lookup
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_project_orchestration_tasks_assigned_agent_id_status" ON "project_orchestration_tasks" ("assigned_agent_id", "status")',
    );

    // Agent inbox poll for unacked items
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_agent_inbox_items_recipient_agent_id_acked_at" ON "agent_inbox_items" ("recipient_agent_id", "acked_at")',
    );

    // Presence sweep for stale/offline agents within a project
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_agents_project_id_last_heartbeat_at" ON "agents" ("project_id", "last_heartbeat_at")',
    );

    // Project file lookup by project + path
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_project_files_project_id_path" ON "project_files" ("project_id", "path")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_project_files_project_id_path"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_agents_project_id_last_heartbeat_at"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_agent_inbox_items_recipient_agent_id_acked_at"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_project_orchestration_tasks_assigned_agent_id_status"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_project_orchestration_tasks_orchestration_id_status"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_project_changesets_project_id_status"');
  }
}
