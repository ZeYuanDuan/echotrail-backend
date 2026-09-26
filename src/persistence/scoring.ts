import { dimensions } from '../llm.js';
import type { DashboardFrameworks } from './types.js';

export const careerAnchorScoreVersion = 2;
const priorWeight = 20;

export function careerAnchorIndex(strengths: number[]): number {
  const net = strengths.reduce((sum, strength) => sum + strength, 0);
  const magnitude = strengths.reduce((sum, strength) => sum + Math.abs(strength), 0);
  return Math.max(0, Math.min(100, Math.round(50 + 50 * net / (priorWeight + magnitude))));
}

export function withCurrentCareerAnchorScores(
  frameworks: Omit<DashboardFrameworks, 'scoreVersion'> & { scoreVersion?: number },
): DashboardFrameworks {
  if (frameworks.scoreVersion === careerAnchorScoreVersion) return frameworks as DashboardFrameworks;
  const schein: Record<string, number> = {};
  for (const dimension of dimensions.schein) {
    schein[dimension] = careerAnchorIndex(
      frameworks.evidence
        .filter((signal) => signal.framework === 'schein' && signal.dimension === dimension)
        .map((signal) => signal.strength),
    );
  }
  return {
    ...frameworks,
    scoreVersion: careerAnchorScoreVersion,
    scores: { ...frameworks.scores, schein },
  };
}
