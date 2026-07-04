import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChangesetIdempotencyKey1782800000000 implements MigrationInterface {
  name = 'AddChangesetIdempotencyKey1782800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_changesets" ADD "idempotency_key" varchar(255)`);
    await queryRunner.query(`CREATE INDEX "IDX_project_changesets_project_id_idempotency_key" ON "project_changesets" ("project_id", "idempotency_key")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_project_changesets_project_id_idempotency_key"`);
    await queryRunner.query(`ALTER TABLE "project_changesets" DROP COLUMN "idempotency_key"`);
  }
}
