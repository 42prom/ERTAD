import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SurveyResponse } from "../components/SurveyFields";
import {
  isSurveyQuestionVisible,
  pruneHiddenSurveyAnswers,
  validSurveyAnswers,
} from "../components/surveyModel";
import PositionComparison from "../components/PositionComparison";
import Units from "../pages/Units";
import { ConsolePreferencesContext } from "../components/useConsolePreferences";
import { unitApi } from "../api/units";
import type { SurveyAnswers, SurveyQuestion } from "../api/decisions";

vi.mock("../api/units", () => ({
  unitApi: {
    contexts: vi.fn(),
    units: vi.fn(),
    reviews: vi.fn(),
    history: vi.fn(),
    detail: vi.fn(),
    changeDetail: vi.fn(),
    write: vi.fn(),
    change: vi.fn(),
    decide: vi.fn(),
  },
}));

describe("Wave 3 Conditional Branching, Position Matrix & Units Tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evaluates conditional survey visibility, prunes hidden answers, and toggles UI cleanly", () => {
    const questions: SurveyQuestion[] = [
      {
        id: "q1",
        title: "Need travel stipend?",
        required: true,
        type: "single_choice",
        options: ["Yes", "No"],
      },
      {
        id: "q2",
        title: "Destination city",
        required: true,
        type: "text",
        maxLength: 100,
        visibleIf: { questionId: "q1", equals: "0" },
      },
    ];

    expect(isSurveyQuestionVisible(questions[1], { q1: 0 })).toBe(true);
    expect(isSurveyQuestionVisible(questions[1], { q1: 1 })).toBe(false);
    expect(validSurveyAnswers(questions, { q1: 0 })).toBe(false);
    expect(validSurveyAnswers(questions, { q1: 0, q2: "Tbilisi" })).toBe(true);
    expect(validSurveyAnswers(questions, { q1: 1 })).toBe(true);
    expect(validSurveyAnswers(questions, { q1: 1, q2: "Stale" })).toBe(false);

    const pruned = pruneHiddenSurveyAnswers(questions, { q1: 1, q2: "Stale" });
    expect(pruned).toEqual({ q1: 1 });

    let latest: SurveyAnswers = { q1: 0, q2: "Batumi" };
    const handleChange = vi.fn((next: SurveyAnswers) => {
      latest = next;
    });

    const { rerender } = render(
      <ConsolePreferencesContext.Provider
        value={{
          language: "en",
          theme: "light",
          setLanguage: vi.fn(),
          setTheme: vi.fn(),
        }}
      >
        <SurveyResponse
          questions={questions}
          answers={latest}
          onChange={handleChange}
          disabled={false}
        />
      </ConsolePreferencesContext.Provider>,
    );

    expect(
      screen.getByRole("textbox", { name: "Destination city" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "No" }));
    expect(handleChange).toHaveBeenCalledWith({ q1: 1 });

    rerender(
      <ConsolePreferencesContext.Provider
        value={{
          language: "en",
          theme: "light",
          setLanguage: vi.fn(),
          setTheme: vi.fn(),
        }}
      >
        <SurveyResponse
          questions={questions}
          answers={latest}
          onChange={handleChange}
          disabled={false}
        />
      </ConsolePreferencesContext.Provider>,
    );
    expect(
      screen.queryByRole("textbox", { name: "Destination city" }),
    ).toBeNull();
  });

  it("renders position permission comparison diff columns", () => {
    render(
      <ConsolePreferencesContext.Provider
        value={{
          language: "en",
          theme: "light",
          setLanguage: vi.fn(),
          setTheme: vi.fn(),
        }}
      >
        <PositionComparison
          comparison={{
            sourceName: "Coordinator v1",
            destinationName: "Coordinator v2",
            added: [{ permission: "decision.create", scope: "subtree" }],
            removed: [{ permission: "task.delete", scope: "unit" }],
            unchanged: [{ permission: "channel.post", scope: "unit" }],
          }}
        />
      </ConsolePreferencesContext.Provider>,
    );

    expect(
      screen.getByText("Coordinator v1 → Coordinator v2"),
    ).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.getByText("Unchanged")).toBeInTheDocument();
  });

  it("switches Units view to hierarchical tree and expands/collapses sub-units", async () => {
    vi.mocked(unitApi.contexts).mockResolvedValue([
      {
        id: "org-1",
        name: "Civic Network",
        canPropose: false,
        canCreateUnit: false,
        canCreateGroup: false,
        canManageLifecycle: false,
        canReview: false,
      },
    ]);
    vi.mocked(unitApi.units).mockResolvedValue({
      page: 1,
      pageSize: 20,
      total: 2,
      items: [
        {
          id: "u-root",
          parent_id: null,
          parent_name: null,
          name: "Central Council",
          kind: "council",
          status: "active",
          version: 1,
          canPropose: false,
          canChange: false,
          archiveBlockers: [],
        },
        {
          id: "u-child",
          parent_id: "u-root",
          parent_name: "Central Council",
          name: "Tbilisi Chapter",
          kind: "regional",
          status: "active",
          version: 1,
          canPropose: false,
          canChange: false,
          archiveBlockers: [],
        },
      ],
    });

    render(
      <MemoryRouter>
        <ConsolePreferencesContext.Provider
          value={{
            language: "en",
            theme: "light",
            setLanguage: vi.fn(),
            setTheme: vi.fn(),
          }}
        >
          <Units />
        </ConsolePreferencesContext.Provider>
      </MemoryRouter>,
    );

    const treeBtn = await screen.findByRole("button", { name: "Visual Tree" });
    fireEvent.click(treeBtn);

    const tree = await screen.findByRole("tree", {
      name: "Unit hierarchy tree",
    });
    expect(tree).toBeInTheDocument();
    expect(screen.getByText("Tbilisi Chapter")).toBeInTheDocument();

    const collapseBtn = screen.getByRole("button", { name: "Collapse group" });
    fireEvent.click(collapseBtn);
    expect(screen.queryByText("Tbilisi Chapter")).toBeNull();
  });
});

