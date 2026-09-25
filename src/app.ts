import Fastify, { type FastifyInstance } from 'fastify';
import { GeminiClient, LlmError, parseMessages, type LlmClient } from './llm.js';
import type { Pool } from 'pg';
import { registerPersistenceRoutes } from './persistence/routes.js';

type BuildAppOptions = {
  logger?: boolean;
  llm?: LlmClient;
  pool?: Pool;
};

export const buildApp = ({ logger = true, llm, pool }: BuildAppOptions = {}): FastifyInstance => {
  const app = Fastify({ logger });
  let client = llm;
  const getClient = () => (client ??= new GeminiClient());

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/api/llm/chat', async (request, reply) => {
    try {
      return await getClient().chat(parseMessages(request.body));
    } catch (error) {
      const statusCode = error instanceof LlmError ? error.statusCode : 500;
      return reply.code(statusCode).send({
        error: error instanceof LlmError ? error.message : '服務暫時無法使用。',
      });
    }
  });

  app.post('/api/llm/insight', async (request, reply) => {
    try {
      return await getClient().insight(parseMessages(request.body, false));
    } catch (error) {
      const statusCode = error instanceof LlmError ? error.statusCode : 500;
      return reply.code(statusCode).send({
        error: error instanceof LlmError ? error.message : '服務暫時無法使用。',
      });
    }
  });

  if (pool) registerPersistenceRoutes(app, { pool, llm: getClient() });

  return app;
};
