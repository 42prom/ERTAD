import client from "./client";
export interface PlatformAccess {
  technicalAccount: boolean;
  permissions: string[];
  validUntil: string | null;
}
export interface PlatformOverview {
  checkedAt: string;
  validUntil: string;
  migrations: number;
  ownActiveSessions: number;
  dependencies: Record<
    "postgres" | "redis" | "storage",
    "ready" | "unavailable"
  >;
  mode: "development" | "test";
  productionEnabled: false;
  webMfa: "release_gate";
  externalCheckpoint: "not_activated";
}
export interface PlatformAudit {
  items: { id: string; event: string; at: string }[];
  nextBefore: string | null;
}
export interface PlatformSession {
  accountId?:string|null;
  id: string;
  kind: "technical" | "organization" | "unclassified";
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}
export interface PlatformSessions {
  items: PlatformSession[];
  nextBefore: string | null;
}
export type SessionReason =
  "suspected_compromise" | "operator_request" | "session_hygiene";
export const platformApi = {
  verificationPolicy: () =>
    client
      .get<VerificationPolicyResponse>("/admin/platform/verification/policy")
      .then((r) => r.data),
  proposeVerificationPolicy: (input: VerificationProposalInput) =>
    client
      .post<{ proposalId: string; status: string }>(
        "/admin/platform/verification/policy/propose",
        input,
      )
      .then((r) => r.data),
  reviewVerificationPolicy: (input: PolicyReviewInput) =>
    client
      .post<{ proposalId: string; action: string }>(
        "/admin/platform/verification/policy/review",
        input,
      )
      .then((r) => r.data),
  mobileDevices: () =>
    client
      .get<MobileDevicesResponse>("/admin/platform/verification/devices")
      .then((r) => r.data),
  controlMobileDevice: (input: MobileDeviceControlInput) =>
    client
      .post<{ bindingId?: string; op?: string; purgedCount?: number }>(
        "/admin/platform/verification/devices/control",
        input,
      )
      .then((r) => r.data),
  externalIntegrations: () =>
    client
      .get<ExternalIntegrationsResponse>(
        "/admin/platform/verification/integrations",
      )
      .then((r) => r.data),
  proposeExternalIntegration: (input: ExternalIntegrationProposalInput) =>
    client
      .post<{ proposalId: string; provider: string; status: string }>(
        "/admin/platform/verification/integrations/propose",
        input,
      )
      .then((r) => r.data),
  reviewExternalIntegration: (input: {
    requestId: string;
    proposalId: string;
    action: "approve" | "reject";
  }) =>
    client
      .post<{ proposalId: string; provider: string; status: string }>(
        "/admin/platform/verification/integrations/review",
        input,
      )
      .then((r) => r.data),
  providerPolicy: (before?: string) =>
    client
      .get<ProviderPolicyList>("/admin/platform/provider-policy", {
        params: { before },
      })
      .then((r) => r.data),
  proposeProviderPolicy: (input: ProviderProposalInput) =>
    client
      .post<{ id: string }>("/admin/platform/provider-policy/propose", input)
      .then((r) => r.data),
  reviewProviderPolicy: (input: PolicyReviewInput) =>
    client
      .post<{ id: string }>("/admin/platform/provider-policy/review", input)
      .then((r) => r.data),
  securityLimits: (before?: string) =>
    client
      .get<SecurityLimitsList>("/admin/platform/security-limits", {
        params: { before },
      })
      .then((r) => r.data),
  proposeSecurityLimits: (input: LimitsProposalInput) =>
    client
      .post<{ id: string }>("/admin/platform/security-limits/propose", input)
      .then((r) => r.data),
  reviewSecurityLimits: (input: PolicyReviewInput) =>
    client
      .post<{ id: string }>("/admin/platform/security-limits/review", input)
      .then((r) => r.data),
  networkPolicy: (before?: string) =>
    client
      .get<NetworkPolicyList>("/admin/platform/network-policy", {
        params: { before },
      })
      .then((r) => r.data),
  networkAddressKey: (address: string) =>
    client
      .post<{ key: string }>("/admin/platform/network-policy/address-key", {
        address,
      })
      .then((r) => r.data),
  proposeNetworkPolicy: (input: NetworkProposalInput) =>
    client
      .post<{ id: string }>("/admin/platform/network-policy/propose", input)
      .then((r) => r.data),
  reviewNetworkPolicy: (input: PolicyReviewInput) =>
    client
      .post<{ id: string }>("/admin/platform/network-policy/review", input)
      .then((r) => r.data),
  monitoring: (minutes: "15" | "60" | "1440", category: SecuritySignal | "all") =>
    client
      .get<PlatformMonitoring>("/admin/platform/monitoring", {
        params: { minutes, category },
      })
      .then((r) => r.data),
  verifyAuditChain: () =>
    client
      .get<AuditChainVerification>("/admin/platform/audit/verify")
      .then((r) => r.data),
  metricsPrometheus: () =>
    client
      .get<string>("/admin/platform/metrics", { responseType: "text" })
      .then((r) => r.data),
  sessionPolicy: (before?: string) =>
    client
      .get<SessionPolicyList>("/admin/platform/session-policy", {
        params: { before },
      })
      .then((r) => r.data),
  proposeSessionPolicy: (input: PolicyProposalInput) =>
    client
      .post<{ id: string }>("/admin/platform/session-policy/propose", input)
      .then((r) => r.data),
  reviewSessionPolicy: (input: PolicyReviewInput) =>
    client
      .post<{ id: string }>("/admin/platform/session-policy/review", input)
      .then((r) => r.data),
  integrations: () =>
    client
      .get<PlatformIntegrations>("/admin/platform/integrations")
      .then((r) => r.data),
  checkIntegration: (target: string) =>
    client
      .post<IntegrationCheck>("/admin/platform/integrations/check", { target })
      .then((r) => r.data),
  sessions: (kind: string, before?: string) =>
    client
      .get<PlatformSessions>("/admin/platform/sessions", {
        params: { kind, before },
      })
      .then((r) => r.data),
  revokeSession: (input: {
    sessionId: string;
    requestId: string;
    reason: SessionReason;
  }) =>
    client
      .post<{ sessionId: string; revokedAt: string }>(
        "/admin/platform/sessions/revoke",
        input,
      )
      .then((r) => r.data),
  access: () =>
    client.get<PlatformAccess>("/admin/platform/access").then((r) => r.data),
  overview: () =>
    client
      .get<PlatformOverview>("/admin/platform/overview")
      .then((r) => r.data),
  audit: (category: string, before?: string) =>
    client
      .get<PlatformAudit>("/admin/platform/audit", {
        params: { category, before },
      })
      .then((r) => r.data),
};

