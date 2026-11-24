import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlatformExternalIntegrations from "../components/PlatformExternalIntegrations";
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
    externalIntegrations: vi.fn(),
    proposeExternalIntegration: vi.fn(),
    reviewExternalIntegration: vi.fn(),
  },
}));

const sampleState = {
  providers: [
    {
      provider: "google_oidc" as const,
      enabled: false,
      version: 1,
      publicConfig: { androidClientId: "", iosClientId: "" },
      hasSecret: false,
      updatedAt: "2026-11-21T00:00:00Z",
    },
    {
      provider: "fcm_push" as const,
      enabled: true,
      version: 2,
      publicConfig: { projectId: "ertad-demo-proj" },
      hasSecret: true,
      updatedAt: "2026-11-21T00:00:00Z",
    },
  ],
  proposals: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      provider: "fcm_push" as const,
      expectedVersion: 2,
      enabled: true,
      publicConfig: { projectId: "ertad-demo-proj" },
      hasSecretUpdate: true,
      reason: "Rotate push token",
      status: "pending" as const,
      proposerId: "22222222-2222-4222-8222-222222222222",
      reviewerId: null,
      createdAt: "2026-11-21T00:00:00Z",
    },
  ],
};

describe("PlatformExternalIntegrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(platformApi.externalIntegrations).mockResolvedValue(sampleState);
    vi.mocked(platformApi.proposeExternalIntegration).mockResolvedValue({
      proposalId: "33333333-3333-4333-8333-333333333333",
      status: "pending",
    });
    vi.mocked(platformApi.reviewExternalIntegration).mockResolvedValue({
      proposalId: sampleState.proposals[0].id,
      status: "approved",
    });
  });

  it("shows read-only integration metadata without mutation buttons when lacking propose/approve", async () => {
    render(
      <PlatformExternalIntegrations canPropose={false} canApprove={false} />,
    );

    await screen.findByText(/Google OIDC \(Sign-In\) · v1/i);
    expect(screen.getByText(/Android OAuth Client ID: — · No secret stored/)).toBeInTheDocument();
    expect(screen.getByText(/Firebase Project ID: ertad-demo-proj · Secret stored/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Configure/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve/i })).toBeNull();
  });

  it("allows proposing Google OIDC with both Android and iOS Client IDs and reviewing pending proposals", async () => {
    const user = userEvent.setup();
    render(<PlatformExternalIntegrations canPropose canApprove />);

    const configureButtons = await screen.findAllByRole("button", {
      name: /Configure/i,
    });
    await user.click(configureButtons[0]);

    await user.click(screen.getByRole("checkbox", { name: /Enable integration/i }));
    await user.type(
      screen.getByLabelText("Android OAuth Client ID"),
      "synthetic-android.apps.googleusercontent.com",
    );
    await user.type(
      screen.getByLabelText("iOS OAuth Client ID (optional)"),
      "synthetic-ios.apps.googleusercontent.com",
    );
    await user.type(
      screen.getByLabelText("OAuth Client Secret (optional)"),
      "synthetic-secret-value",
    );
    await user.type(screen.getByLabelText("Change reason"), "Enable Google OIDC");

    await user.click(screen.getByRole("button", { name: /Submit proposal/i }));
    await waitFor(() =>
      expect(platformApi.proposeExternalIntegration).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "google_oidc",
          expectedVersion: 1,
          enabled: true,
          publicConfig: {
            androidClientId: "synthetic-android.apps.googleusercontent.com",
            iosClientId: "synthetic-ios.apps.googleusercontent.com",
          },
          secret: "synthetic-secret-value",
          reason: "Enable Google OIDC",
        }),
      ),
    );

    await user.click(screen.getByRole("button", { name: /^Approve$/i }));
    await waitFor(() =>
      expect(platformApi.reviewExternalIntegration).toHaveBeenCalledWith(
        expect.objectContaining({
          proposalId: sampleState.proposals[0].id,
          action: "approve",
        }),
      ),
    );
  });

  it("prompts inline password step-up on 428 and retries proposal automatically", async () => {
    const user = userEvent.setup();
    vi.mocked(platformApi.proposeExternalIntegration)
      .mockRejectedValueOnce({ response: { status: 428 } })
      .mockResolvedValueOnce({
        proposalId: "44444444-4444-4444-8444-444444444444",
        status: "pending",
      });
    vi.mocked(authApi.stepUp).mockResolvedValueOnce({
      message: "ok",
      stepUpExpiresAt: "2026-11-24T20:00:00Z",
    });

    render(<PlatformExternalIntegrations canPropose canApprove={false} />);
    const configureButtons = await screen.findAllByRole("button", {
      name: /Configure/i,
    });
    await user.click(configureButtons[0]);
    await user.type(screen.getByLabelText("Change reason"), "Rotate OIDC config");
    await user.click(screen.getByRole("button", { name: /Submit proposal/i }));

    const pwInput = await screen.findByLabelText("Your password");
    await user.type(pwInput, "synthetic-tech-pass");
    await user.click(screen.getByRole("button", { name: /Confirm & submit/i }));

    await waitFor(() => expect(authApi.stepUp).toHaveBeenCalledWith("synthetic-tech-pass"));
    await waitFor(() =>
      expect(platformApi.proposeExternalIntegration).toHaveBeenCalledTimes(2),
    );
  });
});
