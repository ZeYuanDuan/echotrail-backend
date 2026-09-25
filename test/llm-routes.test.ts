import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { LlmClient } from '../src/llm.js';

describe('LLM routes', () => {
  let app: FastifyInstance;
  const llm: LlmClient = {
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
      careerAnchorType: '專家達人',
    }),
    dashboard: vi.fn().mockResolvedValue({
      signals: [],
      dashboard: {
        persona: {
          headline: '先理解問題再行動的人',
          summaries: ['擅長拆解問題'],
          quote: '我很有成就感',
        },
        anchor: {
          primary: '專家達人',
          ability: ['拆解問題'],
          motivation: ['解決問題'],
          values: ['先理解再行動'],
        },
        keywords: [
          { text: '理解', weight: 5 },
          { text: '問題', weight: 4 },
          { text: '行動', weight: 3 },
        ],
        patterns: [{ title: '先釐清再行動', evidenceQuote: '我很有成就感' }],
        northStar: {
          primaryAnchor: '專家達人',
          tagline: '用理解創造價值',
          desires: ['解決真正問題'],
          bottomLine: '不直接照單全收',
          nextSteps: ['提早探索需求'],
        },
      },
    }),
  };

  afterEach(async () => app.close());

  it('serves chat and insight from the backend', async () => {
    app = buildApp({ logger: false, llm });
    const body = { messages: [{ role: 'user', text: '我很有成就感' }] };
    const chat = await app.inject({ method: 'POST', url: '/api/llm/chat', payload: body });
    const insight = await app.inject({ method: 'POST', url: '/api/llm/insight', payload: body });
    const dashboardResponse = await app.inject({
      method: 'POST',
      url: '/api/llm/dashboard',
      payload: {
        events: [
          {
            eventId: 1,
            title: '跨團隊推動成功',
            happen: ['功能成功上線'],
            emotion: '有成就感',
            like: '我擅長拆解問題',
            dislike: '我不喜歡把需求直接當答案',
            value: '先理解真正的問題再行動',
            quote: '我很有成就感',
            careerAnchorType: '專家達人',
          },
        ],
      },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().text).toContain('有成就感');
    expect(insight.statusCode).toBe(200);
    expect(insight.json().card.title).toBe('跨團隊推動成功');
    expect(dashboardResponse.statusCode).toBe(200);
    expect(dashboardResponse.json().dashboard.anchor.primary).toBe('專家達人');
  });
});
