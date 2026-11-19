import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyInboxBrowser(
  app: Express,
  access: DemoAccess,
  ids: { taskId: string; groupId: string; proposalId: string },
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
        `Inbox browser account ${index}: waiting for unchanged rate window`,
      );
      await new Promise((r) => setTimeout(r, 60000));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let closing = false;
      await context.addInitScript(() => {
        if (!localStorage.getItem("ertad.console.language")) {
          localStorage.setItem("ertad.console.language", "en");
        }
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
          if (!closing) errors.push("Inbox transport failure");
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
        await expect(page.locator(".console-inbox")).toBeVisible();
        await page.locator(".console-inbox").click();
        await expect(
          page.getByRole("heading", { name: "Inbox", exact: true }),
        ).toBeVisible();
        if (index === 3) {
          // Reading is independent of approval and opens the current domain record.
          const group = page
            .locator("[data-inbox-id]")
            .filter({ hasText: "Synthetic paginated group" })
            .first();
          const id = await group.getAttribute("data-inbox-id");
          await group.getByRole("button", { name: "Mark as read" }).click();
          await expect(
            page
              .locator(`[data-inbox-id="${id}"]`)
              .getByRole("button", { name: "Mark as read" }),
          ).toHaveCount(0);
          await expect(
            page
              .locator(`[data-inbox-id="${id}"]`)
              .getByRole("button", { name: "Review", exact: true }),
          ).toBeVisible();
          await page.getByRole("button", { name: "All", exact: true }).click();
          await page.getByLabel("Category").selectOption("work");
          await page
            .locator(`[data-inbox-id="${ids.taskId}"]`)
            .getByRole("button", { name: "Synthetic inbox task", exact: true })
            .click();
          await expect(
            page.getByRole("heading", {
              name: "Synthetic inbox task",
              exact: true,
            }),
          ).toBeVisible();
          expect(new URL(page.url()).pathname).toBe("/tasks");
          expect(page.url()).not.toContain(ids.taskId);
          await page.locator(".console-inbox").click();
          await page.getByRole("button", { name: "All", exact: true }).click();
          await page.getByLabel("Category").selectOption("unit");
          await expect(
            page.getByRole("button", { name: "Next", exact: true }),
          ).toBeEnabled();
          await page.getByRole("button", { name: "Next", exact: true }).click();
          await page
            .locator(`[data-inbox-id="${ids.groupId}"]`)
            .getByRole("button", { name: "Synthetic inbox group", exact: true })
            .click();
          await expect(
            page.getByRole("heading", {
              name: "Synthetic inbox group",
              exact: true,
            }),
          ).toBeVisible();
          expect(new URL(page.url()).pathname).toBe("/units");
          await page.locator(".console-inbox").click();
          await page.getByRole("button", { name: "All", exact: true }).click();
          await page.getByLabel("Category").selectOption("collective");
          await page
            .locator(`[data-inbox-id="${ids.proposalId}"]`)
            .getByRole("button", { name: "Directive", exact: true })
            .click();
          await expect(
            page.getByRole("heading", {
              name: /^Directive.*Approved$/,
              exact: true,
            }),
          ).toBeVisible();
          expect(new URL(page.url()).pathname).toBe("/approvals");
          console.log(
            "Inbox browser: three domain links passed; pacing remaining requests",
          );
          await new Promise((r) => setTimeout(r, 60000));
          await page.locator(".console-inbox").click();
          await page.getByRole("button", { name: "All", exact: true }).click();
          await page.getByLabel("Category").selectOption("membership");
          await page
            .locator("[data-inbox-id]")
            .first()
            .getByRole("button", { name: "View", exact: true })
            .click();
          await expect(page.locator(".review-details")).toBeVisible();
          expect(new URL(page.url()).pathname).toBe("/reviews");
          await page.locator(".console-inbox").click();
          await page.getByRole("button", { name: "All", exact: true }).click();
          for (const language of ["en", "ka"])
            for (const theme of ["light", "dark"]) {
              await setConsoleAppearance(page, language, theme);
              await expect(
                page.locator("[data-inbox-id]").first(),
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
            }
          await page.screenshot({
            path: ".local/inbox-ka-dark.png",
            fullPage: true,
          });
        } else {
          await page.getByRole("button", { name: "All", exact: true }).click();
          await page.getByLabel("Category").selectOption("work");
          await expect(page.getByText("No items in this view.")).toBeVisible();
          for (const id of Object.values(ids))
            await expect(page.locator(`[data-inbox-id="${id}"]`)).toHaveCount(
              0,
            );
        }
        console.log(`PASS inbox browser account ${index}`);
      } catch (error) {
        await page
          .screenshot({
            path: ".local/inbox-browser-failure.png",
            fullPage: true,
          })
          .catch(() => {});
        throw error;
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS unified inbox browser: scope, read state, four exact-record links, themes and responsive widths",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
