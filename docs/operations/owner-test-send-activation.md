# Owner-only email test activation plan

**Goal:** Keep Azure and OCI email features available for Ops-managed testing and controlled campaign delivery in the existing Campaigns workspace.

**Architecture:** Use the existing Coolify deployment workflow and its configured API secrets. Before it changes runtime flags, validate the ACS connection and Azure domain-management secret group without printing values. Runtime email ceilings are enabled, while PostgreSQL Ops controls govern email campaigns and owner test sends. Migration 0107 enables those email controls but starts the global emergency stop ON, so no queued job can start until an MFA-enabled Ops user explicitly clears it. SMS dispatch and OCI backup remain off.

**Constraints:**
- Keep `SMS_ENABLED` and `OCI_BACKUP_ENABLED` false.
- Do not accept arbitrary test recipients or From addresses.
- Never print Coolify token, credentials, database URLs, or email addresses in workflow logs.
- Require complete provider and domain-management variable entries before deployment.
- Ops can disable email campaign sending and owner test sends independently. The global emergency stop remains a separate immediate hold.
- SMS campaign delivery and OCI backup have no operational worker in this release, so Ops cannot activate them from the console.

**Verification:** The owner confirmed the Azure test email was received. CI and deployment health/readiness must pass for this release. Ops exposes separately audited campaign/test switches and an emergency-stop control; clearing the stop warns that existing queued jobs may start immediately. Provider acceptance alone does not establish inbox delivery. SMS and OCI backup stay hard-off because their campaign/backup workers are not implemented.
