ALTER TABLE tenant_email_domains ADD COLUMN provider_error_status INTEGER;
ALTER TABLE tenant_email_domains ADD COLUMN provider_error_code TEXT;
ALTER TABLE tenant_email_domains ADD COLUMN provider_request_id TEXT;
ALTER TABLE tenant_email_domains ADD COLUMN provider_error_at TEXT;
