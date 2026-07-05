import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduledDispatch1783200000000 implements MigrationInterface {
  name = 'AddScheduledDispatch1783200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const driver = queryRunner.connection.driver.options.type;
    if (driver === 'postgres') {
      await queryRunner.query(`
        CREATE TABLE "scheduled_dispatch" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "project_id" uuid NOT NULL,
          "title" character varying(255) NOT NULL,
          "goal" text NOT NULL,
          "cron_pattern" character varying(64) NOT NULL,
          "worker_capability" character varying(128),
          "max_concurrent" integer NOT NULL DEFAULT 1,
          "enabled" boolean NOT NULL DEFAULT true,
          "last_run_at" TIMESTAMP,
          "next_run_at" TIMESTAMP,
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "PK_scheduled_dispatch" PRIMARY KEY ("id")
        )
      `);
      await queryRunner.query(`CREATE INDEX "IDX_scheduled_dispatch_project_next_run" ON "scheduled_dispatch" ("project_id", "next_run_at")`);
    } else {
      await queryRunner.query(`
        CREATE TABLE "scheduled_dispatch" (
          "id" varchar PRIMARY KEY NOT NULL,
          "project_id" varchar NOT NULL,
          "title" varchar(255) NOT NULL,
          "goal" text NOT NULL,
          "cron_pattern" varchar(64) NOT NULL,
          "worker_capability" varchar(128),
          "max_concurrent" integer NOT NULL DEFAULT 1,
          "enabled" boolean NOT NULL DEFAULT 1,
          "last_run_at" datetime,
          "next_run_at" datetime,
          "created_at" datetime NOT NULL DEFAULT (datetime('now')),
          "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await queryRunner.query(`CREATE INDEX "IDX_scheduled_dispatch_project_next_run" ON "scheduled_dispatch" ("project_id", "next_run_at")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scheduled_dispatch_project_next_run"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "scheduled_dispatch"`);
  }
}
