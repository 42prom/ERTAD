import client from "./client";

export interface DecisionContext {
  id: string;
  name: string;
  anonymousMinElectorate?: number;
}

export type DecisionKind = "poll" | "referendum" | "survey" | "election";
export type DecisionPrivacy = "named" | "anonymous";
export type DecisionGovernanceMode = "advisory" | "binding_review";

export interface ReferendumLabels {
  yes?: string;
  no?: string;
  abstain?: string;
}

export interface DecisionNomination {
  id: string;
  label: string;
  status: "nominated" | "withdrawn";
  reason: string;
  createdAt: string;
  withdrawnAt: string | null;
}

export type SurveyQuestion = {
  id: string;
  title: string;
  required: boolean;
  visibleIf?: { questionId: string; equals: string };
} & (
  | {
      type: "single_choice" | "multiple_choice" | "ranked_choice";
      options: string[];
    }
  | { type: "text"; maxLength: number; placeholder?: string }
  | {
      type: "rating_scale";
      min: number;
      max: number;
      minLabel?: string;
      maxLabel?: string;
    }
);

export type SurveyAnswers = Record<string, string | number | number[]>;

export interface SurveyResult {
  id: string;
  title: string;
  type: SurveyQuestion["type"];
  answered: number;
  results?: { label: string; votes: number }[];
  average?: number | null;
  texts?: string[];
  truncated?: boolean;
  textsRedacted?: boolean;
}

export interface Decision {
  contributionOffer?: {
    amount: number;
    memberMonthCap: number;
    ruleVersion: number;
  } | null;
  id: string;
  unitId: string;
  unitName: string;
  includedUnitIds?: string[];
  excludedUnitIds?: string[];
  title: string;
  description: string;
  options: string[];
  privacy: DecisionPrivacy;
  anonymousMinElectorate?: number;
  governanceMode?: DecisionGovernanceMode;
  referendumLabels?: ReferendumLabels | null;
  status: "draft" | "scheduled" | "open" | "closed" | "cancelled";
  version: number;
  quorum: number;
  quorumRequired?: number;
  quorumMet?: boolean;
  opensAt?: string | null;
  closesAt: string;
  electorate: number;
  canManage: boolean;
  canPublish: boolean;
  canVote: boolean;
  voted: boolean;
  kind?: DecisionKind;
  threshold?: number | null;
  questions?: SurveyQuestion[] | null;
  nominations?: DecisionNomination[];
  surveyResults?: SurveyResult[];
  resultsSuppressed?: boolean;
  receiptDigests?: string[];
  outcome?: "accepted" | "rejected" | "tie" | "inquorate" | "no_decision";
  participation?: number;
  results?: { label: string; votes: number }[];
}

export interface DecisionReportItem {
  id: string;
  unitName: string;
  title: string;
  kind: DecisionKind;
  status: Decision["status"];
  privacy: DecisionPrivacy;
  governanceMode: DecisionGovernanceMode;
  electorate: number;
  quorum: number;
  participation: number | null;
  closesAt: string;
}

export interface DecisionReport {
  items: DecisionReportItem[];
  total: number;
  truncated: boolean;
  generatedAt: string;
}

export interface DecisionPage {
  items: Decision[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DecisionDefinition {
  unitId: string;
  title: string;
  description: string;
  options: string[];
  quorum: number;
  opensAt?: string;
  closesAt: string;
  kind?: DecisionKind;
  privacy?: DecisionPrivacy;
  anonymousMinElectorate?: number;
  governanceMode?: DecisionGovernanceMode;
  includedUnitIds?: string[];
  excludedUnitIds?: string[];
  referendumLabels?: ReferendumLabels;
  threshold?: number;
  questions?: SurveyQuestion[];
}

export type DecisionWrite = { organizationId: string; key: string } & (
  | ({ operation: "create" } & DecisionDefinition)
  | ({ operation: "update"; id: string; version: number } & DecisionDefinition)
  | {
      operation: "nominate";
      id: string;
      version: number;
      candidateLabel: string;
    }
  | {
      operation: "withdraw_nomination";
      id: string;
      version: number;
      candidateLabel: string;
      reason: string;
    }
  | { operation: "publish" | "close" | "cancel"; id: string; version: number }
  | { operation: "vote"; id: string; choice: number }
  | { operation: "vote"; id: string; answers: SurveyAnswers }
);

const base = "/admin/decisions";
export const decisionApi = {
  contexts: async (): Promise<DecisionContext[]> =>
    (await client.get(base + "/contexts")).data,
  audiences: async (organizationId: string): Promise<DecisionContext[]> =>
    (await client.get(base + "/audiences", { params: { organizationId } }))
      .data,
  estimate: async (
    organizationId: string,
    includedUnitIds: string[],
    excludedUnitIds: string[] = [],
    anonymousMinElectorate?: number,
  ): Promise<{
    electorateCount: number;
    meetsAnonymousFloor: boolean;
    anonymousMinElectorate?: number;
    policyMinElectorate?: number;
  }> =>
    (
      await client.get(base + "/estimate", {
        params: {
          organizationId,
          includedUnitIds: includedUnitIds.join(","),
          excludedUnitIds: excludedUnitIds.join(","),
          ...(anonymousMinElectorate !== undefined
            ? { anonymousMinElectorate }
            : {}),
        },
      })
    ).data,
  list: async (
    organizationId: string,
    view: string,
    page: number,
    search: string,
  ): Promise<DecisionPage> =>
    (
      await client.get(base + "/list", {
        params: { organizationId, view, page, search },
      })
    ).data,
  report: async (
    organizationId: string,
    view: string,
    search: string,
  ): Promise<DecisionReport> =>
    (
      await client.get(base + "/report", {
        params: { organizationId, view, search },
      })
    ).data,
  detail: async (organizationId: string, id: string): Promise<Decision> =>
    (await client.get(base + "/detail", { params: { organizationId, id } }))
      .data,
  write: async ({
    operation,
    ...input
  }: DecisionWrite): Promise<{ id: string; status: string; receiptDigest?: string }> =>
    (await client.post(base + "/" + operation, input)).data,
};
