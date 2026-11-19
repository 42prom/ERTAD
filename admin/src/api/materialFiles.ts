import client from "./client";
import type { EvidenceScope, EvidenceList } from "./evidence";
export const materialFilesApi = {
  list: async (params: EvidenceScope): Promise<EvidenceList> =>
    (await client.get("/admin/work-material-files", { params })).data,
  upload: async (
    params: EvidenceScope & { key: string },
    file: Blob,
  ): Promise<{ id: string }> =>
    (
      await client.post("/admin/work-material-files", file, {
        params,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      })
    ).data,
  download: async (params: EvidenceScope & { id: string }): Promise<Blob> =>
    (
      await client.get("/admin/work-material-files/download", {
        params,
        responseType: "blob",
      })
    ).data,
  remove: async (params: EvidenceScope & { id: string }): Promise<void> => {
    await client.post("/admin/work-material-files/remove", params);
  },
};
