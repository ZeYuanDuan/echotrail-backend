import { resolveGeminiConfig, type GeminiConfig } from './config.js';
import type { DashboardEvidence } from './persistence/types.js';

export type ChatMessage = {
  role: 'user' | 'model';
  text: string;
};

export const maxMessageLength = 800;

export type Framework = 'riasec' | 'disc' | 'schein';

export type InsightSignal = {
  framework: Framework;
  dimension: string;
  strength: number;
  evidenceQuote: string;
};

export type DashboardProfile = {
  persona: { headline: string; summaries: string[]; quote: string };
  anchor: { primary: string; ability: string[]; motivation: string[]; values: string[] };
  keywords: Array<{ text: string; weight: number }>;
  patterns: Array<{ title: string; evidenceQuote: string }>;
  northStar: {
    primaryAnchor: string;
    tagline: string;
    desires: string[];
    bottomLine: string;
    nextSteps: string[];
  };
};

export type InsightResult = {
  card: {
    title: string;
    happen: string[];
    emotion: string;
    like: string;
    dislike: string;
    value: string;
    quote: string;
  };
  signals: InsightSignal[];
};

export class LlmError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface LlmClient {
  chat(messages: ChatMessage[]): Promise<{ text: string }>;
  insight(messages: ChatMessage[]): Promise<InsightResult>;
  synthesizeDashboard(evidence: DashboardEvidence[]): Promise<DashboardProfile>;
}

export const dimensions: Record<Framework, readonly string[]> = {
  riasec: ['R', 'I', 'A', 'S', 'E', 'C'],
  disc: ['D', 'I', 'S', 'C'],
  schein: [
    'technical',
    'managerial',
    'autonomy',
    'security',
    'entrepreneurial',
    'service',
    'challenge',
    'lifestyle',
  ],
};

const commonChatPrompt = `你是「艾可」，EchoTrail 產品裡的職涯自我覺察教練。請使用繁體中文與台灣用語。你會讀到這次對話的完整逐字記錄。

每輪先判斷情境：悲觀螺旋時先承接情緒並把事實與推論分開；快速正向包裝時溫和指出被跳過的張力；真心樂觀分享時指出使用者具體做對的事，並連結到累積的自我認識；無法判斷時採中性策略。

一般回覆依序完成三件事：
1. 根據使用者剛才提供的具體細節，替感受命名並指出來源。
2. 只指出一個具體矛盾、外部訊號與內在判斷的落差、重複模式或洞見。
3. 只問一個具體、可回答的問題，協助釐清事件、情緒、在意／擅長、討厭／不適合與價值主張。

不要用「聽到你說……」、「你提到……」或類似的固定句型複述使用者的話。優先直接回應其意思；只有在某個關鍵詞有助於精準觀察時，才可引用最短必要片段，不得重複整句或大段改寫。

不得捏造使用者沒說過的內容。事件、情緒與引證原話必須來自 user 的實際文字；喜歡／在意／適合／擅長與討厭／不適合／不在意／不擅長可以根據事件與情緒合理推論。內容不足時寧可保守或留待追問。

若事件、情緒、正向傾向、反向傾向、價值主張與可引用原話都已有足夠內容，在回覆最後自然邀請：「這幾層感受你想先整理起來看看嗎？如果差不多了，可以點下方的 Generate Insight。」未具備時不得主動提及產卡。

若出現自傷、輕生意念或極端負面語句，立即中止一般分析與產卡邀請，先確認當下安全、鼓勵聯絡可信任的人與專業協助；在台灣可提供衛福部 1925 安心專線（24 小時）、生命線 1995、張老師 1980，若有立即危險則請撥 119／110 或前往最近急診。`;

const firstChatPrompt = `${commonChatPrompt}

目前是第 1 輪。只有這一輪可以使用「嗨，我是艾可。」，且最多一次。回覆必須是自然語言，不得使用條列。保持陪伴感，不要像問卷。`;

const earlyChatPrompt = `${commonChatPrompt}

目前是第 2～10 輪。不得再自我介紹，也不得使用「嗨，我是艾可。」。回覆必須是自然語言，不得使用條列。保持陪伴感，在自然節奏中逐步補齊資訊，不要像問卷。`;

