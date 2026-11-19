import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyWorkMaterialsBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const title = "Synthetic shared task materials";
  try {
    for (let phase = 0; phase < 3; phase++) {
      console.log(
        `Materials browser phase ${phase + 1}: pacing unchanged rate window`,
      );
      await new Promise((r) => setTimeout(r, 60000));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let loggedIn = false,
        closing = false;
      await context.addInitScript(
        (language) => localStorage.setItem("ertad.console.language", language),
        phase === 1 ? "ka" : "en",
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
      await context.route("https://example.org/**", async (route) => {
        errors.push("Unexpected external fetch");
        await route.abort();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (
          !loggedIn &&
          path === "/api/v1/admin/auth/me" &&
          response.status() === 401
        )
          return;
        if (path === "/api/v1/admin/channels/work" && response.status() === 403)
          return;
        if (path.startsWith("/api/") && response.status() >= 400)
          errors.push(`HTTP ${response.status()} ${path}`);
      });
      try {
        await page.goto("http://localhost:15173/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[[2, 3, 4][phase]].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page.waitForURL((url) => url.pathname !== "/login");
        loggedIn = true;
        await page.goto("http://localhost:15173/tasks");
        if (phase === 0) {
          await page
            .getByRole("button", { name: "New task", exact: true })
            .click();
          await page.getByLabel("Title", { exact: true }).fill(title);
          await page
            .getByLabel("Deadline", { exact: true })
            .fill(
              new Date(
                Date.now() + 86400000 - new Date().getTimezoneOffset() * 60000,
              )
                .toISOString()
                .slice(0, 16),
            );
          await page
            .getByRole("button", { name: "Save task", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Manage links", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Add link", exact: true })
            .click();
          await page.getByLabel("Link title 1").fill("Synthetic meeting guide");
          await page
            .getByLabel("URL 1")
            .fill("https://example.org/meeting-guide");
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
            await page
              .getByRole("region", { name: "Task materials", exact: true })
              .screenshot({
                path: `.local/work-materials-editor-en-${theme}.png`,
              });
          }
          const response = page.waitForResponse(
            (r) =>
              r.request().method() === "POST" &&
              new URL(r.url()).pathname.endsWith("/work/materials"),
          );
          await page
            .getByRole("button", { name: "Save materials", exact: true })
            .click();
          expect((await response).status()).toBe(200);
          await expect(
            page.getByRole("link", { name: /Synthetic meeting guide/ }),
          ).toHaveAttribute("rel", "noopener noreferrer");
        } else if (phase === 1) {
          await page
            .getByRole("button", {
              name: new RegExp("^" + title + "(?: \\(\\d+\\))?$"),
            })
            .click();
          await expect(
            page.getByRole("link", { name: /Synthetic meeting guide/ }),
          ).toHaveAttribute("href", "https://example.org/meeting-guide");
          for (const theme of ["light", "dark"]) {
            await setConsoleAppearance(page, "ka", theme);
            for (const width of [360, 390, 768, 1440]) {
              await page.setViewportSize({ width, height: 1000 });
              expect(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth + 1,
                ),
              ).toBe(true);
            }
            await page
              .getByRole("region", { name: "დავალების მასალები", exact: true })
              .screenshot({
                path: `.local/work-materials-reader-ka-${theme}.png`,
              });
          }
        } else {
          await expect(
            page.getByRole("button", { name: "New task", exact: true }),
          ).toBeVisible();
          await expect(page.getByText("No tasks match this filter.", { exact: true })).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: new RegExp("^" + title + "(?: \\(\\d+\\))?$"),
            }),
          ).toHaveCount(0);
        }
        console.log(`PASS materials browser phase ${phase + 1}`);
      } catch (error) {
        await page.screenshot({
          path: ".local/work-materials-browser-failure.png",
          fullPage: true,
        });
        console.error(errors);
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
