import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskRetry1782600000004 implements MigrationInterface {
  name = 'AddTaskRetry1782600000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN "retry_count" integer NOT NULL DEFAULT 0`);
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN "max_retries" integer NOT NULL DEFAULT 2`);
      return;
    }

    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "max_retries" integer NOT NULL DEFAULT 2`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "max_retries"`);
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "retry_count"`);
  }
}