const lateChatPrompt = `${commonChatPrompt}

目前是第 11～15 輪。不得再自我介紹，也不得使用「嗨，我是艾可。」。語氣仍親切，但要更積極收斂。如果仍缺少產卡所需內容，可以用簡短條列直接指出缺少的面向並提問；若資料已足夠，要積極邀請使用者點 Generate Insight。不得繼續無限開放式探索。`;

const insightPrompt = `你是 EchoTrail 的結構化洞察引擎。只根據 user 訊息生成 JSON，不得把 model 的推論當成使用者原話。

card 規則：
- title：具體事件標題，最多 18 個中文字。
- happen：1 到 4 條客觀事件摘要，每條一句。
- emotion：只整理與事件相關的情緒。
- like：以「我喜歡／我在意／我適合／我擅長」其中一種開頭。
- dislike：以「我討厭／我不適合／我不在意／我不擅長」其中一種開頭，且不能只是 like 的反義句。
- value：第一人稱價值主張。
- quote：必須逐字複製某一則 user 訊息中的連續片段，且至少 4 個文字或數字，空白與符號不計。

signals 規則：
- 只產生有逐字證據的訊號；不要求每個框架或維度都有資料。
- framework=riasec 時 dimension 只能是 R/I/A/S/E/C。
- framework=disc 時 dimension 只能是 D/I/S/C。
- framework=schein 時 dimension 只能是 technical/managerial/autonomy/security/entrepreneurial/service/challenge/lifestyle。
- strength 為 1 到 10 的整數。
- evidenceQuote 必須逐字複製某一則 user 訊息中的連續片段，且至少 4 個文字或數字，空白與符號不計。

輸出格式：{"card":{"title":"","happen":[""],"emotion":"","like":"","dislike":"","value":"","quote":""},"signals":[{"framework":"riasec","dimension":"I","strength":8,"evidenceQuote":""}]}`;

const dashboardLimits = {
  textListMinimum: 1,
  textListMaximum: 3,
  keywordsMinimum: 1,
  keywordsMaximum: 12,
  keywordWeightMinimum: 1,
  keywordWeightMaximum: 5,
  patternsMinimum: 1,
  patternsMaximum: 5,
} as const;

const dashboardPrompt = `你是 EchoTrail 的整體職涯洞察引擎。輸入包含使用者全部已確認事件，以及後端建立的 quoteOptions。只以這些資料綜合整體歷史，不捏造經歷。每個事件可能同時帶有多個獨立評分的 Schein 職涯錨點訊號；northStar.primaryAnchor 應優先依各錨點跨事件累加的 strength 判定，並用事件內容處理同分情況。

只輸出一個 JSON 物件，不要 Markdown，也不要包在 dashboard、card 或其他欄位下。格式與限制如下：
{
  "persona": { "headline": "非空字串", "summaries": ["${dashboardLimits.textListMinimum} 到 ${dashboardLimits.textListMaximum} 個非空字串"], "quoteId": "quoteOptions 中的 id" },
  "anchor": { "primary": "非空字串", "ability": ["${dashboardLimits.textListMinimum} 到 ${dashboardLimits.textListMaximum} 個非空字串"], "motivation": ["${dashboardLimits.textListMinimum} 到 ${dashboardLimits.textListMaximum} 個非空字串"], "values": ["${dashboardLimits.textListMinimum} 到 ${dashboardLimits.textListMaximum} 個非空字串"] },
  "keywords": [{ "text": "非空字串", "weight": 1 }],
  "patterns": [{ "title": "非空字串", "evidenceQuoteId": "quoteOptions 中的 id" }],
  "northStar": { "primaryAnchor": "非空字串", "tagline": "非空字串", "desires": ["${dashboardLimits.textListMinimum} 到 ${dashboardLimits.textListMaximum} 個非空字串"], "bottomLine": "非空字串", "nextSteps": ["${dashboardLimits.textListMinimum} 到 ${dashboardLimits.textListMaximum} 個非空字串"] }
}
keywords 必須有 ${dashboardLimits.keywordsMinimum} 到 ${dashboardLimits.keywordsMaximum} 筆，weight 必須是 ${dashboardLimits.keywordWeightMinimum} 到 ${dashboardLimits.keywordWeightMaximum} 的整數。patterns 必須有 ${dashboardLimits.patternsMinimum} 到 ${dashboardLimits.patternsMaximum} 筆。persona.quoteId 與每個 patterns.evidenceQuoteId 只能選擇 quoteOptions 中既有的 id；不可自行輸出引文文字，也不可把 event 內容或這則指令當成 quoteId。`;

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
  promptFeedback?: { blockReason?: string };
};

