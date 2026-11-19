import client from "./client";
import type { PositionGrant } from "./positions";
export interface CollectiveContext {
  id: string;
  name: string;
}
export interface CollectiveUnit extends CollectiveContext {
  canPropose: boolean;
  canManage: boolean;
  policy: { version: number; method: string; minimum: number };
}
export interface Proposal {
  invitationRecipient?: { displayName: string | null; unitName: string; contactHint: string } | null;
  recognitionSource?: {
    kind: "verified_task";
    workTitle: string | null;
  } | null;
  attachment?: {
    id: string;
    mediaType: string;
    bytes: number;
  } | null;
  id: string;
  unitId: string;
  workId: string | null;
  kind: string;
  parameters: Record<string, string | number | boolean | PositionGrant[]>;
  proposerId: string;
  reason: string;
  version: number;
  status: string;
  deadline: string;
  threshold: number;
  eligibleCount: number;
  approvedCount: number;
  canVote: boolean;
  canWithdraw: boolean;
  votes: {
    actorId: string;
    choice: string;
    reason: string;
    at: string;
    currentlyEligible: boolean;
  }[];
}
export interface CollectiveWrite {
  operation: string;
  organizationId: string;
  key: string;
  id?: string;
  version?: number;
  unitId?: string;
  workId?: string;
  kind?: string;
  parameters?: Record<string, string | number | boolean | PositionGrant[]>;
  reason?: string;
  deadline?: string;
  choice?: string;
  amount?: string;
  pledgeId?: string;
  attachmentId?: string;
}
export interface PointsRule {
  templateId?: string | null;
  title?: string;
  allowedUnitId?: string | null;
  id: string;
  category: string;
  version: number;
  enabled: boolean;
  amount: number;
  memberMonthCap: number;
  issuerMonthCap: number;
}
export interface RecognitionContext {
  canAward: boolean;
  unitId?: string;
  rule?: {
    id: string;
    amount: number;
    memberMonthCap: number;
    issuerMonthCap: number;
  } | null;
  participants: {
    memberId: string;
    activityId: string;
    state: "available" | "pending" | "awarded";
  }[];
}
export interface PointsView {
  actorId: string;
  memberId: string;
  rootUnitId: string;
  canManageRules: boolean;
  canAward: boolean;
  balance: string;
  total: number;
  page: number;
  rules: PointsRule[];
  entries: {
    recognitionSource?: {
      kind: "verified_task";
      workTitle: string | null;
    } | null;
    rewardTitle?: string;
    id: string;
    kind: string;
    category: string;
    points: number;
    unitId: string;
    reason: string;
    date: string;
    reversesId: string | null;
  }[];
}
export interface FundingView {
  actorId: string;
  canRecord: boolean;
  canParticipate: boolean;
  canReadRecords: boolean;
  target: null | {
    currency: string;
    goal: string;
    purpose: string;
    version: number;
    isEnvelope: boolean;
    suppressed: boolean;
    totals: null | Record<string, string | null>;
  };
  entries?: {
    id: string;
    kind: string;
    amount: string;
    workId: string;
    referenceId: string | null;
    externalRef: string | null;
    memberId: string | null;
  }[];
  pledges?: {
    id: string;
    amount: string;
    withdrawn: boolean;
    fulfilled: string;
    remaining: string;
  }[];
}
export const collectiveApi = {
  recognition: async (
    organizationId: string,
    workId: string,
  ): Promise<RecognitionContext> =>
    (
      await client.get("/admin/collective/recognition", {
        params: { organizationId, workId },
      })
    ).data,
  ack: async (
    organizationId: string,
    id: string,
    version: number,
  ): Promise<void> => {
    await client.post("/admin/collective/ack", { organizationId, id, version });
  },
  pointContexts: async (): Promise<CollectiveContext[]> =>
    (await client.get("/admin/collective/point_contexts")).data,
  points: async (params: {
    organizationId: string;
    unitId?: string;
    memberId?: string;
    entryId?: string;
    page: number;
  }): Promise<PointsView> =>
    (await client.get("/admin/collective/points", { params })).data,
  contexts: async (): Promise<CollectiveContext[]> =>
    (await client.get("/admin/collective/contexts")).data,
  units: async (organizationId: string): Promise<CollectiveUnit[]> =>
    (
      await client.get("/admin/collective/units", {
        params: { organizationId },
      })
    ).data,
  list: async (params: {
    organizationId: string;
    page: number;
    view: string;
    workId?: string;
  }): Promise<{ items: Proposal[]; total: number; page: number }> =>
    (await client.get("/admin/collective/list", { params })).data,
  detail: async (organizationId: string, id: string): Promise<Proposal> =>
    (
      await client.get("/admin/collective/detail", {
        params: { organizationId, id },
      })
    ).data,
  write: async (
    input: CollectiveWrite,
  ): Promise<{ id: string; version?: number }> => {
    const { operation, ...body } = input;
    return (await client.post("/admin/collective/" + operation, body)).data;
  },
  funding: async (
    organizationId: string,
    workId: string,
  ): Promise<FundingView> =>
    (
      await client.get("/admin/collective/funding", {
        params: { organizationId, workId },
      })
    ).data,
  uploadAttachment: async (
    organizationId: string,
    unitId: string,
    file: File,
  ): Promise<{ id: string; mediaType: string; bytes: number }> =>
    (
      await client.post("/admin/collective/attachment", await file.arrayBuffer(), {
        params: { organizationId, unitId, key: crypto.randomUUID() },
        headers: { "Content-Type": file.type || "application/octet-stream" },
      })
    ).data,
  downloadAttachment: async (
    organizationId: string,
    attachmentId: string,
  ): Promise<Blob> =>
    (
      await client.get("/admin/collective/attachment/download", {
        params: { organizationId, attachmentId },
        responseType: "blob",
      })
    ).data,
};
// Amounts travel as integer strings; decimal user input never passes through floating point.
export function minorUnits(value: string): string {
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(value))
    throw new Error("INVALID_AMOUNT");
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result < 1n || result > 99999999999n) throw new Error("INVALID_AMOUNT");
  return result.toString();
}
export function displayMoney(
  value: string | undefined | null,
  currency: string,
): string {
  if (value == null) return "—";
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  return `${n < 0n ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")} ${currency}`;
}
