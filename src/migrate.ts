import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { createPool } from './db.js';

export async function applyMigrations(client: Pick<PoolClient, 'query'>, directory: string): Promise<number> {
  const files = (await readdir(directory)).filter((name) => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  let applied = 0;
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('echotrail-schema-migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const version = file.slice(0, 3);
      const sql = await readFile(join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version]);
      if (prior.rows.length) {
        if (prior.rows[0].checksum !== checksum) throw new Error(`Migration ${version} checksum mismatch`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
      applied++;
      console.info(`Applied migration ${version}`);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pool = createPool();
  try {
    const client = await pool.connect();
    try {
      await applyMigrations(client, fileURLToPath(new URL('../migrations/', import.meta.url)));
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Migration failed');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
