import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAgentHeartbeatLog1783400000000 implements MigrationInterface {
  name = 'CreateAgentHeartbeatLog1783400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_heartbeat_log" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "agent_id" uuid NOT NULL,
        "status" varchar(32),
        "health_status" varchar(32),
        "response_time_ms" integer,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_agent_heartbeat_log_agent_id" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      'CREATE INDEX "IDX_agent_heartbeat_log_agent_id_created_at" ON "agent_heartbeat_log" ("agent_id", "created_at")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "agent_heartbeat_log"');
  }
}
