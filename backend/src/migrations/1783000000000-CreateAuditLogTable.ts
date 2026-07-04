import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuditLogTable1783000000000 implements MigrationInterface {
  name = 'CreateAuditLogTable1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audit_log_entries" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "project_id" uuid NOT NULL,
        "actor_type" varchar(16) NOT NULL,
        "actor_id" varchar(255) NOT NULL,
        "action" varchar(128) NOT NULL,
        "target_type" varchar(64),
        "target_id" varchar(255),
        "detail" jsonb,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_audit_log_entries_project_id" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      'CREATE INDEX "IDX_audit_log_entries_project_id_created_at" ON "audit_log_entries" ("project_id", "created_at")',
    );

    await queryRunner.query(
      'CREATE INDEX "IDX_audit_log_entries_project_id_action_created_at" ON "audit_log_entries" ("project_id", "action", "created_at")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "audit_log_entries"');
  }
}
