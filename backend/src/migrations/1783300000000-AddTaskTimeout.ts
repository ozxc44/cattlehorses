import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskTimeout1783300000000 implements MigrationInterface {
  name = 'AddTaskTimeout1783300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN "timeout_seconds" integer NOT NULL DEFAULT 1800`);
      return;
    }

    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "timeout_seconds" integer NOT NULL DEFAULT 1800`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "timeout_seconds"`);
  }
}
