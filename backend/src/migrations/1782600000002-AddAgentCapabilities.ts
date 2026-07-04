import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentCapabilities1782600000002 implements MigrationInterface {
  name = 'AddAgentCapabilities1782600000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      await queryRunner.query(`ALTER TABLE "agents" ADD COLUMN "capabilities" text DEFAULT ''`);
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN "required_capability" varchar(128)`);
    } else {
      await queryRunner.query(`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "capabilities" text DEFAULT ''`);
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "required_capability" character varying(128)`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      return;
    }
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "required_capability"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "capabilities"`);
  }
}
