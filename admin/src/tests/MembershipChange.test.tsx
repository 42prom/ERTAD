import { beforeEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MembershipChange from "../components/MembershipChange";
import { reviewApi } from "../api/reviews";
import { demoApi } from "../api/demo";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/reviews", () => ({
  reviewApi: { changeOptions: vi.fn(), change: vi.fn() },
}));
vi.mock("../api/demo", () => ({
  demoApi: { scenario: vi.fn(), stepUp: vi.fn() },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const options = {
  id: "membership",
  version: 3,
  active: true,
  state: "active",
  canSuspend: true,
  canResume: false,
  canRevoke: true,
  blocked: false,
  validUntil: null,
  unitName: "Region A",
  positionName: "Participant",
  destinations: [{ id: "position", name: "Member", unitName: "Region B" }],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reviewApi.changeOptions).mockResolvedValue(options);
  vi.mocked(reviewApi.change).mockResolvedValue({
    id: "review",
    status: "pending",
  });
  vi.mocked(demoApi.scenario).mockResolvedValue(
    {} as Awaited<ReturnType<typeof demoApi.scenario>>,
  );
  vi.mocked(demoApi.stepUp).mockResolvedValue({});
});
async function open() {
  render(
    <MemoryRouter>
      <MembershipChange organizationId="org" membershipId="membership" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage membership" }));
  await screen.findByLabelText("Action");
}
function intent() {
  fireEvent.change(screen.getByLabelText("Action"), {
    target: { value: "revoke" },
  });
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "Synthetic operational reason" },
  });
}
it("requires explicit revocation intent and submits the frozen version without a new position", async () => {
  await open();
  intent();
  expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  expect(screen.queryByLabelText("Destination position")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  await screen.findByText(/Request submitted/);
  const payload = vi.mocked(reviewApi.change).mock.calls[0][0];
  expect(payload).toMatchObject({
    membershipId: "membership",
    version: 3,
    kind: "revoke",
  });
  expect(payload).not.toHaveProperty("positionId");
  expect(payload).not.toHaveProperty("validUntil");
});
it("uses the selected destination and requested expiry for a transfer", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("Destination position"), {
    target: { value: "position" },
  });
  fireEvent.change(screen.getByLabelText("New membership valid until"), {
    target: { value: "2030-01-01T12:00" },
  });
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "Synthetic transfer reason" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  await screen.findByText(/Request submitted/);
  expect(vi.mocked(reviewApi.change).mock.calls[0][0]).toMatchObject({
    kind: "transfer",
    positionId: "position",
    version: 3,
  });
});
it("does not permit transfer with active task responsibilities", async () => {
  vi.mocked(reviewApi.changeOptions).mockResolvedValue({
    ...options,
    blocked: true,
    canRevoke: false,
  });
  await open();
  expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  expect(screen.getByText(/Active task responsibilities/)).toBeVisible();
  expect(reviewApi.change).not.toHaveBeenCalled();
});
it("permits explicit suspension with active work without sending a replacement or expiry", async () => {
  vi.mocked(reviewApi.changeOptions).mockResolvedValue({
    ...options,
    blocked: true,
    canRevoke: false,
  });
  await open();
  fireEvent.change(screen.getByLabelText("Action"), {
    target: { value: "suspend" },
  });
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "Synthetic temporary restriction" },
  });
  expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  await screen.findByText(/Request submitted/);
  expect(reviewApi.change).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "suspend", version: 3 }),
  );
  expect(vi.mocked(reviewApi.change).mock.calls[0][0]).not.toHaveProperty(
    "validUntil",
  );
  expect(screen.queryByLabelText("Destination position")).toBeNull();
});
it("requires choosing restoration explicitly for a suspended membership and never extends its term", async () => {
  vi.mocked(reviewApi.changeOptions).mockResolvedValue({
    ...options,
    active: false,
    state: "suspended",
    canSuspend: false,
    canResume: true,
  });
  await open();
  expect(screen.getByLabelText("Action")).toHaveValue("");
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "Synthetic approved restoration" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Action"), {
    target: { value: "resume" },
  });
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  await screen.findByText(/Request submitted/);
  const payload = vi.mocked(reviewApi.change).mock.calls[0][0];
  expect(payload.kind).toBe("resume");
  expect(payload).not.toHaveProperty("positionId");
  expect(payload).not.toHaveProperty("validUntil");
});
it("requires confirmation again when the source version changes during refresh", async () => {
  await open();
  intent();
  fireEvent.click(screen.getByRole("checkbox"));
  vi.mocked(reviewApi.changeOptions).mockResolvedValue({
    ...options,
    version: 4,
  });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
  expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  expect(reviewApi.change).not.toHaveBeenCalled();
});
it("preserves the exact request after an uncertain write and locks edits", async () => {
  vi.mocked(reviewApi.change).mockRejectedValueOnce(new Error("lost response"));
  await open();
  intent();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Action")).toBeDisabled();
  const original = vi.mocked(reviewApi.change).mock.calls[0][0];
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await screen.findByText(/Request submitted/);
  expect(vi.mocked(reviewApi.change).mock.calls[1][0]).toEqual(original);
});
it("hides stale controls after a denied write and never reports success", async () => {
  vi.mocked(reviewApi.change).mockRejectedValue({ response: { status: 403 } });
  await open();
  intent();
  fireEvent.click(screen.getByRole("checkbox"));
  vi.mocked(reviewApi.changeOptions).mockRejectedValue({
    response: { status: 403 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  await waitFor(() => expect(screen.queryByLabelText("Action")).toBeNull());
  expect(screen.queryByText(/Request submitted/)).toBeNull();
  expect(await screen.findByText(/Access is no longer/)).toBeVisible();
});
