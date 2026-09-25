import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { LlmClient } from '../src/llm.js';
import { createTestDatabase } from './database.js';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
const profile = { persona: { headline: '重視理解的人', summaries: ['重視理解'], quote: '我很有成就感' },
  anchor: { primary: '專家達人', ability: ['釐清問題'], motivation: ['理解事情'], values: ['先理解'] },
  keywords: [{ text: '理解', weight: 4 }], patterns: [{ title: '先釐清', evidenceQuote: '釐清問題' }],
  northStar: { primaryAnchor: '專家達人', tagline: '理解後行動', desires: ['理解'], bottomLine: '不盲目', nextSteps: ['繼續記錄'] } };
const synthesizeDashboard = vi.fn().mockResolvedValue(profile);
const llm: LlmClient = { chat: vi.fn(), insight: vi.fn(), synthesizeDashboard };
beforeAll(async () => { db = await createTestDatabase(); app = buildApp({ logger: false, pool: db.pool, llm }); });
afterAll(async () => { await app?.close(); await db?.close(); });
async function user(name: string): Promise<string> { return (await app.inject({ method: 'POST', url: '/api/users', payload: { name } })).json().id; }
async function save(userId: string, text = '我很有成就感，也喜歡釐清問題。'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/events', payload: {
    userId, clientEventId: randomUUID(), conversationId: randomUUID(),
    messages: [{ role: 'user', text }, { role: 'model', text: '你怎麼看？' }],
    card: { title: '理解問題', happen: ['完成訪談'], emotion: '有成就感', like: '我喜歡理解', dislike: '我不喜歡盲目', value: '先理解再行動', quote: text },
    editedFields: [], signals: [{ framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: text }],
  } });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

it('rebuilds from all and only the user events, then GET reads the same saved run', async () => {
  const a = await user('Dashboard A');
  const b = await user('Dashboard B');
  const first = await save(a);
  const second = await save(a);
  await save(b, '這是 B 的獨立事件。');
  const result = await app.inject({ method: 'POST', url: '/api/dashboard/rebuild', payload: { userId: a } });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ userId: a, sourceEventCount: 2, sourceRevision: 2, profile });
  expect(result.json().frameworks.scores.riasec.I).toBe(80);
  expect(result.json().frameworks.scores.disc.D).toBe(0);
  expect(result.json().frameworks.evidence.map((item: { eventId: string }) => item.eventId)).toEqual([first, second]);
  expect(synthesizeDashboard).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ eventId: first }), expect.objectContaining({ eventId: second })]));
  expect(synthesizeDashboard.mock.lastCall?.[0]).toHaveLength(2);
  const before = synthesizeDashboard.mock.calls.length;
  const fetched = await app.inject({ method: 'GET', url: `/api/dashboard?userId=${a}` });
  expect(fetched.json().dashboard).toEqual(result.json());
  expect(synthesizeDashboard).toHaveBeenCalledTimes(before);
  expect((await app.inject({ method: 'GET', url: `/api/dashboard?userId=${b}` })).json().dashboard).toBeNull();
});

it('keeps the old run when Gemini fails, output is invalid, or revision changes during synthesis', async () => {
  const a = await user('衝突使用者');
  await save(a);
  const prior = (await app.inject({ method: 'POST', url: '/api/dashboard/rebuild', payload: { userId: a } })).json();
  synthesizeDashboard.mockRejectedValueOnce(new Error('Gemini failed'));
  expect((await app.inject({ method: 'POST', url: '/api/dashboard/rebuild', payload: { userId: a } })).statusCode).toBe(500);
  synthesizeDashboard.mockResolvedValueOnce({ ...profile, persona: { ...profile.persona, quote: '不存在的引文' } });
  expect((await app.inject({ method: 'POST', url: '/api/dashboard/rebuild', payload: { userId: a } })).statusCode).toBe(502);
  let release!: (value: typeof profile) => void;
  synthesizeDashboard.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const before = synthesizeDashboard.mock.calls.length;
  const pending = app.inject({ method: 'POST', url: '/api/dashboard/rebuild', payload: { userId: a } }).then((response) => response);
  await vi.waitFor(() => expect(synthesizeDashboard).toHaveBeenCalledTimes(before + 1));
  await save(a);
  release(profile);
  expect((await pending).statusCode).toBe(409);
  expect((await app.inject({ method: 'GET', url: `/api/dashboard?userId=${a}` })).json().dashboard).toEqual(prior);
});
