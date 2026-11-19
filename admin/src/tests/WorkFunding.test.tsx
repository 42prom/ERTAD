import { beforeEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import WorkFunding from "../components/WorkFunding";
import { collectiveApi, type FundingView } from "../api/collective";
import type { WorkDetail } from "../api/work";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../components/CollectiveWrite", () => ({
  useCollectiveWrite: () => ({ send: vi.fn(), locked: false, feedback: null }),
}));
vi.mock("../api/collective", async (original) => ({
  ...(await original<typeof import("../api/collective")>()),
  collectiveApi: { funding: vi.fn() },
}));
const detail: WorkDetail = {
  id: "work-a",
  unitId: "region",
  unitName: "Region",
  parentId: null,
  title: "Task",
  description: "Synthetic",
  roleLabel: "Organizer",
  priority: "normal",
  capacity: 2,
  used: 0,
  verified: 0,
  deadline: "2099-01-01T00:00:00Z",
  status: "open",
  version: 1,
  actorId: "member",
  unread: 0,
  canManage: true,
  canVerify: true,
  canParticipate: true,
  assignments: [],
  events: [],
  children: [],
};
const funding: FundingView = {
  actorId: "member",
  canRecord: false,
  canParticipate: false,
  canReadRecords: false,
  target: {
    currency: "GEL",
    goal: "10000",
    purpose: "Budget for task A",
    version: 1,
    isEnvelope: false,
    suppressed: false,
    totals: null,
  },
};
const props = { organizationId: "org", demo: false, people: {}, detail };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(collectiveApi.funding).mockResolvedValue(funding);
});
it("hides funding from the previous task immediately while the new scope is loading", async () => {
  let resolve!: (data: FundingView) => void;
  const next = new Promise<FundingView>((yes) => {
    resolve = yes;
  });
  const view = render(
    <MemoryRouter>
      <WorkFunding {...props} />
    </MemoryRouter>,
  );
  await screen.findByText("Budget for task A");
  vi.mocked(collectiveApi.funding).mockReturnValueOnce(next);
  view.rerender(
    <MemoryRouter>
      <WorkFunding {...props} detail={{ ...detail, id: "work-b" }} />
    </MemoryRouter>,
  );
  expect(screen.queryByText("Budget for task A")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await act(async () =>
    resolve({
      ...funding,
      target: { ...funding.target!, purpose: "Budget for task B" },
    }),
  );
  await screen.findByText("Budget for task B");
});
it("denied focus refresh removes funding and mutation controls", async () => {
  render(
    <MemoryRouter>
      <WorkFunding {...props} />
    </MemoryRouter>,
  );
  await screen.findByText("Budget for task A");
  vi.mocked(collectiveApi.funding).mockRejectedValueOnce({
    response: { status: 403 },
  });
  act(() => window.dispatchEvent(new Event("focus")));
  expect(screen.queryByText("Budget for task A")).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load funding.",
    ),
  );
  expect(screen.queryByRole("button", { name: "Propose budget" })).toBeNull();
});
