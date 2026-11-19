import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildEventIcs } from "../utils/ics";
import TaskEvidence from "../components/TaskEvidence";
import { ConsolePreferencesContext } from "../components/useConsolePreferences";
import { evidenceApi } from "../api/evidence";

vi.mock("../api/evidence", () => ({
  evidenceApi: {
    list: vi.fn(),
    reserve: vi.fn(),
    ready: vi.fn(),
    download: vi.fn(),
  },
}));

describe("Wave 2 ICS Calendar Export & Evidence Inline Preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats RFC 5545 iCalendar output with CRLF and strict text escaping", () => {
    const ics = buildEventIcs({
      id: "12345678-1234-4123-8123-123456789abc",
      title: "თბილისი, შეხვედრა; გეგმა",
      description: "ხაზი 1\nხაზი 2\\ბოლო",
      location: "რუსთაველის გამზ. 1, თბილისი",
      startsAt: "2026-12-01T10:00:00.000Z",
      endsAt: "2026-12-01T12:30:00.000Z",
    });
    expect(ics.includes("\r\n")).toBe(true);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART:20261201T100000Z");
    expect(ics).toContain("DTEND:20261201T123000Z");
    expect(ics).toContain("SUMMARY:თბილისი\\, შეხვედრა\\; გეგმა");
    expect(ics).toContain("DESCRIPTION:ხაზი 1\\nხაზი 2\\\\ბოლო");
    expect(ics).toContain("LOCATION:რუსთაველის გამზ. 1\\, თბილისი");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("previews text report inline and closes dialog cleanly", async () => {
    vi.mocked(evidenceApi.list).mockResolvedValue({
      canUpload: false,
      items: [
        {
          id: "ev-1",
          bytes: 24,
          mine: true,
          createdAt: "2026-11-11T10:00:00.000Z",
          expiresAt: "2027-02-09T10:00:00.000Z",
        },
      ],
    });
    vi.mocked(evidenceApi.download).mockResolvedValue(
      new Blob(["შესრულებული სამუშაო ანგარიში"], { type: "text/plain" }),
    );

    render(
      <ConsolePreferencesContext.Provider
        value={{
          language: "en",
          theme: "light",
          setLanguage: vi.fn(),
          setTheme: vi.fn(),
        }}
      >
        <TaskEvidence
          organizationId="org-1"
          workId="work-1"
          version={1}
        />
      </ConsolePreferencesContext.Provider>,
    );

    const previewBtn = await screen.findByRole("button", { name: "Preview" });
    fireEvent.click(previewBtn);

    const dialog = await screen.findByRole("dialog", { name: "File preview" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("შესრულებული სამუშაო ანგარიში")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "File preview" })).toBeNull();
  });
});