export type SecuritySignal =
  | "login_failed"
  | "step_up_failed"
  | "authentication_required"
  | "access_denied"
  | "rate_limited"
  | "server_error";
export interface AuditChainVerification {
  verifiedCount: number;
  genesisId: string | null;
  headId: string | null;
  headHash: string;
  unbroken: boolean;
  brokenId: string | null;
  checkedAt: string;
  manifestDigest: string;
  signedCheckpoint: {
    payload: Record<string, unknown>;
    checkpointHash: string;
    signature: string;
    algorithm: "Ed25519";
    publicKeyPem: string;
  } | null;
}
export interface PlatformMonitoring {
  checkedAt: string;
  observedSince: string;
  processStartedAt: string;
  minutes: 15 | 60 | 1440;
  category: SecuritySignal | "all";
  retention: "process_memory_60_minutes" | "persisted_database_72_hours";
  totals: Record<SecuritySignal, number>;
  items: { at: string; counts: Record<SecuritySignal, number> }[];
  recentTechnicalEvents: PlatformAudit["items"];
}

export interface SessionPolicyValues {
  idleSeconds: number;
  absoluteSeconds: number;
  maxSessions: number;
}

export interface NetworkSettings {
  mode: "off" | "allow" | "deny";
  countries: string[];
  blocked: { key: string; until: string }[];
  exceptions: { key: string; until: string }[];
}
export interface NetworkProposalInput {
  requestId: string;
  expectedVersion: number;
  settings: NetworkSettings;
  reason: "security_tightening" | "network_access" | "recovery";
}
export interface NetworkProposal extends Omit<
  SessionPolicyProposal,
  keyof SessionPolicyValues | "reason"
> {
  settings: NetworkSettings;
  reason: NetworkProposalInput["reason"];
}
export interface NetworkPolicyList {
  current: { version: number; settings: NetworkSettings };
  items: NetworkProposal[];
  nextBefore: string | null;
  configured: boolean;
  countryReady: boolean;
  source: string;
  country: string | null;
}
export type PolicyReason =
  "security_tightening" | "session_usability" | "recovery";
export interface PolicyProposalInput extends SessionPolicyValues {
  requestId: string;
  expectedVersion: number;
  reason: PolicyReason;
}
export interface PolicyReviewInput {
  requestId: string;
  proposalId: string;
  action: "approve" | "reject" | "withdraw";
}
export interface SessionPolicyProposal extends SessionPolicyValues {
  id: string;
  mine: boolean;
  expectedVersion: number;
  version: number | null;
  reason: PolicyReason;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "expired";
  createdAt: string;
  expiresAt: string;
  reviewedAt: string | null;
}
export interface SessionPolicyList {
  current: SessionPolicyValues & { version: number };
  items: SessionPolicyProposal[];
  nextBefore: string | null;
}

export interface PlatformIntegration {
  id: string;
  category: string;
  active: boolean;
  configuration: "loaded" | "missing" | "not_loaded";
  diagnostic: "available" | "unavailable";
  assurance: "not_applicable" | "not_verified";
  blocker: string | null;
}
export interface PlatformIntegrations {
  checkedAt: string;
  items: PlatformIntegration[];
}
export interface IntegrationCheck {
  target: string;
  status: "ready" | "unavailable" | "not_configured";
  checkedAt: string;
  durationMs: number;
}

