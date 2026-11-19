import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { describe, it, expect, vi } from "vitest";
import Workspace from "../pages/Workspace";
import CommandPalette from "../components/CommandPalette";
import { ConsolePreferencesContext } from "../components/useConsolePreferences";

describe("Wave 1 Workspace & CommandPalette", () => {
  it("renders operational KPI strip, 7-day workload schedule and urgent items", () => {
    const context = {
      reviewContexts: [
        {
          id: "org-1",
          name: "თბილისი",
          positions: [
            {
              id: "pos-1",
              name: "კოორდინატორი",
              unitId: "u-1",
              unitName: "საბურთალო",
              canPropose: true,
            },
          ],
        },
      ],
      reviewCount: 4,
      reviewError: false,
      unitContexts: [{ id: "org-1", name: "თბილისი" }],
      decisionContexts: [{ id: "org-1", name: "თბილისი" }],
      workContexts: [{ id: "org-1", name: "თბილისი" }],
      inboxSummary: {
        contexts: [{ id: "org-1", name: "თბილისი" }],
        unread: 3,
        actionRequired: 2,
      },
      workspaceSummary: {
        openWork: 7,
        offeredWork: 1,
        overdueWork: 2,
        upcomingEvents48h: 1,
        openDecisions: 3,
        pendingReviews: 4,
        pendingCollective: 1,
        schedule: [
          {
            dayOffset: 0,
            date: "2026-11-11",
            tasks: 3,
            events: 1,
            decisions: 1,
            proposals: 0,
          },
          {
            dayOffset: 1,
            date: "2026-11-12",
            tasks: 2,
            events: 0,
            decisions: 2,
            proposals: 1,
          },
        ],
        urgent: [
          {
            kind: "task" as const,
            organizationId: "org-1",
            id: "task-1",
            title: "საარჩევნო დამკვირვებლის ბრიფინგი",
            dueAt: "2026-11-11T19:00:00.000Z",
            overdue: true,
            route: "/tasks",
          },
        ],
      },
    };

    render(
      <ConsolePreferencesContext.Provider
        value={{
          language: "ka",
          theme: "light",
          setLanguage: vi.fn(),
          setTheme: vi.fn(),
        }}
      >
        <MemoryRouter initialEntries={["/dashboard"]}>
          <Routes>
            <Route element={<Outlet context={context} />}>
              <Route path="/dashboard" element={<Workspace />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ConsolePreferencesContext.Provider>,
    );

    expect(screen.getByText("აქტიური დავალებები")).toBeInTheDocument();
    expect(screen.getByText("2 ვადაგადაცილებული")).toBeInTheDocument();
    expect(screen.getByText("7-დღიანი ოპერაციული დატვირთვა")).toBeInTheDocument();
    expect(screen.getByText("საარჩევნო დამკვირვებლის ბრიფინგი")).toBeInTheDocument();
    expect(screen.getByText("დავალებების მართვა")).toBeInTheDocument();
  });

  it("filters command palette entries, triggers theme toggle and closes on Escape", () => {
    const onClose = vi.fn();
    const onToggleTheme = vi.fn();
    const onToggleLanguage = vi.fn();

    render(
      <MemoryRouter>
        <CommandPalette
          open={true}
          onClose={onClose}
          language="en"
          theme="light"
          onToggleTheme={onToggleTheme}
          onToggleLanguage={onToggleLanguage}
          items={[
            { path: "/tasks", label: "Tasks", group: "Module" },
            { path: "/channels", label: "Group channels", group: "Module" },
          ]}
          urgent={[]}
        />
      </MemoryRouter>,
    );

    const searchInput = screen.getByLabelText("Quick search");
    fireEvent.change(searchInput, { target: { value: "dark theme" } });
    expect(screen.getByText("Switch to dark theme")).toBeInTheDocument();
    expect(screen.queryByText("Group channels")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Switch to dark theme"));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
