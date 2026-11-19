import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { expect, it, vi } from "vitest";
import Layout from "../components/Layout";
import { workspaceApi } from "../api/workspace";

vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({
    language: "en",
    theme: "light",
    setLanguage: vi.fn(),
    setTheme: vi.fn(),
  }),
}));
vi.mock("../components/ConsolePreferences", () => ({ default: () => null }));
vi.mock("../api/workspace", () => ({ workspaceApi: { bootstrap: vi.fn() } }));

const emptyBootstrap = (
  platformAccess: {
    technicalAccount: boolean;
    permissions: string[];
    validUntil: string | null;
  },
) => ({
  platformAccess,
  reviews: [],
  reviewCount: null,
  units: [],
  decisions: [],
  work: [],
  collective: [],
  points: [],
  channels: [],
  members: [],
  positions: [],
  invitations: [],
  inbox: { contexts: [], unread: 0, actionRequired: 0 },
  summary: {
    openWork: 0,
    offeredWork: 0,
    overdueWork: 0,
    upcomingEvents48h: 0,
    openDecisions: 0,
    pendingReviews: 0,
    pendingCollective: 0,
    schedule: [],
    urgent: [],
  },
});

it("keeps permitted technical deep links, hides unrelated tools and clears links after revocation", async () => {
  vi.mocked(workspaceApi.bootstrap).mockResolvedValue(
    emptyBootstrap({
      technicalAccount: true,
      permissions: ["platform.read", "platform.network.read"],
      validUntil: null,
    }),
  );
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: "/platform/:section?", element: <p>Technical content</p> },
          { path: "/tasks", element: <p>Task content</p> },
        ],
      },
    ],
    { initialEntries: ["/platform/network"] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByText("Technical content");
  expect(router.state.location.pathname).toBe("/platform/network");
  const nav = within(
    screen.getByRole("navigation", { name: "Main navigation" }),
  );
  expect(nav.getByRole("link", { name: "Network protection" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(nav.queryByRole("link", { name: "Provider settings" })).toBeNull();
  expect(nav.queryByRole("link", { name: "Tasks" })).toBeNull();
  fireEvent.click(nav.getByRole("link", { name: "System overview" }));
  expect(router.state.location.pathname).toBe("/platform");
  vi.mocked(workspaceApi.bootstrap).mockRejectedValue({
    response: { status: 403 },
  });
  fireEvent(window, new Event("focus"));
  await screen.findByText("Could not check access. Refresh the page.");
  expect(nav.queryByRole("link", { name: "Network protection" })).toBeNull();
  expect(screen.queryByText("Technical content")).toBeNull();
});
