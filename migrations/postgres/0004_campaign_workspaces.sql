CREATE UNIQUE INDEX consent_evidence_unique_idx
  ON consent_records (tenant_id, contact_id, channel, source, evidence_ref)
  WHERE evidence_ref IS NOT NULL;

CREATE INDEX campaign_jobs_tenant_status_idx
  ON campaign_jobs (tenant_id, campaign_id, status, available_at);
