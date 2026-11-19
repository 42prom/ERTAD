import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import Contribution from "../pages/Contribution";
import { collectiveApi, type PointsView } from "../api/collective";
import { demoApi } from "../api/demo";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/collective", () => ({
  collectiveApi: {
    pointContexts: vi.fn(),
    units: vi.fn(),
    points: vi.fn(),
    write: vi.fn(),
  },
}));
vi.mock("../api/demo", () => ({
  demoApi: { scenario: vi.fn(), stepUp: vi.fn() },
}));
const org = "11111111-1234-4321-8123-012345678901",
  unit = "22222222-1234-4321-8123-012345678901",
  id = "33333333-1234-4321-8123-012345678901",
  actor = "44444444-1234-4321-8123-012345678901",
  member = "55555555-1234-4321-8123-012345678901";
const data: PointsView = {
  actorId: actor,
  memberId: actor,
  rootUnitId: unit,
  canAward: true,
  canManageRules: true,
  balance: "7",
  total: 1,
  page: 1,
  rules: [
    {
      id: "rule",
      category: "manual",
      enabled: true,
      version: 1,
      amount: 20,
      memberMonthCap: 100,
      issuerMonthCap: 100,
    },
  ],
  entries: [
    {
      id,
      kind: "award",
      category: "manual",
      points: 7,
      unitId: unit,
      reason: "Synthetic earned recognition",
      date: "2026-10-21",
      reversesId: null,
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(collectiveApi.pointContexts).mockResolvedValue([
    { id: org, name: "ERTAD" },
  ]);
  vi.mocked(collectiveApi.units).mockResolvedValue([
    { id: unit, name: "Region A" },
    { id: "other", name: "Group A" },
  ] as never);
  vi.mocked(collectiveApi.points).mockResolvedValue(data);
  vi.mocked(collectiveApi.write).mockResolvedValue({ id: "proposal" });
  vi.mocked(demoApi.scenario).mockResolvedValue({
    accounts: [
      { memberId: actor, label: "Me" },
      { memberId: member, label: "Recipient" },
    ],
  } as never);
  vi.mocked(demoApi.stepUp).mockResolvedValue(undefined as never);
});
it('opens scoped member history from the directory without granting new authority',async()=>{
  render(<MemoryRouter initialEntries={[{pathname:'/contribution',state:{memberDirectory:{organizationId:org,memberId:member,unitId:unit}}}]}><Contribution/></MemoryRouter>);
  await waitFor(()=>expect(collectiveApi.points).toHaveBeenCalledWith(expect.objectContaining({organizationId:org,memberId:member,unitId:unit})));
  expect(await screen.findByLabelText('Points history')).toHaveValue(member);
  fireEvent.click(await screen.findByRole('button',{name:'Propose recognition',exact:true}));
  expect(screen.getByLabelText('Recognition recipient')).toHaveValue(member);
});
function Location() {
  const l = useLocation();
  return (
    <output data-testid="location">
      {l.pathname + l.search} {l.state ? "pending" : "consumed"}
    </output>
  );
}
it("proposes an independently reviewed scoped activity template with a stable template identity", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Add reward template" }),
  );
  fireEvent.change(screen.getByLabelText("Template name"), {
    target: { value: "Driving support" },
  });
  fireEvent.change(screen.getByLabelText("Available hierarchy"), {
    target: { value: "other" },
  });
  fireEvent.change(screen.getByLabelText("Points amount"), {
    target: { value: "35" },
  });
  fireEvent.change(screen.getByLabelText("Recognition reason"), {
    target: { value: "Recognize verified support" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Submit recognition proposal" }),
  );
  await waitFor(() => expect(collectiveApi.write).toHaveBeenCalled());
  expect(vi.mocked(collectiveApi.write).mock.calls[0][0]).toMatchObject({
    kind: "points_rule",
    unitId: unit,
    parameters: {
      category: "task",
      templateId: expect.any(String),
      title: "Driving support",
      allowedUnitId: "other",
      amount: 35,
      ruleVersion: 0,
    },
  });
});
it("editing an activity template does not pick the default task rule version", async () => {
  vi.mocked(collectiveApi.points).mockResolvedValue({
    ...data,
    rules: [
      {
        id: "default",
        category: "task",
        version: 7,
        enabled: true,
        amount: 5,
        memberMonthCap: 100,
        issuerMonthCap: 100,
      },
      {
        id: "custom",
        templateId: "template",
        title: "Driving",
        allowedUnitId: unit,
        category: "task",
        version: 2,
        enabled: true,
        amount: 25,
        memberMonthCap: 100,
        issuerMonthCap: 100,
      },
    ],
  });
  mount();
  const title = await screen.findByRole("heading", {
    name: "Driving · Enabled",
  });
  fireEvent.click(
    within(title.parentElement!).getByRole("button", {
      name: "Propose rule change",
    }),
  );
  fireEvent.change(screen.getByLabelText("Recognition reason"), {
    target: { value: "Update future offers" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Submit recognition proposal" }),
  );
  await waitFor(() => expect(collectiveApi.write).toHaveBeenCalled());
  expect(
    vi.mocked(collectiveApi.write).mock.calls[0][0].parameters,
  ).toMatchObject({ templateId: "template", ruleVersion: 2, amount: 25 });
});
function mount(state?: object) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/contribution", state }]}>
      <Contribution />
      <Location />
    </MemoryRouter>,
  );
}
async function begin() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Propose recognition" }),
  );
  fireEvent.change(screen.getByLabelText("Recognition recipient"), {
    target: { value: member },
  });
  fireEvent.change(screen.getByLabelText("Points amount"), {
    target: { value: "12" },
  });
  fireEvent.change(screen.getByLabelText("Recognition reason"), {
    target: { value: "Synthetic scoped recognition" },
  });
}
it("opens an exact own entry using transient state without granting administrative actions", async () => {
  vi.mocked(collectiveApi.points).mockResolvedValue({
    ...data,
    canAward: false,
    canManageRules: false,
  });
  mount({ inbox: { source: "contribution", organizationId: org, id } });
  await waitFor(() =>
    expect(collectiveApi.points).toHaveBeenCalledWith({
      organizationId: org,
      entryId: id,
      page: 1,
    }),
  );
  expect(await screen.findByText("Synthetic earned recognition")).toBeVisible();
  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/contribution consumed",
    ),
  );
  expect(screen.getByTestId("location")).not.toHaveTextContent(id);
  expect(
    screen.queryByRole("button", { name: "Propose recognition" }),
  ).toBeNull();
  expect(collectiveApi.write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "My full history" }));
  await waitFor(() =>
    expect(collectiveApi.points).toHaveBeenLastCalledWith({
      organizationId: org,
      unitId: unit,
      page: 1,
    }),
  );
});
it("ignores foreign organization notification state", async () => {
  mount({ inbox: { source: "contribution", organizationId: "foreign", id } });
  await screen.findByText("Synthetic earned recognition");
  expect(
    collectiveApi.points.mock.calls.every(([input]) => !input.entryId),
  ).toBe(true);
});
it("clears protected entry data after a denied current-authority refresh", async () => {
  mount({ inbox: { source: "contribution", organizationId: org, id } });
  await screen.findByText("Synthetic earned recognition");
  vi.mocked(collectiveApi.points).mockRejectedValue({
    response: { status: 403 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Points are unavailable",
  );
  expect(screen.queryByText("Synthetic earned recognition")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Configure points rule" }),
  ).toBeNull();
});
it("rejects a late response from the previous history scope", async () => {
  let resolve!: (data: PointsView) => void;
  mount();
  await screen.findByText("Synthetic earned recognition");
  vi.mocked(collectiveApi.points)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue({ ...data, balance: "0", entries: [], total: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.change(screen.getByLabelText("Management scope"), {
    target: { value: "other" },
  });
  await screen.findByText("No entries yet.");
  await act(async () => resolve(data));
  expect(screen.queryByText("Synthetic earned recognition")).toBeNull();
});
it("keeps a pending manual award out of earned balance and prevents scope changes while editing", async () => {
  mount();
  await begin();
  expect(screen.getByLabelText("Management scope")).toBeDisabled();
  expect(
    within(screen.getByLabelText("Recognition recipient")).queryByRole(
      "option",
      { name: "Me" },
    ),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Submit recognition proposal" }),
  );
  await screen.findByText(
    "Saved. Proposed changes take effect only after approval.",
  );
  expect(collectiveApi.write).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "points_award",
      unitId: unit,
      parameters: { memberId: member, ruleId: "rule", amount: 12 },
    }),
  );
  expect(await screen.findByText("7 points")).toBeVisible();
  expect(screen.queryByText("19 points")).toBeNull();
});
it("retries an uncertain manual award with its original key and payload, then closes the form", async () => {
  vi.mocked(collectiveApi.write)
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValue({ id: "proposal" });
  mount();
  await begin();
  fireEvent.click(
    screen.getByRole("button", { name: "Submit recognition proposal" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry same request" }),
  );
  await waitFor(() => expect(collectiveApi.write).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(collectiveApi.write).mock.calls;
  expect(calls[1][0]).toEqual(calls[0][0]);
  await screen.findByText(
    "Saved. Proposed changes take effect only after approval.",
  );
  expect(screen.queryByLabelText("Recognition reason")).toBeNull();
});

it("removes the award form and controls when submission authority is revoked", async () => {
  mount();
  await begin();
  vi.mocked(collectiveApi.write).mockRejectedValue({
    response: { status: 403 },
  });
  vi.mocked(collectiveApi.points).mockResolvedValue({
    ...data,
    canAward: false,
    canManageRules: false,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Submit recognition proposal" }),
  );
  await screen.findByText("You no longer have permission for this action.");
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Propose recognition" }),
    ).toBeNull(),
  );
  expect(screen.queryByLabelText("Recognition reason")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Retry same request" }),
  ).toBeNull();
});

it("proposes a linked correction without changing the displayed earned balance", async () => {
  vi.mocked(collectiveApi.points).mockResolvedValue({
    ...data,
    memberId: member,
  });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Request correction" }),
  );
  fireEvent.change(screen.getByLabelText("Recognition reason"), {
    target: { value: "Synthetic reasoned correction" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Submit recognition proposal" }),
  );
  await screen.findByText(
    "Saved. Proposed changes take effect only after approval.",
  );
  expect(collectiveApi.write).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "points_reverse",
      parameters: { entryId: id },
    }),
  );
  expect(await screen.findByText("7 points")).toBeVisible();
});
