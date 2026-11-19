import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TaskRecognition from "../components/TaskRecognition";
import { collectiveApi, type RecognitionContext } from "../api/collective";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/collective", () => ({
  collectiveApi: { recognition: vi.fn(), write: vi.fn() },
}));
vi.mock("../api/demo", () => ({ demoApi: { stepUp: vi.fn() } }));
const data: RecognitionContext = {
  canAward: true,
  unitId: "unit",
  rule: { id: "rule", amount: 20, memberMonthCap: 100, issuerMonthCap: 200 },
  participants: [
    { activityId: "activity", memberId: "member", state: "available" },
    { activityId: "pending", memberId: "pending-member", state: "pending" },
    { activityId: "awarded", memberId: "awarded-member", state: "awarded" },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(collectiveApi.recognition).mockResolvedValue(data);
  vi.mocked(collectiveApi.write).mockResolvedValue({ id: "proposal" });
});
const mount = () =>
  render(
    <MemoryRouter>
      <TaskRecognition
        organizationId="org"
        workId="work"
        version={2}
        demo={false}
        people={{ member: "Verified volunteer", outsider: "Other region" }}
      />
    </MemoryRouter>,
  );
async function fill() {
  fireEvent.change(await screen.findByLabelText("Verified participant"), {
    target: { value: "activity" },
  });
  fireEvent.change(screen.getByLabelText("Bonus points"), {
    target: { value: "5" },
  });
  fireEvent.change(screen.getByLabelText("Reason for bonus"), {
    target: { value: "Additional transport assistance" },
  });
}
it("offers only server-authorized available verified participants with policy limits and proposal source", async () => {
  mount();
  await fill();
  expect(
    screen.queryByRole("option", { name: "Other region" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.getByLabelText("Bonus points")).toHaveAttribute("max", "20");
  expect(screen.getByText(/Bonus awaiting approval/)).toBeInTheDocument();
  expect(screen.getByText(/Bonus already awarded/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Propose bonus" }));
  await waitFor(() =>
    expect(collectiveApi.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "points_award",
        unitId: "unit",
        reason: "Additional transport assistance",
        parameters: {
          memberId: "member",
          activityId: "activity",
          ruleId: "rule",
          amount: 5,
        },
      }),
    ),
  );
  expect(
    await screen.findByText(/Proposed changes take effect only after approval/),
  ).toBeInTheDocument();
});
it("freezes an uncertain request and retries the same source, amount and idempotency key", async () => {
  vi.mocked(collectiveApi.write)
    .mockRejectedValueOnce(new Error("Lost response"))
    .mockResolvedValue({ id: "proposal" });
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Propose bonus" }));
  const retry = await screen.findByRole("button", {
    name: "Retry same request",
  });
  expect(screen.getByLabelText("Bonus points")).toBeDisabled();
  const first = structuredClone(
    vi.mocked(collectiveApi.write).mock.calls[0][0],
  );
  fireEvent.click(retry);
  await waitFor(() => expect(collectiveApi.write).toHaveBeenCalledTimes(2));
  expect(vi.mocked(collectiveApi.write).mock.calls[1][0]).toEqual(first);
});
it("hides controls for unauthorized readers and explains a disabled policy for managers", async () => {
  vi.mocked(collectiveApi.recognition).mockResolvedValueOnce({
    canAward: false,
    participants: [],
  });
  const view = mount();
  await waitFor(() =>
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("region", { name: "Additional recognition" }),
  ).not.toBeInTheDocument();
  view.unmount();
  vi.mocked(collectiveApi.recognition).mockResolvedValue({
    canAward: false,
    unitId: "unit",
    rule: null,
    participants: [],
  });
  mount();
  expect(
    await screen.findByText(/Individual recognition has not been enabled/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Propose bonus" }),
  ).not.toBeInTheDocument();
});
it("refetches after a policy conflict and disables a now-pending recipient", async () => {
  vi.mocked(collectiveApi.recognition)
    .mockResolvedValueOnce(data)
    .mockResolvedValue({
      ...data,
      participants: [{ ...data.participants[0], state: "pending" }],
    });
  vi.mocked(collectiveApi.write).mockRejectedValue({
    response: { status: 409 },
  });
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Propose bonus" }));
  expect(
    await screen.findByText(/Verified volunteer · Bonus awaiting approval/),
  ).toBeInTheDocument();
  expect(
    screen.queryByLabelText("Verified participant"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry same request" }),
  ).not.toBeInTheDocument();
});
