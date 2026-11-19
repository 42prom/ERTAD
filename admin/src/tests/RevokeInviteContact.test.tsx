import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import RevokeInviteContact from "../components/RevokeInviteContact";
import { authApi } from "../api/client";
import { invitationsApi } from "../api/invitations";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
vi.mock("../api/invitations", () => ({
  invitationsApi: { revokeContact: vi.fn() },
}));
const contact = {
  id: "old-contact",
  memberId: "member",
  unitId: "unit",
  unitName: "Region A",
  displayName: "Synthetic recipient",
  contactHint: "re…@…",
  source: "email" as const,
};
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.mocked(authApi.stepUp).mockResolvedValue({
    expiresAt: "2026-11-09T00:00:00Z",
  });
});
async function fill() {
  fireEvent.click(
    screen.getByRole("button", { name: "Revoke recipient contact" }),
  );
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
}
it("requires explicit intent and password, revokes the selected immutable target and clears the dialog", async () => {
  const settled = vi.fn();
  render(
    <RevokeInviteContact
      organizationId="org"
      contact={contact}
      onSettled={settled}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Revoke recipient contact" }),
  );
  expect(
    screen.getByRole("button", { name: "Confirm revocation" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(true));
  expect(authApi.stepUp).toHaveBeenCalledWith("synthetic-password");
  expect(invitationsApi.revokeContact).toHaveBeenCalledWith(
    "org",
    "old-contact",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByLabelText("Your password")).toBeNull();
});
it("failed password confirmation denies the write and returns an unconfirmed outcome", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue(Error("denied"));
  const settled = vi.fn();
  render(
    <RevokeInviteContact
      organizationId="org"
      contact={contact}
      onSettled={settled}
    />,
  );
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(false));
  expect(invitationsApi.revokeContact).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Your password")).toBeNull();
});
it("an unknown mutation outcome never retries automatically and Escape restores focus", async () => {
  vi.mocked(invitationsApi.revokeContact).mockRejectedValue(Error("offline"));
  const settled = vi.fn();
  render(
    <RevokeInviteContact
      organizationId="org"
      contact={contact}
      onSettled={settled}
    />,
  );
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(false));
  expect(invitationsApi.revokeContact).toHaveBeenCalledTimes(1);
  const trigger = screen.getByRole("button", {
    name: "Revoke recipient contact",
  });
  fireEvent.click(trigger);
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { cancelable: true, bubbles: true }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
});