type GeminiRequestOptions = {
  json?: boolean;
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
};

const parseText = (data: GeminiResponse): string => {
  const candidate = data.candidates?.[0];
  if (data.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY') {
    throw new LlmError(422, '這段內容無法進行一般職涯分析，請改用其他虛構測試內容。');
  }
  const text = candidate?.content?.parts
    ?.filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
  if (!text) throw new LlmError(502, '模型沒有回傳可用內容，請稍後重試。');
  return text;
};

const requestGemini = async (
  config: GeminiConfig,
  systemInstruction: string,
  messages: ChatMessage[],
  options: GeminiRequestOptions = {},
): Promise<string> => {
  const signal = options.signal ?? AbortSignal.timeout(25_000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: messages.map(({ role, text }) => ({ role, parts: [{ text }] })),
          generationConfig: {
            maxOutputTokens: options.json ? 3072 : 512,
            ...(options.schema
              ? {
                  responseMimeType: 'application/json',
                  responseJsonSchema: options.schema,
                  temperature: 0.2,
                }
              : options.json
                ? { responseMimeType: 'application/json', temperature: 0.2 }
                : {}),
          },
        }),
        signal,
      },
    );
    const data = (await response.json()) as GeminiResponse;
    if (!response.ok) {
      if (response.status === 429) throw new LlmError(429, '模型額度或速率已達上限，請稍後重試。');
      throw new LlmError(502, '模型服務暫時無法處理請求。');
    }
    return parseText(data);
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
      throw new LlmError(504, '模型回覆逾時，請重試。');
    }
    throw new LlmError(502, '暫時無法連線模型服務。');
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const parseMessages = (body: unknown, requireUserEnding = true): ChatMessage[] => {
  if (!isRecord(body) || !Array.isArray(body.messages)) throw new LlmError(400, '對話格式錯誤。');
  const messages = body.messages.map((item, index): ChatMessage => {
    if (
      !isRecord(item) ||
      item.role !== (index % 2 === 0 ? 'user' : 'model') ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      item.text.length > maxMessageLength
    ) {
      throw new LlmError(400, '對話內容或順序錯誤。');
    }
    return { role: item.role, text: item.text.trim() } as ChatMessage;
  });
  if (
    messages.length === 0 ||
    messages.length > 31 ||
    (requireUserEnding && messages.length % 2 !== 1) ||
    messages.reduce((sum, message) => sum + message.text.length, 0) > 16_000
  ) {
    throw new LlmError(400, '此對話已達長度限制，請開始新對話。');
  }
  return messages;
};

