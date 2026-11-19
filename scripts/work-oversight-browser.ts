import { chromium, expect as baseExpect, type Page } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyWorkOversightBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [],
    title = "Synthetic browser oversight outcomes";
  const date = () => {
    const d = new Date(Date.now() + 3600000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  async function save(page: Page) {
    const response = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/admin/work/") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save oversight change", exact: true })
      .click();
    expect((await response).status()).toBe(200);
    await expect(
      page.getByRole("button", { name: "Save oversight change", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Verified outcomes", exact: true }),
    ).toBeVisible();
  }
  try {
    for (const [phase, index] of [2, 3, 4].entries()) {
      console.log(
        `Oversight browser phase ${phase + 1}: waiting for unchanged rate window`,
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
          if (!closing) errors.push("API transport failed");
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
        if (phase === 0) {
          await page
            .getByRole("button", { name: "New task", exact: true })
            .click();
          await page
            .getByLabel("Responsible unit", { exact: true })
            .selectOption(access.accounts[index].unitId);
          await page.getByLabel("Title", { exact: true }).fill(title);
          await page.locator('summary').filter({hasText:'Additional options'}).click();
          await page
            .getByLabel("Participant role", { exact: true })
            .fill("Organizer");
          await page.getByLabel("Deadline", { exact: true }).fill(date());
          await page
            .getByRole("button", { name: "Save task", exact: true })
            .click();
          await page.locator('summary').filter({hasText:'Criteria and blockers'}).click();
          await page
            .getByRole("button", { name: "Change coordinator", exact: true })
            .click();
          await page
            .getByLabel("Responsible manager", { exact: true })
            .selectOption(access.accounts[3].memberId);
          await save(page);
          await page.locator('summary').filter({hasText:'Criteria and blockers'}).click();
          await page
            .getByRole("button", { name: "Completion criteria", exact: true })
            .click();
          await page
            .getByLabel("Criterion 1", { exact: true })
            .fill("Prepare venue");
          await page
            .getByRole("button", { name: "Add criterion", exact: true })
            .click();
          await page
            .getByLabel("Criterion 2", { exact: true })
            .fill("Deliver event");
          await page.getByLabel("Weight 2", { exact: true }).fill("3");
          await save(page);
          for (const c of ["Prepare venue", "Deliver event"]) {
            await page
              .getByText(c, { exact: true })
              .locator("..")
              .getByRole("button", { name: "Submit result", exact: true })
              .click();
            await page
              .getByLabel("Next action / evidence", { exact: true })
              .fill("Synthetic result evidence");
            await save(page);
          }
          await expect(
            page.getByRole("button", { name: "Verify result", exact: true }),
          ).toHaveCount(0);
          await page
            .getByRole("button", { name: "Report blocker", exact: true })
            .click();
          await page
            .getByLabel("Blocker type", { exact: true })
            .selectOption("resource");
          await page.getByLabel("Next review", { exact: true }).fill(date());
          await page
            .getByLabel("Next action / evidence", { exact: true })
            .fill("Synthetic equipment reconciliation");
          await save(page);
        } else if (phase === 1) {
          console.log("Oversight browser: open blocked task");
          await page
            .getByRole("button", { name: "Blocked", exact: true })
            .click();
          await page
            .getByRole("button", { name: new RegExp("^" + title) })
            .click();
          console.log("Oversight browser: verify outcomes");
          for (const [i, c] of ["Prepare venue", "Deliver event"].entries()) {
            await page
              .getByText(c, { exact: true })
              .locator("..")
              .getByRole("button", { name: "Verify result", exact: true })
              .click();
            await page
              .getByLabel("Next action / evidence", { exact: true })
              .fill("Independent evidence check");
            await save(page);
            await expect(
              page.getByRole("progressbar", {
                name: "Verified progress",
                exact: true,
              }),
            ).toHaveAttribute("value", i === 0 ? "25" : "100");
          }
          await page
            .getByRole("button", { name: "Resolve blocker", exact: true })
            .click();
          await page
            .getByLabel("Next action / evidence", { exact: true })
            .fill("Equipment reconciliation complete");
          await save(page);
          await page
            .getByRole("button", { name: "Complete task", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Confirm action", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: "Complete task", exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("heading", {
              name: "Verified outcomes",
              exact: true,
            }),
          ).toBeVisible();
          console.log("Oversight browser: verify completed appearance");
          for (const lang of ["ka", "en"] as const)
            for (const theme of ["light", "dark"] as const) {
              await setConsoleAppearance(page, lang, theme);
              if (
                !(await page
                  .getByRole("heading", { name: title, exact: true })
                  .isVisible())
              ) {
                console.log(
                  `Oversight browser: reopen completed ${lang} ${theme}`,
                );
                await page
                  .getByRole("button", {
                    name: lang === "ka" ? "დასრულებული" : "Completed",
                    exact: true,
                  })
                  .click();
                await page
                  .getByRole("button", { name: new RegExp("^" + title) })
                  .click();
              }
              await expect(
                page.getByRole("heading", {
                  name:
                    lang === "ka"
                      ? "დადასტურებული შედეგები"
                      : "Verified outcomes",
                  exact: true,
                }),
              ).toBeVisible();
              for (const width of [360, 390, 768, 1440]) {
                await page.setViewportSize({ width, height: 1000 });
                expect(
                  await page.evaluate(
                    () =>
                      document.documentElement.scrollWidth <=
                      window.innerWidth + 1,
                  ),
                ).toBe(true);
              }
            }
        } else {
          await page
            .getByRole("button", { name: "Completed", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: new RegExp("^" + title) }),
          ).toHaveCount(0);
        }
      } catch (error) {
        await page
          .screenshot({
            path: ".local/oversight-browser-error.png",
            fullPage: true,
          })
          .catch(() => {});
        console.log(
          "Oversight browser failed at path",
          new URL(page.url()).pathname,
        );
        throw error;
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS Chrome coordinator, criteria weights, independent outcomes, blockers, scoped queues, completion and responsive themes",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
