import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PlatformAccounts from "../components/PlatformAccounts";
import {
  accountSecurityApi,
  type SecurityAccount,
} from "../api/accountSecurity";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/accountSecurity", () => ({
  accountSecurityApi: {
    list: vi.fn(),
    hold: vi.fn(),
    release: vi.fn(),
    proposeLifecycle: vi.fn(),
    reviewLifecycle: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const account: SecurityAccount = {
  id: "00000000-0000-4000-8000-000000000001",
  active: true,
  recoverable: true,
  createdAt: "2026-11-10T00:00:00Z",
  hold: null,
};
const hold = {
  id: "00000000-0000-4000-8000-000000000002",
  heldAt: "2026-11-10T01:00:00Z",
  reason: "suspected_compromise" as const,
  own: false,
  credentialChanged: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, "", "/platform/accounts");
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.mocked(accountSecurityApi.list).mockResolvedValue({
    items: [account],
    nextBefore: null,
  });
  vi.mocked(authApi.stepUp).mockResolvedValue({
    expiresAt: "2026-11-10T02:00:00Z",
  });
  vi.mocked(accountSecurityApi.hold).mockResolvedValue({});
  vi.mocked(accountSecurityApi.release).mockResolvedValue({});
  vi.mocked(accountSecurityApi.proposeLifecycle).mockResolvedValue({});
  vi.mocked(accountSecurityApi.reviewLifecycle).mockResolvedValue({});
});
async function open(kind = "hold") {
  render(<PlatformAccounts canHold canRelease />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: kind === "hold" ? "Pause web access" : "Release hold",
      exact: true,
    }),
  );
  fireEvent.change(screen.getByLabelText("Your current password"), {
    target: { value: "Synthetic-password" },
  });
}
it("withholds mutations without capabilities and protects accounts lacking recovery", async () => {
  vi.mocked(accountSecurityApi.list).mockResolvedValue({
    items: [{ ...account, recoverable: false }],
    nextBefore: null,
  });
  render(<PlatformAccounts canHold canRelease={false} />);
  expect(
    await screen.findByRole("button", {
      name: "Pause web access",
      exact: true,
    }),
  ).toBeDisabled();
  expect(screen.getByText("Separate procedure required")).toBeVisible();
});
it("a read-only operator has no hold/release buttons", async () => {
  render(<PlatformAccounts canHold={false} canRelease={false} />);
  await screen.findByText(account.id);
  expect(
    screen.queryByRole("button", { name: "Pause web access", exact: true }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Release hold", exact: true }),
  ).toBeNull();
});
it("requires intent and actual password then submits only the selected account and reason", async () => {
  await open();
  const submit = screen.getByRole("button", {
    name: "Confirm security action",
  });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(submit);
  await screen.findByText(
    "Change saved. Organizational permissions are unchanged.",
  );
  expect(authApi.stepUp).toHaveBeenCalledExactlyOnceWith("Synthetic-password");
  expect(accountSecurityApi.hold).toHaveBeenCalledExactlyOnceWith(
    account.id,
    expect.any(String),
    "suspected_compromise",
  );
  expect(screen.queryByLabelText("Your current password")).toBeNull();
});
it("release stays disabled for the original operator or unchanged credentials", async () => {
  vi.mocked(accountSecurityApi.list).mockResolvedValue({
    items: [{ ...account, hold: { ...hold, own: true } }],
    nextBefore: null,
  });
  render(<PlatformAccounts canHold canRelease />);
  expect(
    await screen.findByRole("button", { name: "Release hold", exact: true }),
  ).toBeDisabled();
  expect(
    screen.getByText("Another technical manager is required."),
  ).toBeVisible();
});
it("independent release pins the immutable hold ID", async () => {
  vi.mocked(accountSecurityApi.list).mockResolvedValue({
    items: [{ ...account, hold }],
    nextBefore: null,
  });
  await open("release");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm security action" }),
  );
  await screen.findByText(/Change saved/);
  expect(accountSecurityApi.release).toHaveBeenCalledExactlyOnceWith(
    hold.id,
    expect.any(String),
  );
  expect(accountSecurityApi.hold).not.toHaveBeenCalled();
});
it("wrong passwords do not submit mutations and secrets are discarded", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue(Error("denied"));
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm security action" }),
  );
  await screen.findByText("Password confirmation failed. No action was sent.");
  expect(accountSecurityApi.hold).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Your current password")).toBeNull();
});
it("unknown results refresh state without mutation replay", async () => {
  vi.mocked(accountSecurityApi.hold).mockRejectedValue(Error("lost response"));
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm security action" }),
  );
  await screen.findByText(/outcome is unconfirmed/);
  await waitFor(() => expect(accountSecurityApi.list).toHaveBeenCalledTimes(2));
  expect(accountSecurityApi.hold).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("Your current password")).toBeNull();
});
it("a replacement hold cannot inherit a stale release confirmation", async () => {
  vi.mocked(accountSecurityApi.list).mockResolvedValue({
    items: [{ ...account, hold }],
    nextBefore: null,
  });
  await open("release");
  fireEvent.click(screen.getByRole("checkbox"));
  vi.mocked(accountSecurityApi.list).mockResolvedValue({
    items: [
      {
        ...account,
        hold: { ...hold, id: "replacement", credentialChanged: false },
      },
    ],
    nextBefore: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh accounts" }));
  await screen.findByText("Password change required");
  expect(
    screen.getByRole("button", { name: "Confirm security action" }),
  ).toBeDisabled();
  expect(accountSecurityApi.release).not.toHaveBeenCalled();
});
it("native dialog cancellation clears secrets and restores focus", async () => {
  await open();
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { cancelable: true, bubbles: true }),
  );
  expect(screen.queryByLabelText("Your current password")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Pause web access", exact: true }),
  ).toHaveFocus();
});
it("proposes account disable with explicit intent and password confirmation", async () => {
  vi.mocked(accountSecurityApi.list).mockResolvedValue({
    items: [{ ...account, lostContactEligible: true, mfaEnabled: true }],
    nextBefore: null,
    proposals: [],
  });
  render(<PlatformAccounts canHold canRelease canPropose canApprove={false} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Disable account", exact: true }),
  );
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Your current password"), {
    target: { value: "Synthetic-password" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm security action" }),
  );
  await screen.findByText(/Change saved/);
  expect(accountSecurityApi.proposeLifecycle).toHaveBeenCalledExactlyOnceWith({
    accountId: account.id,
    requestId: expect.any(String),
    action: "disable_account",
    reason: "policy_violation",
  });
});
it("requires valid replacement email for lost-contact recovery and supports independent review", async () => {
  const proposal = {
    id: "00000000-0000-4000-8000-000000000099",
    accountId: account.id,
    action: "lost_contact_recovery" as const,
    reason: "lost_contact" as const,
    status: "pending" as const,
    createdAt: "2026-11-11T01:00:00Z",
    expiresAt: "2026-11-12T01:00:00Z",
    reviewedAt: null,
    mine: false,
    newEmailHint: "ne…@example.org",
  };
  vi.mocked(accountSecurityApi.list).mockResolvedValue({
    items: [{ ...account, lostContactEligible: true, mfaEnabled: true }],
    nextBefore: null,
    proposals: [proposal],
  });
  render(<PlatformAccounts canHold={false} canRelease canPropose canApprove />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Lost-contact recovery",
      exact: true,
    }),
  );
  const submit = screen.getByRole("button", {
    name: "Confirm security action",
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Your current password"), {
    target: { value: "Synthetic-password" },
  });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Verified replacement email"), {
    target: { value: "New.Owner@example.org" },
  });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await screen.findByText(/Change saved/);
  expect(accountSecurityApi.proposeLifecycle).toHaveBeenCalledExactlyOnceWith({
    accountId: account.id,
    requestId: expect.any(String),
    action: "lost_contact_recovery",
    reason: "lost_contact",
    newEmail: "new.owner@example.org",
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve", exact: true }),
  );
  expect(screen.getByText("ne…@example.org")).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Your current password"), {
    target: { value: "Synthetic-password" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm security action" }),
  );
  await waitFor(() =>
    expect(accountSecurityApi.reviewLifecycle).toHaveBeenCalledExactlyOnceWith(
      proposal.id,
      expect.any(String),
      "approve",
    ),
  );
});
