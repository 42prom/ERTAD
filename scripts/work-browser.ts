import { chromium, expect as baseExpect, type Page } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyWorkBrowser(app: Express, access: DemoAccess) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const root = "Synthetic browser regional initiative",
    child = "Synthetic browser regional delivery";
  async function confirm(
    page: Page,
    action: string,
    fields?: () => Promise<void>,
  ) {
    await page.getByRole("button", { name: action, exact: true }).click();
    if (fields) await fields();
    const response = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/admin/work/") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Confirm action", exact: true })
      .click();
    expect((await response).status()).toBe(200);
    await expect(
      page.getByText("Change saved.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Movement history", exact: true }),
    ).toBeVisible();
  }
  try {
    for (const [phase, index] of [0, 2, 1, 0, 4, 5, 3].entries()) {
      if (phase < 5) {
        console.log(
          `Browser phase ${phase + 1}: waiting for the unchanged API rate window`,
        );
        await new Promise((r) => setTimeout(r, 60000));
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
      try {
        await page.goto(origin + "/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[index].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await expect(
          page.getByRole("heading", { name: "Workspace", exact: true }),
        ).toBeVisible();
        await page.getByRole("link", { name: "Tasks", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "Tasks", exact: true }),
        ).toBeVisible();
        if (phase === 0) {
          await page
            .getByRole("button", { name: "New task", exact: true })
            .click();
          await page
            .getByLabel("Responsible unit", { exact: true })
            .selectOption(access.accounts[0].unitId);
          await page.getByLabel("Title", { exact: true }).fill(root);
          await page.locator('summary').filter({hasText:'Additional options'}).click();
          await page
            .getByLabel("Participant role", { exact: true })
            .fill("Organizer");
          const due = new Date(Date.now() + 7200000);
          due.setSeconds(0, 0);
          const local = new Date(
            due.getTime() - due.getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16);
          await page.getByLabel("Deadline", { exact: true }).fill(local);
          await page
            .getByRole("button", { name: "Save task", exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: root, exact: true }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Delegate", exact: true })
            .click();
          await page
            .getByLabel("Responsible unit", { exact: true })
            .selectOption(access.accounts[2].unitId);
          await page.getByLabel("Title", { exact: true }).fill(child);
          await page
            .getByRole("button", { name: "Save task", exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: child, exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Accept", exact: true }),
          ).toBeVisible();
        } else if (phase === 1) {
          await page
            .getByRole("button", { name: "Offered", exact: true })
            .click();
          await page
            .getByRole("button", { name: new RegExp("^" + child) })
            .click();
          await confirm(page, "Accept");
          await confirm(page, "Volunteer");
          await confirm(page, "Assign");
          await confirm(page, "Start work");
          await confirm(page, "Update progress", async () => {
            await page.getByLabel("Progress (%)", { exact: true }).fill("65");
            await page
              .getByLabel("Note / reason", { exact: true })
              .fill("Synthetic progress report");
          });
          await confirm(page, "Submit completion");
          await expect(
            page.getByRole("button", {
              name: "Verify completion",
              exact: true,
            }),
          ).toHaveCount(0);
        } else if (phase === 2) {
          await page
            .getByRole("button", { name: new RegExp("^" + child) })
            .click();
          await confirm(page, "Verify completion");
          await confirm(page, "Complete task");
        } else if (phase === 3) {
          await page
            .getByRole("button", { name: new RegExp("^" + root) })
            .click();
          await confirm(page, "Complete task");
          for (const lang of ["ka", "en"] as const)
            for (const theme of ["light", "dark"] as const) {
              await setConsoleAppearance(page, lang, theme);
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
          if (index >= 4)
            await expect(
              page.getByRole("button", { name: new RegExp("^" + child) }),
            ).toHaveCount(0);
        }
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS Chrome task create, delegate, accept, volunteer, assign, progress, independent verify, close, six-account navigation and responsive themes",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
