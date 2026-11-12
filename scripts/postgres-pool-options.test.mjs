import assert from "node:assert/strict";
import test from "node:test";
import { getPostgresPoolOptions } from "./postgres-pool-options.mjs";

test("uses the isolated campaigns schema before public", () => {
  assert.deepEqual(getPostgresPoolOptions({
    DATABASE_URL: "postgres://user:password@db/mkety",
  }, 5), {
    connectionString: "postgres://user:password@db/mkety",
    max: 5,
    options: "-c search_path=campaigns,public",
  });
});

test("supports a validated custom schema name", () => {
  assert.equal(getPostgresPoolOptions({
    DATABASE_URL: "postgres://user:password@db/mkety",
    CAMPAIGNS_DB_SCHEMA: "campaigns_stage",
  }, 1)?.options, "-c search_path=campaigns_stage,public");
});

test("does not create a pool without DATABASE_URL", () => {
  assert.equal(getPostgresPoolOptions({}, 5), undefined);
});

test("rejects schema values that could alter the PostgreSQL command", () => {
  assert.throws(() => getPostgresPoolOptions({
    DATABASE_URL: "postgres://user:password@db/mkety",
    CAMPAIGNS_DB_SCHEMA: "campaigns,public;DROP SCHEMA public",
  }, 5), /CAMPAIGNS_DB_SCHEMA/);
});
