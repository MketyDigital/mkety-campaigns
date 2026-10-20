ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN image TEXT;
ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER IF NOT EXISTS users_mfa_enrollment_timestamp
AFTER UPDATE OF two_factor_enabled ON users
WHEN OLD.two_factor_enabled != NEW.two_factor_enabled
BEGIN
  UPDATE users
     SET mfa_enrolled_at = CASE WHEN NEW.two_factor_enabled = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
   WHERE id = NEW.id;
END;

CREATE UNIQUE INDEX tenant_seats_user_unique_idx ON tenant_seats(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_id, account_id)
);
CREATE INDEX accounts_user_idx ON accounts(user_id);

CREATE TABLE auth_verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);

CREATE TABLE user_two_factors (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified INTEGER NOT NULL DEFAULT 1,
  failed_verification_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  UNIQUE(user_id)
);
