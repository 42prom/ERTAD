import client from "./client";
import type { AuthResponse } from "../types";
export interface DemoAccount {
  id: string;
  email: string;
  label: string;
  region: string;
  kind?: "technical";
}
export interface DemoPerson {
  id: string;
  memberId: string;
  label: string;
  region: string;
}
export const demoApi = {
  accounts: async (): Promise<{ enabled: boolean; accounts: DemoAccount[] }> =>
    (await client.get("/admin/demo/accounts")).data,
  login: async (accountId: string): Promise<AuthResponse> =>
    (await client.post("/admin/demo/login", { accountId })).data,
  stepUp: async (): Promise<void> => {
    await client.post("/admin/demo/step-up", {});
  },
  scenario: async (): Promise<{ accounts: DemoPerson[] }> =>
    (await client.get("/admin/demo/scenario")).data,
};
