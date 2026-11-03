ALTER TABLE campaigns
  ADD COLUMN sender_identity_id TEXT REFERENCES tenant_sender_identities(id) ON DELETE RESTRICT;

ALTER TABLE campaign_jobs
  ADD COLUMN contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE;

CREATE INDEX campaign_jobs_claim_idx
  ON campaign_jobs (status, available_at, created_at);

ALTER TABLE delivery_attempts
  ADD COLUMN last_error TEXT;

CREATE TABLE unsubscribe_tokens (
  token TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  UNIQUE (campaign_id, contact_id)
);
