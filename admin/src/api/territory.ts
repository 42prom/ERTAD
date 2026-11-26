import client from "./client";

export interface AdmissionPositionOption {
  id: string;
  name: string;
  bundleVersion: number;
}

export interface GroupAdmissionOptions {
  unitId: string;
  admissionOpen: boolean;
  admissionPositionId: string | null;
  eligiblePositions: AdmissionPositionOption[];
}

export const territoryApi = {
  groupOptions: async (
    organizationId: string,
    unitId: string,
  ): Promise<GroupAdmissionOptions> =>
    (
      await client.get("/admin/territory/group-options", {
        params: { organizationId, unitId },
      })
    ).data,
  configureGroup: async (data: {
    organizationId: string;
    unitId: string;
    admissionOpen: boolean;
    admissionPositionId?: string | null;
  }) => (await client.post("/admin/territory/group-settings", data)).data,
};
