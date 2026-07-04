import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskEvidence1782600000005 implements MigrationInterface {
  name = 'AddTaskEvidence1782600000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN "evidence_json" text`);
      return;
    }

    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "evidence_json" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      return;
    }

    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "evidence_json"`);
  }
}
