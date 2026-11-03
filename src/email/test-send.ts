import type { SenderRepository } from "../domains/senders.js";
import type { EmailProvider, EmailSendResult } from "./providers.js";

export interface EmailTestSender {
  sendToAccountOwner(tenantId: string, senderId: string, accountEmail: string): Promise<EmailSendResult>;
}

export class TestSenderUnavailableError extends Error {
  constructor() { super("Sender is not ready for test delivery"); this.name = "TestSenderUnavailableError"; }
}

export function createEmailTestSender(repository: SenderRepository, provider: EmailProvider): EmailTestSender {
  return {
    async sendToAccountOwner(tenantId, senderId, accountEmail) {
      const sender = await repository.get(tenantId, senderId);
      if (!sender || sender.status !== "ready" || sender.provider !== provider.name) throw new TestSenderUnavailableError();
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
