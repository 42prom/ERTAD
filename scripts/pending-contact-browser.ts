import { chromium, expect as baseExpect } from "@playwright/test";
import type { AddressInfo } from "node:net";
import { createApp } from "../backend/src/app";
import { createLocalAdminRouter } from "../backend/src/localAdmin";
import { setConsoleAppearance } from "./console-browser";
import pino from "pino";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyPendingContactBrowser(ctx: any) {
  const { access, owner } = ctx,
    origin = process.env.ERTAD_BROWSER_WEB_ORIGIN ?? "http://localhost:15173";
  const recipient = await ctx.contact();
  await owner.query(
    "UPDATE organization_member_labels SET display_name='Pending contact browser recipient' WHERE organization_id=$1 AND member_id=$2",
    [access.organizationId, recipient.member],
  );
  const app = createApp(
    {
      postgres: async () => {},
      redis: async () => {},
      storage: async () => {},
    },
    pino({ level: "silent" }),
    origin,
    createLocalAdminRouter(origin, () => access),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  let closing = false;
  try {
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
      try {
        await route.fulfill({
          response: await route.fetch({
            url: endpoint + url.pathname + url.search,
          }),
        });
      } catch {
        if (!closing) errors.push("Test API transport failed");
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on("pageerror", () => errors.push("Browser script error"));
    await page.goto(origin + "/login");
    await page
      .getByLabel("Email", { exact: true })
      .fill(access.accounts[2].email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(access.accounts[2].password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((u) => u.pathname === "/dashboard");
    await page.goto(origin + "/invitations");
    await page
      .getByRole("button", { name: "Add member email", exact: true })
      .click();
    await page
      .getByLabel("Member and unit", { exact: true })
      .selectOption(recipient.unit + ":" + recipient.member);
    await page
      .getByLabel("Member email", { exact: true })
      .fill("wrong-browser@example.test");
    await page
      .getByLabel(
        "The selected member supplied this address and agreed to receive an invitation.",
        { exact: true },
      )
      .check();
    await page
      .getByLabel("Your password", { exact: true })
      .fill(access.accounts[2].password);
    await page
      .getByRole("button", { name: "Save contact", exact: true })
      .click();
    await expect(page.getByText(/Contact saved/)).toBeVisible();
    const old = (
      await owner.query(
        "SELECT id FROM web_invite_contacts WHERE email='wrong-browser@example.test'",
      )
    ).rows[0].id;
    for (const language of ["en", "ka"])
      for (const theme of ["light", "dark"]) {
        await setConsoleAppearance(page, language, theme);
        await page
          .getByLabel(language === "en" ? "Recipient" : "ადრესატი", {
            exact: true,
          })
          .selectOption(old);
        const trigger = page.getByRole("button", {
          name:
            language === "en"
              ? "Revoke recipient contact"
              : "კონტაქტის გაუქმება",
          exact: true,
        });
        await trigger.click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        for (const width of [360, 390, 768, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          ).toBe(true);
          const bounds = await dialog.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          expect(bounds!.height).toBeLessThanOrEqual(851);
        }
        await page.screenshot({
          path: ".local/contact-revocation-" + language + "-" + theme + ".png",
        });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
    await page
      .getByRole("button", { name: "კონტაქტის გაუქმება", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByLabel("თქვენი პაროლი", { exact: true })
      .fill(access.accounts[2].password);
    await dialog
      .getByRole("button", { name: "გაუქმების დადასტურება", exact: true })
      .click();
    await expect(page.getByText(/კონტაქტი გაუქმებულია/)).toBeVisible();
    await expect(
      page
        .getByLabel("ადრესატი", { exact: true })
        .locator('option[value="' + old + '"]'),
    ).toHaveCount(0);
    expect(
      (
        await owner.query(
          "SELECT revoked_at FROM web_invite_contacts WHERE id=$1",
          [old],
        )
      ).rows[0].revoked_at,
    ).not.toBeNull();
    await page
      .getByRole("button", { name: "წევრის ელფოსტის მითითება", exact: true })
      .click();
    await page
      .getByLabel("წევრი და ერთეული", { exact: true })
      .selectOption(recipient.unit + ":" + recipient.member);
    const form = page
      .locator("form")
      .filter({ has: page.getByLabel("წევრი და ერთეული", { exact: true }) });
    await form
      .getByLabel("წევრის ელფოსტა", { exact: true })
      .fill("correct-browser@example.test");
    await form.getByRole("checkbox").check();
    await form
      .getByLabel("თქვენი პაროლი", { exact: true })
      .fill(access.accounts[2].password);
    await form
      .getByRole("button", { name: "კონტაქტის შენახვა", exact: true })
      .click();
    await expect(page.getByText(/კონტაქტი შენახულია/)).toBeVisible();
    const replacement = (
      await owner.query(
        "SELECT id,revoked_at FROM web_invite_contacts WHERE email='correct-browser@example.test'",
      )
    ).rows[0];
    expect(replacement.id).not.toBe(old);
    expect(replacement.revoked_at).toBeNull();
    expect(errors).toEqual([]);
    console.log(
      "PASS pending-contact Chrome: real password/intent, immutable target revocation, corrected contact creation, both languages/themes, Escape/focus and 360/390/768/1440 dialog checks",
    );
  } finally {
    closing = true;
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
