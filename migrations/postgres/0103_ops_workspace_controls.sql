ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS contract_reference TEXT,
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS contract_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_campaign_recipients INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS max_daily_email_recipients INTEGER NOT NULL DEFAULT 1000;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_plan_allowed CHECK (plan IN ('standard','growth','enterprise')),
  ADD CONSTRAINT tenants_campaign_limit_valid CHECK (max_campaign_recipients BETWEEN 1 AND 1000),
  ADD CONSTRAINT tenants_daily_limit_valid CHECK (max_daily_email_recipients BETWEEN 1 AND 100000);

ALTER TABLE tenant_invites
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS tenants_expiration_status_idx ON tenants(status, expires_at);
CREATE INDEX IF NOT EXISTS tenant_invites_pending_idx ON tenant_invites(tenant_id, expires_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;

INSERT INTO campaign_ops_audit (action, details_json)
VALUES ('workspace_controls_migration', '{"migration":"0103_ops_workspace_controls"}'::jsonb);
