import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyWorkRecognitionBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const title = "Synthetic browser verified bonus",
    reason = "Synthetic extra transport assistance";
  let proposal = "";
  try {
    for (const index of [0, 2, 3, 4]) {
      console.log(
        `Recognition browser account ${index}: pacing unchanged rate window`,
      );
      await new Promise((r) => setTimeout(r, 60000));
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
        } catch (error) {
          if (!closing)
            errors.push("Transport " + url.pathname + ": " + String(error));
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", (r) => {
        const path = new URL(r.url()).pathname;
        if (!loggedIn && path === "/api/v1/admin/auth/me" && r.status() === 401)
          return;
        if (path === "/api/v1/admin/channels/work" && r.status() === 403)
          return;
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
        await page.waitForLoadState("networkidle");
        if (index === 0) {
          await page.goto("http://localhost:15173/tasks");
          await page
            .getByRole("button", { name: new RegExp("^" + title) })
            .click();
          await expect(page.getByLabel("Verified participant")).toBeVisible();
          for (const language of ["en", "ka"] as const) {
            if (language === "ka")
              await new Promise((r) => setTimeout(r, 60000));
            for (const theme of ["light", "dark"] as const) {
              await page.waitForLoadState("networkidle");
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
                page.getByLabel(
                  language === "ka"
                    ? "დადასტურებული მონაწილე"
                    : "Verified participant",
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
              await page
                .getByRole("region", {
                  name:
                    language === "ka"
                      ? "პირადი ბონუსი"
                      : "Additional recognition",
                })
                .screenshot({
                  path: `.local/recognition-${language}-${theme}.png`,
                });
            }
          }
          await new Promise((r) => setTimeout(r, 60000));
          await setConsoleAppearance(page, "en", "light");
          if (
            !(await page
              .getByRole("heading", { name: title, exact: true })
              .count())
          )
            await page
              .getByRole("button", { name: new RegExp("^" + title) })
              .click();
          await page
            .getByLabel("Verified participant")
            .selectOption({ index: 1 });
          await page.getByLabel("Bonus points").fill("5");
          await page.getByLabel("Reason for bonus").fill(reason);
          const response = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === "/api/v1/admin/collective/propose",
          );
          await page
            .getByRole("button", { name: "Propose bonus", exact: true })
            .click();
          const saved = await response;
          expect(saved.status()).toBe(200);
          proposal = (await saved.json()).id;
          await expect(page.getByText(/Bonus awaiting approval/)).toBeVisible();
        } else if (index === 2) {
          await page.goto("http://localhost:15173/approvals");
          await page.locator(`[data-proposal-id="${proposal}"] button`).click();
          await expect(
            page.getByText("Verified task: " + title, { exact: true }),
          ).toBeVisible();
          await page
            .getByLabel("Review reason", { exact: true })
            .fill("Independent browser bonus review");
          const response = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === "/api/v1/admin/collective/vote",
          );
          await page
            .getByRole("button", { name: "Record decision", exact: true })
            .click();
          expect((await response).status()).toBe(200);
          await expect(
            page.getByRole("heading", { name: /Approved/ }),
          ).toBeVisible();
        } else if (index === 3) {
          await page.goto("http://localhost:15173/contribution");
          await expect(page.getByText(reason, { exact: true })).toBeVisible();
          await expect(
            page.getByText("Verified task: " + title, { exact: true }),
          ).toBeVisible();
          await page.waitForLoadState("networkidle");
          await page.goto("http://localhost:15173/tasks");
          await page
            .getByRole("button", { name: new RegExp("^" + title) })
            .click();
          await expect(
            page.getByText(/No verified participant is currently available/),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Propose bonus", exact: true }),
          ).toHaveCount(0);
        } else {
          await page.goto("http://localhost:15173/tasks");
          await page.getByLabel("Search tasks").fill(title);
          const loaded = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === "/api/v1/admin/work/list" &&
              new URL(r.url()).searchParams.get("search") === title,
          );
          await page
            .getByRole("button", { name: "Search", exact: true })
            .click();
          expect((await (await loaded).json()).total).toBe(0);
          await expect(
            page.getByRole("button", { name: new RegExp("^" + title) }),
          ).toHaveCount(0);
        }
        console.log(
          `PASS recognition browser account ${index}: scoped source, proposal, approval or private history`,
        );
      } catch (error) {
        await page.screenshot({
          path: ".local/recognition-browser-failure.png",
          fullPage: true,
        });
        if (errors.length) console.error(errors);
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
