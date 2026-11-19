import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30_000 });

export async function runUnitLifecycleBrowser(
  app: Express,
  access: DemoAccess,
  originalName: string,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const renamed = originalName + " renamed";
  try {
    for (const [phase, index] of [2, 3, 2, 3, 2, 3, 2].entries()) {
      console.log("Unit lifecycle browser phase " + (phase + 1));
      if (phase > 0) await new Promise((r) => setTimeout(r, 60_000));
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
          if (!closing) errors.push("API transport failure");
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(origin + "/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[index].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page
          .getByRole("link", { name: "Groups and regions", exact: true })
          .click();
        if (phase === 0 || phase === 2) {
          const row = page
            .getByRole("row")
            .filter({ hasText: phase === 0 ? originalName : renamed });
          await row
            .getByRole("button", {
              name: phase === 0 ? "Rename" : "Archive",
              exact: true,
            })
            .click();
          if (phase === 0)
            await page.getByLabel("Unit name", { exact: true }).fill(renamed);
          else
            await page
              .getByLabel(
                "I understand this unit will be archived after approval.",
                { exact: true },
              )
              .check();
          await page
            .getByLabel(/Reason \(10/)
            .fill("Synthetic browser lifecycle request");
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().endsWith("/units/changes") &&
                r.request().method() === "POST",
            ),
            page
              .getByRole("button", { name: "Submit request", exact: true })
              .click(),
          ]);
          expect(response.status()).toBe(200);
          await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        } else if (phase === 1 || phase === 3 || phase === 5) {
          await page
            .getByRole("button", { name: "Needs my decision", exact: true })
            .click();
          await page
            .getByRole("row")
            .filter({ hasText: renamed })
            .getByRole("button", { name: "Details", exact: true })
            .click();
          await expect(
            page
              .getByText(phase === 1 ? originalName : renamed, { exact: true })
              .last(),
          ).toBeVisible();
          await page
            .getByLabel(/Reason \(10/)
            .fill("Synthetic independent lifecycle approval");
          await page
            .getByLabel("I reviewed this change.", { exact: true })
            .check();
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().endsWith("/units/decision") &&
                r.request().method() === "POST",
            ),
            page.getByRole("button", { name: "Approve", exact: true }).click(),
          ]);
          expect(response.status()).toBe(200);
          await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        } else if (phase === 4) {
          await expect(
            page.getByRole("row").filter({ hasText: renamed }),
          ).toHaveCount(0);
          for (const language of ["ka", "en"])
            for (const theme of ["light", "dark"]) {
              await setConsoleAppearance(page, language, theme);
              await page
                .getByLabel(
                  language === "ka" ? "ერთეულის სტატუსი" : "Unit status",
                  { exact: true },
                )
                .selectOption("archived");
              await expect(
                page.getByRole("row").filter({ hasText: renamed }),
              ).toHaveCount(1);
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
          await expect(
            page.getByRole("button", { name: "Archive", exact: true }),
          ).toHaveCount(0);
          await page
            .locator("main")
            .screenshot({ path: ".local/unit-lifecycle-archive.png" });
          await page
            .getByRole("row")
            .filter({ hasText: renamed })
            .getByRole("button", { name: "Restore", exact: true })
            .click();
          await page
            .getByLabel(
              "I understand this unit will become active after approval.",
              { exact: true },
            )
            .check();
          await page
            .getByLabel(/Reason \(10/)
            .fill("Synthetic browser restoration request");
          const [response] = await Promise.all([
            page.waitForResponse(
              (r) =>
                r.url().endsWith("/units/changes") &&
                r.request().method() === "POST",
            ),
            page
              .getByRole("button", { name: "Submit request", exact: true })
              .click(),
          ]);
          expect(response.status()).toBe(200);
          await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        } else {
          await expect(
            page.getByRole("row").filter({ hasText: renamed }),
          ).toHaveCount(1);
          await page
            .getByLabel("Unit status", { exact: true })
            .selectOption("archived");
          await expect(
            page.getByRole("row").filter({ hasText: renamed }),
          ).toHaveCount(0);
        }
      } catch (e) {
        console.error("Lifecycle browser failed", {
          phase: phase + 1,
          errors,
          alerts: await page.getByRole("alert").allTextContents(),
        });
        await page
          .screenshot({
            path: ".local/unit-lifecycle-browser-failure.png",
            fullPage: true,
          })
          .catch(() => {});
        throw e;
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS Chrome unit lifecycle: rename, independent approvals, explicit archive/restoration, archived list, both languages/themes and four widths",
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
