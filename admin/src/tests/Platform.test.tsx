import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Platform from "../pages/Platform";
import { platformApi, type PlatformOverview } from "../api/platform";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/platform", () => ({
  platformApi: { access: vi.fn(), overview: vi.fn(), audit: vi.fn() },
}));
function mount(path = "/platform") {
  const router = createMemoryRouter([{path:"/platform/:section?",element:<Platform/>}],{initialEntries:[path]});
  render(<RouterProvider router={router}/>);
  return router;
}
const overview: PlatformOverview = {
  checkedAt: "2026-10-28T01:00:00Z",
  validUntil: "2027-01-01T00:00:00Z",
  migrations: 31,
  ownActiveSessions: 1,
  dependencies: { postgres: "ready", redis: "unavailable", storage: "ready" },
  mode: "development",
  productionEnabled: false,
  webMfa: "release_gate",
  externalCheckpoint: "not_activated",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(platformApi.access).mockResolvedValue({
    technicalAccount: true,
    permissions: ["platform.read", "platform.audit.read"],
    validUntil: overview.validUntil,
  });
  vi.mocked(platformApi.overview).mockResolvedValue(overview);
  vi.mocked(platformApi.audit).mockResolvedValue({
    items: [
      { id: "25", event: "PLATFORM_BOOTSTRAPPED", at: overview.checkedAt },
      { id: "24", event: "PLATFORM_ACCOUNT_HELD", at: overview.checkedAt },
      { id: "23", event: "PLATFORM_ACCOUNT_RELEASED", at: overview.checkedAt },
      { id: "22", event: "PLATFORM_ACCOUNT_LIFECYCLE_PROPOSED", at: overview.checkedAt },
      { id: "21", event: "PLATFORM_ACCOUNT_LIFECYCLE_REVIEWED", at: overview.checkedAt },
    ],
    nextBefore: "23",
  });
});
it("shows degraded dependencies and production gates without claiming audited security", async () => {
  mount();
  await screen.findByText("Unavailable");
  expect(screen.getAllByText("Available")).toHaveLength(2);
  expect(screen.getByText("Production startup is blocked.")).toBeVisible();
  expect(
    screen.getByText("External signed audit checkpoints are not activated."),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Save|Disable|Terminate/ }),
  ).toBeNull();
});
it("does not request protected data for an organizational or expired account", async () => {
  vi.mocked(platformApi.access).mockResolvedValue({
    technicalAccount: false,
    permissions: [],
    validUntil: null,
  });
  mount();
  await screen.findByText(/You do not have access/);
  expect(platformApi.overview).not.toHaveBeenCalled();
  expect(platformApi.audit).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Technical audit" })).toBeNull();
});
it("clears previously loaded status when authority is revoked", async () => {
  mount();
  await screen.findByText("Unavailable");
  vi.mocked(platformApi.overview).mockRejectedValue({
    response: { status: 403 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Unavailable")).toBeNull();
  expect(screen.queryByText("31")).toBeNull();
});
it("uses server cursors and resets pagination on category changes", async () => {
  mount("/platform/audit");
  await screen.findByText("Technical account created");
  expect(screen.getByText("Web account access paused")).toBeVisible();
  expect(screen.getByText("Web account hold released")).toBeVisible();
  expect(screen.getByText("Web account lifecycle change proposed")).toBeVisible();
  expect(screen.getByText("Web account lifecycle change reviewed")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(platformApi.audit).toHaveBeenLastCalledWith("all", "23"),
  );
  await screen.findByText("Technical account created");
  fireEvent.change(screen.getByLabelText("Event category"), {
    target: { value: "authentication" },
  });
  await waitFor(() =>
    expect(platformApi.audit).toHaveBeenLastCalledWith(
      "authentication",
      undefined,
    ),
  );
});
it("ignores an older overview response after changing to the audit view", async () => {
  let resolve!: (v: PlatformOverview) => void;
  vi.mocked(platformApi.overview).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const router = mount();
  await waitFor(() => expect(platformApi.overview).toHaveBeenCalled());
  await act(async () => { await router.navigate("/platform/audit"); });
  await screen.findByText("Technical account created");
  await act(async () => resolve(overview));
  expect(screen.queryByText("Unavailable")).toBeNull();
});
