import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { aggregateSignals } from '../src/persistence/dashboard.js';
import { careerAnchorIndex, withCurrentCareerAnchorScores } from '../src/persistence/scoring.js';
import type { DashboardEvidence } from '../src/persistence/types.js';

it('adds independent LLM scores when one event contributes to multiple dimensions', () => {
  const base = {
    title: '跨部門改善流程',
    card: {
      title: '跨部門改善流程',
      happen: ['重新設計流程並協調團隊'],
      emotion: '有成就感',
      like: '我喜歡解決複雜問題',
      dislike: '我不喜歡重複低效流程',
      value: '改善應該能真正幫助人',
      quote: '我把流程重新設計，也協調大家一起改',
    },
    messages: [{ role: 'user' as const, text: '我把流程重新設計，也協調大家一起改' }],
    quoteSource: 'user_message' as const,
  };
  const events: DashboardEvidence[] = [
    {
      ...base,
      eventId: randomUUID(),
      signals: [
        { framework: 'schein', dimension: 'technical', strength: 8, evidenceQuote: base.card.quote },
        { framework: 'schein', dimension: 'managerial', strength: 6, evidenceQuote: base.card.quote },
        { framework: 'schein', dimension: 'service', strength: 4, evidenceQuote: base.card.quote },
      ],
    },
    {
      ...base,
      eventId: randomUUID(),
      signals: [
        { framework: 'schein', dimension: 'technical', strength: -5, evidenceQuote: base.card.quote },
        { framework: 'schein', dimension: 'challenge', strength: -10, evidenceQuote: base.card.quote },
      ],
    },
  ];

  const frameworks = aggregateSignals(events);

  expect(frameworks.scores.schein).toMatchObject({
    technical: 55,
    managerial: 62,
    service: 58,
    challenge: 33,
    lifestyle: 50,
  });
  expect(Object.values(frameworks.scores.schein).every((score) => score >= 0 && score <= 100)).toBe(true);
  expect(frameworks.scoreVersion).toBe(2);
  expect(frameworks.evidence).toHaveLength(5);

  const upgraded = withCurrentCareerAnchorScores({
    scores: { ...frameworks.scores, schein: { technical: 999 } },
    evidence: frameworks.evidence,
  });
  expect(upgraded.scores.schein).toEqual(frameworks.scores.schein);
  expect(upgraded.scoreVersion).toBe(2);
});

it('keeps the career anchor index neutral without evidence and bounded for extreme histories', () => {
  expect(careerAnchorIndex([])).toBe(50);
  expect(careerAnchorIndex([10, -10])).toBe(50);
  expect(careerAnchorIndex(Array(100).fill(10))).toBeGreaterThan(50);
  expect(careerAnchorIndex(Array(100).fill(10))).toBeLessThanOrEqual(100);
  expect(careerAnchorIndex(Array(100).fill(-10))).toBeGreaterThanOrEqual(0);
  expect(careerAnchorIndex(Array(100).fill(-10))).toBeLessThan(50);
});