export interface SecurityLimitsValues {
  apiPerMinute: number;
  loginFailures: number;
  lockoutMinutes: number;
  anonymousMinElectorate?: number;
}
export type LimitsReason =
  "security_tightening" | "traffic_adjustment" | "recovery";
export interface LimitsProposalInput extends SecurityLimitsValues {
  requestId: string;
  expectedVersion: number;
  reason: LimitsReason;
}
export interface SecurityLimitsProposal
  extends
    Omit<SessionPolicyProposal, keyof SessionPolicyValues | "reason">,
    SecurityLimitsValues {
  reason: LimitsReason;
}
export interface SecurityLimitsList {
  current: SecurityLimitsValues & { version: number };
  items: SecurityLimitsProposal[];
  nextBefore: string | null;
}

export interface VerificationPolicyValues {
  authProfile: "google_hybrid" | "document_and_face";
  requireDeviceAttestation: boolean;
  requireNfc: boolean;
  requireGeorgianCitizen: boolean;
  livenessProvider:
    | "3d_face_detector"
    | "facetec"
    | "iproov"
    | "aws-rekognition"
    | "faceplusplus"
    | "doublescript"
    | "provider";
  faceMatchProvider:
    | "custom_biometric_matcher"
    | "aws-rekognition"
    | "faceplusplus"
    | "doublescript"
    | "provider";
  livenessMinScore: number;
  faceMatchMinScore: number;
  retryLimit: number;
  biometricTtlSeconds: number;
}
export interface VerificationPolicySnapshot extends VerificationPolicyValues {
  version: number;
  hasCredential: boolean;
  updatedAt: string;
}
export interface VerificationProposalItem extends VerificationPolicyValues {
  id: string;
  proposerId: string;
  expectedVersion: number;
  hasCredential: boolean;
  reason: "security_tightening" | "provider_change" | "recovery";
  status: "pending" | "approved" | "rejected" | "withdrawn";
  createdAt: string;
}
export interface VerificationProposalInput extends VerificationPolicyValues {
  requestId: string;
  expectedVersion: number;
  apiKey?: string;
  reason: "security_tightening" | "provider_change" | "recovery";
}
export interface VerificationPolicyResponse {
  policy: VerificationPolicySnapshot;
  pendingProposals: VerificationProposalItem[];
  ttlHealth: {
    activeBiometricSessions: number;
    purgedOnRead: number;
  };
}
export interface MobileDeviceBindingItem {
  id: string;
  platform: "android" | "ios";
  appId: string;
  verdict: "strong" | "basic" | "unverified";
  counter: number;
  status: "active" | "held" | "revoked";
  holdReason: string | null;
  lastAttestedAt: string;
  createdAt: string;
}
export interface MobileDevicesResponse {
  devices: MobileDeviceBindingItem[];
  summary: {
    activeDevices: number;
    heldDevices: number;
    revokedDevices: number;
  };
}
export interface MobileDeviceControlInput {
  op: "hold" | "release" | "revoke" | "purge_biometrics";
  bindingId?: string;
  reason?: "suspected_compromise" | "replay_detected" | "operator_request";
}

export interface ProviderValues {
  provider: "none" | "iphub";
  mode: "off" | "enforce";
  blockSuspicious: boolean;
}
export type ProviderReason =
  "security_tightening" | "provider_change" | "recovery";
export interface ProviderProposalInput extends ProviderValues {
  requestId: string;
  expectedVersion: number;
  reason: ProviderReason;
  apiKey?: string;
}
export interface ProviderProposal
  extends
    Omit<SessionPolicyProposal, keyof SessionPolicyValues | "reason">,
    ProviderValues {
  hasCredential: boolean;
  reason: ProviderReason;
}
export interface ProviderPolicyList {
  current: ProviderValues & { version: number; hasCredential: boolean };
  items: ProviderProposal[];
  nextBefore: string | null;
  runtimeReady: boolean;
}

export type ExternalIntegrationProvider =
  | "google_oidc"
  | "fcm_push"
  | "telegram_bot"
  | "whatsapp_business"
  | "viber_bot";

export interface ExternalIntegrationState {
  provider: ExternalIntegrationProvider;
  enabled: boolean;
  version: number;
  publicConfig: Record<string, string>;
  hasSecret: boolean;
  updatedAt: string;
}

export interface ExternalIntegrationProposal {
  id: string;
  provider: ExternalIntegrationProvider;
  expectedVersion: number;
  enabled: boolean;
  publicConfig: Record<string, string>;
  hasSecretUpdate: boolean;
  clearSecret: boolean;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  proposerId: string;
  reviewerId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface ExternalIntegrationsResponse {
  providers: ExternalIntegrationState[];
  proposals: ExternalIntegrationProposal[];
}

export interface ExternalIntegrationProposalInput {
  requestId: string;
  provider: ExternalIntegrationProvider;
  expectedVersion: number;
  enabled: boolean;
  publicConfig: Record<string, string>;
  secret?: string;
  clearSecret?: boolean;
  reason: string;
}
