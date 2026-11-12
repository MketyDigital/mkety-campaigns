import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { getPostgresPoolOptions } from "./postgres-pool-options.mjs";

const { Pool } = pg;

test("Campaigns migrations and runtime tables are isolated in the configured schema", async (t) => {
  if (!process.env.DATABASE_URL) {
    t.skip("DATABASE_URL is not configured");
    return;
  }
  const pool = new Pool(getPostgresPoolOptions(process.env, 1));
  try {
    const current = await pool.query("SELECT current_schema() AS schema");
    assert.equal(current.rows[0]?.schema, "campaigns");
    const tables = await pool.query(`
      SELECT table_schema, table_name
        FROM information_schema.tables
       WHERE table_name IN ('schema_migrations', 'tenants')
         AND table_schema IN ('campaigns', 'public')
    `);
    assert.deepEqual(new Set(tables.rows.map((row) => `${row.table_schema}.${row.table_name}`)),
      new Set(["campaigns.schema_migrations", "campaigns.tenants"]));
  } finally {
    await pool.end();
  }
});
