-- Provider-authenticated delivery events are reconciled against server-owned attempts.
CREATE TABLE IF NOT EXISTS email_delivery_events (
  provider TEXT NOT NULL CHECK (provider IN ('acs-email', 'oci-email-delivery')),
  event_id TEXT NOT NULL,
  delivery_attempt_id TEXT NOT NULL REFERENCES delivery_attempts(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'bounced', 'complained', 'failed')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX IF NOT EXISTS email_delivery_events_attempt_idx ON email_delivery_events(delivery_attempt_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS delivery_attempts_provider_message_idx ON delivery_attempts(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
