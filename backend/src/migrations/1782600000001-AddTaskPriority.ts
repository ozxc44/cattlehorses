import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskPriority1782600000001 implements MigrationInterface {
  name = 'AddTaskPriority1782600000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN "priority" integer NOT NULL DEFAULT 0`);
    } else {
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "priority" integer NOT NULL DEFAULT 0`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      return;
    }
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "priority"`);
  }
}
