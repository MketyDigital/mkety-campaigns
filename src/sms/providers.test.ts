import assert from "node:assert/strict";
import test from "node:test";
import { createOptionalSmsProvider, createTelnyxSmsProvider } from "./providers.js";

test("SMS provider stays disabled unless explicitly enabled", () => {
  assert.equal(createOptionalSmsProvider({ TELNYX_API_KEY: "secret", SMS_PROVIDER: "telnyx" }), undefined);
});

test("Telnyx adapter sends one validated recipient with the resolved sender", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const provider = createTelnyxSmsProvider({
    apiKey: "test-key",
    fetcher: async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return Response.json({ data: { id: "message-123" } }, { status: 202 });
    },
  });

  const result = await provider.send({
    idempotencyKey: "campaign-job-123",
    from: "+12065550101",
    to: "+12065550102",
    text: "Your campaign update",
  });

  assert.equal(request?.url, "https://api.telnyx.com/v2/messages");
  assert.equal(request?.init.method, "POST");
  assert.equal(new Headers(request?.init.headers).get("authorization"), "Bearer test-key");
  assert.deepEqual(JSON.parse(String(request?.init.body)), {
    from: "+12065550101",
    to: "+12065550102",
    text: "Your campaign update",
  });
  assert.deepEqual(result, { provider: "telnyx-sms", providerMessageId: "message-123" });
});

test("SMS provider rejects invalid destination before making a request", async () => {
  let called = false;
  const provider = createTelnyxSmsProvider({
    apiKey: "test-key",
    fetcher: async () => {
      called = true;
      return Response.json({ data: { id: "unexpected" } }, { status: 202 });
    },
  });
  await assert.rejects(provider.send({
    idempotencyKey: "job-1", from: "+12065550101", to: "2065550102", text: "Hello",
  }), /E.164/);
  assert.equal(called, false);
});
