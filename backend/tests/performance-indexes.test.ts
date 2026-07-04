import assert from 'node:assert/strict';
import net from 'node:net';

/**
 * Verifies that the hot-query performance indexes defined in
 * 1782900000000-AddPerformanceIndexes were actually created.
 *
 * This test needs a real PostgreSQL instance because it queries pg_indexes.
 * It deliberately does NOT set NODE_ENV='test' so AppDataSource uses the
 * production Postgres branch. If no Postgres is reachable, it prints a blocker
 * and exits cleanly (skip) so SQLite-only local runs still pass.
 */

process.env.JWT_SECRET = 'performance-indexes-test-secret';

const EXPECTED_INDEXES = [
  'IDX_project_changesets_project_id_status',
  'IDX_project_orchestration_tasks_orchestration_id_status',
  'IDX_project_orchestration_tasks_assigned_agent_id_status',
  'IDX_agent_inbox_items_recipient_agent_id_acked_at',
  'IDX_agents_project_id_last_heartbeat_at',
  'IDX_project_files_project_id_path',
];

async function pgReachable(): Promise<boolean> {
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '5432', 10);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  if (!(await pgReachable())) {
    console.log('\n[performance-indexes] SKIP: no PostgreSQL reachable at ' +
      `${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}. ` +
      'Run with a local Postgres or via backend/scripts/pg-parity-check.sh to exercise pg_indexes verification.');
    return;
  }

  const { AppDataSource } = await import('../src/data-source');
  await AppDataSource.initialize();

  try {
    // Ensure migrations are applied so the indexes exist.
    await AppDataSource.runMigrations({ transaction: 'each' });

    const rows: Array<{ indexname: string }> = await AppDataSource.query(
      `SELECT indexname FROM pg_indexes ` +
      `WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [EXPECTED_INDEXES],
    );

    const found = new Set(rows.map((r) => r.indexname));
    const missing = EXPECTED_INDEXES.filter((name) => !found.has(name));

    if (missing.length > 0) {
      console.error('\n❌ performance-indexes test failed: missing indexes:', missing);
      process.exitCode = 1;
      return;
    }

    console.log(`\n✅ performance-indexes test passed: all ${EXPECTED_INDEXES.length} indexes present in pg_indexes.`);
  } catch (err) {
    console.error('\n❌ performance-indexes test failed:', err);
    process.exitCode = 1;
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
