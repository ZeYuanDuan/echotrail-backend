import { LlmError, dimensions, parseMessages, type InsightSignal } from '../llm.js';
import type { ConfirmEventInput, EditedField } from './types.js';

export class InputError extends Error { constructor(message: string, public readonly statusCode = 400) { super(message); } }
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function requireUuid(value: unknown): string {
  if (!isUuid(value)) throw new InputError('UUID 格式錯誤。');
  return value;
}
export function parseName(body: unknown): { display: string; normalized: string } {
  const value = isRecord(body) ? body.name : undefined;
  if (typeof value !== 'string') throw new InputError('請輸入 1 到 80 字的名稱。');
  const display = value.trim();
  const normalized = display.normalize('NFKC').toLowerCase();
  if (!normalized || normalized.length > 80) throw new InputError('請輸入 1 到 80 字的名稱。');
  return { display, normalized };
}
const fields: EditedField[] = ['title', 'happen', 'emotion', 'like', 'dislike', 'value', 'quote'];
function text(value: unknown, maximum = 2000): value is string { return typeof value === 'string' && !!value.trim() && value.length <= maximum; }
export function parseEvent(body: unknown): ConfirmEventInput {
  if (!isRecord(body)) throw new InputError('事件格式錯誤。');
  const userId = requireUuid(body.userId);
  const clientEventId = requireUuid(body.clientEventId);
  const conversationId = requireUuid(body.conversationId);
  let messages;
  try { messages = parseMessages({ messages: body.messages }, false); }
  catch (error) { if (error instanceof LlmError) throw new InputError(error.message); throw error; }
  if (messages.at(-1)?.role !== 'model') throw new InputError('請先完成本次對話。');
  const card = body.card;
  if (!isRecord(card) || !fields.filter((field) => field !== 'happen').every((field) => text(card[field], field === 'title' ? 80 : 2000)) ||
    !Array.isArray(card.happen) || card.happen.length < 1 || card.happen.length > 4 || !card.happen.every((item) => text(item))) {
    throw new InputError('卡片欄位格式錯誤。');
  }
  if (!Array.isArray(body.editedFields) || !body.editedFields.every((field) => fields.includes(field)) || new Set(body.editedFields).size !== body.editedFields.length) {
    throw new InputError('編輯欄位格式錯誤。');
  }
  const userText = messages.filter((message) => message.role === 'user').map((message) => message.text);
  const grounded = (quote: string) => userText.some((item) => item.includes(quote));
  if (!body.editedFields.includes('quote') && !grounded(card.quote as string)) throw new InputError('卡片引用不在本次使用者原文中。');
  if (!Array.isArray(body.signals) || body.signals.length > 100) throw new InputError('訊號格式錯誤。');
  const signals = body.signals.map((item): InsightSignal => {
    if (!isRecord(item) || !['riasec', 'disc', 'schein'].includes(String(item.framework)) || typeof item.dimension !== 'string' ||
      !dimensions[item.framework as keyof typeof dimensions].includes(item.dimension) || !Number.isInteger(item.strength) ||
      (item.strength as number) < 1 || (item.strength as number) > 10 || !text(item.evidenceQuote) || !grounded(item.evidenceQuote)) {
      throw new InputError('訊號缺少本次使用者原文證據。');
    }
    return { framework: item.framework as InsightSignal['framework'], dimension: item.dimension, strength: item.strength as number, evidenceQuote: item.evidenceQuote as string };
  });
  return { userId, clientEventId, conversationId, messages, card: {
    title: (card.title as string).trim(), happen: (card.happen as string[]).map((item) => item.trim()), emotion: (card.emotion as string).trim(),
    like: (card.like as string).trim(), dislike: (card.dislike as string).trim(), value: (card.value as string).trim(), quote: (card.quote as string).trim(),
  }, editedFields: body.editedFields as EditedField[], signals };
}
