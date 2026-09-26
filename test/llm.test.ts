import { randomUUID } from 'node:crypto';
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
const dashboardModel = {
  ...dashboard,
  persona: {
    headline: dashboard.persona.headline,
    summaries: dashboard.persona.summaries,
    quoteId: 'q1',
  },
  patterns: dashboard.patterns.map((pattern) => ({ title: pattern.title, evidenceQuoteId: 'q2' })),
};
const dashboardEvidence: DashboardEvidence[] = [{
  eventId: randomUUID(), title: '理解問題',
  card: { title: '理解問題', happen: ['完成需求探索'], emotion: '有成就感', like: '我在意理解問題',
    dislike: '我不喜歡盲目行動', value: '先理解再行動', quote: '我很有成就感' },
  messages,
  signals: [{ framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '理解真正的問題' }],
  quoteSource: 'user_message',
}];

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
      signals: [
        { framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '不存在的原話' },
      ],
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
    });
    expect(parseInsight(raw, messages).signals[0]?.strength).toBe(8);
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
      signals: [],
    });
    expect(() => parseInsight(raw, [{ role: 'user', text: '我 ！。' }])).toThrow(LlmError);
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
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: invalidRaw }] } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: validRaw }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).insight(messages);

    expect(result.card.quote).toBe('我很有成就感');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).not.toBe(fetchMock.mock.calls[0]?.[1]?.signal);
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
    } }), dashboardEvidence)).toThrow('persona.quote 必須逐字複製允許的使用者原文。');
  });

  it('reports the exact invalid dashboard field instead of a generic validation error', () => {
    expect(() => parseDashboardProfile(JSON.stringify({
      ...dashboard,
      anchor: { ...dashboard.anchor, ability: ['一', '二', '三', '四'] },
    }), dashboardEvidence)).toThrow('anchor.ability 必須包含 1 到 3 個非空字串。');

    expect(() => parseDashboardProfile(JSON.stringify({
      ...dashboard,
      keywords: [{ text: '理解', weight: 8 }],
    }), dashboardEvidence)).toThrow('keywords[0].weight 必須是 1 到 5 的整數。');
  });

  it('gives Gemini the exact invalid signal field and allowed dimensions on retry', async () => {
    const invalidRaw = JSON.stringify({
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
        {
          framework: 'riasec',
          dimension: '研究型',
          strength: 8,
          evidenceQuote: '我很有成就感',
        },
      ],
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
      signals: [
        { framework: 'riasec', dimension: 'I', strength: 8, evidenceQuote: '我很有成就感' },
      ],
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

    const result = await new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).insight(
      messages,
    );

    expect(result.signals[0]?.dimension).toBe('I');
    const retryRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(retryRequest.contents.at(-1)?.parts[0]?.text).toContain(
      'signals[0].dimension 必須是 riasec 的允許代碼：R、I、A、S、E、C',
    );
  });

  it('requests a corrected dashboard when a field is missing, then accepts a grounded profile', async () => {
    const invalidRaw = JSON.stringify({ persona: dashboard.persona });
    const validRaw = JSON.stringify(dashboardModel);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: invalidRaw }] } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: validRaw }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).synthesizeDashboard(dashboardEvidence)).toEqual(dashboard);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[1]?.signal).not.toBe(fetchMock.mock.calls[0]?.[1]?.signal);
      const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        systemInstruction: { parts: Array<{ text: string }> };
        generationConfig: {
          responseMimeType: string;
          responseJsonSchema: {
            properties: {
              persona: { properties: { quoteId: { enum: string[] } } };
              keywords: { minItems: number; maxItems: number };
            };
          };
        };
      };
      expect(firstRequest.systemInstruction.parts[0]?.text).toContain('不要包在 dashboard');
      expect(firstRequest.systemInstruction.parts[0]?.text).toContain('1 到 3 個非空字串');
      expect(firstRequest.systemInstruction.parts[0]?.text).toContain('quoteOptions 中的 id');
      expect(firstRequest.generationConfig.responseMimeType).toBe('application/json');
      expect(firstRequest.generationConfig.responseJsonSchema.properties.persona.properties.quoteId.enum)
        .toEqual(['q1', 'q2', 'q3']);
      expect(firstRequest.generationConfig.responseJsonSchema.properties.keywords)
        .toMatchObject({ minItems: 1, maxItems: 12 });
      const firstPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        contents: Array<{ parts: Array<{ text: string }> }>;
      };
      const input = JSON.parse(firstPayload.contents[0]?.parts[0]?.text ?? '') as {
        quoteOptions: Array<{ id: string; text: string }>;
      };
      expect(input.quoteOptions).toEqual(expect.arrayContaining([
        { id: 'q1', text: '我很有成就感' },
        { id: 'q2', text: '理解真正的問題' },
      ]));
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

  it('tells Gemini which dashboard quote failed grounding before retrying', async () => {
    const invalidRaw = JSON.stringify({
      ...dashboardModel,
      persona: { ...dashboardModel.persona, quoteId: '不存在的-id' },
    });
    const validRaw = JSON.stringify(dashboardModel);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: invalidRaw }] } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: validRaw }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).synthesizeDashboard(dashboardEvidence))
        .resolves.toEqual(dashboard);
      const retryRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
        contents: Array<{ parts: Array<{ text: string }> }>;
      };
      expect(retryRequest.contents.at(-1)?.parts[0]?.text).toContain(
        'persona.quoteId 必須引用 quoteOptions 中既有的 id',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('safely caps oversized model lists before validating the dashboard', async () => {
    const oversized = {
      ...dashboardModel,
      persona: { ...dashboardModel.persona, summaries: ['一', '二', '三', '四'] },
      anchor: { ...dashboardModel.anchor, ability: ['一', '二', '三', '四'] },
      keywords: Array.from({ length: 13 }, (_, index) => ({ text: `關鍵字${index + 1}`, weight: 3 })),
      patterns: Array.from({ length: 6 }, (_, index) => ({
        title: `模式${index + 1}`,
        evidenceQuoteId: 'q2',
      })),
      northStar: { ...dashboardModel.northStar, nextSteps: ['一', '二', '三', '四'] },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(oversized) }] } }] }),
    }));

    const result = await new GeminiClient({ apiKey: 'test-key', model: 'test-model' })
      .synthesizeDashboard(dashboardEvidence);

    expect(result.persona.summaries).toHaveLength(3);
    expect(result.anchor.ability).toHaveLength(3);
    expect(result.keywords).toHaveLength(12);
    expect(result.patterns).toHaveLength(5);
    expect(result.northStar.nextSteps).toHaveLength(3);
  });

  it('never offers model messages as grounded dashboard quote options', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const modelOnlyEvidence: DashboardEvidence[] = [{
      ...dashboardEvidence[0]!,
      card: { ...dashboardEvidence[0]!.card, quote: '模型自己寫的句子' },
      messages: [{ role: 'model', text: '模型自己寫的句子' }],
      signals: [],
      quoteSource: 'user_message',
    }];

    await expect(new GeminiClient({ apiKey: 'test-key', model: 'test-model' })
      .synthesizeDashboard(modelOnlyEvidence))
      .rejects.toThrow('Dashboard 沒有可引用的使用者原文。');
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('asks Gemini to score every supported dimension independently for one event', async () => {
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
        { framework: 'schein', dimension: 'technical', strength: 8, evidenceQuote: '我很有成就感' },
        { framework: 'schein', dimension: 'security', strength: -5, evidenceQuote: '我很有成就感' },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: raw }] } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiClient({ apiKey: 'test-key', model: 'test-model' }).insight(messages);

    expect(result.signals.filter((signal) => signal.framework === 'schein')).toHaveLength(2);
    expect(result.signals[1]?.strength).toBe(-5);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
    };
    const prompt = request.systemInstruction.parts[0]?.text ?? '';
    expect(prompt).toContain('同一事件可以同時影響多個維度');
    expect(prompt).toContain('每個維度獨立評分');
    expect(prompt).toContain('逐一檢視八個維度');
    expect(prompt).toContain('framework 一律為 schein');
    expect(prompt).toContain('正數代表支持該錨點，負數代表');
    expect(prompt).toContain('絕對值 1～3 是間接或較弱訊號');
  });
});
