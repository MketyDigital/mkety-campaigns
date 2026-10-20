import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, "migrations", "postgres");
const pool = new Pool({ connectionString, max: 1 });

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const appliedRows = await pool.query("SELECT name FROM schema_migrations");
  const applied = new Set(appliedRows.rows.map((row) => row.name));
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(path.join(migrationsDir, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
