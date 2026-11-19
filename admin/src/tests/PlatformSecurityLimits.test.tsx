import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import PlatformSecurityLimits from "../components/PlatformSecurityLimits";
import { platformApi, type SecurityLimitsList } from "../api/platform";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/platform", () => ({
  platformApi: {
    securityLimits: vi.fn(),
    proposeSecurityLimits: vi.fn(),
    reviewSecurityLimits: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const data: SecurityLimitsList = {
  current: {
    version: 2,
    apiPerMinute: 120,
    loginFailures: 5,
    lockoutMinutes: 15,
    anonymousMinElectorate: 10,
  },
  nextBefore: null,
  items: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      mine: false,
      expectedVersion: 2,
      version: null,
      apiPerMinute: 300,
      loginFailures: 3,
      lockoutMinutes: 5,
      anonymousMinElectorate: 15,
      reason: "security_tightening",
      status: "pending",
      createdAt: "2026-10-29T10:00:00Z",
      expiresAt: "2026-10-30T10:00:00Z",
      reviewedAt: null,
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.mocked(platformApi.securityLimits).mockResolvedValue(
    structuredClone(data),
  );
  vi.mocked(authApi.stepUp).mockResolvedValue({
    expiresAt: "2026-10-29T11:00:00Z",
  });
});
it("separates read, propose and review controls and never permits a self-approval UI", async () => {
  const view = render(
    <PlatformSecurityLimits canPropose={false} canApprove={false} />,
  );
  await screen.findByText("Pending review · Base version 2");
  expect(screen.queryByRole("button", { name: "Propose change" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review request" })).toBeNull();
  vi.mocked(platformApi.securityLimits).mockResolvedValue({
    ...data,
    items: [{ ...data.items[0], mine: true }],
  });
  view.rerender(
    <PlatformSecurityLimits canPropose canApprove refreshRevision={1} />,
  );
  await screen.findByRole("button", { name: "Withdraw request" });
  expect(screen.queryByRole("button", { name: "Review request" })).toBeNull();
});
it("pins proposal version and exact values across an uncertain response and clears passwords", async () => {
  vi.mocked(platformApi.proposeSecurityLimits)
    .mockRejectedValueOnce(Error("lost response"))
    .mockResolvedValue({ id: data.items[0].id });
  render(<PlatformSecurityLimits canPropose canApprove={false} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Propose change" }),
  );
  fireEvent.change(
    screen.getByLabelText("API requests per address / minute (60–600)"),
    {
      target: { value: "300" },
    },
  );
  fireEvent.change(
    screen.getByLabelText("Anonymous poll minimum electorate (k) (2–1000)"),
    {
      target: { value: "12" },
    },
  );
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
  await screen.findByRole("alert");
  const first = vi.mocked(platformApi.proposeSecurityLimits).mock.calls[0][0];
  expect(first).toEqual({
    requestId: expect.any(String),
    expectedVersion: 2,
    apiPerMinute: 300,
    loginFailures: 5,
    lockoutMinutes: 15,
    anonymousMinElectorate: 12,
    reason: "security_tightening",
  });
  expect(screen.getByLabelText("Your password")).toHaveProperty("value", "");
  expect(
    screen.getByLabelText("API requests per address / minute (60–600)"),
  ).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await screen.findByText("Change saved. Status refreshed.");
  expect(vi.mocked(platformApi.proposeSecurityLimits).mock.calls[1][0]).toEqual(
    first,
  );
});
it("reviews the displayed values with a password and preserves a rejected-action retry", async () => {
  vi.mocked(platformApi.reviewSecurityLimits)
    .mockRejectedValueOnce(Error("lost response"))
    .mockResolvedValue({ id: data.items[0].id });
  render(<PlatformSecurityLimits canPropose={false} canApprove />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Review request" }),
  );
  expect(
    screen.getByLabelText("API requests per address / minute (60–600)"),
  ).toHaveProperty("value", "300");
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reject", exact: true }));
  await screen.findByRole("alert");
  expect(
    vi.mocked(platformApi.reviewSecurityLimits).mock.calls[0][0].action,
  ).toBe("reject");
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await screen.findByText("Change saved. Status refreshed.");
  expect(vi.mocked(platformApi.reviewSecurityLimits).mock.calls[1][0]).toEqual(
    vi.mocked(platformApi.reviewSecurityLimits).mock.calls[0][0],
  );
});
it("failed password never sends a policy command; denied refresh clears protected history", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue(Error("bad password"));
  const view = render(<PlatformSecurityLimits canPropose canApprove={false} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Propose change" }),
  );
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "wrong-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
  await screen.findByRole("alert");
  expect(platformApi.proposeSecurityLimits).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  vi.mocked(platformApi.securityLimits).mockRejectedValue({
    response: { status: 403 },
  });
  view.rerender(
    <PlatformSecurityLimits
      canPropose
      canApprove={false}
      refreshRevision={1}
    />,
  );
  await screen.findByText(
    "Policy could not be loaded or access is no longer available.",
  );
  expect(screen.queryByText("Pending review · Base version 2")).toBeNull();
});
it("stale versions disable approval but allow rejection and late reads cannot restore denied data", async () => {
  let resolve!: (value: SecurityLimitsList) => void;
  vi.mocked(platformApi.securityLimits).mockResolvedValueOnce({
    ...data,
    current: { ...data.current, version: 3 },
  });
  const view = render(<PlatformSecurityLimits canPropose={false} canApprove />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Review request" }),
  );
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  expect(
    screen.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  vi.mocked(platformApi.securityLimits)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockRejectedValueOnce(Error("denied"));
  view.rerender(
    <PlatformSecurityLimits
      canPropose={false}
      canApprove
      refreshRevision={1}
    />,
  );
  await waitFor(() =>
    expect(platformApi.securityLimits).toHaveBeenCalledTimes(2),
  );
  view.rerender(
    <PlatformSecurityLimits
      canPropose={false}
      canApprove
      refreshRevision={2}
    />,
  );
  await screen.findByRole("alert");
  await act(async () => resolve(data));
  expect(screen.queryByText("Pending review · Base version 2")).toBeNull();
});
