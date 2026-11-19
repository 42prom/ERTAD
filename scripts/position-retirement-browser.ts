import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });

export async function runPositionRetirementBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  let proposalId = "";
  try {
    for (const account of [0, 1]) {
      console.log(`Retirement browser account ${account + 1}`);
      // Keep the existing API budget; fixtures and each complete session share it.
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
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith("/api/")) return route.continue();
        try {
          const response = await route.fetch({
            url: endpoint + url.pathname + url.search,
          });
          if (
            response.status() >= 400 &&
            !(
              url.pathname === "/api/v1/admin/auth/me" &&
              response.status() === 401
            )
          )
            errors.push(
              `${route.request().method()} ${url.pathname}: ${response.status()}`,
            );
          await route.fulfill({ response });
        } catch {
          if (!closing) errors.push("Transport failure");
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto("http://localhost:15173/login", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[account].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        if (account === 0) {
          await page.locator(".console-nav-item[href='/positions']").click();
          await page
            .getByLabel("Search positions")
            .fill("Retirement browser position");
          await page
            .getByRole("button", { name: "Search", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Retire position", exact: true })
            .click();
          await expect(
            page.getByRole("button", {
              name: "Submit retirement request",
              exact: true,
            }),
          ).toBeDisabled();
          for (const theme of ["light", "dark"] as const) {
            await setConsoleAppearance(page, "en", theme);
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
            path: ".local/retirement-form.png",
            fullPage: true,
          });
          await page
            .getByLabel("Reason for retirement")
            .fill("Browser independently reviewed retirement");
          await page.getByRole("checkbox").check();
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().endsWith("/collective/propose") &&
                r.request().method() === "POST",
            ),
            page
              .getByRole("button", {
                name: "Submit retirement request",
                exact: true,
              })
              .click(),
          ]);
          expect(response.status()).toBe(200);
          const body = await response.json();
          proposalId = body.id;
          expect(proposalId).toBeTruthy();
          await expect(
            page.getByText(/Proposed changes take effect only after approval/),
          ).toBeVisible();
        } else {
          await page.locator(".console-nav-item[href='/approvals']").click();
          await page
            .locator(`tr[data-proposal-id='${proposalId}']`)
            .getByRole("button")
            .click();
          await expect(
            page.getByText("Retirement browser position", { exact: true }),
          ).toBeVisible();
          await page
            .getByLabel("Review reason")
            .fill("Browser independent retirement approval");
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
            .fill("Retirement browser position");
          await page
            .getByRole("button", { name: "Search", exact: true })
            .click();
          await expect(
            page.getByRole("heading", {
              name: "Retirement browser position",
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.getByText(/Version 1 · Retired/)).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Retire position", exact: true }),
          ).toHaveCount(0);
          await page.screenshot({
            path: ".local/retirement-result.png",
            fullPage: true,
          });
          await setConsoleAppearance(page, "ka", "dark");
          await page
            .getByLabel("პოზიციის ძიება")
            .fill("Retirement browser position");
          await page
            .getByRole("button", { name: "ძებნა", exact: true })
            .click();
          await expect(page.getByText(/ვერსია 1 · გაუქმებული/)).toBeVisible();
          for (const width of [360, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
              ),
            ).toBe(true);
          }
        }
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS browser retirement request, independent approval, retired catalogue and responsive form",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
