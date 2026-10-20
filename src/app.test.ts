import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "./app.js";

test("health endpoint stays available without external services", async () => {
  const response = await createApp().request("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("readiness fails closed when the database is unavailable", async () => {
  const response = await createApp(async () => false).request("/readyz");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "not_ready" });
});

test("readiness succeeds when the database check passes", async () => {
  const response = await createApp(async () => true).request("/readyz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
});
