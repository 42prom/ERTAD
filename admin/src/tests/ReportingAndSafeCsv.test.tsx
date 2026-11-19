import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { buildSafeCsv, sanitizeCsvCell } from "../utils/safeCsv";
import { WorkOverviewStats } from "../components/WorkOversight";
import Inbox from "../pages/Inbox";
import { inboxApi } from "../api/inbox";

vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));

vi.mock("../api/inbox", () => ({
  inboxApi: {
    summary: vi.fn(),
    list: vi.fn(),
    read: vi.fn(),
  },
}));

describe("Step 5 reporting, shortfall views, and inbox event notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(inboxApi.summary).mockResolvedValue({
      contexts: [{ id: "org", name: "Org" }],
      unread: 1,
      actionRequired: 1,
    });
    vi.mocked(inboxApi.list).mockResolvedValue({
      items: [
        {
          source: "event",
          id: "00000000-0000-4000-8000-000000000051",
          version: 2,
          unitId: "region-a",
          unitName: "Region A",
          title: "Rescheduled gathering",
          status: "open",
          updatedAt: "2026-11-11T10:00:00Z",
          deadline: "2026-11-12T10:00:00Z",
          unread: true,
          action: "event_follow_up",
        },
      ],
      total: 1,
      unread: 1,
      actionRequired: 1,
      page: 1,
      pageSize: 25,
    });
  });

  it("neutralizes spreadsheet formula prefixes in CSV cells", () => {
    expect(sanitizeCsvCell("=CMD|'/C calc'!A0")).toBe(`"'=CMD|'/C calc'!A0"`);
    expect(sanitizeCsvCell("+SUM(A1:A2)")).toBe(`"'+SUM(A1:A2)"`);
    expect(sanitizeCsvCell("-100")).toBe(`"'-100"`);
    expect(sanitizeCsvCell("@evil")).toBe(`"'@evil"`);
    expect(buildSafeCsv(["Title", "Count"], [["Clean title", 4]])).toBe(
      `"Title","Count"\n"Clean title","4"`,
    );
  });

  it("displays resource shortfalls and 48h dueSoon counts in WorkOverviewStats", () => {
    render(
      <WorkOverviewStats
        data={{
          total: 10,
          active: 6,
          offered: 1,
          completed: 3,
          overdue: 1,
          dueSoon: 2,
          blocked: 1,
          shortfalls: 3,
          needsReview: 2,
          reviewDue: 0,
          unowned: 0,
          leafTotal: 6,
          leafCompleted: 3,
        }}
      />,
    );
    expect(screen.getByText("Resource shortfalls")).toBeVisible();
    expect(screen.getByText("Due soon")).toBeVisible();
  });

  it("renders event notifications and filter category in Unified Inbox", async () => {
    render(
      <MemoryRouter>
        <Inbox />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Rescheduled gathering")).toBeVisible();
    expect(screen.getByText("Upcoming event")).toBeVisible();
    expect(
      screen.getByRole("option", { name: "Events" }),
    ).toBeInTheDocument();
  });
});

