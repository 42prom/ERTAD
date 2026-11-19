import client from "./client";
import type { PolicyReviewInput, ProviderReason } from "./platform";
export interface MailValues {
  provider: "none" | "sendgrid" | "smtp";
  mode: "off" | "enabled";
  senderName: string;
  senderEmail: string;
  deliveryEnabled?: boolean;
  publicOrigin?: string;
  smtpService?: "sendgrid" | "gmail" | "office365";
  smtpUser?: string;
}
export interface MailProposal extends MailValues {
  id: string;
  mine: boolean;
  expectedVersion: number;
  version: number | null;
  hasCredential: boolean;
  reason: ProviderReason;
  createdAt: string;
  expiresAt: string;
  reviewedAt: string | null;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "expired";
}
export interface MailPolicyList {
  delivery?: Partial<
    Record<
      | "queued"
      | "sending"
      | "retry"
      | "accepted"
      | "failed"
      | "uncertain"
      | "cancelled",
      number
    >
  >;
  current: MailValues & { version: number; hasCredential: boolean };
  items: MailProposal[];
  nextBefore: string | null;
}
export const mailPolicyApi = {
  list: (before?: string) =>
    client
      .get<MailPolicyList>("/admin/platform/mail-policy", {
        params: { before },
      })
      .then((r) => r.data),
  propose: (
    input: MailValues & {
      requestId: string;
      expectedVersion: number;
      reason: ProviderReason;
      apiKey?: string;
    },
  ) =>
    client
      .post<{ id: string }>("/admin/platform/mail-policy/propose", input)
      .then((r) => r.data),
  review: (input: PolicyReviewInput) =>
    client
      .post<{ id: string }>("/admin/platform/mail-policy/review", input)
      .then((r) => r.data),
  check: (expectedVersion: number) =>
    client
      .post<{ version: number; status: "valid" | "unavailable" | "off" }>(
        "/admin/platform/mail-policy/check",
        { expectedVersion },
      )
      .then((r) => r.data),
};
