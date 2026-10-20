import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

const { Pool } = pg;
const { DATABASE_URL, BOOTSTRAP_OPS_EMAIL, BOOTSTRAP_OPS_NAME, BOOTSTRAP_OPS_PASSWORD } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!BOOTSTRAP_OPS_EMAIL || !BOOTSTRAP_OPS_NAME || !BOOTSTRAP_OPS_PASSWORD) {
  throw new Error("BOOTSTRAP_OPS_EMAIL, BOOTSTRAP_OPS_NAME, and BOOTSTRAP_OPS_PASSWORD are required");
}
if (BOOTSTRAP_OPS_PASSWORD.length < 12 || BOOTSTRAP_OPS_PASSWORD.length > 128) {
  throw new Error("BOOTSTRAP_OPS_PASSWORD must be between 12 and 128 characters");
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('mkety-campaigns-bootstrap-ops'))");
  const existingOps = await client.query("SELECT id FROM users WHERE role = 'ops' LIMIT 1");
  if (existingOps.rowCount) throw new Error("An Ops account already exists; bootstrap can only run once");
  const email = BOOTSTRAP_OPS_EMAIL.trim().toLowerCase();
  const existingEmail = await client.query("SELECT id FROM users WHERE lower(email) = $1 LIMIT 1", [email]);
  if (existingEmail.rowCount) throw new Error("This email already belongs to an account");

  const userId = randomUUID();
  const now = new Date();
  const passwordHash = await hashPassword(BOOTSTRAP_OPS_PASSWORD);
  await client.query(
    `INSERT INTO users(id, email, display_name, role, email_verified, two_factor_enabled, created_at, updated_at)
     VALUES ($1, $2, $3, 'ops', TRUE, FALSE, $4, $4)`,
    [userId, email, BOOTSTRAP_OPS_NAME.trim(), now],
  );
  await client.query(
    `INSERT INTO accounts(id, account_id, provider_id, user_id, password, created_at, updated_at)
     VALUES ($1, $2, 'credential', $2, $3, $4, $4)`,
    [randomUUID(), userId, passwordHash, now],
  );
  await client.query("COMMIT");
  console.log(`Created the one-time Ops account for ${email}. Sign in and enroll TOTP before using tenant routes.`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
