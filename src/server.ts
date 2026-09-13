import { buildApp } from './app.js';
import { resolvePort } from './config.js';

const app = buildApp();

try {
  await app.listen({ host: '0.0.0.0', port: resolvePort() });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
