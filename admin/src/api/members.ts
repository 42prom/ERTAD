import client from "./client";
export interface MemberUnit {
  id: string;
  name: string;
}
export interface MemberPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface DirectoryMembership {
  canChange?: boolean;
  id: string;
  unitId: string;
  unitName: string;
  positionId: string;
  positionName: string;
  status: string;
  validFrom: string;
  validUntil: string | null;
}
export interface DirectoryMember {
  id: string;
  displayName: string | null;
  memberships: DirectoryMembership[];
  points: string | null;
}
export interface MemberDetail extends DirectoryMember {
  canPropose: boolean;
  pointsScopes: MemberUnit[];
  work: MemberPage<{
    id: string;
    title: string;
    status: string;
    progress: number;
  }> & { verified: number };
}
const get = async <T>(path: string, params: object) =>
  (await client.get<T>("/admin/members/" + path, { params })).data;
export const membersApi = {
  contexts: () => get<MemberUnit[]>("contexts", {}),
  units: (organizationId: string, search: string, page: number) =>
    get<MemberPage<MemberUnit>>("units", { organizationId, search, page }),
  list: (params: {
    organizationId: string;
    unitId?: string;
    search: string;
    role: string;
    status: string;
    page: number;
  }) => get<MemberPage<DirectoryMember>>("list", params),
  detail: (
    organizationId: string,
    memberId: string,
    unitId: string | undefined,
    page: number,
  ) => get<MemberDetail>("detail", { organizationId, memberId, unitId, page }),
};
