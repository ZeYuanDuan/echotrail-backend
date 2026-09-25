import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { applyMigrations } from '../src/migrate.js';
import { fileURLToPath } from 'node:url';

export async function createTestDatabase(migrate = true): Promise<{ pool: Pool; close: () => Promise<void> }> {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (url.pathname.slice(1) === 'echotrail') throw new Error('Refusing to test against echotrail');
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const { rows } = await admin.query('SELECT current_database() AS name');
  if (rows[0]?.name === 'echotrail') throw new Error('Refusing to test against echotrail');
  const name = `echotrail_test_${randomUUID().replace(/-/g, '')}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Invalid test database name');
  await admin.query(`CREATE DATABASE ${name}`);
  async function dropDatabase(): Promise<void> {
    // pg-pool can finish end() before PostgreSQL observes the socket closing.
    const deadline = Date.now() + 5000;
    while (true) {
      const { rows } = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1', [name]);
      if (rows[0]?.count === 0) break;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for test database ${name} connections to close`);
      await setTimeout(20);
    }
    await admin.query(`DROP DATABASE ${name}`);
  }
  const testUrl = new URL(url);
  testUrl.pathname = `/${name}`;
  const pool = new Pool({ connectionString: testUrl.toString() });
  try {
    if (migrate) {
      const client = await pool.connect();
      try { await applyMigrations(client, fileURLToPath(new URL('../migrations/', import.meta.url))); }
      finally { client.release(); }
    }
  } catch (error) {
    await pool.end();
    try { await dropDatabase(); }
    finally { await admin.end(); }
    throw error;
  }
  return {
    pool,
    close: async () => {
      await pool.end();
      try { await dropDatabase(); }
      finally { await admin.end(); }
    },
  };
}
