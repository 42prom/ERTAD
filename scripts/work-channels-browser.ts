import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyWorkChannelsBrowser(
  app: Express,
  access: DemoAccess,
  _workId: string,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173",
    browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const title = "Synthetic rollback conversation",
    text = "Synthetic task browser message",
    taskButton = /^Synthetic rollback conversation(?: \(\d+\))?$/;
  try {
    for (const index of [2, 3, 4]) {
      console.log(
        `Task channels browser account ${index}: pacing unchanged rate window`,
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
      try {
        await page.goto(origin + "/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[index].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page.getByRole("link", { name: "Tasks", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "Tasks", exact: true }),
        ).toBeVisible();
        if (index === 4) {
          await expect(
            page.getByRole("button", { name: taskButton }),
          ).toHaveCount(0);
          await page.locator('a[href="/channels"]').click();
          await expect(
            page.getByText("No channels in this view."),
          ).toBeVisible();
          console.log(
            "PASS browser sibling region sees neither task nor conversation",
          );
          continue;
        }
        await page.getByRole("button", { name: taskButton }).click();
        const entry = page.getByRole("button", {
          name:
            index === 2 ? "Create task conversation" : "Open task conversation",
          exact: true,
        });
        await expect(entry).toBeVisible();
        await entry.click();
        await expect(
          page.getByRole("heading", { name: title, exact: true }),
        ).toBeVisible();
        if (index === 2) {
          await page.getByLabel("Message", { exact: true }).fill(text);
          await page.getByRole("button", { name: "Send", exact: true }).click();
        }
        await expect(page.getByText(text, { exact: true })).toBeVisible();
        await page
          .getByRole("button", { name: "Back to task", exact: true })
          .click();
        await expect(
          page.getByRole("button", {
            name: "Open task conversation",
            exact: true,
          }),
        ).toBeVisible();
        expect(new URL(page.url()).pathname).toBe("/tasks");
        expect(new URL(page.url()).search).toBe("");
        await page
          .getByRole("button", { name: "Open task conversation", exact: true })
          .click();
        await expect(page.getByText(text, { exact: true })).toBeVisible();
        console.log(
          `PASS browser account ${index}: task conversation and exact-task return`,
        );
        if (index === 3) {
          for (const language of ["en", "ka"])
            for (const theme of ["light", "dark"]) {
              await setConsoleAppearance(page, language, theme);
              const heading = page.getByRole("heading", {
                name: title,
                exact: true,
              });
              if (!(await heading.count()))
                await page
                  .getByRole("button", { name: new RegExp(title) })
                  .click();
              await expect(heading).toBeVisible();
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
                path: `.local/work-channel-${language}-${theme}.png`,
                fullPage: true,
              });
            }
          console.log(
            "PASS browser Georgian/English, light/dark and four widths",
          );
        }
      } catch (e) {
        await page.screenshot({
          path: ".local/work-channel-failure.png",
          fullPage: true,
        });
        throw e;
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
