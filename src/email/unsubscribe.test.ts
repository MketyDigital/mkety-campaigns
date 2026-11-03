import assert from "node:assert/strict";
import test from "node:test";
import { buildUnsubscribeUrl, createOpaqueUnsubscribeToken } from "./unsubscribe.js";

test("unsubscribe tokens are random opaque values and do not contain contact identifiers", () => {
  const first = createOpaqueUnsubscribeToken();
  const second = createOpaqueUnsubscribeToken();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
  assert.doesNotMatch(first, /tenant-1|contact-1|@/);
});

test("unsubscribe URL requires HTTPS outside local development", () => {
  assert.match(buildUnsubscribeUrl("https://campaign.mkety.com", "token").href, /^https:\/\/campaign\.mkety\.com\/unsubscribe\?token=/);
  assert.throws(() => buildUnsubscribeUrl("http://campaign.mkety.com", "token"), /HTTPS/i);
});
