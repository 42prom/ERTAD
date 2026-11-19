import { chromium, expect as baseExpect } from "@playwright/test";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { Client } from "pg";
import { randomBytes, createHash } from "node:crypto";
import type { DemoAccess } from "../backend/src/localDemo";
import { setConsoleAppearance } from "./console-browser";
const expect = baseExpect.configure({ timeout: 30000 });
export async function runInvitationBrowser(
  app: Express,
  access: DemoAccess,
  owner: Client,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    browser = await chromium.launch({ channel: "chrome" }),
    errors: string[] = [];
  const recipient = (
    await owner.query(
      `SELECT c.* FROM web_invite_contacts c JOIN organization_member_labels l ON (l.organization_id,l.member_id)=(c.organization_id,c.member_id)
 WHERE c.organization_id=$1 AND c.unit_id=$2 AND l.display_name=$3`,
      [access.organizationId, access.accounts[2].unitId, "სატესტო მიმღები 1"],
    )
  ).rows[0];
  let proposalId = "";
  try {
    for (const index of [2, 3, 6]) {
      console.log("Invitation browser stage " + index);
      // Ordinary request budgets stay intact, including previous SQL/HTTP fixtures.
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
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith("/api/")) return route.continue();
        try {
          const response = await route.fetch({
            url: endpoint + url.pathname + url.search,
          });
          if (
            response.status() >= 400 &&
            !(
              response.status() === 428 &&
              ["/collective/propose", "/collective/vote"].some((path) =>
                url.pathname.endsWith(path),
              )
            ) &&
            !(url.pathname.endsWith("/auth/me") && response.status() === 401)
          )
            errors.push(
              `${route.request().method()} ${url.pathname}: ${response.status()}`,
            );
          await route.fulfill({ response });
        } catch {
          if (!closing) errors.push("Transport failure");
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on("pageerror", () => errors.push("Browser script error"));
      try {
        if (index !== 6) {
          await page.goto("http://localhost:15173/login", {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await page
            .getByRole("button", {
              name: new RegExp(
                access.accounts[index].email.replaceAll(".", "\\."),
              ),
            })
            .click();
          await page.locator(".console-nav-item[href='/invitations']").click();
          if (index === 2) {
            await expect(page.getByLabel("Recipient")).toBeVisible();
            for (const language of ["en", "ka"])
              for (const theme of ["light", "dark"]) {
                await setConsoleAppearance(page, language, theme);
                await expect(
                  page.getByRole("heading", {
                    name:
                      language === "en"
                        ? "Create invitation"
                        : "მოწვევის შექმნა",
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
              }
            await page.screenshot({
              path: ".local/invitation-form-ka.png",
              fullPage: true,
            });
            await setConsoleAppearance(page, "en", "light");
            await page.getByLabel("Recipient").selectOption(recipient.id);
            await page
              .getByLabel("Reason", { exact: true })
              .fill("Browser recipient activation");
            await page
              .getByLabel("I confirm submitting this invitation")
              .check();
            const [response] = await Promise.all([
              page.waitForResponse(
                (r) =>
                  r.url().endsWith("/collective/propose") &&
                  r.request().method() === "POST" &&
                  r.status() !== 428,
              ),
              (async () => {
                await page
                  .getByRole("button", { name: "Submit for approval" })
                  .click();
                await page
                  .locator("#step-up-password")
                  .fill(access.accounts[index].password);
                await page
                  .getByRole("button", { name: "Confirm and continue" })
                  .click();
              })(),
            ]);
            expect(response.status()).toBe(200);
            proposalId = (await response.json()).id;
            await expect(
              page.getByText("Invitation submitted for independent approval."),
            ).toBeVisible();
          } else {
            await page.locator(".console-nav-item[href='/approvals']").click();
            await page
              .locator(`tr[data-proposal-id='${proposalId}']`)
              .getByRole("button")
              .click();
            await expect(page.getByText(/სატესტო მიმღები 1/)).toBeVisible();
            await page
              .getByLabel("Review reason")
              .fill("Browser independent invitation approval");
            const [response] = await Promise.all([
              page.waitForResponse(
                (r) =>
                  r.url().endsWith("/collective/vote") &&
                  r.request().method() === "POST" &&
                  r.status() !== 428,
              ),
              // The existing collective demo flow obtains its scoped demo step-up.
              page
                .getByRole("button", { name: "Record decision", exact: true })
                .click(),
            ]);
            expect(response.status()).toBe(200);
            await expect(
              page.getByText("Saved.", { exact: true }),
            ).toBeVisible();
          }
        } else {
          const token = randomBytes(32).toString("base64url"),
            password = "Synthetic-browser-activation-483!";
          await owner.query("SELECT ertad.web_invite_delivery($1,$2)", [
            proposalId,
            createHash("sha256").update(token).digest("hex"),
          ]);
          await page.goto(
            `http://localhost:15173/activate#${proposalId}.${token}`,
            { waitUntil: "domcontentloaded" },
          );
          await expect(
            page.getByRole("heading", {
              name: "Activate web account",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByLabel("Password", { exact: true }),
          ).toBeVisible();
          expect(new URL(page.url()).hash).toBe("");
          for (const width of [360, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
              ),
            ).toBe(true);
          }
          await page.screenshot({
            path: ".local/invitation-activation.png",
            fullPage: true,
          });
          await page.getByLabel("Password", { exact: true }).fill(password);
          await page.getByLabel("Repeat password").fill(password);
          await page.getByLabel("I confirm account activation").check();
          await page
            .getByRole("button", { name: "Activate account", exact: true })
            .click();
          await expect(page.getByText(/Account activated/)).toBeVisible();
          const row = (
            await owner.query(
              "SELECT consumed_at,account_id FROM web_invitations WHERE id=$1",
              [proposalId],
            )
          ).rows[0];
          expect(row.consumed_at).toBeTruthy();
          expect(row.account_id).toBeTruthy();
          await page
            .getByRole("link", { name: "Sign in", exact: true })
            .click();
          await page.getByLabel("Email", { exact: true }).fill(recipient.email);
          await page.getByLabel("Password", { exact: true }).fill(password);
          await page
            .getByRole("button", { name: "Sign in", exact: true })
            .click();
          await expect(page).not.toHaveURL(/\/login/);
          await page.goto("http://localhost:15173/account");
          await expect(
            page.getByRole("heading", {
              name: "Account security",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.locator(".console-nav-item[href='/invitations']"),
          ).toHaveCount(0);
        }
      } catch (error) {
        // Do not capture typed passwords or token-bearing URLs on failure.
        console.error("Invitation browser failed", {
          stage: index,
          path: new URL(page.url()).pathname,
        });
        throw error;
      } finally {
        closing = true;
        await context.close();
      }
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS browser invitation, independent approval, recipient activation and password login",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
