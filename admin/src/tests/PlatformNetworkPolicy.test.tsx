import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PlatformNetworkPolicy from "../components/PlatformNetworkPolicy";
import { platformApi, type NetworkPolicyList } from "../api/platform";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/platform", () => ({
  platformApi: {
    networkPolicy: vi.fn(),
    networkAddressKey: vi.fn(),
    proposeNetworkPolicy: vi.fn(),
    reviewNetworkPolicy: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const settings = {
  mode: "deny" as const,
  countries: ["DE"],
  blocked: [],
  exceptions: [],
};
const data: NetworkPolicyList = {
  configured: true,
  countryReady: true,
  source: "local",
  country: null,
  current: { version: 1, settings },
  nextBefore: null,
  items: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      mine: false,
      expectedVersion: 1,
      version: null,
      settings,
      reason: "security_tightening",
      status: "pending",
      createdAt: "2026-10-30T10:00:00Z",
      expiresAt: "2026-10-31T10:00:00Z",
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
  vi.mocked(platformApi.networkPolicy).mockResolvedValue(structuredClone(data));
  vi.mocked(authApi.stepUp).mockResolvedValue({
    expiresAt: "2099-01-01T00:00:00Z",
  });
});
it("withholds country approval until verified while allowing rejection and clears denied refresh", async () => {
  vi.mocked(platformApi.networkPolicy).mockResolvedValue({
    ...data,
    countryReady: false,
  });
  const view = render(<PlatformNetworkPolicy canPropose={false} canApprove />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Review request" }),
  );
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic" },
  });
  expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("button", { name: "Reject" })).toHaveProperty(
    "disabled",
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  vi.mocked(platformApi.networkPolicy).mockRejectedValue(Error("denied"));
  view.rerender(
    <PlatformNetworkPolicy canPropose={false} canApprove refreshRevision={1} />,
  );
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Review request" })).toBeNull();
});
it("retains exact network payload and request key after uncertain response; clears password", async () => {
  vi.mocked(platformApi.proposeNetworkPolicy)
    .mockRejectedValueOnce(Error("lost"))
    .mockResolvedValue({ id: data.items[0].id });
  render(<PlatformNetworkPolicy canPropose canApprove={false} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Propose change" }),
  );
  fireEvent.change(screen.getByLabelText("Country codes (GE, DE)"), {
    target: { value: "GE, DE" },
  });
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
  await screen.findByRole("alert");
  const input = vi.mocked(platformApi.proposeNetworkPolicy).mock.calls[0][0];
  expect(input.settings.countries).toEqual(["GE", "DE"]);
  expect(screen.getByLabelText("Your password")).toHaveProperty("value", "");
  expect(screen.queryByLabelText("Country filter")).toBeNull();
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await screen.findByText("Change saved. Status refreshed.");
  expect(vi.mocked(platformApi.proposeNetworkPolicy).mock.calls[1][0]).toEqual(
    input,
  );
});
it("hashes transient address and sends only fingerprint with bounded expiry for independent approval", async () => {
  vi.mocked(platformApi.networkAddressKey).mockResolvedValue({
    key: "a".repeat(64),
  });
  vi.mocked(platformApi.proposeNetworkPolicy).mockResolvedValue({
    id: data.items[0].id,
  });
  render(<PlatformNetworkPolicy canPropose canApprove={false} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Propose change" }),
  );
  fireEvent.change(screen.getByLabelText("IP address"), {
    target: { value: "192.0.2.1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add to list" }));
  await waitFor(() =>
    expect(screen.getByLabelText("IP address")).toHaveProperty("value", ""),
  );
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
  await screen.findByText("Change saved. Status refreshed.");
  const body = vi.mocked(platformApi.proposeNetworkPolicy).mock.calls[0][0];
  expect(body.settings.blocked[0].key).toBe("a".repeat(64));
  expect(
    Date.parse(body.settings.blocked[0].until) - Date.now(),
  ).toBeLessThanOrEqual(3600000);
  expect(JSON.stringify(body)).not.toContain("192.0.2.1");
});
