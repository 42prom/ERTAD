import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PlatformSessions from "../components/PlatformSessions";
import { platformApi, type PlatformSession } from "../api/platform";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/platform", () => ({
  platformApi: { sessions: vi.fn(), revokeSession: vi.fn() },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const session: PlatformSession = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "organization",
  current: false,
  createdAt: "2026-10-28T00:00:00Z",
  lastSeenAt: "2026-10-28T01:00:00Z",
  expiresAt: "2026-10-28T02:00:00Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.mocked(platformApi.sessions).mockResolvedValue({
    items: [
      session,
      {
        ...session,
        id: "22222222-2222-4222-8222-222222222222",
        current: true,
        kind: "technical",
      },
    ],
    nextBefore: null,
  });
  vi.mocked(authApi.stepUp).mockResolvedValue({
    expiresAt: "2026-10-28T02:00:00Z",
  });
});
it("withholds response controls without the separate revoke capability and marks the current session", async () => {
  render(<PlatformSessions canRevoke={false} />);
  await screen.findByText("Current session");
  expect(
    screen.queryByRole("button", { name: "Revoke", exact: true }),
  ).toBeNull();
});
it("requires explicit confirmation and password, retains exact retry identity, and never submits on cancel", async () => {
  vi.mocked(platformApi.revokeSession)
    .mockRejectedValueOnce(Error("lost response"))
    .mockResolvedValue({ sessionId: session.id, revokedAt: session.expiresAt });
  render(<PlatformSessions canRevoke />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Revoke", exact: true }),
  );
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(authApi.stepUp).not.toHaveBeenCalled();
  expect(platformApi.revokeSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Revoke", exact: true }));
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "session_hygiene" },
  });
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm and revoke" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Your password")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Reason")).toHaveProperty("disabled", true);
  const first = vi.mocked(platformApi.revokeSession).mock.calls[0][0];
  expect(first).toEqual({
    sessionId: session.id,
    reason: "session_hygiene",
    requestId: expect.any(String),
  });
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm and revoke" }));
  await screen.findByText("Session revoked.");
  expect(vi.mocked(platformApi.revokeSession).mock.calls[1][0]).toEqual(first);
  expect(authApi.stepUp).toHaveBeenCalledTimes(2);
});
it("failed password verification never invokes session revocation", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue(Error("bad password"));
  render(<PlatformSessions canRevoke />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Revoke", exact: true }),
  );
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "wrong-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm and revoke" }));
  await screen.findByRole("alert");
  expect(platformApi.revokeSession).not.toHaveBeenCalled();
});
it("resets pagination on a type filter and clears protected rows after a denied refresh", async () => {
  vi.mocked(platformApi.sessions).mockResolvedValueOnce({
    items: [session],
    nextBefore: session.id,
  });
  render(<PlatformSessions canRevoke />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Next", exact: true }),
  );
  await waitFor(() =>
    expect(platformApi.sessions).toHaveBeenLastCalledWith("all", session.id),
  );
  fireEvent.change(screen.getByLabelText("Account type"), {
    target: { value: "technical" },
  });
  await waitFor(() =>
    expect(platformApi.sessions).toHaveBeenLastCalledWith(
      "technical",
      undefined,
    ),
  );
  vi.mocked(platformApi.sessions).mockRejectedValue(Error("forbidden"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
  await screen.findByRole("alert");
  expect(screen.queryByText(session.id)).toBeNull();
});
