import Fastify, { type FastifyInstance } from 'fastify';

type BuildAppOptions = {
  logger?: boolean;
};

export const buildApp = ({ logger = true }: BuildAppOptions = {}): FastifyInstance => {
  const app = Fastify({ logger });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
};
