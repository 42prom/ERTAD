import { beforeEach, it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import ChannelRestrictions from "../components/ChannelRestrictions";
import { channelsApi, type ChannelRestriction } from "../api/channels";
import { demoApi } from "../api/demo";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/channels", () => ({
  channelsApi: { restrictions: vi.fn(), restriction: vi.fn(), write: vi.fn() },
}));
vi.mock("../api/demo", () => ({ demoApi: { stepUp: vi.fn() } }));
const row: ChannelRestriction = {
  id: "restriction",
  channelId: "channel",
  channelTitle: "Scoped channel",
  participantTag: 2,
  mine: false,
  reason: "Synthetic original reason",
  createdAt: "2026-10-21T12:00:00Z",
  expiresAt: "2026-10-22T12:00:00Z",
  appeal: "Synthetic appeal",
  appealedAt: "2026-10-21T13:00:00Z",
  outcome: null,
  reviewReason: null,
  reviewedAt: null,
  version: 2,
  active: true,
  canAppeal: false,
  canReview: true,
};
const changed = vi.fn(),
  close = vi.fn(),
  dirty = vi.fn();
function mount(create = false) {
  return render(
    <ChannelRestrictions
      organizationId="org"
      demo
      target={
        create
          ? { id: "channel", messageId: "message", participantTag: 2 }
          : undefined
      }
      onClose={close}
      onChanged={changed}
      onDirty={dirty}
    />,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(channelsApi.restrictions).mockResolvedValue({
    items: [row],
    total: 1,
    page: 1,
  });
  vi.mocked(channelsApi.write).mockResolvedValue({ id: "channel" });
  vi.mocked(channelsApi.restriction).mockResolvedValue(row);
  vi.mocked(demoApi.stepUp).mockResolvedValue({ ok: true } as never);
});
it("requires an explicit bounded restriction and keeps the exact retry after a lost response", async () => {
  vi.mocked(channelsApi.write).mockRejectedValueOnce(
    new Error("Lost response"),
  );
  mount(true);
  expect(channelsApi.write).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Synthetic policy violation" },
  });
  fireEvent.change(screen.getByLabelText("Restriction duration"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm", exact: true }));
  const retry = await screen.findByRole("button", {
    name: "Retry same request",
  });
  expect(screen.getByLabelText("Reason")).toBeDisabled();
  fireEvent.click(retry);
  await screen.findByText("Action recorded.");
  const calls = vi.mocked(channelsApi.write).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1][0]).toEqual(calls[0][0]);
  expect(calls[0][0]).toMatchObject({
    operation: "restrict",
    id: "channel",
    messageId: "message",
    reason: "Synthetic policy violation",
  });
  expect(
    new Date(String(calls[0][0].expiresAt)).getTime() - Date.now(),
  ).toBeLessThanOrEqual(3600000);
  expect(demoApi.stepUp).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledOnce();
});
it("shows only server-authorized review actions and submits the observed version", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Review appeal", exact: true }),
  );
  expect(screen.getByText(row.appeal!, { exact: true })).toBeVisible();
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Synthetic independent decision" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm", exact: true }));
  await screen.findByText("Action recorded.");
  expect(channelsApi.write).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "review-appeal",
      restrictionId: "restriction",
      version: 2,
      outcome: "lift",
    }),
  );
});
it("allows the affected member to appeal without granting review powers or moderator step-up", async () => {
  vi.mocked(channelsApi.restrictions).mockResolvedValue({
    items: [
      {
        ...row,
        mine: true,
        appeal: null,
        version: 1,
        canAppeal: true,
        canReview: false,
      },
    ],
    total: 1,
    page: 1,
  });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "My restrictions" }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Appeal restriction",
      exact: true,
    }),
  );
  expect(screen.queryByLabelText("Decision")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Synthetic member appeal" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm", exact: true }));
  await screen.findByText("Action recorded.");
  expect(demoApi.stepUp).not.toHaveBeenCalled();
  expect(channelsApi.write).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "appeal",
      restrictionId: "restriction",
      version: 1,
    }),
  );
});
it("clears actionable records after revocation and never retries a rejected review", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Review appeal", exact: true }),
  );
  vi.mocked(channelsApi.write).mockRejectedValue({ response: { status: 403 } });
  vi.mocked(channelsApi.restrictions).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
  });
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Synthetic rejected review" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm", exact: true }));
  await screen.findByText("You no longer have permission for this action.");
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Review appeal" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("button", { name: "Retry same request" }),
  ).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalledOnce();
});
it("ignores a stale list response after switching views", async () => {
  let finish!: (value: {
    items: ChannelRestriction[];
    total: number;
    page: number;
  }) => void;
  vi.mocked(channelsApi.restrictions)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ items: [], total: 0, page: 1 });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "My restrictions" }));
  await screen.findByText("No restrictions in this view.");
  await act(async () => {
    finish({ items: [row], total: 1, page: 1 });
  });
  expect(
    screen.queryByText("Scoped channel", { exact: false }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Review appeal" }),
  ).not.toBeInTheDocument();
});

it("opens an exact notice outside the current queue without marking it read or taking action", async () => {
  render(
    <ChannelRestrictions
      organizationId="org"
      demo
      initialRestrictionId="notice-id"
      onClose={close}
      onChanged={changed}
      onDirty={dirty}
    />,
  );
  await screen.findByText(row.reason);
  expect(channelsApi.restriction).toHaveBeenCalledWith("org", "notice-id");
  expect(channelsApi.restrictions).not.toHaveBeenCalled();
  expect(channelsApi.write).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Review appeal", exact: true }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Restriction history", exact: true }),
  );
  await waitFor(() =>
    expect(channelsApi.restrictions).toHaveBeenCalledWith("org", "history", 1),
  );
});
it("removes an exact notice and its action after the server revokes access", async () => {
  render(
    <ChannelRestrictions
      organizationId="org"
      demo
      initialRestrictionId="notice-id"
      onClose={close}
      onChanged={changed}
      onDirty={dirty}
    />,
  );
  await screen.findByText(row.reason);
  vi.mocked(channelsApi.restriction).mockRejectedValue({
    response: { status: 403 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh restrictions" }));
  await screen.findByRole("alert");
  expect(screen.queryByText(row.reason)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Review appeal", exact: true }),
  ).not.toBeInTheDocument();
  expect(channelsApi.write).not.toHaveBeenCalled();
});
it("refreshes the global inbox only after a confirmed moderation decision", async () => {
  const changedInbox = vi.fn();
  window.addEventListener("ertad-inbox-changed", changedInbox);
  try {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Review appeal", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Synthetic reviewed appeal" },
    });
    expect(changedInbox).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm", exact: true }),
    );
    await screen.findByText("Action recorded.");
    expect(changedInbox).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("ertad-inbox-changed", changedInbox);
  }
});
