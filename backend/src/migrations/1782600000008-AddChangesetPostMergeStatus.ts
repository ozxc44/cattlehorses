import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddChangesetPostMergeStatus1782600000008 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_changesets" ADD COLUMN IF NOT EXISTS "post_merge_status" varchar`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_changesets" DROP COLUMN IF EXISTS "post_merge_status"`);
  }
}
