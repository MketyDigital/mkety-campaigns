import assert from "node:assert/strict";
import test from "node:test";
import { createAuth } from "./auth.js";

test("auth refuses short secrets before initializing a database adapter", () => {
  assert.throws(() => createAuth(undefined, { BETTER_AUTH_SECRET: "short", BETTER_AUTH_URL: "https://campaigns.example.com" }), /at least 32 characters/);
});

test("auth rejects a non-HTTPS public URL", () => {
  assert.throws(() => createAuth(undefined, { BETTER_AUTH_SECRET: "s".repeat(32), BETTER_AUTH_URL: "http://campaigns.example.com" }), /must use HTTPS/);
});
