import { beforeEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Positions from "../pages/Positions";
import { positionsApi, type PositionCatalogue } from "../api/positions";
import { collectiveApi } from "../api/collective";
import { demoApi } from "../api/demo";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/positions", () => ({
  positionsApi: { contexts: vi.fn(), list: vi.fn() },
}));
vi.mock("../api/collective", () => ({ collectiveApi: { write: vi.fn() } }));
vi.mock("../api/demo", () => ({
  demoApi: { scenario: vi.fn(), stepUp: vi.fn() },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const catalogue: PositionCatalogue = {
  items: [
    {
      id: "old",
      name: "Regional helper",
      unitId: "region",
      unitName: "Region A",
      revision: 2,
      version: 4,
      predecessorId: null,
      status: "active",
      canRevise: true,
      canRetire: true,
      retirementBlocked: false,
      grants: [{ permission: "unit.read", scope: "unit" }],
    },
  ],
  units: [
    {
      id: "region",
      name: "Region A",
      canPropose: true,
      grants: [
        { permission: "unit.read", scope: "unit" },
        { permission: "unit.read", scope: "subtree" },
        { permission: "workitem.read", scope: "unit" },
      ],
    },
  ],
  total: 1,
  page: 1,
};

it("requires confirmed retirement intent and preserves the exact source on an uncertain retry", async () => {
  vi.mocked(collectiveApi.write).mockRejectedValueOnce(
    new TypeError("Synthetic transport loss"),
  );
  render(
    <MemoryRouter>
      <Positions />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Retire position", exact: true }),
  );
  const submit = screen.getByRole("button", {
    name: "Submit retirement request",
  });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Reason for retirement"), {
    target: { value: "No longer used after reviewed transfers" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(submit);
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry same request" }),
  );
  await waitFor(() => expect(collectiveApi.write).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(collectiveApi.write).mock.calls;
  expect(calls[0][0]).toMatchObject({
    kind: "position_retire",
    parameters: {
      sourceId: "old",
      sourceVersion: 4,
      sourceName: "Regional helper",
    },
  });
  expect(calls[1][0]).toEqual(calls[0][0]);
});
it("explains blocked retirement without exposing membership identities", async () => {
  const blocked = structuredClone(catalogue);
  blocked.items[0].retirementBlocked = true;
  vi.mocked(positionsApi.list).mockResolvedValue(blocked);
  render(
    <MemoryRouter>
      <Positions />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("button", { name: "Retire position", exact: true }),
  ).toBeDisabled();
  expect(
    screen.getByText(/Resolve memberships or pending changes/),
  ).toBeVisible();
  expect(collectiveApi.write).not.toHaveBeenCalled();
});
it("disables an open retirement form after a new blocker or source version arrives", async () => {
  render(
    <MemoryRouter>
      <Positions />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Retire position", exact: true }),
  );
  fireEvent.change(screen.getByLabelText("Reason for retirement"), {
    target: { value: "Unused position" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  const changed = structuredClone(catalogue);
  changed.items[0].version++;
  vi.mocked(positionsApi.list).mockResolvedValue(changed);
  fireEvent(window, new Event("focus"));
  await screen.findByText(
    "Position state or access changed. Review the current records.",
  );
  expect(
    screen.getByRole("button", { name: "Submit retirement request" }),
  ).toBeDisabled();
  expect(collectiveApi.write).not.toHaveBeenCalled();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(positionsApi.contexts).mockResolvedValue([
    { id: "org", name: "ERTAD" },
  ]);
  vi.mocked(positionsApi.list).mockResolvedValue(structuredClone(catalogue));
  vi.mocked(collectiveApi.write).mockResolvedValue({
    id: "proposal",
    version: 1,
  });
  vi.mocked(demoApi.scenario).mockResolvedValue(
    {} as Awaited<ReturnType<typeof demoApi.scenario>>,
  );
  vi.mocked(demoApi.stepUp).mockResolvedValue({});
});
async function open(revise = false) {
  render(
    <MemoryRouter>
      <Positions />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: revise ? "Propose revision" : "New position",
    }),
  );
  await screen.findByLabelText("Position name");
  await screen.findByLabelText("View tasks");
}
function intent() {
  fireEvent.change(screen.getByLabelText("Position name"), {
    target: { value: "New helper" },
  });
  fireEvent.change(screen.getByLabelText("Reason for change"), {
    target: { value: "Scoped operational need" },
  });
}
it("requires explicit confirmation and offers only server-authorized scopes", async () => {
  await open();
  expect(positionsApi.list).toHaveBeenLastCalledWith("org", "", 1, true);
  intent();
  expect(
    screen.getByRole("button", { name: "Submit for approval" }),
  ).toBeDisabled();
  const task = screen.getByLabelText("View tasks") as HTMLSelectElement;
  expect([...task.options].map((o) => o.value)).toEqual(["", "unit"]);
  fireEvent.change(task, { target: { value: "unit" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
  await screen.findByText(/Proposed changes take effect only after approval/);
  expect(vi.mocked(collectiveApi.write).mock.calls[0][0]).toMatchObject({
    operation: "propose",
    organizationId: "org",
    unitId: "region",
    kind: "position_create",
    parameters: {
      name: "New helper",
      grants: [
        { permission: "unit.read", scope: "unit" },
        { permission: "workitem.read", scope: "unit" },
      ],
    },
  });
});
it("revision freezes the source version without moving memberships", async () => {
  await open(true);
  intent();
  expect(screen.getByLabelText("Unit")).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
  await waitFor(() => expect(collectiveApi.write).toHaveBeenCalledOnce());
  expect(vi.mocked(collectiveApi.write).mock.calls[0][0]).toMatchObject({
    kind: "position_revision",
    parameters: { sourceId: "old", sourceVersion: 4 },
  });
});
it("uncertain submission retries the identical key and frozen permission set", async () => {
  vi.mocked(collectiveApi.write).mockRejectedValueOnce(
    new Error("Synthetic transport loss"),
  );
  await open();
  intent();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry same request" }),
  );
  await waitFor(() => expect(collectiveApi.write).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(collectiveApi.write).mock.calls;
  expect(calls[0][0]).toEqual(calls[1][0]);
});
it("denied refresh removes previously visible positions and disables stale forms", async () => {
  await open();
  intent();
  vi.mocked(positionsApi.list).mockRejectedValue({
    response: { status: 403 },
  });
  fireEvent(window, new Event("focus"));
  await screen.findByText(/Access or data changed/);
  expect(screen.queryByText("Regional helper")).toBeNull();
  const submit = screen.queryByRole("button", { name: "Submit for approval" });
  if (submit) expect(submit).toBeDisabled();
});

it("keeps the draft and blocks submission when editor permissions fail, then retries only that read", async () => {
  await open();
  intent();
  fireEvent.click(screen.getByRole("checkbox"));
  vi.mocked(positionsApi.list).mockImplementation(
    async (_org, _search, _page, includeGrants) => {
      if (includeGrants) throw new Error("Synthetic permission read outage");
      return catalogue;
    },
  );
  fireEvent(window, new Event("focus"));
  await screen.findByText(/Permissions could not load/);
  expect(screen.getByLabelText("Position name")).toHaveValue("New helper");
  expect(screen.getByLabelText("Reason for change")).toHaveValue(
    "Scoped operational need",
  );
  expect(
    screen.getByRole("button", { name: "Submit for approval" }),
  ).toBeDisabled();
  expect(collectiveApi.write).not.toHaveBeenCalled();
  vi.mocked(positionsApi.list).mockResolvedValue(catalogue);
  fireEvent.click(screen.getByRole("button", { name: "Retry permissions" }));
  await screen.findByLabelText("View tasks");
  expect(positionsApi.list).toHaveBeenLastCalledWith("org", "", 1, true);
  expect(screen.getByLabelText("Position name")).toHaveValue("New helper");
  expect(
    screen.getByRole("button", { name: "Submit for approval" }),
  ).toBeEnabled();
  expect(collectiveApi.write).not.toHaveBeenCalled();
});
