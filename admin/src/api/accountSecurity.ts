import client from "./client";

export type HoldReason = "suspected_compromise" | "credential_exposure";
export type LifecycleAction =
  | "disable_account"
  | "restore_account"
  | "lost_contact_recovery"
  | "mfa_reset";
export type LifecycleReason =
  | "policy_violation"
  | "departure"
  | "account_restoration"
  | "lost_contact"
  | "lost_mfa_device"
  | "mfa_compromise";
export type LifecycleStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "expired";

export interface PendingLifecycleProposal {
  id: string;
  action: LifecycleAction;
  reason: LifecycleReason;
  createdAt: string;
  expiresAt: string;
  mine: boolean;
  newEmailHint: string | null;
}

export interface LifecycleProposal extends PendingLifecycleProposal {
  accountId: string;
  status: LifecycleStatus;
  reviewedAt: string | null;
}

export interface SecurityAccount {
  id: string;
  active: boolean;
  recoverable: boolean;
  createdAt: string;
  mfaEnabled?: boolean;
  mfaProvisioned?: boolean;
  lostContactEligible?: boolean;
  pendingProposals?: PendingLifecycleProposal[];
  hold: null | {
    id: string;
    heldAt: string;
    reason: HoldReason;
    own: boolean;
    credentialChanged: boolean;
  };
}

export interface SecurityAccounts {
  items: SecurityAccount[];
  nextBefore: string | null;
  proposals?: LifecycleProposal[];
}

export const accountSecurityApi = {
  list: (state: string, before?: string, accountId?: string) =>
    client
      .get<SecurityAccounts>("/admin/platform/accounts", {
        params: { state, before, accountId },
      })
      .then((r) => r.data),
  hold: (accountId: string, requestId: string, reason: HoldReason) =>
    client
      .post("/admin/platform/accounts/hold", { accountId, requestId, reason })
      .then((r) => r.data),
  release: (holdId: string, requestId: string) =>
    client
      .post("/admin/platform/accounts/release", { holdId, requestId })
      .then((r) => r.data),
  proposeLifecycle: (input: {
    accountId: string;
    requestId: string;
    action: LifecycleAction;
    reason: LifecycleReason;
    newEmail?: string;
  }) =>
    client
      .post("/admin/platform/accounts/lifecycle/propose", input)
      .then((r) => r.data),
  reviewLifecycle: (
    proposalId: string,
    requestId: string,
    decision: "approve" | "reject" | "withdraw",
  ) =>
    client
      .post("/admin/platform/accounts/lifecycle/review", {
        proposalId,
        requestId,
        decision,
      })
      .then((r) => r.data),
};
