import { resolveGeminiConfig, type GeminiConfig } from './config.js';
import type { DashboardEvidence } from './persistence/types.js';

export type ChatMessage = {
  role: 'user' | 'model';
  text: string;
};

export type Framework = 'riasec' | 'disc' | 'schein';

export type InsightSignal = {
  framework: Framework;
  dimension: string;
  strength: number;
  evidenceQuote: string;
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
  dashboard: {
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
  synthesizeDashboard(evidence: DashboardEvidence[]): Promise<InsightResult['dashboard']>;
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

const chatPrompt = `你是「艾可」，EchoTrail 產品裡的職涯自我覺察教練。請使用繁體中文與台灣用語。

每次回覆都用自然語言完成三件事，不要使用條列：
1. 直接引用使用者剛才的具體字句，替感受命名並指出來源。
2. 只指出一個具體矛盾、外部訊號與內在判斷的落差、重複模式或洞見。
3. 只問一個具體、可回答的問題，依序協助釐清事件、情緒、在意的點與不能接受的點。

不得捏造使用者沒說過的話。真心樂觀分享時，萃取做對的判斷，不要硬找問題；悲觀螺旋時，把事實與推論分開；快速正向包裝時，溫和指出被略過的張力。不要聲稱已產生卡片或更新儀表板。若出現自傷或極端負面語句，中止一般分析，改為關懷並建議尋求在地緊急或專業協助。`;

const insightPrompt = `你是 EchoTrail 的結構化洞察引擎。只根據 user 訊息生成 JSON，不得把 model 的推論當成使用者原話。

card 規則：
- title：具體事件標題，最多 18 個中文字。
- happen：1 到 4 條客觀事件摘要，每條一句。
- emotion：只整理與事件相關的情緒。
- like：以「我喜歡／我在意／我適合／我擅長」其中一種開頭。
- dislike：以「我討厭／我不適合／我不在意／我不擅長」其中一種開頭，且不能只是 like 的反義句。
- value：第一人稱價值主張。
- quote：必須逐字複製某一則 user 訊息中的連續片段。

signals 規則：
- 只產生有逐字證據的訊號；不要求每個框架或維度都有資料。
- framework=riasec 時 dimension 只能是 R/I/A/S/E/C。
- framework=disc 時 dimension 只能是 D/I/S/C。
- framework=schein 時 dimension 只能是 technical/managerial/autonomy/security/entrepreneurial/service/challenge/lifestyle。
- strength 為 1 到 10 的整數。
- evidenceQuote 必須逐字複製某一則 user 訊息中的連續片段。

dashboard 規則：
- persona：headline 是一句人物輪廓；summaries 為 1 到 3 個具體特質；quote 必須是 user 原文。
- anchor：primary 是最主要的 Schein 職涯錨點；ability、motivation、values 各列 1 到 3 個短句，分別回答「我擅長什麼」「我想要什麼」「我的標準是什麼」。
- keywords：列出 3 到 8 個對話關鍵詞，weight 為 1 到 5 整數。
- patterns：列出 1 到 3 個可觀察行為模式，每項 evidenceQuote 必須是 user 原文。
- northStar：primaryAnchor、簡短 tagline、1 到 3 個 desires、一句 bottomLine、1 到 3 個 nextSteps。nextSteps 只能是從對話合理推得的發展方向，不可捏造經歷。

輸出格式：{"card":{"title":"","happen":[""],"emotion":"","like":"","dislike":"","value":"","quote":""},"signals":[{"framework":"riasec","dimension":"I","strength":8,"evidenceQuote":""}],"dashboard":{"persona":{"headline":"","summaries":[""],"quote":""},"anchor":{"primary":"","ability":[""],"motivation":[""],"values":[""]},"keywords":[{"text":"","weight":3}],"patterns":[{"title":"","evidenceQuote":""}],"northStar":{"primaryAnchor":"","tagline":"","desires":[""],"bottomLine":"","nextSteps":[""]}}}`;

const dashboardPrompt = `你是 EchoTrail 的整體職涯洞察引擎。輸入是使用者全部已確認事件、卡片、逐字訊息及訊號。只以這些資料綜合整體歷史，不捏造經歷。輸出單一 JSON 物件，最外層必須直接包含 persona、anchor、keywords、patterns、northStar 五個欄位；不要包在 dashboard、card 或其他欄位下。persona 包含 headline、summaries、quote；anchor 包含 primary、ability、motivation、values；keywords 是含 text、weight 的陣列；patterns 是含 title、evidenceQuote 的陣列；northStar 包含 primaryAnchor、tagline、desires、bottomLine、nextSteps。persona.quote 與每個 patterns.evidenceQuote 必須逐字來自 user 訊息，或使用者明確編輯過的卡片 quote。不得使用 model 訊息作為引文。`;

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
  promptFeedback?: { blockReason?: string };
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
  json = false,
): Promise<string> => {
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
            maxOutputTokens: json ? 3072 : 512,
            ...(json ? { responseMimeType: 'application/json', temperature: 0.2 } : {}),
          },
        }),
        signal: AbortSignal.timeout(25_000),
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
    if (error instanceof Error && error.name === 'TimeoutError') {
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
      item.text.length > 2000
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

const quotedByUser = (quote: string, messages: ChatMessage[]): boolean =>
  quote.length > 0 && messages.some((message) => message.role === 'user' && message.text.includes(quote));

const isTextArray = (value: unknown, minimum = 1, maximum = 3): value is string[] =>
  Array.isArray(value) &&
  value.length >= minimum &&
  value.length <= maximum &&
  value.every((item) => typeof item === 'string' && item.trim());

const dashboardFields = ['persona', 'anchor', 'keywords', 'patterns', 'northStar'] as const;
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

export function parseDashboardProfile(raw: string, evidence: DashboardEvidence[]): InsightResult['dashboard'] {
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
  if (typeof persona.headline !== 'string' || !persona.headline.trim() || !isTextArray(persona.summaries) || !quoted(persona.quote) ||
    typeof anchor.primary !== 'string' || !anchor.primary.trim() || !isTextArray(anchor.ability) || !isTextArray(anchor.motivation) || !isTextArray(anchor.values) ||
    value.keywords.length < 1 || value.keywords.length > 12 || !value.keywords.every((item) => isRecord(item) && typeof item.text === 'string' && !!item.text.trim() && Number.isInteger(item.weight) && (item.weight as number) >= 1 && (item.weight as number) <= 5) ||
    value.patterns.length < 1 || value.patterns.length > 5 || !value.patterns.every((item) => isRecord(item) && typeof item.title === 'string' && !!item.title.trim() && quoted(item.evidenceQuote)) ||
    typeof northStar.primaryAnchor !== 'string' || !northStar.primaryAnchor.trim() || typeof northStar.tagline !== 'string' || !northStar.tagline.trim() ||
    !isTextArray(northStar.desires) || typeof northStar.bottomLine !== 'string' || !northStar.bottomLine.trim() || !isTextArray(northStar.nextSteps)) {
    throw new LlmError(502, 'Dashboard 模型產出未通過格式或原文驗證。');
  }
  return value as InsightResult['dashboard'];
}

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
    !Array.isArray(value.signals) ||
    !isRecord(value.dashboard)
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
  const signals = value.signals.map((item): InsightSignal => {
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
      throw new LlmError(502, '模型產出的圖表訊號格式錯誤。');
    }
    const framework = item.framework as Framework;
    if (!dimensions[framework].includes(item.dimension) || !quotedByUser(item.evidenceQuote, messages)) {
      throw new LlmError(502, '模型產出的圖表訊號未通過 grounding 驗證。');
    }
    return {
      framework,
      dimension: item.dimension,
      strength: item.strength,
      evidenceQuote: item.evidenceQuote,
    };
  });
  const dashboard = value.dashboard;
  if (
    !isRecord(dashboard.persona) ||
    typeof dashboard.persona.headline !== 'string' ||
    !isTextArray(dashboard.persona.summaries) ||
    typeof dashboard.persona.quote !== 'string'
  ) {
    throw new LlmError(502, 'Dashboard persona 格式驗證失敗。');
  }
  if (!quotedByUser(dashboard.persona.quote, messages)) {
    throw new LlmError(502, 'Dashboard persona.quote 不是 user 原文的連續片段。');
  }
  if (
    !isRecord(dashboard.anchor) ||
    typeof dashboard.anchor.primary !== 'string' ||
    !isTextArray(dashboard.anchor.ability) ||
    !isTextArray(dashboard.anchor.motivation) ||
    !isTextArray(dashboard.anchor.values)
  ) {
    throw new LlmError(502, 'Dashboard anchor 格式驗證失敗。');
  }
  if (
    !Array.isArray(dashboard.keywords) ||
    dashboard.keywords.length < 3 ||
    dashboard.keywords.length > 8 ||
    !dashboard.keywords.every(
      (keyword) =>
        isRecord(keyword) &&
        typeof keyword.text === 'string' &&
        keyword.text.trim() &&
        typeof keyword.weight === 'number' &&
        Number.isInteger(keyword.weight) &&
        keyword.weight >= 1 &&
        keyword.weight <= 5,
    )
  ) {
    throw new LlmError(502, 'Dashboard keywords 格式驗證失敗。');
  }
  if (
    !Array.isArray(dashboard.patterns) ||
    dashboard.patterns.length < 1 ||
    dashboard.patterns.length > 3 ||
    !dashboard.patterns.every(
      (pattern) =>
        isRecord(pattern) &&
        typeof pattern.title === 'string' &&
        pattern.title.trim() &&
        typeof pattern.evidenceQuote === 'string',
    )
  ) {
    throw new LlmError(502, 'Dashboard patterns 格式驗證失敗。');
  }
  if (
    !dashboard.patterns.every((pattern) =>
      quotedByUser((pattern as { evidenceQuote: string }).evidenceQuote, messages),
    )
  ) {
    throw new LlmError(502, 'Dashboard patterns.evidenceQuote 不是 user 原文的連續片段。');
  }
  if (
    !isRecord(dashboard.northStar) ||
    typeof dashboard.northStar.primaryAnchor !== 'string' ||
    typeof dashboard.northStar.tagline !== 'string' ||
    !isTextArray(dashboard.northStar.desires) ||
    typeof dashboard.northStar.bottomLine !== 'string' ||
    !isTextArray(dashboard.northStar.nextSteps)
  ) {
    throw new LlmError(502, 'Dashboard northStar 格式驗證失敗。');
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
    dashboard: dashboard as InsightResult['dashboard'],
  };
};

