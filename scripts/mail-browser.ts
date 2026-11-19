import { chromium, expect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import { setConsoleAppearance } from "./console-browser";
export async function verifyMailBrowser(
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
      await page.locator(".console-nav-item[href='/platform/email']").click();
      await expect(
        page.getByRole("heading", { name: "Email service", exact: true }),
      ).toBeVisible();
      return page;
    }

    const first = await login(operator);
    await first
      .getByRole("button", { name: "Change email settings", exact: true })
      .click();
    await first
      .getByLabel("Provider", { exact: true })
      .selectOption("sendgrid");
    await first.getByLabel("Sender name", { exact: true }).fill("ERTAD test");
    await first
      .getByLabel("Sender email", { exact: true })
      .fill("sender@example.invalid");
    await first.getByLabel(/New API key/).fill("SG.synthetic-browser-key");
    await first.getByLabel("Mode", { exact: true }).selectOption("enabled");
    await first
      .getByLabel("Your password", { exact: true })
      .fill(operator.password);
    await first.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(
      first.getByText("Change submitted for independent approval.", {
        exact: true,
      }),
    ).toBeVisible();
    const second = await login(reviewer);
    await expect(
      second.getByRole("button", {
        name: "Change email settings",
        exact: true,
      }),
    ).toHaveCount(0);
    const proposal = second.locator("article").filter({ hasText: "Pending" });
    await expect(proposal).toHaveCount(1);
    await proposal
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await expect(
      second.locator("dialog").getByText("SendGrid", { exact: true }),
    ).toBeVisible();
    await second
      .getByLabel("Your password", { exact: true })
      .fill(reviewer.password);
    await second.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(
      second.getByText("Review completed.", { exact: true }),
    ).toBeVisible();
    await first
      .getByRole("button", { name: "Refresh email settings", exact: true })
      .click();
    await expect(
      first.locator("dl").first().getByText("SendGrid", { exact: true }),
    ).toBeVisible();
    await expect(
      first.locator("dl").first().getByText("Enabled", { exact: true }),
    ).toBeVisible();
    await first
      .getByRole("button", { name: "Change email settings", exact: true })
      .click();
    await expect(first.getByLabel(/New API key/)).toHaveValue("");
    await first.keyboard.press("Escape");
    await expect(first.locator("dialog")).toHaveCount(0);
    await expect(
      first.getByRole("button", { name: "Change email settings", exact: true }),
    ).toBeFocused();
    for (const language of ["en", "ka"])
      for (const theme of ["light", "dark"]) {
        await setConsoleAppearance(first, language, theme);
        await first
          .locator(".console-nav-item[href='/platform/email']")
          .click();
        await first
          .getByRole("button", {
            name:
              language === "en"
                ? "Change email settings"
                : "პარამეტრების შეცვლა",
            exact: true,
          })
          .click();
        for (const width of [360, 390, 768, 1440]) {
          await first.setViewportSize({ width, height: 1000 });
          expect(
            await first.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
          expect(
            await first
              .locator("dialog")
              .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          ).toBe(true);
          const box=await first.locator('dialog').boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThan(0);
          expect(box!.x+box!.width).toBeLessThanOrEqual(width);
          expect(box!.height).toBeLessThanOrEqual(851);
        }
        await first.screenshot({
          path: ".local/mail-" + language + "-" + theme + ".png",
        });
        await first.keyboard.press("Escape");
      }
    expect(errors).toEqual([]);
    console.log(
      "PASS email browser: sender/key proposal, independent approval, masked credential, Escape/focus and language/theme/viewport matrix",
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
