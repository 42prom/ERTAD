import client from "./client";
export const recoveryApi = {
  request: (email: string) =>
    client
      .post<{ accepted: true }>("/admin/recovery/request", { email })
      .then((r) => r.data),
  complete: (id: string, token: string, password: string) =>
    client
      .post<{ recovered: true }>("/admin/recovery/complete", {
        id,
        token,
        password,
      })
      .then((r) => r.data),
};
