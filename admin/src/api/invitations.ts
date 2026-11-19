import client from "./client";
export interface InviteContact {
  source?:'synthetic'|'email';
  id: string;
  memberId: string;
  unitId: string;
  unitName: string;
  displayName: string | null;
  contactHint: string;
}
export interface WebInvitation {
  mailStatus?: string | null;
  needsEmailProof?: boolean;
  id: string;
  unitId: string;
  unitName: string;
  displayName: string | null;
  status: string;
  deadline: string;
  canRevoke: boolean;
  version: number;
}
export const invitationsApi = {
  revokeContact:(organizationId:string,id:string)=>client.post<{id:string;revoked:true}>('/admin/invitations/contact/revoke',{organizationId,id}).then(r=>r.data),
  candidates: (organizationId: string, page = 1) =>
    client
      .get<{
        items: {
          memberId: string;
          unitId: string;
          unitName: string;
          displayName: string | null;
        }[];
        page: number;
      }>("/admin/invitations/candidates", { params: { organizationId, page } })
      .then((r) => r.data),
  createContact: (input: {
    organizationId: string;
    unitId: string;
    memberId: string;
    email: string;
    requestId: string;
  }) =>
    client
      .post<{ id: string }>("/admin/invitations/contact", input)
      .then((r) => r.data),
  confirmEmail: (id: string, token: string) =>
    client
      .post<{ verified: true }>("/admin/invitations/confirm-email", {
        id,
        token,
      })
      .then((r) => r.data),
  contexts: () =>
    client
      .get<{ id: string; name: string }[]>("/admin/invitations/contexts")
      .then((r) => r.data),
  contacts: (organizationId: string, page = 1) =>
    client
      .get<{ items: InviteContact[]; page: number }>(
        "/admin/invitations/contacts",
        { params: { organizationId, page } },
      )
      .then((r) => r.data),
  list: (organizationId: string, page = 1) =>
    client
      .get<{ items: WebInvitation[]; page: number }>(
        "/admin/invitations/list",
        { params: { organizationId, page } },
      )
      .then((r) => r.data),
  revoke: (organizationId: string, id: string) =>
    client
      .post("/admin/invitations/revoke", { organizationId, id })
      .then((r) => r.data),
  activate: (id: string, token: string, password: string) =>
    client
      .post<{ activated: true }>("/admin/invitations/activate", {
        id,
        token,
        password,
      })
      .then((r) => r.data),
};
