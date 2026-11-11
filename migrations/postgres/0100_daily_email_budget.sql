-- Daily reservations count queued recipients, not provider delivery successes.
-- Conservatively keep reservations for canceled or suppressed jobs.
CREATE TABLE tenant_daily_email_reservations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day_utc DATE NOT NULL,
  reserved_count INTEGER NOT NULL CHECK (reserved_count >= 0),
  max_recipients INTEGER NOT NULL CHECK (max_recipients BETWEEN 1 AND 100000),
  CONSTRAINT daily_recipient_budget_enforced CHECK (reserved_count <= max_recipients),
  PRIMARY KEY (tenant_id, day_utc)
);
