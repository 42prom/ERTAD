import { beforeEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Tasks from "../pages/Tasks";
import { MemoryRouter } from "react-router-dom";
import { workApi, type WorkDetail } from "../api/work";
vi.mock("../components/TaskRecognition", () => ({ default: () => null }));
vi.mock("../api/channels", () => ({
  channelsApi: {
    work: vi.fn().mockResolvedValue({ id: null, canCreate: false }),
  },
}));
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/work", () => ({
  workApi: {
    contexts: vi.fn(),
    units: vi.fn(),
    list: vi.fn(),
    detail: vi.fn(),
    write: vi.fn(),
    ack: vi.fn(),
    overview: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("../api/demo", () => ({
  demoApi: {
    scenario: vi.fn().mockResolvedValue({ accounts: [] }),
    stepUp: vi.fn().mockResolvedValue({}),
  },
}));
const row: WorkDetail = {
  id: "task",
  unitId: "region",
  unitName: "Region",
  parentId: null,
  title: "Synthetic task",
  description: "Scoped task evidence",
  roleLabel: "Organizer",
  priority: "normal",
  capacity: 2,
  used: 0,
  verified: 0,
  deadline: "2099-01-01T00:00:00Z",
  status: "open",
  version: 3,
  actorId: "member",
  unread: 0,
  canManage: true,
  canVerify: true,
  canParticipate: true,
  assignments: [],
  events: [],
  children: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workApi.contexts).mockResolvedValue([{ id: "org", name: "Org" }]);
  vi.mocked(workApi.units).mockResolvedValue([
    { id: "region", name: "Region", parentId: null, canCreate: true },
  ]);
  vi.mocked(workApi.list).mockResolvedValue({
    items: [row],
    total: 1,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(workApi.detail).mockResolvedValue(row);
});
it("edits with a required reason and retries the exact request without changing scope or reward", async () => {
  vi.mocked(workApi.detail).mockResolvedValue({
    ...row,
    deadline: "2099-01-01T00:00:37.123+00:00",
  });
  vi.mocked(workApi.write)
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce({ id: "task", version: 4 });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Synthetic task", exact: true }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit task", exact: true }),
  );
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Edit task" })).toHaveFocus(),
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Title", { exact: true }), {
    target: { value: "Updated task" },
  });
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Reason for change"), {
    target: { value: "Meeting instructions clarified" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const retry = await screen.findByRole("button", { name: "Retry request" });
  expect(screen.getByLabelText("Title", { exact: true })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(workApi.write).toHaveBeenCalledTimes(2));
  const [first, second] = vi.mocked(workApi.write).mock.calls;
  expect(second[0]).toEqual(first[0]);
  expect(first[0]).toMatchObject({
    operation: "edit",
    id: "task",
    version: 3,
    title: "Updated task",
    deadline: "2099-01-01T00:00:37.123+00:00",
    note: "Meeting instructions clarified",
  });
  expect(first[0]).not.toHaveProperty("unitId");
  expect(first[0]).not.toHaveProperty("contributionRuleId");
});
it("keeps delegated capacity fixed and refreshes conflicting edits", async () => {
  vi.mocked(workApi.detail).mockResolvedValue({ ...row, parentId: "parent" });
  vi.mocked(workApi.write).mockRejectedValue({ response: { status: 409 } });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Synthetic task", exact: true }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit task", exact: true }),
  );
  expect(screen.getByLabelText("Capacity", { exact: true })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Title", { exact: true }), {
    target: { value: "Updated task" },
  });
  fireEvent.change(screen.getByLabelText("Reason for change"), {
    target: { value: "Correction" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  await waitFor(() => expect(workApi.detail).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry request" })).toBeNull();
});
it.each([
  { canManage: false, status: "open" as const },
  { canManage: true, status: "completed" as const },
  { canManage: true, status: "offered" as const },
])("hides editing outside current open-task management (%j)", async (state) => {
  vi.mocked(workApi.detail).mockResolvedValue({ ...row, ...state });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Synthetic task", exact: true }),
  );
  await screen.findByRole("heading", { name: "Synthetic task" });
  expect(
    screen.queryByRole("button", { name: "Edit task", exact: true }),
  ).toBeNull();
});
it("uses the server's per-participant review authority instead of the broad verifier flag", async () => {
  vi.mocked(workApi.detail).mockResolvedValue({
    ...row,
    assignments: [
      {
        memberId: "participant",
        status: "submitted",
        progress: 100,
        canReview: false,
        reviewRoute: "higher",
        reviewUnitName: null,
      },
    ],
  });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Synthetic task/ }),
  );
  expect(
    await screen.findByText(
      "Confirmed by an independent reviewer in the upper hierarchy",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Verify completion", exact: true }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Return for changes", exact: true }),
  ).toBeNull();
});
it("offers independent review only for the participant authorized by the server", async () => {
  vi.mocked(workApi.detail).mockResolvedValue({
    ...row,
    assignments: [
      {
        memberId: "participant",
        status: "submitted",
        progress: 100,
        canReview: true,
        reviewRoute: "higher",
        reviewUnitName: "Council",
      },
      {
        memberId: "member",
        status: "submitted",
        progress: 100,
        canReview: false,
        reviewRoute: "local",
      },
    ],
  });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Synthetic task/ }),
  );
  expect(await screen.findByText(/upper hierarchy · Council/)).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: "Verify completion", exact: true }),
  ).toHaveLength(1);
});
it("fails closed when an older response lacks participant review authorization", async () => {
  vi.mocked(workApi.detail).mockResolvedValue({
    ...row,
    assignments: [
      { memberId: "participant", status: "submitted", progress: 100 },
    ],
  });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Synthetic task/ }),
  );
  await screen.findByRole("heading", { name: "Participants and progress" });
  expect(
    screen.queryByRole("button", { name: "Verify completion", exact: true }),
  ).toBeNull();
});
it("retries the exact material links after an uncertain save", async () => {
  vi.mocked(workApi.write)
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce({ id: "task", version: 4 });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Synthetic task", exact: true }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Manage links" }));
  fireEvent.click(screen.getByRole("button", { name: "Add link" }));
  fireEvent.change(screen.getByLabelText("Link title 1"), {
    target: { value: "Instructions" },
  });
  fireEvent.change(screen.getByLabelText("URL 1"), {
    target: { value: "https://example.org/guide" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save materials" }));
  const retry = await screen.findByRole("button", { name: "Retry request" });
  expect(screen.getByLabelText("URL 1")).toBeDisabled();
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(workApi.write).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(workApi.write).mock.calls;
  expect(calls[1][0]).toEqual(calls[0][0]);
  expect(calls[0][0]).toMatchObject({
    operation: "materials",
    links: [{ title: "Instructions", url: "https://example.org/guide" }],
  });
});
it("creates an ordinary task without advanced fields and explicitly disables rewards", async () => {
  vi.mocked(workApi.write).mockResolvedValue({ id: "task" });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "New task", exact: true }),
  );
  expect(screen.getByRole("radio",{name:"Do not assign points"})).toBeChecked();
  expect(
    screen.getByLabelText("Participant role").closest("details"),
  ).not.toHaveAttribute("open");
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Community support" },
  });
  fireEvent.change(screen.getByLabelText("Deadline"), {
    target: { value: "2099-01-01T12:00" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save task", exact: true }),
  );
  await waitFor(() => expect(workApi.write).toHaveBeenCalled());
  expect(vi.mocked(workApi.write).mock.calls[0][0]).toMatchObject({
    operation: "create",
    roleLabel: "Participant",
    contributionRuleId: null,
    startsAt: null,
    priority: "normal",
  });
});
it("clears a selected template when the responsible hierarchy changes", async () => {
  vi.mocked(workApi.units).mockResolvedValue([
    {
      id: "region",
      name: "Region",
      parentId: null,
      canCreate: true,
      rewardOptions: [
        {
          id: "reward",
          category: "task",
          version: 1,
          enabled: true,
          amount: 20,
          memberMonthCap: 100,
          issuerMonthCap: 100,
          title: "Driving",
        },
      ],
    },
    {
      id: "other",
      name: "Other",
      parentId: null,
      canCreate: true,
      rewardOptions: [],
    },
  ]);
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "New task", exact: true }),
  );
  fireEvent.click(screen.getByRole("radio", {name:"Assign points"}));
  fireEvent.change(screen.getByLabelText("Participation reward"), {
    target: { value: "reward" },
  });
  expect(screen.getByLabelText("Participation reward")).toHaveValue("reward");
  fireEvent.change(screen.getByLabelText("Responsible unit"), {
    target: { value: "other" },
  });
  expect(screen.getByRole("radio",{name:"Do not assign points"})).toBeChecked();
  expect(screen.queryByRole("option", { name: "Driving · 20" })).toBeNull();
});
it("retries a task with the same selected reward and meeting details after an uncertain response", async () => {
  vi.mocked(workApi.units).mockResolvedValue([
    {
      id: "region",
      name: "Region",
      parentId: null,
      canCreate: true,
      rewardOptions: [
        {
          id: "reward",
          category: "task",
          version: 1,
          enabled: true,
          amount: 20,
          memberMonthCap: 100,
          issuerMonthCap: 100,
          title: "Driving",
        },
      ],
    },
  ]);
  vi.mocked(workApi.write)
    .mockRejectedValueOnce(new Error("Network interrupted"))
    .mockResolvedValue({ id: "task" });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "New task", exact: true }),
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Driving support" },
  });
  fireEvent.click(screen.getByRole("radio", {name:"Assign points"}));
  fireEvent.change(screen.getByLabelText("Participation reward"), {
    target: { value: "reward" },
  });
  fireEvent.change(screen.getByLabelText("Deadline"), {
    target: { value: "2099-01-01T12:00" },
  });
  fireEvent.change(screen.getByLabelText("Meeting place (optional)"), {
    target: { value: "Synthetic place" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save task", exact: true }),
  );
  const retry = await screen.findByRole("button", {
    name: "Retry request",
    exact: true,
  });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(workApi.write).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(workApi.write).mock.calls;
  expect(calls[1][0]).toEqual(calls[0][0]);
  expect(calls[0][0]).toMatchObject({
    contributionRuleId: "reward",
    location: "Synthetic place",
  });
});
it("locks competing actions and retries the exact immutable request after an uncertain write", async () => {
  vi.mocked(workApi.write)
    .mockRejectedValueOnce(new TypeError("Connection lost"))
    .mockResolvedValueOnce({ id: "task", version: 4 });
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Synthetic task", exact: true }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Volunteer", exact: true }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm action", exact: true }),
  );
  const retry = await screen.findByRole("button", {
    name: "Retry request",
    exact: true,
  });
  expect(
    screen.getByRole("button", { name: "New task", exact: true }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Back to list", exact: true }),
  ).toBeDisabled();
  expect(
    screen.getByLabelText("Note / reason", { exact: true }),
  ).toBeDisabled();
  const first = vi.mocked(workApi.write).mock.calls[0][0];
  expect(first).toMatchObject({
    operation: "apply",
    id: "task",
    version: 3,
    organizationId: "org",
  });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(workApi.write).toHaveBeenCalledTimes(2));
  expect(vi.mocked(workApi.write).mock.calls[1][0]).toEqual(first);
  await screen.findByText("Change saved.", { exact: true });
  expect(
    screen.queryByRole("button", { name: "Retry request" }),
  ).not.toBeInTheDocument();
});
it("removes previously loaded task evidence when the refreshed scope is denied", async () => {
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Synthetic task", exact: true }),
  );
  await screen.findByText("Scoped task evidence", { exact: true });
  vi.mocked(workApi.detail).mockRejectedValue({ response: { status: 403 } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
  await screen.findByRole("alert");
  expect(
    screen.queryByText("Scoped task evidence", { exact: true }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Volunteer", exact: true }),
  ).not.toBeInTheDocument();
});
