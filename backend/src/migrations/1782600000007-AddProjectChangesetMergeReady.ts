import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectChangesetMergeReady1782600000007 implements MigrationInterface {
  name = 'AddProjectChangesetMergeReady1782600000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "project_changesets_status_enum" ADD VALUE IF NOT EXISTS 'merge_ready'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing values from an ENUM type directly.
    // Reversing this change would require rebuilding the enum column, which is
    // out of scope for a simple rollback. Leave the value in place.
    await queryRunner.query(`SELECT 1`);
  }
}
