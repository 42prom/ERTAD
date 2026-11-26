import { beforeEach, it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import Channels from "../pages/Channels";
import { demoApi } from "../api/demo";
import { channelsApi, type Channel, type ChannelThread } from "../api/channels";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/demo", () => ({
  demoApi: {
    scenario: vi.fn().mockRejectedValue(new Error("Not demo")),
    stepUp: vi.fn(),
  },
}));
vi.mock("../api/channels", () => ({
  channelsApi: {
    contexts: vi.fn(),
    units: vi.fn(),
    list: vi.fn(),
    thread: vi.fn(),
    reports: vi.fn(),
    restrictions: vi.fn(),
    restriction: vi.fn(),
    write: vi.fn(),
  },
}));
const row: Channel = {
  id: "private-channel-id",
  unitId: "unit",
  title: "Scoped conversation",
  archived: false,
  version: 2,
  lastSeq: 8,
  readSeq: 1,
  muted: false,
  unread: 1,
  reports: 0,
  canPost: true,
  canManage: false,
  canModerate: false,
};
const thread: ChannelThread = {
  channel: row,
  hasOlder: false,
  items: [
    {
      id: "message",
      seq: 8,
      body: "<img src=x onerror=alert(1)>",
      removed: false,
      mine: false,
      authorTag: 3,
      replySeq: 2,
      createdAt: "2026-10-20T12:00:00Z",
    },
  ],
};
function Location() {
  const l = useLocation();
  return <output data-testid="url">{l.pathname + l.search}</output>;
}
function mount() {
  return render(
    <MemoryRouter initialEntries={["/channels"]}>
      <Channels />
      <Location />
    </MemoryRouter>,
  );
}
async function open() {
  fireEvent.click(
    await screen.findByRole("button", { name: /Scoped conversation/ }),
  );
  await screen.findByLabelText("Message");
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(demoApi.scenario).mockRejectedValue(new Error("Not demo"));
  vi.mocked(channelsApi.contexts).mockResolvedValue([
    { id: "org", name: "ERTAD" },
  ]);
  vi.mocked(channelsApi.units).mockResolvedValue({ items: [], page: 1 });
  vi.mocked(channelsApi.list).mockResolvedValue({
    items: [row],
    total: 1,
    page: 1,
  });
  vi.mocked(channelsApi.thread).mockResolvedValue(thread);
  vi.mocked(channelsApi.restrictions).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
  });
  vi.mocked(channelsApi.reports).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
  });
  vi.mocked(channelsApi.write).mockResolvedValue({ id: row.id });
});

it("opens a fresh restriction form when the same message is selected after cancellation", async () => {
  vi.mocked(channelsApi.thread).mockResolvedValue({
    ...thread,
    items: thread.items.map((m) => ({ ...m, canRestrict: true })),
  });
  mount();
  await open();
  fireEvent.click(
    screen.getByRole("button", { name: "Restrict writing", exact: true }),
  );
  fireEvent.change(await screen.findByLabelText("Reason"), {
    target: { value: "Discarded restriction reason" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Restrict writing", exact: true }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Restrict writing", exact: true }),
  );
  expect(await screen.findByLabelText("Reason")).toHaveValue("");
  expect(channelsApi.write).not.toHaveBeenCalled();
});

it("shows the current writing restriction while keeping message history and read controls", async () => {
  vi.mocked(channelsApi.thread).mockResolvedValue({
    ...thread,
    channel: {
      ...row,
      canPost: false,
      postingRestriction: {
        id: "restriction",
        reason: "Synthetic scoped restriction",
        expiresAt: "2026-10-22T12:00:00Z",
      },
    },
  });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /Scoped conversation/ }),
  );
  await screen.findByText("Synthetic scoped restriction");
  expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
  expect(
    screen.getByText("<img src=x onerror=alert(1)>", { exact: true }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Mark displayed messages read" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Restrictions and appeals" }),
  ).toBeVisible();
});

