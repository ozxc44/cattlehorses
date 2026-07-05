import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskCancelledAt1783100000000 implements MigrationInterface {
  name = 'AddTaskCancelledAt1783100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const driver = queryRunner.connection.driver.options.type;
    if (driver === 'postgres') {
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD "cancelled_at" TIMESTAMP`);
    } else {
      // SQLite
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD "cancelled_at" datetime`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN "cancelled_at"`);
  }
}
