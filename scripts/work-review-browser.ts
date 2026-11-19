import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyWorkReviewBrowser(
  app: Express,
  access: DemoAccess,
  id: string,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const title = "Synthetic browser hierarchy confirmation";
  try {
    for (const index of [3, 0, 2]) {
      console.log(
        `Review browser account ${index}: pacing unchanged rate window`,
      );
      await new Promise((resolve) => setTimeout(resolve, 60000));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let closing = false,
        loggedIn = false;
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
          if (!closing) errors.push("Transport " + url.pathname);
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (r) => {
        const path = new URL(r.url()).pathname;
        if (!loggedIn && path === "/api/v1/admin/auth/me" && r.status() === 401)
          return;
        if (path === "/api/v1/admin/channels/work" && r.status() === 403)
          return; // fixture has no channel grants
        if (path.startsWith("/api/") && r.status() >= 400)
          errors.push(`HTTP ${r.status()} ${path}`);
      });
      try {
        await page.goto("http://localhost:15173/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[index].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page.waitForURL((url) => url.pathname !== "/login");
        loggedIn = true;
        if (index !== 2) {
          const listing = page.waitForResponse(
            (r) => new URL(r.url()).pathname === "/api/v1/admin/inbox",
          );
          await page.goto("http://localhost:15173/inbox");
          const data = await (await listing).json();
          expect(
            data.items.some(
              (item: any) => item.id === id && item.action === "verify",
            ),
          ).toBe(index === 0);
          if (index === 0)
            await page
              .locator(`[data-inbox-id="${id}"]`)
              .getByRole("button", { name: title, exact: true })
              .click();
        }
        if (index !== 0) {
          await page.goto("http://localhost:15173/tasks");
          await page
            .getByRole("button", { name: new RegExp("^" + title) })
            .click();
        }
        await expect(
          page.getByRole("heading", { name: title, exact: true }),
        ).toBeVisible();
        if (index === 3) {
          await expect(
            page.getByText(
              "Confirmed by an independent reviewer in the upper hierarchy",
              { exact: true },
            ),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: "Verify completion",
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("button", {
              name: "Return for changes",
              exact: true,
            }),
          ).toHaveCount(0);
          for (const language of ["en", "ka"] as const)
            for (const theme of ["light", "dark"] as const) {
              await setConsoleAppearance(page, language, theme);
              if (
                !(await page
                  .getByRole("heading", { name: title, exact: true })
                  .count())
              )
                await page
                  .getByRole("button", { name: new RegExp("^" + title) })
                  .click();
              await expect(
                page.getByText(
                  language === "ka"
                    ? "ადასტურებს ზედა იერარქიის დამოუკიდებელი შემმოწმებელი"
                    : "Confirmed by an independent reviewer in the upper hierarchy",
                  { exact: true },
                ),
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
                path: `.local/work-review-${language}-${theme}.png`,
                fullPage: true,
              });
            }
        } else if (index === 0) {
          await page
            .getByRole("button", { name: "Verify completion", exact: true })
            .click();
          const response = page.waitForResponse(
            (r) => new URL(r.url()).pathname === "/api/v1/admin/work/verify",
          );
          await page
            .getByRole("button", { name: "Confirm action", exact: true })
            .click();
          expect((await response).status()).toBe(200);
          await expect(
            page.getByText("Change saved.", { exact: true }),
          ).toBeVisible();
        } else {
          await expect(
            page.getByRole("button", {
              name: "Verify completion",
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(page.getByText(/Verified · 100%/)).toBeVisible();
        }
        console.log(
          `PASS review browser account ${index}: scoped inbox, review controls and completion`,
        );
      } catch (error) {
        if (errors.length) console.error("Review browser requests", errors);
        await page.screenshot({
          path: ".local/work-review-browser-failure.png",
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
