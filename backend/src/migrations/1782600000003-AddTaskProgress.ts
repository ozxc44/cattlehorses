import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskProgress1782600000003 implements MigrationInterface {
  name = 'AddTaskProgress1782600000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN "progress_note" text`);
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN "progress_percent" integer CHECK ("progress_percent" IS NULL OR ("progress_percent" >= 0 AND "progress_percent" <= 100))`);
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN "progress_at" datetime`);
      return;
    }

    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "progress_note" text`);
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "progress_percent" integer`);
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "progress_at" TIMESTAMP`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_project_orchestration_tasks_progress_percent'
        ) THEN
          ALTER TABLE "project_orchestration_tasks"
            ADD CONSTRAINT "CHK_project_orchestration_tasks_progress_percent"
            CHECK ("progress_percent" IS NULL OR ("progress_percent" >= 0 AND "progress_percent" <= 100));
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP CONSTRAINT IF EXISTS "CHK_project_orchestration_tasks_progress_percent"`);
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "progress_at"`);
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "progress_percent"`);
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "progress_note"`);
  }
}
