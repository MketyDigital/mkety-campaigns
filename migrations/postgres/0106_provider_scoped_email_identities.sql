ALTER TABLE tenant_email_domains
  DROP CONSTRAINT IF EXISTS tenant_email_domains_domain_name_key;

CREATE UNIQUE INDEX tenant_email_domains_tenant_provider_name_key
  ON tenant_email_domains (tenant_id, provider, domain_name);

ALTER TABLE tenant_sender_identities
  DROP CONSTRAINT IF EXISTS tenant_sender_identities_tenant_id_sender_address_key;

CREATE UNIQUE INDEX tenant_sender_identities_tenant_provider_address_key
  ON tenant_sender_identities (tenant_id, provider, sender_address);

INSERT INTO campaign_ops_audit (action, details_json)
VALUES ('email_provider_identity_scope_migration', '{"migration":"0106_provider_scoped_email_identities"}'::jsonb);