const normalizedQuote = (quote: string): string => quote.trim();
const isLongEnoughQuote = (quote: string): boolean =>
  (normalizedQuote(quote).match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 4;
const quotedByUser = (quote: string, messages: ChatMessage[]): boolean => {
  const normalized = normalizedQuote(quote);
  return (
    isLongEnoughQuote(normalized) &&
    messages.some((message) => message.role === 'user' && message.text.includes(normalized))
  );
};

const isTextArray = (
  value: unknown,
  minimum = dashboardLimits.textListMinimum,
  maximum = dashboardLimits.textListMaximum,
): value is string[] =>
  Array.isArray(value) &&
  value.length >= minimum &&
  value.length <= maximum &&
  value.every((item) => typeof item === 'string' && item.trim());

const dashboardFields = ['persona', 'anchor', 'keywords', 'patterns', 'northStar'] as const;
type DashboardQuoteOption = { id: string; text: string };

const dashboardQuoteOptions = (evidence: DashboardEvidence[]): DashboardQuoteOption[] => {
  const texts = new Set<string>();
  for (const event of evidence) {
    const cardQuoteAllowed = event.quoteSource === 'user_edit' || event.messages.some((message) =>
      message.role === 'user' && message.text.includes(event.card.quote));
    if (cardQuoteAllowed && event.card.quote.trim()) texts.add(event.card.quote);
    for (const signal of event.signals) {
      if (event.messages.some((message) => message.role === 'user' && message.text.includes(signal.evidenceQuote))) {
        texts.add(signal.evidenceQuote);
      }
    }
    for (const message of event.messages) {
      if (message.role === 'user' && message.text.trim()) texts.add(message.text);
    }
  }
  return Array.from(texts, (text, index) => ({ id: `q${index + 1}`, text }));
};

const dashboardRequestPayload = (evidence: DashboardEvidence[], quoteOptions: DashboardQuoteOption[]): unknown => ({
  events: evidence.map((event) => ({
    eventId: event.eventId,
    title: event.title,
    card: {
      happen: event.card.happen,
      emotion: event.card.emotion,
      like: event.card.like,
      dislike: event.card.dislike,
      value: event.card.value,
    },
    userMessages: event.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.text),
    signals: event.signals,
  })),
  quoteOptions,
});

const dashboardResponseSchema = (quoteOptions: DashboardQuoteOption[]): Record<string, unknown> => {
  const textList = {
    type: 'array',
    items: { type: 'string' },
    minItems: dashboardLimits.textListMinimum,
    maxItems: dashboardLimits.textListMaximum,
  };
  const quoteId = { type: 'string', enum: quoteOptions.map((option) => option.id) };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      persona: {
        type: 'object',
        additionalProperties: false,
        properties: {
          headline: { type: 'string' },
          summaries: textList,
          quoteId,
        },
        required: ['headline', 'summaries', 'quoteId'],
      },
      anchor: {
        type: 'object',
        additionalProperties: false,
        properties: {
          primary: { type: 'string' },
          ability: textList,
          motivation: textList,
          values: textList,
        },
        required: ['primary', 'ability', 'motivation', 'values'],
      },
      keywords: {
        type: 'array',
        minItems: dashboardLimits.keywordsMinimum,
        maxItems: dashboardLimits.keywordsMaximum,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            weight: {
              type: 'integer',
              minimum: dashboardLimits.keywordWeightMinimum,
              maximum: dashboardLimits.keywordWeightMaximum,
            },
          },
          required: ['text', 'weight'],
        },
      },
      patterns: {
        type: 'array',
        minItems: dashboardLimits.patternsMinimum,
        maxItems: dashboardLimits.patternsMaximum,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            evidenceQuoteId: quoteId,
          },
          required: ['title', 'evidenceQuoteId'],
        },
      },
      northStar: {
        type: 'object',
        additionalProperties: false,
        properties: {
          primaryAnchor: { type: 'string' },
          tagline: { type: 'string' },
          desires: textList,
          bottomLine: { type: 'string' },
          nextSteps: textList,
        },
        required: ['primaryAnchor', 'tagline', 'desires', 'bottomLine', 'nextSteps'],
      },
    },
    required: ['persona', 'anchor', 'keywords', 'patterns', 'northStar'],
  };
};

const fieldType = (value: unknown): string =>
  value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

const dashboardResponseShape = (raw: string): Record<string, unknown> => {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '')); }
  catch { return { json: 'invalid' }; }
  const root = isRecord(parsed) ? parsed : {};
  const wrapped = isRecord(root.dashboard) ? root.dashboard : {};
  const types = (value: Record<string, unknown>) =>
    Object.fromEntries(dashboardFields.map((field) => [field, fieldType(value[field])]));
  return { root: types(root), dashboard: fieldType(root.dashboard), wrapped: types(wrapped) };
};

