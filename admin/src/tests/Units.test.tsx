import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Units from "../pages/Units";
import { unitApi } from "../api/units";
import { demoApi } from "../api/demo";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/units", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/units")>();
  return {
    ...actual,
    unitApi: {
      geography: vi.fn(),
      contexts: vi.fn(),
      units: vi.fn(),
      reviews: vi.fn(),
      detail: vi.fn(),
      propose: vi.fn(),
      change: vi.fn(),
      decide: vi.fn(),
    },
  };
});
vi.mock("../api/demo", () => ({
  demoApi: { scenario: vi.fn(), stepUp: vi.fn() },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const unit = {
  id: "unit-a",
  name: "Region A",
  parent_id: null,
  parent_name: null,
  kind: "authority",
  canPropose: true,
  canChange: false,
  version: 0,
  status: "active" as const,
  archiveBlockers: [] as string[],
};
const review = {
  kind: "create" as const,
  original_name: null,
  target_id: null,
  id: "review-a",
  name: "New group",
  parent_id: "unit-a",
  parent_name: "Region A",
  status: "pending" as const,
  created_at: "2026-10-09T00:00:00Z",
  expires_at: "2026-10-15T00:00:00Z",
};
const mount = (path = "/units") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Units />
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(unitApi.contexts).mockResolvedValue([
    { id: "org-a", name: "Synthetic organization" },
  ]);
  vi.mocked(unitApi.units).mockResolvedValue({
    items: [unit],
    total: 1,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(unitApi.reviews).mockResolvedValue({
    items: [review],
    total: 1,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(demoApi.scenario).mockResolvedValue({ accounts: [] });
  vi.mocked(demoApi.stepUp).mockResolvedValue(undefined);
});
describe("Hierarchy workflow", () => {
  it("does not present a loading failure as an empty successful list", async () => {
    vi.mocked(unitApi.units).mockRejectedValue({ response: { status: 403 } });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Access denied");
    expect(
      screen.queryByText("No items in this view."),
    ).not.toBeInTheDocument();
  });
  it("retries a lost response with the original key, deadline and payload", async () => {
    vi.mocked(unitApi.propose)
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce({ id: "review-a", status: "pending" });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Create group here" }),
    );
    fireEvent.change(screen.getByLabelText("Unit name"), {
      target: { value: "New group" },
    });
    fireEvent.change(screen.getByLabelText("Reason (10–1000 characters)"), {
      target: { value: "Synthetic operational reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Unit name")).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry same submission" }),
    );
    await screen.findByText("Saved.");
    expect(unitApi.propose).toHaveBeenCalledTimes(2);
    expect(vi.mocked(unitApi.propose).mock.calls[1][0]).toEqual(
      vi.mocked(unitApi.propose).mock.calls[0][0],
    );
  });
  it("hides decision controls when the server denies independent review", async () => {
    vi.mocked(unitApi.detail).mockResolvedValue({
      ...review,
      reason: "Synthetic reason",
      canDecide: false,
      decision_reason: null,
      decision_at: null,
      unit_id: null,
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Needs my decision" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    await screen.findByText(
      "You cannot decide this request, or it is already closed.",
    );
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
    expect(unitApi.decide).not.toHaveBeenCalled();
  });
  it("requires explicit intent, then shows a conflict instead of success", async () => {
    vi.mocked(unitApi.detail).mockResolvedValue({
      ...review,
      reason: "Synthetic reason",
      canDecide: true,
      decision_reason: null,
      decision_at: null,
      unit_id: null,
    });
    vi.mocked(unitApi.decide).mockRejectedValue({ response: { status: 409 } });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Needs my decision" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason (10–1000 characters)"), {
      target: { value: "Synthetic independent reason" },
    });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I reviewed this change."));
    fireEvent.click(approve);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("conditions changed"),
    );
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });
});

describe("Reviewed unit changes", () => {
  it("restores archived units only through explicit reviewed intent", async () => {
    vi.mocked(unitApi.units).mockResolvedValue({
      items: [{ ...unit, status: "archived", canChange: true, version: 6 }],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    vi.mocked(unitApi.change).mockResolvedValue({ id: "restore-a" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Reason \(10/), {
      target: { value: "Synthetic reviewed restoration" },
    });
    expect(
      screen.getByRole("button", { name: "Submit request" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(
        "I understand this unit will become active after approval.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await screen.findByText("Saved.");
    expect(vi.mocked(unitApi.change).mock.calls[0][0]).toMatchObject({
      kind: "restore",
      unitId: unit.id,
      version: 6,
    });
    expect(vi.mocked(unitApi.change).mock.calls[0][0]).not.toHaveProperty(
      "name",
    );
  });
  function editable(blockers: string[] = []) {
    vi.mocked(unitApi.units).mockResolvedValue({
      items: [
        {
          ...unit,
          parent_id: "parent-a",
          canChange: true,
          version: 4,
          archiveBlockers: blockers,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });
  }
  it("does not show rename or archive without server-owned change capability", async () => {
    mount();
    await screen.findByText("Region A");
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });
  it("renames with the original version and retries an uncertain result with the exact payload", async () => {
    editable();
    vi.mocked(unitApi.change)
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce({ id: "change-a" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const submit = screen.getByRole("button", { name: "Submit request" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Unit name"), {
      target: { value: "  Revised region  " },
    });
    fireEvent.change(screen.getByLabelText(/Reason \(10/), {
      target: { value: "Synthetic rename reason" },
    });
    fireEvent.click(submit);
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Unit name")).toBeDisabled();
    expect(vi.mocked(unitApi.change).mock.calls[0][0]).toMatchObject({
      unitId: unit.id,
      version: 4,
      kind: "rename",
      name: "Revised region",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Retry same submission" }),
    );
    await screen.findByText("Saved.");
    expect(vi.mocked(unitApi.change).mock.calls[1][0]).toEqual(
      vi.mocked(unitApi.change).mock.calls[0][0],
    );
  });
  it("shows archive blockers without exposing attached records or permitting submission", async () => {
    editable(["children", "memberships"]);
    mount();
    expect(
      await screen.findByRole("button", { name: "Archive" }),
    ).toBeDisabled();
    expect(screen.getByText(/Archive blocked:/)).toHaveTextContent(
      "Child units, Membership records",
    );
    expect(unitApi.change).not.toHaveBeenCalled();
  });
  it("requires explicit archival intent and handles stale state without claiming success", async () => {
    editable();
    vi.mocked(unitApi.change).mockRejectedValue({ response: { status: 409 } });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    fireEvent.change(screen.getByLabelText(/Reason \(10/), {
      target: { value: "Synthetic archive reason" },
    });
    const submit = screen.getByRole("button", { name: "Submit request" });
    expect(submit).toBeDisabled();
    expect(screen.queryByLabelText("Unit name")).toBeNull();
    fireEvent.click(
      screen.getByLabelText(
        "I understand this unit will be archived after approval.",
      ),
    );
    fireEvent.click(submit);
    await screen.findByRole("alert");
    const sent = vi.mocked(unitApi.change).mock.calls[0][0];
    expect(sent).toMatchObject({
      unitId: unit.id,
      version: 4,
      kind: "archive",
    });
    expect(sent).not.toHaveProperty("name");
    expect(screen.queryByText("Saved.")).toBeNull();
  });
  it("hides active rows immediately when switching to a pending archive read", async () => {
    mount();
    await screen.findByText("Region A");
    vi.mocked(unitApi.units).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    fireEvent.change(screen.getByLabelText("Unit status"), {
      target: { value: "archived" },
    });
    expect(screen.queryByText("Region A")).toBeNull();
    await waitFor(() =>
      expect(unitApi.units).toHaveBeenLastCalledWith(
        "org-a",
        1,
        "",
        "archived",
      ),
    );
  });
});
