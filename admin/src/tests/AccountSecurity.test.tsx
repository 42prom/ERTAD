import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AccountSecurity from "../pages/AccountSecurity";
import { accountApi } from "../api/account";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/account", () => ({
  accountApi: {
    sessions: vi.fn(),
    revoke: vi.fn(),
    revokeOthers: vi.fn(),
    changePassword: vi.fn(),
    recovery: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
vi.mock("../components/OwnEmailChange", () => ({default:()=>null}));
const sessions = {
  items: [
    {
      id: "current",
      current: true,
      createdAt: "2026-11-04T10:00:00Z",
      lastSeenAt: "2026-11-04T11:00:00Z",
      expiresAt: "2026-11-04T12:00:00Z",
    },
    {
      id: "other",
      current: false,
      createdAt: "2026-11-04T09:00:00Z",
      lastSeenAt: "2026-11-04T10:00:00Z",
      expiresAt: "2026-11-04T12:00:00Z",
    },
  ],
  nextBefore: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(accountApi.sessions).mockResolvedValue(sessions);
  vi.mocked(accountApi.recovery).mockResolvedValue({ available: false, pending: null });
  vi.mocked(authApi.stepUp).mockResolvedValue({
    expiresAt: "2026-11-04T12:00:00Z",
  });
  vi.mocked(accountApi.changePassword).mockResolvedValue({ signedOut: true });
  vi.mocked(accountApi.revoke).mockResolvedValue({});
  vi.mocked(accountApi.revokeOthers).mockResolvedValue({ revokedCount: 28 });
});
async function open() {
  render(<AccountSecurity />);
  await screen.findByText("Current session");
}
function fill(secret = "Synthetic-long-passphrase-32") {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "Current-synthetic-password" },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: secret },
  });
  fireEvent.change(screen.getByLabelText("Repeat new password"), {
    target: { value: secret },
  });
}
it("shows only own session metadata and never offers revocation of the current session", async () => {
  await open();
  expect(
    screen.getAllByRole("button", { name: "Revoke session" }),
  ).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
});
it("requires explicit confirmation, reauthenticates and changes the password without a target account", async () => {
  await open();
  fill();
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText(/Password changed and all sessions ended/);
  expect(authApi.stepUp).toHaveBeenCalledExactlyOnceWith(
    "Current-synthetic-password",
  );
  expect(accountApi.changePassword).toHaveBeenCalledExactlyOnceWith(
    "Synthetic-long-passphrase-32",
  );
  expect(screen.queryByLabelText("New password")).toBeNull();
});
it("rejects mismatched confirmation and oversized multibyte passwords", async () => {
  await open();
  fill("ა".repeat(25));
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  fill();
  fireEvent.change(screen.getByLabelText("Repeat new password"), {
    target: { value: "Different-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(accountApi.changePassword).not.toHaveBeenCalled();
});
it("does not change credentials when current-password confirmation fails", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue({ response: { status: 401 } });
  await open();
  fill();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByRole("alert");
  expect(accountApi.changePassword).not.toHaveBeenCalled();
  expect(screen.getByLabelText("New password")).toHaveValue(
    "Synthetic-long-passphrase-32",
  );
});
it("does not retry an uncertain password mutation or retain entered secrets in the result view", async () => {
  vi.mocked(accountApi.changePassword).mockRejectedValue(
    new Error("Synthetic transport loss"),
  );
  await open();
  fill();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText(/outcome is uncertain/);
  expect(accountApi.changePassword).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("New password")).toBeNull();
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/login",
  );
});
it("confirms and revokes only the selected session while retaining the current login", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Revoke session" }));
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "Current-synthetic-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText("Selected session revoked.");
  expect(accountApi.revoke).toHaveBeenCalledExactlyOnceWith("other");
  expect(accountApi.changePassword).not.toHaveBeenCalled();
  expect(await screen.findByText("Current session")).toBeVisible();
});
it("hides stale session data on denied refresh and allows a fresh read", async () => {
  await open();
  vi.mocked(accountApi.sessions).mockRejectedValueOnce({
    response: { status: 403 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
  await screen.findByText("Sessions could not load.");
  expect(screen.queryByText("Other session")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
  await waitFor(() => expect(screen.getByText("Other session")).toBeVisible());
});

it("confirms revocation of all other sessions, including other pages, using the real password", async () => {
  await open();
  fill();
  fireEvent.click(
    screen.getByRole("button", { name: "Close all other sessions" }),
  );
  expect(
    screen.getByRole("heading", { name: "Close all other sessions" }),
  ).toHaveFocus();
  expect(screen.queryByLabelText("New password")).toBeNull();
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "Current-synthetic-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText(
    "Other sessions closed (28). Your current session remains active.",
  );
  expect(authApi.stepUp).toHaveBeenCalledExactlyOnceWith(
    "Current-synthetic-password",
  );
  expect(accountApi.revokeOthers).toHaveBeenCalledExactlyOnceWith();
  expect(accountApi.revoke).not.toHaveBeenCalled();
  expect(accountApi.changePassword).not.toHaveBeenCalled();
  expect(screen.getByLabelText("New password")).toHaveValue("");
});

it("clears confirmation when changing between single and all-other revocation or cancelling", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Revoke session" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Close all other sessions" }),
  );
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  const openAll = screen.getByRole("button", { name: "Close all other sessions" });
  openAll.focus();
  fireEvent.click(openAll);
  expect(screen.getByRole("heading", { name: "Close all other sessions" })).toHaveFocus();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByLabelText("New password")).toBeVisible();
  expect(accountApi.revokeOthers).not.toHaveBeenCalled();
});

it("does not revoke other sessions when password verification fails", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue({ response: { status: 401 } });
  await open();
  fireEvent.click(
    screen.getByRole("button", { name: "Close all other sessions" }),
  );
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "wrong" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByRole("alert");
  expect(accountApi.revokeOthers).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Current password")).toHaveValue("");
});

it("refreshes an uncertain bulk revocation without retrying and requires new explicit confirmation", async () => {
  vi.mocked(accountApi.revokeOthers).mockRejectedValue(
    new Error("Synthetic transport loss"),
  );
  await open();
  fireEvent.click(
    screen.getByRole("button", { name: "Close all other sessions" }),
  );
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "Current-synthetic-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText(/session revocation outcome is uncertain/);
  expect(accountApi.revokeOthers).toHaveBeenCalledOnce();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByLabelText("Current password")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await waitFor(() => expect(accountApi.sessions).toHaveBeenCalledTimes(2));
});
