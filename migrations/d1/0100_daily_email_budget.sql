-- Reservations include all queued email recipients, even if later suppressed.
CREATE TABLE tenant_daily_email_reservations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day_utc TEXT NOT NULL,
  reserved_count INTEGER NOT NULL CHECK (reserved_count >= 0),
  max_recipients INTEGER NOT NULL CHECK (max_recipients BETWEEN 1 AND 100000),
  CONSTRAINT daily_recipient_budget_enforced CHECK (reserved_count <= max_recipients),
  PRIMARY KEY (tenant_id, day_utc)
);
