import client from "./client";
export interface ChannelRestriction {
  id: string;
  channelId: string;
  channelTitle: string;
  participantTag: number;
  mine: boolean;
  reason: string;
  createdAt: string;
  expiresAt: string;
  appeal: string | null;
  appealedAt: string | null;
  outcome: "uphold" | "lift" | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  version: number;
  active: boolean;
  canAppeal: boolean;
  canReview: boolean;
}
export type ChannelEmoji = "like" | "confirm" | "heart" | "eyes" | "celebrate";
export interface ChannelReactionSummary {
  emoji: ChannelEmoji;
  count: number;
  mine: boolean;
}
export interface ChannelAttachmentMeta {
  id: string;
  mediaType: "image/png" | "application/pdf";
  bytes: number;
}
export interface ChannelParticipant {
  id: string;
  tag: number | null;
  displayName: string | null;
}
export interface Channel {
  postingRestriction?: { id: string; expiresAt: string; reason: string } | null;
  workId?: string | null;
  workStatus?: string | null;
  pinnedMessage?: { id: string; seq: number; body: string } | null;
  id: string;
  unitId: string;
  title: string;
  archived: boolean;
  version: number;
  lastSeq: number;
  readSeq: number;
  muted: boolean;
  unread: number;
  reports: number;
  canPost: boolean;
  canManage: boolean;
  canModerate: boolean;
}
export interface ChannelMessage {
  canRestrict?: boolean;
  reactions?: ChannelReactionSummary[];
  attachment?: ChannelAttachmentMeta | null;
  id: string;
  seq: number;
  body: string;
  removed: boolean;
  mine: boolean;
  authorTag: number;
  replySeq: number | null;
  createdAt: string;
}
export interface ChannelThread {
  channel: Channel;
  items: ChannelMessage[];
  hasOlder: boolean;
}
export interface ChannelReport {
  id: string;
  seq: number;
  body: string;
  removed: boolean;
  category: string;
}
export type ChannelWrite = {
  operation:
    | "restrict"
    | "appeal"
    | "review-appeal"
    | "work-create"
    | "create"
    | "post"
    | "read"
    | "mute"
    | "archive"
    | "remove"
    | "report"
    | "resolve"
    | "react"
    | "pin";
  organizationId: string;
  key: string;
} & Record<string, unknown>;
export const channelsApi = {
  restriction: async (
    organizationId: string,
    restrictionId: string,
  ): Promise<ChannelRestriction> =>
    (
      await client.get("/admin/channels/restriction", {
        params: { organizationId, restrictionId },
      })
    ).data,
  restrictions: async (
    organizationId: string,
    view: "pending" | "mine" | "history",
    page = 1,
  ): Promise<{ items: ChannelRestriction[]; total: number; page: number }> =>
    (
      await client.get("/admin/channels/restrictions", {
        params: { organizationId, view, page },
      })
    ).data,
  work: async (
    organizationId: string,
    workId: string,
  ): Promise<{ id: string | null; canCreate: boolean }> =>
    (
      await client.get("/admin/channels/work", {
        params: { organizationId, workId },
      })
    ).data,
  contexts: async (): Promise<{ id: string; name: string }[]> =>
    (await client.get("/admin/channels/contexts")).data,
  units: async (
    organizationId: string,
    page = 1,
  ): Promise<{ items: { id: string; name: string }[]; page: number }> =>
    (
      await client.get("/admin/channels/units", {
        params: { organizationId, page },
      })
    ).data,
  list: async (
    organizationId: string,
    view: string,
    page = 1,
  ): Promise<{ items: Channel[]; total: number; page: number }> =>
    (
      await client.get("/admin/channels/list", {
        params: { organizationId, view, page },
      })
    ).data,
  thread: async (
    organizationId: string,
    id: string,
    before = 0,
  ): Promise<ChannelThread> =>
    (
      await client.get("/admin/channels/thread", {
        params: { organizationId, id, before },
      })
    ).data,
  search: async (
    organizationId: string,
    id: string,
    search: string,
  ): Promise<ChannelThread> =>
    (
      await client.get("/admin/channels/search", {
        params: { organizationId, id, search },
      })
    ).data,
  participants: async (
    organizationId: string,
    id: string,
  ): Promise<{ items: ChannelParticipant[] }> =>
    (
      await client.get("/admin/channels/participants", {
        params: { organizationId, id },
      })
    ).data,
  uploadAttachment: async (
    organizationId: string,
    id: string,
    key: string,
    file: File,
  ): Promise<ChannelAttachmentMeta> =>
    (
      await client.post("/admin/channels/attachment", file, {
        params: { organizationId, id, key },
        headers: { "Content-Type": file.type || "application/octet-stream" },
      })
    ).data,
  downloadAttachment: async (
    organizationId: string,
    id: string,
    attachmentId: string,
  ): Promise<Blob> =>
    (
      await client.get("/admin/channels/attachment/download", {
        params: { organizationId, id, attachmentId },
        responseType: "blob",
      })
    ).data,
  reports: async (
    organizationId: string,
    id: string,
    page = 1,
  ): Promise<{ items: ChannelReport[]; total: number; page: number }> =>
    (
      await client.get("/admin/channels/reports", {
        params: { organizationId, id, page },
      })
    ).data,
  write: async (
    input: ChannelWrite,
  ): Promise<{ id: string; messageId?: string; seq?: number }> => {
    const { operation, ...data } = input;
    return (await client.post("/admin/channels/" + operation, data)).data;
  },
};
