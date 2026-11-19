import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function runPositionRolloutBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  try {
    for (const account of [0, 1]) {
      console.log("Position rollout browser phase " + (account + 1));
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
        const path = new URL(r.url()).pathname;
        if (
          path.startsWith("/api/") &&
          r.status() >= 400 &&
          !(path === "/api/v1/admin/auth/me" && r.status() === 401)
        )
          errors.push(`${path}: ${r.status()}`);
      });
      async function openRollout(language = "en") {
        if (!new URL(page.url()).pathname.startsWith("/positions"))
          await page.locator(".console-nav-item[href='/positions']").click();
        await page
          .getByLabel(
            language === "en" ? "Search positions" : "პოზიციის ძიება",
            { exact: true },
          )
          .fill("Browser adopted position");
        await page
          .getByRole("button", {
            name: language === "en" ? "Search" : "ძებნა",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", {
            name:
              language === "en"
                ? "Adopt revision / progress"
                : "წევრების გადაყვანა / მიმდინარეობა",
            exact: true,
          })
          .click();
        await expect(page.getByLabel("Browser first member")).toBeVisible();
      }
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
          await openRollout();
          await expect(
            page.getByRole("region", { name: "Permission comparison" }),
          ).toBeVisible();
          for (const theme of ["light", "dark"]) {
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
          await page.getByLabel("Browser first member").check();
          await page.getByLabel("Browser second member").check();
          await page
            .getByLabel("Reason (10–1000 characters)")
            .fill("Synthetic browser revision adoption");
          await page
            .getByLabel(
              "I reviewed the permissions and confirm the selected membership requests.",
            )
            .check();
          await page
            .getByRole("heading", {
              name: "Adopt position revision",
              exact: true,
            })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: ".local/position-rollout-comparison.png",
            fullPage: true,
            animations: "disabled",
          });
          await page.screenshot({
            path: ".local/position-rollout-form.png",
            fullPage: true,
            animations: "disabled",
          });
          await page
            .getByRole("button", { name: "Submit requests (2)", exact: true })
            .click();
          await expect(
            page
              .getByRole("status")
              .filter({ hasText: "Confirmed saved requests" }),
          ).toContainText("2");
          await expect(
            page.getByText("Pending approval", { exact: true }),
          ).toHaveCount(2);
        } else {
          await page.locator(".console-nav-item[href='/reviews']").click();
          await page
            .getByLabel("Search unit or position", { exact: true })
            .fill("Browser adopted position");
          for (let n = 0; n < 2; n++) {
            await page
              .getByRole("button", {
                name: "Details: Browser adopted position",
                exact: true,
              })
              .first()
              .click();
            await expect(
              page.getByRole("region", { name: "Permission comparison" }),
            ).toBeVisible();
            await expect(
              page.getByText("No expiry — unchanged", { exact: true }),
            ).toBeVisible();
            await page
              .getByLabel("Decision reason (10–1000 characters)", {
                exact: true,
              })
              .fill("Synthetic independent adoption approval");
            await page
              .getByLabel(
                "I have reviewed the proposed change and its duration.",
              )
              .check();
            const [response] = await Promise.all([
              page.waitForResponse(
                (r) =>
                  r.url().endsWith("/reviews/decision") &&
                  r.request().method() === "POST",
              ),
              page
                .getByRole("button", { name: "Approve", exact: true })
                .click(),
            ]);
            expect(response.status()).toBe(200);
            await expect(
              page.getByText("Decision saved.", { exact: true }),
            ).toBeVisible();
          }
          await openRollout();
          await expect(page.getByText("Approved", { exact: true })).toHaveCount(
            2,
          );
          for (const language of ["ka", "en"])
            for (const theme of ["light", "dark"]) {
              const reload =
                (await page.locator("html").getAttribute("lang")) !== language;
              // Each locale reload repeats the complete route/access bootstrap.
              // Respect the real per-peer rate window; never raise the product limit for tests.
              if (reload) {
                console.log(
                  "Waiting for rate window before locale " + language,
                );
                await new Promise((r) => setTimeout(r, 60000));
              }
              await setConsoleAppearance(page, language, theme);
              if (reload) await openRollout(language);
              await expect(
                page.getByText(
                  language === "ka" ? "დამტკიცებული" : "Approved",
                  { exact: true },
                ),
              ).toHaveCount(2);
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
            path: ".local/position-rollout-progress.png",
            fullPage: true,
            animations: "disabled",
          });
        }
      } catch (e) {
        await page
          .screenshot({
            path: ".local/position-rollout-failure.png",
            fullPage: true,
            animations: "disabled",
          })
          .catch(() => {});
        console.error("Rollout browser failure", {
          account,
          errors,
          alerts: await page.getByRole("alert").allTextContents(),
        });
        throw e;
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS Chrome two-member rollout, separate approvals and persisted progress; both languages/themes and four widths",
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
