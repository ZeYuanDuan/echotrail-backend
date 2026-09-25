import Fastify, { type FastifyInstance } from 'fastify';
import {
  GeminiClient,
  LlmError,
  parseDashboardEvents,
  parseMessages,
  type LlmClient,
} from './llm.js';

type BuildAppOptions = {
  logger?: boolean;
  llm?: LlmClient;
};

export const buildApp = ({ logger = true, llm }: BuildAppOptions = {}): FastifyInstance => {
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

  app.post('/api/llm/dashboard', async (request, reply) => {
    try {
      return await getClient().dashboard(parseDashboardEvents(request.body));
    } catch (error) {
      const statusCode = error instanceof LlmError ? error.statusCode : 500;
      return reply.code(statusCode).send({
        error: error instanceof LlmError ? error.message : '服務暫時無法使用。',
      });
    }
  });

  return app;
};
