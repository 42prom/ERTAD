import client from "./client";
export interface EvidenceScope {
  organizationId: string;
  workId: string;
}
export interface EvidenceList {
  canUpload: boolean;
  canRemove?: boolean;
  items: {
    id: string;
    bytes: number;
    createdAt: string;
    expiresAt: string;
    mine?: boolean;
    mediaType?: string;
  }[];
}
export const evidenceApi = {
  list: async (params: EvidenceScope): Promise<EvidenceList> =>
    (await client.get("/admin/work-evidence", { params })).data,
  upload: async (
    params: EvidenceScope & { key: string },
    file: Blob,
  ): Promise<{ id: string }> =>
    (
      await client.post("/admin/work-evidence", file, {
        params,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    ).data,
  download: async (params: EvidenceScope & { id: string }): Promise<Blob> =>
    (
      await client.get("/admin/work-evidence/download", {
        params,
        responseType: "blob",
      })
    ).data,
};
