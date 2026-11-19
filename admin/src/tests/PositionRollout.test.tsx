import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PositionRollout from "../components/PositionRollout";
import { reviewApi, type RevisionOptions } from "../api/reviews";
import { demoApi } from "../api/demo";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/reviews", () => ({
  reviewApi: { revisionOptions: vi.fn(), change: vi.fn() },
}));
vi.mock("../api/demo", () => ({ demoApi: { stepUp: vi.fn() } }));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const options: RevisionOptions = {
  definitionKey: "a".repeat(32),
  page: 1,
  total: 2,
  comparison: {
    sourceName: "Original role",
    destinationName: "Revised role",
    added: [{ permission: "unit.read", scope: "subtree" }],
    removed: [{ permission: "unit.read", scope: "unit" }],
    unchanged: [],
  },
  items: ["First member", "Second member"].map((displayName, i) => ({
    id: `m${i}`,
    memberId: `u${i}`,
    displayName,
    version: 2,
    state: "active",
    validUntil: null,
    blocker: null,
    review: null,
  })),
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(reviewApi.revisionOptions).mockResolvedValue(
    structuredClone(options),
  );
  vi.mocked(reviewApi.change).mockResolvedValue({
    id: "request",
    status: "pending",
  });
  vi.mocked(demoApi.stepUp).mockResolvedValue({});
});
async function open() {
  render(
    <MemoryRouter>
      <PositionRollout
        organizationId="org"
        positionId="position"
        demo
        close={vi.fn()}
      />
    </MemoryRouter>,
  );
  await screen.findByLabelText("First member");
}
function choose(both = false) {
  fireEvent.click(screen.getByLabelText("First member"));
  if (both) fireEvent.click(screen.getByLabelText("Second member"));
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "Synthetic adoption reason" },
  });
}
function confirm() {
  fireEvent.click(screen.getByLabelText(/I reviewed the permissions/));
}
const submit = () => screen.getByRole("button", { name: /Submit requests/ });
it("requires explicit member selection and confirmation of the permission comparison", async () => {
  await open();
  expect(
    screen.getByRole("region", { name: "Permission comparison" }),
  ).toBeVisible();
  choose();
  expect(submit()).toBeDisabled();
  confirm();
  fireEvent.click(submit());
  await waitFor(() => expect(reviewApi.change).toHaveBeenCalledTimes(1));
  expect(vi.mocked(reviewApi.change).mock.calls[0][0]).toMatchObject({
    membershipId: "m0",
    version: 2,
    positionId: "position",
    kind: "revision",
    definitionKey: options.definitionKey,
  });
  expect(vi.mocked(reviewApi.change).mock.calls[0][0]).not.toHaveProperty(
    "validUntil",
  );
  await screen.findByText(/Confirmed saved requests/);
});
it("does not allow members with obligations or a pending review to be selected", async () => {
  vi.mocked(reviewApi.revisionOptions).mockResolvedValue({
    ...options,
    items: options.items.map((m, i) => ({
      ...m,
      blocker: i ? "pending" : "responsibilities",
    })),
  });
  await open();
  expect(screen.getByLabelText("First member")).toBeDisabled();
  expect(screen.getByLabelText("Second member")).toBeDisabled();
  expect(
    screen.getByText("Resolve active responsibilities first"),
  ).toBeVisible();
});
it("retries only the uncertain request with exactly its original payload after partial success", async () => {
  vi.mocked(reviewApi.change)
    .mockResolvedValueOnce({ id: "first", status: "pending" })
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce({ id: "second", status: "pending" });
  await open();
  choose(true);
  confirm();
  fireEvent.click(submit());
  const retry = await screen.findByRole("button", {
    name: "Retry same requests",
  });
  const uncertain = vi.mocked(reviewApi.change).mock.calls[1][0];
  expect(screen.getByLabelText("First member")).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(reviewApi.change).toHaveBeenCalledTimes(3));
  expect(vi.mocked(reviewApi.change).mock.calls[2][0]).toEqual(uncertain);
  expect(
    vi
      .mocked(reviewApi.change)
      .mock.calls.filter(([p]) => p.membershipId === "m0"),
  ).toHaveLength(1);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry same requests" }),
    ).toBeNull(),
  );
});
it("stops on conflict and retains the confirmed partial result without claiming all members changed", async () => {
  vi.mocked(reviewApi.change)
    .mockResolvedValueOnce({ id: "first", status: "pending" })
    .mockRejectedValueOnce({ response: { status: 409 } });
  await open();
  choose(true);
  confirm();
  fireEvent.click(submit());
  await screen.findByText(/Submission stopped/);
  expect(screen.getByText(/Confirmed saved requests/)).toHaveTextContent("1");
  expect(
    screen.queryByRole("button", { name: "Retry same requests" }),
  ).toBeNull();
  await screen.findByLabelText("First member");
  expect(submit()).toBeDisabled();
});
it("invalidates confirmation when the definition or selected membership changes on refresh", async () => {
  await open();
  choose();
  confirm();
  vi.mocked(reviewApi.revisionOptions).mockResolvedValue({
    ...options,
    definitionKey: "b".repeat(32),
  });
  fireEvent(window, new Event("focus"));
  await waitFor(() =>
    expect(reviewApi.revisionOptions).toHaveBeenCalledTimes(2),
  );
  await screen.findByLabelText("First member");
  expect(submit()).toBeDisabled();
  confirm();
  expect(submit()).toBeEnabled();
  vi.mocked(reviewApi.revisionOptions).mockResolvedValue({
    ...options,
    definitionKey: "b".repeat(32),
    items: options.items.map((m) => ({ ...m, version: 3 })),
  });
  fireEvent(window, new Event("focus"));
  await waitFor(() =>
    expect(reviewApi.revisionOptions).toHaveBeenCalledTimes(3),
  );
  await screen.findByLabelText("First member");
  expect(submit()).toBeDisabled();
});
it("removes members and permission details after access is denied", async () => {
  await open();
  choose();
  vi.mocked(reviewApi.revisionOptions).mockRejectedValue({
    response: { status: 403 },
  });
  fireEvent(window, new Event("focus"));
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("First member")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Permission comparison" }),
  ).toBeNull();
});
it("clears selection when searching a different page of members", async () => {
  await open();
  choose();
  confirm();
  fireEvent.change(screen.getByLabelText("Name or full member code"), {
    target: { value: "Another member" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search", exact: true }));
  await waitFor(() =>
    expect(reviewApi.revisionOptions).toHaveBeenLastCalledWith(
      "org",
      "position",
      "Another member",
      1,
    ),
  );
  await screen.findByLabelText("First member");
  expect(submit()).toBeDisabled();
});
