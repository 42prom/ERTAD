import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Decisions from "../pages/Decisions";
import { decisionApi, type Decision } from "../api/decisions";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/decisions", () => ({
  decisionApi: {
    contexts: vi.fn(),
    audiences: vi.fn(),
    list: vi.fn(),
    detail: vi.fn(),
    write: vi.fn(),
  },
}));
vi.mock("../api/demo", () => ({
  demoApi: {
    scenario: vi.fn().mockResolvedValue({ accounts: [] }),
    stepUp: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const row: Decision = {
  id: "poll",
  unitId: "region",
  unitName: "Region",
  title: "Synthetic poll",
  description: "Test",
  options: ["One", "Two"],
  privacy: "named",
  status: "draft",
  version: 1,
  quorum: 50,
  closesAt: "2099-01-01T00:00:00Z",
  electorate: 2,
  canManage: false,
  canPublish: false,
  canVote: false,
  voted: false,
};
function mount() {
  render(
    <MemoryRouter>
      <Decisions />
    </MemoryRouter>,
  );
}
const inboxDecisionId = "01234567-1234-4321-8123-012345678901";
function mountFromInbox(organizationId = "org") {
  render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/decisions",
          state: {
            inbox: { source: "decision", organizationId, id: inboxDecisionId },
          },
        },
      ]}
    >
      <Decisions />
    </MemoryRouter>,
  );
}
it("opens the exact inbox Decision even when absent from the current list without submitting a vote", async () => {
  vi.mocked(decisionApi.list).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(decisionApi.detail).mockResolvedValue({
    ...row,
    id: inboxDecisionId,
    status: "closed",
    title: "Closed inbox decision",
  });
  mountFromInbox();
  await screen.findByRole("heading", {
    name: "Closed inbox decision",
    exact: true,
  });
  expect(decisionApi.detail).toHaveBeenCalledExactlyOnceWith(
    "org",
    inboxDecisionId,
  );
  expect(decisionApi.write).not.toHaveBeenCalled();
});
it("rechecks the inbox destination and does not display a revoked Decision", async () => {
  vi.mocked(decisionApi.list).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(decisionApi.detail).mockRejectedValue({
    response: { status: 403 },
  });
  mountFromInbox();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Access denied or revoked",
  );
  expect(
    screen.queryByRole("heading", { name: row.title }),
  ).not.toBeInTheDocument();
  expect(decisionApi.write).not.toHaveBeenCalled();
});
it("ignores an inbox destination from another organization", async () => {
  mountFromInbox("other");
  await screen.findByRole("heading", { name: "Polls", exact: true });
  expect(decisionApi.detail).not.toHaveBeenCalled();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(decisionApi.contexts).mockResolvedValue([
    { id: "org", name: "Org" },
  ]);
  vi.mocked(decisionApi.audiences).mockResolvedValue([
    { id: "region", name: "Region" },
  ]);
  vi.mocked(decisionApi.list).mockResolvedValue({
    items: [row],
    total: 1,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(decisionApi.detail).mockResolvedValue(row);
});
describe("Decision interactions", () => {
  it("refreshes inbox after a saved vote without triggering the full membership/navigation refresh", async () => {
    const inbox = vi.fn(), authority = vi.fn();
    window.addEventListener("ertad-inbox-changed", inbox);
    window.addEventListener("ertad-reviews-changed", authority);
    try {
      vi.mocked(decisionApi.detail).mockResolvedValue({...row,status:"open",canVote:true});
      vi.mocked(decisionApi.write).mockResolvedValue({id:row.id,status:"open"});
      mount();
      fireEvent.click(await screen.findByRole("button",{name:"Open: Synthetic poll",exact:true}));
      fireEvent.click(await screen.findByRole("radio",{name:"One",exact:true}));
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button",{name:"Submit vote",exact:true}));
      await screen.findByText("Action saved.");
      expect(inbox).toHaveBeenCalledOnce();
      expect(authority).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("ertad-inbox-changed", inbox);
      window.removeEventListener("ertad-reviews-changed", authority);
    }
  });
  it("creates multiple questions and preserves options across choice types and targeted removal", async () => {
    vi.mocked(decisionApi.write).mockRejectedValue(
      new TypeError("connection lost"),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Create", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Poll type", {exact:true}),{target:{value:"survey"}});
    expect(screen.getByLabelText("Poll type", { exact: true })).toHaveValue(
      "survey",
    );
    fireEvent.change(screen.getByLabelText("Title", { exact: true }), {
      target: { value: "Synthetic survey" },
    });
    fireEvent.change(screen.getByLabelText("Question 1", { exact: true }), {
      target: { value: "Choose activities" },
    });
    fireEvent.change(screen.getByLabelText("Option 1.1", { exact: true }), {
      target: { value: "Reading" },
    });
    fireEvent.change(screen.getByLabelText("Option 1.2", { exact: true }), {
      target: { value: "Walking" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add option", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Option 1.3", { exact: true }), {
      target: { value: "Drawing" },
    });
    fireEvent.change(screen.getByLabelText("Question type", { exact: true }), {
      target: { value: "multiple_choice" },
    });
    expect(screen.getByLabelText("Option 1.3", { exact: true })).toHaveValue(
      "Drawing",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove option 1.2", exact: true }),
    );
    expect(screen.getByLabelText("Option 1.2", { exact: true })).toHaveValue(
      "Drawing",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add another question", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Question 2", { exact: true }), {
      target: { value: "Your suggestion" },
    });
    fireEvent.change(
      screen.getAllByLabelText("Question type", { exact: true })[1],
      { target: { value: "text" } },
    );
    fireEvent.change(
      screen.getByLabelText("Response placeholder", { exact: true }),
      { target: { value: "Describe an idea" } },
    );
    fireEvent.click(screen.getByText("Preview", { exact: true }));
    expect(screen.getByPlaceholderText("Describe an idea")).toBeDisabled();
    expect(decisionApi.write).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Save draft", exact: true }),
    );
    await screen.findByRole("button", {
      name: "Retry same action",
      exact: true,
    });
    expect(vi.mocked(decisionApi.write).mock.calls[0][0]).toMatchObject({
      operation: "create",
      kind: "survey",
      options: [],
      questions: [
        {
          title: "Choose activities",
          type: "multiple_choice",
          options: ["Reading", "Drawing"],
        },
        {
          title: "Your suggestion",
          type: "text",
          maxLength: 500,
          placeholder: "Describe an idea",
        },
      ],
    });
  });
  it("uses the referendum outcome when abstentions equal affirmative votes", async () => {
    vi.mocked(decisionApi.detail).mockResolvedValue({
      ...row,
      status: "closed",
      kind: "referendum",
      threshold: 60,
      options: ["Yes", "No", "Abstain"],
      outcome: "accepted",
      participation: 2,
      electorate: 2,
      results: [
        { label: "Yes", votes: 1 },
        { label: "No", votes: 0 },
        { label: "Abstain", votes: 1 },
      ],
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open: Synthetic poll",
        exact: true,
      }),
    );
    expect(
      await screen.findByText("Referendum outcome: Accepted"),
    ).toBeVisible();
    expect(screen.queryByText("Result: tie")).not.toBeInTheDocument();
  });
  it("requires all survey answers and new confirmation after an answer changes", async () => {
    vi.mocked(decisionApi.detail).mockResolvedValue({
      ...row,
      status: "open",
      kind: "survey",
      options: [],
      canVote: true,
      questions: [
        {
          id: "q1",
          title: "Choose a time",
          type: "single_choice",
          required: true,
          options: ["Morning", "Evening"],
        },
        {
          id: "q2",
          title: "Rate the idea",
          type: "rating_scale",
          required: true,
          min: 1,
          max: 5,
        },
      ],
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open: Synthetic poll",
        exact: true,
      }),
    );
    const submit = await screen.findByRole("button", {
      name: "Submit responses",
      exact: true,
    });
    fireEvent.click(
      screen.getByRole("radio", { name: "Morning", exact: true }),
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Rate the idea", { exact: true }), {
      target: { value: "4" },
    });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit).toBeEnabled();
    fireEvent.click(
      screen.getByRole("radio", { name: "Evening", exact: true }),
    );
    expect(submit).toBeDisabled();
  });
  it("keeps the description label stable when editing an existing draft", async () => {
    vi.mocked(decisionApi.detail).mockResolvedValue({
      ...row,
      canManage: true,
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open: Synthetic poll",
        exact: true,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit", exact: true }),
    );
    expect(screen.getByLabelText("Description", { exact: true })).toHaveValue(
      "Test",
    );
  });
  it("does not turn a failed read into an empty poll list", async () => {
    vi.mocked(decisionApi.list).mockRejectedValue({
      response: { status: 403 },
    });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Access denied");
    expect(screen.queryByText("No polls in this view")).not.toBeInTheDocument();
  });
  it("keeps an uncertain draft payload frozen for an identical retry", async () => {
    vi.mocked(decisionApi.write).mockRejectedValue(
      new TypeError("connection lost"),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Create", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Title", { exact: true }), {
      target: { value: "Synthetic draft" },
    });
    fireEvent.change(screen.getByLabelText("Option 1", { exact: true }), {
      target: { value: "One" },
    });
    fireEvent.change(screen.getByLabelText("Option 2", { exact: true }), {
      target: { value: "Two" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save draft", exact: true }),
    );
    const retry = await screen.findByRole("button", {
      name: "Retry same action",
      exact: true,
    });
    const first = vi.mocked(decisionApi.write).mock.calls[0][0];
    expect(screen.getByLabelText("Title", { exact: true })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(decisionApi.write).toHaveBeenCalledTimes(2));
    expect(vi.mocked(decisionApi.write).mock.calls[1][0]).toEqual(first);
    expect(screen.queryByText("Action saved.")).not.toBeInTheDocument();
  });
  it("normalizes uppercase hyphenated receipt codes and renders receipt verification for anonymous closed surveys", async () => {
    vi.mocked(decisionApi.detail).mockResolvedValue({
      ...row,
      status: "closed",
      kind: "survey",
      privacy: "anonymous",
      options: [],
      participation: 3,
      electorate: 5,
      resultsSuppressed: false,
      receiptDigests: ["a1b2c3d4e5f60718"],
      surveyResults: [
        {
          id: "q1",
          title: "Favorite format",
          type: "single_choice",
          answered: 3,
          results: [{ label: "Online", votes: 3 }],
        },
      ],
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open: Synthetic poll",
        exact: true,
      }),
    );
    const receiptInput = await screen.findByLabelText("16-char receipt digest");
    fireEvent.change(receiptInput, { target: { value: "A1B2-C3D4-E5F6-0718" } });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Verified: receipt included in final tallied ballots.",
    );
  });
  it("requires explicit vote intent, discloses named storage and respects denied management", async () => {
    vi.mocked(decisionApi.detail).mockResolvedValue({
      ...row,
      status: "open",
      canVote: true,
    });
    vi.mocked(decisionApi.write).mockRejectedValue({
      response: { status: 409 },
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open: Synthetic poll",
        exact: true,
      }),
    );
    expect(
      await screen.findByText(
        "Named poll — responses are stored with the account.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Close poll", exact: true }),
    ).not.toBeInTheDocument();
    const submit = screen.getByRole("button", {
      name: "Submit vote",
      exact: true,
    });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Two", exact: true }));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The poll changed",
    );
    expect(vi.mocked(decisionApi.write).mock.calls[0][0]).toMatchObject({
      operation: "vote",
      choice: 1,
      id: "poll",
    });
    expect(screen.queryByText("Action saved.")).not.toBeInTheDocument();
  });
});
