import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function runDecisionsBrowser(app: Express, access: DemoAccess) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const title = "Synthetic web decision";
  try {
    for (const [iteration, index] of [2, 4, 3, 2].entries()) {
      if (iteration === 0 || iteration >= 2) {
        console.log(
          "Waiting for unchanged API rate window before browser phase",
        );
        await new Promise((resolve) => setTimeout(resolve, 60000));
      }
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let closing = false;
      await context.addInitScript(() => {
        if (!localStorage.getItem("ertad.console.language"))
          localStorage.setItem("ertad.console.language", "en");
      });
      await context.route("**/api/**", async (route) => {
        try {
          const url = new URL(route.request().url());
          if (!url.pathname.startsWith("/api/")) {
            await route.continue();
            return;
          }
          const response = await route.fetch({
            url: endpoint + url.pathname + url.search,
          });
          await route.fulfill({ response });
        } catch {
          if (!closing) errors.push("API transport failure");
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", (r) => {
        const path = new URL(r.url()).pathname;
        if (path.startsWith("/api/") && r.status() >= 400 && r.status() !== 403 && !(path === "/api/v1/admin/auth/me" && r.status() === 401)) {
          console.error(`Decisions browser HTTP ${r.status()} ${path}`);
          errors.push(`HTTP ${r.status()} ${path}`);
        }
      });
      await page.goto(origin + "/login");
      await page
        .getByRole("button", {
          name: new RegExp(access.accounts[index].email.replaceAll(".", "\\.")),
        })
        .click();
      await expect(page.getByRole('heading',{name:'Workspace',exact:true})).toBeVisible();
      try { await page.getByRole("link", { name: "Polls", exact: true }).click(); }
      catch(error){await page.screenshot({path:'.local/decisions-navigation-failure.png'});console.error('Navigation failure',errors,await page.locator('main').innerText());throw error;}
      await expect(
        page.getByRole("heading", { name: "Polls", exact: true }),
      ).toBeVisible();
      const open = () =>
        page
          .getByRole("button", { name: "Open: " + title, exact: true })
          .click();
      const confirm = () =>
        page
          .getByRole("checkbox", {
            name: "I reviewed the poll rules and deadline and confirm the selected action.",
          })
          .check();
      const saved = () =>
        expect(page.getByText("Action saved.", { exact: true })).toBeVisible();
      if (iteration === 0) {
        await page
          .getByRole("button", { name: "Create", exact: true })
          .click();
        await page.getByLabel("Title", { exact: true }).fill(title);
        await page
          .getByLabel("Description", { exact: true })
          .fill("Synthetic browser poll description");
        await page
          .getByLabel("Audience — region or group", { exact: true })
          .selectOption(access.accounts[2].unitId);
        await page.getByLabel("Option 1", { exact: true }).fill("Option A");
        await page.getByLabel("Option 2", { exact: true }).fill("Option B");
        await page
          .getByRole("button", { name: "Save draft", exact: true })
          .click();
        await saved();
        await open();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await page
          .getByLabel("Description", { exact: true })
          .fill("Updated synthetic browser description");
        await page
          .getByRole("button", { name: "Save draft", exact: true })
          .click();
        await saved();
        await open();
        await expect(
          page.getByText("Updated synthetic browser description", {
            exact: true,
          }),
        ).toBeVisible();
        await confirm();
        await page
          .getByRole("button", { name: "Publish", exact: true })
          .click();
        await saved();
        await open();
        await expect(
          page.getByText(
            "Named poll — responses are stored with the account.",
            { exact: true },
          ),
        ).toBeVisible();
        await page
          .getByRole("radio", { name: "Option A", exact: true })
          .check();
        await confirm();
        await page
          .getByRole("button", { name: "Submit vote", exact: true })
          .click();
        await saved();
        await page.reload();
        await open();
        await expect(
          page.getByText("Your participation is recorded.", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Submit vote", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("heading", { name: "Results", exact: true }),
        ).toHaveCount(0);
      } else if (index === 4) {
        await page.getByLabel("Search polls", { exact: true }).fill(title);
        await expect(
          page.getByRole("heading", {
            name: "No polls in this view",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Open: " + title, exact: true }),
        ).toHaveCount(0);
      } else if (index === 3) {
        await open();
        await page
          .getByRole("radio", { name: "Option B", exact: true })
          .check();
        await confirm();
        await page
          .getByRole("button", { name: "Submit vote", exact: true })
          .click();
        await saved();
        await open();
        await confirm();
        await page
          .getByRole("button", { name: "Close poll", exact: true })
          .click();
        await saved();
        await open();
        await expect(
          page.getByText("Result: tie", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Results", exact: true }),
        ).toBeVisible();
      } else {
        await page.getByRole("button", { name: "Closed", exact: true }).click();
        await open();
        await expect(
          page.getByText("Result: tie", { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: ".local/decisions-results.png" });
        // Detail selection is deliberately local state. Verify list reloads in every visual mode.
        await page.getByRole("button", { name: "Back", exact: true }).click();
        for (const language of ["ka", "en"])
          for (const theme of ["light", "dark"])
            for (const width of [360, 390, 768, 1440]) {
              await setConsoleAppearance(page, language, theme);
              await page.setViewportSize({ width, height: 1000 });
              await expect(
                page.getByRole("heading", { name: title, exact: true }),
              ).toBeVisible();
              expect(
                await page.evaluate(
                  () =>
                    document.documentElement.scrollWidth <= innerWidth &&
                    document.querySelector("main")!.scrollWidth <=
                      document.querySelector("main")!.clientWidth,
                ),
              ).toBe(true);
            }
        await page.screenshot({ path: ".local/decisions-list.png" });
      }
      closing = true;
      await context.close();
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS Chrome decisions: draft/edit/publish, two votes, regional isolation, closed results, reload and responsive themes",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
