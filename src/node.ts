import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : undefined;
const app = createApp(async () => {
  if (!pool) return false;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
});

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`MKETY Campaigns listening on http://${info.address}:${info.port}`);
});

const shutdown = async () => {
  server.close();
  await pool?.end();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
