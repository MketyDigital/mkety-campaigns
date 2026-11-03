import assert from "node:assert/strict";
import pg from "pg";
import { createAuth } from "../dist/auth.js";

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const auth = createAuth(pool, {
  BETTER_AUTH_SECRET: "test-only-secret-please-replace-00000000000000000000000000000000",
  BETTER_AUTH_URL: "http://localhost:3000",
});

try {
  const result = await pool.query(`
    SELECT u.id, u.email, u.display_name, u.email_verified, u.two_factor_enabled, u.updated_at,
           s.id AS session_id, a.id AS account_id, v.id AS verification_id, tf.id AS two_factor_id
      FROM users u
      LEFT JOIN sessions s ON s.user_id = u.id
      LEFT JOIN accounts a ON a.user_id = u.id
      LEFT JOIN auth_verifications v ON v.identifier = u.email
      LEFT JOIN user_two_factors tf ON tf.user_id = u.id
     LIMIT 0`);
  assert.equal(result.rowCount, 0);

  const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-a-real-user@example.invalid", password: "not-a-real-password" }),
  }));
  assert.notEqual(response.status, 500, `Auth schema check returned 500: ${await response.text()}`);
  assert.ok(response.status >= 400 && response.status < 500, `Expected an invalid-login response, received ${response.status}`);
} finally {
  await pool.end();
}
