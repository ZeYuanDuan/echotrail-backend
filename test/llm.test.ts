import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient, LlmError, parseDashboardProfile, parseInsight, parseMessages } from '../src/llm.js';
import type { DashboardEvidence } from '../src/persistence/types.js';

const messages = [
  { role: 'user' as const, text: '我很有成就感，也重視先理解真正的問題。' },
];
const dashboard = {
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
  patterns: [{ title: '先釐清再行動', evidenceQuote: '理解真正的問題' }],
  northStar: {
    primaryAnchor: '專家達人',
    tagline: '用理解創造價值',
    desires: ['解決真正問題'],
    bottomLine: '不直接照單全收',
    nextSteps: ['提早探索需求'],
  },
};
const dashboardEvidence: DashboardEvidence[] = [{
  eventId: 'event-1', title: '理解問題',
  card: { title: '理解問題', happen: ['完成需求探索'], emotion: '有成就感', like: '我在意理解問題',
    dislike: '我不喜歡盲目行動', value: '先理解再行動', quote: '我很有成就感' },
  messages, signals: [], quoteSource: 'user_message',
}];

describe('LLM input and grounded output', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts alternating history ending with a user message', () => {
    expect(parseMessages({ messages })).toEqual(messages);
  });

  it('rejects an invented evidence quote', () => {
    const raw = JSON.stringify({
      card: {
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我很有成就感',
      },
      signals: [
        { framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '不存在的原話' },
      ],
      dashboard,
    });
    expect(() => parseInsight(raw, messages)).toThrow(LlmError);
  });

  it('accepts a grounded card and chart signal', () => {
    const raw = JSON.stringify({
      card: {
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我很有成就感',
      },
      signals: [
        { framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '理解真正的問題' },
      ],
      dashboard,
    });
    expect(parseInsight(raw, messages).signals[0]?.strength).toBe(8);
  });

  it('gives the failed JSON and validation reason back to Gemini for a targeted retry', async () => {
    const invalidRaw = JSON.stringify({
      card: {
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我非常有成就感',
      },
      signals: [],
      dashboard,
    });
    const validRaw = JSON.stringify({
      card: {
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我很有成就感',
      },
      signals: [],
      dashboard,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: invalidRaw }] } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: validRaw }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).insight(messages);

    expect(result.card.quote).toBe('我很有成就感');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    expect(retryRequest.contents.at(-2)).toEqual({ role: 'model', parts: [{ text: invalidRaw }] });
    expect(retryRequest.contents.at(-1)?.parts[0]?.text).toContain(
      '模型產出的卡片未通過 grounding 驗證',
    );
  });

  it('accepts a dashboard profile in the prior insight response shape without weakening grounding', () => {
    expect(parseDashboardProfile(JSON.stringify({ card: {}, signals: [], dashboard }), dashboardEvidence)).toEqual(dashboard);
    expect(() => parseDashboardProfile(JSON.stringify({ card: {}, signals: [], dashboard: {
      ...dashboard, persona: { ...dashboard.persona, quote: '不存在的原話' },
    } }), dashboardEvidence)).toThrow('Dashboard 模型產出未通過格式或原文驗證。');
  });

  it('requests a corrected dashboard when a field is missing, then accepts a grounded profile', async () => {
    const invalidRaw = JSON.stringify({ persona: dashboard.persona });
    const validRaw = JSON.stringify(dashboard);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: invalidRaw }] } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: validRaw }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).synthesizeDashboard(dashboardEvidence)).toEqual(dashboard);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        systemInstruction: { parts: Array<{ text: string }> };
      };
      expect(firstRequest.systemInstruction.parts[0]?.text).toContain('最外層');
      const retryRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
        contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      };
      expect(retryRequest.contents.at(-1)?.parts[0]?.text).toContain('Dashboard 模型產出缺少欄位');
      expect(warn).toHaveBeenCalledWith('Dashboard profile validation failed', expect.objectContaining({
        reason: 'Dashboard 模型產出缺少欄位。',
        shape: expect.objectContaining({ dashboard: 'missing' }),
      }));
    } finally {
      warn.mockRestore();
    }
  });

  it('logs only the expected field types after repeated invalid dashboard responses', async () => {
    const invalidRaw = JSON.stringify({ dashboard: { persona: { headline: '私人內容' } } });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: invalidRaw }] } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).synthesizeDashboard(dashboardEvidence))
        .rejects.toThrow('Dashboard 模型產出缺少欄位。');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith('Dashboard profile validation failed', {
        reason: 'Dashboard 模型產出缺少欄位。',
        shape: {
          root: { persona: 'missing', anchor: 'missing', keywords: 'missing', patterns: 'missing', northStar: 'missing' },
          dashboard: 'object',
          wrapped: { persona: 'object', anchor: 'missing', keywords: 'missing', patterns: 'missing', northStar: 'missing' },
        },
      });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('persona');
      expect(logged).toContain('dashboard');
      expect(logged).not.toContain('私人內容');
      expect(logged).not.toContain(messages[0]!.text);
    } finally {
      warn.mockRestore();
    }
  });
});
