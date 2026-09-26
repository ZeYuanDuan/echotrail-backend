import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ConfirmEventInput, DashboardEvidence, DashboardSnapshot, EventRecord, User } from './types.js';
import { InputError } from './validate.js';
import { withCurrentCareerAnchorScores } from './scoring.js';

export async function upsertUser(pool: Pool, display: string, normalized: string): Promise<User> {
  const { rows } = await pool.query('INSERT INTO users(id,display_name,normalized_name) VALUES($1,$2,$3) ON CONFLICT(normalized_name) DO UPDATE SET normalized_name=EXCLUDED.normalized_name RETURNING id,display_name', [randomUUID(), display, normalized]);
  return { id: rows[0].id as string, name: rows[0].display_name as string };
}

type EventRow = Record<string, unknown>;
async function hydrate(pool: Pool | PoolClient, row: EventRow): Promise<EventRecord> {
  const { rows: signalRows } = await pool.query('SELECT framework,dimension,strength,evidence_quote FROM framework_signals WHERE user_id=$1 AND event_id=$2 ORDER BY id', [row.user_id, row.id]);
  return {
    id: row.id as string, userId: row.user_id as string, conversationId: row.conversation_id as string,
    messageStartSeq: row.message_start_seq as number, messageEndSeq: row.message_end_seq as number,
    createdAt: (row.created_at as Date).toISOString(), source: row.source as string,
    card: { title: row.title as string, happen: row.happen as string[], emotion: row.emotion as string,
      like: row.likes as string, dislike: row.dislikes as string, value: row.value_claim as string, quote: row.quote as string },
    signals: signalRows.map((signal) => ({ framework: signal.framework, dimension: signal.dimension, strength: signal.strength, evidenceQuote: signal.evidence_quote })),
  };
}
const eventSelect = `SELECT e.id,e.user_id,e.conversation_id,e.message_start_seq,e.message_end_seq,e.title,e.source,e.created_at,
  i.happen,i.emotion,i.likes,i.dislikes,i.value_claim,i.quote
  FROM events e JOIN event_insights i ON i.event_id=e.id`;

async function findByKey(pool: Pool | PoolClient, userId: string, clientEventId: string): Promise<{ hash: string; event: EventRecord } | null> {
  const { rows } = await pool.query(`${eventSelect} WHERE e.user_id=$1 AND e.client_event_id=$2`, [userId, clientEventId]);
  if (!rows.length) return null;
  const hash = await pool.query('SELECT request_hash FROM events WHERE id=$1', [rows[0].id]);
  return { hash: hash.rows[0].request_hash as string, event: await hydrate(pool, rows[0]) };
}

