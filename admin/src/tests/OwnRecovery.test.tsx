import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OwnRecovery from "../components/OwnRecovery";
import { accountApi } from "../api/account";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/account", () => ({
  accountApi: { recovery: vi.fn(), cancelRecovery: vi.fn() },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const pending = {
  id: "own-request",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1800000).toISOString(),
  delivered: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(accountApi.recovery).mockResolvedValue({
    available: true,
    pending,
  });
  vi.mocked(accountApi.cancelRecovery).mockResolvedValue({ cancelled: true });
  vi.mocked(authApi.stepUp).mockResolvedValue({ expiresAt: pending.expiresAt });
});
async function open() {
  render(<OwnRecovery />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel recovery link" }),
  );
  fireEvent.change(screen.getByLabelText("Current password to cancel link"), {
    target: { value: "Synthetic-password-only" },
  });
}
it("shows an honest unavailable state without offering cancellation", async () => {
  vi.mocked(accountApi.recovery).mockResolvedValue({
    available: false,
    pending: null,
  });
  render(<OwnRecovery />);
  await screen.findByText(
    "Self-service recovery is not currently available for this account.",
  );
  expect(
    screen.queryByRole("button", { name: "Cancel recovery link" }),
  ).toBeNull();
});
it("requires explicit intent and real password confirmation, then cancels only the selected ID", async () => {
  await open();
  expect(
    screen.getByRole("button", { name: "Confirm cancellation" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  await screen.findByText(/Selected recovery link cancelled/);
  expect(authApi.stepUp).toHaveBeenCalledExactlyOnceWith(
    "Synthetic-password-only",
  );
  expect(accountApi.cancelRecovery).toHaveBeenCalledExactlyOnceWith(
    "own-request",
  );
  expect(screen.queryByLabelText("Current password to cancel link")).toBeNull();
});
it("does not send cancellation when password confirmation fails", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue(new Error("denied"));
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  await screen.findByText(/No cancellation was sent/);
  expect(accountApi.cancelRecovery).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Current password to cancel link")).toBeNull();
});
it("clears secrets and refreshes on an uncertain mutation without retry", async () => {
  vi.mocked(accountApi.cancelRecovery).mockRejectedValue(
    new Error("lost response"),
  );
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  await screen.findByText(/Cancellation could not be confirmed/);
  await waitFor(() => expect(accountApi.recovery).toHaveBeenCalledTimes(2));
  expect(accountApi.cancelRecovery).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("Current password to cancel link")).toBeNull();
});
it("does not apply old confirmation to a replacement request", async () => {
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  vi.mocked(accountApi.recovery).mockResolvedValue({
    available: true,
    pending: { ...pending, id: "new-request", delivered: false },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh recovery status" }),
  );
  await screen.findByText("Request awaiting link preparation.");
  expect(
    screen.getByRole("button", { name: "Confirm cancellation" }),
  ).toBeDisabled();
  expect(accountApi.cancelRecovery).not.toHaveBeenCalled();
});
it("removes stale request data on refresh failure", async () => {
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  vi.mocked(accountApi.recovery).mockRejectedValue(new Error("unavailable"));
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh recovery status" }),
  );
  await screen.findByText("Recovery status could not load.");
  expect(screen.queryByText("Recovery link prepared.")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Confirm cancellation" }),
  ).toBeDisabled();
});
