import { setConsoleAppearance } from "./console-browser";
import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
const expect = baseExpect.configure({ timeout: 30000 });

export async function runUnitsBrowser(app: Express, access: DemoAccess) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const name = "Synthetic browser group";
  let closing = false;
  try {
    for (const [iteration, i] of [2, 4, 3, 2].entries()) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let contextClosing = false;
      await context.addInitScript(() => {
        if (!localStorage.getItem("ertad.console.language"))
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
          if (!closing && !contextClosing) errors.push("API transport failed");
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(origin + "/login");
      await page
        .getByRole("button", {
          name: new RegExp(access.accounts[i].email.replaceAll(".", "\\.")),
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "Workspace", exact: true }),
      ).toBeVisible();
      if (iteration === 0) {
        await expect(
          page.getByRole("link", { name: "Create group", exact: true }),
        ).toBeVisible();
        await page
          .locator("main")
          .screenshot({ path: ".local/group-actions-workspace.png" });
      }
      await page
        .getByRole("link", {
          name:
            iteration === 0
              ? "Create group"
              : i === 3
                ? "Group requests awaiting approval"
                : "Groups and regions",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "Groups and regions", exact: true }),
      ).toBeVisible();
      const existing = page.getByRole("row").filter({ hasText: name });
      if (iteration === 0) {
        await expect(
          page.getByRole("heading", {
            name: "Choose where to create the group",
            exact: true,
          }),
        ).toBeVisible();
        await expect(page.locator("tbody tr")).toHaveCount(2);
        // Region row has a scope-root parent; the group row has a permitted parent name.
        await page
          .getByRole("row")
          .filter({ hasText: "Scope root" })
          .getByRole("button", { name: "Create group here" })
          .click();
        await page.getByLabel("Unit name", { exact: true }).fill(name);
        await page
          .getByLabel("Reason (10–1000 characters)", { exact: true })
          .fill("Synthetic browser creation request");
        await page
          .getByRole("button", { name: "Submit request", exact: true })
          .click();
        await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        await page
          .getByRole("button", { name: "Details", exact: true })
          .first()
          .click();
        await expect(
          page.getByRole("button", { name: "Approve", exact: true }),
        ).toHaveCount(0);
      } else if (i === 4) {
        await expect(page.locator("tbody tr")).toHaveCount(2);
        await page
          .getByRole("button", { name: "Needs my decision", exact: true })
          .click();
        await expect(
          page.getByText("No items in this view.", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(name, { exact: true })).toHaveCount(0);
      } else if (i === 3) {
        await page
          .getByRole("button", { name: "Needs my decision", exact: true })
          .click();
        await page
          .getByRole("row")
          .filter({ hasText: name })
          .getByRole("button", { name: "Details", exact: true })
          .click();
        await page
          .getByLabel("Reason (10–1000 characters)", { exact: true })
          .fill("Synthetic browser independent approval");
        await page
          .getByLabel("I reviewed this change.", { exact: true })
          .check();
        await page
          .getByRole("button", { name: "Approve", exact: true })
          .click();
        await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        await page.reload();
        await expect(
          page.getByRole("row").filter({ hasText: name }),
        ).toHaveCount(1);
      } else {
        await expect(existing).toHaveCount(1);
        // HTTP setup plus four real sessions share the unchanged 120/minute API budget.
        // Start the presentation matrix in a fresh window rather than disabling the limiter.
        console.log('PASS group journey; waiting for the API rate window before presentation checks');
        await new Promise(resolve => setTimeout(resolve, 60_000));
        for (const language of ["ka", "en"])
          for (const theme of ["light", "dark"])
            for (const width of [360, 390, 768, 1440]) {
              await setConsoleAppearance(page, language, theme);
              await expect(existing).toHaveCount(1);
              await page.setViewportSize({ width, height: 1000 });
              await expect(page.locator("html")).toHaveAttribute(
                "data-theme",
                theme,
              );
              expect(
                await page.evaluate(
                  () =>
                    document.documentElement.scrollWidth <= innerWidth &&
                    document.querySelector("main")!.scrollWidth <=
                      document.querySelector("main")!.clientWidth,
                ),
              ).toBe(true);
            }
        await page
          .locator("main")
          .screenshot({ path: ".local/units-browser.png" });
      }
      contextClosing = true;
      await context.close();
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS Chrome hierarchy: create, independent approval, other-region denial, reload, themes/languages and four widths",
    );
  } finally {
    closing = true;
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