it("opens a task conversation outside the current list and returns to the exact task", async () => {
  const id = "a947f9cb-8448-40cc-aa33-dd24394d52e0";
  vi.mocked(channelsApi.list).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
  });
  vi.mocked(channelsApi.thread).mockResolvedValue({
    ...thread,
    channel: { ...row, id, workId: "task", archived: true, canPost: false },
  });
  function State() {
    const l = useLocation();
    return <output data-testid="state">{JSON.stringify(l.state)}</output>;
  }
  render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/channels",
          state: { channel: { organizationId: "org", id } },
        },
      ]}
    >
      <Channels />
      <Location />
      <State />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Back to task" }));
  expect(channelsApi.thread).toHaveBeenCalledWith("org", id, 0);
  expect(screen.getByTestId("url").textContent).toBe("/tasks");
  expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual({
    inbox: { source: "work", organizationId: "org", id: "task" },
  });
  expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
});

it("does not fetch a conversation destination belonging to another organization", async () => {
  render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/channels",
          state: {
            channel: {
              organizationId: "other",
              id: "a947f9cb-8448-40cc-aa33-dd24394d52e0",
            },
          },
        },
      ]}
    >
      <Channels />
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: /Scoped conversation/ });
  expect(channelsApi.thread).not.toHaveBeenCalled();
});
it("renders text without HTML, keeps channel IDs off the URL and acknowledges the observed sequence", async () => {
  mount();
  await open();
  expect(screen.getByText(thread.items[0].body)).toBeVisible();
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByTestId("url")).toHaveTextContent("/channels");
  expect(screen.getByTestId("url")).not.toHaveTextContent(row.id);
  expect(
    screen.queryByRole("button", { name: "Moderation" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Mark displayed messages read" }),
  );
  await waitFor(() =>
    expect(channelsApi.write).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "read", seq: 8, id: row.id }),
    ),
  );
});
it("retries an uncertain reply with the exact same key and payload", async () => {
  vi.mocked(channelsApi.write)
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValue({ id: row.id });
  mount();
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Reply", exact: true }));
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Synthetic reply" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const retry = await screen.findByRole("button", {
    name: "Retry same request",
  });
  const original = structuredClone(
    vi.mocked(channelsApi.write).mock.calls[0][0],
  );
  expect(original).toMatchObject({
    operation: "post",
    body: "Synthetic reply",
    replyId: "message",
  });
  expect(
    screen.getByRole("button", { name: "Archived", exact: true }),
  ).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(channelsApi.write).toHaveBeenCalledTimes(2));
  expect(vi.mocked(channelsApi.write).mock.calls[1][0]).toEqual(original);
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
});
it("clears protected content on revoked access and lets a stranded draft be discarded", async () => {
  mount();
  await open();
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Unsaved private draft" },
  });
  vi.mocked(channelsApi.thread).mockRejectedValue({
    response: { status: 403 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Access is no longer available",
  );
  expect(screen.queryByText(thread.items[0].body)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: row.title }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Channels: 0")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to channels" }));
  await screen.findByRole("button", { name: /Scoped conversation/ });
  expect(channelsApi.write).not.toHaveBeenCalled();
});
it("ignores a late conversation response after navigating back to a filter", async () => {
  let finish!: (v: ChannelThread) => void;
  vi.mocked(channelsApi.thread).mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /Scoped conversation/ }),
  );
  await waitFor(() => expect(channelsApi.thread).toHaveBeenCalledTimes(1));
  fireEvent.click(
    screen.getByRole("button", { name: "Archived", exact: true }),
  );
  await act(async () => finish(thread));
  expect(screen.queryByText(thread.items[0].body)).not.toBeInTheDocument();
  expect(screen.getByTestId("url")).toHaveTextContent(
    "/channels?view=archived",
  );
});
it("requires a report confirmation and locks channel navigation until cancel", async () => {
  mount();
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Report", exact: true }));
  expect(
    screen.getByRole("button", { name: "Archived", exact: true }),
  ).toBeDisabled();
  expect(channelsApi.write).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Category"), {
    target: { value: "privacy" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm", exact: true }));
  await waitFor(() =>
    expect(channelsApi.write).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "report",
        messageId: "message",
        category: "privacy",
      }),
    ),
  );
});

