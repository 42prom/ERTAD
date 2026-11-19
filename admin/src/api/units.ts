import client from "./client";
export interface UnitContext {
  id: string;
  name: string;
}
export interface UnitRow {
  id: string;
  name: string;
  parent_id: string | null;
  parent_name: string | null;
  kind: string;
  canPropose: boolean;
  canChange: boolean;
  version: number;
  status: "active" | "archived";
  archiveBlockers: string[];
}
export interface UnitReview {
  kind: "create" | "rename" | "archive" | "restore";
  original_name: string | null;
  target_id: string | null;
  id: string;
  name: string;
  parent_id: string;
  parent_name: string;
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  expires_at: string;
}
export interface UnitDetail extends UnitReview {
  reason: string;
  decision_reason: string | null;
  decision_at: string | null;
  canDecide: boolean;
  unit_id: string | null;
}
export interface UnitPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface UnitProposal {
  organizationId: string;
  parentId: string;
  name: string;
  reason: string;
  expiresAt: string;
  key: string;
}
export interface UnitChange {
  organizationId: string;
  unitId: string;
  version: number;
  kind: "rename" | "archive" | "restore";
  name?: string;
  reason: string;
  expiresAt: string;
  key: string;
}
export interface UnitDecision {
  organizationId: string;
  id: string;
  decision: "approved" | "rejected";
  reason: string;
  key: string;
}
const base = "/admin/units";
export const unitApi = {
  contexts: async (): Promise<UnitContext[]> =>
    (await client.get(base + "/contexts")).data,
  units: async (
    organizationId: string,
    page: number,
    search = "",
    status: "active" | "archived" = "active",
  ): Promise<UnitPage<UnitRow>> =>
    (
      await client.get(base, {
        params: { organizationId, page, search, status },
      })
    ).data,
  reviews: async (
    organizationId: string,
    page: number,
    view: string,
  ): Promise<UnitPage<UnitReview>> =>
    (
      await client.get(base + "/reviews", {
        params: { organizationId, page, view },
      })
    ).data,
  detail: async (organizationId: string, id: string): Promise<UnitDetail> =>
    (await client.get(base + "/detail", { params: { organizationId, id } }))
      .data,
  propose: async (data: UnitProposal) =>
    (await client.post(base + "/reviews", data)).data,
  change: async (data: UnitChange) =>
    (await client.post(base + "/changes", data)).data,
  decide: async (data: UnitDecision) =>
    (await client.post(base + "/decision", data)).data,
};
