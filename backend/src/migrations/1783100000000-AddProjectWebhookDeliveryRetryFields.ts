import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * R29a: persistent webhook delivery retry.
 *
 * Adds retry_count (how many retries have been scheduled for this delivery
 * attempt chain) and next_retry_at (when the next retry is due; null once
 * the delivery reaches a terminal state) to project_webhook_deliveries, plus
 * a partial-style index the retry sweep uses to find due rows cheaply:
 *   status = 'retrying' AND next_retry_at <= now().
 *
 * Existing rows are backfilled to retry_count = 0 / next_retry_at = NULL so
 * they are treated as terminal (no spontaneous retries for old history).
 */
export class AddProjectWebhookDeliveryRetryFields1783100000000 implements MigrationInterface {
  name = 'AddProjectWebhookDeliveryRetryFields1783100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_webhook_deliveries"
       ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_webhook_deliveries"
       ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_webhook_deliveries"
       ADD COLUMN IF NOT EXISTS "request_body" text`,
    );
    // Old RETRYING rows predate the sweep; mark them dead-letter so the sweep
    // never picks up a record that has no next_retry_at to reschedule from.
    await queryRunner.query(
      `UPDATE "project_webhook_deliveries"
       SET status = 'dead_letter', next_retry_at = NULL
       WHERE status = 'retrying'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_webhook_deliveries_status_next_retry"
       ON "project_webhook_deliveries" ("status", "next_retry_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_project_webhook_deliveries_status_next_retry"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_webhook_deliveries" DROP COLUMN IF EXISTS "request_body"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_webhook_deliveries" DROP COLUMN IF EXISTS "next_retry_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_webhook_deliveries" DROP COLUMN IF EXISTS "retry_count"`,
    );
  }
}
