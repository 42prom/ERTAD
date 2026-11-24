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
export interface MemberVerificationBadge {
  assuranceLevel: string;
  sodCscaVerified: boolean;
  citizenshipCountry: string;
  verifiedAt: string | null;
  hasWebAccount: boolean;
  documentCount: number;
  activeDeviceCount: number;
  linkedGoogleCount: number;
}
export interface DirectoryMember {
  id: string;
  displayName: string | null;
  memberships: DirectoryMembership[];
  points: string | null;
  verificationStatus?: MemberVerificationBadge | null;
}
export interface MemberListPage extends MemberPage<DirectoryMember> {
  verifiedTotal?: number;
  unverifiedTotal?: number;
}
export interface MemberVerificationDocument {
  id: string;
  documentKind: "eid_card" | "passport" | "other";
  issuingCountry: string;
  sodCscaVerified: boolean;
  livenessScore?: number | null;
  faceMatchScore?: number | null;
  portraitDataUrl: string | null;
  createdAt: string;
}
export interface MemberVerificationLogEntry {
  id: string;
  sessionKind: "enrollment" | "reauth";
  status: string;
  sodCscaVerified: boolean;
  livenessScore?: number | null;
  faceMatchScore?: number | null;
  createdAt: string;
}
export interface MemberVerificationSummary {
  assuranceLevel: string;
  citizenshipCountry: string;
  sodCscaVerified: boolean;
  livenessScore?: number | null;
  faceMatchScore?: number | null;
  verifiedAt: string | null;
  portraitDataUrl: string | null;
  documentCount?: number;
  activeDeviceCount?: number;
  linkedGoogleCount?: number;
  documents?: MemberVerificationDocument[];
  verificationLog?: MemberVerificationLogEntry[];
}
export interface MemberDetail extends DirectoryMember {
  canPropose: boolean;
  pointsScopes: MemberUnit[];
  verification?: MemberVerificationSummary | null;
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
    verification?: "all" | "verified" | "unverified";
    page: number;
  }) => get<MemberListPage>("list", params),
  detail: (
    organizationId: string,
    memberId: string,
    unitId: string | undefined,
    page: number,
  ) => get<MemberDetail>("detail", { organizationId, memberId, unitId, page }),
};