it("does not carry another channel's moderation view into a newly created channel", async () => {
  vi.mocked(channelsApi.units).mockResolvedValue({
    items: [{ id: "unit", name: "Group" }],
    page: 1,
  });
  vi.mocked(channelsApi.thread).mockImplementation(async (_org, id) => ({
    ...thread,
    channel: {
      ...row,
      id,
      title: id === row.id ? row.title : "New group",
      canManage: true,
      canModerate: id === row.id,
    },
  }));
  vi.mocked(channelsApi.write).mockResolvedValue({ id: "new-channel" });
  vi.mocked(channelsApi.reports).mockImplementation(async (_org, id) => {
    if (id !== row.id) throw { response: { status: 403 } };
    return { items: [], total: 0, page: 1 };
  });
  mount();
  await open();
  fireEvent.click(
    screen.getByRole("button", { name: "Moderation", exact: true }),
  );
  await screen.findByText("No reports eligible for independent review.");
  fireEvent.click(
    screen.getByRole("button", { name: "New channel", exact: true }),
  );
  fireEvent.change(screen.getByLabelText("Channel name"), {
    target: { value: "New group" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));
  await screen.findByRole("heading", { name: "New group", exact: true });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    vi
      .mocked(channelsApi.reports)
      .mock.calls.every((call) => call[1] === row.id),
  ).toBe(true);
});

it("consumes an exact moderation destination once and excludes foreign organization targets", async () => {
  const id = "01234567-1234-4321-8123-012345678901";
  vi.mocked(channelsApi.restriction).mockRejectedValue({
    response: { status: 403 },
  });
  const view = render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/channels",
          state: {
            inbox: { source: "moderation", organizationId: "other", id },
          },
        },
      ]}
    >
      <Channels />
      <Location />
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: /Scoped conversation/ });
  expect(channelsApi.restriction).not.toHaveBeenCalled();
  view.unmount();
  render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/channels",
          state: { inbox: { source: "moderation", organizationId: "org", id } },
        },
      ]}
    >
      <Channels />
      <Location />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(channelsApi.restriction).toHaveBeenCalledExactlyOnceWith("org", id),
  );
  await screen.findByRole("alert");
  expect(screen.getByTestId("url")).toHaveTextContent("/channels");
  expect(screen.getByTestId("url")).not.toHaveTextContent(id);
  expect(channelsApi.write).not.toHaveBeenCalled();
});

it("creates a descendant announcement channel and displays scope badges", async () => {
  vi.mocked(channelsApi.units).mockResolvedValue({
    items: [{ id: "region-1", name: "Tbilisi Region" }],
    page: 1,
  });
  vi.mocked(channelsApi.list).mockResolvedValue({
    items: [
      { ...row, title: "Group Main", isMain: true, audienceScope: "unit_only" },
      { ...row, id: "ann-1", title: "Region Notice", kind: "global", audienceScope: "unit_and_descendants", canPost: false },
    ],
    total: 2,
    page: 1,
  });
  vi.mocked(channelsApi.write).mockResolvedValue({ id: "ann-2" });
  vi.mocked(channelsApi.thread).mockResolvedValue({
    ...thread,
    channel: { ...row, id: "ann-2", title: "New Regional Notice", kind: "global", audienceScope: "unit_and_descendants", canPost: false },
  });
  mount();
  expect(await screen.findByText("Main chat")).toBeInTheDocument();
  expect(screen.getByText("Announcement")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "New channel", exact: true }));
  fireEvent.change(screen.getByLabelText("Audience scope"), {
    target: { value: "global" },
  });
  fireEvent.change(screen.getByLabelText("Channel name"), {
    target: { value: "New Regional Notice" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));
  await waitFor(() =>
    expect(channelsApi.write).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create",
        unitId: "region-1",
        title: "New Regional Notice",
        kind: "global",
      }),
    ),
  );
  expect(await screen.findByText("Descendant announcement")).toBeInTheDocument();
});
