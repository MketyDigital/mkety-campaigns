ALTER TABLE tenant_email_domains
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'acs-email'
  CHECK (provider IN ('acs-email', 'oci-email-delivery'));
