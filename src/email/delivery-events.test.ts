import assert from "node:assert/strict";
import test from "node:test";
import { validateEmailDeliveryEvent } from "./delivery-events.js";

const validEvent = {
  provider: "acs-email",
  eventId: "evt-123",
  providerMessageId: "message-456",
  outcome: "bounced",
  occurredAt: "2026-11-10T20:00:00Z",
};

test("normalizes accepted event fields without trusting tenant or address data", () => {
  const normalized = validateEmailDeliveryEvent({
    ...validEvent, tenantId: "attacker-tenant", recipient: "attacker@example.com",
  });
  assert.deepEqual(normalized, validEvent);
});

test("supports both providers and all terminal outcomes", () => {
  for (const provider of ["acs-email", "oci-email-delivery"]) {
    for (const outcome of ["delivered", "bounced", "complained", "failed"]) {
      assert.equal(validateEmailDeliveryEvent({ ...validEvent, provider, outcome }).outcome, outcome);
    }
  }
});

test("rejects malformed, unrecognized, and incomplete events", () => {
  for (const invalid of [
    null, [], "event",
    { ...validEvent, provider: "custom-provider" },
    { ...validEvent, eventId: "" },
    { ...validEvent, eventId: "x".repeat(257) },
    { ...validEvent, providerMessageId: "\nheader-injection" },
    { ...validEvent, outcome: "accepted" },
    { ...validEvent, outcome: "unknown" },
    { ...validEvent, occurredAt: "yesterday" },
    { ...validEvent, occurredAt: "2020-01-01" },
    { ...validEvent, occurredAt: "2019-01-01T00:00:00Z" },
    { ...validEvent, occurredAt: null },
  ]) {
    assert.throws(() => validateEmailDeliveryEvent(invalid), /Invalid normalized email delivery event/);
  }
});
