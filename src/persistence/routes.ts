import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { LlmError, type LlmClient } from '../llm.js';
import { confirmEvent, getLatestDashboard, listEvents, upsertUser } from './repository.js';
import { InputError, isRecord, parseEvent, parseName, requireUuid } from './validate.js';
import { rebuildDashboard } from './dashboard.js';

export function registerPersistenceRoutes(app: FastifyInstance, deps: { pool: Pool; llm: LlmClient }): void {
  const respond = async <T>(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, operation: () => Promise<T>): Promise<T | unknown> => {
    try { return await operation(); }
    catch (error) {
      const status = error instanceof InputError || error instanceof LlmError ? error.statusCode : 500;
      return reply.code(status).send({ error: error instanceof InputError || error instanceof LlmError ? error.message : '服務暫時無法使用。' });
    }
  };
  app.post('/api/users', async (request, reply) => respond(reply, async () => {
    const { display, normalized } = parseName(request.body);
    return upsertUser(deps.pool, display, normalized);
  }));
  app.post('/api/events', async (request, reply) => respond(reply, async () => {
    const result = await confirmEvent(deps.pool, parseEvent(request.body));
    reply.code(result.created ? 201 : 200);
    return result.event;
  }));
  app.get('/api/events', async (request, reply) => respond(reply, async () => {
    const userId = requireUuid(isRecord(request.query) ? request.query.userId : undefined);
    return { events: await listEvents(deps.pool, userId) };
  }));
  app.post('/api/dashboard/rebuild', async (request, reply) => respond(reply, async () => {
    const userId = requireUuid(isRecord(request.body) ? request.body.userId : undefined);
    return rebuildDashboard(deps.pool, deps.llm, userId);
  }));
  app.get('/api/dashboard', async (request, reply) => respond(reply, async () => {
    const userId = requireUuid(isRecord(request.query) ? request.query.userId : undefined);
    return { dashboard: await getLatestDashboard(deps.pool, userId) };
  }));
}
