ALTER TABLE tenant_email_domains
  ADD COLUMN provider_error_status SMALLINT,
  ADD COLUMN provider_error_code TEXT,
  ADD COLUMN provider_request_id TEXT,
  ADD COLUMN provider_error_at TIMESTAMPTZ;

ALTER TABLE tenant_email_domains
  ADD CONSTRAINT tenant_email_domains_provider_error_status_valid
    CHECK (provider_error_status IS NULL OR provider_error_status BETWEEN 100 AND 599),
  ADD CONSTRAINT tenant_email_domains_provider_error_code_safe
    CHECK (provider_error_code IS NULL OR provider_error_code ~ '^[A-Za-z0-9_.-]{1,64}$'),
  ADD CONSTRAINT tenant_email_domains_provider_request_id_safe
    CHECK (provider_request_id IS NULL OR provider_request_id ~ '^[A-Za-z0-9_.:-]{1,128}$');

CREATE INDEX tenant_email_domains_failed_ops_idx ON tenant_email_domains (provider, updated_at DESC)
  WHERE provisioning_state IN ('Failed','Unknown');
