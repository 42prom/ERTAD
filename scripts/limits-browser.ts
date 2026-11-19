import { chromium, expect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import { setConsoleAppearance } from "./console-browser";
export async function verifyLimitsBrowser(
  app: Express,
  operator: { email: string; password: string },
  reviewer: { email: string; password: string },
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  try {
    async function login(account: typeof operator) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      await context.addInitScript(() => {
        if (!localStorage.getItem("ertad.console.language"))
          localStorage.setItem("ertad.console.language", "en");
      });
      await context.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith("/api/")) return route.continue();
        await route.fulfill({
          response: await route.fetch({
            url: endpoint + url.pathname + url.search,
          }),
        });
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("http://localhost:15173/login");
      await expect(page.locator(".demo-account-grid button")).toHaveCount(7);
      await page.getByLabel("Email", { exact: true }).fill(account.email);
      await page.getByLabel("Password", { exact: true }).fill(account.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL((u) => u.pathname === "/platform");
      await page
        .locator(".console-nav-item[href='/platform/limits']")
        .click();
      await expect(
        page.getByRole("heading", { name: "Security limits", exact: true }),
      ).toBeVisible();
      return page;
    }

    const first = await login(operator);
    await first
      .getByRole("button", { name: "Propose change", exact: true })
      .click();
    await first
      .getByLabel("API requests per address / minute (60–600)", { exact: true })
      .fill("180");
    await first
      .getByLabel("Your password", { exact: true })
      .fill(operator.password);
    await first
      .getByRole("button", { name: "Submit for approval", exact: true })
      .click();
    await expect(
      first.getByText("Change saved. Status refreshed.", { exact: true }),
    ).toBeVisible();
    const second = await login(reviewer);
    await expect(
      second.getByRole("button", { name: "Propose change", exact: true }),
    ).toHaveCount(0);
    const proposal = second
      .locator("article")
      .filter({ hasText: "Pending review" });
    await expect(proposal).toHaveCount(1);
    await proposal
      .getByRole("button", { name: "Review request", exact: true })
      .click();
    await second
      .getByLabel("Your password", { exact: true })
      .fill(reviewer.password);
    await second.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(
      second.getByText("Change saved. Status refreshed.", { exact: true }),
    ).toBeVisible();
    await first.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      first.locator("dl").first().getByText("180", { exact: true }),
    ).toBeVisible();
    await first
      .getByRole("button", { name: "Propose change", exact: true })
      .click();
    await first.keyboard.press("Escape");
    await expect(first.locator("dialog")).toHaveCount(0);
    for (const language of ["en", "ka"])
      for (const theme of ["light", "dark"]) {
        await setConsoleAppearance(first, language, theme);
        await first
          .locator(".console-nav-item[href='/platform/limits']")
          .click();
        for (const width of [360, 390, 768, 1440]) {
          await first.setViewportSize({ width, height: 1000 });
          expect(
            await first.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
        }
        await first.screenshot({
          path: ".local/limits-" + language + "-" + theme + ".png",
        });
      }
    expect(errors).toEqual([]);
    console.log(
      "PASS limits browser: seven logins, technical panel, proposal, independent approval, Escape focus and responsive language/theme matrix",
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
