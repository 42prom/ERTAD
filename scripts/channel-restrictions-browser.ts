import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyRestrictionsBrowser(
  app: Express,
  access: DemoAccess,
  fromInbox = false,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    origin = "http://localhost:15173",
    browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const title = "Synthetic browser moderation",
    reason = "Synthetic browser restriction reason",
    appeal = "Synthetic browser independent appeal";
  let noticeId = "";
  try {
    for (const index of [2, 3, 1, 4]) {
      console.log(
        "Moderation browser account " +
          index +
          ": pacing unchanged rate window",
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
        } catch (error) {
          if (!closing) {
            // Playwright's multiline call log can include session headers.
            const message = (
              error instanceof Error ? error.message : String(error)
            ).split(/\r?\n/, 1)[0];
            errors.push("Transport failure: " + u.pathname + ": " + message);
          }
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      let loggedIn = false;
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        // The login page probes the absent session before authentication.
        if (!loggedIn && path === "/api/v1/admin/auth/me" && response.status() === 401)
          return;
        if (path.startsWith("/api/") && response.status() >= 400)
          errors.push("HTTP failure: " + response.status() + " " + path);
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
        await page.waitForURL((url) => url.pathname !== "/login");
        loggedIn = true;
        if (fromInbox && (index === 1 || index === 3)) {
          await page.locator('a[href="/inbox"]').first().click();
          await page
            .getByLabel("Category", { exact: true })
            .selectOption("moderation");
          if (index === 3)
            await page
              .getByRole("button", { name: "All", exact: true })
              .click();
          const notice = page.locator('[data-inbox-id="' + noticeId + '"]');
          await expect(notice).toBeVisible();
          await expect(notice).not.toContainText(reason);
          await expect(notice).not.toContainText(appeal);
          await notice
            .getByRole("button", { name: "Mark as read", exact: true })
            .click();
          await expect(
            notice.getByRole("button", { name: "Mark as read", exact: true }),
          ).toHaveCount(0);
          await notice
            .getByRole("button", {
              name: index === 1 ? "Review appeal" : "View",
              exact: true,
            })
            .click();
          await expect(
            page.getByText("Record opened from notification", { exact: true }),
          ).toBeVisible();
          expect(new URL(page.url()).pathname).toBe("/channels");
          expect(new URL(page.url()).search).toBe("");
          console.log(
            "PASS browser exact notice navigation and reading remains independent of action",
          );
        } else {
          await page.locator('a[href="/channels"]').click();
          await expect(
            page.getByRole("heading", { name: "Group channels", exact: true }),
          ).toBeVisible();
          if (index === 4) {
            await expect(
              page.getByRole("button", { name: new RegExp(title) }),
            ).toHaveCount(0);
            await page
              .getByRole("button", {
                name: "Restrictions and appeals",
                exact: true,
              })
              .click();
            await page
              .getByRole("button", { name: "Restriction history", exact: true })
              .click();
            await expect(
              page.getByText("No restrictions in this view."),
            ).toBeVisible();
            console.log(
              "PASS browser sibling region cannot discover moderation records",
            );
            if (fromInbox) {
              await page.locator('a[href="/inbox"]').first().click();
              await page
                .getByLabel("Category", { exact: true })
                .selectOption("moderation");
              await page
                .getByRole("button", { name: "All", exact: true })
                .click();
              await expect(
                page.getByText("No items in this view."),
              ).toBeVisible();
              console.log(
                "PASS browser sibling region has no moderation notices",
              );
            }
            continue;
          }
          await page.getByRole("button", { name: new RegExp(title) }).click();
          await expect(
            page.getByRole("heading", { name: title, exact: true }),
          ).toBeVisible();
        }
        if (index === 2) {
          await page
            .getByRole("button", { name: "Restrict writing", exact: true })
            .click();
          await page.getByLabel("Restriction duration").selectOption("1");
          await page.getByLabel("Reason", { exact: true }).fill(reason);
          const issued = page.waitForResponse(
            (r) =>
              r.request().method() === "POST" &&
              new URL(r.url()).pathname.endsWith("/channels/restrict"),
          );
          await page
            .getByRole("button", { name: "Confirm", exact: true })
            .click();
          noticeId = (await (await issued).json()).restrictionId;
          await expect(page.getByText("Action recorded.")).toBeVisible();
          await expect(
            page.getByText("No restrictions in this view."),
          ).toBeVisible();
          console.log(
            "PASS browser explicit channel restriction and issuer has no review action",
          );
        } else if (index === 3) {
          await expect(page.getByText(reason, { exact: true })).toBeVisible();
          await expect(page.getByLabel("Message", { exact: true })).toHaveCount(
            0,
          );
          if (!fromInbox) {
            await page
              .getByRole("button", {
                name: "Restrictions and appeals",
                exact: true,
              })
              .click();
            await page
              .getByRole("button", { name: "My restrictions", exact: true })
              .click();
          }
          const record = page.getByRole("article", {
            name: title,
            exact: true,
          });
          await record
            .getByRole("button", { name: "Appeal restriction", exact: true })
            .click();
          await page.getByLabel("Reason", { exact: true }).fill(appeal);
          await page
            .getByRole("button", { name: "Confirm", exact: true })
            .click();
          await expect(page.getByText("Action recorded.")).toBeVisible();
          await expect(
            record.getByText("Awaiting independent review."),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Review appeal", exact: true }),
          ).toHaveCount(0);
          console.log(
            "PASS browser restricted member reads and appeals without self-review",
          );
        } else {
          if (!fromInbox)
            await page
              .getByRole("button", {
                name: "Restrictions and appeals",
                exact: true,
              })
              .click();
          const record = page.getByRole("article", {
            name: title,
            exact: true,
          });
          await record
            .getByRole("button", { name: "Review appeal", exact: true })
            .click();
          await page
            .getByLabel("Decision", { exact: true })
            .selectOption("lift");
          await page
            .getByLabel("Reason", { exact: true })
            .fill("Synthetic browser independent reversal");
          await page
            .getByRole("button", { name: "Confirm", exact: true })
            .click();
          await expect(page.getByText("Action recorded.")).toBeVisible();
          for (const language of ["en", "ka"])
            for (const theme of ["light", "dark"]) {
              // Each layout repeats real inbox/detail navigation. Keep these
              // bursts in separate rate windows, as with account transitions.
              if (fromInbox) {
                console.log("Moderation inbox layout " + language + "/" + theme + ": pacing unchanged rate window");
                await new Promise((r) => setTimeout(r, 60000));
              }
              await setConsoleAppearance(page, language, theme);
              const panel = page.getByRole("region", {
                name:
                  language === "ka"
                    ? "შეზღუდვები და გასაჩივრება"
                    : "Restrictions and appeals",
                exact: true,
              });
              if (!(await panel.count()))
                await page
                  .getByRole("button", {
                    name:
                      language === "ka"
                        ? "შეზღუდვები და გასაჩივრება"
                        : "Restrictions and appeals",
                    exact: true,
                  })
                  .click();
              await panel
                .getByRole("button", {
                  name: language === "ka" ? "ისტორია" : "Restriction history",
                  exact: true,
                })
                .click();
              await expect(
                panel.getByText("Synthetic browser independent reversal", {
                  exact: false,
                }),
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
                path: ".local/moderation-" + language + "-" + theme + ".png",
                fullPage: true,
              });
              if (fromInbox) {
                await page.locator('a[href="/inbox"]').first().click();
                await page
                  .getByLabel(language === "ka" ? "კატეგორია" : "Category", {
                    exact: true,
                  })
                  .selectOption("moderation");
                await page
                  .getByRole("button", {
                    name: language === "ka" ? "ყველა" : "All",
                    exact: true,
                  })
                  .click();
                const notice = page.locator(
                  '[data-inbox-id="' + noticeId + '"]',
                );
                const statusCell = notice.getByRole("cell").nth(2);
                await expect(statusCell).toContainText(
                  language === "ka" ? "შეზღუდვა მოხსნილია" : "Restriction lifted",
                );
                await expect(statusCell).toBeVisible();
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
                  path:
                    ".local/moderation-inbox-" +
                    language +
                    "-" +
                    theme +
                    ".png",
                  fullPage: true,
                });
                await notice
                  .getByRole("button", {
                    name: language === "ka" ? "ნახვა" : "View",
                    exact: true,
                  })
                  .click();
                await expect(
                  page.getByText(
                    language === "ka"
                      ? "შეტყობინებიდან გახსნილი ჩანაწერი"
                      : "Record opened from notification",
                    { exact: true },
                  ),
                ).toBeVisible();
              }
            }
          console.log(
            "PASS browser independent lift and history, both languages/themes and four widths",
          );
        }
        expect(new URL(page.url()).search).toBe("");
      } catch (e) {
        if (errors.length) console.error("Browser request failures", errors);
        await page.screenshot({
          path: ".local/moderation-failure.png",
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
