import client from "./client";
export interface OwnEmailStatus {
  accountId: string;
  currentEmail: string;
  available: boolean;
  deliveryEnabled: boolean;
  pending: null | {
    id: string;
    newEmail: string;
    createdAt: string;
    expiresAt: string;
    valid: boolean;
    mailStatus: string | null;
  };
}
export const emailChangeApi = {
  status: () =>
    client
      .get<OwnEmailStatus>("/admin/auth/security/email")
      .then((r) => r.data),
  request: (requestId: string, newEmail: string) =>
    client
      .post<{ id: string }>("/admin/auth/security/email/request", {
        requestId,
        newEmail,
      })
      .then((r) => r.data),
  cancel: (id: string) =>
    client
      .post<{ cancelled: true }>("/admin/auth/security/email/cancel", { id })
      .then((r) => r.data),
  confirm: (id: string, token: string, newEmail: string) =>
    client
      .post<{ changed: true }>("/admin/auth/security/email/confirm", {
        id,
        token,
        newEmail,
      })
      .then((r) => r.data),
};
