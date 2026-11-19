import { beforeEach, it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import Inbox from "../pages/Inbox";
import { inboxApi, type InboxItem, type InboxPage } from "../api/inbox";
import { useInboxTarget } from "../components/useInboxTarget";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/inbox", () => ({
  inboxApi: { summary: vi.fn(), list: vi.fn(), read: vi.fn() },
}));
const id = "01234567-1234-4321-8123-012345678901",
  org = "11111111-1234-4321-8123-012345678901";
const row: InboxItem = {
  id,
  source: "work",
  version: 4,
  unitId: "unit",
  unitName: "Region A",
  title: "Scoped test task",
  status: "open",
  updatedAt: "2026-10-19T10:00:00Z",
  deadline: "2026-10-20T10:00:00Z",
  unread: true,
  action: "verify",
};
const page = (items: InboxItem[] = [row]): InboxPage => ({
  items,
  total: items.length,
  unread: items.filter((i) => i.unread).length,
  actionRequired: items.filter((i) => i.action).length,
  page: 1,
  pageSize: 25,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inboxApi.summary).mockResolvedValue({
    contexts: [{ id: org, name: "ERTAD" }],
    unread: 1,
    actionRequired: 1,
  });
  vi.mocked(inboxApi.list).mockResolvedValue(page());
  vi.mocked(inboxApi.read).mockResolvedValue();
});
function mount(url = "/inbox") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Inbox />
    </MemoryRouter>,
  );
}
it("acknowledges exactly the displayed version while keeping the required action", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Mark as read" }));
  await waitFor(() =>
    expect(inboxApi.read).toHaveBeenCalledWith({
      organizationId: org,
      source: "work",
      id,
      version: 4,
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Verify completion" }),
  ).toBeVisible();
});
it("clears stale records on an unconfirmed read and waits for explicit refresh", async () => {
  vi.mocked(inboxApi.read).mockRejectedValue(new Error("Lost response"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Mark as read" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be confirmed",
  );
  expect(screen.queryByText(row.title)).not.toBeInTheDocument();
  vi.mocked(inboxApi.list).mockResolvedValue(page([{ ...row, version: 5 }]));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(row.title);
  expect(inboxApi.read).toHaveBeenCalledTimes(1);
});
it("ignores a delayed result from an older filter", async () => {
  let finish!: (data: InboxPage) => void;
  vi.mocked(inboxApi.list)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(page([]));
  mount();
  await waitFor(() => expect(inboxApi.list).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText("Category"), {
    target: { value: "unit" },
  });
  await screen.findByText("No items in this view.");
  await act(async () => finish(page()));
  expect(screen.queryByText(row.title)).not.toBeInTheDocument();
});
it("validates URL filters and resets pagination on category change", async () => {
  mount("/inbox?source=unknown&view=private&page=-1");
  await screen.findByText(row.title);
  expect(inboxApi.list).toHaveBeenLastCalledWith({
    organizationId: org,
    source: "all",
    view: "action",
    page: 1,
  });
  fireEvent.change(screen.getByLabelText("Category"), {
    target: { value: "membership" },
  });
  await waitFor(() =>
    expect(inboxApi.list).toHaveBeenLastCalledWith({
      organizationId: org,
      source: "membership",
      view: "action",
      page: 1,
    }),
  );
});
const opened = vi.fn();
function Destination({
  source = "work",
}: {
  source?: "work" | "decision" | "moderation";
}) {
  const location = useLocation();
  useInboxTarget(source, org, opened);
  return (
    <p data-testid="location">
      {location.pathname + location.search}{" "}
      {location.state ? "pending" : "consumed"}
    </p>
  );
}
it("opens the exact record once through transient navigation state, never the URL", async () => {
  render(
    <MemoryRouter initialEntries={["/inbox"]}>
      <Routes>
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/tasks" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: row.title }));
  await waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith(id));
  expect(screen.getByTestId("location")).toHaveTextContent("/tasks consumed");
  expect(screen.getByTestId("location")).not.toHaveTextContent(id);
});
it("does not open a record from another organization", () => {
  render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/tasks",
          state: { inbox: { organizationId: "other", source: "work", id } },
        },
      ]}
    >
      <Destination />
    </MemoryRouter>,
  );
  expect(opened).not.toHaveBeenCalled();
});
it("routes a Decision participation action to its original page without IDs in the URL", async () => {
  vi.mocked(inboxApi.list).mockResolvedValue(
    page([{ ...row, source: "decision", action: "decision_participate" }]),
  );
  render(
    <MemoryRouter initialEntries={["/inbox?source=decision"]}>
      <Routes>
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/decisions" element={<Destination source="decision" />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Participate", exact: true }),
  );
  await waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith(id));
  expect(screen.getByTestId("location")).toHaveTextContent(
    "/decisions consumed",
  );
  expect(screen.getByTestId("location")).not.toHaveTextContent(id);
  expect(inboxApi.read).not.toHaveBeenCalled();
});

it("opens a moderation notice at its domain without automatically acknowledging or reviewing it", async () => {
  vi.mocked(inboxApi.list).mockResolvedValue(
    page([
      {
        ...row,
        source: "moderation",
        title: "channel_restriction",
        status: "appealed",
        action: "review_appeal",
      },
    ]),
  );
  render(
    <MemoryRouter initialEntries={["/inbox?source=moderation"]}>
      <Routes>
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/channels" element={<Destination source="moderation" />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("button", {
      name: "Writing restriction and appeal",
    }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Review appeal", exact: true }),
  );
  await waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith(id));
  expect(screen.getByTestId("location")).toHaveTextContent(
    "/channels consumed",
  );
  expect(screen.getByTestId("location")).not.toHaveTextContent(id);
  expect(inboxApi.read).not.toHaveBeenCalled();
});

it("opens a recipient recognition record without a deadline, precise event time or approval action", async () => {
  vi.mocked(inboxApi.list).mockResolvedValue(
    page([
      {
        ...row,
        source: "contribution",
        title: "contribution_record",
        status: "award",
        action: "",
        deadline: null,
        updatedAt: "2026-10-21T00:00:00Z",
      },
    ]),
  );
  render(
    <MemoryRouter initialEntries={["/inbox?source=contribution"]}>
      <Routes>
        <Route path="/inbox" element={<Inbox />} />
        <Route
          path="/contribution"
          element={<Destination source="contribution" />}
        />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText("Points awarded")).toBeVisible();
  expect(screen.queryByText(/Due:/)).toBeNull();
  expect(screen.queryByText(/00:00:00/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View", exact: true }));
  await waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith(id));
  expect(screen.getByTestId("location")).toHaveTextContent(
    "/contribution consumed",
  );
  expect(inboxApi.read).not.toHaveBeenCalled();
});
