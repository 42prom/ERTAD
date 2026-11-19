import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function verifyContributionBrowser(
  app: Express,
  access: DemoAccess,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ channel: "chrome" });
  const errors: string[] = [];
  let proposal = "",
    entry = "",
    baseline = 0;
  const origin = "http://localhost:15173",
    reason = "Synthetic browser personal recognition";
  try {
    for (let phase = 0; phase < 8; phase++) {
      console.log(
        `Contribution browser phase ${phase + 1}: pacing unchanged rate window`,
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
        } catch (e) {
          if (!closing)
            errors.push(
              "Transport " +
                url.pathname +
                ": " +
                String(e instanceof Error ? e.message : e).split(/\r?\n/, 1)[0],
            );
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (
          !loggedIn &&
          path === "/api/v1/admin/auth/me" &&
          response.status() === 401
        )
          return;
        if (path.startsWith("/api/") && response.status() >= 400)
          errors.push(`HTTP ${response.status()} ${path}`);
      });
      const post = async (button: string, operation: string) => {
        const response = page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname.endsWith("/collective/" + operation),
        );
        await page.getByRole("button", { name: button, exact: true }).click();
        const result = await response;
        expect(result.status()).toBe(200);
        return result.json();
      };
      try {
        await page.goto(origin + "/login");
        const index = [0, 1, 0, 2, 3, 0, 2, 3][phase];
        await page
          .getByRole("button", {
            name: new RegExp(
              access.accounts[index].email.replaceAll(".", "\\."),
            ),
          })
          .click();
        await page.waitForURL((url) => url.pathname !== "/login");
        loggedIn = true;
        if ([1, 3, 6].includes(phase)) {
          await page.goto(origin + "/approvals");
          await page.locator(`[data-proposal-id="${proposal}"] button`).click();
          await page
            .getByLabel("Review reason", { exact: true })
            .fill("Synthetic independent recognition approval");
          await post("Record decision", "vote");
          await expect(
            page.getByRole("heading", { name: /Approved/ }),
          ).toBeVisible();
        } else if (phase === 0 || phase === 2 || phase === 5) {
          await page.goto(origin + "/contribution");
          await expect(
            page.getByRole("heading", { name: "Current rules", exact: true }),
          ).toBeVisible();
          if (phase === 0) {
            await page
              .getByRole("button", {
                name: "Configure points rule",
                exact: true,
              })
              .click();
            await page
              .getByLabel("Participation category", { exact: true })
              .selectOption("manual");
            await page.getByLabel("Points amount", { exact: true }).fill("25");
          } else {
            await page
              .getByLabel("Management scope", { exact: true })
              .selectOption(access.accounts[2].unitId);
            if (phase === 2) {
              await page
                .getByRole("button", {
                  name: "Propose recognition",
                  exact: true,
                })
                .click();
              await page
                .getByLabel("Recognition recipient", { exact: true })
                .selectOption(access.accounts[3].memberId);
              await page
                .getByLabel("Points amount", { exact: true })
                .fill("12");
            } else {
              await page
                .getByLabel("Points history", { exact: true })
                .selectOption(access.accounts[3].memberId);
              // Recipient history may be paginated; locate the actual awarded entry.
              for (let n = 0; n < 3; n++) {
                await expect(
                  page.getByRole("heading", {
                    name: "Recognition history",
                    exact: true,
                  }),
                ).toBeVisible();
                if (
                  await page
                    .locator(`[data-contribution-id="${entry}"]`)
                    .count()
                )
                  break;
                await page
                  .getByRole("button", { name: "Next", exact: true })
                  .click();
              }
              await page
                .locator(`[data-contribution-id="${entry}"]`)
                .getByRole("button", {
                  name: "Request correction",
                  exact: true,
                })
                .click();
            }
          }
          await page
            .getByLabel("Recognition reason", { exact: true })
            .fill(
              phase === 2
                ? reason
                : "Synthetic browser recognition policy or correction",
            );
          proposal = (await post("Submit recognition proposal", "propose")).id;
          await expect(
            page.getByText(
              "Saved. Proposed changes take effect only after approval.",
            ),
          ).toBeVisible();
        } else {
          await page.locator('a[href="/inbox"]').first().click();
          await page
            .getByLabel("Category", { exact: true })
            .selectOption("contribution");
          await page.getByRole("button", { name: "All", exact: true }).click();
          // Fetch the owner's authorized history to identify the newly awarded/corrected entry,
          // then use the actual inbox controls for navigation and acknowledgement.
          const ownHistory = async (historyPage: number) => {
            const result = await page.evaluate(
              async ({ org, historyPage }) => {
                const response = await fetch(
                  "/api/v1/admin/collective/points?" +
                    new URLSearchParams({
                      organizationId: org,
                      page: String(historyPage),
                    }),
                  { credentials: "include" },
                );
                return { status: response.status, data: await response.json() };
              },
              { org: access.organizationId, historyPage },
            );
            expect(result.status).toBe(200);
            return result.data;
          };
          const view = await ownHistory(1);
          let target = view.entries.find((e: any) =>
            phase === 4 ? e.reason === reason : e.reversesId === entry,
          );
          if (!target) {
            target = (await ownHistory(2)).entries.find((e: any) =>
              phase === 4 ? e.reason === reason : e.reversesId === entry,
            );
          }
          expect(target).toBeTruthy();
          if (phase === 4) {
            entry = target.id;
            baseline = Number(view.balance) - 12;
          } else expect(Number(view.balance)).toBe(baseline);
          const targetId = target.id;
          for (let n = 0; n < 3; n++) {
            await expect(page.getByRole("table")).toBeVisible();
            if (await page.locator(`[data-inbox-id="${targetId}"]`).count())
              break;
            await page
              .getByRole("button", { name: "Next", exact: true })
              .click();
          }
          const notice = page.locator(`[data-inbox-id="${targetId}"]`);
          await expect(notice).toBeVisible();
          await expect(notice).not.toContainText(reason);
          await notice
            .getByRole("button", { name: "Mark as read", exact: true })
            .click();
          await expect(
            notice.getByRole("button", { name: "Mark as read", exact: true }),
          ).toHaveCount(0);
          await notice
            .getByRole("button", { name: "View", exact: true })
            .click();
          await expect(
            page.getByText("Record opened from notification", { exact: true }),
          ).toBeVisible();
          await expect(
            page.locator(`[data-contribution-id="${targetId}"]`),
          ).toBeVisible();
          expect(new URL(page.url()).search).toBe("");
          await expect(
            page.getByRole("button", {
              name: "Propose recognition",
              exact: true,
            }),
          ).toHaveCount(0);
          if (phase === 7) {
            // Layout changes do not need repeated domain navigation; theme is local state.
            for (const language of ["en", "ka"])
              for (const theme of ["light", "dark"]) {
                await setConsoleAppearance(page, language, theme);
                await expect(page.getByRole("heading", {
                  name: language === "ka" ? "ქულების ისტორია" : "Recognition history",
                  exact: true,
                })).toBeVisible();
                await expect(page.getByRole("alert")).toHaveCount(0);
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
                  path: `.local/contribution-${language}-${theme}.png`,
                  fullPage: true,
                });
              }
          }
        }
        console.log(`PASS contribution browser phase ${phase + 1}`);
      } catch (e) {
        if (errors.length) console.error("Browser failures", errors);
        await page.screenshot({
          path: ".local/contribution-browser-failure.png",
          fullPage: true,
        });
        throw e;
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS real Chrome rule approval, manual award, recipient notice/history and independently approved correction",
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
