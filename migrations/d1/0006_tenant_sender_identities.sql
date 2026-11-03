CREATE TABLE tenant_sender_identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain_id TEXT NOT NULL REFERENCES tenant_email_domains(id) ON DELETE CASCADE,
  sender_address TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'acs-email'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, sender_address)
);
CREATE INDEX tenant_sender_identities_tenant_idx ON tenant_sender_identities (tenant_id, created_at DESC);
