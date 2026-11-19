import client from "./client";
import type { ServerRegistrationOptions } from "../utils/webauthnClient";

export interface OwnSession {
  id: string;
  current: boolean;
  clientLabel?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}
export interface OwnSessions {
  items: OwnSession[];
  nextBefore: string | null;
}
export interface OwnRecovery {
  available: boolean;
  pending: null | {
    id: string;
    createdAt: string;
    expiresAt: string;
    delivered: boolean;
  };
}
export interface OwnTotpStatus {
  enabled: boolean;
  pendingSetup: boolean;
  enrolledAt: string | null;
  recoveryRemaining: number;
}
export interface OwnPasskey {
  id: string;
  label: string;
  algorithm: number;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}
export interface OwnNotificationPreferences {
  eventReminders: boolean;
  taskDeadlines: boolean;
  approvalDigests: boolean;
  channelMentions: boolean;
  updatedAt: string;
}
export interface OwnNotificationsView {
  preferences: OwnNotificationPreferences;
  newlyQueued: number;
  recentQueued: {
    id: string;
    kind: string;
    title: string;
    scheduledFor: string;
    deliveredAt: string | null;
  }[];
}
export const accountApi = {
  recovery: () =>
    client
      .get<OwnRecovery>("/admin/auth/security/recovery")
      .then((r) => r.data),
  cancelRecovery: (recoveryId: string) =>
    client
      .post<{ cancelled: true }>("/admin/auth/security/recovery/cancel", {
        recoveryId,
      })
      .then((r) => r.data),
  sessions: (before?: string) =>
    client
      .get<OwnSessions>("/admin/auth/security/sessions", { params: { before } })
      .then((r) => r.data),
  revoke: (sessionId: string) =>
    client
      .post("/admin/auth/security/sessions/revoke", { sessionId })
      .then((r) => r.data),
  revokeOthers: () =>
    client
      .post<{ revokedCount: number }>(
        "/admin/auth/security/sessions/revoke-others",
        {},
      )
      .then((r) => r.data),
  changePassword: (newPassword: string) =>
    client
      .post<{ signedOut: true }>("/admin/auth/security/password", {
        newPassword,
      })
      .then((r) => r.data),
  totpStatus: () =>
    client.get<OwnTotpStatus>("/admin/auth/security/totp").then((r) => r.data),
  totpSetup: () =>
    client
      .post<{ secret: string; otpauthUri: string; pendingSetup: boolean }>(
        "/admin/auth/security/totp/setup",
        {},
      )
      .then((r) => r.data),
  totpConfirm: (code: string) =>
    client
      .post<{
        enabled: boolean;
        recoveryCodes: string[];
        recoveryRemaining: number;
      }>("/admin/auth/security/totp/confirm", { code })
      .then((r) => r.data),
  totpDisable: () =>
    client
      .post<{ enabled: boolean }>("/admin/auth/security/totp/disable", {})
      .then((r) => r.data),
  totpRegenerateRecovery: () =>
    client
      .post<{ recoveryCodes: string[]; recoveryRemaining: number }>(
        "/admin/auth/security/totp/recovery/regenerate",
        {},
      )
      .then((r) => r.data),
  passkeys: () =>
    client
      .get<{ items: OwnPasskey[] }>("/admin/auth/security/passkeys")
      .then((r) => r.data),
  passkeyRegisterOptions: (label: string) =>
    client
      .post<ServerRegistrationOptions>(
        "/admin/auth/security/passkeys/register/options",
        { label },
      )
      .then((r) => r.data),
  passkeyRegisterVerify: (input: {
    challengeId: string;
    label: string;
    clientDataJSON: string;
    attestationObject: string;
    transports: string[];
  }) =>
    client
      .post<{ id: string; label: string; createdAt: string }>(
        "/admin/auth/security/passkeys/register/verify",
        input,
      )
      .then((r) => r.data),
  passkeyRename: (passkeyId: string, label: string) =>
    client
      .post<{ id: string; label: string }>(
        "/admin/auth/security/passkeys/rename",
        { passkeyId, label },
      )
      .then((r) => r.data),
  passkeyDelete: (passkeyId: string) =>
    client
      .post<{ deletedId: string }>("/admin/auth/security/passkeys/delete", {
        passkeyId,
      })
      .then((r) => r.data),
  notifications: () =>
    client
      .get<OwnNotificationsView>("/admin/auth/security/notifications")
      .then((r) => r.data),
  updateNotifications: (input: {
    eventReminders?: boolean;
    taskDeadlines?: boolean;
    approvalDigests?: boolean;
    channelMentions?: boolean;
  }) =>
    client
      .post<OwnNotificationsView>("/admin/auth/security/notifications", input)
      .then((r) => r.data),
  syncNotifications: () =>
    client
      .post<OwnNotificationsView>(
        "/admin/auth/security/notifications/sync",
        {},
      )
      .then((r) => r.data),
};
