import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyChannelsBrowser(app: Express, access: DemoAccess) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const title = "Synthetic browser channel",
    message = "Synthetic conversation <img src=x onerror=alert(1)>";
  try {
    for (const index of [2, 3, 0, 4]) {
      console.log(
        `Channels browser account ${index}: pacing unchanged rate window`,
      );
      await new Promise((r) => setTimeout(r, 60000));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let closing = false;
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
          if (!closing) errors.push("Transport failure");
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", (r) => {
        if (r.status() >= 400 && new URL(r.url()).pathname.startsWith("/api/"))
          console.log("Browser HTTP", r.status(), new URL(r.url()).pathname);
      });
      try {
        await page.goto(origin + "/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[index].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page.locator('a[href="/channels"]').click();
        await expect(
          page.getByRole("heading", { name: "Group channels", exact: true }),
        ).toBeVisible();
        if (index === 2) {
          await page
            .getByRole("button", { name: "New channel", exact: true })
            .click();
          await page
            .getByLabel("Group or region")
            .selectOption(access.accounts[2].unitId);
          await page.getByLabel("Channel name").fill(title);
          await page
            .getByRole("button", { name: "Create", exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: title, exact: true }),
          ).toBeVisible();
          await page.getByLabel("Message", { exact: true }).fill(message);
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await expect(page.getByText(message, { exact: true })).toBeVisible();
          await expect(page.locator("[data-message-id] img")).toHaveCount(0);
          await page
            .getByRole("button", { name: "Archive channel", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Confirm", exact: true })
            .click();
          await expect(
            page.getByText("Archived channel. New messages are disabled."),
          ).toBeVisible();
          await expect(page.getByLabel("Message", { exact: true })).toHaveCount(
            0,
          );
          await page
            .getByRole("button", { name: "Reopen channel", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Confirm", exact: true })
            .click();
          await expect(
            page.getByLabel("Message", { exact: true }),
          ).toBeVisible();
          console.log(
            "PASS browser create, send, HTML escaping, archive and reopen",
          );
        } else if (index === 3) {
          await page.getByRole("button", { name: new RegExp(title) }).click();
          await expect(page.getByText(message, { exact: true })).toBeVisible();
          await page
            .getByRole("button", { name: "Reply", exact: true })
            .click();
          await page
            .getByLabel("Message", { exact: true })
            .fill("Synthetic reply from a second member");
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await expect(
            page.getByText("Synthetic reply from a second member", {
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByText("Reply to message #1", { exact: true }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Mark displayed messages read" })
            .click();
          await page.getByRole("button", { name: "Mute", exact: true }).click();
          await expect(
            page.getByRole("button", { name: "Unmute", exact: true }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Unmute", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Report", exact: true })
            .click();
          await page.getByLabel("Category").selectOption("privacy");
          await page
            .getByRole("button", { name: "Confirm", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Moderation", exact: true })
            .click();
          await expect(
            page.getByText("No reports eligible for independent review."),
          ).toBeVisible();
          console.log(
            "PASS browser reply, read, mute and reporter independence",
          );
        } else if (index === 0) {
          await page.getByRole("button", { name: new RegExp(title) }).click();
          await page.getByRole("button", { name: /^Moderation/ }).click();
          await page
            .getByRole("button", {
              name: "Remove reported message",
              exact: true,
            })
            .click();
          await page
            .getByRole("button", { name: "Confirm", exact: true })
            .click();
          await expect(
            page.getByText("Message removed.", { exact: true }),
          ).toBeVisible();
          await expect(page.getByText(message, { exact: true })).toHaveCount(0);
          await expect(
            page.getByText("Synthetic reply from a second member", {
              exact: true,
            }),
          ).toBeVisible();
          for (const language of ["en", "ka"])
            for (const theme of ["light", "dark"]) {
              await setConsoleAppearance(page, language, theme);
              const heading = page.getByRole("heading", {
                name: title,
                exact: true,
              });
              if (!(await heading.count()))
                await page
                  .getByRole("button", { name: new RegExp(title) })
                  .click();
              await expect(heading).toBeVisible();
              for (const width of [360, 390, 768, 1440]) {
                await page.setViewportSize({ width, height: 1000 });
                expect(
                  await page.evaluate(
                    () =>
                      document.documentElement.scrollWidth <= innerWidth + 1,
                  ),
                ).toBe(true);
              }
              await page.screenshot({
                path: `.local/channels-${language}-${theme}.png`,
                fullPage: true,
              });
            }
          expect(new URL(page.url()).search).toBe("");
          console.log(
            "PASS browser independent moderation, both languages/themes and four widths",
          );
        } else {
          await expect(
            page.getByText("No channels in this view."),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: new RegExp(title) }),
          ).toHaveCount(0);
          await page
            .getByRole("button", { name: "New channel", exact: true })
            .click();
          const options = await page
            .getByLabel("Group or region")
            .locator("option")
            .allTextContents();
          expect(options.length).toBe(2);
          console.log(
            "PASS browser second-region isolation and scoped creation choices",
          );
        }
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
