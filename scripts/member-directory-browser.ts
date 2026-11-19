import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyMemberDirectoryBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  try {
    for (let phase = 0; phase < 3; phase++) {
      console.log(
        `Members browser phase ${phase + 1}: pacing existing rate window`,
      );
      await new Promise((r) => setTimeout(r, 60000));
      const ka = phase === 1,
        language = ka ? "ka" : "en",
        account = [2, 0, 4][phase];
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let closing = false;
      await context.addInitScript(
        (value) => localStorage.setItem("ertad.console.language", value),
        language,
      );
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
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (path === "/api/v1/admin/auth/me" && response.status() === 401)
          return;
        if (path.startsWith("/api/") && response.status() >= 400)
          errors.push(`HTTP ${response.status()} ${path}`);
      });
      try {
        await page.goto("http://localhost:15173/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[account].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page.waitForURL((u) => u.pathname !== "/login");
        await page
          .getByRole("link", { name: ka ? "წევრები" : "Members", exact: true })
          .click();
        await page
          .getByLabel(
            ka ? "სახელი ან წევრის სრული კოდი" : "Name or full member code",
            { exact: true },
          )
          .fill(access.accounts[3].memberId);
        if (phase === 2) {
          await expect(
            page.getByText("No members match these filters.", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: access.accounts[3].label,
              exact: true,
            }),
          ).toHaveCount(0);
        } else {
          await page
            .getByRole("button", {
              name: access.accounts[3].label,
              exact: true,
            })
            .click();
          await expect(
            page.getByRole("heading", {
              name: access.accounts[3].label,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByText(
              ka ? "ქულები ხილულ ფარგლებში: 17" : "Points in visible scope: 17",
              { exact: true },
            ),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: "Synthetic directory task",
              exact: true,
            }),
          ).toBeVisible();
          for (const theme of ["light", "dark"]) {
            await setConsoleAppearance(page, language, theme);
            for (const width of [360, 390, 768, 1440]) {
              await page.setViewportSize({ width, height: 1000 });
              expect(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth + 1,
                ),
              ).toBe(true);
            }
            await page
              .locator(".members-page")
              .screenshot({
                path: `.local/members-card-${language}-${theme}.png`,
              });
          }
          if (phase === 0) {
            await page
              .getByRole("button", { name: /^Points and recognition/ })
              .first()
              .click();
            await expect(
              page.getByLabel("Points history", { exact: true }),
            ).toHaveValue(access.accounts[3].memberId);
            await expect(
              page.getByText("17 points", { exact: false }),
            ).toBeVisible();
            expect(new URL(page.url()).search).toBe("");
          } else {
            await page
              .getByRole("button", { name: "პოზიციის შეთავაზება", exact: true })
              .click();
            await expect(
              page.getByLabel("არსებული წევრის კოდი", { exact: true }),
            ).toHaveValue(access.accounts[3].memberId);
            expect(new URL(page.url()).search).toBe("");
          }
        }
        await page.waitForLoadState("networkidle");
        console.log(`PASS members browser phase ${phase + 1}`);
      } catch (error) {
        await page.screenshot({
          path: ".local/members-browser-failure.png",
          fullPage: true,
        });
        throw error;
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
