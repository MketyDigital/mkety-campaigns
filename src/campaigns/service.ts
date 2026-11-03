export type CampaignChannel = "email" | "sms";

export type ContactImport = {
  email?: string;
  phone?: string;
  displayName?: string;
  emailConsent?: boolean;
  smsConsent?: boolean;
  consentSource?: string;
  consentEvidenceRef?: string;
  consentOccurredAt?: string;
};

export type ValidContactImport = {
  email: string | null;
  phoneE164: string | null;
  displayName: string | null;
  consent: {
    channel: CampaignChannel;
    source: string;
    evidenceRef: string;
    occurredAt: string;
  };
};

export type CampaignDraft = {
  channel: CampaignChannel;
  senderIdentityId?: string;
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  scheduledAt?: string;
};

/** CSV column names: email, phone, display_name, email_consent, sms_consent,
 * consent_source, consent_evidence_ref, consent_occurred_at. */
export function parseContactsCsv(csv: string, channel: CampaignChannel): ValidContactImport[] {
  if (new TextEncoder().encode(csv).byteLength > 1_000_000) throw new Error("CSV file is larger than 1 MB");
  const table = parseCsvRows(csv);
  if (table.length < 2) throw new Error("CSV must include a header and at least one contact");
  const headers = table[0].map((header) => header.trim().toLowerCase().replace(/[ -]+/g, "_"));
  const requiredHeaders = [channel === "email" ? "email" : "phone", `${channel}_consent`, "consent_source", "consent_evidence_ref", "consent_occurred_at"];
  for (const header of requiredHeaders) if (!headers.includes(header)) throw new Error(`CSV is missing the ${header} column`);
  if (headers.length !== new Set(headers).size) throw new Error("CSV contains duplicate column names");
  if (table.length - 1 > 1000) throw new Error("CSV may contain at most 1,000 contacts at a time");

  return table.slice(1).map((cells, index) => {
    const rowNumber = index + 2;
    try {
      if (cells.length !== headers.length) throw new Error("the row has a different number of columns than the header");
      const record = Object.fromEntries(headers.map((header, column) => [header, cells[column]?.trim() ?? ""]));
      const consent = parseConsent(record[`${channel}_consent`]);
      return validateContactImport({
        email: record.email,
        phone: record.phone,
        displayName: record.display_name,
        emailConsent: channel === "email" ? consent : false,
        smsConsent: channel === "sms" ? consent : false,
        consentSource: record.consent_source,
        consentEvidenceRef: record.consent_evidence_ref,
        consentOccurredAt: record.consent_occurred_at,
      }, channel);
    } catch (error) {
      throw new Error(`CSV row ${rowNumber}: ${error instanceof Error ? error.message : "invalid contact"}`);
    }
  });
}

/** Validates opt-in evidence before a contact can enter a channel audience. */
export function validateContactImport(input: ContactImport, channel: CampaignChannel): ValidContactImport {
  const email = input.email?.trim().toLowerCase() || null;
  const phoneE164 = input.phone?.trim() || null;
  const displayName = input.displayName?.trim() || null;
  if (!email && !phoneE164) throw new Error("A contact needs an email address or phone number");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
  if (phoneE164 && !/^\+[1-9]\d{6,14}$/.test(phoneE164)) throw new Error("Enter a valid phone number in E.164 format");
  if (channel === "email" && !email) throw new Error("An email address is required for email consent");
  if (channel === "sms" && !phoneE164) throw new Error("A phone number is required for SMS consent");

  const consented = channel === "email" ? input.emailConsent : input.smsConsent;
  if (consented !== true) throw new Error(`Explicit ${channel} consent is required`);
  const source = input.consentSource?.trim();
  if (!source) throw new Error("A consent source is required");
  const evidenceRef = input.consentEvidenceRef?.trim();
  if (!evidenceRef) throw new Error("Consent evidence is required");
  const occurredAt = input.consentOccurredAt?.trim();
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) throw new Error("A valid consent time is required");

  return {
    email,
    phoneE164,
    displayName,
    consent: { channel, source, evidenceRef, occurredAt: new Date(occurredAt).toISOString() },
  };
}

/** Sender identities are resolved from verified domain records, never accepted from the draft. */
export function validateCampaignDraft(input: Record<string, unknown>, now = new Date()): CampaignDraft {
  const channel = input.channel;
  if (channel !== "email" && channel !== "sms") throw new Error("Campaign channel must be email or sms");
  const bodyText = typeof input.bodyText === "string" ? input.bodyText.trim() : "";
  if (!bodyText) throw new Error(channel === "sms" ? "SMS message is required" : "Campaign content is required");
  if (bodyText.length > (channel === "sms" ? 1600 : 500_000)) throw new Error("Campaign content is too long");

  const scheduledAt = parseFutureSchedule(input.scheduledAt, now);
  if (channel === "sms") return { channel, bodyText, ...(scheduledAt ? { scheduledAt } : {}) };

  const senderIdentityId = typeof input.senderIdentityId === "string" ? input.senderIdentityId.trim() : "";
  if (senderIdentityId && senderIdentityId.length > 128) throw new Error("Campaign sender is invalid");

  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject) throw new Error("Email subject is required");
  if (subject.length > 998) throw new Error("Email subject is too long");
  const bodyHtml = typeof input.bodyHtml === "string" ? input.bodyHtml.trim() : "";
  return { channel, ...(senderIdentityId ? { senderIdentityId } : {}), subject, bodyText, ...(bodyHtml ? { bodyHtml } : {}), ...(scheduledAt ? { scheduledAt } : {}) };
}

function parseFutureSchedule(value: unknown, now: Date): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Campaign schedule must be a valid date");
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error("Campaign schedule must be a valid date");
  if (time <= now.getTime()) throw new Error("Campaign schedule must be in the future");
  return new Date(time).toISOString();
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') {
      if (value.length) throw new Error("CSV contains a quote in an unquoted field");
      quoted = true;
    } else if (char === ",") {
      row.push(value); value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = []; value = "";
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field");
  row.push(value.replace(/\r$/, ""));
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseConsent(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized ?? "")) return true;
  if (["false", "no", "0", ""].includes(normalized ?? "")) return false;
  throw new Error("consent column must be true or false");
}
