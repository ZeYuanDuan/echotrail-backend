import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../src/migrate.js';
import { createTestDatabase } from './database.js';

const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { db = await createTestDatabase(false); });
afterAll(async () => { await db?.close(); });

it('applies once and serializes concurrent runners', async () => {
  const clients = await Promise.all([db.pool.connect(), db.pool.connect()]);
  try {
    const counts = await Promise.all(clients.map((client) => applyMigrations(client, directory)));
    expect(counts.sort()).toEqual([0, 2]);
    expect(await applyMigrations(clients[0]!, directory)).toBe(0);
    expect((await db.pool.query('SELECT version FROM schema_migrations')).rows).toHaveLength(2);

    const userId = randomUUID();
    const eventId = randomUUID();
    await db.pool.query(
      'INSERT INTO users(id,display_name,normalized_name) VALUES($1,$2,$3)',
      [userId, 'migration test', `migration-${userId}`],
    );
    await db.pool.query(
      "INSERT INTO events(id,user_id,client_event_id,request_hash,title,source) VALUES($1,$2,$3,'hash','event','import')",
      [eventId, userId, randomUUID()],
    );
    await expect(db.pool.query(
      "INSERT INTO framework_signals(user_id,event_id,framework,dimension,strength,evidence_quote) VALUES($1,$2,'schein','security',-6,'quote')",
      [userId, eventId],
    )).resolves.toBeDefined();
    await expect(db.pool.query(
      "INSERT INTO framework_signals(user_id,event_id,framework,dimension,strength,evidence_quote) VALUES($1,$2,'schein','technical',0,'quote')",
      [userId, eventId],
    )).rejects.toThrow();
  } finally { clients.forEach((client) => client.release()); }
});

it('rejects a changed checksum and rolls back a failed migration', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'echotrail-migrate-'));
  const client = await db.pool.connect();
  try {
    const original = await readFile(join(directory, '001_initial_schema.sql'), 'utf8');
    await writeFile(join(temp, '001_initial_schema.sql'), `${original}\n-- changed`);
    await expect(applyMigrations(client, temp)).rejects.toThrow(/checksum/i);
    await writeFile(join(temp, '001_initial_schema.sql'), original);
    await writeFile(join(temp, '002_fail.sql'), 'CREATE TABLE should_rollback(id int); SELECT 1/0;');
    await expect(applyMigrations(client, temp)).rejects.toThrow();
    expect((await db.pool.query("SELECT to_regclass('should_rollback') AS table_name")).rows[0]?.table_name).toBeNull();
    expect((await db.pool.query('SELECT version FROM schema_migrations')).rows).toHaveLength(2);
  } finally { client.release(); await rm(temp, { recursive: true, force: true }); }
});
