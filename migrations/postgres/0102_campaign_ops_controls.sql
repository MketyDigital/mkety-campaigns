CREATE TABLE IF NOT EXISTS campaign_ops_controls (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  email_emergency_stop BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES campaign_ops_users(id) ON DELETE SET NULL
);
INSERT INTO campaign_ops_controls (id, email_emergency_stop) VALUES (TRUE, TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS campaign_ops_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES campaign_ops_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS campaign_ops_audit_created_idx ON campaign_ops_audit (created_at DESC);
