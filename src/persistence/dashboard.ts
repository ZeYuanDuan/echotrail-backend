import type { Pool } from 'pg';
import type { LlmClient } from '../llm.js';
import { dimensions, parseDashboardProfile } from '../llm.js';
import { getUserRevision, loadEvidence, saveDashboard } from './repository.js';
import type { DashboardEvidence, DashboardFrameworks, DashboardSnapshot } from './types.js';
import { InputError } from './validate.js';

export function aggregateSignals(events: DashboardEvidence[]): DashboardFrameworks {
  const scores: DashboardFrameworks['scores'] = { riasec: {}, disc: {}, schein: {} };
  const evidence: DashboardFrameworks['evidence'] = [];
  for (const [framework, names] of Object.entries(dimensions) as Array<[keyof typeof dimensions, readonly string[]]>) {
    for (const dimension of names) {
      const matching = events.flatMap((event) => event.signals.filter((signal) => signal.framework === framework && signal.dimension === dimension));
      scores[framework][dimension] = matching.length ? Math.max(0, Math.min(100, Math.round(matching.reduce((sum, signal) => sum + signal.strength, 0) / matching.length * 10))) : 0;
    }
  }
  for (const event of events) for (const signal of event.signals) evidence.push({ eventId: event.eventId, eventTitle: event.title, ...signal });
  return { scores, evidence };
}

export async function rebuildDashboard(pool: Pool, llm: LlmClient, userId: string): Promise<DashboardSnapshot> {
  const revision = await getUserRevision(pool, userId);
  if (revision === null) throw new InputError('找不到使用者。', 404);
  const evidence = await loadEvidence(pool, userId);
  if (!evidence.length) throw new InputError('尚無已確認事件。', 409);
  const profile = await llm.synthesizeDashboard(evidence);
  // Validate injected clients as well as Gemini, before publishing a run.
  const validated = parseDashboardProfile(JSON.stringify(profile), evidence);
  return saveDashboard(pool, userId, revision, evidence.length, { profile: validated, frameworks: aggregateSignals(evidence) });
}
