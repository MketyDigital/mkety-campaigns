import type { SenderRepository } from "../domains/senders.js";
import type { EmailProvider, EmailSendResult } from "./providers.js";

export interface EmailTestSender {
  sendToAccountOwner(tenantId: string, senderId: string, accountEmail: string): Promise<EmailSendResult>;
  checkProviderStatus(provider: EmailSendResult["provider"], operationId: string): Promise<{ status: string; errorCode?: string }>;
}

export class TestSenderUnavailableError extends Error {
  constructor() { super("Sender is not ready for test delivery"); this.name = "TestSenderUnavailableError"; }
}

export function createEmailTestSender(repository: SenderRepository, providers: EmailProvider | EmailProvider[]): EmailTestSender {
  const configuredProviders = Array.isArray(providers) ? providers : [providers];
  return {
    async checkProviderStatus(providerName, operationId) {
      const provider = configuredProviders.find((item) => item.name === providerName);
      if (!provider?.getSendStatus) throw new TestSenderUnavailableError();
      return provider.getSendStatus(operationId);
    },
    async sendToAccountOwner(tenantId, senderId, accountEmail) {
      const sender = await repository.get(tenantId, senderId);
      const provider = sender ? configuredProviders.find((item) => item.name === sender.provider) : undefined;
      if (!sender || sender.status !== "ready" || !provider) throw new TestSenderUnavailableError();
      const recipient = accountEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new TestSenderUnavailableError();
      return provider.send({
        idempotencyKey: `test-send:${crypto.randomUUID()}`,
        from: sender.senderAddress,
        to: [recipient],
        subject: "MKETY Campaigns sender test",
        text: `This is a test message sent from the verified campaign sender ${sender.senderAddress}. No campaign was sent.`,
      });
    },
  };
}
