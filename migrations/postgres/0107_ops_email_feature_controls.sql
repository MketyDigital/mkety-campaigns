ALTER TABLE campaign_ops_controls
  ADD COLUMN email_campaign_send_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN email_test_send_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN sms_send_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN oci_backup_enabled BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO campaign_ops_controls (id, email_emergency_stop, email_campaign_send_enabled, email_test_send_enabled, sms_send_enabled, oci_backup_enabled)
VALUES (TRUE, TRUE, TRUE, TRUE, FALSE, FALSE)
ON CONFLICT (id) DO UPDATE SET
  email_emergency_stop = TRUE,
  email_campaign_send_enabled = TRUE,
  email_test_send_enabled = TRUE,
  sms_send_enabled = FALSE,
  oci_backup_enabled = FALSE;

INSERT INTO campaign_ops_audit (action, details_json)
VALUES ('email_feature_controls_migration', '{"migration":"0107_ops_email_feature_controls","emailCampaignsEnabled":true,"ownerTestSendEnabled":true,"smsEnabled":false,"ociBackupEnabled":false,"emergencyStop":true}'::jsonb);
