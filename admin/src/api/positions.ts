import client from "./client";
export interface PositionGrant {
  permission: string;
  scope: "unit" | "subtree";
}
export interface PositionDefinition {
  id: string;
  unitId: string;
  unitName: string;
  name: string;
  revision: number;
  version: number;
  predecessorId: string | null;
  status: string;
  canRevise: boolean;
  canRetire: boolean;
  canRollout?: boolean;
  retirementBlocked: boolean;
  grants: PositionGrant[];
}
export interface PositionUnit {
  id: string;
  name: string;
  canPropose: boolean;
  grants: PositionGrant[];
}
export interface PositionCatalogue {
  items: PositionDefinition[];
  units: PositionUnit[];
  total: number;
  page: number;
}
export const positionsApi = {
  contexts: () =>
    client
      .get<{ id: string; name: string }[]>(
        "/admin/collective/position_contexts",
      )
      .then((r) => r.data),
  list: (organizationId: string, search = "", page = 1, includeGrants = false) =>
    client
      .get<PositionCatalogue>("/admin/collective/positions", {
        params: { organizationId, search, page, includeGrants },
      })
      .then((r) => r.data),
};
