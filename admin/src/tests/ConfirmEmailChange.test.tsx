import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ConfirmEmailChange from "../pages/ConfirmEmailChange";
import { emailChangeApi } from "../api/emailChange";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/emailChange", () => ({
  emailChangeApi: { status: vi.fn(), confirm: vi.fn() },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const id = "00000000-0000-4000-8000-000000000001",
  token = "a".repeat(43),
  pending = {
    id,
    newEmail: "new@example.test",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    valid: true,
    mailStatus: "accepted",
  };
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(
    {},
    "",
    "/verify-email-change#" + id + "." + token,
  );
  sessionStorage.clear();
  vi.mocked(emailChangeApi.status).mockResolvedValue({
    accountId: "own",
    currentEmail: "old@example.test",
    available: true,
    deliveryEnabled: true,
    pending,
  });
  vi.mocked(authApi.stepUp).mockResolvedValue({ expiresAt: pending.expiresAt });
  vi.mocked(emailChangeApi.confirm).mockResolvedValue({ changed: true });
});
async function open() {
  render(<ConfirmEmailChange />);
  await screen.findByLabelText("Current password");
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "Synthetic-password" },
  });
}
it("a guest link only explains sign-in; clears the credential fragment without mutation", async () => {
  vi.mocked(emailChangeApi.status).mockRejectedValue({
    response: { status: 401 },
  });
  render(<ConfirmEmailChange />);
  expect(location.hash).toBe("");
  await screen.findByText(/Sign in to the account that requested/);
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/login",
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(emailChangeApi.confirm).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
});
it("requires own pending request, explicit intent and fresh password, then clears cached identity", async () => {
  sessionStorage.setItem("admin_csrf", "synthetic");
  sessionStorage.setItem("admin_user", "synthetic");
  await open();
  expect(location.hash).toBe("");
  expect(
    screen.getByRole("button", { name: "Confirm address change" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm address change" }),
  );
  await screen.findByText(/Email changed and all sessions closed/);
  expect(authApi.stepUp).toHaveBeenCalledExactlyOnceWith("Synthetic-password");
  expect(emailChangeApi.confirm).toHaveBeenCalledExactlyOnceWith(
    id,
    token,
    pending.newEmail,
  );
  expect(sessionStorage.length).toBe(0);
  expect(screen.queryByLabelText("Current password")).toBeNull();
});
it("another account or replaced request cannot offer confirmation", async () => {
  vi.mocked(emailChangeApi.status).mockResolvedValue({
    accountId: "other",
    currentEmail: "other@example.test",
    available: true,
    deliveryEnabled: true,
    pending: { ...pending, id: "different" },
  });
  render(<ConfirmEmailChange />);
  await screen.findByText(/does not match a valid request/);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(emailChangeApi.confirm).not.toHaveBeenCalled();
});
it("a wrong password never submits a link and clears the password for a manual retry", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue(Error("denied"));
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm address change" }),
  );
  await screen.findByText("Password confirmation failed.");
  expect(emailChangeApi.confirm).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Current password")).toHaveValue("");
});
it("unknown mutation results discard proof and never replay automatically", async () => {
  vi.mocked(emailChangeApi.confirm).mockRejectedValue(Error("lost response"));
  await open();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm address change" }),
  );
  await screen.findByText(/outcome is unconfirmed/);
  expect(emailChangeApi.confirm).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(sessionStorage.length).toBe(0);
});
it("malformed links never load private status", async () => {
  window.history.replaceState({}, "", "/verify-email-change#bad");
  render(<ConfirmEmailChange />);
  expect(location.hash).toBe("");
  expect(emailChangeApi.status).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Current password")).toBeNull();
});
