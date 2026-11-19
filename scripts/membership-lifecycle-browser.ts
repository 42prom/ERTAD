import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function runMembershipLifecycleBrowser(
  app: Express,
  access: DemoAccess,
  memberId: string,
  destinationId: string,
  journey: "transfer" | "suspension" = "transfer",
) {
  const suspension = journey === "suspension";
  const reviewPositionName = suspension
    ? "Browser membership role"
    : "Browser destination role";
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  try {
    for (const [phase, account] of [0, 1, 0].entries()) {
      console.log("Membership lifecycle browser phase " + (phase + 1));
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
        page.on("response", (r) => {
          const path = new URL(r.url()).pathname;
          if (
            suspension &&
            path.startsWith("/api/") &&
            r.status() >= 400 &&
            !(path === "/api/v1/admin/auth/me" && r.status() === 401)
          )
            errors.push(`${path}: ${r.status()}`);
        });
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
        if (phase > 0) {
          await page.locator(".console-nav-item[href='/reviews']").click();
          await page
            .getByLabel("Search unit or position", { exact: true })
            .fill(reviewPositionName);
          const row = page
            .getByRole("row")
            .filter({ hasText: reviewPositionName });
          await row
            .getByRole("button", {
              name: "Details: " + reviewPositionName,
              exact: true,
            })
            .click();
          await expect(
            page
              .getByText(
                suspension
                  ? phase === 1
                    ? "Suspend membership"
                    : "Resume membership"
                  : phase === 1
                    ? "Membership transfer"
                    : "End membership",
                { exact: true },
              )
              .last(),
          ).toBeVisible();
          await page
            .getByLabel("Decision reason (10–1000 characters)", { exact: true })
            .fill("Synthetic independent lifecycle browser approval");
          await page
            .getByLabel("I have reviewed the proposed change and its duration.")
            .check();
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().endsWith("/reviews/decision") &&
                r.request().method() === "POST",
            ),
            page.getByRole("button", { name: "Approve", exact: true }).click(),
          ]);
          expect(response.status()).toBe(200);
          await expect(
            page.getByText("Decision saved.", { exact: true }),
          ).toBeVisible();
        }
        if (phase < 2) {
          await page
            .getByRole("link", { name: "Members", exact: true })
            .click();
          if (suspension && phase === 1)
            await page
              .getByLabel("Membership status", { exact: true })
              .selectOption("suspended");
          await page
            .getByLabel("Name or full member code", { exact: true })
            .fill(memberId);
          await page
            .getByRole("button", {
              name: "Synthetic lifecycle member",
              exact: true,
            })
            .click();
          await page
            .getByRole("button", { name: "Manage membership", exact: true })
            .click();
          if (suspension) {
            await page
              .getByLabel("Action", { exact: true })
              .selectOption(phase === 0 ? "suspend" : "resume");
            for (const theme of ["light", "dark"]) {
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
              path: `.local/membership-${phase === 0 ? "suspend" : "resume"}-form.png`,
              fullPage: true,
              animations: "disabled",
            });
          } else if (phase === 0) {
            await page
              .getByLabel("Destination position", { exact: true })
              .selectOption(destinationId);
            const until = new Date(Date.now() + 7 * 86400000);
            until.setMinutes(until.getMinutes() - until.getTimezoneOffset());
            await page
              .getByLabel("New membership valid until", { exact: true })
              .fill(until.toISOString().slice(0, 16));
          } else
            await page
              .getByLabel("Action", { exact: true })
              .selectOption("revoke");
          await page
            .getByLabel("Reason (10–1000 characters)", { exact: true })
            .fill("Synthetic lifecycle browser request");
          await page
            .getByLabel("I confirm the requested change to this membership.")
            .check();
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().endsWith("/reviews/changes") &&
                r.request().method() === "POST",
            ),
            page
              .getByRole("button", { name: "Submit request", exact: true })
              .click(),
          ]);
          expect(response.status()).toBe(200);
          await expect(
            page.getByText(/Request submitted; membership remains unchanged/),
          ).toBeVisible();
        } else {
          await page
            .getByRole("link", { name: "Members", exact: true })
            .click();
          await page
            .getByLabel("Name or full member code", { exact: true })
            .fill(memberId);
          if (!suspension)
            await expect(
              page.getByText("No members match these filters.", {
                exact: true,
              }),
            ).toBeVisible();
          // Historical membership remains discoverable to authorized management.
          if (!suspension)
            await page
              .getByLabel("Membership status", { exact: true })
              .selectOption("ended");
          await page
            .getByRole("button", {
              name: "Synthetic lifecycle member",
              exact: true,
            })
            .click();
          await expect(
            page.getByRole("button", {
              name: "Manage membership",
              exact: true,
            }),
          ).toHaveCount(suspension ? 1 : 0);
          for (const language of ["ka", "en"])
            for (const theme of ["light", "dark"]) {
              const reloads =
                (await page.locator("html").getAttribute("lang")) !== language;
              await setConsoleAppearance(page, language, theme);
              if (reloads) {
                await page.getByLabel(
                  language === "ka" ? "სახელი ან წევრის სრული კოდი" : "Name or full member code",
                  { exact: true },
                ).fill(memberId);
                if (!suspension)
                  await page.getByLabel(
                    language === "ka" ? "წევრობის სტატუსი" : "Membership status",
                    { exact: true },
                  ).selectOption("ended");
                await page.getByRole("button", {
                  name: "Synthetic lifecycle member", exact: true,
                }).click();
              }
              await expect(page.getByText("Synthetic lifecycle member", { exact: true })).toBeVisible();
              await expect(page.getByRole("button", {
                name: language === "ka" ? "განახლება" : "Refresh", exact: true,
              })).toBeEnabled();
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
            path: ".local/membership-lifecycle-browser.png",
            fullPage: true,
            animations: "disabled",
          });
        }
      } catch (e) {
        await page
          .screenshot({
            path: ".local/membership-lifecycle-failure.png",
            fullPage: true,
          })
          .catch(() => {});
        console.error("Membership browser failed", {
          phase: phase + 1,
          errors,
          alerts: await page.getByRole("alert").allTextContents(),
          rows: await page.getByRole("row").allTextContents(),
        });
        throw e;
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      suspension
        ? "PASS Chrome membership suspension, independent approvals, restoration and retained member"
        : "PASS Chrome membership transfer, independent approvals, revocation and retained history",
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
