import type { EmailSendResult } from "./providers.js";

/**
 * Canonical, provider-neutral event after provider-specific signature verification
 * and event mapping. Never accept this structure directly from a public webhook.
 *
 * Reconciliation must resolve the provider message ID through delivery_attempts.
 * Tenant IDs and recipient addresses are deliberately excluded so a caller cannot
 * choose the tenant whose suppression state is changed.
 */
export type EmailDeliveryEvent = {
  provider: EmailSendResult["provider"];
  eventId: string;
  providerMessageId: string;
  outcome: "delivered" | "bounced" | "complained" | "failed";
  occurredAt: string;
};

export class InvalidEmailDeliveryEventError extends Error {
  constructor() {
    super("Invalid normalized email delivery event");
    this.name = "InvalidEmailDeliveryEventError";
  }
}

/** Only validates the canonical shape; it does NOT authenticate webhooks. */
export function validateEmailDeliveryEvent(input: unknown): EmailDeliveryEvent {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidEmailDeliveryEventError();
  }
  const value = input as Record<string, unknown>;
  const provider = value.provider;
  const eventId = value.eventId;
  const providerMessageId = value.providerMessageId;
  const outcome = value.outcome;
  const occurredAt = value.occurredAt;
  if (provider !== "acs-email" && provider !== "oci-email-delivery") {
    throw new InvalidEmailDeliveryEventError();
  }
  if (!isOpaqueIdentifier(eventId) || !isOpaqueIdentifier(providerMessageId)) {
    throw new InvalidEmailDeliveryEventError();
  }
  if (outcome !== "delivered" && outcome !== "bounced" && outcome !== "complained" && outcome !== "failed") {
    throw new InvalidEmailDeliveryEventError();
  }
  if (typeof occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt)) {
    throw new InvalidEmailDeliveryEventError();
  }
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).getUTCFullYear() < 2020) {
    throw new InvalidEmailDeliveryEventError();
  }
  return { provider, eventId, providerMessageId, outcome, occurredAt };
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && /^[\x21-\x7E]+$/.test(value);
}
