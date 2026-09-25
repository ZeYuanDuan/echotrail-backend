import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { LlmClient } from '../src/llm.js';
import { createTestDatabase } from './database.js';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
const llm: LlmClient = { chat: vi.fn(), insight: vi.fn(), synthesizeDashboard: vi.fn() };
let app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await createTestDatabase(); app = buildApp({ logger: false, pool: db.pool, llm }); });
afterAll(async () => { await app?.close(); await db?.close(); });
const card = { title: '理解問題', happen: ['完成訪談'], emotion: '有成就感', like: '我喜歡釐清問題', dislike: '我討厭盲目執行', value: '先理解再行動', quote: '我很有成就感' };
const messages = [{ role: 'user', text: '我很有成就感，也喜歡釐清問題。' }, { role: 'model', text: '你為什麼有成就感？' }];
const event = (userId: string, conversationId = randomUUID()) => ({ userId, clientEventId: randomUUID(), conversationId, messages, card,
  editedFields: [], signals: [{ framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '喜歡釐清問題' }] });

it('resolves normalized names to stable users and rejects invalid names', async () => {
  const first = await app.inject({ method: 'POST', url: '/api/users', payload: { name: '  小美  ' } });
  const second = await app.inject({ method: 'POST', url: '/api/users', payload: { name: '小美' } });
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({ id: second.json().id, name: '小美' });
  expect((await app.inject({ method: 'POST', url: '/api/users', payload: { name: '  ' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/users', payload: { name: 'a'.repeat(81) } })).statusCode).toBe(400);
});

it('saves each card atomically, retries idempotently, and appends only the new segment', async () => {
  const user = (await app.inject({ method: 'POST', url: '/api/users', payload: { name: '多卡使用者' } })).json();
  const input = event(user.id);
  const first = await app.inject({ method: 'POST', url: '/api/events', payload: input });
  expect(first.statusCode).toBe(201);
  expect(first.json()).toMatchObject({ userId: user.id, conversationId: input.conversationId, messageStartSeq: 1, messageEndSeq: 2 });
  expect((await app.inject({ method: 'POST', url: '/api/events', payload: input })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/api/events', payload: { ...input, card: { ...card, title: 'changed' } } })).statusCode).toBe(409);
  const secondInput = event(user.id, input.conversationId);
  secondInput.messages = [{ role: 'user', text: '第二張卡我想挑戰不同的事。' }, { role: 'model', text: '你想挑戰什麼？' }];
  secondInput.card = { ...card, quote: '第二張卡我想挑戰不同的事。' };
  secondInput.signals = [];
  const second = await app.inject({ method: 'POST', url: '/api/events', payload: secondInput });
  expect(second.statusCode).toBe(201);
  expect(second.json()).toMatchObject({ messageStartSeq: 3, messageEndSeq: 4 });
  const count = await db.pool.query('SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM event_insights) AS insights, (SELECT count(*) FROM conversation_messages WHERE conversation_id=$1) AS messages', [input.conversationId]);
  expect(count.rows[0]).toMatchObject({ messages: '4' });
  expect((await db.pool.query('SELECT insight_revision FROM users WHERE id=$1', [user.id])).rows[0].insight_revision).toBe('2');
  const crossQuote = { ...event(user.id, input.conversationId), card: { ...card, quote: '我很有成就感' }, messages: secondInput.messages, signals: [] };
  expect((await app.inject({ method: 'POST', url: '/api/events', payload: crossQuote })).statusCode).toBe(400);
  const trail = await app.inject({ method: 'GET', url: `/api/events?userId=${user.id}` });
  expect(trail.json().events.map((item: { id: string }) => item.id)).toEqual([first.json().id, second.json().id]);
  const other = (await app.inject({ method: 'POST', url: '/api/users', payload: { name: '另一位' } })).json();
  expect((await app.inject({ method: 'GET', url: `/api/events?userId=${other.id}` })).json().events).toEqual([]);
  await db.pool.query('UPDATE events SET created_at=$1 WHERE id=ANY($2::uuid[])', ['2026-09-25T00:00:00Z', [first.json().id, second.json().id]]);
  const tied = (await app.inject({ method: 'GET', url: `/api/events?userId=${user.id}` })).json().events;
  expect(tied.map((item: { id: string }) => item.id)).toEqual([first.json().id, second.json().id].sort());
  const foreignConversation = event(other.id, input.conversationId);
  expect((await app.inject({ method: 'POST', url: '/api/events', payload: foreignConversation })).statusCode).toBe(409);
});

it('rejects invalid IDs and ungrounded signals without partial writes', async () => {
  const user = (await app.inject({ method: 'POST', url: '/api/users', payload: { name: '驗證使用者' } })).json();
  const input = event(user.id);
  expect((await app.inject({ method: 'POST', url: '/api/events', payload: { ...input, userId: 'bad' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/events', payload: { ...input, signals: [{ framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '不存在的原話' }] } })).statusCode).toBe(400);
  expect((await db.pool.query('SELECT count(*) FROM events WHERE user_id=$1', [user.id])).rows[0].count).toBe('0');
});
