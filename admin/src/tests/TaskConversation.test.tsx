import { beforeEach, it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import TaskConversation from "../components/TaskConversation";
import { channelsApi } from "../api/channels";
import { demoApi } from "../api/demo";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/channels", () => ({
  channelsApi: { work: vi.fn(), write: vi.fn() },
}));
vi.mock("../api/demo", () => ({ demoApi: { stepUp: vi.fn() } }));
function Location() {
  const l = useLocation();
  return (
    <output data-testid="destination">
      {JSON.stringify({ path: l.pathname, state: l.state })}
    </output>
  );
}
function mount() {
  return render(
    <MemoryRouter initialEntries={["/tasks"]}>
      <TaskConversation organizationId="org" workId="task" version={1} demo />
      <Location />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(channelsApi.work).mockResolvedValue({ id: null, canCreate: true });
  vi.mocked(channelsApi.write).mockResolvedValue({ id: "conversation" });
  vi.mocked(demoApi.stepUp).mockResolvedValue({ ok: true } as never);
});
it("opens an existing conversation through transient state without creating or leaking IDs into the URL", async () => {
  vi.mocked(channelsApi.work).mockResolvedValue({
    id: "conversation",
    canCreate: false,
  });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Open task conversation" }),
  );
  expect(JSON.parse(screen.getByTestId("destination").textContent!)).toEqual({
    path: "/channels",
    state: { channel: { organizationId: "org", id: "conversation" } },
  });
  expect(channelsApi.write).not.toHaveBeenCalled();
});
it("does not create on read and reuses the exact command after an uncertain creation response", async () => {
  vi.mocked(channelsApi.write).mockRejectedValueOnce(
    new Error("Lost response"),
  );
  mount();
  const create = await screen.findByRole("button", {
    name: "Create task conversation",
  });
  expect(channelsApi.write).not.toHaveBeenCalled();
  fireEvent.click(create);
  const retry = await screen.findByRole("button", { name: "Retry same request" });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(channelsApi.write).toHaveBeenCalledTimes(2));
  expect(vi.mocked(channelsApi.write).mock.calls[1][0]).toEqual(
    vi.mocked(channelsApi.write).mock.calls[0][0],
  );
  await waitFor(() =>
    expect(screen.getByTestId("destination").textContent).toContain(
      "/channels",
    ),
  );
  expect(demoApi.stepUp).toHaveBeenCalledTimes(2);
});
it("removes creation controls after access is revoked and refreshes current authority", async () => {
  vi.mocked(channelsApi.write).mockRejectedValue({ response: { status: 403 } });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Create task conversation" }),
  );
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: "Retry same request" }),
  ).not.toBeInTheDocument();
  vi.mocked(channelsApi.work).mockRejectedValue({ response: { status: 403 } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh conversation" }));
  await screen.findByText("You do not have access to this task conversation.");
  expect(
    screen.queryByRole("button", { name: "Create task conversation" }),
  ).not.toBeInTheDocument();
});
it("ignores creation responses after the task view has unmounted", async () => {
  let finish!: (result: { id: string }) => void;
  vi.mocked(channelsApi.write).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Create task conversation" }),
  );
  await waitFor(() => expect(channelsApi.write).toHaveBeenCalledOnce());
  view.rerender(
    <MemoryRouter initialEntries={["/tasks"]}>
      <Location />
    </MemoryRouter>,
  );
  await act(async () => {
    finish({ id: "conversation" });
  });
  expect(screen.getByTestId("destination").textContent).toContain("/tasks");
});
