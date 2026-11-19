import client from "./client";
import type { PointsRule } from "./collective";
export interface WorkContext {
  id: string;
  name: string;
}
export interface WorkUnit extends WorkContext {
  parentId: string | null;
  canCreate: boolean;
  rewardOptions?: PointsRule[];
}
export type WorkStatus = "offered" | "open" | "completed" | "cancelled";
export type AssignmentStatus =
  | "applied"
  | "reserved"
  | "assigned"
  | "in_progress"
  | "submitted"
  | "verified"
  | "withdrawn"
  | "rejected"
  | "no_show";
export interface WorkItem {
  startsAt?: string | null;
  location?: string;
  id: string;
  unitId: string;
  unitName: string;
  parentId: string | null;
  title: string;
  description: string;
  roleLabel: string;
  priority: "low" | "normal" | "high" | "urgent";
  capacity: number;
  used: number;
  verified: number;
  deadline: string;
  status: WorkStatus;
  version: number;
  actorId: string;
  unread: number;
  canManage: boolean;
  canVerify: boolean;
  canParticipate: boolean;
  coordinatorId?: string;
  coordinatorActive?: boolean;
  verifiedProgress?: number | null;
  criteriaTotal?: number;
  criteriaVerified?: number;
  pendingReview?: number;
  blockers?: number;
  nextReviewAt?: string | null;
}
export interface WorkOverview {
  total: number;
  active: number;
  offered: number;
  completed: number;
  overdue: number;
  dueSoon?: number;
  blocked: number;
  shortfalls?: number;
  needsReview: number;
  reviewDue: number;
  unowned: number;
  leafTotal: number;
  leafCompleted: number;
}
export interface WorkReportItem {
  id: string;
  unitName: string;
  title: string;
  status: WorkStatus;
  priority: WorkItem["priority"];
  capacity: number;
  used: number;
  verified: number;
  overdue: boolean;
  blocked: boolean;
  shortfalls: number;
  deadline: string;
}
export interface WorkReport {
  items: WorkReportItem[];
  total: number;
  truncated: boolean;
  generatedAt: string;
}
export interface WorkCriterion {
  id: string;
  title: string;
  weight: number;
  status: "pending" | "submitted" | "verified";
  submittedBy: string | null;
  verifiedBy: string | null;
  submissionNote: string;
  reviewNote: string;
}
export interface WorkBlocker {
  id: string;
  kind: string;
  reason: string;
  ownerId: string;
  ownerActive: boolean;
  nextReviewAt: string;
  nextAction: string;
  resolvedAt: string | null;
  resolution: string | null;
}
export interface WorkDetail extends WorkItem {
  event?: import("./events").MobilizationEvent;
  materialLinks?: { title: string; url: string }[];
  contributionOffer?: {
    title?: string;
    ruleId?: string;
    amount: number;
    memberMonthCap: number;
    ruleVersion: number;
  } | null;
  needs?: WorkNeed[];
  canVerifyQualifications?: boolean;
  qualificationCatalog?: { id: string; title: string }[];
  qualificationClaims?: QualificationClaim[];
  canReport?: boolean;
  canSetCriteria?: boolean;
  coordinators?: string[];
  criteria?: WorkCriterion[];
  blockerRecords?: WorkBlocker[];
  overview?: WorkOverview;
  assignments: {
    canReview?: boolean;
    reviewRoute?: "local" | "higher";
    reviewUnitName?: string | null;
    needId?: string | null;
    qualified?: boolean;
    memberId: string;
    status: AssignmentStatus;
    progress: number;
  }[];
  events: {
    version: number;
    action: string;
    note: string;
    at: string;
    actorId: string;
    subjectId: string | null;
    progress: number | null;
    details?: {
      before?: WorkAmendment;
      after?: WorkAmendment;
      title?: string;
      coordinatorId?: string;
      previousCoordinatorId?: string;
      criteria?: { title: string; weight: number }[];
    };
  }[];
  children: WorkItem[];
}
export interface WorkPage {
  items: WorkItem[];
  total: number;
  page: number;
  pageSize: number;
}
export interface WorkDefinition {
  startsAt?: string | null;
  location?: string;
  contributionRuleId?: string | null;
  unitId: string;
  title: string;
  description: string;
  roleLabel: string;
  priority: WorkItem["priority"];
  capacity: number;
  deadline: string;
}
export type WorkAmendment = Pick<
  WorkDefinition,
  "title" | "description" | "priority" | "capacity" | "deadline"
