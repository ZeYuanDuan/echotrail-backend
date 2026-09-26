import type { ChatMessage, DashboardProfile, InsightResult, InsightSignal } from '../llm.js';

export type CardFields = InsightResult['card'];
export type EditedField = 'title' | 'happen' | 'emotion' | 'like' | 'dislike' | 'value' | 'quote';
export type User = { id: string; name: string };
export type ConfirmEventInput = {
  userId: string;
  clientEventId: string;
  conversationId: string;
  messages: ChatMessage[];
  card: CardFields;
  editedFields: EditedField[];
  signals: InsightSignal[];
};
export type EventRecord = {
  id: string;
  userId: string;
  conversationId: string;
  messageStartSeq: number;
  messageEndSeq: number;
  createdAt: string;
  source: string;
  card: CardFields;
  signals: InsightSignal[];
};
export type DashboardEvidence = {
  eventId: string;
  title: string;
  card: CardFields;
  messages: ChatMessage[];
  signals: InsightSignal[];
  quoteSource: 'user_message' | 'user_edit';
};
export type DashboardFrameworks = {
  scoreVersion: number;
  scores: Record<'riasec' | 'disc' | 'schein', Record<string, number>>;
  evidence: Array<{ eventId: string; eventTitle: string; framework: string; dimension: string; strength: number; evidenceQuote: string }>;
};
export type DashboardSnapshot = {
  id: number;
  userId: string;
  createdAt: string;
  sourceRevision: number;
  sourceEventCount: number;
  profile: DashboardProfile;
  frameworks: DashboardFrameworks;
};
