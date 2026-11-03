import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

test("partial Azure settings do not take unrelated Cloudflare Worker routes offline", async () => {
  const response = await worker.fetch(new Request("https://campaign.example/healthz"), {
    DB: {} as D1Database,
    AZURE_ARM_CLIENT_ID: "partial-config",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});
