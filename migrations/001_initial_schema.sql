CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  insight_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);
CREATE TABLE conversation_messages (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  seq integer NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'model')),
  body text NOT NULL,
  FOREIGN KEY (user_id, conversation_id) REFERENCES conversations(user_id, id),
  UNIQUE (conversation_id, seq)
);
CREATE TABLE events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  conversation_id uuid,
  message_start_seq integer,
  message_end_seq integer,
  client_event_id uuid NOT NULL,
  request_hash text NOT NULL,
  title text NOT NULL,
  source text NOT NULL DEFAULT 'conversation',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, client_event_id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES conversations(user_id, id),
  FOREIGN KEY (conversation_id, message_start_seq) REFERENCES conversation_messages(conversation_id, seq),
  FOREIGN KEY (conversation_id, message_end_seq) REFERENCES conversation_messages(conversation_id, seq),
  CHECK ((source = 'conversation' AND conversation_id IS NOT NULL AND message_start_seq IS NOT NULL AND message_end_seq IS NOT NULL AND message_start_seq > 0 AND message_end_seq >= message_start_seq)
    OR (source <> 'conversation' AND message_start_seq IS NULL AND message_end_seq IS NULL))
);
CREATE INDEX events_user_created_idx ON events(user_id, created_at, id);
CREATE TABLE event_insights (
  event_id uuid PRIMARY KEY REFERENCES events(id),
  happen jsonb NOT NULL,
  emotion text NOT NULL,
  likes text NOT NULL,
  dislikes text NOT NULL,
  value_claim text NOT NULL,
  quote text NOT NULL,
  quote_source text NOT NULL CHECK (quote_source IN ('user_message', 'user_edit')),
  anchor_type text
);
CREATE TABLE framework_signals (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  framework text NOT NULL,
  dimension text NOT NULL,
  strength smallint NOT NULL CHECK (strength BETWEEN 1 AND 10),
  evidence_quote text NOT NULL,
  extraction_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, event_id) REFERENCES events(user_id, id),
  UNIQUE (event_id, framework, dimension, evidence_quote, extraction_version)
);
CREATE INDEX framework_signals_user_event_idx ON framework_signals(user_id, event_id);
CREATE TABLE dashboard_runs (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  source_revision bigint NOT NULL,
  source_event_count integer NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboard_runs_user_latest_idx ON dashboard_runs(user_id, id DESC);
