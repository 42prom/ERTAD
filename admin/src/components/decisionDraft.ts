import { newQuestion } from "./surveyModel";
import type {
  Decision,
  DecisionGovernanceMode,
  DecisionKind,
  DecisionPrivacy,
  SurveyQuestion,
} from "../api/decisions";

export interface ComposerDraft {
  title: string;
  description: string;
  unitId: string;
  includedUnitIds: string[];
  excludedUnitIds: string[];
  options: string[];
  kind: DecisionKind;
  privacy: DecisionPrivacy;
  anonymousMinElectorate?: number;
  governanceMode: DecisionGovernanceMode;
  quorum: number;
  opensAt: string;
  deadline: string;
  threshold: number;
  yesLabel: string;
  noLabel: string;
  abstainLabel: string;
  questions: SurveyQuestion[];
}

const toLocalDatetime = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

export function newComposerDraft(row?: Decision, unitId = ""): ComposerDraft {
  const date = row ? new Date(row.closesAt) : new Date(Date.now() + 86400000);
  const primary = row?.unitId ?? unitId;
  return {
    title: row?.title ?? "",
    description: row?.description ?? "",
    unitId: primary,
    includedUnitIds:
      row?.includedUnitIds && row.includedUnitIds.length
        ? row.includedUnitIds
        : primary
          ? [primary]
          : [],
    excludedUnitIds: row?.excludedUnitIds ?? [],
    options: row?.options ?? ["", ""],
    kind: row?.kind ?? "poll",
    privacy: row?.privacy ?? "named",
    anonymousMinElectorate: row?.anonymousMinElectorate,
    governanceMode: row?.governanceMode ?? "advisory",
    quorum: row?.quorum ?? 50,
    opensAt: row?.opensAt ? toLocalDatetime(row.opensAt) : "",
    deadline: new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16),
    threshold: row?.threshold ?? 50,
    yesLabel: row?.referendumLabels?.yes ?? "",
    noLabel: row?.referendumLabels?.no ?? "",
    abstainLabel: row?.referendumLabels?.abstain ?? "",
    questions: row?.questions ?? [newQuestion()],
  };
}
