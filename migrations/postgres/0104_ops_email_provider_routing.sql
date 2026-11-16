ALTER TABLE campaign_ops_controls
  ADD COLUMN primary_email_provider TEXT,
  ADD COLUMN fallback_email_provider TEXT;

ALTER TABLE campaign_ops_controls
  ADD CONSTRAINT campaign_ops_primary_email_provider_allowed
    CHECK (primary_email_provider IS NULL OR primary_email_provider IN ('acs-email','oci-email-delivery')),
  ADD CONSTRAINT campaign_ops_fallback_email_provider_allowed
    CHECK (fallback_email_provider IS NULL OR fallback_email_provider IN ('acs-email','oci-email-delivery')),
  ADD CONSTRAINT campaign_ops_email_providers_distinct
    CHECK (fallback_email_provider IS NULL OR (primary_email_provider IS NOT NULL AND fallback_email_provider <> primary_email_provider));

INSERT INTO campaign_ops_audit (action, details_json)
VALUES ('email_provider_routing_migration', '{"migration":"0104_ops_email_provider_routing"}'::jsonb);
