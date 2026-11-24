import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import Members from "../pages/Members";
import {
  membersApi,
  type DirectoryMember,
  type MemberDetail,
} from "../api/members";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/members", () => ({
  membersApi: {
    contexts: vi.fn(),
    units: vi.fn(),
    list: vi.fn(),
    detail: vi.fn(),
  },
}));
const row: DirectoryMember = {
  id: "33333333-1234-4321-8123-012345678901",
  displayName: "Synthetic regional member",
  points: "17",
  memberships: [
    {
      id: "membership",
      unitId: "region",
      unitName: "Region A",
      positionId: "position",
      positionName: "Coordinator",
      status: "active",
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: null,
    },
  ],
};
const detail: MemberDetail = {
  ...row,
  canPropose: true,
  pointsScopes: [{ id: "region", name: "Region A" }],
  work: {
    items: [
      {
        id: "task",
        title: "Synthetic task",
        status: "verified",
        progress: 100,
      },
    ],
    page: 1,
    pageSize: 25,
    total: 1,
    verified: 1,
  },
};
function Location() {
  const l = useLocation();
  return (
    <output data-testid="location">
      {JSON.stringify({ path: l.pathname, state: l.state })}
    </output>
  );
}
function mount() {
  return render(
    <MemoryRouter>
      <Members />
      <Location />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(membersApi.contexts).mockResolvedValue([
    { id: "org", name: "ERTAD" },
  ]);
  vi.mocked(membersApi.units).mockResolvedValue({
    items: [{ id: "region", name: "Region A" }],
    total: 1,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(membersApi.list).mockResolvedValue({
    items: [row],
    total: 1,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(membersApi.detail).mockResolvedValue(detail);
});
it("loads the scoped directory and debounces name/role filters without putting protected terms in URLs", async () => {
  mount();
  await screen.findByRole("button", { name: row.displayName! });
  fireEvent.change(screen.getByLabelText("Name or full member code"), {
    target: { value: "Synthetic" },
  });
  fireEvent.change(screen.getByLabelText("Search role"), {
    target: { value: "Coordinator" },
  });
  await waitFor(() =>
    expect(membersApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationId: "org",
        search: "Synthetic",
        role: "Coordinator",
        page: 1,
      }),
    ),
  );
  expect(screen.getByTestId("location")).not.toHaveTextContent("Synthetic");
  fireEvent.change(screen.getByLabelText("Unit and descendants"), {
    target: { value: "region" },
  });
  await waitFor(() =>
    expect(membersApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ unitId: "region" }),
    ),
  );
});
it("shows restricted points rather than a false zero and uses only server-authorized profile actions", async () => {
  vi.mocked(membersApi.detail).mockResolvedValue({
    ...detail,
    points: null,
    pointsScopes: [],
    canPropose: false,
  });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: row.displayName! }),
  );
  const heading = await screen.findByRole("heading", {
    name: row.displayName!,
  });
  await waitFor(() => expect(heading).toHaveFocus());
  expect(screen.getByText(/Points in visible scope: Restricted/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Propose position" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Points and recognition/ }),
  ).toBeNull();
});
it("opens the existing contribution workflow with transient member and unit state", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: row.displayName! }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Points and recognition · Region A",
    }),
  );
  expect(JSON.parse(screen.getByTestId("location").textContent!)).toEqual({
    path: "/contribution",
    state: {
      memberDirectory: {
        organizationId: "org",
        memberId: row.id,
        unitId: "region",
      },
    },
  });
});
it("clears loaded member details when scope is denied on refresh", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: row.displayName! }),
  );
  await screen.findByRole("heading", { name: row.displayName! });
  vi.mocked(membersApi.detail).mockRejectedValue({ response: { status: 403 } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("heading", { name: row.displayName! })).toBeNull();
  expect(screen.queryByRole("button", { name: "Synthetic task" })).toBeNull();
});
it("discards a late detail response after returning to the list", async () => {
  let resolve!: (value: MemberDetail) => void;
  vi.mocked(membersApi.detail).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: row.displayName! }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Back to list" }));
  await act(async () => resolve(detail));
  expect(screen.queryByRole("heading", { name: row.displayName! })).toBeNull();
});
it("keeps a promptly opened card visible when unchanged filter debounce settles", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: row.displayName! }));
  await screen.findByRole("heading", { name: row.displayName! });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(screen.getByRole("heading", { name: row.displayName! })).toBeVisible();
});
it("renders unmasked Member 360 personal data, document claims, trusted devices, and unified View logs tab with filters", async () => {
  vi.mocked(membersApi.detail).mockResolvedValue({
    ...detail,
    verification: {
      assuranceLevel: "biometric_verified",
      citizenshipCountry: "GE",
      sodCscaVerified: true,
      livenessScore: 0.98,
      faceMatchScore: 0.92,
      verifiedAt: "2026-11-24T11:00:00Z",
      portraitDataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      documentCount: 1,
      activeDeviceCount: 1,
      linkedGoogleCount: 1,
      documents: [
        {
          id: "doc-1",
          documentKind: "eid_card",
          issuingCountry: "GE",
          sodCscaVerified: true,
          livenessScore: 0.98,
          faceMatchScore: 0.92,
          portraitDataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
          documentNumber: "SYN123456",
          personalNumber: "00000000001",
          legalName: "Synthetic Citizen",
          dateOfBirth: "1990-01-01",
          createdAt: "2026-11-24T11:00:00Z",
        },
      ],
    },
    profile360: {
      anonCode: "#K4M9P2",
      hasWebAccount: true,
      webEmail: "member@example.test",
      hasPhone: true,
      phoneNumber: "+995599000001",
      phoneHint: "+995 5** ** ** 01",
      phoneUpdatedAt: "2026-11-24T10:00:00Z",
      linkedGoogleAccounts: [
        {
          id: "g-1",
          emailHint: "m***@gmail.com",
          isPrimary: true,
          linkedAt: "2026-11-24T10:00:00Z",
        },
      ],
      devices: [
        {
          id: "d-1",
          platform: "android",
          appId: "ge.ertad.mobile",
          verdict: "strong",
          status: "active",
          lastAttestedAt: "2026-11-24T12:00:00Z",
          createdAt: "2026-11-24T10:00:00Z",
        },
      ],
      activityLog: [
        {
          id: "ver:1",
          category: "verification",
          action: "eid_verification",
          status: "passed",
          summary: "face=92% · liveness=98%",
          occurredAt: "2026-11-24T11:00:00Z",
        },
        {
          id: "pts:1",
          category: "points",
          action: "award:manual",
          status: "+15",
          summary: "Field support",
          occurredAt: "2026-11-24T12:00:00Z",
        },
      ],
    },
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: row.displayName! }));
  await screen.findByText("#K4M9P2");
  expect(screen.getByText("+995599000001")).toBeVisible();
  expect(screen.getByText("SYN123456")).toBeVisible();
  expect(screen.getByText("00000000001")).toBeVisible();
  expect(screen.getByText("member@example.test")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /View logs/i }));
  expect(screen.getByText("eid_verification")).toBeVisible();
  expect(screen.getByText("award:manual")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Points" }));
  expect(screen.queryByText("eid_verification")).toBeNull();
  expect(screen.getByText("award:manual")).toBeVisible();
});
it("distinguishes denied access from an authorized empty result", async () => {
  vi.mocked(membersApi.contexts).mockResolvedValue([]);
  mount();
  await screen.findByText("You do not have permission to browse members.");
  expect(membersApi.list).not.toHaveBeenCalled();
  expect(screen.queryByText("No members match these filters.")).toBeNull();
});
