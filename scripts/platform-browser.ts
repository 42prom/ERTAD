import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyPlatformBrowser(
  app: Express,
  account: { email: string; password: string },
  victim: { email: string; sessionId: () => Promise<string> },
  reviewer?: { email: string; password: string },
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  try {
    console.log("Platform browser: waiting for existing rate window");
    await new Promise((r) => setTimeout(r, 60000));
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    let closing = false;
    await context.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/")) return route.continue();
      try {
        await route.fulfill({
          response: await route.fetch({
            url: endpoint + url.pathname + url.search,
          }),
        });
      } catch {
        if (!closing) errors.push("Transport " + url.pathname);
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      const path = new URL(r.url()).pathname;
      if (path === "/api/v1/admin/auth/me" && r.status() === 401) return;
      if (path.startsWith("/api/") && r.status() >= 400)
        errors.push(`HTTP ${r.status()} ${path}`);
    });
    try {
      await page.goto("http://localhost:15173/login");
      await expect(
        page.getByRole("button", { name: /@demo\.ertad\.local/ }),
      ).toHaveCount(6);
      await expect(page.locator(".demo-account-grid button")).toHaveCount(7);
      await page
        .getByRole("button", {
          name: new RegExp(account.email.replaceAll(".", "\\.")),
        })
        .click();
      await page.waitForURL((u) => u.pathname === "/platform");
      for (const language of ["ka", "en"])
        for (const theme of ["light", "dark"]) {
          await setConsoleAppearance(page, language, theme);
          await expect(
            page.getByRole("heading", {
              name:
                language === "ka" ? "სისტემის მართვა" : "System administration",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByText(
              language === "ka"
                ? "პროდაქშენის გაშვება დაბლოკილია."
                : "Production startup is blocked.",
              { exact: true },
            ),
          ).toBeVisible();
          await expect(page.locator(".console-nav-item[href='/platform/audit']")).toBeVisible();
          await expect(page.locator(".console-nav-item[href='/platform/integrations']")).toBeVisible();
          await expect(page.locator(".console-nav-item:not([href^='/platform'])")).toHaveCount(0);
          for (const width of [360, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 1100 });
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
              ),
            ).toBe(true);
          }
          await page.screenshot({
            path: `.local/platform-${language}-${theme}.png`,
          });
        }
      await page
        .locator(".console-nav-item[href='/platform/audit']")
        .click();
      await expect(page.getByRole("table")).toBeVisible();
      await page.getByLabel("Event category").selectOption("authentication");
      await expect(
        page.getByText("Technical account login", { exact: true }).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
      await page.screenshot({ path: ".local/platform-audit.png" });
      const victimContext = await browser.newContext();
      await victimContext.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith("/api/")) return route.continue();
        await route.fulfill({
          response: await route.fetch({
            url: endpoint + url.pathname + url.search,
          }),
        });
      });
      try {
        const victimPage = await victimContext.newPage();
        await victimPage.goto("http://localhost:15173/login");
        await victimPage
          .getByRole("button", {
            name: new RegExp(victim.email.replaceAll(".", "\\.")),
          })
          .click();
        await victimPage.waitForURL((u) => u.pathname !== "/login");
        const targetId = await victim.sessionId();
        await page
          .locator(".console-nav-item[href='/platform/sessions']")
          .click();
        await expect(
          page.getByRole("heading", { name: "Active web sessions" }),
        ).toBeVisible();
        const row = page.getByRole("row").filter({ hasText: targetId });
        await row.getByRole("button", { name: "Revoke", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(
          row.getByRole("button", { name: "Revoke", exact: true }),
        ).toBeFocused();
        await row.getByRole("button", { name: "Revoke", exact: true }).click();
        await page
          .getByLabel("Reason", { exact: true })
          .selectOption("session_hygiene");
        await page.getByLabel("Your password").fill(account.password);
        const refreshResponse = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/api/v1/admin/platform/sessions" &&
            r.status() === 200,
        );
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await refreshResponse;
        await expect(page.getByRole("dialog")).toBeVisible();
        await expect(page.getByLabel("Your password")).toHaveValue(
          account.password,
        );
        await page.getByRole("button", { name: "Confirm and revoke" }).click();
        await expect(
          page.getByText("Session revoked.", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("row").filter({ hasText: targetId }),
        ).toHaveCount(0);
        const deniedStatus = await victimPage.evaluate(
          async () => (await fetch("/api/v1/admin/auth/me")).status,
        );
        expect(deniedStatus).toBe(401);
        for (const language of ["ka", "en"])
          for (const theme of ["light", "dark"]) {
            await setConsoleAppearance(page, language, theme);
            await page
              .locator(".console-nav-item[href='/platform/sessions']")
              .click();
            await expect(
              page.getByRole("heading", {
                name:
                  language === "ka"
                    ? "აქტიური ვებ-სესიები"
                    : "Active web sessions",
              }),
            ).toBeVisible();
            for (const width of [360, 390, 768, 1440]) {
              await page.setViewportSize({ width, height: 1100 });
              expect(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth + 1,
                ),
              ).toBe(true);
            }
            await page.screenshot({
              path: `.local/platform-sessions-${language}-${theme}.png`,
            });
          }
      } finally {
        await victimContext.close();
      }
      await page
        .locator(".console-nav-item[href='/platform/integrations']")
        .click();
      await expect(
        page.getByRole("heading", { name: "Integrations and providers" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Check connection", exact: true }),
      ).toHaveCount(3);
      await page
        .getByRole("heading", { name: "Database", exact: true })
        .locator("..")
        .getByRole("button", { name: "Check connection", exact: true })
        .click();
      await expect(
        page.getByRole("status").filter({ hasText: "Available" }),
      ).toHaveCount(1);
      await page
        .getByLabel("Category", { exact: true })
        .selectOption("identity");
      await expect(
        page.getByRole("button", { name: "Check connection", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Not activated", { exact: true }),
      ).toHaveCount(3);
      for (const language of ["ka", "en"])
        for (const theme of ["light", "dark"]) {
          await setConsoleAppearance(page, language, theme);
          await page
            .locator(".console-nav-item[href='/platform/integrations']")
            .click();
          await expect(
            page.getByRole("heading", {
              name:
                language === "ka"
                  ? "ინტეგრაციები და პროვაიდერები"
                  : "Integrations and providers",
            }),
          ).toBeVisible();
          await page
            .getByLabel(language === "ka" ? "კატეგორია" : "Category", {
              exact: true,
            })
            .selectOption("identity");
          await expect(
            page.getByRole("heading", {
              name:
                language === "ka"
                  ? "ცოცხალი ადამიანის შემოწმება"
                  : "Liveness / PAD",
            }),
          ).toBeVisible();
          for (const width of [360, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 1100 });
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
              ),
            ).toBe(true);
          }
          await page.screenshot({
            path: `.local/platform-integrations-${language}-${theme}.png`,
          });
        }
      await (
        await import("./platform-monitoring-browser")
      ).verifyMonitoringBrowser(page);
      if (reviewer)
        await (
          await import("./platform-policy-browser")
        ).verifyPolicyBrowser(page, browser, endpoint, account, reviewer);
      await page.goto("http://localhost:15173/tasks");
      await page.waitForURL((u) => u.pathname === "/platform");
      await expect(
        page.getByRole("heading", {
          name: "System administration",
          exact: true,
        }),
      ).toBeVisible();
      await page.goto("http://localhost:15173/settings/security");
      await page.waitForURL((u) => u.pathname === "/platform");
      await page.waitForLoadState("networkidle");
      expect(errors).toEqual([]);
      console.log(
        "PASS platform browser: seven quick logins, overview/audit/sessions/integrations, real diagnostic, inactive identity gates, password-confirmed revocation, two languages/themes and four widths",
      );
    } catch (error) {
      console.error("Platform browser response failures:", errors);
      await page.screenshot({ path: ".local/platform-browser-failure.png" });
      throw error;
    } finally {
      closing = true;
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
