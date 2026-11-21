import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Events from "../pages/Events";
import { eventsApi, type EventDetail } from "../api/events";
import { workApi } from "../api/work";
import { demoApi } from "../api/demo";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/events", () => ({
  eventsApi: { list: vi.fn(), detail: vi.fn(), write: vi.fn() },
}));
vi.mock("../api/work", () => ({
  workApi: { contexts: vi.fn(), units: vi.fn(), write: vi.fn() },
}));
vi.mock("../api/demo", () => ({
  demoApi: {
    scenario: vi.fn().mockRejectedValue(new Error("Not demo")),
    stepUp: vi.fn(),
  },
}));
const row: EventDetail = {
  id: "event",
  unitId: "region",
  title: "Community gathering",
  description: "Practical support",
  location: "Meeting point",
  startsAt: "2099-01-01T10:00:00Z",
  endsAt: "2099-01-01T12:00:00Z",
  status: "open",
  version: 1,
  canManage: true,
  rewardPolicy: "once_per_event",
  contributionOffer: { amount: 10, memberMonthCap: 100, ruleVersion: 1 },
  tasks: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(demoApi.scenario).mockRejectedValue(new Error("Not demo"));
  vi.mocked(workApi.contexts).mockResolvedValue([
    { id: "org", name: "Organization" },
  ]);
  vi.mocked(workApi.units).mockResolvedValue([
    { id: "region", name: "Region", parentId: null, canCreate: true },
  ]);
  vi.mocked(eventsApi.list).mockResolvedValue({
    items: [row],
    total: 1,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(eventsApi.detail).mockResolvedValue(row);
});
const mount = () =>
  render(
    <MemoryRouter>
      <Events />
    </MemoryRouter>,
  );
it("only exposes server-authorized event controls, while showing the fixed once-per-event offer", async () => {
  vi.mocked(eventsApi.detail).mockResolvedValue({ ...row, canManage: false });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open event" }));
  expect(await screen.findByText(/One award per member/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Add task" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel event" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
});
it("freezes an uncertain event write and retries the identical payload and key", async () => {
  vi.mocked(eventsApi.write)
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValue({ id: "event", version: 1 });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Create event" }));
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Community gathering" },
  });
  fireEvent.change(screen.getByLabelText("Starts at"), {
    target: { value: "2099-01-01T10:00" },
  });
  fireEvent.change(screen.getByLabelText("Ends at"), {
    target: { value: "2099-01-01T12:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry same request" }),
  );
  await waitFor(() => expect(eventsApi.write).toHaveBeenCalledTimes(2));
  expect(vi.mocked(eventsApi.write).mock.calls[1][0]).toEqual(
    vi.mocked(eventsApi.write).mock.calls[0][0],
  );
  expect(vi.mocked(eventsApi.write).mock.calls[0][0]).toMatchObject({
    operation: "event_create",
    contributionRuleId: null,
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "New event" }),
    ).not.toBeInTheDocument(),
  );
});
it("creates a linked task without a client-selected reward override", async () => {
  vi.mocked(workApi.write).mockRejectedValue(new Error("Unknown result"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open event" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Transport support" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await screen.findByRole("button", { name: "Retry same request" });
  const sent = vi.mocked(workApi.write).mock.calls[0][0];
  expect(sent).toMatchObject({
    operation: "create",
    eventId: "event",
    unitId: "region",
  });
  expect(sent).not.toHaveProperty("contributionRuleId");
  expect(screen.getByLabelText("Title")).toBeDisabled();
});
it("clears denied event details and allows returning to the scoped list", async () => {
  vi.mocked(eventsApi.detail).mockRejectedValue({ response: { status: 403 } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open event" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "You no longer have permission",
  );
  expect(
    screen.queryByRole("button", { name: "Add task" }),
  ).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "All events" }));
  expect(
    await screen.findByRole("button", { name: "Open event" }),
  ).toBeInTheDocument();
});
it("edits and reschedules an open event with required reason while keeping offer pinned", async () => {
  vi.mocked(eventsApi.detail).mockResolvedValue({
    ...row,
    linkedSummary: {
      totalTasks: 2,
      openTasks: 1,
      verifiedOpenTasks: 0,
      cancellableOpenTasks: 1,
      completedTasks: 1,
      cancelledTasks: 0,
      claimsCount: 1,
    },
    history: [
      {
        version: 1,
        action: "edit",
        note: "Earlier note",
        details: {},
        createdAt: "2099-01-01T08:00:00Z",
      },
    ],
  });
  vi.mocked(eventsApi.write).mockResolvedValue({ id: "event", version: 2 });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open event" }));
  expect(
    await screen.findByText(/Reward claims: 1/),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Edit or reschedule", exact: true }),
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Rescheduled gathering" },
  });
  fireEvent.change(screen.getByLabelText("Reason for amendment"), {
    target: { value: "Venue updated for attendees" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await waitFor(() => expect(eventsApi.write).toHaveBeenCalledTimes(1));
  expect(vi.mocked(eventsApi.write).mock.calls[0][0]).toMatchObject({
    operation: "event_edit",
    id: "event",
    version: 1,
    title: "Rescheduled gathering",
    note: "Venue updated for attendees",
  });
});
it("requires reason when cancelling an event together with open unverified linked tasks", async () => {
  vi.mocked(eventsApi.detail).mockResolvedValue({
    ...row,
    linkedSummary: {
      totalTasks: 2,
      openTasks: 1,
      verifiedOpenTasks: 0,
      cancellableOpenTasks: 1,
      completedTasks: 1,
      cancelledTasks: 0,
      claimsCount: 1,
    },
  });
  vi.mocked(eventsApi.write).mockResolvedValue({ id: "event", version: 2 });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open event" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel event", exact: true }),
  );
  const confirm = screen.getByRole("button", { name: "Confirm" });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Cancellation reason"), {
    target: { value: "Postponed indefinitely" },
  });
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);
  await waitFor(() => expect(eventsApi.write).toHaveBeenCalledTimes(1));
  expect(vi.mocked(eventsApi.write).mock.calls[0][0]).toMatchObject({
    operation: "event_cancel",
    id: "event",
    note: "Postponed indefinitely",
    cancelLinkedTasks: true,
  });
});
it("opens an inbox event destination directly without auto-mutating", async () => {
  const inboxEventId = "01234567-1234-4321-8123-012345678902";
  vi.mocked(eventsApi.list).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(eventsApi.detail).mockResolvedValue({
    ...row,
    id: inboxEventId,
    title: "Inbox linked event",
    status: "completed",
  });
  render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/events",
          state: {
            inbox: {
              source: "event",
              organizationId: "org",
              id: inboxEventId,
            },
          },
        },
      ]}
    >
      <Events />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Inbox linked event", exact: true });
  expect(eventsApi.detail).toHaveBeenCalledWith("org", inboxEventId);
  expect(eventsApi.write).not.toHaveBeenCalled();
});
