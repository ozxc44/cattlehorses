import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChangesetStaleNotifiedAt1782700000000 implements MigrationInterface {
  name = 'AddChangesetStaleNotifiedAt1782700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_changesets" ADD "stale_notified_at" TIMESTAMP`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_changesets" DROP COLUMN "stale_notified_at"`);
  }
}
