import type { EmailProvider, EmailSendResult } from "../email/providers.js";

export type CampaignDeliveryJob = {
  id: string;
  tenantId: string;
  campaignId: string;
  contactId: string;
  provider: EmailSendResult["provider"];
  idempotencyKey: string;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  unsubscribeUrl?: string;
};

export interface CampaignDeliveryRepository {
  /** Claims a single due job and rechecks consent/suppression immediately before returning it. */
  claimNext(): Promise<CampaignDeliveryJob | null>;
  markAccepted(id: string, result: EmailSendResult): Promise<void>;
  /** Provider timeouts and local persistence failures are ambiguous; they must not be auto-retried. */
  markUncertain(id: string, reason: string): Promise<void>;
  isEmergencyStopActive?(): Promise<boolean>;
}

export interface EmailCampaignWorker {
  processOne(): Promise<boolean>;
}

const UNCERTAIN_REASON = "Provider outcome is uncertain; reconcile before retrying.";

export function createEmailCampaignWorker(
  repository: CampaignDeliveryRepository,
  providers: EmailProvider | EmailProvider[],
  enabled: boolean,
): EmailCampaignWorker {
  return {
    async processOne() {
      if (!enabled) return false;
      if (repository.isEmergencyStopActive && await repository.isEmergencyStopActive()) return false;
      const job = await repository.claimNext();
      if (!job) return false;
      const provider = Array.isArray(providers) ? providers.find((candidate) => candidate.name === job.provider) : providers.name === job.provider ? providers : undefined;
      if (!provider) {
        await repository.markUncertain(job.id, "The selected sender provider is not configured.");
        return true;
      }
      if (!hasValidUnsubscribeUrl(job.unsubscribeUrl)) {
        await repository.markUncertain(job.id, "A valid HTTPS unsubscribe link is required before delivery.");
        return true;
      }
      try {
        const result = await provider.send({
          idempotencyKey: job.idempotencyKey,
          from: job.from,
          to: [job.to],
          subject: job.subject,
          text: job.unsubscribeUrl ? `${job.bodyText}\n\nUnsubscribe: ${job.unsubscribeUrl}` : job.bodyText,
          ...(job.bodyHtml ? { html: job.unsubscribeUrl ? `${job.bodyHtml}<p><a href="${escapeAttribute(job.unsubscribeUrl)}">Unsubscribe</a></p>` : job.bodyHtml } : {}),
          ...(job.unsubscribeUrl ? { headers: {
            "List-Unsubscribe": `<${job.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          } } : {}),
        });
        await repository.markAccepted(job.id, result);
      } catch {
        try { await repository.markUncertain(job.id, UNCERTAIN_REASON); } catch { /* Lease recovery records this as uncertain. */ }
      }
      return true;
    },
  };
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function hasValidUnsubscribeUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost"))
      && !url.username && !url.password
      && url.pathname === "/unsubscribe"
      && Boolean(url.searchParams.get("token"));
  } catch {
    return false;
  }
}
