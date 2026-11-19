import client from "./client";
import type { WorkDetail, WorkItem } from "./work";

export interface EventLinkedSummary {
  totalTasks: number;
  openTasks: number;
  verifiedOpenTasks: number;
  cancellableOpenTasks: number;
  completedTasks: number;
  cancelledTasks: number;
  claimsCount: number;
}

export interface EventHistoryEntry {
  version: number;
  action: "edit" | "complete" | "cancel";
  note: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface MobilizationEvent {
  id: string;
  unitId: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  status: "open" | "completed" | "cancelled";
  version: number;
  canManage: boolean;
  rewardPolicy: "once_per_event";
  contributionOffer: WorkDetail["contributionOffer"];
  capacityLimit?: number | null;
  goingCount?: number;
  waitlistCount?: number;
  checkedInCount?: number;
  myRsvp?: {
    status: "going" | "waitlist" | "cancelled" | "checked_in";
    checkinCode: string | null;
  } | null;
}

export interface EventDetail extends MobilizationEvent {
  tasks: WorkItem[];
  linkedSummary?: EventLinkedSummary;
  history?: EventHistoryEntry[];
}

export type EventWrite = { organizationId: string; key: string } & (
  | {
      operation: "event_create";
      unitId: string;
      title: string;
      description: string;
      location: string;
      startsAt: string;
      endsAt: string;
      contributionRuleId: string | null;
      capacityLimit?: number | null;
    }
  | {
      operation: "event_edit";
      id: string;
      version: number;
      title: string;
      description: string;
      location: string;
      startsAt: string;
      endsAt: string;
      note: string;
      capacityLimit?: number | null;
    }
  | {
      operation: "event_complete" | "event_cancel";
      id: string;
      version: number;
      note: string;
      cancelLinkedTasks?: boolean;
    }
  | {
      operation: "event_rsvp";
      id: string;
      action: "rsvp" | "cancel";
    }
  | {
      operation: "event_checkin";
      id: string;
      checkinCode: string;
    }
  | {
      operation: "event_clone";
      id: string;
      startsAt: string;
      endsAt: string;
    }
);

export const eventsApi = {
  list: async (params: {
    organizationId: string;
    page: number;
    status: string;
    search: string;
  }): Promise<{
    items: MobilizationEvent[];
    total: number;
    page: number;
    pageSize: number;
  }> => (await client.get("/admin/work/event_list", { params })).data,
  detail: async (organizationId: string, id: string): Promise<EventDetail> =>
    (
      await client.get("/admin/work/event_detail", {
        params: { organizationId, id },
      })
    ).data,
  write: async (
    input: EventWrite,
  ): Promise<{ id: string; version: number }> => {
    const { operation, ...body } = input;
    return (await client.post("/admin/work/" + operation, body)).data;
  },
};