export async function confirmEvent(pool: Pool, input: ConfirmEventInput): Promise<{ created: boolean; event: EventRecord }> {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prior = await findByKey(pool, input.userId, input.clientEventId);
  if (prior) {
    if (prior.hash !== hash) throw new InputError('相同事件 ID 的內容不同。', 409);
    return { created: false, event: prior.event };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT id FROM users WHERE id=$1', [input.userId]);
    if (!user.rows.length) throw new InputError('找不到使用者。', 404);
    await client.query('INSERT INTO conversations(id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [input.conversationId, input.userId]);
    const conversation = await client.query('SELECT user_id FROM conversations WHERE id=$1 FOR UPDATE', [input.conversationId]);
    if (conversation.rows[0]?.user_id !== input.userId) throw new InputError('此對話屬於另一位使用者。', 409);
    // A retry may have been waiting on this conversation's row lock.
    const lockedPrior = await findByKey(client, input.userId, input.clientEventId);
    if (lockedPrior) {
      if (lockedPrior.hash !== hash) throw new InputError('相同事件 ID 的內容不同。', 409);
      await client.query('COMMIT');
      return { created: false, event: lockedPrior.event };
    }
    const current = await client.query('SELECT COALESCE(MAX(seq),0) AS seq FROM conversation_messages WHERE conversation_id=$1', [input.conversationId]);
    const start = Number(current.rows[0].seq) + 1;
    for (const [index, message] of input.messages.entries()) {
      await client.query('INSERT INTO conversation_messages(user_id,conversation_id,seq,role,body) VALUES($1,$2,$3,$4,$5)', [input.userId, input.conversationId, start + index, message.role, message.text]);
    }
    const eventId = randomUUID();
    await client.query('INSERT INTO events(id,user_id,conversation_id,message_start_seq,message_end_seq,client_event_id,request_hash,title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [eventId, input.userId, input.conversationId, start, start + input.messages.length - 1, input.clientEventId, hash, input.card.title]);
    const card = input.card;
    await client.query('INSERT INTO event_insights(event_id,happen,emotion,likes,dislikes,value_claim,quote,quote_source) VALUES($1,$2::jsonb,$3,$4,$5,$6,$7,$8)',
      [eventId, JSON.stringify(card.happen), card.emotion, card.like, card.dislike, card.value, card.quote, input.editedFields.includes('quote') ? 'user_edit' : 'user_message']);
    for (const signal of input.signals) {
      await client.query('INSERT INTO framework_signals(user_id,event_id,framework,dimension,strength,evidence_quote) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [input.userId, eventId, signal.framework, signal.dimension, signal.strength, signal.evidenceQuote]);
    }
    await client.query('UPDATE users SET insight_revision=insight_revision+1 WHERE id=$1', [input.userId]);
    const saved = await findByKey(client, input.userId, input.clientEventId);
    await client.query('COMMIT');
    return { created: true, event: saved!.event };
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
      const duplicate = await findByKey(pool, input.userId, input.clientEventId);
      if (duplicate) {
        if (duplicate.hash !== hash) throw new InputError('相同事件 ID 的內容不同。', 409);
        return { created: false, event: duplicate.event };
      }
    }
    throw error;
  } finally { client.release(); }
}

export async function listEvents(pool: Pool | PoolClient, userId: string): Promise<EventRecord[]> {
  const { rows } = await pool.query(`${eventSelect} WHERE e.user_id=$1 ORDER BY e.created_at ASC,e.id ASC`, [userId]);
  return Promise.all(rows.map((row) => hydrate(pool, row)));
}

export async function getUserRevision(pool: Pool, userId: string): Promise<number | null> {
  const { rows } = await pool.query('SELECT insight_revision FROM users WHERE id=$1', [userId]);
  return rows.length ? Number(rows[0].insight_revision) : null;
}

export async function loadEvidence(pool: Pool, userId: string): Promise<DashboardEvidence[]> {
  const evidenceSelect = eventSelect.replace('FROM events', ',i.quote_source FROM events');
  const { rows } = await pool.query(`${evidenceSelect} WHERE e.user_id=$1 ORDER BY e.created_at ASC,e.id ASC`, [userId]);
  const events = await Promise.all(rows.map((row) => hydrate(pool, row)));
  return Promise.all(events.map(async (event, index) => {
    const { rows: messages } = await pool.query('SELECT role,body FROM conversation_messages WHERE user_id=$1 AND conversation_id=$2 AND seq BETWEEN $3 AND $4 ORDER BY seq',
      [userId, event.conversationId, event.messageStartSeq, event.messageEndSeq]);
    return { eventId: event.id, title: event.card.title, card: event.card, signals: event.signals,
      messages: messages.map((message) => ({ role: message.role, text: message.body })), quoteSource: rows[index].quote_source } as DashboardEvidence;
  }));
}

export async function saveDashboard(pool: Pool, userId: string, revision: number, count: number, result: Pick<DashboardSnapshot, 'profile' | 'frameworks'>): Promise<DashboardSnapshot> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: users } = await client.query('SELECT insight_revision FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (!users.length) throw new InputError('找不到使用者。', 404);
    if (Number(users[0].insight_revision) !== revision) throw new InputError('事件已變更，請重新更新 Dashboard。', 409);
    const { rows } = await client.query('INSERT INTO dashboard_runs(user_id,source_revision,source_event_count,result) VALUES($1,$2,$3,$4::jsonb) RETURNING id,created_at',
      [userId, revision, count, JSON.stringify(result)]);
    await client.query('COMMIT');
    return { id: Number(rows[0].id), userId, createdAt: (rows[0].created_at as Date).toISOString(), sourceRevision: revision, sourceEventCount: count, ...result };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function getLatestDashboard(pool: Pool, userId: string): Promise<DashboardSnapshot | null> {
  const { rows } = await pool.query('SELECT id,user_id,source_revision,source_event_count,result,created_at FROM dashboard_runs WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [userId]);
  if (!rows.length) return null;
  const row = rows[0];
  const result = row.result as Pick<DashboardSnapshot, 'profile' | 'frameworks'>;
  return { id: Number(row.id), userId: row.user_id, createdAt: (row.created_at as Date).toISOString(), sourceRevision: Number(row.source_revision), sourceEventCount: row.source_event_count,
    profile: result.profile, frameworks: withCurrentCareerAnchorScores(result.frameworks) };
}
