import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlatformVerification from "../components/PlatformVerification";
import { platformApi } from "../api/platform";
import { authApi } from "../api/client";

vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en", theme: "light" }),
}));

vi.mock("../api/client", () => ({
  authApi: {
    stepUp: vi.fn(),
  },
}));

vi.mock("../api/platform", () => ({
  platformApi: {
    verificationPolicy: vi.fn(),
    proposeVerificationPolicy: vi.fn(),
    reviewVerificationPolicy: vi.fn(),
    mobileDevices: vi.fn(),
    controlMobileDevice: vi.fn(),
  },
}));

const samplePolicy = {
  policy: {
    version: 2,
    authProfile: "google_hybrid" as const,
    requireDeviceAttestation: true,
    requireNfc: true,
    requireGeorgianCitizen: true,
    livenessProvider: "3d_face_detector" as const,
    faceMatchProvider: "custom_biometric_matcher" as const,
    livenessMinScore: 0.85,
    faceMatchMinScore: 0.8,
    retryLimit: 3,
    biometricTtlSeconds: 900,
    hasCredential: true,
    updatedAt: "2026-11-19T00:00:00Z",
  },
  pendingProposals: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      proposerId: "22222222-2222-4222-8222-222222222222",
      expectedVersion: 2,
      authProfile: "google_hybrid" as const,
      requireDeviceAttestation: true,
      requireNfc: true,
      requireGeorgianCitizen: true,
      livenessProvider: "facetec" as const,
      faceMatchProvider: "custom_biometric_matcher" as const,
      livenessMinScore: 0.88,
      faceMatchMinScore: 0.82,
      retryLimit: 3,
      biometricTtlSeconds: 600,
      hasCredential: true,
      reason: "security_tightening" as const,
      status: "pending" as const,
      createdAt: "2026-11-19T00:00:00Z",
    },
  ],
  ttlHealth: { activeBiometricSessions: 1, purgedOnRead: 2 },
};

const sampleDevices = {
  devices: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      platform: "android" as const,
      appId: "ge.ertad.mobile",
      verdict: "strong" as const,
      counter: 3,
      status: "active" as const,
      holdReason: null,
      lastAttestedAt: "2026-11-19T00:00:00Z",
      createdAt: "2026-11-19T00:00:00Z",
    },
  ],
  summary: { activeDevices: 1, heldDevices: 0, revokedDevices: 0 },
};

describe("PlatformVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(platformApi.verificationPolicy).mockResolvedValue(samplePolicy);
    vi.mocked(platformApi.mobileDevices).mockResolvedValue(sampleDevices);
    vi.mocked(platformApi.proposeVerificationPolicy).mockResolvedValue({
      proposalId: "44444444-4444-4444-8444-444444444444",
      status: "pending",
    });
    vi.mocked(platformApi.reviewVerificationPolicy).mockResolvedValue({
      proposalId: samplePolicy.pendingProposals[0].id,
      action: "approve",
    });
    vi.mocked(platformApi.controlMobileDevice).mockResolvedValue({
      bindingId: sampleDevices.devices[0].id,
      op: "hold",
    });
  });

  it("enforces strict Read-only view when operator lacks propose/approve/control capabilities", async () => {
    render(
      <PlatformVerification
        canPropose={false}
        canApprove={false}
        canControlDevices={false}
        refreshRevision={0}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Read-only access/i)).toBeInTheDocument());
    expect(screen.getByText(/v2 · google_hybrid/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Propose policy change/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hold/i })).not.toBeInTheDocument();
  });

  it("allows governed Propose, Approve, and Device Hold when operator has explicit capabilities", async () => {
    const user = userEvent.setup();
    render(
      <PlatformVerification
        canPropose
        canApprove
        canControlDevices
        refreshRevision={0}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Propose policy change/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Liveness 0\.88 · Face 0\.82/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Propose policy change/i }));
    await waitFor(() => expect(platformApi.proposeVerificationPolicy).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /^Approve$/i }));
    await waitFor(() => expect(platformApi.reviewVerificationPolicy).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /^Hold$/i }));
    await user.click(screen.getByRole("button", { name: /Confirm action/i }));
    await waitFor(() =>
      expect(platformApi.controlMobileDevice).toHaveBeenCalledWith({
        op: "hold",
        bindingId: sampleDevices.devices[0].id,
        reason: "operator_request",
      }),
    );
  });

  it("prompts inline password step-up on 428 and retries verification proposal", async () => {
    const user = userEvent.setup();
    vi.mocked(platformApi.proposeVerificationPolicy)
      .mockRejectedValueOnce({ response: { status: 428 } })
      .mockResolvedValueOnce({
        proposalId: "55555555-5555-4555-8555-555555555555",
        status: "pending",
      });
    vi.mocked(authApi.stepUp).mockResolvedValueOnce({
      message: "ok",
      stepUpExpiresAt: "2026-11-24T20:00:00Z",
    });

    render(
      <PlatformVerification
        canPropose
        canApprove={false}
        canControlDevices={false}
        refreshRevision={0}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /Propose policy change/i }));
    const pwInput = await screen.findByLabelText("Your password");
    await user.type(pwInput, "synthetic-tech-pass");
    await user.click(screen.getByRole("button", { name: /Confirm & submit/i }));

    await waitFor(() => expect(authApi.stepUp).toHaveBeenCalledWith("synthetic-tech-pass"));
    await waitFor(() => expect(platformApi.proposeVerificationPolicy).toHaveBeenCalledTimes(2));
  });
});
