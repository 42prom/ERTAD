import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import PlatformIntegrations from "../components/PlatformIntegrations";
import {
  platformApi,
  type PlatformIntegrations as Inventory,
  type IntegrationCheck,
} from "../api/platform";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/platform", () => ({
  platformApi: { integrations: vi.fn(), checkIntegration: vi.fn() },
}));
const inventory: Inventory = {
  checkedAt: "2026-10-29T00:00:00Z",
  items: [
    {
      id: "postgres",
      category: "infrastructure",
      active: true,
      configuration: "loaded",
      diagnostic: "available",
      assurance: "not_applicable",
      blocker: null,
    },
    {
      id: "liveness",
      category: "identity",
      active: false,
      configuration: "not_loaded",
      diagnostic: "unavailable",
      assurance: "not_verified",
      blocker: "pad_not_implemented",
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(platformApi.integrations).mockResolvedValue(inventory);
});
it("distinguishes activation, loaded configuration and unchecked connection, with no tests for inactive providers", async () => {
  render(<PlatformIntegrations canTest />);
  await screen.findByText("Liveness / PAD");
  expect(screen.getByText("Not activated")).toBeTruthy();
  expect(
    screen.getByText("Connection has not been checked in this view."),
  ).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "Check connection", exact: true }),
  ).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Category"), {
    target: { value: "identity" },
  });
  expect(screen.queryByText("Database")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Check connection", exact: true }),
  ).toBeNull();
  expect(platformApi.checkIntegration).not.toHaveBeenCalled();
});
it("read-only authority can view inventory without requesting connection tests", async () => {
  render(<PlatformIntegrations canTest={false} />);
  await screen.findByText("Database");
  expect(
    screen.queryByRole("button", { name: "Check connection", exact: true }),
  ).toBeNull();
});
it("a diagnostic sends only its target and a later denied result clears protected state", async () => {
  vi.mocked(platformApi.checkIntegration)
    .mockResolvedValueOnce({
      target: "postgres",
      status: "ready",
      checkedAt: inventory.checkedAt,
      durationMs: 10,
    })
    .mockRejectedValueOnce(Error("forbidden"));
  render(<PlatformIntegrations canTest />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Check connection",
      exact: true,
    }),
  );
  await screen.findByText(/Available ·/);
  expect(platformApi.checkIntegration).toHaveBeenCalledWith("postgres");
  fireEvent.click(
    screen.getByRole("button", { name: "Check connection", exact: true }),
  );
  await screen.findByRole("alert");
  expect(screen.queryByText("Database")).toBeNull();
  expect(screen.queryByText(/Available ·/)).toBeNull();
});
it("a late diagnostic cannot restore results after refresh invalidates the view", async () => {
  let finish!: (result: IntegrationCheck) => void;
  vi.mocked(platformApi.checkIntegration).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<PlatformIntegrations canTest refreshRevision={0} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Check connection",
      exact: true,
    }),
  );
  vi.mocked(platformApi.integrations).mockRejectedValue(Error("revoked"));
  view.rerender(<PlatformIntegrations canTest refreshRevision={1} />);
  await screen.findByRole("alert");
  await act(async () =>
    finish({
      target: "postgres",
      status: "ready",
      checkedAt: inventory.checkedAt,
      durationMs: 1,
    }),
  );
  await waitFor(() => expect(screen.queryByText(/Available ·/)).toBeNull());
});
