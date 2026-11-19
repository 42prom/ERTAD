import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function runPositionsBrowser(app: Express, access: DemoAccess) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  try {
    for (const [phase, account] of [0, 1, 0, 1].entries()) {
      console.log(`Position browser phase ${phase + 1}`);
      // Respect the unchanged development API budget between complete sessions.
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
      try {
        await page.goto("http://localhost:15173/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[account].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        if (phase % 2 === 0) {
          await page.locator(".console-nav-item[href='/positions']").click();
          if (phase === 0) {
            await page
              .getByRole("button", { name: "New position", exact: true })
              .click();
            await page
              .getByLabel("Unit", { exact: true })
              .selectOption(access.accounts[2].unitId);
          } else {
            await page
              .getByLabel("Search positions")
              .fill("Browser position A");
            await page
              .getByRole("button", { name: "Search", exact: true })
              .click();
            await page
              .getByRole("button", { name: "Propose revision", exact: true })
              .click();
          }
          await page
            .getByLabel("Position name", { exact: true })
            .fill(phase === 0 ? "Browser position A" : "Browser position B");
          await page
            .getByLabel("Reason for change")
            .fill("Browser independently reviewed position definition");
          await page.getByRole("checkbox").check();
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().endsWith("/collective/propose") &&
                r.request().method() === "POST",
            ),
            page
              .getByRole("button", { name: "Submit for approval", exact: true })
              .click(),
          ]);
          expect(response.status()).toBe(200);
          await expect(
            page.getByText(/Proposed changes take effect only after approval/),
          ).toBeVisible();
        } else {
          await page.locator(".console-nav-item[href='/approvals']").click();
          await page.locator("tbody tr").first().getByRole("button").click();
          await expect(
            page.getByText(
              phase === 1 ? "Browser position A" : "Browser position B",
              { exact: true },
            ),
          ).toBeVisible();
          await expect(
            page.getByText("View unit — This unit only", { exact: true }),
          ).toBeVisible();
          await page
            .getByLabel("Review reason")
            .fill("Browser independent permission review");
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().endsWith("/collective/vote") &&
                r.request().method() === "POST",
            ),
            page
              .getByRole("button", { name: "Record decision", exact: true })
              .click(),
          ]);
          expect(response.status()).toBe(200);
          await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
          await page.locator(".console-nav-item[href='/positions']").click();
          await page
            .getByLabel("Search positions")
            .fill(phase === 1 ? "Browser position A" : "Browser position B");
          await page
            .getByRole("button", { name: "Search", exact: true })
            .click();
          await expect(
            page.getByRole("heading", {
              name: phase === 1 ? "Browser position A" : "Browser position B",
              exact: true,
            }),
          ).toBeVisible();
          if (phase === 3) {
            for (const theme of ["light", "dark"] as const) {
              await setConsoleAppearance(page, "en", theme);
              for (const width of [360, 390, 768, 1440]) {
                await page.setViewportSize({ width, height: 1000 });
                expect(
                  await page.evaluate(
                    () =>
                      document.documentElement.scrollWidth <= innerWidth + 1,
                  ),
                ).toBe(true);
              }
            }
            await page.screenshot({
              path: ".local/positions-browser.png",
              fullPage: true,
            });
          }
        }
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS browser position creation, independent approval, revision, approval and responsive catalogue",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
