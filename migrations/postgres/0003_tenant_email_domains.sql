CREATE TABLE tenant_email_domains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain_name TEXT NOT NULL UNIQUE,
  azure_resource_id TEXT,
  provisioning_state TEXT NOT NULL DEFAULT 'Pending',
  verification_records_json TEXT NOT NULL DEFAULT '{}',
  verification_states_json TEXT NOT NULL DEFAULT '{}',
  linked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tenant_email_domains_tenant_idx ON tenant_email_domains(tenant_id, created_at DESC);
