import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyDecisionInboxBrowser(
  app: Express,
  access: DemoAccess,
  ids: Record<string, string>,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  try {
    for (const index of [3, 4]) {
      console.log(
        `Decision inbox browser account ${index}: pacing unchanged rate window`,
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
        await page.locator(".console-inbox").click();
        await page.getByLabel("Category").selectOption("decision");
        if (index === 3) {
          const row = page.locator(`[data-inbox-id="${ids.referendum}"]`);
          await row.getByRole("button", { name: "Mark as read" }).click();
          await expect(
            row.getByRole("button", { name: "Mark as read" }),
          ).toHaveCount(0);
          await row
            .getByRole("button", { name: "Participate", exact: true })
            .click();
          await expect(
            page.getByRole("heading", {
              name: "Synthetic inbox referendum",
              exact: true,
            }),
          ).toBeVisible();
          expect(new URL(page.url()).pathname).toBe("/decisions");
          expect(page.url()).not.toContain(ids.referendum);
          await page.getByRole("radio", { name: "Yes", exact: true }).check();
          await page.getByRole("checkbox").check();
          await page
            .getByRole("button", { name: "Submit vote", exact: true })
            .click();
          await expect(
            page.getByText("Action saved.", { exact: true }),
          ).toBeVisible();
          await page.locator(".console-inbox").click();
          await page.getByLabel("Category").selectOption("decision");
          await expect(
            page.locator(`[data-inbox-id="${ids.referendum}"]`),
          ).toHaveCount(0);
          await page.getByRole("button", { name: "All", exact: true }).click();
          await expect(
            page.locator(`[data-inbox-id="${ids.referendum}"]`),
          ).toBeVisible();
          // Closed and already-answered records open directly despite the default open filter.
          for (const [kind, title] of [
            ["poll", "Synthetic inbox poll"],
            ["survey", "Synthetic inbox survey"],
            ["election", "Synthetic inbox election"],
          ]) {
            await page
              .locator(`[data-inbox-id="${ids[kind]}"]`)
              .getByRole("button", { name: title, exact: true })
              .click();
            await expect(
              page.getByRole("heading", { name: title, exact: true }),
            ).toBeVisible();
            expect(page.url()).not.toContain(ids[kind]);
            await page.locator(".console-inbox").click();
            await page
              .getByRole("button", { name: "All", exact: true })
              .click();
            await page.getByLabel("Category").selectOption("decision");
          }
          console.log(
            "PASS read versus participation, vote refresh and all four exact Decision links",
          );
          console.log("Decision inbox browser: pacing appearance checks");
          await new Promise((r) => setTimeout(r, 60000));
          for (const language of ["en", "ka"])
            for (const theme of ["light", "dark"]) {
              await setConsoleAppearance(page, language, theme);
              await expect(
                page.locator(`[data-inbox-id="${ids.referendum}"]`),
              ).toBeVisible();
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
                path: `.local/decision-inbox-${language}-${theme}.png`,
                fullPage: true,
              });
            }
          console.log(
            "PASS Decision notices in Georgian/English, light/dark and four viewport widths",
          );
        } else {
          await page.getByRole("button", { name: "All", exact: true }).click();
          for (const id of Object.values(ids))
            await expect(page.locator(`[data-inbox-id="${id}"]`)).toHaveCount(
              0,
            );
          await expect(page.getByRole("alert")).toHaveCount(0);
          console.log("PASS other-region denial of all four notices");
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
