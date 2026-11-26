import client from "./client";
import type { PositionGrant } from "./positions";
export interface RevisionComparison {
  sourceName: string;
  destinationName: string;
  added: PositionGrant[];
  removed: PositionGrant[];
  unchanged: PositionGrant[];
}
export interface RevisionOptions {
  definitionKey: string;
  comparison: RevisionComparison;
  total: number;
  page: number;
  items: {
    id: string;
    memberId: string;
    displayName: string | null;
    version: number;
    state: string;
    validUntil: string | null;
    blocker: string | null;
    review: { id: string; status: ReviewStatus } | null;
  }[];
}
export interface ReviewContext {
  id: string;
  name: string;
  positions: {
    id: string;
    name: string;
    unitId: string;
    unitName: string;
    canPropose: boolean;
  }[];
}
export type ReviewStatus = "pending" | "approved" | "rejected" | "expired";
export interface ReviewRow {
  kind?: "grant" | "transfer" | "revoke" | "suspend" | "resume" | "revision" | "admission";
  id: string;
  requester_id: string;
  unit_id: string;
  position_id: string;
  unit_name: string;
  position_name: string;
  created_at: string;
  expires_at: string;
  status: ReviewStatus;
}
export interface ReviewDetail extends ReviewRow {
  comparison?: RevisionComparison;
  sourceValidUntil?: string | null;
  sourceUnitName?: string | null;
  sourcePositionName?: string | null;
  target_id: string;
  reason: string;
  valid_until: string | null;
  bundle_version: number;
  decision_by: string | null;
  decision_reason: string | null;
  decision_at: string | null;
  canDecide: boolean;
}
export interface ReviewList {
  items: ReviewRow[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ReviewNotification {
  id: string;
  status: ReviewStatus;
  created_at: string;
  read_at: string | null;
}
export interface Proposal {
  organizationId: string;
  key: string;
  positionId: string;
  targetId: string;
  reason: string;
  expiresAt: string;
  validUntil: string;
}
export interface ReviewDecision {
  organizationId: string;
  id: string;
  key: string;
  decision: "approved" | "rejected";
  reason: string;
}
export interface MembershipChange {
  organizationId: string;
  membershipId: string;
  version: number;
  key: string;
  kind: "transfer" | "revoke" | "suspend" | "resume" | "revision";
  definitionKey?: string;
  positionId?: string;
  validUntil?: string;
  expiresAt: string;
  reason: string;
}
export interface MembershipChangeOptions {
  id: string;
  version: number;
  active: boolean;
  state: string;
  canSuspend: boolean;
  canResume: boolean;
  canRevoke: boolean;
  blocked: boolean;
  validUntil: string | null;
  unitName: string;
  positionName: string;
  destinations: { id: string; name: string; unitName: string }[];
}
const base = "/admin/reviews";
export const reviewApi = {
  revisionOptions: async (
    organizationId: string,
    positionId: string,
    search = "",
    page = 1,
  ): Promise<RevisionOptions> =>
    (
      await client.get(`${base}/revision-options`, {
        params: { organizationId, positionId, search, page },
      })
    ).data,
  changeOptions: async (
    organizationId: string,
    membershipId: string,
  ): Promise<MembershipChangeOptions> =>
    (
      await client.get(`${base}/change-options`, {
        params: { organizationId, membershipId },
      })
    ).data,
  change: async (
    data: MembershipChange,
  ): Promise<{ id: string; status: ReviewStatus }> =>
    (await client.post(`${base}/changes`, data)).data,
  contexts: async (): Promise<ReviewContext[]> =>
    (await client.get(`${base}/contexts`)).data,
  list: async (params: {
    organizationId: string;
    view: string;
    status?: string;
    search?: string;
    page: number;
    unitId?: string;
    from?: string;
    to?: string;
  }): Promise<ReviewList> => (await client.get(base, { params })).data,
  detail: async (organizationId: string, id: string): Promise<ReviewDetail> =>
    (await client.get(`${base}/detail`, { params: { organizationId, id } }))
      .data,
  propose: async (
    data: Proposal,
  ): Promise<{ id: string; status: ReviewStatus }> =>
    (await client.post(base, data)).data,
  decide: async (
    data: ReviewDecision,
  ): Promise<{ id: string; status: ReviewStatus }> =>
    (await client.post(`${base}/decision`, data)).data,
  notifications: async (
    organizationId: string,
  ): Promise<{ items: ReviewNotification[] }> =>
    (await client.get(`${base}/notifications`, { params: { organizationId } }))
      .data,
  read: async (organizationId: string, id: string): Promise<void> => {
    await client.post(`${base}/read`, { organizationId, id });
  },
};
