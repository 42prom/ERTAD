import { afterEach, expect, it, vi } from "vitest";
import { AxiosError } from "axios";
import client, { adminFetch } from "../api/client";

afterEach(() => vi.unstubAllGlobals());

for (const path of ["/activate", "/recover", "/verify-email", "/verify-email-change", "/dashboard"]) {
  it(`handles expired Axios sessions on ${path} without exposing protected pages`, async () => {
    const location = { pathname: path, href: path };
    vi.stubGlobal("window", { location });
    sessionStorage.setItem("admin_csrf", "stale");
    sessionStorage.setItem("admin_user", "stale");
    await expect(
      client.get("/admin/auth/me", {
        adapter: async (config) => {
          throw new AxiosError(
            "Unauthenticated",
            undefined,
            config,
            undefined,
            {
              status: 401,
              statusText: "Unauthorized",
              data: {},
              headers: {},
              config,
            },
          );
        },
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
    expect(location.href).toBe(path === "/dashboard" ? "/login" : path);
    expect(sessionStorage.getItem("admin_csrf")).toBeNull();
    expect(sessionStorage.getItem("admin_user")).toBeNull();
  });

  it(`handles expired fetch sessions on ${path} with the same public-route boundary`, async () => {
    const location = { pathname: path, href: path };
    vi.stubGlobal("window", { location });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    sessionStorage.setItem("admin_csrf", "stale");
    sessionStorage.setItem("admin_user", "stale");
    expect((await adminFetch("/api/v1/admin/auth/me")).status).toBe(401);
    expect(location.href).toBe(path === "/dashboard" ? "/login" : path);
    expect(sessionStorage.getItem("admin_csrf")).toBeNull();
    expect(sessionStorage.getItem("admin_user")).toBeNull();
  });
}
