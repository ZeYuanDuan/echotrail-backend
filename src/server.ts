import { buildApp } from './app.js';
import { resolvePort } from './config.js';
import { createPool } from './db.js';

const pool = createPool();
const app = buildApp({ pool });
app.addHook('onClose', async () => { await pool.end(); });

try {
  await app.listen({ host: '0.0.0.0', port: resolvePort() });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
