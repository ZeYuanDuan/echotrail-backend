import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { LlmClient } from '../src/llm.js';

describe('LLM routes', () => {
  let app: FastifyInstance;
  const llm: LlmClient = {
    synthesizeDashboard: vi.fn(),
    chat: vi.fn().mockResolvedValue({ text: '你提到「有成就感」，哪個判斷最關鍵？' }),
    insight: vi.fn().mockResolvedValue({
      card: {
        title: '跨團隊推動成功',
        happen: ['功能成功上線'],
        emotion: '有成就感',
        like: '我擅長拆解問題',
        dislike: '我不喜歡把需求直接當答案',
        value: '先理解真正的問題再行動',
        quote: '我很有成就感',
      },
      signals: [],
    }),
  };

  afterEach(async () => app.close());

  it('serves chat and insight from the backend', async () => {
    app = buildApp({ logger: false, llm });
    const body = { messages: [{ role: 'user', text: '我很有成就感' }] };
    const chat = await app.inject({ method: 'POST', url: '/api/llm/chat', payload: body });
    const insight = await app.inject({ method: 'POST', url: '/api/llm/insight', payload: body });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().text).toContain('有成就感');
    expect(insight.statusCode).toBe(200);
    expect(insight.json().card.title).toBe('跨團隊推動成功');
    expect(insight.json().signals).toEqual([]);
    expect(insight.json()).not.toHaveProperty('dashboard');
  });
});
