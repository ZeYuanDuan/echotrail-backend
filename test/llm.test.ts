import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GeminiClient,
  LlmError,
  parseDashboard,
  parseInsight,
  parseMessages,
} from '../src/llm.js';

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
  patterns: [{ title: '先釐清再行動', evidenceQuote: '我很有成就感' }],
  northStar: {
    primaryAnchor: '專家達人',
    tagline: '用理解創造價值',
    desires: ['解決真正問題'],
    bottomLine: '不直接照單全收',
    nextSteps: ['提早探索需求'],
  },
};

describe('LLM input and grounded output', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts alternating history ending with a user message', () => {
    expect(parseMessages({ messages })).toEqual(messages);
  });

  it('enforces the per-message length limit', () => {
    expect(parseMessages({ messages: [{ role: 'user', text: '字'.repeat(800) }] })).toHaveLength(1);
    expect(() =>
      parseMessages({ messages: [{ role: 'user', text: '字'.repeat(801) }] }),
    ).toThrow(LlmError);
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
      careerAnchorType: '專家達人',
    });
    const inventedQuote = raw.replace('我很有成就感', '不存在的原話');
    expect(() => parseInsight(inventedQuote, messages)).toThrow(LlmError);
  });

  it('accepts a grounded Echo Card and career anchor', () => {
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
      careerAnchorType: '專家達人',
    });
    expect(parseInsight(raw, messages).careerAnchorType).toBe('專家達人');
  });

  it('does not count whitespace or symbols toward the minimum Echo Card quote length', () => {
    const raw = JSON.stringify({
      card: {
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我 ！。',
      },
      careerAnchorType: '專家達人',
    });
    expect(() => parseInsight(raw, messages)).toThrow(LlmError);
  });

  it('validates Dashboard evidence against stored event quotes', () => {
    const events = [
      {
        eventId: 1,
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我很有成就感',
        careerAnchorType: '專家達人' as const,
      },
    ];
    const raw = JSON.stringify({
      signals: [
        { framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '我很有成就感' },
      ],
      dashboard,
    });
    expect(parseDashboard(raw, events).signals[0]?.strength).toBe(8);
  });

  it('rejects a shortened Dashboard quote that is not in the evidence allowlist', () => {
    const events = [
      {
        eventId: 1,
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我很有成就感，也重視先理解真正的問題',
        careerAnchorType: '專家達人' as const,
      },
    ];
    const raw = JSON.stringify({
      signals: [
        { framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '我很有成就感' },
      ],
      dashboard,
    });

    expect(() => parseDashboard(raw, events)).toThrow(
      'signals[0].evidenceQuote 必須完整複製 allowedEvidenceQuotes',
    );
  });

  it('does not count whitespace or symbols toward the minimum Dashboard quote length', () => {
    const events = [
      {
        eventId: 1,
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我 ！。我很有成就感',
        careerAnchorType: '專家達人' as const,
      },
    ];
    const raw = JSON.stringify({
      signals: [{ framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '我 ！。' }],
      dashboard,
    });
    expect(() => parseDashboard(raw, events)).toThrow(LlmError);
  });

  it('reports the exact invalid Dashboard dimension', () => {
    const events = [
      {
        eventId: 1,
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我很有成就感',
        careerAnchorType: '專家達人' as const,
      },
    ];
    const raw = JSON.stringify({
      signals: [
        {
          framework: 'schein',
          dimension: '專家達人',
          strength: 8,
          evidenceQuote: '我很有成就感',
        },
      ],
      dashboard,
    });

    expect(() => parseDashboard(raw, events)).toThrow(
      'signals[0].dimension 必須是 schein 的允許代碼',
    );
  });

  it('gives Gemini an explicit Dashboard evidence allowlist and targeted retry reason', async () => {
    const events = [
      {
        eventId: 1,
        title: '理解問題',
        happen: ['完成一次需求探索'],
        emotion: '有成就感',
        like: '我在意理解問題',
        dislike: '我不喜歡直接照單全收',
        value: '先理解問題再行動',
        quote: '我很有成就感',
        careerAnchorType: '專家達人' as const,
      },
    ];
    const invalidRaw = JSON.stringify({
      signals: [
        {
          framework: 'riasec',
          dimension: '研究型',
          strength: 8,
          evidenceQuote: '我很有成就感',
        },
      ],
      dashboard,
    });
    const validRaw = JSON.stringify({
      signals: [
        { framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '我很有成就感' },
      ],
      dashboard,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: invalidRaw }] } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: validRaw }] } }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).dashboard(
      events,
    );

    expect(result.signals[0]?.dimension).toBe('I');
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(firstRequest.systemInstruction.parts[0]?.text).toContain(
      'riasec 使用 R、I、A、S、E、C',
    );
    expect(JSON.parse(firstRequest.contents[0]?.parts[0]?.text ?? '{}')).toMatchObject({
      allowedEvidenceQuotes: [{ eventId: 1, quote: '我很有成就感' }],
    });
    const retryRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(retryRequest.contents.at(-1)?.parts[0]?.text).toContain(
      'signals[0].dimension 必須是 riasec 的允許代碼：R、I、A、S、E、C',
    );
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
      careerAnchorType: '專家達人',
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
      careerAnchorType: '專家達人',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: invalidRaw }] } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: validRaw }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).insight(messages);

    expect(result.card.quote).toBe('我很有成就感');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(fetchMock.mock.calls[0]?.[1]?.signal);
    const retryRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    expect(retryRequest.contents.at(-2)).toEqual({ role: 'model', parts: [{ text: invalidRaw }] });
    expect(retryRequest.contents.at(-1)?.parts[0]?.text).toContain(
      '模型產出的卡片未通過 grounding 驗證',
    );
  });

  it('switches to the more direct prompt after ten user turns', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '回覆' }] } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new GeminiClient({ apiKey: 'test-key', model: 'test-model' });
    const history = Array.from({ length: 21 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'model') as 'user' | 'model',
      text: `第 ${index + 1} 則`,
    }));

    await client.chat(history);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
    };
    expect(request.systemInstruction.parts[0]?.text).toContain('第 11～15 輪');
  });

  it('allows the introduction only in the first-turn prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '回覆' }] } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new GeminiClient({ apiKey: 'test-key', model: 'test-model' });

    await client.chat([{ role: 'user', text: '我想聊今天發生的事' }]);
    await client.chat([
      { role: 'user', text: '我想聊今天發生的事' },
      { role: 'model', text: '好，我們來看看。' },
      { role: 'user', text: '我覺得有點挫折' },
    ]);

    const prompts = fetchMock.mock.calls.map((call) => {
      const request = JSON.parse(String(call[1]?.body)) as {
        systemInstruction: { parts: Array<{ text: string }> };
      };
      return request.systemInstruction.parts[0]?.text ?? '';
    });
    expect(prompts[0]).toContain('只有這一輪可以使用「嗨，我是艾可。」');
    expect(prompts[1]).toContain('不得再自我介紹');
    expect(prompts[1]).toContain('不得使用「嗨，我是艾可。」');
  });

  it('instructs Gemini not to parrot the user with canned phrases', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '回覆' }] } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).chat([
      { role: 'user', text: '我覺得有點挫折' },
    ]);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
    };
    const prompt = request.systemInstruction.parts[0]?.text ?? '';
    expect(prompt).toContain('不要用「聽到你說……」');
    expect(prompt).toContain('不得重複整句或大段改寫');
  });
});
