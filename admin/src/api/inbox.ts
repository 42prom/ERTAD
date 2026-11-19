import client from "./client";
export type InboxSource =
  | "membership"
  | "unit"
  | "work"
  | "collective"
  | "decision"
  | "moderation"
  | "contribution"
  | "event";
export interface InboxSummary {
  contexts: { id: string; name: string }[];
  unread: number;
  actionRequired: number;
}
export interface InboxItem {
  source: InboxSource;
  id: string;
  version: number;
  unitId: string;
  unitName: string | null;
  title: string;
  status: string;
  updatedAt: string;
  deadline: string | null;
  unread: boolean;
  action: string;
}
export interface InboxPage {
  items: InboxItem[];
  total: number;
  unread: number;
  actionRequired: number;
  page: number;
  pageSize: number;
}
export const inboxApi = {
  summary: async (): Promise<InboxSummary> =>
    (await client.get("/admin/inbox/summary")).data,
  list: async (params: {
    organizationId: string;
    view: string;
    source: string;
    page: number;
  }): Promise<InboxPage> => (await client.get("/admin/inbox", { params })).data,
  read: async (input: {
    organizationId: string;
    source: InboxSource;
    id: string;
    version: number;
  }): Promise<void> => {
    await client.post("/admin/inbox/read", input);
  },
};
