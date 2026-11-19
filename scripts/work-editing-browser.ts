import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });

export async function verifyWorkEditingBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  try {
    for (let phase = 0; phase < 2; phase++) {
      console.log(
        `Editing browser phase ${phase + 1}: pacing existing rate window`,
      );
      await new Promise((r) => setTimeout(r, 60000));
      const ka = phase === 1,
        language = ka ? "ka" : "en";
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
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (path === "/api/v1/admin/auth/me" && response.status() === 401)
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
              access.accounts[2 + phase].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page.waitForURL((url) => url.pathname !== "/login");
        await page.goto("http://localhost:15173/tasks");
        await page
          .getByRole("button", {
            name: /^Synthetic browser editable task(?: \(\d+\))?$/,
          })
          .click();
        if (ka) {
          await expect(
            page.getByText("Synthetic updated instructions", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText("Synthetic reason for rescheduling", {
              exact: true,
            }),
          ).toBeVisible();
        }
        await page
          .getByRole("button", {
            name: ka ? "დავალების რედაქტირება" : "Edit task",
            exact: true,
          })
          .click();
        await expect(
          page.getByRole("heading", {
            name: ka ? "დავალების რედაქტირება" : "Edit task",
          }),
        ).toBeFocused();
        await page
          .getByLabel(ka ? "აღწერა" : "Description", { exact: true })
          .fill(
            ka
              ? "განახლებული სატესტო ინსტრუქცია"
              : "Synthetic updated instructions",
          );
        await page
          .getByLabel(ka ? "ცვლილების მიზეზი" : "Reason for change", {
            exact: true,
          })
          .fill(ka ? "სატესტო დაზუსტება" : "Synthetic reason for rescheduling");
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
            .locator(".task-page form")
            .screenshot({
              path: `.local/work-editing-${language}-${theme}.png`,
            });
        }
        const saved = page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname.endsWith("/work/edit"),
        );
        await page
          .getByRole("button", {
            name: ka ? "ცვლილებების შენახვა" : "Save changes",
            exact: true,
          })
          .click();
        expect((await saved).status()).toBe(200);
        await expect(
          page.getByText(ka ? "ცვლილება შენახულია." : "Change saved.", {
            exact: true,
          }),
        ).toBeVisible();
        const changes = page.getByText(
          ka ? "ცვლილებების ნახვა" : "View changes",
          { exact: true },
        );
        await expect(changes).toHaveCount(phase + 1);
        await changes.first().click();
        await expect(
          page.getByText(
            ka ? "სატესტო დაზუსტება" : "Synthetic reason for rescheduling",
            { exact: true },
          ),
        ).toBeVisible();
        await page.waitForLoadState("networkidle");
        console.log(
          `PASS editing browser phase ${phase + 1}: persisted correction, history, ${language}, light/dark, responsive widths`,
        );
      } catch (error) {
        await page.screenshot({
          path: ".local/work-editing-browser-failure.png",
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