export function parseDashboardProfile(raw: string, evidence: DashboardEvidence[]): DashboardProfile {
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '')); }
  catch { throw new LlmError(502, 'Dashboard 模型產出不是有效 JSON。'); }
  if (isRecord(value)) {
    const root = value;
    if (isRecord(root.dashboard) && dashboardFields.every((field) => !(field in root))) value = root.dashboard;
  }
  if (!isRecord(value) || !isRecord(value.persona) || !isRecord(value.anchor) || !isRecord(value.northStar) ||
    !Array.isArray(value.keywords) || !Array.isArray(value.patterns)) throw new LlmError(502, 'Dashboard 模型產出缺少欄位。');
  const quoted = (quote: unknown): boolean => typeof quote === 'string' && !!quote && evidence.some((event) =>
    event.messages.some((message) => message.role === 'user' && message.text.includes(quote)) ||
    (event.quoteSource === 'user_edit' && event.card.quote.includes(quote)));
  const persona = value.persona;
  const anchor = value.anchor;
  const northStar = value.northStar;
  const requireText = (value: unknown, path: string): void => {
    if (typeof value !== 'string' || !value.trim()) throw new LlmError(502, `${path} 必須是非空字串。`);
  };
  const requireTexts = (value: unknown, path: string): void => {
    if (!isTextArray(value)) {
      throw new LlmError(
        502,
        `${path} 必須包含 ${dashboardLimits.textListMinimum} 到 ${dashboardLimits.textListMaximum} 個非空字串。`,
      );
    }
  };
  requireText(persona.headline, 'persona.headline');
  requireTexts(persona.summaries, 'persona.summaries');
  if (!quoted(persona.quote)) throw new LlmError(502, 'persona.quote 必須逐字複製允許的使用者原文。');
  requireText(anchor.primary, 'anchor.primary');
  requireTexts(anchor.ability, 'anchor.ability');
  requireTexts(anchor.motivation, 'anchor.motivation');
  requireTexts(anchor.values, 'anchor.values');
  if (value.keywords.length < dashboardLimits.keywordsMinimum || value.keywords.length > dashboardLimits.keywordsMaximum) {
    throw new LlmError(
      502,
      `keywords 必須包含 ${dashboardLimits.keywordsMinimum} 到 ${dashboardLimits.keywordsMaximum} 筆。`,
    );
  }
  value.keywords.forEach((item, index) => {
    if (!isRecord(item)) throw new LlmError(502, `keywords[${index}] 必須是物件。`);
    requireText(item.text, `keywords[${index}].text`);
    if (!Number.isInteger(item.weight) ||
      (item.weight as number) < dashboardLimits.keywordWeightMinimum ||
      (item.weight as number) > dashboardLimits.keywordWeightMaximum) {
      throw new LlmError(
        502,
        `keywords[${index}].weight 必須是 ${dashboardLimits.keywordWeightMinimum} 到 ${dashboardLimits.keywordWeightMaximum} 的整數。`,
      );
    }
  });
  if (value.patterns.length < dashboardLimits.patternsMinimum || value.patterns.length > dashboardLimits.patternsMaximum) {
    throw new LlmError(
      502,
      `patterns 必須包含 ${dashboardLimits.patternsMinimum} 到 ${dashboardLimits.patternsMaximum} 筆。`,
    );
  }
  value.patterns.forEach((item, index) => {
    if (!isRecord(item)) throw new LlmError(502, `patterns[${index}] 必須是物件。`);
    requireText(item.title, `patterns[${index}].title`);
    if (!quoted(item.evidenceQuote)) {
      throw new LlmError(502, `patterns[${index}].evidenceQuote 必須逐字複製允許的使用者原文。`);
    }
  });
  requireText(northStar.primaryAnchor, 'northStar.primaryAnchor');
  requireText(northStar.tagline, 'northStar.tagline');
  requireTexts(northStar.desires, 'northStar.desires');
  requireText(northStar.bottomLine, 'northStar.bottomLine');
  requireTexts(northStar.nextSteps, 'northStar.nextSteps');
  return value as DashboardProfile;
}

