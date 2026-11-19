import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import OwnMfaAndPasskeys from "../components/OwnMfaAndPasskeys";
import OwnNotifications from "../components/OwnNotifications";
import Platform from "../pages/Platform";
import { ConsolePreferencesContext } from "../components/useConsolePreferences";
import { accountApi } from "../api/account";
import { platformApi } from "../api/platform";

vi.mock("../api/account", () => ({
  accountApi: {
    totpStatus: vi.fn(),
    totpSetup: vi.fn(),
    totpConfirm: vi.fn(),
    totpDisable: vi.fn(),
    totpRegenerateRecovery: vi.fn(),
    passkeys: vi.fn(),
    passkeyRegisterOptions: vi.fn(),
    passkeyRegisterVerify: vi.fn(),
    passkeyRename: vi.fn(),
    passkeyDelete: vi.fn(),
    notifications: vi.fn(),
    updateNotifications: vi.fn(),
    syncNotifications: vi.fn(),
    sessions: vi.fn(),
    recovery: vi.fn(),
    revoke: vi.fn(),
    revokeOthers: vi.fn(),
    changePassword: vi.fn(),
    cancelRecovery: vi.fn(),
  },
}));

vi.mock("../api/platform", async () => {
  const actual = await vi.importActual<typeof import("../api/platform")>(
    "../api/platform",
  );
  return {
    ...actual,
    platformApi: {
      ...actual.platformApi,
      access: vi.fn(),
      overview: vi.fn(),
      audit: vi.fn(),
      verifyAuditChain: vi.fn(),
    },
  };
});

describe("Wave 4 Security (TOTP, Passkeys, Opt-in Notifications & Audit Verifier)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles interactive TOTP setup confirmation and recovery codes", async () => {
    vi.mocked(accountApi.totpStatus).mockResolvedValue({
      enabled: false,
      pendingSetup: false,
      enrolledAt: null,
      recoveryRemaining: 0,
    });
    vi.mocked(accountApi.passkeys).mockResolvedValue({ items: [] });
    vi.mocked(accountApi.totpSetup).mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/ERTAD:demo@example.test?secret=JBSWY3DPEHPK3PXP",
      pendingSetup: true,
    });
    vi.mocked(accountApi.totpConfirm).mockResolvedValue({
      enabled: true,
      recoveryCodes: ["ABCD-EF23", "GHJK-LM45"],
      recoveryRemaining: 2,
    });

    render(
      <ConsolePreferencesContext.Provider
        value={{
          language: "en",
          theme: "light",
          setLanguage: vi.fn(),
          setTheme: vi.fn(),
        }}
      >
        <OwnMfaAndPasskeys />
      </ConsolePreferencesContext.Provider>,
    );

    const startBtn = await screen.findByRole("button", {
      name: "Set up TOTP app",
    });
    fireEvent.click(startBtn);

    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "TOTP QR code" }),
    ).toBeInTheDocument();
    const codeInput = screen.getByLabelText("6-digit confirmation code");
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Verify & activate TOTP" }),
    );

    expect(await screen.findByText("ABCD-EF23")).toBeInTheDocument();
    expect(screen.getByText("GHJK-LM45")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("ABCD-EF23")).toBeNull();
  });

  it("toggles opt-in notification preferences and syncs reminders", async () => {
    vi.mocked(accountApi.notifications).mockResolvedValue({
      preferences: {
        eventReminders: false,
        taskDeadlines: false,
        approvalDigests: false,
        channelMentions: false,
        updatedAt: "2026-11-11T10:00:00.000Z",
      },
      newlyQueued: 0,
      recentQueued: [],
    });
    vi.mocked(accountApi.updateNotifications).mockResolvedValue({
      preferences: {
        eventReminders: true,
        taskDeadlines: false,
        approvalDigests: false,
        channelMentions: false,
        updatedAt: "2026-11-11T10:01:00.000Z",
      },
      newlyQueued: 0,
      recentQueued: [],
    });

    render(
      <ConsolePreferencesContext.Provider
        value={{
          language: "en",
          theme: "light",
          setLanguage: vi.fn(),
          setTheme: vi.fn(),
        }}
      >
        <OwnNotifications />
      </ConsolePreferencesContext.Provider>,
    );

    const eventCheckbox = await screen.findByLabelText(
      "Event reminder (48h before start)",
    );
    expect(eventCheckbox).not.toBeChecked();
    fireEvent.click(eventCheckbox);
    expect(
      await screen.findByText("Notification preferences saved."),
    ).toBeInTheDocument();
    expect(accountApi.updateNotifications).toHaveBeenCalledWith({
      eventReminders: true,
    });
  });

  it("verifies immutable audit hash chain from Platform Audit tab", async () => {
    vi.mocked(platformApi.access).mockResolvedValue({
      technicalAccount: true,
      permissions: ["platform.read", "platform.audit.read"],
      validUntil: "2027-01-01T00:00:00.000Z",
    });
    vi.mocked(platformApi.audit).mockResolvedValue({
      items: [
        {
          id: "1",
          event: "PLATFORM_ACCESS_READ",
          at: "2026-11-11T10:00:00.000Z",
        },
      ],
      nextBefore: null,
    });
    vi.mocked(platformApi.verifyAuditChain).mockResolvedValue({
      verifiedCount: 42,
      genesisId: "1",
      headId: "42",
      headHash: "a".repeat(64),
      unbroken: true,
      brokenId: null,
      checkedAt: "2026-11-11T10:05:00.000Z",
      manifestDigest: "b".repeat(64),
      signedCheckpoint: null,
    });

    render(
      <MemoryRouter initialEntries={["/platform/audit"]}>
        <ConsolePreferencesContext.Provider
          value={{
            language: "en",
            theme: "light",
            setLanguage: vi.fn(),
            setTheme: vi.fn(),
          }}
        >
          <Routes>
            <Route path="/platform/:section" element={<Platform />} />
          </Routes>
        </ConsolePreferencesContext.Provider>
      </MemoryRouter>,
    );

    const verifyBtn = await screen.findByRole("button", {
      name: "Verify audit hash chain",
    });
    fireEvent.click(verifyBtn);
    expect(
      await screen.findByText(/Unbroken SHA-256 hash chain verified \(42 entries\)/),
    ).toBeInTheDocument();
  });
});

