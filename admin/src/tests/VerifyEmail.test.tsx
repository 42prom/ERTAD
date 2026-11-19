import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import VerifyEmail from "../pages/VerifyEmail";
import { invitationsApi } from "../api/invitations";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/invitations", () => ({
  invitationsApi: { confirmEmail: vi.fn() },
}));
const id = "00000000-0000-4000-8000-000000000001",
  token = "a".repeat(43);
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, "", "/verify-email#" + id + "." + token);
});
it("opening a link removes its fragment and requires explicit confirmation", async () => {
  vi.mocked(invitationsApi.confirmEmail).mockResolvedValue({ verified: true });
  render(<VerifyEmail />);
  expect(window.location.hash).toBe("");
  expect(invitationsApi.confirmEmail).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText(/Email confirmed. An activation link will follow/);
  expect(invitationsApi.confirmEmail).toHaveBeenCalledWith(id, token);
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("unknown confirmation clears the credential and never retries automatically", async () => {
  vi.mocked(invitationsApi.confirmEmail).mockRejectedValue(Error("offline"));
  render(<VerifyEmail />);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText(/outcome is unconfirmed/);
  expect(invitationsApi.confirmEmail).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
});
it("a malformed link cannot confirm and a new same-tab link can be opened", async () => {
  window.history.replaceState({}, "", "/verify-email#bad");
  render(<VerifyEmail />);
  expect(screen.queryByRole("checkbox")).toBeNull();
  window.history.replaceState({}, "", "/verify-email#" + id + "." + token);
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("checkbox");
  expect(window.location.hash).toBe("");
});
