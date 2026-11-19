import { chromium, expect as baseExpect, type Page } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });

export async function verifyOperationsBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  let funding = "",
    rule = "";
  const title = "Synthetic browser operations task";
  async function post(page: Page, name: string, operation: string) {
    const button = page.getByRole("button", { name, exact: true });
    const invalid = await button.evaluate((element) => {
      const form = (element as HTMLButtonElement).form;
      return form ? Array.from(form.elements)
        .filter((field): field is HTMLInputElement => field instanceof HTMLInputElement)
        .filter((field) => !field.checkValidity())
        .map((field) => ({ id: field.id, message: field.validationMessage })) : [];
    });
    expect(invalid, "Synthetic operation form must be valid before submission").toEqual([]);
    const [r] = await Promise.all([page.waitForResponse(
      (r) =>
        r.url().endsWith("/" + operation) && r.request().method() === "POST",
    ), button.click()]);
    expect(r.status()).toBe(200);
    return r.json();
  }
  async function layout(page: Page) {
    for (const theme of ["light", "dark"]) {
      await setConsoleAppearance(page, "en", theme);
      for (const width of [360, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
      }
    }
  }
  try {
    for (const [phase, index] of [2, 3, 0, 1].entries()) {
      console.log(`Operations browser phase ${phase + 1}`);
      // This suite owns a fresh app. Only successive actors share its rate window.
      if (phase > 0) await new Promise((r) => setTimeout(r, 60000));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let closing = false;
      await context.addInitScript(() =>
        localStorage.setItem("ertad.console.language", "en"),
      );
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
          if (!closing) errors.push("API transport failure");
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      const failedResponses: { path: string; status: number }[] = [];
      const requestCounts: Record<string, number> = {};
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/")) requestCounts[path] = (requestCounts[path] ?? 0) + 1;
      });
      page.on("response", (response) => {
        if (response.status() >= 400) failedResponses.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
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
        await expect(
          page.getByRole("link", { name: "Tasks", exact: true }),
        ).toBeVisible();
        if (phase === 0) {
          await page.getByRole("link", { name: "Tasks", exact: true }).click();
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
          const d = new Date(Date.now() + 3600000);
          await page
            .getByLabel("Deadline", { exact: true })
            .fill(
              new Date(d.getTime() - d.getTimezoneOffset() * 60000)
                .toISOString()
                .slice(0, 16),
            );
          await post(page, "Save task", "create");
          await page.locator('summary').filter({hasText:'Additional roles and resources'}).click();
          await page
            .getByRole("button", { name: "Add need", exact: true })
            .click();
          await page
            .getByLabel("Name", { exact: true })
            .fill("Synthetic browser equipment");
          await page
            .getByLabel("Need type", { exact: true })
            .selectOption("resource");
          await page.getByLabel("Quantity", { exact: true }).fill("2");
          await page
            .getByLabel("Measurement unit", { exact: true })
            .fill("items");
          await post(page, "Save need change", "need_create");
          await expect(
            page.getByRole("heading", { name: /Synthetic browser equipment/ }),
          ).toBeVisible();
          await page.locator('summary').filter({hasText:'Funding (when needed)'}).click();
          await page
            .getByRole("button", { name: "Propose budget", exact: true })
            .click();
          await page.getByLabel("Amount (GEL)", { exact: true }).fill("250");
          await page
            .getByLabel("Funding reason", { exact: true })
            .fill("Synthetic browser reviewed funding");
          funding = (await post(page, "Submit funding proposal", "propose")).id;
          await expect(
            page.getByText("No approved funding target yet.", { exact: true }),
          ).toBeVisible();
          await layout(page);
        } else if (phase === 1) {
          await page.getByRole("link", { name: "Approvals", exact: true }).click();
          await page.locator(`[data-proposal-id="${funding}"] button`).click();
          await page
            .getByLabel("Review reason", { exact: true })
            .fill("Independent synthetic budget review");
          await post(page, "Record decision", "vote");
          await expect(
            page.getByRole("heading", {
              name: "Funding target · Approved",
              exact: true,
            }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Mark as read", exact: true })
            .click();
          await page.getByRole("link", { name: "Tasks", exact: true }).click();
          await page
            .getByRole("button", { name: new RegExp("^" + title) })
            .click();
          await page.locator('summary').filter({hasText:'Funding (when needed)'}).click();
          await expect(
            page.getByText("Funding goal: 250.00 GEL", { exact: true }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Pledge funding", exact: true })
            .click();
          await page.getByLabel("Amount (GEL)", { exact: true }).fill("25");
          await post(page, "Save pledge", "pledge");
          await expect(page.getByText(/25.00 GEL.*Pledged/)).toBeVisible();
          await layout(page);
        } else if (phase === 2) {
          await page.getByRole("link", { name: "Contribution", exact: true }).click();
          await page
            .getByRole("button", { name: "Configure points rule", exact: true })
            .click();
          await page
            .getByLabel("Participation category", { exact: true })
            .selectOption("task");
          await page.getByLabel("Points amount", { exact: true }).fill("12");
          await page
            .getByLabel("Recognition reason", { exact: true })
            .fill("Synthetic browser prospective rule");
          rule = (await post(page, "Submit recognition proposal", "propose"))
            .id;
          await layout(page);
        } else {
          await page.getByRole("link", { name: "Approvals", exact: true }).click();
          await page.locator(`[data-proposal-id="${rule}"] button`).click();
          await page
            .getByLabel("Review reason", { exact: true })
            .fill("Independent synthetic rule approval");
          await post(page, "Record decision", "vote");
          await expect(
            page.getByRole("heading", {
              name: "Points rule · Approved",
              exact: true,
            }),
          ).toBeVisible();
          await layout(page);
          await page.getByRole("link", { name: "Contribution", exact: true }).click();
          await expect(
            page.getByText(/Confirmed participation: 12/),
          ).toBeVisible();
        }
        await page.screenshot({
          path: `.local/operations-browser-${phase + 1}.png`,
          fullPage: true,
        });
      } catch (e) {
        console.error("Synthetic browser failure", {
          phase: phase + 1,
          failedResponses,
          requestCounts,
          browserErrors: errors,
          alerts: await page.getByRole("alert").allTextContents(),
        });
        await page
          .screenshot({
            path: ".local/operations-browser-failure.png",
            fullPage: true,
          })
          .catch(() => {});
        throw e;
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS real Chrome operations: needs, independent funding/rule approvals, pledges, inbox, responsive themes",
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
