PRAGMA foreign_keys = ON;

CREATE TABLE tenant_email_domains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain_name TEXT NOT NULL UNIQUE,
  azure_resource_id TEXT,
  provisioning_state TEXT NOT NULL DEFAULT 'Pending',
  verification_records_json TEXT NOT NULL DEFAULT '{}',
  verification_states_json TEXT NOT NULL DEFAULT '{}',
  linked INTEGER NOT NULL DEFAULT 0 CHECK (linked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX tenant_email_domains_tenant_idx ON tenant_email_domains(tenant_id, created_at DESC);
