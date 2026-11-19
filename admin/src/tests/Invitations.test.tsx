import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Invitations from "../pages/Invitations";
import ActivateAccount from "../pages/ActivateAccount";
import { invitationsApi } from "../api/invitations";
import { collectiveApi } from "../api/collective";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/invitations", () => ({
  invitationsApi: {
    contexts: vi.fn(),
    contacts: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
    activate: vi.fn(),
  },
}));
vi.mock("../api/collective", () => ({ collectiveApi: { write: vi.fn() } }));
const contact = {
  id: "contact",
  memberId: "member",
  unitId: "region-a",
  unitName: "Region A",
  displayName: "Synthetic recipient",
  contactHint: "re…@example.invalid",
};
const invitation = {
  id: "invite",
  unitId: "region-a",
  unitName: "Region A",
  displayName: "Synthetic recipient",
  status: "activation_pending",
  deadline: "2027-01-01T10:00:00Z",
  canRevoke: true,
  version: 2,
};
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
  vi.mocked(invitationsApi.contexts).mockResolvedValue([
    { id: "org", name: "Synthetic organization" },
  ]);
  vi.mocked(invitationsApi.contacts).mockResolvedValue({
    items: [contact],
    page: 1,
  });
  vi.mocked(invitationsApi.list).mockResolvedValue({
    items: [invitation],
    page: 1,
  });
  vi.mocked(invitationsApi.revoke).mockResolvedValue({});
  vi.mocked(collectiveApi.write).mockResolvedValue({ id: "new", version: 1 });
  vi.mocked(invitationsApi.activate).mockResolvedValue({ activated: true });
});
async function open() {
  render(
    <MemoryRouter>
      <Invitations />
    </MemoryRouter>,
  );
  await screen.findByLabelText("Recipient");
}
function fill() {
  fireEvent.change(screen.getByLabelText("Recipient"), {
    target: { value: "contact" },
  });
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Synthetic invitation reason" },
  });
}
it("requires explicit intent and sends only the bound contact rather than an arbitrary destination or privileges", async () => {
  await open();
  fill();
  expect(
    screen.getByRole("button", { name: "Submit for approval" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText("I confirm submitting this invitation"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
  await waitFor(() => expect(collectiveApi.write).toHaveBeenCalledOnce());
  expect(vi.mocked(collectiveApi.write).mock.calls[0][0]).toMatchObject({
    organizationId: "org",
    unitId: "region-a",
    kind: "account_invite",
    parameters: { contactId: "contact" },
  });
});
it("preserves the exact request and deadline after an uncertain response", async () => {
  vi.mocked(collectiveApi.write).mockRejectedValueOnce(
    new Error("Transport unavailable"),
  );
  await open();
  fill();
  fireEvent.click(
    screen.getByLabelText("I confirm submitting this invitation"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
  const retry = await screen.findByRole("button", {
    name: "Retry same request",
  });
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Recipient")).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(collectiveApi.write).toHaveBeenCalledTimes(2));
  expect(vi.mocked(collectiveApi.write).mock.calls[1][0]).toEqual(
    vi.mocked(collectiveApi.write).mock.calls[0][0],
  );
});
it("removes recipient and revocation details after a failed refresh and prevents stale actions", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Revoke invitation" }));
  expect(
    screen.getByRole("heading", { name: /Revoke invitation/ }),
  ).toHaveFocus();
  vi.mocked(invitationsApi.list).mockRejectedValue(new Error("Denied"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Could not load invitations.");
  expect(screen.queryByLabelText("Recipient")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Confirm" }),
  ).not.toBeInTheDocument();
  expect(invitationsApi.revoke).not.toHaveBeenCalled();
});
it("revocation requires its own confirmation and clears it on an uncertain result", async () => {
  vi.mocked(invitationsApi.revoke).mockRejectedValue(
    new Error("Unknown outcome"),
  );
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Revoke invitation" }));
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("I confirm revocation"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(screen.getByLabelText("I confirm revocation")).not.toBeChecked(),
  );
  expect(invitationsApi.revoke).toHaveBeenCalledTimes(1);
});
const id = "00000000-0000-4000-8000-000000000001",
  token = "A".repeat(43),
  password = "Synthetic-strong-password-42";
function activatePage() {
  window.history.replaceState(null, "", `/activate#${id}.${token}`);
  render(<ActivateAccount />);
}
function activationFill() {
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText("Repeat password"), {
    target: { value: password },
  });
}
it("opening the fragment clears browser history but does not activate; explicit password and intent are required", async () => {
  activatePage();
  expect(location.hash).toBe("");
  expect(invitationsApi.activate).not.toHaveBeenCalled();
  activationFill();
  expect(
    screen.getByRole("button", { name: "Activate account" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByLabelText("I confirm account activation"));
  fireEvent.click(screen.getByRole("button", { name: "Activate account" }));
  await screen.findByRole("status");
  expect(invitationsApi.activate).toHaveBeenCalledWith(id, token, password);
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
});
it("uncertain activation never auto-retries and removes the credential form", async () => {
  vi.mocked(invitationsApi.activate).mockRejectedValue(
    new Error("Lost response"),
  );
  activatePage();
  activationFill();
  fireEvent.click(screen.getByLabelText("I confirm account activation"));
  fireEvent.click(screen.getByRole("button", { name: "Activate account" }));
  await screen.findByText(/Outcome uncertain/);
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  expect(invitationsApi.activate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/login",
  );
});
it("known activation failure clears entered secrets and requires new confirmation", async () => {
  vi.mocked(invitationsApi.activate).mockRejectedValue({
    response: { status: 409 },
  });
  activatePage();
  activationFill();
  fireEvent.click(screen.getByLabelText("I confirm account activation"));
  fireEvent.click(screen.getByRole("button", { name: "Activate account" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Password")).toHaveValue("");
  expect(screen.getByLabelText("Repeat password")).toHaveValue("");
  expect(
    screen.getByLabelText("I confirm account activation"),
  ).not.toBeChecked();
});
it("oversized UTF-8 passwords cannot submit", () => {
  activatePage();
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "ა".repeat(25) },
  });
  fireEvent.change(screen.getByLabelText("Repeat password"), {
    target: { value: "ა".repeat(25) },
  });
  fireEvent.click(screen.getByLabelText("I confirm account activation"));
  expect(
    screen.getByRole("button", { name: "Activate account" }),
  ).toBeDisabled();
});
