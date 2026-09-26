import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InputError, parseEvent } from '../src/persistence/validate.js';

const validEvent = () => ({
  userId: randomUUID(),
  clientEventId: randomUUID(),
  conversationId: randomUUID(),
  messages: [
    { role: 'user', text: '我很有成就感，也喜歡釐清問題。' },
    { role: 'model', text: '你最在意哪個部分？' },
  ],
  card: {
    title: '理解問題',
    happen: ['完成訪談'],
    emotion: '有成就感',
    like: '我喜歡釐清問題',
    dislike: '我討厭盲目執行',
    value: '先理解再行動',
    quote: '我很有成就感',
  },
  editedFields: [],
  signals: [
    {
      framework: 'riasec',
      dimension: 'I',
      strength: 8,
      evidenceQuote: '喜歡釐清問題',
    },
  ],
});

describe('event persistence validation', () => {
  it('accepts and preserves UUID event identity fields', () => {
    const input = validEvent();

    expect(parseEvent(input)).toMatchObject({
      userId: input.userId,
      clientEventId: input.clientEventId,
      conversationId: input.conversationId,
    });
  });

  it('rejects the former sequential numeric client event ID contract', () => {
    expect(() => parseEvent({ ...validEvent(), clientEventId: 1 })).toThrow(InputError);
  });
});
