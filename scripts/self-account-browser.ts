import { chromium, expect as baseExpect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function selfAccountBrowser(
  app: Express,
  email: string,
  password: string,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  let closing = false;
  const nextPassword = randomBytes(24).toString("base64url");
  try {
    await context.addInitScript(() => {
      if (!localStorage.getItem("ertad.console.language"))
        localStorage.setItem("ertad.console.language", "en");
    });
    await context.route("**/api/**", async (route) => {
      const u = new URL(route.request().url());
      if (!u.pathname.startsWith("/api/")) return route.continue();
      try {
        await route.fulfill({
          response: await route.fetch({
            url: endpoint + u.pathname + u.search,
          }),
        });
      } catch {
        if (!closing) errors.push("API transport failure");
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (
        new URL(r.url()).pathname.startsWith("/api/v1/admin/auth/security") &&
        r.status() >= 400
      )
        errors.push("Account API " + r.status());
    });
    try {
      await page.goto("http://localhost:15173/login");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL("**/dashboard");
      await page
        .getByRole("link", { name: "Account security", exact: true })
        .click();
      await expect(
        page.getByText("Current session", { exact: true }),
      ).toBeVisible();
      for (const language of ["ka", "en"])
        for (const theme of ["light", "dark"]) {
          await setConsoleAppearance(page, language, theme);
          await expect(
            page.getByText(
              language === "ka" ? "მიმდინარე სესია" : "Current session",
              { exact: true },
            ),
          ).toBeVisible();
          await page.getByRole("button", {
            name: language === "ka" ? "ყველა სხვა სესიის დახურვა" : "Close all other sessions",
            exact: true,
          }).click();
          await expect(page.getByRole("heading", {
            name: language === "ka" ? "ყველა სხვა სესიის დახურვა" : "Close all other sessions",
            exact: true,
          })).toBeFocused();
          for (const width of [360, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
              ),
            ).toBe(true);
          }
        }
      await page.screenshot({
        path: ".local/account-security.png",
        fullPage: true,
        animations: "disabled",
      });
      console.log(
        "PASS account view in both languages/themes and four widths; respecting API rate window",
      );
      await new Promise((r) => setTimeout(r, 60000));
      const count = await page
        .getByRole("button", { name: "Revoke session", exact: true })
        .count();
      expect(count).toBeGreaterThan(0);
      await page
        .getByRole("button", { name: "Revoke session", exact: true })
        .first()
        .click();
      await page.getByLabel("Current password", { exact: true }).fill(password);
      await page.getByLabel("I confirm this change", { exact: true }).check();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(
        page.getByText("Selected session revoked.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Revoke session", exact: true }),
      ).toHaveCount(count - 1);
      await page
        .getByRole("button", { name: "Close all other sessions", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Close all other sessions",
          exact: true,
        }),
      ).toBeFocused();
      for (const width of [360, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
      }
      await page.screenshot({
        path: ".local/account-close-others.png",
        fullPage: true,
        animations: "disabled",
      });
      await page.getByLabel("Current password", { exact: true }).fill(password);
      await page.getByLabel("I confirm this change", { exact: true }).check();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(
        page.getByText(
          `Other sessions closed (${count - 1}). Your current session remains active.`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Revoke session", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Current session", { exact: true }),
      ).toBeVisible();
      await page.getByLabel("Current password", { exact: true }).fill(password);
      await page.getByLabel("New password", { exact: true }).fill(nextPassword);
      await page
        .getByLabel("Repeat new password", { exact: true })
        .fill(nextPassword);
      await page.getByLabel("I confirm this change", { exact: true }).check();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(
        page.getByText(
          "Password changed and all sessions ended. Sign in with your new password.",
          { exact: true },
        ),
      ).toBeVisible();
      await page.screenshot({
        path: ".local/account-password-complete.png",
        fullPage: true,
        animations: "disabled",
      });
      expect(errors).toEqual([]);
      console.log(
        "PASS Chrome single/all-other session revocation and password rotation with confirmed sign-out",
      );
    } catch (error) {
      await page
        .screenshot({
          path: ".local/account-browser-failure.png",
          fullPage: true,
        })
        .catch(() => {});
      console.error("Account browser failure", { errors });
      throw error;
    }
    return nextPassword;
  } finally {
    closing = true;
    await context.close();
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
