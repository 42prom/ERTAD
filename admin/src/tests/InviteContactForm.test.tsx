import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import InviteContactForm from "../components/InviteContactForm";
import { invitationsApi } from "../api/invitations";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/invitations", () => ({
  invitationsApi: { candidates: vi.fn(), createContact: vi.fn() },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invitationsApi.candidates).mockResolvedValue({
    items: [
      {
        memberId: "member",
        unitId: "unit",
        unitName: "Region A",
        displayName: "Synthetic recipient",
      },
    ],
    page: 1,
  });
  vi.mocked(authApi.stepUp).mockResolvedValue({
    expiresAt: "2026-11-09T00:00:00Z",
  });
});
async function fill() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Add member email" }),
  );
  await screen.findByRole("option", { name: "Synthetic recipient · Region A" });
  fireEvent.change(screen.getByLabelText("Member and unit"), {
    target: { value: "unit:member" },
  });
  fireEvent.change(screen.getByLabelText("Member email"), {
    target: { value: "recipient@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
}
it("stores a chosen scoped recipient only after password and member consent confirmation", async () => {
  vi.mocked(invitationsApi.createContact).mockResolvedValue({ id: "contact" });
  const created = vi.fn();
  render(<InviteContactForm organizationId="org" onCreated={created} />);
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
  await screen.findByText(/Contact saved/);
  expect(authApi.stepUp).toHaveBeenCalledWith("synthetic-password");
  expect(invitationsApi.createContact).toHaveBeenCalledWith({
    organizationId: "org",
    unitId: "unit",
    memberId: "member",
    email: "recipient@example.test",
    requestId: expect.any(String),
  });
  expect(created).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Your password")).toBeNull();
});
it("failed reauthentication prevents writing and clears entered secrets", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue(Error("denied"));
  render(<InviteContactForm organizationId="org" onCreated={vi.fn()} />);
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
  await screen.findByText(/outcome is unconfirmed/);
  expect(invitationsApi.createContact).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Your password")).toHaveValue("");
  expect(screen.getByLabelText("Member email")).toHaveValue("");
});
