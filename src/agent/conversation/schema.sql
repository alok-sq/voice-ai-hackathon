-- Permanent conversation logs (SSE-15536). Applied automatically by PostgresConversationStore.ensure_schema().
CREATE TABLE IF NOT EXISTS conversation_logs (
    conversation_id       TEXT PRIMARY KEY,           -- LiveKit room name; unique per call
    call_id               TEXT        NOT NULL,
    lead_id               TEXT,                        -- not in the event contract yet; NULL until it is
    agent_name            TEXT,
    language              TEXT,
    channel               TEXT,                        -- phone | browser
    started_at            TIMESTAMPTZ,
    ended_at              TIMESTAMPTZ,
    duration_s            NUMERIC(10, 1),
    outcome               TEXT,                        -- qualified | not_qualified | callback | wrong_number | do_not_call
    outcome_reason        TEXT,
    qualification_status  TEXT        NOT NULL,        -- qualified | not_qualified | needs_review
    next_action           TEXT,
    end_reason            TEXT,
    message_count         INTEGER     NOT NULL DEFAULT 0,
    transcript            JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{sequence, message_id, timestamp, speaker, text}]
    text_log              TEXT        NOT NULL,                      -- human-readable log
    lead                  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    metrics               JSONB       NOT NULL DEFAULT '{}'::jsonb,
    metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_logs_started_at_idx ON conversation_logs (started_at DESC);
CREATE INDEX IF NOT EXISTS conversation_logs_outcome_idx    ON conversation_logs (outcome);
CREATE INDEX IF NOT EXISTS conversation_logs_lead_id_idx    ON conversation_logs (lead_id) WHERE lead_id IS NOT NULL;