const parseDashboardModelProfile = (
  raw: string,
  evidence: DashboardEvidence[],
  quoteOptions: DashboardQuoteOption[],
): DashboardProfile => {
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '')); }
  catch { throw new LlmError(502, 'Dashboard 模型產出不是有效 JSON。'); }
  if (isRecord(value)) {
    const root = value;
    if (isRecord(root.dashboard) && dashboardFields.every((field) => !(field in root))) value = root.dashboard;
  }
  if (!isRecord(value) || !isRecord(value.persona) || !Array.isArray(value.patterns)) {
    throw new LlmError(502, 'Dashboard 模型產出缺少欄位。');
  }
  const quotes = new Map(quoteOptions.map((option) => [option.id, option.text]));
  const quoteFor = (id: unknown, path: string): string => {
    if (typeof id !== 'string' || !quotes.has(id)) {
      throw new LlmError(502, `${path} 必須引用 quoteOptions 中既有的 id。`);
    }
    return quotes.get(id)!;
  };
  const capped = (items: unknown, maximum: number): unknown =>
    Array.isArray(items) ? items.slice(0, maximum) : items;
  const anchor = isRecord(value.anchor)
    ? {
        ...value.anchor,
        ability: capped(value.anchor.ability, dashboardLimits.textListMaximum),
        motivation: capped(value.anchor.motivation, dashboardLimits.textListMaximum),
        values: capped(value.anchor.values, dashboardLimits.textListMaximum),
      }
    : value.anchor;
  const northStar = isRecord(value.northStar)
    ? {
        ...value.northStar,
        desires: capped(value.northStar.desires, dashboardLimits.textListMaximum),
        nextSteps: capped(value.northStar.nextSteps, dashboardLimits.textListMaximum),
      }
    : value.northStar;
  const profile = {
    persona: {
      headline: value.persona.headline,
      summaries: capped(value.persona.summaries, dashboardLimits.textListMaximum),
      quote: quoteFor(value.persona.quoteId, 'persona.quoteId'),
    },
    anchor,
    keywords: capped(value.keywords, dashboardLimits.keywordsMaximum),
    patterns: value.patterns.slice(0, dashboardLimits.patternsMaximum).map((pattern, index) => {
      if (!isRecord(pattern)) throw new LlmError(502, `patterns[${index}] 必須是物件。`);
      return {
        title: pattern.title,
        evidenceQuote: quoteFor(pattern.evidenceQuoteId, `patterns[${index}].evidenceQuoteId`),
      };
    }),
    northStar,
  };
  return parseDashboardProfile(JSON.stringify(profile), evidence);
};

export const parseInsight = (raw: string, messages: ChatMessage[]): InsightResult => {
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''));
  } catch {
    throw new LlmError(502, '模型產出不是有效 JSON。');
  }
  if (
    !isRecord(value) ||
    !isRecord(value.card) ||
    !Array.isArray(value.signals)
  ) {
    throw new LlmError(502, '模型產出缺少必要欄位。');
  }
  const card = value.card;
  const textFields = ['title', 'emotion', 'like', 'dislike', 'value', 'quote'] as const;
  if (
    textFields.some((field) => typeof card[field] !== 'string' || !card[field].trim()) ||
    !Array.isArray(card.happen) ||
    card.happen.length === 0 ||
    card.happen.length > 4 ||
    card.happen.some((item) => typeof item !== 'string' || !item.trim()) ||
    typeof card.quote !== 'string' ||
    !quotedByUser(card.quote, messages)
  ) {
    throw new LlmError(502, '模型產出的卡片未通過 grounding 驗證。');
  }
  const signals = value.signals.map((item, index): InsightSignal => {
    if (
      !isRecord(item) ||
      !['riasec', 'disc', 'schein'].includes(String(item.framework)) ||
      typeof item.dimension !== 'string' ||
      typeof item.strength !== 'number' ||
      !Number.isInteger(item.strength) ||
      item.strength < 1 ||
      item.strength > 10 ||
      typeof item.evidenceQuote !== 'string'
    ) {
      throw new LlmError(502, `signals[${index}] 的欄位格式錯誤。`);
    }
    const framework = item.framework as Framework;
    if (!dimensions[framework].includes(item.dimension)) {
      throw new LlmError(
        502,
        `signals[${index}].dimension 必須是 ${framework} 的允許代碼：${dimensions[framework].join('、')}。`,
      );
    }
    if (!quotedByUser(item.evidenceQuote, messages)) {
      throw new LlmError(
        502,
        `signals[${index}].evidenceQuote 必須逐字複製一則 user 訊息中至少 4 個文字或數字的連續片段。`,
      );
    }
    return {
      framework,
      dimension: item.dimension,
      strength: item.strength,
      evidenceQuote: item.evidenceQuote,
    };
  });
  const signalKeys = signals.map((signal) => `${signal.framework}:${signal.dimension}`);
  if (new Set(signalKeys).size !== signalKeys.length) {
    throw new LlmError(502, '同一事件的圖表訊號維度不可重複。');
  }
  return {
    card: {
      title: String(card.title).trim(),
      happen: (card.happen as string[]).map((item) => item.trim()),
      emotion: String(card.emotion).trim(),
      like: String(card.like).trim(),
      dislike: String(card.dislike).trim(),
      value: String(card.value).trim(),
      quote: String(card.quote).trim(),
    },
    signals,
  };
};

