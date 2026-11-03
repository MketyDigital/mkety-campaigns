import type { CampaignChannel, CampaignDraft, ValidContactImport } from "./service.js";

export type ContactSummary = {
  id: string;
  email: string | null;
  phoneE164: string | null;
  displayName: string | null;
  createdAt: string;
};

export type CampaignSummary = CampaignDraft & {
  id: string;
  tenantId: string;
  status: string;
  createdAt: string;
};

export interface CampaignWorkspace {
  listContacts(tenantId: string): Promise<ContactSummary[]>;
  importContacts(tenantId: string, channel: CampaignChannel, rows: ValidContactImport[]): Promise<{ imported: number }>;
  listCampaigns(tenantId: string): Promise<CampaignSummary[]>;
  createCampaign(tenantId: string, draft: CampaignDraft): Promise<CampaignSummary>;
  submitForReview(tenantId: string, campaignId: string): Promise<CampaignSummary | null>;
  listCampaignsInReview(): Promise<CampaignSummary[]>;
  listApprovedCampaigns(): Promise<CampaignSummary[]>;
  reviewCampaign(campaignId: string, reviewerUserId: string, decision: "approve" | "reject"): Promise<CampaignSummary | null>;
  withdrawConsent(tenantId: string, contactId: string, channel: CampaignChannel): Promise<boolean>;
  unsubscribe(token: string): Promise<boolean>;
}
