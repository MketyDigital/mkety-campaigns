import test from "node:test";
import assert from "node:assert/strict";
import { parseContactsCsv, validateContactImport, validateCampaignDraft } from "./service.js";

test("contact import requires a valid address and affirmative consent evidence for the selected channel", () => {
  assert.throws(() => validateContactImport({ email: "not-an-email", emailConsent: true, consentSource: "signup" }, "email"), /valid email/i);
  assert.throws(() => validateContactImport({ phone: "+2348012345678", emailConsent: true, consentSource: "signup", consentEvidenceRef: "form", consentOccurredAt: "2026-11-02T12:00:00Z" }, "email"), /email address is required/i);
  assert.throws(() => validateContactImport({ email: "person@example.com", smsConsent: true, consentSource: "signup", consentEvidenceRef: "form", consentOccurredAt: "2026-11-02T12:00:00Z" }, "sms"), /phone number is required/i);
  assert.throws(() => validateContactImport({ email: "person@example.com", emailConsent: true }, "email"), /consent source/i);
  assert.throws(() => validateContactImport({ phone: "+2348012345678", smsConsent: true, consentSource: "signup" }, "sms"), /consent evidence/i);
  assert.throws(() => validateContactImport({ email: "person@example.com", emailConsent: true, consentSource: "website", consentEvidenceRef: "form-123" }, "email"), /consent time/i);
  assert.deepEqual(validateContactImport({ email: " Person@Example.com ", emailConsent: true, consentSource: "website", consentEvidenceRef: "form-123", consentOccurredAt: "2026-11-02T12:00:00.000Z" }, "email"), {
    email: "person@example.com",
    phoneE164: null,
    displayName: null,
    consent: { channel: "email", source: "website", evidenceRef: "form-123", occurredAt: "2026-11-02T12:00:00.000Z" },
  });
});

test("campaign drafts validate channel content without accepting sender identity from the request", () => {
  assert.throws(() => validateCampaignDraft({ channel: "email", subject: "", bodyText: "Hi" }), /subject/i);
  assert.throws(() => validateCampaignDraft({ channel: "sms", bodyText: "  " }), /message/i);
  assert.deepEqual(validateCampaignDraft({ channel: "email", subject: " Sale ", bodyText: " Hello ", bodyHtml: "<p>Hello</p>", from: "attacker@example.com" }), {
    channel: "email",
    subject: "Sale",
    bodyText: "Hello",
    bodyHtml: "<p>Hello</p>",
  });
});

test("campaign draft accepts only a valid future schedule and normalizes it to UTC", () => {
  const future = "2030-04-05T12:30:00.000Z";
  assert.equal(validateCampaignDraft({ channel: "email", subject: "Hello", bodyText: "Hi", scheduledAt: future }, new Date("2030-04-01T00:00:00Z")).scheduledAt, future);
  assert.throws(() => validateCampaignDraft({ channel: "email", subject: "Hello", bodyText: "Hi", scheduledAt: "not-a-date" }), /schedule/i);
  assert.throws(() => validateCampaignDraft({ channel: "email", subject: "Hello", bodyText: "Hi", scheduledAt: "2020-01-01T00:00:00Z" }, new Date("2030-01-01T00:00:00Z")), /future/i);
});

test("CSV contact import parses quoted fields and validates every row before returning any", () => {
  const csv = [
    "email,phone,display_name,email_consent,consent_source,consent_evidence_ref,consent_occurred_at",
    'person@example.com,,"Ada, Lovelace",true,checkout,order-123,2026-11-02T12:00:00.000Z',
  ].join("\n");
  const rows = parseContactsCsv(csv, "email");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].displayName, "Ada, Lovelace");
  assert.equal(rows[0].consent.evidenceRef, "order-123");
  assert.throws(() => parseContactsCsv(csv.replace("true,checkout", "false,checkout"), "email"), /CSV row 2/i);
  assert.throws(() => parseContactsCsv(csv + "\ninvalid", "email"), /CSV row 3/i);
});