export class GeminiClient implements LlmClient {
  constructor(private readonly config = resolveGeminiConfig()) {}

  async chat(messages: ChatMessage[]): Promise<{ text: string }> {
    return { text: await requestGemini(this.config, chatPrompt, messages) };
  }

  async insight(messages: ChatMessage[]): Promise<InsightResult> {
    const requestMessages: ChatMessage[] = [
      ...messages,
      ...(messages.at(-1)?.role === 'model'
        ? [{ role: 'user' as const, text: '請根據以上逐字稿產生結構化洞察 JSON。這句系統觸發文字不可作為證據。' }]
        : []),
    ];
    let retryMessages = requestMessages;
    let raw = await requestGemini(this.config, insightPrompt, retryMessages, true);
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
        raw = await requestGemini(this.config, insightPrompt, retryMessages, true);
      }
    }
    throw new LlmError(502, '模型產出未通過 grounding 驗證。');
  }

  async synthesizeDashboard(evidence: DashboardEvidence[]): Promise<InsightResult['dashboard']> {
    let requestMessages: ChatMessage[] = [{ role: 'user', text: JSON.stringify(evidence) }];
    let raw = await requestGemini(this.config, dashboardPrompt, requestMessages, true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return parseDashboardProfile(raw, evidence);
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
          { role: 'user', text: `上一個 JSON 未通過後端驗證：${caught.message} 請只修正 JSON。最外層直接放 persona、anchor、keywords、patterns、northStar；引文只可逐字複製最初 user 訊息或使用者編輯的卡片 quote。這則修正指令不可作為證據。` },
        ];
        raw = await requestGemini(this.config, dashboardPrompt, requestMessages, true);
      }
    }
    throw new LlmError(502, 'Dashboard 模型產出未通過驗證。');
  }
}
