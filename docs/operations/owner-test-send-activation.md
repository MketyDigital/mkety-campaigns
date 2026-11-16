# Owner-only email test activation plan

**Goal:** Enable the fixed account-owner email test in the existing Campaigns workspace so MKETY can validate a real verified sender.

**Architecture:** Use the existing Coolify deployment workflow and its configured API secrets. Before it changes runtime flags, validate the selected email provider and the matching domain-management credentials from Coolify's variable names without printing values. Enable `EMAIL_TEST_SEND_ENABLED`, force campaign dispatch, SMS, and OCI backup off, and redeploy. The test endpoint uses the verified sender selected by the owner and the signed-in account email; the user initiates the message.

**Constraints:**
- Do not enable `EMAIL_CAMPAIGN_SEND_ENABLED`, SMS, or OCI backup.
- Do not accept arbitrary test recipients or From addresses.
- Never print Coolify token, credentials, database URLs, or email addresses in workflow logs.
- Require complete provider and domain-management variable entries before enabling the test route.
- Disable the test-send gate after the owner confirms the inbox check.

**Verification:** CI must pass. The Coolify workflow must report only provider name, credential-group completeness, and safe gate states. Confirm deployment health/readiness; the owner confirms sender readiness and initiates the single fixed test from the signed-in workspace account.
