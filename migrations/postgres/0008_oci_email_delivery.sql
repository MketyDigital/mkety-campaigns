ALTER TABLE tenant_sender_identities
  DROP CONSTRAINT tenant_sender_identities_provider_check;

ALTER TABLE tenant_sender_identities
  ADD CONSTRAINT tenant_sender_identities_provider_check
  CHECK (provider IN ('acs-email', 'oci-email-delivery'));
