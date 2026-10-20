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

test("auth endpoints fail closed when auth secrets are not configured", async () => {
  const response = await createApp().request("/api/auth/sign-in/email", { method: "POST" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "auth_not_configured" });
});

test("tenant routes require an authenticated MFA-enabled seat", async () => {
  const app = createApp(async () => true, {
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({ user: { id: "user-1", role: "tenant", twoFactorEnabled: false }, session: { createdAt: new Date() } }),
    },
    resolveTenantSeat: async () => "tenant-1",
  });
  const response = await app.request("/api/tenant/me");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "mfa_required" });
});

test("tenant context comes from the authenticated seat, not a request parameter", async () => {
  const app = createApp(async () => true, {
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({ user: { id: "user-1", role: "tenant", twoFactorEnabled: true }, session: { createdAt: new Date() } }),
    },
    resolveTenantSeat: async (userId) => userId === "user-1" ? "tenant-authorized" : null,
  });
  const response = await app.request("/api/tenant/me?tenantId=tenant-attacker");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tenantId: "tenant-authorized", userId: "user-1" });
});
