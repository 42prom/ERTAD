import client from "./client";
import type { DecisionContext } from "./decisions";
import type { InboxSummary } from "./inbox";
import type { PlatformAccess } from "./platform";
import type { ReviewContext } from "./reviews";
import type { UnitContext } from "./units";
import type { WorkContext } from "./work";

export interface WorkspaceScheduleBucket {
  dayOffset: number;
  date: string;
  tasks: number;
  events: number;
  decisions: number;
  proposals: number;
}

export interface WorkspaceUrgentItem {
  kind: "task" | "event" | "decision";
  organizationId: string;
  id: string;
  title: string;
  dueAt: string;
  overdue: boolean;
  route: string;
}

export interface WorkspaceSummary {
  openWork: number;
  offeredWork: number;
  overdueWork: number;
  upcomingEvents48h: number;
  openDecisions: number;
  pendingReviews: number;
  pendingCollective: number;
  schedule: WorkspaceScheduleBucket[];
  urgent: WorkspaceUrgentItem[];
}

export interface WorkspaceBootstrap {
  platformAccess: PlatformAccess;
  reviews: ReviewContext[];
  reviewCount: number | null;
  units: UnitContext[];
  decisions: DecisionContext[];
  work: WorkContext[];
  collective: WorkContext[];
  points: WorkContext[];
  channels: { id: string; name: string }[];
  members: { id: string; name: string }[];
  positions: { id: string; name: string }[];
  invitations: { id: string; name: string }[];
  inbox: InboxSummary;
  summary: WorkspaceSummary;
}

export const workspaceApi = {
  bootstrap: () =>
    client
      .get<WorkspaceBootstrap>("/admin/workspace/bootstrap")
      .then((r) => r.data),
};

