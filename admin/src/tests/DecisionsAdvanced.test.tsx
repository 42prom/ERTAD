import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Decisions from "../pages/Decisions";
import { decisionApi, type Decision } from "../api/decisions";

vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));

vi.mock("../api/decisions", () => ({
  decisionApi: {
    contexts: vi.fn(),
    audiences: vi.fn(),
    estimate: vi.fn(),
    list: vi.fn(),
    detail: vi.fn(),
    write: vi.fn(),
  },
}));

vi.mock("../api/demo", () => ({
  demoApi: {
    scenario: vi.fn().mockResolvedValue({ accounts: [] }),
    stepUp: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));

const baseDraft: Decision = {
  id: "poll-1",
  unitId: "region-a",
  unitName: "Region A",
  title: "Synthetic election",
  description: "Choose candidate",
  options: ["Cand A", "Cand B", "Cand C"],
  privacy: "anonymous",
  governanceMode: "binding_review",
  status: "draft",
  version: 1,
  quorum: 50,
  closesAt: "2099-01-01T00:00:00Z",
  electorate: 12,
  canManage: true,
  canPublish: true,
  canVote: false,
  voted: false,
  kind: "election",
};

describe("Decisions Step 4 controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decisionApi.contexts).mockResolvedValue([
      { id: "org", name: "Org", anonymousMinElectorate: 10 },
    ]);
    vi.mocked(decisionApi.audiences).mockResolvedValue([
      { id: "region-a", name: "Region A" },
      { id: "region-b", name: "Region B" },
    ]);
    vi.mocked(decisionApi.estimate).mockResolvedValue({
      electorateCount: 14,
      meetsAnonymousFloor: true,
      anonymousMinElectorate: 10,
      policyMinElectorate: 10,
    });
    vi.mocked(decisionApi.list).mockResolvedValue({
      items: [baseDraft],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    vi.mocked(decisionApi.detail).mockResolvedValue(baseDraft);
    vi.mocked(decisionApi.write).mockResolvedValue({ id: "poll-1", status: "draft" });
  });

  function mount() {
    render(
      <MemoryRouter>
        <Decisions />
      </MemoryRouter>,
    );
  }

  it("shows Scheduled view tab, multi-unit estimate, and enforces anonymous k>=10 floor on save", async () => {
    vi.mocked(decisionApi.estimate).mockResolvedValue({
      electorateCount: 6,
      meetsAnonymousFloor: false,
    });
    mount();
    expect(
      await screen.findByRole("button", { name: "Scheduled", exact: true }),
    ).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: "Create", exact: true }),
    );
    fireEvent.change(await screen.findByLabelText("Participation privacy"), {
      target: { value: "anonymous" },
    });
    expect(await screen.findByText(/Below anonymity floor \(< 10\)/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  });

  it("adapts UI labels and validation dynamically to admin-configured anonymity floor", async () => {
    vi.mocked(decisionApi.contexts).mockResolvedValue([
      { id: "org", name: "Org", anonymousMinElectorate: 4 },
    ]);
    vi.mocked(decisionApi.estimate).mockResolvedValue({
      electorateCount: 6,
      meetsAnonymousFloor: true,
      anonymousMinElectorate: 4,
      policyMinElectorate: 4,
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Create", exact: true }),
    );
    fireEvent.change(await screen.findByLabelText("Participation privacy"), {
      target: { value: "anonymous" },
    });
    expect(await screen.findByText(/Meets anonymity floor \(≥ 4\)/i)).toBeVisible();
    expect(screen.getByLabelText("Minimum electorate (k, ≥ 4)")).toHaveProperty("value", "4");
    expect(screen.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
  });

  it("discloses anonymous storage, binding governance contract, and supports draft candidate nomination/withdrawal", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open: Synthetic election", exact: true }),
    );
    expect(await screen.findByText(/Ballot choices are unlinkable/i)).toBeVisible();
    expect(
      screen.getByText(/Binding \(requires independent review execution\)/i),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Candidate label", { exact: true }), {
      target: { value: "Cand D" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Nominate candidate", exact: true }),
    );
    await waitFor(() => expect(decisionApi.write).toHaveBeenCalledTimes(1));
    expect(vi.mocked(decisionApi.write).mock.calls[0][0]).toMatchObject({
      operation: "nominate",
      id: "poll-1",
      candidateLabel: "Cand D",
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Open: Synthetic election", exact: true }),
    );
    fireEvent.change(await screen.findByLabelText("Withdrawal reason", { exact: true }), {
      target: { value: "Stepped down prior to ballot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw: Cand B", exact: true }));
    await waitFor(() => expect(decisionApi.write).toHaveBeenCalledTimes(2));
    expect(vi.mocked(decisionApi.write).mock.calls[1][0]).toMatchObject({
      operation: "withdraw_nomination",
      id: "poll-1",
      candidateLabel: "Cand B",
      reason: "Stepped down prior to ballot",
    });
  });
});
