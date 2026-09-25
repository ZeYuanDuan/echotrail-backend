import { Pool } from 'pg';

export function createPool(): Pool {
  const { PGHOST, PGDATABASE, PGUSER, PGPASSWORD } = process.env;
  const port = Number(process.env.PGPORT ?? 5432);
  if (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD || !Number.isInteger(port) || port < 1) {
    throw new Error('PostgreSQL configuration is incomplete');
  }
  return new Pool({ host: PGHOST, port, database: PGDATABASE, user: PGUSER, password: PGPASSWORD, max: 5, connectionTimeoutMillis: 5000 });
}
