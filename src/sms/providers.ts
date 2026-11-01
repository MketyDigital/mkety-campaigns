export type SmsMessage = {
  /** Stored by the delivery job for reconciliation; the adapter does not automatically retry. */
  idempotencyKey: string;
  /** Resolved server-side from an approved sender for this tenant. */
  from: string;
  /** E.164 destination after country and consent checks. */
  to: string;
  text: string;
};

export type SmsSendResult = {
  provider: "telnyx-sms";
  providerMessageId: string;
};

export interface SmsProvider {
  readonly name: SmsSendResult["provider"];
  send(message: SmsMessage): Promise<SmsSendResult>;
}

type Fetcher = typeof fetch;

export function createTelnyxSmsProvider(config: {
  apiKey: string;
  fetcher?: Fetcher;
}): SmsProvider {
  const apiKey = required(config.apiKey, "TELNYX_API_KEY");
  const fetcher = config.fetcher ?? fetch;

  return {
    name: "telnyx-sms",
    async send(message) {
      validateMessage(message);
      const response = await fetcher("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          text: message.text,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`Telnyx SMS request failed with HTTP ${response.status}`);
      }
      const providerMessageId = getMessageId(payload);
      if (!providerMessageId) {
        throw new Error("Telnyx SMS response did not include a message ID");
      }
      return { provider: "telnyx-sms", providerMessageId };
    },
  };
}

export function createOptionalSmsProvider(env: Record<string, string | undefined>): SmsProvider | undefined {
  if (env.SMS_ENABLED !== "true") return undefined;
  if (env.SMS_PROVIDER !== "telnyx") {
    throw new Error("SMS_PROVIDER must be set to a supported provider when SMS_ENABLED=true");
  }
  return createTelnyxSmsProvider({ apiKey: required(env.TELNYX_API_KEY, "TELNYX_API_KEY") });
}

function validateMessage(message: SmsMessage): void {
  if (!message.idempotencyKey.trim()) throw new Error("SMS idempotency key is required");
  if (!message.from.trim()) throw new Error("SMS sender is required");
  if (!/^\+[1-9]\d{6,14}$/.test(message.to)) throw new Error("SMS destination must be in E.164 format");
  if (!message.text.trim()) throw new Error("SMS text is required");
}

function getMessageId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) return undefined;
  const data = payload.data;
  if (typeof data !== "object" || data === null || !("id" in data)) return undefined;
  return typeof data.id === "string" && data.id.length > 0 ? data.id : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