> & {
  startsAt: string | null;
  location: string;
};
export type WorkAction =
  | "accept"
  | "decline"
  | "cancel"
  | "complete"
  | "apply"
  | "reserve"
  | "assign"
  | "reject"
  | "withdraw"
  | "start"
  | "progress"
  | "submit"
  | "return"
  | "verify"
  | "no_show";
export type WorkTrackingAction =
  | "coordinator"
  | "criteria"
  | "criterion_submit"
  | "criterion_verify"
  | "criterion_return"
  | "block"
  | "resolve_block"
  | "block_update";
export type WorkWrite = { organizationId: string; key: string } & (
  | ({
      operation: "edit";
      id: string;
      version: number;
      note: string;
    } & WorkAmendment)
  | {
      operation: "materials";
      id: string;
      version: number;
      note: string;
      links: { title: string; url: string }[];
    }
  | ({ operation: "create"; eventId?: string } & WorkDefinition)
  | ({
      operation: "delegate";
      needId?: string;
      id: string;
      version: number;
      note: string;
    } & WorkDefinition)
  | {
      operation: WorkAction | WorkTrackingAction | WorkNeedsAction;
      id: string;
      version: number;
      note: string;
      memberId?: string;
      capacity?: number;
      progress?: number;
      criteria?: { id: string; title: string; weight: number }[];
      criterionId?: string;
      blockerId?: string;
      kind?: string;
      nextReviewAt?: string;
      needId?: string;
      provisionId?: string;
      qualificationId?: string;
      claimId?: string;
      validUntil?: string;
      reference?: string;
      title?: string;
      quantity?: string;
      unitLabel?: string;
      gate?: string;
      deadline?: string;
      qualificationIds?: string[];
    }
);
export type WorkNeedsAction =
  | "qualification_define"
  | "qualification_claim"
  | "qualification_verify"
  | "qualification_reject"
  | "qualification_revoke"
  | "need_create"
  | "need_cancel"
  | "provision_offer"
  | "provision_confirm"
  | "provision_withdraw"
  | "provision_return"
  | "provision_reject";
export interface WorkNeed {
  id: string;
  kind: "people" | "resource" | "service";
  title: string;
  quantity: string;
  unitLabel: string;
  gate: "optional" | "start" | "complete";
  ownerId: string;
  deadline: string;
  cancelled: boolean;
  confirmed: string;
  remaining: string;
  pledged: string;
  qualified: boolean;
  qualificationIds: string[];
  provisions: {
    id: string;
    memberId: string;
    quantity: string;
    status: string;
    note: string;
  }[];
}
export interface QualificationClaim {
  id: string;
  qualificationId: string;
  memberId: string;
  status: string;
  reference: string;
  reviewNote: string;
  validUntil: string | null;
}
const base = "/admin/work";
export const workApi = {
  contexts: async (): Promise<WorkContext[]> =>
    (await client.get(base + "/contexts")).data,
  units: async (organizationId: string): Promise<WorkUnit[]> =>
    (await client.get(base + "/units", { params: { organizationId } })).data,
  list: async (params: {
    organizationId: string;
    view: string;
    page: number;
    search: string;
    unitId?: string;
  }): Promise<WorkPage> => (await client.get(base + "/list", { params })).data,
  overview: async (
    organizationId: string,
    unitId?: string,
  ): Promise<WorkOverview> =>
    (
      await client.get(base + "/overview", {
        params: { organizationId, unitId },
      })
    ).data,
  report: async (params: {
    organizationId: string;
    view: string;
    search: string;
    unitId?: string;
  }): Promise<WorkReport> =>
    (await client.get(base + "/report", { params })).data,
  detail: async (organizationId: string, id: string): Promise<WorkDetail> =>
    (await client.get(base + "/detail", { params: { organizationId, id } }))
      .data,
  write: async (input: WorkWrite): Promise<{ id: string; version: number }> => {
    const { operation, ...body } = input;
    return (await client.post(base + "/" + operation, body)).data;
  },
  ack: async (organizationId: string, id: string, version: number) => {
    await client.post(base + "/ack", { organizationId, id, version });
  },
};