export class GeminiClient implements LlmClient {
  constructor(private readonly config = resolveGeminiConfig()) {}

  async chat(messages: ChatMessage[]): Promise<{ text: string }> {
    const userTurns = messages.filter((message) => message.role === 'user').length;
    const prompt = userTurns <= 1 ? firstChatPrompt : userTurns <= 10 ? earlyChatPrompt : lateChatPrompt;
    return { text: await requestGemini(this.config, prompt, messages) };
  }

  async insight(messages: ChatMessage[]): Promise<InsightResult> {
    const requestMessages: ChatMessage[] = [
      ...messages,
      ...(messages.at(-1)?.role === 'model'
        ? [{ role: 'user' as const, text: '請根據以上逐字稿產生結構化洞察 JSON。這句系統觸發文字不可作為證據。' }]
        : []),
    ];
    let retryMessages = requestMessages;
    let raw = await requestGemini(this.config, insightPrompt, retryMessages, { json: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return parseInsight(raw, messages);
      } catch (caught) {
        if (!(caught instanceof LlmError) || caught.statusCode !== 502 || attempt === 2) {
          throw caught;
        }
        const correction = [
          '上一個 JSON 未通過後端驗證，錯誤類型如下：',
          caught.message,
          '只修正 JSON，不要解釋。quote 與每個 evidenceQuote 必須從最初 user 逐字稿完整複製連續片段，不可改寫、加省略號或替換標點。',
          '這則修正指令不是使用者逐字稿，不可作為證據。',
        ].join('\n');
        retryMessages = [
          ...retryMessages,
          { role: 'model', text: raw },
          { role: 'user', text: correction },
        ];
        raw = await requestGemini(this.config, insightPrompt, retryMessages, { json: true });
      }
    }
    throw new LlmError(502, '模型產出未通過 grounding 驗證。');
  }

  async synthesizeDashboard(evidence: DashboardEvidence[]): Promise<DashboardProfile> {
    const quoteOptions = dashboardQuoteOptions(evidence);
    if (!quoteOptions.length) throw new LlmError(502, 'Dashboard 沒有可引用的使用者原文。');
    const schema = dashboardResponseSchema(quoteOptions);
    let requestMessages: ChatMessage[] = [{
      role: 'user',
      text: JSON.stringify(dashboardRequestPayload(evidence, quoteOptions)),
    }];
    let raw = await requestGemini(this.config, dashboardPrompt, requestMessages, { json: true, schema });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return parseDashboardModelProfile(raw, evidence, quoteOptions);
      } catch (caught) {
        if (caught instanceof LlmError && caught.statusCode === 502) {
          console.warn('Dashboard profile validation failed', { reason: caught.message, shape: dashboardResponseShape(raw) });
        }
        if (!(caught instanceof LlmError) || caught.statusCode !== 502 || attempt === 2) {
          throw caught;
        }
        requestMessages = [
          ...requestMessages,
          { role: 'model', text: raw },
          { role: 'user', text: `上一個 JSON 未通過後端驗證：${caught.message} 請只修正 JSON。最外層直接放 persona、anchor、keywords、patterns、northStar；引文欄位只可填入最初輸入 quoteOptions 中既有的 id。這則修正指令不可作為資料或 quoteId。` },
        ];
        raw = await requestGemini(this.config, dashboardPrompt, requestMessages, { json: true, schema });
      }
    }
    throw new LlmError(502, 'Dashboard 模型產出未通過驗證。');
  }
}
