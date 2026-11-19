import { setConsoleAppearance } from "./console-browser";
import { chromium, expect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { Client } from "pg";
import type { DemoAccess } from "../backend/src/localDemo";

export async function runDemoBrowser(
  app: Express,
  access: DemoAccess,
  owner: Client,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  try {
    for (let i = 0; i < 6; i++) {
      if (i === 3) {
        console.log('PASS first three demo accounts; waiting for the unchanged API rate window');
        await new Promise(resolve => setTimeout(resolve, 60_000));
      }
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let closing = false;
      await context.addInitScript(() => {
        localStorage.getItem("ertad.console.language") ||
          localStorage.setItem("ertad.console.language", "en");
        localStorage.setItem("ertad.console.theme", "dark");
      });
      await context.route("**/api/**", async (route) => {
        try {
          const u = new URL(route.request().url());
          if (!u.pathname.startsWith("/api/")) {
            await route.continue();
            return;
          }
          const response = await route.fetch({
            url: endpoint + u.pathname + u.search,
          });
          await route.fulfill({ response });
        } catch {
          if (!closing) errors.push("Demo browser API transport failed");
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.error("Browser script:", e.message);
      });
      page.on("response", (r) => {
        if (r.status() >= 400)
          console.error("Browser HTTP:", new URL(r.url()).pathname, r.status());
      });
      await page.goto(origin + "/login");
      await expect(
        page.getByRole("heading", { name: "Quick sign-in · Web demo" }),
      ).toBeVisible();
      await expect(page.locator(".demo-account-grid button")).toHaveCount(6);
      if (i === 0) {
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.screenshot({
          path: ".local/web-demo-login.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      await page
        .getByRole("button", {
          name: new RegExp(access.accounts[i].email.replaceAll(".", "\\.")),
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "Workspace", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("ERTAD · ვებ-დემო", { exact: true }),
      ).toBeVisible();
      const units = page.locator(".workspace-units").first();
      await expect(units.locator(":scope > li")).toHaveCount(i < 2 ? 5 : 2);
      if (i >= 2)
        await expect(
          units.getByText(i < 4 ? "რეგიონი B" : "რეგიონი A", { exact: true }),
        ).toHaveCount(0);
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      if (i === 0) {
        for (const language of ["ka", "en"])
          for (const theme of ["light", "dark"]) {
            await setConsoleAppearance(page, language, theme);
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            await expect(
              page.getByRole("heading", {
                name: language === "ka" ? "სამუშაო სივრცე" : "Workspace",
                exact: true,
              }),
            ).toBeVisible();
            await page.setViewportSize({ width: 390, height: 1000 });
            expect(
              await page.evaluate(
                () =>
                  document.documentElement.scrollWidth <= innerWidth &&
                  document.querySelector("main")!.scrollWidth <=
                    document.querySelector("main")!.clientWidth,
              ),
            ).toBe(true);
          }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page
          .locator("main")
          .screenshot({ path: ".local/web-demo-council.png" });
      }
      if (i === 3) {
        await page
          .getByRole("link", { name: "Open requests", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Requests and notifications" }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: /Details/ })
          .first()
          .click();
        await page
          .getByLabel("Decision reason (10–1000 characters)", { exact: true })
          .fill("Synthetic browser regional approval");
        await page
          .getByLabel("I have reviewed the proposed change and its duration.")
          .check();
        await expect(
          page.getByLabel("Confirm with your password", { exact: true }),
        ).toHaveCount(0);
        await page
          .getByRole("button", { name: "Approve", exact: true })
          .click();
        await expect(
          page.getByText("Decision saved.", { exact: true }),
        ).toBeVisible();
        expect(
          Number(
            (
              await owner.query(
                "SELECT count(*) FROM membership_reviews WHERE status='approved'",
              )
            ).rows[0].count,
          ),
        ).toBe(1);
        await page.reload();
        await expect(
          page.getByRole("heading", { name: "Requests and notifications" }),
        ).toBeVisible();
        await page.screenshot({
          path: ".local/web-demo-region.png",
          fullPage: true,
        });
      }
      if (i === 5) {
        await page.getByTitle("Logout").click();
        await expect(page).toHaveURL(/\/login$/);
        await page
          .getByRole("button", {
            name: new RegExp(access.accounts[1].email.replaceAll(".", "\\.")),
          })
          .click();
        await expect(
          page.getByRole("heading", { name: "Workspace", exact: true }),
        ).toBeVisible();
        await expect(
          page.locator(".workspace-units").first().locator(":scope > li"),
        ).toHaveCount(5);
      }
      closing = true;
      await context.close();
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS Chrome: six quick logins, regional isolation, password-free demo approval, reload/logout/account switch, Georgian/English light/dark, 390/1440 widths",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
