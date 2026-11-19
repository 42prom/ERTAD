import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ShieldDashboard from "../pages/ShieldDashboard";
import { platformApi, type PlatformMonitoring } from "../api/platform";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/platform", () => ({ platformApi: { monitoring: vi.fn() } }));
const totals = {
  login_failed: 2,
  step_up_failed: 0,
  authentication_required: 3,
  access_denied: 1,
  rate_limited: 0,
  server_error: 0,
};
const data: PlatformMonitoring = {
  checkedAt: "2026-10-29T10:00:00Z",
  observedSince: "2026-10-29T09:59:00Z",
  processStartedAt: "2026-10-29T09:59:00Z",
  minutes: 15,
  category: "all",
  retention: "process_memory_60_minutes",
  totals,
  items: [{ at: "2026-10-29T09:59:00Z", counts: totals }],
  recentTechnicalEvents: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(platformApi.monitoring).mockResolvedValue(data);
});
it("shows coverage, real counters and authorized response navigation, then requests bounded filters", async () => {
  const sessions = vi.fn(),
    audit = vi.fn();
  render(<ShieldDashboard onSessions={sessions} onAudit={audit} />);
  await screen.findByText("Observations by minute");
  expect(screen.getByText(/temporary counters reset on restart/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review sessions" }));
  expect(sessions).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Open audit" }));
  expect(audit).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("Period"), {
    target: { value: "60" },
  });
  await waitFor(() =>
    expect(platformApi.monitoring).toHaveBeenLastCalledWith("60", "all"),
  );
  fireEvent.change(screen.getByLabelText("Event type"), {
    target: { value: "rate_limited" },
  });
  await waitFor(() =>
    expect(platformApi.monitoring).toHaveBeenLastCalledWith(
      "60",
      "rate_limited",
    ),
  );
});
it("clears old observations on a denied refresh and does not invent response permissions", async () => {
  const view = render(<ShieldDashboard />);
  await screen.findByText("Observations by minute");
  expect(screen.queryByRole("button", { name: "Review sessions" })).toBeNull();
  vi.mocked(platformApi.monitoring).mockRejectedValue(new Error("denied"));
  view.rerender(<ShieldDashboard refreshRevision={1} />);
  await screen.findByRole("alert");
  expect(screen.queryByText("Observations by minute")).toBeNull();
});
it("ignores a late obsolete response after a filter change fails", async () => {
  let resolve!: (value: PlatformMonitoring) => void;
  vi.mocked(platformApi.monitoring)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockRejectedValue(new Error("denied"));
  render(<ShieldDashboard />);
  fireEvent.change(screen.getByLabelText("Period"), {
    target: { value: "60" },
  });
  await screen.findByRole("alert");
  await act(async () => resolve(data));
  expect(screen.queryByText("Observations by minute")).toBeNull();
});
