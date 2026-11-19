import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyMobilizationBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    origin = "http://localhost:15173";
  const browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const title = "Synthetic browser mobilization",
    template = "Synthetic browser driving";
  let proposal = "";
  try {
    for (let phase = 0; phase < 8; phase++) {
      console.log(
        `Mobilization browser phase ${phase + 1}: pacing unchanged rate window`,
      );
      await new Promise((r) => setTimeout(r, 60000));
      const index = [0, 1, 2, 3, 2, 3, 0, 3][phase];
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
          return; // fixture grants Work, not channels
        if (path.startsWith("/api/") && r.status() >= 400)
          errors.push(`HTTP ${r.status()} ${path}`);
      });
      const post = async (name: string, path: string) => {
        const response = page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname.endsWith(path),
        );
        await page.getByRole("button", { name, exact: true }).click();
        const result = await response;
        expect(result.status()).toBe(200);
        return result.json();
      };
      const confirm = async (name: string, operation: string) => {
        await page.getByRole("button", { name, exact: true }).click();
        await post("Confirm action", "/work/" + operation);
        await expect(
          page.getByText("Change saved.", { exact: true }),
        ).toBeVisible();
      };
      try {
        await page.goto(origin + "/login");
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[index].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page.waitForURL((url) => url.pathname !== "/login");
        loggedIn = true;
        if (phase === 0) {
          await page.goto(origin + "/contribution");
          await page
            .getByRole("button", { name: "Add reward template", exact: true })
            .click();
          await page
            .getByLabel("Template name", { exact: true })
            .fill(template);
          await page
            .getByLabel("Available hierarchy", { exact: true })
            .selectOption(access.accounts[2].unitId);
          await page.getByLabel("Points amount", { exact: true }).fill("37");
          await page
            .getByLabel("Member monthly cap", { exact: true })
            .fill("100000");
          await page
            .getByLabel("Issuer monthly allowance", { exact: true })
            .fill("100000");
          await page
            .getByLabel("Recognition reason", { exact: true })
            .fill("Synthetic activity template policy");
          proposal = (
            await post("Submit recognition proposal", "/collective/propose")
          ).id;
        } else if (phase === 1) {
          await page.goto(origin + "/approvals");
          await page.locator(`[data-proposal-id="${proposal}"] button`).click();
          await expect(page.getByText(template, { exact: true })).toBeVisible();
          await page
            .getByLabel("Review reason", { exact: true })
            .fill("Independent synthetic template approval");
          await post("Record decision", "/collective/vote");
        } else if (phase === 7) {
          await page.goto(origin + "/contribution");
          await expect(
            page
              .locator("[data-contribution-id]")
              .filter({ hasText: template }),
          ).toContainText("+37");
          for (const language of ["en", "ka"])
            for (const theme of ["light", "dark"]) {
              await setConsoleAppearance(page, language, theme);
              await expect(
                page
                  .locator("[data-contribution-id]")
                  .filter({ hasText: template }),
              ).toContainText("+37");
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
                path: `.local/mobilization-history-${language}-${theme}.png`,
                fullPage: true,
              });
            }
        } else {
          await page.goto(origin + "/tasks");
          if (phase === 2) {
            await page
              .getByRole("button", { name: "New task", exact: true })
              .click();
            await page
              .getByLabel("Responsible unit", { exact: true })
              .selectOption(access.accounts[2].unitId);
            await page.getByLabel("Title", { exact: true }).fill(title);
            await page
              .getByLabel("Description and expected outcome", { exact: true })
              .fill("Synthetic voluntary support instructions");
            await page
              .getByLabel("Meeting place (optional)", { exact: true })
              .fill("Synthetic meeting place");
            await page.getByRole("radio", {name:"Assign points", exact:true}).check();
            const reward = page.getByLabel("Participation reward", { exact: true });
            const ruleId = await reward.locator("option").filter({hasText: template + " · 37 points"}).getAttribute("value");
            expect(ruleId).toBeTruthy();
            await reward.selectOption(ruleId!);
            const due = new Date(Date.now() + 3600000);
            await page
              .getByLabel("Deadline", { exact: true })
              .fill(
                new Date(due.getTime() - due.getTimezoneOffset() * 60000)
                  .toISOString()
                  .slice(0, 16),
              );
            await expect(
              page.getByLabel("Participant role", { exact: true }),
            ).not.toBeVisible();
            await page.screenshot({
              path: ".local/mobilization-simple-form.png",
              fullPage: true,
            });
            await post("Save task", "/work/create");
          } else {
            await page
              .getByRole("button", { name: new RegExp("^" + title) })
              .click();
            if (phase === 3) await confirm("Volunteer", "apply");
            if (phase === 4) await confirm("Assign", "assign");
            if (phase === 5) {
              await confirm("Start work", "start");
              await confirm("Submit completion", "submit");
            }
            if (phase === 6) await confirm("Verify completion", "verify");
          }
          await expect(
            page.getByRole("heading", { name: title, exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(/Points for verified participation: 37/),
          ).toBeVisible();
        }
        console.log(`PASS mobilization browser phase ${phase + 1}`);
      } catch (error) {
        await page.screenshot({
          path: ".local/mobilization-browser-failure.png",
          fullPage: true,
        });
        console.error(errors);
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
