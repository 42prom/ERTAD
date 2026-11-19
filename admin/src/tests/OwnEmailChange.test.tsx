import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OwnEmailChange from "../components/OwnEmailChange";
import { emailChangeApi, type OwnEmailStatus } from "../api/emailChange";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/emailChange", () => ({
  emailChangeApi: { status: vi.fn(), request: vi.fn(), cancel: vi.fn() },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const state: OwnEmailStatus = {
  accountId: "own-account",
  currentEmail: "old@example.test",
  available: true,
  deliveryEnabled: true,
  pending: null,
};
const pending = {
  id: "selected",
  newEmail: "next@example.test",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1800000).toISOString(),
  valid: true,
  mailStatus: "queued",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(emailChangeApi.status).mockResolvedValue(state);
  vi.mocked(authApi.stepUp).mockResolvedValue({ expiresAt: pending.expiresAt });
  vi.mocked(emailChangeApi.request).mockResolvedValue({ id: "new-request" });
  vi.mocked(emailChangeApi.cancel).mockResolvedValue({ cancelled: true });
});
async function open() {
  render(<OwnEmailChange />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Change sign-in email" }),
  );
  fireEvent.change(screen.getByLabelText("New email address"), {
    target: { value: "NEXT@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "Synthetic-password" },
  });
}
it("Escape clears the draft and restores focus to the originating action", async () => {
  await open();
  fireEvent.keyDown(screen.getByLabelText("New email address"), {
    key: "Escape",
  });
  expect(screen.queryByLabelText("New email address")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Change sign-in email" }),
  ).toHaveFocus();
});
it("explains unverified binding and disabled delivery without enabling a mutation", async () => {
  vi.mocked(emailChangeApi.status).mockResolvedValue({
    ...state,
    available: false,
  });
  render(<OwnEmailChange />);
  await screen.findByText(
    "Changes require an account bound to a verified contact.",
  );
  expect(
    screen.getByRole("button", { name: "Change sign-in email" }),
  ).toBeDisabled();
});
it("requires intent and actual password confirmation; normalizes only the selected new address", async () => {
  await open();
  const button = screen.getByRole("button", { name: "Confirm email request" });
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(button);
  await screen.findByText(/Request saved/);
  expect(authApi.stepUp).toHaveBeenCalledExactlyOnceWith("Synthetic-password");
  expect(emailChangeApi.request).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    "next@example.test",
  );
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(await screen.findByText("old@example.test")).toBeVisible();
});
it("failed password sends no mutation and clears sensitive input", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue(Error("denied"));
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm email request" }),
  );
  await screen.findByText("Password confirmation failed.");
  expect(emailChangeApi.request).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Current password")).toBeNull();
});
it("unknown outcomes refresh status without replaying the mutation or retaining drafts", async () => {
  vi.mocked(emailChangeApi.request).mockRejectedValue(Error("lost response"));
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm email request" }),
  );
  await screen.findByText(/outcome is unconfirmed/);
  await waitFor(() => expect(emailChangeApi.status).toHaveBeenCalledTimes(2));
  expect(emailChangeApi.request).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("New email address")).toBeNull();
});
it("cancellation targets an immutable ID and cannot transfer confirmation to a replacement", async () => {
  vi.mocked(emailChangeApi.status).mockResolvedValue({ ...state, pending });
  render(<OwnEmailChange />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel email request" }),
  );
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "Synthetic-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  vi.mocked(emailChangeApi.status).mockResolvedValue({
    ...state,
    pending: {
      ...pending,
      id: "replacement",
      newEmail: "replacement@example.test",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh email status" }));
  await screen.findByText(/replacement@example.test/);
  expect(
    screen.getByRole("button", { name: "Confirm email request" }),
  ).toBeDisabled();
  expect(emailChangeApi.cancel).not.toHaveBeenCalled();
});
it("cancels the selected request after fresh password confirmation", async () => {
  vi.mocked(emailChangeApi.status).mockResolvedValue({ ...state, pending });
  render(<OwnEmailChange />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel email request" }),
  );
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "Synthetic-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm email request" }),
  );
  await screen.findByText("Email change request cancelled.");
  expect(emailChangeApi.cancel).toHaveBeenCalledExactlyOnceWith("selected");
});
