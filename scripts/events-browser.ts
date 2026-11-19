import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyEventsBrowser(app: Express, access: DemoAccess) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const title = "Synthetic browser event",
    task = "Synthetic browser event support";
  try {
    for (const index of [2, 3, 4]) {
      console.log(
        `Events browser account ${index}: pacing unchanged rate window`,
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
        } catch {
          if (!closing) errors.push("Transport " + url.pathname);
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
        await page.getByRole("link", { name: "Events", exact: true }).click();
        if (index === 2) {
          await page
            .getByRole("button", { name: "Create event", exact: true })
            .click();
          await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
          await page.getByLabel("Title", { exact: true }).fill(title);
          await page
            .getByLabel("Description and instructions")
            .fill("Synthetic voluntary gathering with support tasks.");
          const local = (offset: number) =>
            new Date(
              Date.now() + offset - new Date().getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16);
          await page
            .getByLabel("Starts at", { exact: true })
            .fill(local(3600000));
          await page
            .getByLabel("Ends at", { exact: true })
            .fill(local(86400000));
          await page
            .getByLabel("Meeting place (optional)")
            .fill("Synthetic meeting point");
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await expect(
            page.getByRole("heading", { name: title, exact: true }),
          ).toBeVisible();
          for (const language of ["en", "ka"] as const)
            for (const theme of ["light", "dark"] as const) {
              await setConsoleAppearance(page, language, theme);
              await expect(
                page.getByRole("heading", { name: title, exact: true }),
              ).toBeVisible();
              const open = page.getByRole("button", {
                name: language === "ka" ? "ღონისძიების გახსნა" : "Open event",
                exact: true,
              });
              if (await open.count())
                await page
                  .getByRole("heading", { name: title, exact: true })
                  .locator("..")
                  .getByRole("button", {
                    name:
                      language === "ka" ? "ღონისძიების გახსნა" : "Open event",
                    exact: true,
                  })
                  .click();
              await expect(
                page.getByText(
                  language === "ka"
                    ? "ჯილდო ერთხელ თითო წევრზე, პირველი დადასტურებული შესრულებისას. დაკავშირებული დავალებები განმეორებით ქულებს არ იძლევა."
                    : "One award per member on the first verified completion. Linked tasks do not award duplicate points.",
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
                path: `.local/events-${language}-${theme}.png`,
                fullPage: true,
              });
            }
          await setConsoleAppearance(page, "en", "light");
          await expect(
            page.getByRole("heading", { name: title, exact: true }),
          ).toBeVisible();
          if (
            await page
              .getByRole("button", { name: "Open event", exact: true })
              .count()
          ) {
            const card = page
              .getByRole("heading", { name: title, exact: true })
              .locator("..");
            await card
              .getByRole("button", { name: "Open event", exact: true })
              .click();
          }
          console.log('Events browser: pacing after appearance reloads before task creation');
          await new Promise(r=>setTimeout(r,60000));
          await page
            .getByRole("button", { name: "Add task", exact: true })
            .click();
          await page.getByLabel("Title", { exact: true }).fill(task);
          await page
            .getByLabel("Description and instructions")
            .fill("Synthetic practical support instructions.");
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await page.waitForURL((url) => url.pathname === "/tasks");
          await expect(
            page.getByRole("heading", { name: task, exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(/This event awards each member once/),
          ).toBeVisible();
        } else {
          await page.getByLabel("Search events").fill(title);
          const loaded = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === "/api/v1/admin/work/event_list" &&
              new URL(r.url()).searchParams.get("search") === title,
          );
          await page
            .getByRole("button", { name: "Search", exact: true })
            .click();
          const data = await (await loaded).json();
          if (index === 4) {
            expect(data.total).toBe(0);
            await expect(
              page.getByText("No matching events.", { exact: true }),
            ).toBeVisible();
          } else {
            expect(data.total).toBe(1);
            await page
              .getByRole("button", { name: "Open event", exact: true })
              .click();
            await expect(page.getByText(task, { exact: true })).toBeVisible();
            await page
              .getByRole("button", { name: "Open task", exact: true })
              .click();
            await expect(
              page.getByRole("heading", { name: task, exact: true }),
            ).toBeVisible();
          }
        }
        console.log(
          `PASS events browser account ${index}: create/link/navigation or scoped discovery`,
        );
      } catch (error) {
        await page.screenshot({
          path: ".local/events-browser-failure.png",
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
